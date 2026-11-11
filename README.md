# OB–Zotero Academic Ingestion

獨立的 Chrome 擴充功能＋Python Native Messaging Host。從學術網頁擷取書目與全文，將使用者選擇的內容寫入 Obsidian Vault，並可選擇整合 Zotero。

本專案從 OB 的 `chrome-extension/`、`scripts/native_host/`、`scripts/ingestion/` 抽出；不包含原 Vault 的筆記、設定、API Key、Zotero 資料庫或快取。原 OB 專案不需要搬走，也不需要作為安裝依賴。

## 安裝（macOS）

需要 Python 3.10 以上（目前以 3.12 驗證）、Google Chrome。已安裝 uv 時，安裝器會自動建立 Python 3.12 環境；也可用 `PYTHON=/完整路徑/python3.12` 指定 Python。第一次安裝需要網路下載 Python／鎖定的套件。執行 JavaScript 測試另需 Node.js。

先在 Chrome 的 `chrome://extensions` 開啟「開發人員模式」，選「載入未封裝項目」，指定本專案的 `chrome-extension` 目錄。

```sh
cd ~/GITHUB/ob-zotero-ingest
mkdir -p "$HOME/GITHUB/OB-Zotero-Demo-Vault"
./install.sh --vault "$HOME/GITHUB/OB-Zotero-Demo-Vault"
```

`--vault` 必須是已存在的目錄。開啟空白目錄作為 Obsidian Vault 後，名稱預設使用該目錄名稱；可用 `--vault-name` 指定已登記的不同名稱。

安裝器會建立本專案專用的 `.venv`，安裝 `requirements.txt`，再註冊 Chrome Native Host。pip 安裝路徑使用其內建 CA bundle，避免空白 macOS HOME 的鑰匙圈存放區錯誤；HTTPS 憑證驗證仍保持啟用。Chrome 透過完整 Python 路徑啟動，不依賴 Anaconda、shell 啟動設定或啟用虛擬環境。

如果 Chrome 已經註冊原 OB 的 Native Host，安裝器會停止，避免覆蓋。確定要切換到此專案時才加上 `--replace-host`；要保留原設定，使用下方隔離測試即可。

載入擴充功能後，開啟側欄，確認「本地庫已連線」。`manifest.json` 的公鑰讓開發版 ID 固定為 `nigcccipceneamlocmomenlncpedpkne`。商店 zip 會拿掉這把公鑰，所以上架後的項目 ID 不同。改用商店版本時，請用商店項目 ID 重新註冊 Host：`./install.sh --vault <vault 路徑> --extension-id <商店項目 ID>`。不要刪除或搬動已註冊的專案／`.venv`；搬動後需重新執行安裝。

## 空白環境測試

測試只建立暫存 HOME、空白測試 Vault、設定及 Native Host 註冊檔；不註冊到日常 Chrome，也不讀取個人的 Zotero 或 Gemini 設定。

```sh
.venv/bin/python -I -m unittest discover -s tests -v
node --test chrome-extension/tests/*.test.js
```

也可從已提交的 Git 版本建立另一個全新 clone，使用空白 HOME、新 `.venv` 和 pip 重新下載套件後測試（不依賴 uv 或目前環境的 site-packages）：

```sh
.venv/bin/python -I scripts/verify_clean_clone.py
```

加上 `--keep` 可保留暫存 clone 和安裝 log。完整驗證結果與限制見 [VALIDATION.md](VALIDATION.md)。

測試包含：從 Chrome 類似的最小 PATH 啟動 Host、Native Messaging 協定往返、空白庫狀態、寫入合成的全文與閱讀筆記、保留 frontmatter、PDF 分塊傳送、暫存 PDF、中文／空格／引號路徑、避免覆蓋其他 Host，以及阻擋目錄跳脫。

若要測試安裝器本身，且不變更目前 Chrome 註冊：

```sh
TEST_DIR=$(mktemp -d)
mkdir -p "$TEST_DIR/Empty Vault"
./install.sh --vault "$TEST_DIR/Empty Vault" \
  --config-dir "$TEST_DIR/settings" \
  --hosts-dir "$TEST_DIR/NativeMessagingHosts"
```

此範例的註冊目錄沒有接到日常 Chrome，因此只用於安裝／協定測試；不會使日常 Chrome 自動連到測試 Host。

## 設定與資料位置

macOS 設定、狀態和快取預設位於 `~/Library/Application Support/OB-Zotero/`。主設定是 `config.json`，包含 `vault_path`、`vault_name`、可選的 `zotero_dir`。CLI 支援 `--config-dir` 和 `--hosts-dir` 作為隔離測試用途。

輸出保留原結構：`Research/<主題>/sources/`、`sources/etc/`（PDF）、`sources/_assets/`（圖表）、`notes/`。只有使用者選擇寫入內容時才產生檔案。

Zotero 預設不讀取任何本地資料庫。需要整合時，明確傳入 `--zotero-dir /路徑/Zotero`；建立 Zotero 書目及附件仍需要使用者自己的 Web API 設定（`zotero.json`，欄位為 `user_id`、`api_key`，存於設定目錄，勿提交 Git）。沒有設定時可使用 Obsidian 入庫；Zotero 寫入與實際期刊下載需要另做有帳號的整合測試。

Gemini 為選用功能；沒有憑證也能啟動。設定位置是專案的執行期目錄中的 `gemini.json`，不再搜尋原 OB 或使用者私人的 skill。掃描 PDF 的 OCR 使用 macOS Swift Vision，需系統能執行 `swift`；此次 clean install 測試不涵蓋 OCR。

## 打包與 Chrome Web Store 送審準備

```sh
.venv/bin/python -I scripts/package_extension.py
```

輸出 `dist/ob-zotero-1.0.0.zip`。ZIP 僅包含瀏覽器端必要檔案，不包含本地 Host、測試、憑證或 `.venv`，且自動移除開發用 `"key"` 欄位以符合 Chrome Web Store 新上架規範（本地 `chrome-extension/manifest.json` 仍保留 `"key"` 供開發模式固定 ID 使用；若需保留可加 `--keep-key`）。

- **最小權限與無 Cookie 外傳**：移除 `cookies` 權限與 `document.cookie` 擷取，將安裝期 `<all_urls>` 改為 `activeTab` 搭配按需請求之 `optional_host_permissions`。
- **免安裝 Python 瀏覽器直連模式（File System Access API）**：未安裝本地 Python Host 時，可直接點選側欄的「📂 選擇 Vault 資料夾」，授權本地 Obsidian Vault 目錄後，即可在瀏覽器內直接執行「🚀 一鍵入庫至本地庫」（寫入 `Research/<主題>/sources/`、下載高解析度圖表至 `_assets/`、下載原廠或 Open Access PDF 至 `sources/etc/`）與「💾 寫入 Obsidian 筆記」（支援自動保留 YAML frontmatter），亦可一鍵「📋 複製結構化全文 Markdown」。
- **隱私權政策與送審指南**：隱私權政策公開於 https://t0mst0ne.github.io/ob-zotero-ingest/privacy/ （與 [PRIVACY.md](PRIVACY.md) 相同；GitHub Pages 需在 Settings → Pages 選擇 Deploy from a branch：`main` / `docs` 後才會上線）。Chrome Web Store 欄位、權限理由與資料揭露見 [CHROME_WEB_STORE.md](CHROME_WEB_STORE.md)。
