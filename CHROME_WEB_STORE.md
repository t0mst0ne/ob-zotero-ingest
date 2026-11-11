# Chrome Web Store Submission & Reviewer Guide

Dashboard text for **OB–Zotero Academic Ingestion** (`dist/ob-zotero-1.0.0.zip`). The network claims below were checked against the extension (`chrome-extension/sidepanel.js`, `content_script.js`, `background.js`, `manifest.json`) and the optional host (`scripts/ingestion/metadata_client.py`, `pdf_resolver.py`, `zotero_client.py`, `gemini_client.py`, `scripts/native_host/native_host.py`).

The public privacy policy is https://t0mst0ne.github.io/ob-zotero-ingest/privacy/ (same text as [`PRIVACY.md`](PRIVACY.md)). That URL serves a page only after GitHub Pages is enabled for `main` / `docs`. Until then, the committed policy is [`PRIVACY.md`](PRIVACY.md).

---

## 1. Build the Store Package

```sh
.venv/bin/python -I scripts/package_extension.py
```

- **Output file:** `dist/ob-zotero-1.0.0.zip`
- `manifest.json` is at the archive root (`manifest_version: 3`).
- The development `"key"` is removed from the packaged manifest unless you pass `--keep-key`. A first store upload therefore receives a **new item ID**. See section 4.
- No `"cookies"` permission and no install-time `"<all_urls>"` host permission.
- The nine runtime files are `manifest.json`, `background.js`, `content_script.js`, `sidepanel.js`, `sidepanel.html`, `sidepanel.css`, `icons/icon16.png`, `icons/icon48.png`, and `icons/icon128.png`. The host, tests, and credentials are not in the zip.

---

## 2. Privacy Practices Tab

### Single purpose

> Extracts bibliographic metadata, article sections, figures, and tables from the active academic article or PDF tab when the user opens the side panel or clicks Refresh or Ingest, formats them as structured Markdown, and optionally saves them to a user-selected local folder. When the user has installed the local companion host, that host can also write the same files and, if the user stored their own keys locally, align the item with the user's Zotero library.

### Permission justifications

**sidePanel**

> Required to show the extension UI in Chrome’s side panel beside the article, so the user can preview extracted metadata, choose a vault folder, copy Markdown, and import a reading note without covering the paper.

**activeTab**

> Grants temporary access to the tab the user is viewing when they click the toolbar icon, so the extension can read citation metadata and article content on that page. It does not request the `tabs` permission. While the side panel remains open, switching to another tab reads that newly active tab; tabs are not read while the panel is closed, and no browsing history is stored.

**scripting**

> Used with `activeTab`, or with a later user-granted site origin, to inject `content_script.js` when the user opens the side panel or clicks Refresh / Ingest, in order to parse scholarly metadata, headings, figures, and tables from the current page.

**clipboardRead**

> Used only when the user clicks “讀取剪貼簿內容” (Read clipboard) in the side panel, to paste a reading note or translation into the note editor. The extension does not read the clipboard in the background.

**downloads**

> Used only when the user starts PDF inspection or ingestion and a direct in-tab fetch is blocked, so Chrome’s download manager can retrieve that PDF.

**nativeMessaging**

> Used to talk to the optional open-source local host (`com.ob.zotero.ingest`) that the user installs with `./install.sh`. The host writes Markdown, figures, and PDFs into the user’s vault, reads a local Zotero database only if the user passed `--zotero-dir`, and calls the scholarly APIs listed below. It calls `api.zotero.org` only when the user has stored a Zotero Web API key in local `zotero.json`. The Gemini client in the host package is not invoked by the host actions the extension sends; those actions only store a Gemini key locally if the user saves one. The extension works in browser-only mode without this host. No message is sent to a developer server.

**optional_host_permissions (`https://*/*`, `http://*/*`)**

> Academic journals are hosted on thousands of domains, so a fixed install-time host list is not practical. These patterns are not granted at install, and the extension never prompts for all websites. It does not request the `tabs` permission. A toolbar click uses `activeTab` for the open tab. Only if that is not enough, and only when the current origin is already known, Refresh asks for that one origin (for example `https://www.neurology.org/*`). `http://` is included for uncommon publisher or local pages still served over HTTP.

### Remote code

Select **No, I am not using remote code.** `background.js`, `sidepanel.js`, and `content_script.js` are packed in the zip. The extension source has no `eval`, `new Function`, or `importScripts`, and it does not load a remote script or CDN script.

### Data use

This extension **does handle user data**. Do **not** certify “No data collected” or “does not transmit user data to remote servers.” The extension reads the article the user is viewing and sends identifiers, and sometimes a PDF-page excerpt, to the scholarly services below. Cookies are not collected.

Paste guidance for the checkboxes:

| Dashboard item | Certify | Why |
| --- | --- | --- |
| Website content | **Yes** | After the user opens the side panel or starts an ingest, the extension reads the active article or PDF (title, authors, headings, body, figures, tables). Identifiers from that page or its URL may be sent to the APIs below. During PDF inspection the host may send up to 1000 characters of first-page text to Crossref. |
| Web history | **No** (switch to Yes if a reviewer treats the active-tab URL as history) | The extension does not store a browsing history. It sees the tab the user invoked, and, while the side panel is open, the active tab the user switches to. |
| User activity | **No** | Clicks stay inside the extension. They are not sent to a developer server. This is not keystroke, scroll, or mouse logging. |
| Personally identifiable information | **No** | The extension does not ask for the user’s name, email, or account. Unpaywall receives the fixed placeholder `academic-ingest@ob-vault.local`, which is not the user’s address. |
| Health information | **No** | Text of an academic paper is not the user’s own health record. |
| Financial and payment information | **No** | Not collected. |
| Authentication information | **No** (disclose the cookie behavior in the justification; switch to Yes if a reviewer disagrees) | The extension does not read `document.cookie`, does not use the `chrome.cookies` API, and does not collect passwords or API keys onto a developer server. Some PDF fetches use `credentials: "include"` so the browser can send the user’s existing cookies **to that publisher only**. A `chrome.downloads` fallback is a normal Chrome download of that PDF URL. |
| Personal communications | **No** | Clipboard text is read only when the user clicks “Read clipboard,” and it stays local. |
| Location | **No** | Not collected. |

Certify all three Limited Use statements:

- Data is **not sold**. Transfers are only the user-initiated requests in the table below, which provide the single purpose (an approved use, not a sale).
- Data is **not used or transferred for purposes unrelated** to that single purpose.
- Data is **not used to determine creditworthiness or for lending**.

Data leaves the browser only when the user is extracting or saving the current article, and only to the destinations below. Nothing is sent to a developer-operated server.

**Extension (`sidepanel.js`), on extract or save:**

- `https://api.crossref.org/works/{doi}` — DOI.
- `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi` — PMID.
- `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi` — PMCID or DOI, to find a PMID.
- `https://api.unpaywall.org/v2/{doi}?email=academic-ingest@ob-vault.local` — DOI and the placeholder email, when browser-vault mode saves a PDF.
- The current tab, its PDF URL, and figure URLs on the publisher or CDN (JAMA and NEJM PDF URLs are constructed in `content_script.js` and then fetched). Unpaywall’s `url_for_pdf` is fetched from whatever host Unpaywall returns.

**Optional host only** (local process; also repeats Crossref, PubMed, and Unpaywall):

- `https://api.crossref.org/works?query.bibliographic=...` — up to 1000 characters of first-page or OCR text, only when a PDF inspection has no DOI/PMID.
- `https://api.openalex.org/works/https://doi.org/{doi}` — DOI.
- `https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}?fields=openAccessPdf` — DOI.
- `https://www.ebi.ac.uk/europepmc/webservices/rest/search` — PMID or DOI.
- `https://europepmc.org/backend/ptpmcrender.fcgi?accid={pmcid}&blobtype=pdf` and `https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/pdf/` — PMCID.
- `https://www.biorxiv.org/content/{doi}.full.pdf` — DOIs that start with `10.1101/`. There is no request to `medrxiv.org` or `arxiv.org`.
- The article PDF URL, open-access PDF URLs returned by those APIs, and figure `src` URLs. Figure requests send the article URL as `Referer`, or `https://jamanetwork.com/` when the article URL is missing. A failed PDF GET is retried with `curl` against the same URL.
- `http://localhost:23119/api/application` — only if the user configured a local Zotero data directory. Also reads that directory’s `zotero.sqlite` locally.
- `https://api.zotero.org/users/{user_id}/items` — only if the user stored `user_id` and `api_key` in local `zotero.json`. Sends bibliographic fields and attachment records. PDF bytes are copied into local Zotero storage and are not uploaded to this API. The ingest checkbox is on by default.
- `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` — implemented in `scripts/ingestion/gemini_client.py`. The host actions the extension actually sends (`ping`, `inspect_pdf`, `check_status`, `ingest_webpage`, `upload_pdf_chunk`, `save_reading_note`, `get_gemini_config`, `save_gemini_config`) do **not** call it. Saving a key writes `gemini.json` on disk and returns a masked status over native messaging. Article text is not sent to Google by those actions.

### Privacy policy URL

```
https://t0mst0ne.github.io/ob-zotero-ingest/privacy/
```

Use this after Pages is enabled (Settings → Pages → Deploy from a branch → `main` → `/docs`). The page is `docs/privacy.md` with permalink `/privacy/`.

---

## 3. Instructions for Reviewers

> **Testing Mode 1 — Browser-only (no Python and no native host):**
>
> 1. Open an academic article with standard citation meta tags, for example a PubMed Central article at https://pmc.ncbi.nlm.nih.gov/ or a page that exposes `citation_title` / `citation_doi`.
> 2. Click the OB–Zotero Academic Ingestion toolbar icon to open the side panel.
> 3. The panel should show Title, Authors, Journal, Year, DOI, and/or PMID. On some publisher PDF viewers, metadata is recovered from the DOI or PMID in the URL via Crossref (`api.crossref.org`) or PubMed (`eutils.ncbi.nlm.nih.gov`). That network call is expected.
> 4. Click “📂 選擇 Vault 資料夾” (Select vault folder) and choose any local folder. The badge should change to a browser-direct / folder-connected state.
> 5. Click “🚀 一鍵入庫至本地庫” (Ingest to local vault) to write Markdown under `Research/<Topic>/sources/`. When PDF download is selected, the extension may also call Unpaywall (`api.unpaywall.org`) and fetch the PDF or figures from the publisher. You can copy Markdown to the clipboard, or use “📝 匯入閱讀筆記” to write `Research/<Topic>/notes/<stem>.md`.
>
> **Testing Mode 2 — Optional local host (macOS or Linux; not required to approve the item):**
>
> 1. Clone https://github.com/t0mst0ne/ob-zotero-ingest and run `./install.sh --vault /path/to/empty/vault --extension-id <this item’s Chrome Web Store ID>`. The store ID is not the unpacked development ID. Omit the flag only for an unpacked load of this repository.
> 2. Click the connection badge in the side panel. It should show a connected state.
> 3. Ingest again to write into the configured vault. The host may also call OpenAlex, Semantic Scholar, Europe PMC, and bioRxiv while resolving an open-access PDF. Zotero Web API and Gemini are not required for review. Gemini article upload is not performed by the current host actions.
>
> A review can be completed entirely with Mode 1.

---

## 4. Store builds get a new extension ID

`scripts/package_extension.py` strips `manifest.json` `"key"` so the Chrome Web Store will accept a first upload. This repository has `chrome-extension/key.pub` and does not contain the matching private `key.pem`. Unless that private key is supplied at upload time, the store assigns a new item ID. The item ID cannot be changed later.

The unpacked ID, from the manifest key, is `nigcccipceneamlocmomenlncpedpkne` (`chrome-extension/ext_id.txt`). `install.sh` forwards arguments to `scripts/native_host/install_host.py`, which defaults `allowed_origins` to `chrome-extension://nigcccipceneamlocmomenlncpedpkne/`.

A user or reviewer who installs the store package must register the host with the store ID:

```sh
./install.sh --vault /path/to/vault --extension-id <chrome-web-store-id>
```

If the host remains on the development ID, the store-installed extension cannot connect. Browser-only vault mode does not need the host.

After the first dashboard upload, copy the item ID. Putting the store public key back into the local manifest `key` field, so unpacked reloads match the store ID, is a later change. Chrome’s `key` field: https://developer.chrome.com/docs/extensions/reference/manifest/key
