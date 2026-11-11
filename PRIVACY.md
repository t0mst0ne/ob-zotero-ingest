# Privacy Policy / 隱私權政策 — OB–Zotero Academic Ingestion

**Last Updated / 最後更新日期:** 2026-11-11

---

## English

### 1. Single Purpose
**OB–Zotero Academic Ingestion** extracts bibliographic metadata (Title, Authors, Journal, Year, DOI, PMID), article sections, figures, and tables from the active academic article tab upon explicit user action, formats them into structured Markdown, and optionally saves them to a user-configured local Obsidian Vault and Zotero library via a local Native Messaging Host.

### 2. Data Collection & Storage
- **No Remote Analytics or Tracking:** This extension does **not** collect, transmit, sell, or store any personal data, browsing history, or telemetry on developer-operated servers.
- **Local Processing Only:** Extracted article text, metadata, and clipboard notes are processed locally within the browser — written directly to a user-selected local folder via the browser's native File System Access API (`window.showDirectoryPicker`), or sent via Chrome Native Messaging (`stdio`) to the user's own local Python Native Host (`com.ob.zotero.ingest`) to write Markdown/PDF files into the user's local Obsidian Vault directory.
- **No Cookie Exfiltration:** The extension does **not** read `document.cookie` or use the `chrome.cookies` API, and never exports browser session cookies outside the browser.

### 3. External API Requests (Initiated by Local Host Only When Configured)
When the optional local Native Host is installed and triggered by the user:
- **Public Bibliographic & Open-Access APIs:** The local host may query public academic databases (`api.crossref.org`, `eutils.ncbi.nlm.nih.gov`, `api.unpaywall.org`, `api.openalex.org`, `www.ebi.ac.uk/europepmc`, `api.semanticscholar.org`) using only the article's public DOI, PMID, or title.
- **User-Configured Zotero / Gemini APIs (Optional):** If the user configures their own Zotero Web API key (`zotero.json`) or Google Gemini API key (`gemini.json`) in their local OS configuration directory (`~/Library/Application Support/OB-Zotero/`), the local host communicates directly with `api.zotero.org` or `generativelanguage.googleapis.com` using the user's own credentials.

### 4. Permissions Justification
- **`sidePanel`**: Displays the article extraction, vault alignment status, and Markdown import interface in Chrome's Side Panel.
- **`activeTab` & `scripting`**: Executes `content_script.js` in the currently active tab when the user opens the Side Panel or clicks "重新整理" / "一鍵入庫" to extract academic metadata, text sections, figures, and tables.
- **`optional_host_permissions` (`https://*/*`, `http://*/*`)**: Not granted at install, and the `"tabs"` permission is not requested. These hosts are requested only when the user clicks「重新整理」. If the current tab URL is already known, only that site's origin is requested. If Chrome omitted the URL (no `activeTab` grant and no host permission yet), the same click asks for these optional http(s) patterns so detection can continue.
- **`clipboardRead`**: Used only when the user explicitly clicks the "📋 讀取剪貼簿內容" button to paste reading notes into the Side Panel.
- **`downloads`**: Used only when the user initiates PDF ingestion or inspection on a PDF tab and in-page `fetch` is unavailable.
- **`nativeMessaging`**: Connects to the optional local host (`com.ob.zotero.ingest`) installed by the user to write files into their local Obsidian Vault and check local Zotero status.

---

## 繁體中文

### 1. 單一用途說明
**OB–Zotero Academic Ingestion** 僅在使用者主動點擊操作時，從目前瀏覽的學術論文頁面擷取書目資訊（標題、作者、期刊、年份、DOI、PMID）、章節內文、圖表與表格，轉換為結構化 Markdown，並可選擇透過本地端 Native Messaging Host 寫入使用者自己電腦上的 Obsidian Vault 與 Zotero 書目庫。

### 2. 資料收集與儲存原則
- **不收集個人資料或瀏覽紀錄**：本擴充功能**不會**向任何開發者伺服器傳送、收集、分析或販售使用者的個人資料、瀏覽紀錄或遙測數據。
- **純本地端處理**：擷取的論文內容與剪貼簿筆記僅在瀏覽器內處理，或透過 Chrome Native Messaging (`stdio`) 傳送至使用者本機自行安裝的 Python Host (`com.ob.zotero.ingest`)，直接寫入本機的 Obsidian Vault 資料夾。
- **不讀取或外傳 Cookie**：本擴充功能**不要求** `cookies` 權限，不讀取 `document.cookie`，亦不會將瀏覽器登入憑證或 Cookie 傳遞至外部程式。

### 3. 第三方公開 API 查詢（僅由本地端依需求發起）
- **公開學術書目與開放取用 API**：本地端為補齊 DOI/PMID 書目或尋找合法開放取用 (Open Access) PDF，僅會以公開的論文識別碼查詢 CrossRef、PubMed (NCBI E-utilities)、Unpaywall、OpenAlex、Europe PMC 與 Semantic Scholar。
- **使用者自備之 Zotero / Gemini API（選用）**：若使用者於本機設定目錄（`~/Library/Application Support/OB-Zotero/`）自行設定 Zotero API Key 或 Gemini API Key，本地端將直接連線至官方 API，金鑰僅存於使用者本機（權限 `0600`）。
