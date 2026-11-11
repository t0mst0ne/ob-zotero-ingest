"""
Zotero Client supporting Zotero Local API with fallback to Zotero Web API.
Handles offline graceful degradation without throwing unhandled exceptions.
"""

import json
import os
import re
import shutil
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

from .models import PaperMetadata

DEFAULT_CONFIG_PATH = Path(__file__).parent.parent / ".zotero_config.json"
DEFAULT_LOCAL_STORAGE = Path("/Users/tomstone/Zotero/storage")


class ZoteroClient:
    def __init__(
        self,
        config_path: Optional[Path] = None,
        local_storage_dir: Optional[Path] = None,
        local_api_port: int = 23119,
        prefer_local: bool = True,
        timeout: int = 8,
    ):
        self.config_path = config_path or DEFAULT_CONFIG_PATH
        self.local_storage_dir = local_storage_dir or DEFAULT_LOCAL_STORAGE
        self.local_api_base = f"http://localhost:{local_api_port}"
        self.prefer_local = prefer_local
        self.timeout = timeout

        self.config = self._load_config()
        self.user_id = self.config.get("user_id", "")
        self.api_key = self.config.get("api_key", "")
        self.web_api_base = f"https://api.zotero.org/users/{self.user_id}" if self.user_id else ""

        self._load_local_sqlite_index()

    def _load_local_sqlite_index(self) -> None:
        """Fast offline index directly from Zotero SQLite database."""
        self._local_doi_map: Dict[str, str] = {}
        self._local_pmid_map: Dict[str, str] = {}
        self._local_attachments_map: Dict[str, List[str]] = {}
        sqlite_path = Path("/Users/tomstone/Zotero/zotero.sqlite")
        if not sqlite_path.exists():
            return
        try:
            import sqlite3
            conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
            cur = conn.cursor()
            cur.execute('''
                SELECT items.key, itemDataValues.value
                FROM items
                JOIN itemData ON items.itemID = itemData.itemID
                JOIN fields ON itemData.fieldID = fields.fieldID
                JOIN itemDataValues ON itemData.valueID = itemDataValues.valueID
                WHERE fields.fieldName = 'DOI'
            ''')
            for k, v in cur.fetchall():
                if v:
                    self._local_doi_map[v.strip().lower()] = k
            cur.execute('''
                SELECT items.key, itemDataValues.value
                FROM items
                JOIN itemData ON items.itemID = itemData.itemID
                JOIN fields ON itemData.fieldID = fields.fieldID
                JOIN itemDataValues ON itemData.valueID = itemDataValues.valueID
                WHERE fields.fieldName = 'extra'
            ''')
            for k, v in cur.fetchall():
                if v:
                    m = re.search(r'\b(?:pmid[:\s]*)(\d{6,9})\b', v, re.IGNORECASE)
                    if m:
                        self._local_pmid_map[m.group(1)] = k
            cur.execute('''
                SELECT parentItem.key, itemAttachments.path
                FROM itemAttachments
                JOIN items AS parentItem ON itemAttachments.parentItemID = parentItem.itemID
            ''')
            for p_key, path in cur.fetchall():
                if path:
                    fn = path.replace('storage:', '')
                    self._local_attachments_map.setdefault(p_key, []).append(fn)
            conn.close()
        except Exception:
            pass

    def _load_config(self) -> Dict[str, Any]:
        if self.config_path.exists():
            try:
                return json.loads(self.config_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {}

    def is_local_api_available(self) -> bool:
        """Check if Zotero Local API is responding."""
        try:
            r = requests.get(f"{self.local_api_base}/api/application", timeout=1.5)
            return r.status_code == 200
        except Exception:
            return False

    def is_web_api_available(self) -> bool:
        """Check if Web API credentials exist."""
        return bool(self.user_id and self.api_key)

    def get_status(self) -> Dict[str, Any]:
        local_ok = self.is_local_api_available()
        web_ok = self.is_web_api_available()
        mode = "offline"
        if local_ok and self.prefer_local:
            mode = "local"
        elif web_ok:
            mode = "web"
        return {
            "local_api": local_ok,
            "web_api": web_ok,
            "mode": mode,
            "user_id": self.user_id or None,
            "local_storage_exists": self.local_storage_dir.exists(),
        }

    # ── Search & Retrieval ───────────────────────────────────────────────────

    def find_item_by_doi(self, doi: str) -> Optional[Dict[str, Any]]:
        """Search Zotero library for an item by DOI."""
        if not doi:
            return None
        doi_clean = doi.lower().strip()

        # Check fast local SQLite index first
        if hasattr(self, '_local_doi_map') and doi_clean in self._local_doi_map:
            key = self._local_doi_map[doi_clean]
            return {"key": key, "data": {"DOI": doi_clean}, "version": 0}

        # Try Web API if local index didn't find it
        if self.is_web_api_available():
            try:
                headers = {"Zotero-API-Key": self.api_key}
                params = {"q": doi_clean, "qmode": "everything", "limit": 10}
                r = requests.get(f"{self.web_api_base}/items", headers=headers, params=params, timeout=self.timeout)
                if r.status_code == 200:
                    for item in r.json():
                        data = item.get("data", {})
                        item_doi = (data.get("DOI") or "").lower().strip()
                        if item_doi == doi_clean or doi_clean in item_doi:
                            return {"key": item["key"], "data": data, "version": item.get("version")}
            except Exception:
                pass

        return None

    def find_item_by_pmid(self, pmid: str) -> Optional[Dict[str, Any]]:
        """Search Zotero library for an item by PMID."""
        if not pmid:
            return None
        pmid_clean = str(pmid).strip()

        # Check fast local SQLite index first
        if hasattr(self, '_local_pmid_map') and pmid_clean in self._local_pmid_map:
            key = self._local_pmid_map[pmid_clean]
            return {"key": key, "data": {"extra": f"PMID: {pmid_clean}"}, "version": 0}

        if self.is_web_api_available():
            try:
                headers = {"Zotero-API-Key": self.api_key}
                params = {"q": f"PMID: {pmid_clean}", "qmode": "everything", "limit": 10}
                r = requests.get(f"{self.web_api_base}/items", headers=headers, params=params, timeout=self.timeout)
                if r.status_code == 200:
                    for item in r.json():
                        data = item.get("data", {})
                        extra = data.get("extra", "")
                        if f"PMID: {pmid_clean}" in extra or f"pmid: {pmid_clean}" in extra.lower():
                            return {"key": item["key"], "data": data, "version": item.get("version")}
            except Exception:
                pass

        return None

    def find_existing_attachments(self, parent_key: str) -> List[Dict[str, Any]]:
        """Retrieve existing child attachments of an item."""
        if hasattr(self, '_local_attachments_map') and parent_key in self._local_attachments_map:
            filenames = self._local_attachments_map[parent_key]
            return [{"data": {"filename": fn}} for fn in filenames]

        if not self.is_web_api_available():
            return []
        try:
            headers = {"Zotero-API-Key": self.api_key}
            r = requests.get(f"{self.web_api_base}/items/{parent_key}/children", headers=headers, timeout=self.timeout)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        return []

    # ── Creation & Modifications ─────────────────────────────────────────────

    def build_zotero_item(self, meta: PaperMetadata, extra_tags: Optional[List[str]] = None) -> Dict[str, Any]:
        """Convert PaperMetadata to Zotero journalArticle JSON payload."""
        creators = []
        for author in (meta.authors or "").split(", "):
            parts = author.strip().split(" ")
            if len(parts) >= 2:
                creators.append({
                    "creatorType": "author",
                    "lastName": parts[0],
                    "firstName": " ".join(parts[1:]),
                })
            elif parts and parts[0]:
                creators.append({"creatorType": "author", "name": parts[0]})

        tags = [{"tag": "auto-imported"}]
        if extra_tags:
            for t in extra_tags:
                tags.append({"tag": t})

        extra_parts = []
        if meta.pmid:
            extra_parts.append(f"PMID: {meta.pmid}")

        return {
            "itemType": "journalArticle",
            "title": meta.title or "",
            "creators": creators,
            "abstractNote": meta.abstract or "",
            "publicationTitle": meta.journal or "",
            "date": str(meta.year or ""),
            "DOI": meta.doi or "",
            "url": meta.url or "",
            "extra": "\n".join(extra_parts),
            "tags": tags,
        }

    def create_item(self, meta: PaperMetadata, extra_tags: Optional[List[str]] = None) -> Optional[str]:
        """Create a new journalArticle item in Zotero. Returns created item key."""
        if not self.is_web_api_available():
            return None

        payload = [self.build_zotero_item(meta, extra_tags)]
        headers = {"Zotero-API-Key": self.api_key, "Content-Type": "application/json"}
        try:
            r = requests.post(f"{self.web_api_base}/items", json=payload, headers=headers, timeout=self.timeout)
            if r.status_code == 200:
                res = r.json()
                key = res.get("successful", {}).get("0", {}).get("key")
                return key
        except Exception:
            pass
        return None

    def add_pdf_attachment(self, parent_key: str, pdf_path: Path) -> Optional[str]:
        """
        Register a PDF attachment item in Zotero and copy file into local storage.
        Returns attachment key or None.
        """
        if not self.is_web_api_available():
            return None
        pdf_path = Path(pdf_path).resolve()
        if not pdf_path.exists():
            return None

        headers = {"Zotero-API-Key": self.api_key, "Content-Type": "application/json"}
        attachment = [{
            "itemType": "attachment",
            "parentItem": parent_key,
            "linkMode": "imported_file",
            "title": pdf_path.name,
            "contentType": "application/pdf",
            "filename": pdf_path.name,
        }]

        try:
            r = requests.post(f"{self.web_api_base}/items", json=attachment, headers=headers, timeout=self.timeout)
            if r.status_code != 200:
                return None
            att_key = r.json().get("successful", {}).get("0", {}).get("key")
            if not att_key:
                return None

            # Copy PDF into local storage directory if storage dir exists
            if self.local_storage_dir.exists():
                dest_dir = self.local_storage_dir / att_key
                dest_dir.mkdir(parents=True, exist_ok=True)
                dest = dest_dir / pdf_path.name
                if not dest.exists():
                    shutil.copy2(pdf_path, dest)

            return att_key
        except Exception:
            return None

    def add_obsidian_backlink(self, parent_key: str, note_path: Path, vault_name: str = "OB") -> Optional[str]:
        """
        Add a linked_url attachment to Zotero pointing back to the Obsidian note.
        URL format: obsidian://open?vault=OB&file=<relative_path>
        """
        if not self.is_web_api_available():
            return None

        # Calculate relative path from vault root if possible
        try:
            vault_root = Path(__file__).parent.parent.parent
            rel_path = note_path.relative_to(vault_root).as_posix()
        except Exception:
            rel_path = note_path.name

        encoded_path = urllib.parse.quote(rel_path)
        ob_uri = f"obsidian://open?vault={vault_name}&file={encoded_path}"

        headers = {"Zotero-API-Key": self.api_key, "Content-Type": "application/json"}
        payload = [{
            "itemType": "attachment",
            "parentItem": parent_key,
            "linkMode": "linked_url",
            "title": f"Obsidian Note: {note_path.stem}",
            "url": ob_uri,
        }]

        try:
            r = requests.post(f"{self.web_api_base}/items", json=payload, headers=headers, timeout=self.timeout)
            if r.status_code == 200:
                return r.json().get("successful", {}).get("0", {}).get("key")
        except Exception:
            pass
        return None
