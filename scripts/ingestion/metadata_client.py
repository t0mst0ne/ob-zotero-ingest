"""
Metadata client for CrossRef and PubMed APIs.
"""

import re
import unicodedata
from typing import Optional

import requests

from .identifier import extract_lead_author, normalize_doi
from .models import PaperMetadata


def _ascii(s: str) -> str:
    """Strip diacritics and non-ASCII characters."""
    return unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii')


def generate_citekey(meta: PaperMetadata) -> str:
    """
    Generate standard citekey: [firstauthor][year][keyword].
    Example: wimo2025cost
    """
    first_author = "unknown"
    if meta.authors:
        author_lead = extract_lead_author(meta.authors)
        first_author = re.sub(r'[^\w]', '', _ascii(author_lead.lower()))

    year_str = str(meta.year) if meta.year else ""
    stop_words = {"a", "an", "the", "of", "in", "on", "for", "and", "to", "with", "is", "at", "by"}
    words = [w.lower() for w in re.split(r'\W+', meta.title or "") if w and w.lower() not in stop_words]
    keyword = re.sub(r'[^\w]', '', words[0]) if words else ""

    return f"{first_author}{year_str}{keyword}"


import json
from pathlib import Path

DEFAULT_METADATA_CACHE = Path(__file__).parent.parent / ".cache" / "metadata_cache.json"


class MetadataClient:
    def __init__(
        self,
        user_agent: str = "OBVault/2.0 (mailto:iamtomstone@gmail.com)",
        timeout: int = 5,
        cache_file: Optional[Path] = None,

    ):
        self.user_agent = user_agent
        self.timeout = timeout
        self.cache_file = cache_file or DEFAULT_METADATA_CACHE
        self._cache = self._load_cache()

    def _load_cache(self) -> dict:
        if self.cache_file.exists():
            try:
                return json.loads(self.cache_file.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {}

    def _save_cache(self) -> None:
        try:
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)
            self.cache_file.write_text(json.dumps(self._cache, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    def fetch_crossref(self, doi: str) -> Optional[PaperMetadata]:
        """Fetch paper metadata from CrossRef API."""
        cache_key = f"doi:{doi.lower()}"
        if cache_key in self._cache:
            data = self._cache[cache_key]
            meta = PaperMetadata(**data)
            if not meta.citekey:
                meta.citekey = generate_citekey(meta)
            return meta

        url = f"https://api.crossref.org/works/{doi}"
        headers = {"User-Agent": self.user_agent}

        try:
            r = requests.get(url, headers=headers, timeout=self.timeout)
            if r.status_code != 200:
                return None
            msg = r.json().get("message", {})
            authors = msg.get("author", [])
            author_parts = []
            for a in authors[:6]:
                fam = a.get("family", "")
                giv = a.get("given", "")
                if fam and giv:
                    author_parts.append(f"{fam} {giv[0]}.")
                elif fam:
                    author_parts.append(fam)
            author_str = ", ".join(author_parts)

            year = None
            pub = msg.get("published", {}).get("date-parts", [[]])
            if pub and pub[0]:
                year = pub[0][0]

            title_list = msg.get("title", [])
            title = title_list[0] if title_list else ""

            journal_list = msg.get("container-title", [])
            journal = journal_list[0] if journal_list else ""

            abstract = re.sub(r'<[^>]+>', '', msg.get("abstract", "")).strip()

            meta = PaperMetadata(
                title=title,
                authors=author_str,
                journal=journal,
                year=year,
                doi=msg.get("DOI", doi).lower(),
                abstract=abstract,
                url=msg.get("URL"),
            )
            meta.citekey = generate_citekey(meta)
            self._cache[cache_key] = meta.to_dict()
            self._save_cache()
            return meta
        except Exception:
            return None

    def search_by_bibliographic_text(self, text: str, rows: int = 5) -> list[PaperMetadata]:
        """Return Crossref candidates for title/author text when identifiers are absent."""
        query = " ".join((text or "").split())[:1000]
        if len(query) < 20:
            return []
        try:
            response = requests.get(
                "https://api.crossref.org/works",
                params={"query.bibliographic": query, "rows": max(1, min(rows, 10))},
                headers={"User-Agent": self.user_agent},
                timeout=self.timeout,
            )
            if response.status_code != 200:
                return []
            items = response.json().get("message", {}).get("items", [])
        except Exception:
            return []

        candidates = []
        for item in items:
            title_values = item.get("title") or []
            doi = normalize_doi(item.get("DOI"))
            if not title_values or not doi:
                continue
            authors = []
            for author in (item.get("author") or [])[:6]:
                family = author.get("family", "")
                given = author.get("given", "")
                if family and given:
                    authors.append(f"{family} {given[0]}.")
                elif family:
                    authors.append(family)

            year = None
            for date_field in ("published", "published-online", "published-print", "created"):
                date_parts = item.get(date_field, {}).get("date-parts", [])
                if date_parts and date_parts[0] and isinstance(date_parts[0][0], int):
                    year = date_parts[0][0]
                    break

            meta = PaperMetadata(
                title=title_values[0],
                authors=", ".join(authors),
                journal=(item.get("container-title") or [""])[0],
                year=year,
                doi=doi,
                abstract=re.sub(r"<[^>]+>", "", item.get("abstract", "")).strip(),
                url=item.get("URL"),
            )
            meta.citekey = generate_citekey(meta)
            candidates.append(meta)
        return candidates

    def fetch_pubmed(self, pmid: str) -> Optional[PaperMetadata]:
        """Fetch paper metadata from PubMed API."""
        cache_key = f"pmid:{pmid.strip()}"
        if cache_key in self._cache:
            data = self._cache[cache_key]
            meta = PaperMetadata(**data)
            if not meta.citekey:
                meta.citekey = generate_citekey(meta)
            return meta

        url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
        params = {"db": "pubmed", "id": pmid, "retmode": "json"}
        try:
            r = requests.get(url, params=params, timeout=self.timeout)
            if r.status_code != 200:
                return None
            result = r.json().get("result", {})
            data = result.get(pmid, {})
            if not data or data.get("error") or not data.get("title"):
                return None

            authors = ", ".join(a.get("name", "") for a in data.get("authors", [])[:6] if a.get("name"))

            pubdate = data.get("pubdate", "")
            year = int(pubdate[:4]) if pubdate and pubdate[:4].isdigit() else None

            article_ids = data.get("articleids", [])
            doi = next((i["value"].lower() for i in article_ids if i.get("idtype") == "doi"), None)

            meta = PaperMetadata(
                title=data.get("title", "").rstrip('.'),
                authors=authors,
                journal=data.get("source", ""),
                year=year,
                doi=doi,
                pmid=pmid,
                abstract="",
            )
            meta.citekey = generate_citekey(meta)
            self._cache[cache_key] = meta.to_dict()
            if doi:
                self._cache[f"doi:{doi}"] = meta.to_dict()
            self._save_cache()
            return meta
        except Exception:
            return None

    def find_pmid_by_doi(self, doi: str) -> Optional[str]:
        """Resolve an exact DOI through PubMed before assigning a PMID."""
        clean_doi = normalize_doi(doi)
        if not clean_doi:
            return None
        try:
            response = requests.get(
                "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
                params={"db": "pubmed", "term": f'"{clean_doi}"[DOI]', "retmode": "json", "retmax": 5},
                timeout=self.timeout,
            )
            if response.status_code != 200:
                return None
            for candidate in response.json().get("esearchresult", {}).get("idlist", []):
                record = self.fetch_pubmed(candidate)
                if record and normalize_doi(record.doi) == clean_doi:
                    return candidate
        except Exception:
            pass
        return None


    def fetch_metadata(self, doi: Optional[str] = None, pmid: Optional[str] = None) -> Optional[PaperMetadata]:
        """
        Fetch metadata trying CrossRef (if DOI provided) first, then PubMed.
        """
        if pmid:
            pubmed = self.fetch_pubmed(pmid)
            if pubmed:
                return pubmed
        meta = self.fetch_crossref(doi) if doi else None
        if doi and not pmid:
            pmid = self.find_pmid_by_doi(doi)
        if meta:
            meta.pmid = pmid or meta.pmid
            return meta
        return self.fetch_pubmed(pmid) if pmid else None
