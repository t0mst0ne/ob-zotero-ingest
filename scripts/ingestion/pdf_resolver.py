"""
Multi-source Academic PDF Resolver & Downloader.
Locates and downloads official paper PDFs via:
1. Direct active-tab browser session extraction (base64)
2. Direct public publisher PDF URL
3. Unpaywall Open Access API (fast, legal, high coverage)
4. OpenAlex Work API (direct OA PDF links)
5. Europe PMC / PubMed Central (PMC OA service)
6. Semantic Scholar Open Access API
7. bioRxiv / medRxiv / arXiv direct PDF endpoints
"""

import base64
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

try:
    from ingestion.identifier import normalize_doi, normalize_pmid
except ImportError:
    from scripts.ingestion.identifier import normalize_doi, normalize_pmid

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


class PDFResolver:
    def __init__(self, timeout: int = 10):
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "application/pdf,application/xhtml+xml,text/html,*/*;q=0.9",
            "Accept-Language": "en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7",
        })

    def _is_valid_pdf_content(self, data: bytes) -> bool:
        """Verify binary data contains PDF magic bytes and is non-empty."""
        return len(data) > 1024 and b"%PDF" in data[:1024]

    def save_from_base64(self, b64_str: str, dest_path: Path) -> bool:
        """Decode base64 string and save to dest_path if valid PDF."""
        try:
            raw_bytes = base64.b64decode(b64_str)
            if self._is_valid_pdf_content(raw_bytes):
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                dest_path.write_bytes(raw_bytes)
                logging.info(f"Saved PDF from browser base64 ({len(raw_bytes)} bytes) to {dest_path}")
                return True
            else:
                logging.warning(f"Base64 data is not a valid PDF (%PDF magic missing, length={len(raw_bytes)})")
        except Exception as e:
            logging.warning(f"Failed to decode base64 PDF: {e}")
        return False

    def download_url(
        self,
        url: str,
        dest_path: Path,
        referer: Optional[str] = None,
    ) -> bool:
        """Download from a direct URL with optional referer."""
        if not url or not url.startswith("http"):
            return False

        headers = {}
        if referer:
            headers["Referer"] = referer

        try:
            logging.info(f"Attempting PDF download from URL: {url}")
            r = self.session.get(url, headers=headers, timeout=self.timeout, stream=True, allow_redirects=True)
            if r.status_code == 200:
                # Read initial chunk to verify magic bytes
                content = r.content
                if self._is_valid_pdf_content(content):
                    dest_path.parent.mkdir(parents=True, exist_ok=True)
                    dest_path.write_bytes(content)
                    logging.info(f"Successfully downloaded PDF from {url} ({len(content)} bytes)")
                    return True
                else:
                    logging.warning(f"Downloaded content from {url} is not a valid PDF (len={len(content)})")
            else:
                logging.warning(f"Download from {url} returned HTTP {r.status_code}")
        except Exception as e:
            logging.warning(f"Error downloading PDF from {url}: {e}")

        # Fallback: Use curl with browser-like headers
        try:
            import subprocess
            curl_cmd = [
                "curl", "-s", "-L", "--compressed", "--max-time", str(self.timeout + 5),
                "-A", USER_AGENT,
                "-H", "Accept: application/pdf,application/xhtml+xml,text/html,*/*",
            ]
            if referer:
                curl_cmd.extend(["-e", referer])
            curl_cmd.extend(["-o", str(dest_path), url])
            res = subprocess.run(curl_cmd, capture_output=True, timeout=self.timeout + 10)
            if dest_path.exists():
                raw = dest_path.read_bytes()
                if self._is_valid_pdf_content(raw):
                    logging.info(f"Successfully downloaded PDF via curl fallback from {url} ({len(raw)} bytes)")
                    return True
                else:
                    dest_path.unlink()
        except Exception as e:
            logging.warning(f"Curl fallback failed for {url}: {e}")

        return False

    def resolve_unpaywall(self, doi: str, dest_path: Path) -> bool:
        """Check Unpaywall for legal Open Access PDF."""
        if not doi:
            return False
        clean_doi = normalize_doi(doi)
        if not clean_doi:
            return False

        api_url = f"https://api.unpaywall.org/v2/{clean_doi}?email=academic-ingest@ob-vault.local"
        try:
            r = self.session.get(api_url, timeout=10)
            if r.status_code == 200:
                data = r.json()
                # Check best OA location
                best_oa = data.get("best_oa_location") or {}
                candidates = []
                if best_oa.get("url_for_pdf"):
                    candidates.append(best_oa["url_for_pdf"])

                # Check other locations
                for loc in data.get("oa_locations", []):
                    u = loc.get("url_for_pdf")
                    if u and u not in candidates:
                        candidates.append(u)

                for pdf_url in candidates:
                    if self.download_url(pdf_url, dest_path):
                        return True
        except Exception as e:
            logging.warning(f"Unpaywall resolution failed for {doi}: {e}")
        return False

    def resolve_openalex(self, doi: str, dest_path: Path) -> bool:
        """Check OpenAlex for open access PDF URL."""
        if not doi:
            return False
        clean_doi = normalize_doi(doi)
        if not clean_doi:
            return False

        api_url = f"https://api.openalex.org/works/https://doi.org/{clean_doi}"
        try:
            r = self.session.get(api_url, timeout=10)
            if r.status_code == 200:
                data = r.json()
                best_oa = data.get("best_oa_location") or {}
                pdf_url = best_oa.get("pdf_url")
                if pdf_url and self.download_url(pdf_url, dest_path):
                    return True
        except Exception as e:
            logging.warning(f"OpenAlex resolution failed for {doi}: {e}")
        return False

    def resolve_semantic_scholar(self, doi: str, dest_path: Path) -> bool:
        """Check Semantic Scholar API for open access PDF."""
        if not doi:
            return False
        clean_doi = normalize_doi(doi)
        if not clean_doi:
            return False

        api_url = f"https://api.semanticscholar.org/graph/v1/paper/DOI:{clean_doi}?fields=openAccessPdf"
        try:
            r = self.session.get(api_url, timeout=10)
            if r.status_code == 200:
                data = r.json()
                oa_info = data.get("openAccessPdf") or {}
                pdf_url = oa_info.get("url")
                if pdf_url and self.download_url(pdf_url, dest_path):
                    return True
        except Exception as e:
            logging.warning(f"Semantic Scholar resolution failed for {doi}: {e}")
        return False

    def resolve_europe_pmc(self, pmid: Optional[str], doi: Optional[str], dest_path: Path) -> bool:
        """Check Europe PMC for full text PDF."""
        query = None
        if pmid:
            query = f"EXT_ID:{normalize_pmid(pmid)}%20AND%20SRC:MED"
        elif doi:
            query = f"DOI:{normalize_doi(doi)}"

        if not query:
            return False

        api_url = f"https://www.ebi.ac.uk/europepmc/webservices/rest/search?query={query}&format=json"
        try:
            r = self.session.get(api_url, timeout=10)
            if r.status_code == 200:
                results = r.json().get("resultList", {}).get("result", [])
                if results:
                    item = results[0]
                    pmcid = item.get("pmcid")
                    if pmcid:
                        # Try PMC PDF endpoints
                        candidates = [
                            f"https://europepmc.org/backend/ptpmcrender.fcgi?accid={pmcid}&blobtype=pdf",
                            f"https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/pdf/",
                        ]
                        for c in candidates:
                            if self.download_url(c, dest_path):
                                return True
        except Exception as e:
            logging.warning(f"Europe PMC resolution failed: {e}")
        return False

    def resolve_preprint(self, doi: str, dest_path: Path) -> bool:
        """Check bioRxiv / medRxiv direct PDF URL."""
        if not doi:
            return False
        clean_doi = normalize_doi(doi) or ""
        if clean_doi.startswith("10.1101/"):
            biorxiv_url = f"https://www.biorxiv.org/content/{clean_doi}.full.pdf"
            if self.download_url(biorxiv_url, dest_path):
                return True
        return False

    def find_and_save_pdf(
        self,
        dest_path: Path,
        doi: Optional[str] = None,
        pmid: Optional[str] = None,
        pdf_url: Optional[str] = None,
        pdf_base64: Optional[str] = None,
        referer: Optional[str] = None,
    ) -> Tuple[bool, str]:
        """
        Comprehensive multi-step pipeline to find and save the PDF:
        1. From browser base64 bytes (fastest, keeps auth/session in browser)
        2. From active-tab PDF URL
        3. From Unpaywall Open Access
        4. From OpenAlex Open Access
        5. From Europe PMC / PMC
        6. From Semantic Scholar
        7. From bioRxiv / medRxiv
        Returns (success: bool, method_or_error: str).
        """
        # 1. Browser Base64
        if pdf_base64:
            if self.save_from_base64(pdf_base64, dest_path):
                return True, "browser_capture"

        # 2. Direct Webpage PDF URL
        if pdf_url:
            if self.download_url(pdf_url, dest_path, referer=referer):
                return True, "webpage_link"

        # 3. Unpaywall Open Access API
        if doi:
            if self.resolve_unpaywall(doi, dest_path):
                return True, "unpaywall_oa"

        # 4. OpenAlex API
        if doi:
            if self.resolve_openalex(doi, dest_path):
                return True, "openalex_oa"

        # 5. Europe PMC / PMC
        if pmid or doi:
            if self.resolve_europe_pmc(pmid, doi, dest_path):
                return True, "pmc_oa"

        # 6. Semantic Scholar
        if doi:
            if self.resolve_semantic_scholar(doi, dest_path):
                return True, "semanticscholar_oa"

        # 7. bioRxiv / medRxiv
        if doi:
            if self.resolve_preprint(doi, dest_path):
                return True, "preprint_direct"

        # 8. Check Downloads folder for files downloaded via browser
        import shutil
        downloads_dir = Path.home() / "Downloads"
        for search_dir in [downloads_dir / "OB_Ingest", downloads_dir]:
            if search_dir.exists():
                candidates = []
                if pmid:
                    candidates.extend(list(search_dir.glob(f"*{pmid}*.pdf")))
                candidates.extend(list(search_dir.glob(f"{dest_path.name}")))
                for f in candidates:
                    if f.is_file() and f.stat().st_size > 1024:
                        if self._is_valid_pdf_content(f.read_bytes()[:2048]):
                            dest_path.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(f, dest_path)
                            logging.info(f"Found PDF in downloads folder {f} -> {dest_path}")
                            try:
                                f.unlink()
                            except Exception:
                                pass
                            return True, "browser_download"

        return False, "未能自動定位到可下載的 PDF 檔案（請確認該文獻是否受付費牆限制或由瀏覽器直接下載）。"
