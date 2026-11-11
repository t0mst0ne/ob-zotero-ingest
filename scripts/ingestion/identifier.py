"""
Identification and extraction of paper identities from PDFs and Obsidian notes.
"""

import hashlib
import re
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from .models import NoteIdentity, PDFIdentity

DOI_REGEX = re.compile(r'10\.\d{4,9}/[-._;()/:+a-zA-Z0-9]+', re.IGNORECASE)

PMID_REGEX = re.compile(r'\b(?:pmid[:\s]*|pubmed(?:\s*id)?[:\s]*)(\d{6,9})\b', re.IGNORECASE)
SUPPLEMENTARY_REGEX = re.compile(r'(moesm|esm\d*|supplement|suppl)', re.IGNORECASE)


def normalize_unicode_dashes(text: str) -> str:
    """Normalize various Unicode dashes to standard ASCII hyphen."""
    for dash in ('\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2212'):
        text = text.replace(dash, '-')
    return text


def normalize_doi(raw_doi: Optional[str]) -> Optional[str]:
    """
    Clean and normalize a DOI string.
    Removes URL prefixes, trailing punctuation, trailing 'doi:', and normalizes dashes.
    """
    if not raw_doi:
        return None
    d = raw_doi.strip()
    d = normalize_unicode_dashes(d)
    # Remove common URL prefixes
    d = re.sub(r'^https?://(?:dx\.)?doi\.org/', '', d, flags=re.IGNORECASE)
    d = re.sub(r'^doi:\s*', '', d, flags=re.IGNORECASE)
    # Strip trailing punctuation and trailing 'doi:' often caught in regex from medRxiv preprints
    d = d.rstrip('.,/);:\'" \t\n')
    d = re.sub(r'doi:?$', '', d, flags=re.IGNORECASE)
    d = d.rstrip('.,/);:\'" \t\n')

    m = DOI_REGEX.search(d)
    if m:
        cleaned = m.group(0).rstrip('.,/);:\'" \t\n')
        cleaned = re.sub(r'doi:?$', '', cleaned, flags=re.IGNORECASE)
        cleaned = cleaned.rstrip('.,/);:\'" \t\n')

        # Strip common PDF page header / article section suffixes concatenated without whitespace
        trailing_artifacts = (
            r'www\.nature\.com.*$',
            r'research$',
            r'original$',
            r'review$',
            r'letter$',
            r'correction$',
            r'received$',
            r'european$',
            r'into$',
            r'molecular$',
            r'alzheimer$',
            r'acta$',
            r'introduction$',
            r'and$',
            r'csf$',
        )
        for pat in trailing_artifacts:
            cleaned = re.sub(pat, '', cleaned, flags=re.IGNORECASE)
        cleaned = cleaned.rstrip('.,/);:\'" \t\n')

        return cleaned.lower()
    return None


def normalize_pmid(raw_pmid: Optional[str]) -> Optional[str]:
    """Extract and validate a PubMed ID."""
    if not raw_pmid:
        return None
    s = str(raw_pmid).strip()
    m = re.search(r'\b(\d{6,9})\b', s)
    return m.group(1) if m else None


def extract_lead_author(authors_str: Optional[str]) -> str:
    """
    Extract lead author surname from various author string formats:
    - "Campagna MP, Schneider JA" -> "Campagna"
    - "M. Pia Campagna, Julie A. Schneider" -> "Campagna"
    - "Campagna M., Schneider J." -> "Campagna"
    - "Matthew Campagna" -> "Campagna"
    - "Campagna, Matthew" -> "Campagna"
    - "Dr TestAuthor" -> "TestAuthor"
    """
    if not authors_str:
        return "Unknown"
    raw_first = str(authors_str).split(",")[0].strip()
    parts = [p for p in raw_first.split() if p.strip()]
    honorifics = {"dr", "prof", "mr", "ms", "mrs"}
    while parts and parts[0].lower().rstrip('.') in honorifics:
        parts.pop(0)
    if not parts:
        return "Unknown"
    if len(parts) == 1:
        surname = parts[0]
    else:
        p0_clean = re.sub(r'[^a-zA-Z]', '', parts[0])
        p_last_clean = re.sub(r'[^a-zA-Z]', '', parts[-1])
        is_last_initials = (
            len(p_last_clean) <= 3 and (parts[-1].endswith('.') or parts[-1].isupper() or len(p_last_clean) <= 2)
        )
        is_first_initials = (
            len(p0_clean) <= 2 or parts[0].endswith('.')
        )
        if is_last_initials and not is_first_initials:
            surname = parts[0]
        elif is_first_initials:
            surname = parts[-1]
        else:
            surname = parts[-1]
    clean = re.sub(r'[^a-zA-Z0-9]', '', surname)
    if clean and clean.islower():
        clean = clean.capitalize()
    return clean or "Unknown"


def calculate_file_hash(path: Path) -> str:
    """Compute SHA-256 hash of a file."""
    hasher = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def unbreak_line_broken_dois(text: str) -> str:
    """Join DOIs that are split across newlines in PDF text extraction."""
    # Pattern 1: https://doi.org/10.xxxx/abc \n def -> https://doi.org/10.xxxx/abcdef
    text = re.sub(
        r'(https?://(?:dx\.)?doi\.org/10\.\d{4,9}/[^\s\n]*?[-/])\s*\n\s*([a-zA-Z0-9._;()/:+-]+)',
        r'\1\2',
        text,
    )
    # Pattern 2: 10.xxxx/abc/ \n def -> 10.xxxx/abc/def
    text = re.sub(
        r'(10\.\d{4,9}/[^\s\n]*?[/-])\s*\n\s*([a-zA-Z0-9._;()/:+-]+)',
        r'\1\2',
        text,
    )
    return text


def extract_candidate_dois_from_text(text: str) -> List[str]:
    """
    Scan text for all valid DOIs, prioritizing article DOIs over commentary/erratum DOIs.
    """
    text = normalize_unicode_dashes(text)
    text = unbreak_line_broken_dois(text)
    primary_dois = []
    secondary_dois = []

    for line in text.splitlines():
        line_clean = line.strip()
        if not line_clean:
            continue
        is_commentary_or_erratum = bool(re.search(r'(commentary\s+on|erratum|correction\s+to|citing\s+article)', line_clean, re.I))
        matches = DOI_REGEX.findall(line_clean)

        for m in matches:
            norm = normalize_doi(m)
            if norm:
                if is_commentary_or_erratum:
                    if norm not in secondary_dois:
                        secondary_dois.append(norm)
                else:
                    if norm not in primary_dois:
                        primary_dois.append(norm)

    # Combine: primary DOIs first, then secondary
    combined = []
    for d in primary_dois + secondary_dois:
        if d not in combined:
            combined.append(d)

    # Filter out journal-level prefix DOIs (e.g. '10.1073/pnas') when a full article DOI ('10.1073/pnas.2401420121') exists
    filtered = []
    for d in combined:
        if not any(other.startswith(d + ".") or other.startswith(d + "/") for other in combined if other != d):
            filtered.append(d)

    return filtered



def extract_doi_from_text(text: str) -> Optional[str]:
    """Scan text for the first valid primary DOI."""
    dois = extract_candidate_dois_from_text(text)
    return dois[0] if dois else None


def extract_pmid_from_text(text: str) -> Optional[str]:
    """Scan text for PMID patterns."""
    m = PMID_REGEX.search(text)
    if m:
        return m.group(1)
    return None


def extract_pdf_identity(pdf_path: Path) -> PDFIdentity:
    """
    Analyze a PDF file to extract file hash, size, and metadata (DOI, PMID).
    Tries pypdf first, then pdfplumber if available.
    """
    pdf_path = Path(pdf_path).resolve()
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")

    file_size = pdf_path.stat().st_size
    file_hash = calculate_file_hash(pdf_path)
    is_supp = bool(SUPPLEMENTARY_REGEX.search(pdf_path.name))

    # Try extracting DOI/PMID from filename first
    filename_doi = None
    filename_pmid = None
    stem = pdf_path.stem
    # Pattern: 10.1177_13872877251323231 or 10.1038/s41467...
    if stem.startswith("10.") and "_" in stem:
        parts = stem.split("_", 1)
        filename_doi = normalize_doi(f"{parts[0]}/{parts[1]}")
    # Pattern: 37639492_Saloner_2024
    pmid_m = re.match(r'^(\d{7,9})_', stem)
    if pmid_m:
        filename_pmid = pmid_m.group(1)

    # Read PDF text (first 3 pages)
    text_content = ""
    try:
        import pypdf
        reader = pypdf.PdfReader(str(pdf_path))
        for page in reader.pages[:3]:
            t = page.extract_text() or ""
            text_content += "\n" + t
    except Exception:
        try:
            import pdfplumber
            with pdfplumber.open(pdf_path) as pdf:
                for page in pdf.pages[:3]:
                    t = page.extract_text() or ""
                    text_content += "\n" + t
        except Exception:
            pass

    candidate_dois = []
    text_doi = None
    text_pmid = None

    if text_content:
        candidate_dois = extract_candidate_dois_from_text(text_content)
        text_doi = candidate_dois[0] if candidate_dois else None
        text_pmid = extract_pmid_from_text(text_content)

    # If filename provided a DOI, put it first in candidate_dois
    if filename_doi and filename_doi not in candidate_dois:
        candidate_dois.insert(0, filename_doi)

    extracted_doi = filename_doi or text_doi
    extracted_pmid = filename_pmid or text_pmid

    return PDFIdentity(
        path=pdf_path,
        filename=pdf_path.name,
        file_hash=file_hash,
        file_size=file_size,
        extracted_doi=extracted_doi,
        extracted_pmid=extracted_pmid,
        candidate_dois=candidate_dois,
        is_supplementary=is_supp,
    )



def parse_frontmatter(content: str) -> Tuple[bool, Dict[str, Any], str]:
    """
    Parse YAML frontmatter from markdown content.
    Returns (has_frontmatter, frontmatter_dict, body_text).
    """
    lines = content.splitlines()
    if lines and lines[0].strip() == "---":
        end_idx = None
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                end_idx = i
                break
        if end_idx is not None:
            fm_text = "\n".join(lines[1:end_idx])
            body = "\n".join(lines[end_idx + 1:])
            try:
                data = yaml.safe_load(fm_text) or {}
                if isinstance(data, dict):
                    return True, data, body
            except Exception:
                pass
    return False, {}, content


def extract_note_identity(note_path: Path) -> NoteIdentity:
    """
    Analyze an existing Obsidian markdown note.
    Extracts frontmatter, DOI, PMID, citekey, and zotero link.
    """
    note_path = Path(note_path).resolve()
    if not note_path.exists():
        raise FileNotFoundError(f"Note file not found: {note_path}")

    content = note_path.read_text(encoding="utf-8")
    has_fm, fm_dict, body = parse_frontmatter(content)

    raw_doi = fm_dict.get("doi")
    raw_pmid = fm_dict.get("pmid")
    citekey = fm_dict.get("citekey")
    zotero_link = fm_dict.get("zotero")

    doi = normalize_doi(str(raw_doi)) if raw_doi else None
    pmid = normalize_pmid(str(raw_pmid)) if raw_pmid else None

    # Fallback to searching note body if missing in frontmatter
    if not doi:
        doi = extract_doi_from_text(content)
    if not pmid:
        pmid = extract_pmid_from_text(content)

    return NoteIdentity(
        path=note_path,
        filename=note_path.name,
        extracted_doi=doi,
        extracted_pmid=pmid,
        citekey=str(citekey).strip() if citekey else None,
        zotero_link=str(zotero_link).strip() if zotero_link else None,
        has_frontmatter=has_fm,
        existing_frontmatter=fm_dict,
        body=body,
    )
