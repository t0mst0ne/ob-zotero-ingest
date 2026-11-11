# Chrome Web Store Submission & Reviewer Guide

This document contains the exact package details, permission justifications, privacy declarations, and reviewer testing instructions required for submitting **OB–Zotero Academic Ingestion** (`dist/ob-zotero-1.0.0.zip`) to the Chrome Web Store.

---

## 1. Build the Store Package

Run the packaging script to generate the store-ready ZIP:

```sh
.venv/bin/python -I scripts/package_extension.py
```

- **Output file:** `dist/ob-zotero-1.0.0.zip`
- **Verification guarantees:**
  - `manifest.json` is at the archive root (`manifest_version: 3`).
  - Development `"key"` is automatically stripped from the packaged `manifest.json` so Chrome Web Store accepts new item uploads (while keeping `"key"` in `chrome-extension/manifest.json` for local unpacked testing).
  - No `"cookies"` permission or install-time `"<all_urls>"` host permissions are requested.
  - Only the 9 required browser runtime files are included (`manifest.json`, `background.js`, `content_script.js`, `sidepanel.js`, `sidepanel.html`, `sidepanel.css`, `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`).

---

## 2. Chrome Web Store Dashboard — Privacy Practices Tab

### Single Purpose Description
> Extracts academic article metadata (Title, Authors, Journal, Year, DOI, PMID), full-text sections, figures, and tables from the active tab into structured Obsidian Markdown, with optional local synchronization to the user's Obsidian Vault and Zotero library.

### Permission Justifications (Copy & Paste into Dashboard)

- **`sidePanel`**:
  > Required to display the extension's user interface in Chrome's Side Panel alongside the academic article being read, allowing the user to preview extracted metadata, select target folders, copy structured Markdown, and import reading notes.

- **`activeTab`**:
  > Grants temporary access to the currently active academic article tab when the user clicks the extension icon so the extension can extract citation metadata (`citation_doi`, `citation_pmid`, `citation_title`) and article sections without requiring broad install-time host permissions.

- **`scripting`**:
  > Used with `activeTab` (or user-granted optional host permissions) to run `content_script.js` on demand when the user opens the Side Panel or clicks "Refresh" / "Ingest" to parse scholarly metadata, headings, figures, and tables from the current page.

- **`optional_host_permissions` (`https://*/*`, `http://*/*`)**:
  > Academic journals are hosted across thousands of university, society, and publisher domains. Optional host permissions are requested only on user gesture if the user switches tabs while the Side Panel is already open and clicks "Refresh" (`🔄 重新整理`).

- **`clipboardRead`**:
  > Used exclusively when the user clicks the "📋 讀取剪貼簿內容" (Read Clipboard) button in the Side Panel to import reading notes or translations into their note editor.

- **`downloads`**:
  > Used only when the user explicitly requests PDF ingestion or PDF tab inspection and direct in-tab `fetch` is blocked by the publisher's viewer, delegating the PDF download to Chrome's download manager.

- **`nativeMessaging`**:
  > Used to communicate with the optional open-source local Python companion host (`com.ob.zotero.ingest`) on the user's computer to write Markdown notes and PDFs directly into the user's local Obsidian Vault and query local Zotero status.

### Data Usage Disclosures
- **Does this extension collect or transmit any user data to remote servers?** **No.**
- **Certification:** All three Chrome Web Store Limited Use / Data Usage checkboxes can be certified as **No data collected**.
- **Privacy Policy URL:** Point to the hosted URL of [`PRIVACY.md`](PRIVACY.md) in the GitHub repository.

---

## 3. Reviewer Testing Instructions (Copy & Paste into "Instructions for Reviewers")

> **Testing Mode 1 — Browser-Only Mode (No Local Native Host Installation Required):**
> 1. Open any academic article page, for example on PubMed Central or JAMA Network (e.g., `https://pmc.ncbi.nlm.nih.gov/` or any article with standard `citation_title` / `citation_doi` meta tags).
> 2. Click the **OB–Zotero Academic Ingestion** toolbar icon to open the Side Panel.
> 3. The Side Panel automatically extracts and displays the article's Title, Authors, Journal, Year, DOI, and PMID.
> 4. Click **"📋 複製結構化全文 Markdown"** (Copy Structured Full-Text Markdown). The extension generates the complete YAML frontmatter, abstract, structured headings, figure links, and Markdown tables and copies them directly to your clipboard (100% in-browser, without needing the companion Native Host).
> 5. In the bottom card ("📝 匯入閱讀筆記"), paste any HTML or text into the textarea to verify the note editor UI.
>
> **Testing Mode 2 — Optional Local Native Host Mode (macOS / Linux):**
> 1. Clone the companion repository and run `./install.sh --vault /path/to/empty/vault --extension-id <cws-extension-id>`.
> 2. Click the connection badge (`○ 點此重新連線`) at the top right of the Side Panel; it will turn green (`● 本地庫已連線`).
> 3. Click **"🚀 一鍵入庫至本地庫"** to write the extracted Markdown source, figures, and PDF directly into `Research/<Topic>/` inside the configured Obsidian Vault.
