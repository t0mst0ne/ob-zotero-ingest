# 隱私權政策 / Privacy Policy — OB–Zotero Academic Ingestion

**生效日期 / Effective date:** 2026-11-11

**公開頁面 / Public page:** https://t0mst0ne.github.io/ob-zotero-ingest/privacy/

**聯絡 / Contact:** https://github.com/t0mst0ne/ob-zotero-ingest/issues

**原始碼 / Source:** https://github.com/t0mst0ne/ob-zotero-ingest

本開源專案的開發者不營運會接收你資料的後端。「處理」是指擴充功能或選用的本機配套程式為了完成你要求的功能，讀取資料、存在你的電腦，或傳給第三方服務。

The developers of this open-source project do not operate a backend that receives your data. “Handle” means the extension, or its optional local companion, reads data, stores it on your computer, or sends it to a third-party service in order to do the thing you asked for.

---

## 繁體中文

### 1. 我們是誰，以及單一用途

OB–Zotero Academic Ingestion 是開源的 Chrome 擴充功能（Manifest V3）。單一用途是：在你主動操作時，從目前開啟的學術論文網頁或 PDF 擷取書目、章節、圖表與表格，整理成結構化 Markdown，並可選擇寫入你指定的本機資料夾（通常是 Obsidian Vault）。若你另外安裝並設定本機 Native Messaging Host（`com.ob.zotero.ingest`），該程式也可以把檔案寫進同一個 Vault，並在你提供本機金鑰時對齊你的 Zotero 書目庫。

Windows 沒有實作 Host 註冊。未安裝 Host 時，仍可使用瀏覽器直連 Vault 的模式。

### 2. 什麼時候會處理資料

只在你使用這個功能時處理資料，例如：

- 點工具列圖示以開啟側欄，或在側欄點「重新整理」或「一鍵入庫」
- 側欄保持開啟時，你切換到另一個分頁或導向該分頁的新網址（側欄會改讀你正在看的那個分頁）
- 選擇 Vault 資料夾、點「讀取剪貼簿內容」，或與你已安裝的本機 Host 連線

側欄關閉時，不會讀取其他分頁，也不會記錄瀏覽歷史。沒有廣告、分析或當機遙測，也不會把資料傳到開發者的伺服器。本擴充功能不向你索取姓名、電子郵件或帳號密碼。

### 3. 我們會處理哪些資料

- **目前分頁的網站內容。** 標題、作者、期刊、年份、DOI、PMID、PMCID、摘要、章節、正文、圖表說明、表格，以及該頁 PDF 或圖片的位元組。
- **你喚起擴充功能時的分頁網址，以及側欄開啟期間的作用中分頁網址。** 用來判斷是不是 PDF、從網址還原 DOI／PMID／PMCID，以及在你要求下載時抓取檔案。這些網址不會被存成一份瀏覽紀錄。
- **你自行撰寫或貼上的筆記。** 側欄裡的文字，或你點「讀取剪貼簿內容」之後讀到的文字或 HTML。剪貼簿只在那一次點擊時讀取。
- **你授權的本機資料夾。** 瀏覽器直連模式只在你透過 Chrome 檔案系統選擇器挑選的資料夾內讀寫。Host 則寫入安裝腳本收到的 Vault 路徑。

### 4. 資料存放位置

- 使用期間暫存在側欄的記憶體。
- 瀏覽器的 IndexedDB（資料庫 `ob_zotero_vault_db`）只保存你挑選的資料夾控制代碼，不保存論文內容，也不會上傳。
- 你儲存筆記、圖表或 PDF 時，寫入該 Vault（常見路徑為 `Research/<主題>/sources/`、`sources/etc/`、`sources/_assets/`、`notes/`）。
- 若安裝 Host，設定在本機目錄：macOS 為 `~/Library/Application Support/OB-Zotero/`；Linux 及其他非 macOS 系統為 `$XDG_CONFIG_HOME/ob-zotero`，未設定時為 `~/.config/ob-zotero/`。其中包含：
  - `config.json`（安裝器寫入，權限 `0600`）：Vault 路徑、Vault 名稱，以及你選擇性提供的 Zotero 資料目錄
  - `cache/metadata_cache.json`：已查過的書目快取
  - 你自行放置的 `zotero.json`（`user_id`、`api_key`）
  - Host 在你儲存 Gemini 金鑰時寫入的 `gemini.json`（權限 `0600`），或同一目錄的 `.env` / 環境變數 `GEMINI_API_KEY`、`GOOGLE_API_KEY`
- 若你設定了本機 Zotero 資料目錄，Host 會以唯讀方式讀取該目錄的 `zotero.sqlite`，並把 PDF 複製到該資料目錄的 `storage/`。這些檔案留在你的電腦。

### 5. 擴充功能本身會連線的服務

下列請求由打包在擴充功能內的 `sidepanel.js` 發出，使用 HTTPS，而且只針對你正在擷取的那一篇論文。

| 服務 | 端點 | 送出的資料 | 何時 |
| --- | --- | --- | --- |
| Crossref | `https://api.crossref.org/works/{doi}` | DOI | 頁面或 PDF 網址沒有足夠書目、需要用 DOI 補齊時 |
| NCBI PubMed E-utilities | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id={pmid}` | PMID | 需要用 PMID 補齊書目時 |
| NCBI PubMed E-utilities | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=1&term=...` | PMCID（`{pmcid}[pmcid]`）或 DOI（`"{doi}"[DOI]`） | 只有 PMCID 或 DOI、需要找出 PMID 時 |
| Unpaywall | `https://api.unpaywall.org/v2/{doi}?email=academic-ingest@ob-vault.local` | DOI，以及固定的占位信箱 `academic-ingest@ob-vault.local`（不是你的信箱；`.local` 不會寄到任何人） | 瀏覽器直連入庫、且要儲存 PDF 時 |
| 目前論文的出版社或 CDN | 作用中分頁網址、頁面上的 PDF 網址（含 JAMA 的 `https://jamanetwork.com/journals/{journal}/articlepdf/{doi}` 與 NEJM 的 `https://www.nejm.org/doi/pdf/{doi}?download=true`），以及圖檔網址 | 取得該 URL 的檔案。Unpaywall 回傳的開放取用 PDF 網址也會再抓一次，主機依該筆結果而定 | 檢測 PDF 分頁，或你勾選下載 PDF／圖表並入庫時 |

向出版社抓取 PDF 時，有些請求使用 `credentials: "include"`，讓瀏覽器在「該網站自己的請求」附上你既有的登入 Cookie，以便下載你本來就有權閱讀的檔案。這發生在：

- 於 PDF 分頁內抓取該分頁網址
- 擴充功能背景對該 PDF 網址再抓一次（`cache: "no-store"`）
- 入庫時在目前分頁內抓取 PDF 網址

側欄直接 `fetch` PDF 或圖檔時，沒有設定 `credentials: "include"`。跨來源的出版社請求因此不會由這支 `fetch` 附上 Cookie。若改走 `chrome.downloads.download`，則是 Chrome 下載管理員的一般下載，瀏覽器可能依該網址附上既有 Cookie。

本擴充功能不讀取 `document.cookie`，不使用 `chrome.cookies` API，也不把 Cookie、密碼或登入憑證傳給開發者，或傳給上表的書目 API。

### 6. 選用的本機 Host 另外會連線的服務

Host 只在你安裝它、而且擴充功能透過 Native Messaging（本機 stdio，不是開發者的伺服器）連上時才會執行。它會再呼叫上一節的 Crossref、PubMed 與 Unpaywall，並另外使用下列端點。

| 服務 | 端點 | 送出的資料 | 何時 |
| --- | --- | --- | --- |
| Crossref 書目檢索 | `https://api.crossref.org/works?query.bibliographic={text}&rows={1-10}` | PDF 檢測時，首頁或 OCR 文字最多 1000 字 | 僅 Host；PDF 沒有 DOI／PMID，且書目查詢還沒有標題時 |
| OpenAlex | `https://api.openalex.org/works/https://doi.org/{doi}` | DOI | 僅 Host；尋找開放取用 PDF 時 |
| Semantic Scholar | `https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}?fields=openAccessPdf` | DOI | 僅 Host；尋找開放取用 PDF 時 |
| Europe PMC | `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query={pmid 或 doi}&format=json` | PMID（`EXT_ID:{pmid} AND SRC:MED`）或 DOI | 僅 Host |
| Europe PMC PDF | `https://europepmc.org/backend/ptpmcrender.fcgi?accid={pmcid}&blobtype=pdf` | PMCID | 僅 Host；Europe PMC 有回傳 PMCID 時 |
| PubMed Central PDF | `https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/pdf/` | PMCID | 僅 Host；同上 |
| bioRxiv | `https://www.biorxiv.org/content/{doi}.full.pdf` | 以 `10.1101/` 開頭的 DOI | 僅 Host。程式沒有另向 `medrxiv.org` 或 `arxiv.org` 送請求；`10.1101` 的預印本一律向這個 bioRxiv 網址要求 PDF |
| 論文 PDF 與圖檔網址 | 頁面提供的 PDF 網址、上述 API 回傳的開放取用 PDF 網址，以及圖檔 `src` | 下載該檔。圖檔請求會帶文章網址作為 `Referer`；沒有文章網址時，`Referer` 使用固定值 `https://jamanetwork.com/`。同一 PDF 網址若第一次失敗，會用 `curl` 再試一次 | 僅 Host；你入庫並勾選 PDF 或圖表時 |
| 本機 Zotero | `http://localhost:23119/api/application` | 只確認本機 Zotero 是否在聽 | 僅 Host，而且你已設定 Zotero 資料目錄時。不會離開這台電腦 |
| Zotero Web API | `https://api.zotero.org/users/{user_id}/items` 及其子項目 | 你的 API 金鑰（`Zotero-API-Key` 標頭）。查詢時送出 DOI 或 `PMID:`。建立項目時送出標題、作者、摘要、期刊、年份、DOI、網址、PMID 與標籤。附件紀錄包含檔名、標題，或 Obsidian 連結 | 僅 Host，而且本機有 `zotero.json` 的 `user_id` 與 `api_key` 時。入庫畫面的「對齊 Zotero」預設為勾選。此程式把 PDF 複製到本機 Zotero storage，不把 PDF 位元組上傳到 `api.zotero.org` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}` | 若呼叫讀論文函式：標題、作者、期刊、年份、DOI、PMID、摘要、章節正文與表格，以及你的 API 金鑰（放在查詢字串） | 這支客戶端在 Host 套件內。目前接到擴充功能的 Host 動作只會把金鑰存進本機並回報遮罩後的狀態，不會呼叫 `generateContent`，因此現況不會把論文文字傳到 Google |

Host 送給 Crossref 的 `User-Agent` 是 `OB-Zotero/1.0`。PDF 下載使用類似瀏覽器的 `User-Agent`。兩者都不是你的個人資料。

金鑰只留在上述本機檔案或環境變數，不會傳給擴充功能的開發者。

### 7. 權限

- **sidePanel：** 在論文旁邊顯示側欄。
- **activeTab：** 你點工具列圖示時，暫時讀取那一個分頁。不要求 `tabs` 權限。
- **scripting：** 在你開啟側欄或重新整理時，把 `content_script.js` 注入該分頁。
- **optional host permissions（`https://*/*`、`http://*/*`）：** 安裝時不授予，也不會要求「所有網站」。只有在已知道目前這一個來源、而且需要較持久的授權時，才對該來源詢問（例如 `https://www.neurology.org/*`）。`http://` 是為了少數仍使用 HTTP 的出版社或本機頁面。
- **clipboardRead：** 僅在你點「讀取剪貼簿內容」時使用。
- **downloads：** 僅在你已開始 PDF 檢測或入庫，且分頁內直接抓取失敗時，交給 Chrome 下載管理員。
- **nativeMessaging：** 僅與你安裝的本機 Host `com.ob.zotero.ingest` 通訊。

商店版套件會拿掉開發用的 `key`，因此項目 ID 與本機未封裝 ID `nigcccipceneamlocmomenlncpedpkne` 不同。使用商店版又要安裝 Host 時，請執行 `./install.sh --vault <vault 路徑> --extension-id <商店項目 ID>`。

### 8. 分享、出售與保留

我們不出售你的資料。不用於廣告、信用評估、放貸，或與第 1 節單一用途無關的目的。開發者沒有伺服器可留存你的論文或筆記。你寫入 Vault 或本機設定目錄的檔案，留到你自己刪除為止。書目快取也在那個本機目錄。

Crossref、NCBI、Unpaywall、OpenAlex、Semantic Scholar、Europe PMC、出版社或 CDN、Zotero 與 Google 各有自己的隱私權政策與保留期限。我們無法控制那些服務在收到 DOI、論文文字或檔案請求之後怎麼保存紀錄。

### 9. 兒童

本產品供研究人員與學生整理學術文獻，並非以 13 歲以下兒童為對象，也不會故意收集其個人資料。

### 10. 變更

資料處理方式變更時，會更新本政策並修改文首生效日期。Chrome Web Store 上的隱私權政策網址應指向 https://t0mst0ne.github.io/ob-zotero-ingest/privacy/ 。

問題或請求請開 issue：https://github.com/t0mst0ne/ob-zotero-ingest/issues

---

## English

### 1. Who we are and the single purpose

OB–Zotero Academic Ingestion is an open-source Chrome extension (Manifest V3). Its single purpose is to extract bibliographic metadata, article sections, figures, and tables from the academic article or PDF you have open, format them as structured Markdown, and optionally save them to a local folder you choose (typically an Obsidian vault). If you also install and configure the local Native Messaging host (`com.ob.zotero.ingest`), that program can write into the same vault and, when you have stored your own keys on this computer, align the item with your Zotero library.

Host registration is not implemented on Windows. Browser-only vault mode works without the host.

### 2. When data is handled

Data is handled when you use the feature:

- You click the toolbar icon to open the side panel, or you click Refresh or Ingest in the panel.
- While the side panel stays open, you switch tabs or navigate the active tab. The panel then reads the tab you are looking at.
- You choose a vault folder, click “Read clipboard,” or connect to a local host you installed.

While the side panel is closed, the extension does not read other tabs and does not record a browsing history. There is no advertising, analytics, or crash telemetry, and nothing is sent to a server operated by the developers. The extension does not ask for your name, email, or account password.

### 3. Data we handle

- **Website content from the tab being extracted.** Title, authors, journal, year, DOI, PMID, PMCID, abstract, headings, body text, figure and table captions, and the bytes of a PDF or image on that page.
- **The URL of the tab you invoked the extension on, and the active-tab URL while the side panel is open.** Used to detect a PDF, recover a DOI, PMID, or PMCID from the address, and fetch a file when you ask for a download. These URLs are not stored as a browsing history.
- **Notes you write or paste.** Text in the side panel, or text/HTML read after you click “Read clipboard.” The clipboard is read only on that click.
- **Local folder contents you grant.** Browser-only mode reads and writes only inside the folder you pick with Chrome’s directory picker. The host writes under the vault path passed to the install script.

### 4. Where data is stored

- In memory in the side panel while you work.
- In IndexedDB (`ob_zotero_vault_db`), which stores only the directory handle you picked, not article contents, and does not upload it.
- In the vault folder when you save a note, figure, or PDF (typically `Research/<Topic>/sources/`, `sources/etc/`, `sources/_assets/`, and `notes/`).
- If you install the host, in its local config directory: `~/Library/Application Support/OB-Zotero/` on macOS, and `$XDG_CONFIG_HOME/ob-zotero` or `~/.config/ob-zotero/` on Linux and other non-macOS systems. That directory holds:
  - `config.json` (written by the installer, mode `0600`): vault path, vault name, and an optional Zotero data directory
  - `cache/metadata_cache.json`: bibliographic responses already fetched
  - `zotero.json` if you create it (`user_id`, `api_key`)
  - `gemini.json` (mode `0600`) if you save a Gemini key through the host, or a `.env` / the environment variables `GEMINI_API_KEY` and `GOOGLE_API_KEY` in that runtime directory
- If you configured a local Zotero data directory, the host reads `zotero.sqlite` there in read-only mode and may copy a PDF into that directory’s `storage/` folder. Those files stay on your computer.

### 5. Services the extension itself contacts

These requests are made by `sidepanel.js` inside the extension, over HTTPS, and only for the article you are extracting.

| Service | Endpoint | Data sent | When |
| --- | --- | --- | --- |
| Crossref | `https://api.crossref.org/works/{doi}` | DOI | The page or PDF URL does not already supply enough bibliographic fields |
| NCBI PubMed E-utilities | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id={pmid}` | PMID | A PMID is needed to fill in bibliographic fields |
| NCBI PubMed E-utilities | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=1&term=...` | A PMCID (`{pmcid}[pmcid]`) or a DOI (`"{doi}"[DOI]`) | Only a PMCID or DOI is known and a PMID is needed |
| Unpaywall | `https://api.unpaywall.org/v2/{doi}?email=academic-ingest@ob-vault.local` | DOI and the fixed placeholder address `academic-ingest@ob-vault.local` (not your email; `.local` is not a deliverable mailbox) | Browser-vault ingest while a PDF is being saved |
| Publisher or CDN of the current article | The active tab URL, the article PDF URL (including JAMA `https://jamanetwork.com/journals/{journal}/articlepdf/{doi}` and NEJM `https://www.nejm.org/doi/pdf/{doi}?download=true`), and figure URLs | The file at that URL. An open-access PDF URL returned by Unpaywall is fetched next; that host depends on the result | Inspecting a PDF tab, or ingesting with PDF or figure download selected |

Some PDF fetches send `credentials: "include"`, so the browser attaches the cookies it already has for that publisher to the publisher’s own request. That lets you download a PDF you are already allowed to view. This applies to:

- the in-page fetch of a PDF tab’s URL
- a second fetch of that PDF URL from the extension (`cache: "no-store"`)
- the in-tab fetch of the PDF URL during ingest

Direct `fetch` of a PDF or figure from the side panel does not set `credentials: "include"`, so that call does not attach cookies to a cross-origin publisher request. If the extension falls back to `chrome.downloads.download`, Chrome’s download manager performs a normal download and may send the cookies the browser already has for that URL.

The extension does not read `document.cookie`, does not use the `chrome.cookies` API, and does not send cookies, passwords, or login credentials to the developers or to the bibliographic APIs in the table above.

### 6. Additional services the optional local host contacts

The host runs only after you install it and the extension connects over Native Messaging (local stdio, not a developer server). It calls Crossref, PubMed, and Unpaywall as listed above, and it also uses the endpoints below.

| Service | Endpoint | Data sent | When |
| --- | --- | --- | --- |
| Crossref bibliographic search | `https://api.crossref.org/works?query.bibliographic={text}&rows={1-10}` | Up to 1000 characters of first-page or OCR text from a PDF inspection | Host only, when the PDF has no DOI or PMID and the identifier lookup has not returned a title |
| OpenAlex | `https://api.openalex.org/works/https://doi.org/{doi}` | DOI | Host only, while locating an open-access PDF |
| Semantic Scholar | `https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}?fields=openAccessPdf` | DOI | Host only, while locating an open-access PDF |
| Europe PMC | `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query={pmid or doi}&format=json` | PMID (`EXT_ID:{pmid} AND SRC:MED`) or DOI | Host only |
| Europe PMC PDF | `https://europepmc.org/backend/ptpmcrender.fcgi?accid={pmcid}&blobtype=pdf` | PMCID | Host only, when Europe PMC returns a PMCID |
| PubMed Central PDF | `https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/pdf/` | PMCID | Host only, in that same case |
| bioRxiv | `https://www.biorxiv.org/content/{doi}.full.pdf` | A DOI that starts with `10.1101/` | Host only. The code does not call `medrxiv.org` or `arxiv.org`. A `10.1101` preprint is requested from this bioRxiv URL |
| Article PDF and figure URLs | The page’s PDF URL, open-access PDF URLs returned by the APIs above, and figure `src` URLs | The file. Figure requests send the article URL as `Referer`. If the article URL is missing, the `Referer` is the fixed value `https://jamanetwork.com/`. A failed PDF download is retried with `curl` against the same URL | Host only, when you ingest with PDF or figure download selected |
| Local Zotero | `http://localhost:23119/api/application` | A liveness check only | Host only, and only if you configured a Zotero data directory. The request does not leave the computer |
| Zotero Web API | `https://api.zotero.org/users/{user_id}/items` and child-item URLs | Your API key (`Zotero-API-Key`). Searches send a DOI or `PMID:`. Creating an item sends title, authors, abstract, journal, year, DOI, URL, PMID, and tags. Attachment records include a filename, title, or Obsidian link | Host only, and only if local `zotero.json` contains `user_id` and `api_key`. The ingest checkbox “align with Zotero” is on by default. This code copies the PDF into local Zotero storage and does not upload PDF bytes to `api.zotero.org` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}` | If the reading-note function is called: title, authors, journal, year, DOI, PMID, abstract, section text, tables, and your API key in the query string | The client ships in the host package. The host actions connected to the extension save a key locally and return a masked status. They do not call `generateContent`, so article text is not sent to Google by those actions |

Crossref requests from the host use the `User-Agent` `OB-Zotero/1.0`. PDF downloads use a browser-like `User-Agent`. Neither value is your personal information.

API keys remain in the local files or environment variables above. They are not sent to the extension’s developers.

### 7. Permissions

- **sidePanel:** shows the side panel next to the article.
- **activeTab:** temporary access to the tab whose toolbar icon you clicked. The `tabs` permission is not requested.
- **scripting:** injects `content_script.js` when you open the side panel or refresh.
- **optional host permissions (`https://*/*`, `http://*/*`):** not granted at install, and the extension does not ask for all websites. Only when the current origin is already known, and a lasting grant is needed, does Refresh ask for that one origin (for example `https://www.neurology.org/*`). `http://` covers uncommon publisher or local pages still served over HTTP.
- **clipboardRead:** used only when you click “Read clipboard.”
- **downloads:** used only after you start PDF inspection or ingest and an in-tab fetch fails, so Chrome’s download manager can retrieve the PDF.
- **nativeMessaging:** talks only to the local host `com.ob.zotero.ingest` that you installed.

The store package removes the development `key`, so the store item ID differs from the unpacked ID `nigcccipceneamlocmomenlncpedpkne`. After installing from the store, register the host with `./install.sh --vault <vault path> --extension-id <store item id>`.

### 8. Sharing, sale, and retention

We do not sell your data. We do not use it for advertising, creditworthiness, lending, or any purpose unrelated to the single purpose in section 1. The developers have no server that retains your papers or notes. Files you save in the vault or the local config directory remain until you delete them. The bibliographic cache is in that same local directory.

Crossref, NCBI, Unpaywall, OpenAlex, Semantic Scholar, Europe PMC, the publisher or CDN, Zotero, and Google have their own privacy policies and retention practices. We do not control what those services store after they receive an identifier, article text, or file request.

### 9. Children

This product is intended for researchers and students managing academic literature. It is not directed at children under 13, and it does not knowingly collect their personal information.

### 10. Changes

When data practices change, this policy is updated and the effective date at the top is revised. The Chrome Web Store privacy-policy field should point to https://t0mst0ne.github.io/ob-zotero-ingest/privacy/ .

Questions or requests: https://github.com/t0mst0ne/ob-zotero-ingest/issues
