# Bug Check Report (by Gemini)

Date: 2026-11-11  
Repository: `ob-zotero-ingest`  
Status: **All 11 bugs resolved and verified with automated tests; Chrome Web Store compliance completed.**

---

## High Severity

### 1. Markdown / Plain-Text Corruption & Unreachable PDF Line-Repair in `handle_save_reading_note`
- **Locations**:
  - `scripts/native_host/native_host.py` (lines 944–956)
  - `chrome-extension/sidepanel.html` (lines 168–177)
  - `chrome-extension/sidepanel.js` (lines 883–884)
- **Description**:
  Both `#opt-auto-html` and `#opt-auto-pdf` checkboxes are `checked` by default in `sidepanel.html`, and `saveReadingNote()` passes their boolean checkbox states directly as `is_html: optAutoHtml.checked` and `is_pdf: optAutoPdf.checked` regardless of whether the pasted content is actually HTML.
  In `native_host.py`:
  ```python
  if is_html or ("<p>" in raw_content or "</div>" in raw_content or "</h3>" in raw_content or "<table>" in raw_content):
      processed_content = clean_html_to_md(raw_content)
  elif is_pdf:
      processed_content = clean_pdf_text(raw_content)
  else:
      processed_content = raw_content
  ```
- **Impact**:
  1. Because `is_html` is `True` by default, the `if` branch is always taken and `elif is_pdf:` (`clean_pdf_text`) is **unreachable** unless the user manually unchecks "HTML 自動轉 Markdown".
  2. When pasting plain text or Markdown (such as Gemini `/read-paper` output), `clean_html_to_md()` parses the Markdown through `BeautifulSoup(raw_content, 'html.parser')` and calls `.get_text()`. Any `<` or `>` characters in clinical statistics (e.g., `p < 0.001 ... > 5`) are treated as HTML tags and stripped out.

---

### 2. `AttributeError` Crash on Preprint vs. Journal Fallback in `match_and_plan`
- **Location**: `scripts/ingestion/matcher.py` (line 160)
- **Description**:
  ```python
  t_note = m_note.title if m_note else (note.frontmatter.get("title") if note and note.frontmatter else "")
  ```
  `NoteIdentity` (`scripts/ingestion/models.py`, lines 77–87) defines `existing_frontmatter`, not `frontmatter`.
- **Impact**:
  When comparing a preprint DOI and a published journal DOI and `metadata_client.fetch_metadata(doi=note_doi)` returns `None` (e.g., offline mode or unindexed preprint), evaluating `note.frontmatter` raises `AttributeError: 'NoteIdentity' object has no attribute 'frontmatter'`.

---

### 3. Inline Formatting Destroyed & Row Headers Misplaced in `clean_html_to_md`
- **Location**: `scripts/native_host/native_host.py` (lines 188–226)
- **Description**:
  - Block elements (`h1`–`h6`, `p` at lines 193–197) are replaced using `.get_text()` **before** inline elements (`strong`, `b`, `em`, `i`, `code` at lines 198–208). Calling `p.replace_with(f'\n\n{p.get_text().strip()}\n\n')` strips all descendant `<strong>`, `<em>`, and `<code>` tags inside paragraphs before the inline replacement loops execute.
  - For tables (lines 211–220), `table.find_all('th')` collects every `<th>` across the entire table (including `<th scope="row">` cells in body rows) into a single header row, while the `<tr>` loop only collects `<td>` cells, misaligning table columns.
- **Impact**:
  Bold, italic, and inline code inside HTML paragraphs are lost when converting to Markdown, and tables with row-header `<th>` cells are corrupted.

---

### 4. Unescaped YAML Strings Break Frontmatter Parsing in `handle_ingest_webpage`
- **Location**: `scripts/native_host/native_host.py` (lines 681–685, 762–763)
- **Description**:
  `meta.title`, `meta.authors`, and `meta.journal` are interpolated directly into double-quoted YAML strings (`f"title: \"{meta.title}\""`) without escaping `"` or `\` (unlike `_format_yaml_value` in `scripts/ingestion/note_updater.py`).
- **Impact**:
  Any paper title or journal name containing double quotes produces invalid YAML frontmatter, causing `parse_frontmatter` (`yaml.safe_load` in `scripts/ingestion/identifier.py`) to fail and treat the file as having no frontmatter (`has_frontmatter=False`).

---

## Medium Severity

### 5. Hardcoded `vault=OB` in Sidepanel PDF Link
- **Location**: `chrome-extension/sidepanel.js` (lines 774–776)
- **Description**:
  ```javascript
  linkObPdf.href = `obsidian://open?vault=OB&file=${encodeURIComponent(res.pdf.path)}`;
  ```
- **Impact**:
  Unlike `res.note.obsidian_uri` (which uses the configured `VAULT_NAME` from `native_host.py`), clicking "📄 開啟原始 PDF" hardcodes `vault=OB` and fails when the user's Obsidian vault has any other name.

---

### 6. Stem Mismatch Between Browser Upload and Backend Ingest Orphans Uploaded PDFs & Misnames Notes
- **Locations**:
  - `chrome-extension/sidepanel.js` (lines 140–143, 471–481, 567–591, 734–796, 873)
  - `scripts/native_host/native_host.py` (lines 479–514, 587–595)
- **Description**:
  1. When a DOI contains parentheses, colons, or semicolons (common in Lancet/Wiley DOIs such as `10.1016/s0140-6736(24)00123-4`), `computeStem` in `sidepanel.js` (line 479) and `safe_doi` in `native_host.py` (line 510) only replace `/` with `_`.
  2. `handle_upload_pdf_chunk` saves the uploaded file using that `stem`, but `handle_ingest_webpage` (line 587) validates `uploaded_pdf_stem` with `re.fullmatch(r"[\w.\-]+", uploaded_pdf_stem)`, which rejects parentheses/colons/semicolons. If the backend also resolves a PMID via `find_pmid_by_doi` or normalizes metadata via CrossRef/PubMed, `dest_pdf_path` uses a different stem, leaving the uploaded PDF orphaned in `sources/etc/` and re-downloading the PDF.
  3. `handleIngestionSuccess` in `sidepanel.js` never updates `currentArticleData.metadata` with `res.metadata` (and `handleNativeResponse` at line 140 compares normalized lowercase `msg.doi` against raw `currentArticleData.metadata.doi` with `===`). When the user subsequently clicks "寫入 Obsidian 筆記" (`saveReadingNote`), `computeStem(currentArticleData.metadata)` can compute a stale stem that does not match the ingested source/note file.

---

### 7. Duplicate Table Extraction in `extractTables`
- **Location**: `chrome-extension/content_script.js` (lines 343–364)
- **Description**:
  ```javascript
  const tableWraps = document.querySelectorAll(".table-wrap, .c-article-table, figure.table, table");
  ```
  When a `<table>` is nested inside `.table-wrap`, `.c-article-table`, or `figure.table` (standard across PMC, Nature/Springer, JAMA, etc.), `querySelectorAll` matches **both** the wrapper element and the inner `<table>` element.
- **Impact**:
  Every wrapped table is extracted and written to the Markdown source twice.

---

### 8. Zotero Local Index & Local Mode Mismatches in `ZoteroClient`
- **Locations**:
  - `scripts/ingestion/zotero_client.py` (lines 84–93, 117–131, 190–195)
  - `scripts/ingestion/matcher.py` (lines 304, 319)
  - `scripts/ingestion/core.py` (lines 94–110)
- **Description**:
  1. `find_existing_attachments` (lines 192–194) returns `[{"data": {"filename": fn}}]` from `_local_attachments_map` without any `"url"` field (and `_load_local_sqlite_index` only queries `itemAttachments.path`). Consequently, `has_ob_link = any("obsidian://" in a.get("data", {}).get("url", "") for a in attachments)` in `matcher.py` (line 304) is always `False` for locally indexed items, causing duplicate Obsidian backlinks to be planned/created.
  2. `get_status()` reports `mode: "local"` when port `23119` responds even if Web API credentials (`user_id`/`api_key`) are not configured, causing `core.py` and `matcher.py` to attempt write operations (`create_item`, `add_pdf_attachment`, `add_obsidian_backlink`) that immediately fail because those methods require `is_web_api_available()`.

---

### 9. PubMed Lookup Shadows CrossRef Abstract & DOI Cache Misses Resolved PMID in `MetadataClient.fetch_metadata`
- **Location**: `scripts/ingestion/metadata_client.py` (lines 125, 220, 253–267)
- **Description**:
  - When both `doi` and `pmid` are provided, `fetch_metadata` calls `fetch_pubmed(pmid)` first and returns immediately. Because `fetch_pubmed` uses `esummary.fcgi` and hardcodes `abstract=""` (line 220), any paper with a PMID receives an empty abstract instead of enriching from CrossRef.
  - When only `doi` is provided, `fetch_crossref(doi)` caches `self._cache[f"doi:{doi.lower()}"]` with `pmid: None` (line 125) *before* `find_pmid_by_doi(doi)` runs (line 263), and never saves the resolved `meta.pmid` back to `self._cache`—forcing a live PubMed `esearch.fcgi` network call on every subsequent lookup of the same DOI.

---

## Low Severity

### 10. `PaperState.source_path` Not Persisted in `models.py`
- **Locations**:
  - `scripts/native_host/native_host.py` (lines 825–826)
  - `scripts/ingestion/models.py` (lines 125–177)
- **Description**:
  `handle_ingest_webpage` sets `state.source_path = str(source_md_path)`, but `PaperState` does not declare `source_path` in its dataclass fields, `to_dict()`, or `from_dict()`.
- **Impact**:
  `source_path` is silently dropped whenever `IngestionStateTracker.save()` serializes state to `ingest_state.json`.

---

### 11. Non-Relative Imports in `gemini_client.py`
- **Location**: `scripts/ingestion/gemini_client.py` (lines 16–18)
- **Description**:
  Uses `from ingestion.identifier import ...` instead of relative imports `from .identifier import ...` (unlike all other modules in `scripts/ingestion/`).
- **Impact**:
  Importing `scripts.ingestion.gemini_client` from the repository root without `scripts/` on `sys.path` raises `ModuleNotFoundError: No module named 'ingestion'`.
