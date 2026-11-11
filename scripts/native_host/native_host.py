#!/usr/bin/env python3
"""
OB-Zotero Native Messaging Host for Chrome Extension.
Communicates via standard 4-byte length-prefixed JSON protocol over stdin/stdout.
Coordinates web article extraction, figure downloading, Obsidian note/source generation,
and Zotero bibliographic indexing via IngestionCore.
"""

import json
import logging
import os
import re
import struct
import subprocess
import sys
import time
import unicodedata
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# Ensure scripts directory is in sys.path
BASE_DIR = Path(__file__).parent.parent.parent.resolve()
SCRIPTS_DIR = BASE_DIR / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import requests

from ingestion.runtime_config import CACHE_DIR, get_vault_root, get_vault_name
from ingestion.core import IngestionCore
from ingestion.identifier import (
    calculate_file_hash,
    extract_candidate_dois_from_text,
    extract_lead_author,
    extract_note_identity,
    extract_pdf_identity,
    extract_pmid_from_text,
    normalize_doi,
    normalize_pmid,
    parse_frontmatter,
)
from ingestion.metadata_client import MetadataClient, generate_citekey
from ingestion.models import PaperMetadata, StepStatus
from ingestion.note_updater import update_note_frontmatter
from ingestion.zotero_client import ZoteroClient
from ingestion.gemini_client import GeminiClient
from ingestion.pdf_resolver import PDFResolver

# Logs and runtime state live outside the project and the Vault.
VAULT_DIR = get_vault_root()
VAULT_NAME = urllib.parse.quote(get_vault_name(), safe="")
LOG_DIR = CACHE_DIR
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "native_host.log"
logging.basicConfig(
    filename=str(LOG_FILE),
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)


def read_message() -> Optional[Dict[str, Any]]:
    """Read a 32-bit length-prefixed JSON message from stdin."""
    try:
        raw_length = sys.stdin.buffer.read(4)
        if len(raw_length) < 4:
            return None
        length = struct.unpack("@I", raw_length)[0]
        if length == 0:
            return None
        raw_data = sys.stdin.buffer.read(length)
        if len(raw_data) < length:
            return None
        return json.loads(raw_data.decode("utf-8"))
    except Exception as e:
        logging.error(f"Error reading message from stdin: {e}")
        return None


def send_message(data: Dict[str, Any]) -> None:
    """Send a 32-bit length-prefixed JSON message to stdout."""
    try:
        encoded = json.dumps(data, ensure_ascii=False).encode("utf-8")
        sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
    except Exception as e:
        logging.error(f"Error sending message to stdout: {e}")


def clean_pdf_text(text: str) -> str:
    """Repair broken hyphens and hard line wraps from PDF text copying."""
    # 1. Rejoin hyphenated words broken across lines: "inter-\nvention" -> "intervention"
    text = re.sub(r'(\b\w+)-\s*\n\s*(\w+\b)', r'\1\2', text)
    # 2. Join lines that break inside sentences, preserving Markdown block syntax
    lines = text.splitlines()
    joined = []
    md_block_pattern = re.compile(r'^(?:#{1,6}\s|\||>|[-*+]\s|\d+\.\s|---+$|```)')
    for line in lines:
        stripped = line.strip()
        if not stripped:
            joined.append("")
            continue
        if (
            joined
            and joined[-1]
            and not md_block_pattern.match(joined[-1])
            and not md_block_pattern.match(stripped)
            and not re.search(r'([.。?!:：]|\b\d+\.|\b[-*#])\s*$', joined[-1])
        ):
            # If current line starts with alphanumeric or non-list marker, join with space
            if re.match(r'^[a-zA-Z0-9\u4e00-\u9fa5]', stripped):
                joined[-1] = joined[-1] + " " + stripped
                continue
        joined.append(stripped)
    return "\n".join(joined)


def extract_doi_from_pdf_url(url: str) -> Optional[str]:
    """Read an article DOI embedded in common publisher PDF URLs."""
    decoded_url = urllib.parse.unquote(url or "")
    match = re.search(r"10\.\d{4,9}/[A-Za-z0-9._;()/:+-]+", decoded_url)
    if not match:
        return None
    candidate = re.sub(r"(?i)\.pdf$", "", match.group(0).rstrip(".,)"))
    return normalize_doi(candidate)


def extract_pdf_vision_text(pdf_path: Path) -> str:
    """OCR the first PDF pages with macOS Vision when no text layer exists."""
    ocr_script = SCRIPTS_DIR / "ingestion" / "pdf_vision_ocr.swift"
    if sys.platform != "darwin" or not ocr_script.is_file():
        return ""
    try:
        result = subprocess.run(
            ["swift", str(ocr_script), str(pdf_path)],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if result.returncode != 0:
            logging.warning("Vision OCR failed for %s: %s", pdf_path, result.stderr[-1000:])
            return ""
        return result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        logging.warning("Vision OCR could not run for %s: %s", pdf_path, exc)
        return ""


def match_metadata_from_pdf_text(text: str, candidates: List[PaperMetadata]) -> Optional[PaperMetadata]:
    """Accept a Crossref candidate only when its title and another PDF clue agree."""
    ascii_text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii").lower()
    pdf_terms = set(re.findall(r"[a-z0-9]+", ascii_text))
    if not pdf_terms:
        return None

    ranked = []
    for meta in candidates:
        title_terms = set(re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKD", meta.title or "").encode("ascii", "ignore").decode("ascii").lower()))
        if len(title_terms) < 5:
            continue
        title_coverage = len(title_terms & pdf_terms) / len(title_terms)
        if title_coverage < 0.86:
            continue

        lead_author = extract_lead_author(meta.authors)
        author_terms = set(re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKD", lead_author).encode("ascii", "ignore").decode("ascii").lower()))
        author_match = bool(author_terms & pdf_terms)
        year_match = bool(meta.year and re.search(rf"\b{meta.year}\b", ascii_text))
        journal_terms = set(re.findall(r"[a-z0-9]+", unicodedata.normalize("NFKD", meta.journal or "").encode("ascii", "ignore").decode("ascii").lower()))
        journal_terms = {term for term in journal_terms if len(term) >= 4}
        journal_match = bool(journal_terms and len(journal_terms & pdf_terms) / len(journal_terms) >= 0.5)

        # A strong title match must agree with the first author and another
        # bibliographic clue. If OCR missed the author, require an almost exact
        # title plus both year and journal evidence.
        if not (author_match and (year_match or journal_match)) and not (
            title_coverage >= 0.98 and year_match and journal_match
        ):
            continue
        score = title_coverage * 0.70 + (0.15 if author_match else 0) + (0.08 if year_match else 0) + (0.07 if journal_match else 0)
        ranked.append((score, meta))

    ranked.sort(key=lambda item: item[0], reverse=True)
    if not ranked:
        return None
    if len(ranked) > 1 and ranked[0][1].doi != ranked[1][1].doi and ranked[0][0] - ranked[1][0] < 0.08:
        return None
    return ranked[0][1]


def _yaml_quote(value: Any) -> str:
    """Format a string safely inside double quotes for YAML frontmatter."""
    s = str(value or "").replace("\\", "\\\\").replace('"', '\\"').replace("\r", " ").replace("\n", " ").strip()
    return f'"{s}"'


def clean_html_to_md(html_str: str) -> str:
    """Convert copied HTML structure to clean Markdown format."""
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html_str, 'html.parser')
        for pre in soup.find_all('pre'):
            pre.replace_with(f'\n```\n{pre.get_text().strip()}\n```\n')
        for code in soup.find_all('code'):
            code.replace_with(f'`{code.get_text()}`')
        for b in soup.find_all(['strong', 'b']):
            b.replace_with(f'**{b.get_text()}**')
        for i in soup.find_all(['em', 'i']):
            i.replace_with(f'*{i.get_text()}*')
        for h in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']):
            level = int(h.name[1])
            h.replace_with(f'\n\n{"#" * level} {h.get_text().strip()}\n\n')
        for p in soup.find_all('p'):
            p.replace_with(f'\n\n{p.get_text().strip()}\n\n')
        for bq in soup.find_all('blockquote'):
            bq_text = bq.get_text().strip().replace('\n', '\n> ')
            bq.replace_with(f'\n> {bq_text}\n')
        for li in soup.find_all('li'):
            li.replace_with(f'\n- {li.get_text().strip()}')
        for table in soup.find_all('table'):
            rows = table.find_all('tr')
            if not rows:
                continue
            parsed_rows = []
            for tr in rows:
                cells = [c.get_text().strip().replace('|', '\\|') for c in tr.find_all(['th', 'td'])]
                if cells:
                    parsed_rows.append(cells)
            if parsed_rows:
                col_count = max(len(r) for r in parsed_rows)
                md_table_rows = []
                for idx, cells in enumerate(parsed_rows):
                    padded = cells + [''] * (col_count - len(cells))
                    md_table_rows.append('| ' + ' | '.join(padded) + ' |')
                    if idx == 0:
                        md_table_rows.append('| ' + ' | '.join(['---'] * col_count) + ' |')
                table.replace_with('\n\n' + '\n'.join(md_table_rows) + '\n\n')
        return soup.get_text().strip()
    except Exception as e:
        logging.warning(f"Error converting HTML to Markdown: {e}")
        return html_str


class NativeHostHandler:
    def __init__(self):
        self.core = IngestionCore()
        self.metadata_client = self.core.metadata_client
        self.zotero_client = self.core.zotero_client
        self.state_tracker = self.core.state_tracker
        self.gemini_client = GeminiClient()
        self.pdf_resolver = PDFResolver()
        self._pdf_upload_buffers: Dict[str, Dict[int, str]] = {}
        self._pdf_inspection_paths: Dict[str, str] = {}

    def handle_ping(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "status": "ok",
            "version": "1.0.0",
            "vault_path": str(VAULT_DIR),
            "vault_name": get_vault_name(),
            "zotero_mode": self.zotero_client.get_status().get("mode", "offline"),
            "zotero_indexed_dois": len(self.zotero_client._local_doi_map),
            "gemini": self.gemini_client.get_status(),
        }

    def handle_check_status(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Check if the current article already exists in OB vault notes, sources, PDFs, or Zotero.
        """
        raw_doi = payload.get("doi")
        raw_pmid = payload.get("pmid")
        title = payload.get("title", "")

        doi = normalize_doi(raw_doi)
        pmid = normalize_pmid(raw_pmid)
        if doi and not pmid:
            pmid = self.metadata_client.find_pmid_by_doi(doi)

        # 1. Check Zotero
        zotero_key = None
        if doi:
            item = self.zotero_client.find_item_by_doi(doi)
            if item:
                zotero_key = item.get("key")
        if not zotero_key and pmid:
            item = self.zotero_client.find_item_by_pmid(pmid)
            if item:
                zotero_key = item.get("key")

        # 2. Check Obsidian Notes
        topic = payload.get("topic") or "Neurology"
        topic_dir = VAULT_DIR / "Research" / topic
        notes_dir = topic_dir / "notes"
        ob_note_path = None
        ob_has_note = False
        note_zotero_key = None

        if notes_dir.exists():
            for n in notes_dir.glob("*.md"):
                if n.name.endswith("-中文翻譯.md"):
                    continue
                try:
                    n_id = extract_note_identity(n)
                    matched = False
                    if doi and n_id.extracted_doi and normalize_doi(n_id.extracted_doi) == doi:
                        matched = True
                    elif pmid and n_id.extracted_pmid and normalize_pmid(n_id.extracted_pmid) == pmid:
                        matched = True

                    if matched:
                        ob_has_note = True
                        ob_note_path = str(n.relative_to(VAULT_DIR))
                        if n_id.zotero_link:
                            m_zk = re.search(r'/items/([A-Za-z0-9]+)', n_id.zotero_link)
                            if m_zk:
                                note_zotero_key = m_zk.group(1)
                        break
                except Exception:
                    pass

        # Fallback for Zotero key from note frontmatter or state tracker
        if not zotero_key and note_zotero_key:
            zotero_key = note_zotero_key
        if not zotero_key and doi:
            st = self.state_tracker.get_state(doi)
            if st and st.zotero_key:
                zotero_key = st.zotero_key
        if not zotero_key and pmid:
            st = self.state_tracker.get_state(f"pmid:{pmid}")
            if st and st.zotero_key:
                zotero_key = st.zotero_key

        # 3. Check Obsidian Sources
        sources_dir = topic_dir / "sources"
        ob_source_path = None
        ob_has_source = False

        if sources_dir.exists():
            # Check by filename stem or pattern
            candidates = []
            if pmid:
                candidates.extend(list(sources_dir.rglob(f"*{pmid}*.md")))
            if doi:
                doi_clean = re.sub(r"[^\w.\-]+", "_", doi)
                candidates.extend(list(sources_dir.rglob(f"*{doi_clean}*.md")))
            if candidates:
                ob_has_source = True
                ob_source_path = str(candidates[0].relative_to(VAULT_DIR))

        # 4. Check Obsidian PDFs (check sources/etc and all subdirectories under sources)
        ob_pdf_path = None
        ob_has_pdf = False
        if sources_dir.exists():
            candidates = []
            if pmid:
                candidates.extend(list(sources_dir.rglob(f"*{pmid}*.pdf")))
            if doi:
                doi_clean = re.sub(r"[^\w.\-]+", "_", doi)
                candidates.extend(list(sources_dir.rglob(f"*{doi_clean}*.pdf")))
            if candidates:
                ob_has_pdf = True
                ob_pdf_path = str(candidates[0].relative_to(VAULT_DIR))

        return {
            "status": "ok",
            "doi": doi,
            "pmid": pmid,
            "zotero": {
                "has_item": bool(zotero_key),
                "key": zotero_key,
                "url": f"zotero://select/library/items/{zotero_key}" if zotero_key else None,
            },
            "obsidian": {
                "has_note": ob_has_note,
                "note_path": ob_note_path,
                "has_source": ob_has_source,
                "source_path": ob_source_path,
            },
            "pdf": {
                "has_pdf": ob_has_pdf,
                "pdf_path": ob_pdf_path,
            },
        }

    def handle_inspect_pdf(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Identify a PDF downloaded from Chrome before assigning its final name."""
        uploaded_transfer_id = payload.get("uploaded_transfer_id")
        uploaded_path = self._pdf_inspection_paths.pop(uploaded_transfer_id, "") if uploaded_transfer_id else ""
        pdf_path = Path(payload.get("downloaded_file_path") or uploaded_path or "")
        if not pdf_path.is_file() or not self.pdf_resolver._is_valid_pdf_content(pdf_path.read_bytes()[:2048]):
            return {"status": "error", "pdf_inspection": True, "message": "目前分頁未取得有效的 PDF。"}
        identity = extract_pdf_identity(pdf_path)
        full_text = ""
        try:
            import pypdf
            reader = pypdf.PdfReader(str(pdf_path))
            full_text = "\n\n".join(page.extract_text() or "" for page in reader.pages).strip()[:500000]
        except Exception as exc:
            logging.warning("PDF text extraction failed for %s: %s", pdf_path, exc)

        # Image-only PDFs have no extractable text. OCR the opening pages to find
        # the DOI/PMID printed on the article, then verify it against metadata.
        ocr_text = ""
        if not identity.extracted_doi and not identity.extracted_pmid:
            ocr_text = extract_pdf_vision_text(pdf_path)
        doi_candidates = extract_candidate_dois_from_text(ocr_text)
        doi = identity.extracted_doi
        if not doi and doi_candidates:
            doi = doi_candidates[0]
        doi = doi or extract_doi_from_pdf_url(payload.get("url", ""))
        pmid = identity.extracted_pmid
        pmid = pmid or extract_pmid_from_text(ocr_text)
        meta = self.metadata_client.fetch_metadata(doi=doi, pmid=pmid) if (doi or pmid) else None
        if not meta or not meta.title:
            evidence_text = ocr_text or full_text
            first_page_text = evidence_text.split("\n\n", 1)[0][:1800]
            if len(first_page_text.strip()) >= 40:
                candidates = self.metadata_client.search_by_bibliographic_text(first_page_text, rows=5)
                meta = match_metadata_from_pdf_text(first_page_text, candidates)
                if meta:
                    logging.info(
                        "PDF identity matched by title/author/year/journal evidence: doi=%s title=%s",
                        meta.doi,
                        meta.title,
                    )
        if not meta or not meta.title or not (meta.pmid or meta.doi):
            return {"status": "error", "pdf_inspection": True, "message": "PDF 的識別碼查詢未成功，首頁標題／作者／年份／期刊比對也未達確認門檻；請檢查頁面清晰度或人工核對來源。"}
        if not full_text and ocr_text:
            full_text = ocr_text[:500000]
        return {
            "status": "ok", "pdf_inspection": True,
            "metadata": {
                "title": meta.title, "authors": meta.authors, "journal": meta.journal,
                "year": meta.year, "doi": meta.doi, "pmid": meta.pmid,
                "abstract": meta.abstract, "url": payload.get("url"),
                "pdf_url": payload.get("url"),
            },
            "downloaded_file_path": str(pdf_path),
            "sections": [{"heading": "PDF 全文", "level": 2, "text": full_text}] if full_text else [],
        }

    def _sanitize_filename(self, text: str) -> str:
        s = re.sub(r'[\\/*?:"<>|]', "", text)
        s = re.sub(r'[\s_]+', "_", s).strip("_")
        return s[:60]

    def _sanitize_article_name(self, text: str, max_len: int = 120) -> str:
        if not text:
            return "paper"
        s = text.replace("'", "")
        s = re.sub(r'[\\/*?:"<>|#^\[\]\n\r\t]', "", s)
        s = re.sub(r'[\s_\-]+', "_", s).strip("_")
        if len(s) <= max_len:
            return s
        truncated = s[:max_len]
        if "_" in truncated:
            truncated = truncated.rsplit("_", 1)[0]
        return truncated or s[:max_len]

    def handle_ingest_webpage(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Ingest article content captured by Chrome extension:
        - Download figures and save into assets folder
        - Write structured Markdown source to Research/<topic>/sources/...
        - Create reading note shell in Research/<topic>/notes/... if requested
        - Index into Zotero
        """
        meta_dict = payload.get("metadata", {})
        sections = payload.get("sections", [])
        figures = payload.get("figures", [])
        tables = payload.get("tables", [])
        options = payload.get("options", {})

        topic = options.get("topic", "Neurology")
        save_source = options.get("save_source", False)
        save_note = options.get("save_note", False)
        download_figures = options.get("download_figures", True)
        save_zotero = options.get("save_zotero", True)
        download_pdf = options.get("download_pdf", True)

        downloaded_file_path = payload.get("downloaded_file_path")
        uploaded_pdf_stem = payload.get("uploaded_pdf_stem")
        pdf_url = payload.get("pdf_url") or meta_dict.get("pdf_url")
        pdf_base64 = payload.get("pdf_base64")
        browser_pdf_failure = payload.get("browser_pdf_failure")
        referer = payload.get("referer") or meta_dict.get("url")

        raw_doi = meta_dict.get("doi")
        raw_pmid = meta_dict.get("pmid")
        doi = normalize_doi(raw_doi)
        pmid = normalize_pmid(raw_pmid)

        # Fetch / Verify Metadata online if possible
        meta = self.metadata_client.fetch_metadata(doi=doi, pmid=pmid)
        if not meta or not meta.title or not meta.doi:
            meta = PaperMetadata(
                title=(meta.title if meta and meta.title else "") or meta_dict.get("title", "Untitled Article"),
                authors=(meta.authors if meta and meta.authors else "") or meta_dict.get("authors", ""),
                journal=(meta.journal if meta and meta.journal else "") or meta_dict.get("journal", ""),
                year=(meta.year if meta and meta.year else None) or (int(meta_dict.get("year")) if str(meta_dict.get("year", "")).isdigit() else None),
                doi=doi or (meta.doi if meta else None),
                pmid=pmid or (meta.pmid if meta else None),
                abstract=(meta.abstract if meta and meta.abstract else "") or meta_dict.get("abstract", ""),
                url=meta_dict.get("url", ""),
            )
        if not meta.citekey:
            meta.citekey = generate_citekey(meta)

        # Determine file stems and directory paths
        topic_dir = VAULT_DIR / "Research" / topic
        sources_dir = topic_dir / "sources"
        notes_dir = topic_dir / "notes"
        pdfs_dir = sources_dir / "etc"
        sources_dir.mkdir(parents=True, exist_ok=True)
        notes_dir.mkdir(parents=True, exist_ok=True)
        pdfs_dir.mkdir(parents=True, exist_ok=True)

        author_lead = extract_lead_author(meta.authors)
        year_str = str(meta.year or datetime.now().year)
        article_name = self._sanitize_article_name(meta.title)

        if meta.pmid:
            stem = f"{meta.pmid}_{author_lead}_{article_name}_{year_str}"
        elif meta.doi:
            safe_doi = re.sub(r"[^\w.\-]+", "_", meta.doi)
            stem = f"{safe_doi}_{author_lead}_{article_name}_{year_str}"
        else:
            stem = f"{author_lead}_{article_name}_{year_str}"

        source_md_path = sources_dir / f"{stem}.md"
        note_md_path = notes_dir / f"{stem}.md"
        # If legacy note exists with -notes.md or other formats, reuse it to prevent duplication
        if not note_md_path.exists():
            legacy_cands = [
                notes_dir / f"{stem}-notes.md",
                notes_dir / f"{meta.pmid}_{author_lead}_{year_str}-notes.md" if meta.pmid else None,
                notes_dir / f"{meta.pmid}_{author_lead}_{year_str}.md" if meta.pmid else None,
                notes_dir / f"{meta.citekey}-notes.md" if meta.citekey else None,
            ]
            for cand in legacy_cands:
                if cand and cand.exists():
                    note_md_path = cand
                    break

        dest_pdf_path = pdfs_dir / f"{stem}.pdf"
        assets_dir = sources_dir / "_assets" / stem

        # ── 1. Download Figures ──
        downloaded_figs = []
        if download_figures and figures:
            assets_dir.mkdir(parents=True, exist_ok=True)
            session = requests.Session()
            session.headers.update({
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                "Referer": meta_dict.get("url") or "https://jamanetwork.com/",
            })
            for idx, fig in enumerate(figures, 1):
                src = fig.get("src")
                if not src:
                    continue
                label = fig.get("label") or f"Fig_{idx}"
                caption = fig.get("caption") or ""
                # Determine extension
                clean_label = self._sanitize_filename(label)
                try:
                    r = session.get(src, timeout=12)
                    if r.status_code == 200:
                        content = r.content
                        if content.startswith(b"\x89PNG\r\n\x1a\n"):
                            ext = ".png"
                        elif content.startswith(b"\xff\xd8\xff"):
                            ext = ".jpg"
                        elif content.startswith((b"GIF87a", b"GIF89a")):
                            ext = ".gif"
                        elif content.startswith(b"RIFF") and content[8:12] == b"WEBP":
                            ext = ".webp"
                        else:
                            logging.warning(f"Figure URL returned non-image content: {src}")
                            continue
                        img_filename = f"{clean_label}_{idx}{ext}"
                        img_dest = assets_dir / img_filename
                        img_dest.write_bytes(content)
                        rel_img_path = f"_assets/{stem}/{img_filename}"
                        downloaded_figs.append({
                            "original_src": src,
                            "local_rel_path": rel_img_path,
                            "label": label,
                            "caption": caption,
                        })
                    else:
                        logging.warning(f"Figure download returned HTTP {r.status_code}: {src}")
                except Exception as e:
                    logging.warning(f"Failed to download image {src}: {e}")

        # ── 1b. Download / Resolve Official PDF ──
        saved_pdf = False
        pdf_source = None
        uploaded_path = (
            pdfs_dir / f"{uploaded_pdf_stem}.pdf"
            if uploaded_pdf_stem and re.fullmatch(r"[\w.\-]+", uploaded_pdf_stem)
            else None
        )
        if dest_pdf_path.exists() and self.pdf_resolver._is_valid_pdf_content(dest_pdf_path.read_bytes()[:2048]):
            saved_pdf = True
            pdf_source = "pre_uploaded"
            logging.info(f"PDF already present on disk: {dest_pdf_path}")
            if uploaded_path and uploaded_path.is_file() and uploaded_path != dest_pdf_path:
                uploaded_path.unlink(missing_ok=True)
        elif uploaded_path and uploaded_path.is_file() and self.pdf_resolver._is_valid_pdf_content(uploaded_path.read_bytes()[:2048]):
            import shutil
            shutil.copy2(uploaded_path, dest_pdf_path)
            saved_pdf = True
            pdf_source = "browser_capture"
            if uploaded_path != dest_pdf_path:
                uploaded_path.unlink(missing_ok=True)
        elif download_pdf and downloaded_file_path and Path(downloaded_file_path).exists():
            try:
                import shutil
                dl_p = Path(downloaded_file_path)
                if dl_p.is_file() and dl_p.stat().st_size > 1024:
                    raw_head = dl_p.read_bytes()[:2048]
                    if self.pdf_resolver._is_valid_pdf_content(raw_head):
                        dest_pdf_path.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(dl_p, dest_pdf_path)
                        saved_pdf = True
                        pdf_source = "chrome_downloads"
                        logging.info(f"Copied PDF from Chrome downloads {dl_p} -> {dest_pdf_path}")
                        try:
                            dl_p.unlink()
                        except Exception:
                            pass
            except Exception as e:
                logging.warning(f"Failed to process downloaded_file_path {downloaded_file_path}: {e}")

        if not saved_pdf and download_pdf:
            logging.info(f"Attempting to resolve and download PDF for {stem}...")
            ok, method = self.pdf_resolver.find_and_save_pdf(
                dest_path=dest_pdf_path,
                doi=meta.doi,
                pmid=meta.pmid,
                pdf_url=pdf_url,
                pdf_base64=pdf_base64,
                referer=referer,
            )
            if ok:
                saved_pdf = True
                pdf_source = method
                logging.info(f"PDF resolved and saved via {method}: {dest_pdf_path}")
            else:
                pdf_source = ("期刊網站未提供可存取的 PDF；請確認登入或訂閱權限。"
                              if browser_pdf_failure in {"publisher_rejected", "publisher_pdf_unavailable"} else method)
                logging.warning(f"Could not resolve PDF for {stem}: {method}")

        # The viewer download is a temporary inspection copy, even when the PDF
        # already exists in the vault or the user disables PDF storage.
        if downloaded_file_path:
            inspection_copy = Path(downloaded_file_path)
            if (inspection_copy.parent.name == "OB_Ingest" and
                    re.fullmatch(r"inspection_\d+(?: \(\d+\))?\.pdf", inspection_copy.name)):
                inspection_copy.unlink(missing_ok=True)
            elif (inspection_copy.parent == CACHE_DIR / "OB_Ingest" and
                    re.fullmatch(r"inspection_\d+\.pdf", inspection_copy.name)):
                inspection_copy.unlink(missing_ok=True)

        # ── 2. Zotero Lookup / Creation / Attachment ──
        zotero_key = None
        zotero_att_key = None
        if save_zotero:
            if meta.doi:
                item = self.zotero_client.find_item_by_doi(meta.doi)
                if item:
                    zotero_key = item.get("key")
            if not zotero_key and meta.pmid:
                item = self.zotero_client.find_item_by_pmid(meta.pmid)
                if item:
                    zotero_key = item.get("key")

            # If not found, try creating via Web API
            if not zotero_key and self.zotero_client.is_web_api_available():
                try:
                    new_key = self.zotero_client.create_item(meta, extra_tags=["chrome-captured", topic.lower()])
                    if new_key:
                        zotero_key = new_key
                except Exception as e:
                    logging.warning(f"Zotero web creation failed: {e}")

            # If Zotero item exists and PDF is saved, register PDF attachment in Zotero
            if zotero_key and saved_pdf and dest_pdf_path.exists():
                try:
                    zotero_att_key = self.zotero_client.add_pdf_attachment(zotero_key, dest_pdf_path)
                    if zotero_att_key:
                        logging.info(f"Attached PDF {dest_pdf_path.name} to Zotero item {zotero_key} (att={zotero_att_key})")
                except Exception as e:
                    logging.warning(f"Failed to attach PDF to Zotero: {e}")

        # ── 3. Write Structured Markdown Source ──
        if save_source:
            source_lines = []
            source_lines.append("---")
            source_lines.append(f"title: {_yaml_quote(meta.title)}")
            if meta.authors:
                source_lines.append(f"authors: {_yaml_quote(meta.authors)}")
            if meta.journal:
                source_lines.append(f"journal: {_yaml_quote(meta.journal)}")
            if meta.year:
                source_lines.append(f"year: {meta.year}")
            if meta.doi:
                source_lines.append(f"doi: {meta.doi}")
            if meta.pmid:
                source_lines.append(f"pmid: {meta.pmid}")
            if meta.citekey:
                source_lines.append(f"citekey: {meta.citekey}")
            if meta.url:
                source_lines.append(f"url: {meta.url}")
            if saved_pdf:
                source_lines.append(f"pdf: Research/{topic}/sources/etc/{stem}.pdf")
            if zotero_key:
                source_lines.append(f"zotero: zotero://select/library/items/{zotero_key}")
            source_lines.append(f"captured_date: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}")
            source_lines.append("type: source-snapshot")
            source_lines.append(f"tags: [source, {topic.lower()}, full-text]")
            source_lines.append("---")
            source_lines.append("")
            source_lines.append(f"# {meta.title}")
            source_lines.append("")

            # Abstract
            if meta.abstract:
                source_lines.append("## Abstract")
                source_lines.append(meta.abstract)
                source_lines.append("")

            # Main Body Sections
            if sections:
                for sec in sections:
                    heading = sec.get("heading", "").strip()
                    level = sec.get("level", 2)
                    text = sec.get("text", "").strip()
                    if heading:
                        source_lines.append(f"{'#' * level} {heading}")
                    if text:
                        source_lines.append(text)
                        source_lines.append("")

            # Figures Section
            if downloaded_figs:
                source_lines.append("## Figures & Captions")
                for fig_info in downloaded_figs:
                    source_lines.append(f"### {fig_info['label']}")
                    source_lines.append(f"![{fig_info['label']}]({fig_info['local_rel_path']})")
                    if fig_info['caption']:
                        source_lines.append(f"> 📌 **{fig_info['label']}**: {fig_info['caption']}")
                    source_lines.append("")

            # Tables Section
            if tables:
                source_lines.append("## Tables")
                for tbl in tables:
                    caption = tbl.get("caption", "Table")
                    md_table = tbl.get("markdown", "").strip()
                    source_lines.append(f"### {caption}")
                    if md_table:
                        source_lines.append(md_table)
                    source_lines.append("")

            source_md_path.write_text("\n".join(source_lines), encoding="utf-8")
            logging.info(f"Successfully saved source markdown: {source_md_path}")

        # ── 4. Write / Link Reading Note Shell ──
        note_created = False
        note_updated = False
        if save_note:
            rel_source = source_md_path.relative_to(notes_dir.parent).as_posix()
            if not note_md_path.exists():
                # Create clean initial reading note shell
                shell_lines = [
                    "---",
                    f"citekey: {meta.citekey}",
                    f"doi: {meta.doi or ''}",
                    f"pmid: {meta.pmid or ''}",
                    f"authors: {_yaml_quote(meta.authors)}",
                    f"journal: {_yaml_quote(meta.journal)}",
                    f"year: {meta.year or ''}",
                    f"source: \"[[{stem}]]\"",
                ]
                if saved_pdf:
                    shell_lines.append(f"pdf: Research/{topic}/sources/etc/{stem}.pdf")
                    shell_lines.append(f"source_pdf: ../sources/etc/{stem}.pdf")
                if zotero_key:
                    shell_lines.append(f"zotero: zotero://select/library/items/{zotero_key}")
                shell_lines.extend([
                    f"topic: {topic.lower()}",
                    "type: reading-note",
                    f"tags: [{topic.lower()}, reading-note]",
                    "---",
                    f"# {meta.title}",
                    "",
                    "## 縮寫對照｜Glossary",
                    "| 縮寫 | 全名 |",
                    "|---|---|",
                    "",
                    "---",
                    "",
                    "## 重要提問｜Key Questions",
                    "1. ",
                    "",
                    "---",
                    "",
                    "## 1. 研究背景與目的｜Background & Objective",
                    "",
                    "## 2. 方法與收案｜Methods & Cohort",
                    "",
                    "## 3. 主要研究結果｜Key Findings",
                    "",
                    "## 4. 臨床意涵與討論｜Clinical Implications",
                    "",
                ])
                note_md_path.write_text("\n".join(shell_lines), encoding="utf-8")
                note_created = True
                logging.info(f"Created new reading note shell: {note_md_path}")
            else:
                # Existing note exists: Update frontmatter in-place WITHOUT touching note body!
                updates = {}
                if meta.citekey:
                    updates["citekey"] = meta.citekey
                if meta.doi:
                    updates["doi"] = meta.doi
                if meta.pmid:
                    updates["pmid"] = meta.pmid
                if zotero_key:
                    updates["zotero"] = f"zotero://select/library/items/{zotero_key}"
                updates["source"] = f"[[{stem}]]"
                if saved_pdf:
                    updates["pdf"] = f"Research/{topic}/sources/etc/{stem}.pdf"
                    updates["source_pdf"] = f"../sources/etc/{stem}.pdf"

                changed, _, _, _ = update_note_frontmatter(note_md_path, updates, dry_run=False)
                note_updated = changed
                logging.info(f"Updated existing reading note frontmatter: {note_md_path} (changed={changed})")

        # ── 5. Record State Tracker ──
        primary_id = meta.doi or (f"pmid:{meta.pmid}" if meta.pmid else stem)
        state = self.state_tracker.get_or_create(paper_id=primary_id, doi=meta.doi, pmid=meta.pmid)
        if save_source:
            state.source_path = str(source_md_path)
        if saved_pdf:
            state.pdf_path = str(dest_pdf_path)
            try:
                state.pdf_hash = calculate_file_hash(dest_pdf_path)
            except Exception:
                pass
        if save_note:
            state.note_path = str(note_md_path)
        if zotero_key:
            state.zotero_key = zotero_key
            state.zotero_item_status = StepStatus.DONE
        self.state_tracker.update_state(state)

        return {
            "status": "success",
            "message": "文獻全文與結構化筆記已成功入庫！",
            "stem": stem,
            "metadata": {
                "title": meta.title,
                "authors": meta.authors,
                "journal": meta.journal,
                "year": meta.year,
                "citekey": meta.citekey,
                "doi": meta.doi,
                "pmid": meta.pmid,
            },
            "source": {
                "created": save_source,
                "path": str(source_md_path.relative_to(VAULT_DIR)) if save_source else None,
                "figures_found": len(figures),
                "figures_requested": download_figures,
                "figures_downloaded": len(downloaded_figs),
            },
            "pdf": {
                "saved": saved_pdf,
                "source": pdf_source,
                "path": str(dest_pdf_path.relative_to(VAULT_DIR)) if saved_pdf else None,
                "obsidian_uri": f"obsidian://open?vault={VAULT_NAME}&file={urllib.parse.quote(str(dest_pdf_path.relative_to(VAULT_DIR)))}" if saved_pdf else None,
                "size_bytes": dest_pdf_path.stat().st_size if (saved_pdf and dest_pdf_path.exists()) else 0,
                "zotero_attached": bool(zotero_att_key),
            },
            "note": {
                "created": note_created,
                "updated": note_updated,
                "path": str(note_md_path.relative_to(VAULT_DIR)) if save_note else None,
                "obsidian_uri": f"obsidian://open?vault={VAULT_NAME}&file={urllib.parse.quote(str(note_md_path.relative_to(VAULT_DIR)))}" if save_note else None,
            },
            "zotero": {
                "key": zotero_key,
                "url": f"zotero://select/library/items/{zotero_key}" if zotero_key else None,
            },
        }

    def handle_upload_pdf_chunk(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Receives chunked PDF data from Chrome extension (to bypass the 1MB Native Messaging limit).
        When the last chunk is received, verifies %PDF and writes to Research/<topic>/sources/pdfs/<stem>.pdf.
        """
        transfer_id = payload.get("transfer_id") or "default_pdf"
        chunk_index = int(payload.get("chunk_index", 0))
        total_chunks = int(payload.get("total_chunks", 1))
        chunk_b64 = payload.get("chunk_base64", "")
        topic = payload.get("topic", "Neurology")
        stem = payload.get("stem", "document")

        buf = self._pdf_upload_buffers.setdefault(transfer_id, {})
        buf[chunk_index] = chunk_b64

        logging.info(f"Received PDF chunk {chunk_index + 1}/{total_chunks} for {stem}")

        if len(buf) >= total_chunks and all(i in buf for i in range(total_chunks)):
            chunks_map = self._pdf_upload_buffers.pop(transfer_id, {})
            full_b64 = "".join(chunks_map[i] for i in range(total_chunks))
            import base64
            try:
                full_data = base64.b64decode(full_b64)
            except Exception as e:
                return {"status": "error", "transfer_id": transfer_id, "completed": False, "message": f"Base64 decode failed: {e}"}

            if not self.pdf_resolver._is_valid_pdf_content(full_data):
                logging.warning(f"Uploaded chunks for {stem} did not form a valid PDF (length={len(full_data)})")
                return {"status": "error", "transfer_id": transfer_id, "completed": False, "message": "上傳的內容不是有效的 PDF 檔案 (%PDF 標頭缺失)"}

            if payload.get("inspection"):
                dest_dir = CACHE_DIR / "OB_Ingest"
                dest_path = dest_dir / f"inspection_{int(time.time() * 1000)}.pdf"
            else:
                dest_dir = VAULT_DIR / "Research" / topic / "sources" / "etc"
                dest_path = dest_dir / f"{stem}.pdf"
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest_path.write_bytes(full_data)
            logging.info(f"Successfully assembled and saved PDF from {total_chunks} chunks: {dest_path} ({len(full_data)} bytes)")

            if payload.get("inspection"):
                self._pdf_inspection_paths[transfer_id] = str(dest_path)

            return {
                "status": "success",
                "transfer_id": transfer_id,
                "completed": True,
                "path": str(dest_path) if payload.get("inspection") else str(dest_path.relative_to(VAULT_DIR)),
                "bytes": len(full_data),
            }

        return {
            "status": "ok",
            "transfer_id": transfer_id,
            "completed": False,
            "chunk_index": chunk_index,
            "total_chunks": total_chunks,
        }

    def handle_save_reading_note(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Save reading note or translation draft imported from Gemini / clipboard.
        Preserves existing frontmatter verbatim while updating note body.
        """
        topic = payload.get("topic", "Neurology")
        citekey = payload.get("citekey")
        doi = normalize_doi(payload.get("doi"))
        pmid = normalize_pmid(payload.get("pmid"))
        target_type = payload.get("target_type", "note")  # "note" or "translation"
        raw_content = payload.get("content", "").strip()
        is_html = payload.get("is_html", False)
        is_pdf = payload.get("is_pdf", False)

        if not raw_content:
            return {"status": "error", "message": "剪貼簿或傳入內容為空，無法寫入。"}

        # Format conversion: only parse as HTML when actual HTML elements exist
        looks_like_html = bool(
            re.search(
                r"<\s*(?:p|div|h[1-6]|table|tr|td|th|ul|ol|li|strong|b|em|i|blockquote|pre|code|br|article|section|span)\b[^>]*>",
                raw_content,
                re.I,
            )
        )
        if looks_like_html and (is_html or "<p>" in raw_content or "</div>" in raw_content or "</h3>" in raw_content or "<table>" in raw_content):
            processed_content = clean_html_to_md(raw_content)
        elif is_pdf and not looks_like_html:
            processed_content = clean_pdf_text(raw_content)
        else:
            processed_content = raw_content

        # Determine file paths
        topic_dir = VAULT_DIR / "Research" / topic
        notes_dir = topic_dir / "notes"
        notes_dir.mkdir(parents=True, exist_ok=True)

        stem = payload.get("stem")
        note_path = None
        if stem:
            candidate = (notes_dir / f"{stem}.md") if target_type == "note" else (notes_dir / f"{stem}-中文翻譯.md")
            if candidate.exists():
                note_path = candidate
            elif target_type == "note" and (notes_dir / f"{stem}-notes.md").exists():
                note_path = notes_dir / f"{stem}-notes.md"
        if not note_path and citekey:
            candidate = (notes_dir / f"{citekey}.md") if target_type == "note" else (notes_dir / f"{citekey}-中文翻譯.md")
            if candidate.exists():
                note_path = candidate
            elif target_type == "note" and (notes_dir / f"{citekey}-notes.md").exists():
                note_path = notes_dir / f"{citekey}-notes.md"

        # If not found by stem/citekey, search existing note by DOI / PMID
        if (not note_path or not note_path.exists()) and (doi or pmid):
            for n in notes_dir.glob("*.md"):
                if target_type == "note" and n.name.endswith("-中文翻譯.md"):
                    continue
                if target_type == "translation" and not n.name.endswith("-中文翻譯.md"):
                    continue
                try:
                    n_id = extract_note_identity(n)
                    if (doi and n_id.extracted_doi and normalize_doi(n_id.extracted_doi) == doi) or \
                       (pmid and n_id.extracted_pmid and normalize_pmid(n_id.extracted_pmid) == pmid):
                        note_path = n
                        break
                except Exception:
                    pass

        if not note_path:
            base_name = stem or citekey or (f"pmid_{pmid}" if pmid else "unknown")
            fname = f"{base_name}.md" if target_type == "note" else f"{base_name}-中文翻譯.md"
            note_path = notes_dir / fname

        # Check for incoming frontmatter in processed_content to prevent duplication
        incoming_has_fm, incoming_fm, incoming_body = parse_frontmatter(processed_content)
        body_to_write = incoming_body.strip() if incoming_has_fm else processed_content.strip()

        if target_type == "note":
            # Preserve existing note's frontmatter verbatim
            if note_path.exists():
                existing_content = note_path.read_text(encoding="utf-8")
                has_fm, _, _ = parse_frontmatter(existing_content)
                if has_fm:
                    fm_lines = []
                    for line in existing_content.splitlines():
                        fm_lines.append(line)
                        if len(fm_lines) > 1 and line.strip() == "---":
                            break
                    frontmatter_block = "\n".join(fm_lines)
                    final_content = f"{frontmatter_block}\n\n{body_to_write}\n"
                else:
                    final_content = f"{body_to_write}\n"
            else:
                final_content = f"---\ncitekey: {citekey or ''}\ndoi: {doi or ''}\npmid: {pmid or ''}\ntopic: {topic.lower()}\ntype: reading-note\n---\n\n{body_to_write}\n"
        else:
            # Translation draft file
            if note_path.exists():
                existing_content = note_path.read_text(encoding="utf-8")
                has_fm, _, _ = parse_frontmatter(existing_content)
                if has_fm:
                    fm_lines = []
                    for line in existing_content.splitlines():
                        fm_lines.append(line)
                        if len(fm_lines) > 1 and line.strip() == "---":
                            break
                    frontmatter_block = "\n".join(fm_lines)
                    final_content = f"{frontmatter_block}\n\n{body_to_write}\n"
                else:
                    final_content = f"{body_to_write}\n"
            else:
                final_content = f"---\ntype: paper-translation\ncitekey: {citekey or ''}\ndoi: {doi or ''}\npmid: {pmid or ''}\ntopic: {topic.lower()}\n---\n\n{body_to_write}\n"

        note_path.write_text(final_content, encoding="utf-8")
        logging.info(f"Saved reading note content to {note_path} ({len(final_content)} chars)")

        rel_path = str(note_path.relative_to(VAULT_DIR))
        ob_uri = f"obsidian://open?vault={VAULT_NAME}&file={urllib.parse.quote(rel_path)}"

        return {
            "status": "success",
            "message": f"筆記內容已成功寫入 {note_path.name}！",
            "note_path": rel_path,
            "obsidian_uri": ob_uri,
            "target_type": target_type,
            "bytes_written": len(final_content.encode("utf-8")),
        }

    def process_message(self, message: Dict[str, Any]) -> Dict[str, Any]:
        action = message.get("action", "")
        payload = message.get("payload", {})
        logging.info(f"Handling action: {action}")

        try:
            # These values are directory/file names, never paths supplied by a webpage.
            fields = {"topic": payload.get("options", {}).get("topic", payload.get("topic"))}
            if action in {"upload_pdf_chunk", "save_reading_note"}:
                fields.update({key: payload.get(key) for key in ("stem", "citekey")})
            for field, value in fields.items():
                if value is not None and (not isinstance(value, str) or not value.strip()
                        or value in {".", ".."} or any(char in value for char in ("/", "\\", "\x00"))):
                    raise ValueError(f"Invalid {field}: expected a single directory or file name")
            if action == "ping":
                return self.handle_ping(payload)
            elif action == "inspect_pdf":
                return self.handle_inspect_pdf(payload)
            elif action == "check_status":
                return self.handle_check_status(payload)
            elif action == "ingest_webpage":
                return self.handle_ingest_webpage(payload)
            elif action == "upload_pdf_chunk":
                return self.handle_upload_pdf_chunk(payload)
            elif action == "save_reading_note":
                return self.handle_save_reading_note(payload)
            elif action == "get_gemini_config":
                return {"status": "ok", "config": self.gemini_client.get_status()}
            elif action == "save_gemini_config":
                api_key = payload.get("api_key", "").strip()
                model = payload.get("model", "gemini-2.5-flash")
                ok = self.gemini_client.save_config(api_key, model)
                if ok:
                    return {"status": "success", "message": "Gemini API 設定已儲存！", "config": self.gemini_client.get_status()}
                else:
                    return {"status": "error", "message": "儲存 Gemini 設定失敗。"}
            else:
                return {"status": "error", "message": f"Unknown action: {action}"}
        except Exception as e:
            logging.exception(f"Error handling action '{action}': {e}")
            return {"status": "error", "message": f"處理出錯: {str(e)}"}


def main():
    handler = NativeHostHandler()
    logging.info("Native Messaging Host started.")
    while True:
        message = read_message()
        if message is None:
            break
        response = handler.process_message(message)
        send_message(response)
    logging.info("Native Messaging Host exited.")


if __name__ == "__main__":
    main()
