# 安裝驗證紀錄

日期：2026-11-11。專案：OB–Zotero standalone。

來源：本機 OB（commit `c6e46e267e8b43a58c7f815da097cb3884ea67ca`）中的擴充功能與必要 Python 原始碼，另建立獨立 Git 專案。沒有搬移、修改原 Vault，也沒有複製憑證、個人資料或快取。

## 已通過

- macOS ARM64、Python 3.12.14；新的虛擬環境，沒有繼承 system site-packages。
- 從獨立專案建立另一份 Git clone，目錄名稱包含空格。
- 在空白 HOME、`PATH=/usr/bin:/bin`（找不到 uv）、沒有 API Key 的環境執行 `install.sh`，透過 pip 下載並安裝 17 個鎖定套件。
- uv 安裝路徑及依賴一致性檢查亦通過。
- 11 項 Python 整合測試通過：已安裝 launcher 的 Native Messaging 協定往返、空白庫狀態、合成來源與筆記寫入／frontmatter 保留、Markdown 不等號與 PDF 斷行修復、HTML 行內格式與表格保留、YAML 引號跳脫與複雜 DOI 檔名對齊、預印本離線比對與 Zotero 本地回連識別、CrossRef/PubMed 書目合併快取、PDF 分塊及 inspection cache、既有 Host 覆蓋保護、ID 驗證、路徑跳脫保護與 Chrome Web Store 打包驗證。
- 6 項 JavaScript 測試通過（含 JAMA 圖表擷取、包裹表格去重、無 Cookie 洩漏、付費牆攔截、PDF 檢視器 PMID 對齊與自訂 Vault URI／純瀏覽器 Markdown 產生）。
- ZIP 可建立，`manifest.json` 在根目錄，只含 9 個瀏覽器必要檔案，且已移除開發用 `"key"`、`cookies` 權限與安裝期 `<all_urls>` 權限。

以上以本機模擬乾淨使用者環境，並非重新安裝 macOS 或另一台實體電腦。

## 發現並修正

- 原始碼沒有獨立安裝依賴清單。
- Native Host 使用固定的 Anaconda Python、Zotero 個人路徑及 `OB` Vault 名稱。
- Python 3.12 啟動時 `identifier.py` 缺少 `List` 匯入。
- 執行期設定、日誌和狀態原本與原始碼／Vault 混放，現改為獨立設定目錄。
- 空白 macOS HOME 的 pip system truststore 發生 `OSStatus -26276`；改用 pip 的 bundled CA，沒有關閉 HTTPS 驗證。依據：[pip 官方憑證文件](https://pip.pypa.io/en/stable/topics/https-certificates/)。
- 移除未使用的 Chrome `storage` 與 `cookies` 權限，將 `<all_urls>` 改為 `optional_host_permissions`，加入最低 Chrome 版本與免本地端「複製結構化全文 Markdown」功能，並補齊 [PRIVACY.md](PRIVACY.md)、[CHROME_WEB_STORE.md](CHROME_WEB_STORE.md) 與 [bug_check_by_gemini.md](bug_check_by_gemini.md) 全部 11 項程式碼修正。

## 尚未驗證

- Chrome 真正啟動 Native Host 的完整瀏覽器整合。已嘗試獨立設定檔和本機快取的 Chrome for Testing；瀏覽器在提供 CDP 連線前即異常結束（exit 134），macOS Launch Services 另回報 `kLSNoExecutableErr`。browser-harness 因此未連線，沒有將此項視為成功。
- 實際 Zotero 帳號建立書目／附件、訂閱期刊下載、Swift Vision OCR。
- Windows 安裝；Linux 實機安裝。
- Chrome Web Store 審查。隱私政策、Cookie／網站權限範圍、商店素材及審查操作說明仍需完成。

所有測試註冊檔都寫入暫存目錄；沒有覆蓋日常 Chrome 的原 OB Host。
