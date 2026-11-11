/**
 * OB-Zotero Academic Ingestion - Side Panel Controller
 * Handles UI interactions, content extraction from active tab,
 * and IPC communication with the Python Native Messaging Host.
 */

const NATIVE_HOST_NAME = "com.ob.zotero.ingest";

// State
let nativePort = null;
let isNativeHostOnline = false;
let vaultDirHandle = null;
let currentArticleData = null;
let isIngesting = false;
let currentVaultName = "OB";

// DOM Elements
const hostBadge = document.getElementById("host-badge");
const btnPickVault = document.getElementById("btn-pick-vault");
const btnDetect = document.getElementById("btn-detect");
const btnIngest = document.getElementById("btn-ingest");
const btnCopyMd = document.getElementById("btn-copy-md");

const articleEmpty = document.getElementById("article-empty");
const articleContent = document.getElementById("article-content");
const artTitle = document.getElementById("art-title");
const artMeta = document.getElementById("art-meta");
const artDoi = document.getElementById("art-doi");
const artPmid = document.getElementById("art-pmid");

const statusNote = document.getElementById("status-note");
const statusSource = document.getElementById("status-source");
const statusPdf = document.getElementById("status-pdf");
const statusZotero = document.getElementById("status-zotero");

const topicSelect = document.getElementById("topic-select");
const optSource = document.getElementById("opt-source");
const optPdf = document.getElementById("opt-pdf");
const optFigures = document.getElementById("opt-figures");
const optZotero = document.getElementById("opt-zotero");

const resultCard = document.getElementById("result-card");
const progressSpinner = document.getElementById("progress-spinner");
const progressText = document.getElementById("progress-text");
const resultSuccess = document.getElementById("result-success");
const resultError = document.getElementById("result-error");
const errorText = document.getElementById("error-text");
const linkObNote = document.getElementById("link-ob-note");
const linkObPdf = document.getElementById("link-ob-pdf");
const linkZotero = document.getElementById("link-zotero");

// Import Card Elements
const optAutoHtml = document.getElementById("opt-auto-html");
const optAutoPdf = document.getElementById("opt-auto-pdf");
const pasteContent = document.getElementById("paste-content");
const btnPasteClip = document.getElementById("btn-paste-clip");
const btnSaveNote = document.getElementById("btn-save-note");
const pasteResult = document.getElementById("paste-result");
const pasteResultIcon = document.getElementById("paste-result-icon");
const pasteResultMsg = document.getElementById("paste-result-msg");
const linkPasteOb = document.getElementById("link-paste-ob");


// ── Browser File System Access API (Zero-Python Local Vault Mode) ───────────

const VAULT_IDB_NAME = "ob_zotero_vault_db";
const VAULT_IDB_STORE = "handles";
const VAULT_IDB_KEY = "vault_dir";

function openVaultIdb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const req = indexedDB.open(VAULT_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VAULT_IDB_STORE)) {
        db.createObjectStore(VAULT_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveVaultHandleToIdb(handle) {
  try {
    const db = await openVaultIdb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(VAULT_IDB_STORE, "readwrite");
      tx.objectStore(VAULT_IDB_STORE).put(handle, VAULT_IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("Could not persist vault handle to IndexedDB:", e);
  }
}

async function loadVaultHandleFromIdb() {
  try {
    const db = await openVaultIdb();
    if (!db) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction(VAULT_IDB_STORE, "readonly");
      const req = tx.objectStore(VAULT_IDB_STORE).get(VAULT_IDB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function ensureVaultPermission(handle, mode = "readwrite", promptUser = true) {
  if (!handle) return false;
  try {
    if (typeof handle.queryPermission === "function") {
      const state = await handle.queryPermission({ mode });
      if (state === "granted") return true;
    }
    if (promptUser && typeof handle.requestPermission === "function") {
      const state = await handle.requestPermission({ mode });
      return state === "granted";
    }
    return typeof handle.queryPermission !== "function";
  } catch (e) {
    return false;
  }
}

function updateBrowserVaultBadge() {
  if (isNativeHostOnline) return;
  if (vaultDirHandle) {
    currentVaultName = vaultDirHandle.name || currentVaultName;
    hostBadge.textContent = `● 瀏覽器直連 (${currentVaultName})`;
    hostBadge.className = "badge badge-connected cursor-pointer";
    if (btnPickVault) btnPickVault.textContent = `📂 ${currentVaultName} (更換)`;
  } else {
    hostBadge.textContent = "○ 點此選擇 Vault 或連線";
    hostBadge.className = "badge badge-disconnected cursor-pointer";
    if (btnPickVault) btnPickVault.textContent = "📂 選擇 Vault 資料夾";
  }
}

async function pickVaultDirectory() {
  if (typeof window === "undefined" || typeof window.showDirectoryPicker !== "function") {
    showError("目前瀏覽器環境不支援 File System Access API (showDirectoryPicker)。");
    return null;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    if (handle) {
      vaultDirHandle = handle;
      currentVaultName = handle.name || "OB";
      await saveVaultHandleToIdb(handle);
      updateBrowserVaultBadge();
      if (currentArticleData && currentArticleData.metadata && !isNativeHostOnline) {
        await checkBrowserVaultStatus(currentArticleData.metadata, topicSelect ? topicSelect.value : "Neurology");
      }
    }
    return handle;
  } catch (e) {
    if (e && e.name !== "AbortError") {
      console.warn("Directory picker error:", e);
    }
    return null;
  }
}

async function getSubDirHandle(rootHandle, pathParts, create = false) {
  let curr = rootHandle;
  for (const part of pathParts) {
    if (!part) continue;
    try {
      curr = await curr.getDirectoryHandle(part, { create });
    } catch (e) {
      return null;
    }
  }
  return curr;
}

async function readFileTextFromDir(dirHandle, filename) {
  if (!dirHandle || !filename) return null;
  try {
    const fh = await dirHandle.getFileHandle(filename, { create: false });
    const file = await fh.getFile();
    return await file.text();
  } catch (e) {
    return null;
  }
}

async function writeFileToDir(dirHandle, filename, content) {
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fh.createWritable();
  await writable.write(content);
  await writable.close();
}

async function listDirNames(dirHandle) {
  if (!dirHandle || typeof dirHandle.entries !== "function") return [];
  const names = [];
  try {
    for await (const [name] of dirHandle.entries()) {
      names.push(name);
    }
  } catch (e) {}
  return names;
}

async function checkBrowserVaultStatus(meta, topic) {
  if (!vaultDirHandle || !meta) return;
  const granted = await ensureVaultPermission(vaultDirHandle, "read", false);
  if (!granted) return;

  const targetTopic = topic || "Neurology";
  const stem = computeStem(meta);
  const pmid = meta.pmid ? String(meta.pmid).trim() : null;
  const safeDoi = meta.doi ? String(meta.doi).trim().toLowerCase().replace(/[^\w.\-]+/g, "_") : null;

  const notesDir = await getSubDirHandle(vaultDirHandle, ["Research", targetTopic, "notes"], false);
  const sourcesDir = await getSubDirHandle(vaultDirHandle, ["Research", targetTopic, "sources"], false);
  const pdfsDir = await getSubDirHandle(vaultDirHandle, ["Research", targetTopic, "sources", "etc"], false);

  let notePath = null;
  let sourcePath = null;
  let pdfPath = null;

  const matchesPaper = (name, ext) => {
    if (!name.endsWith(ext)) return false;
    if (name === `${stem}${ext}` || name === `${stem}-notes${ext}`) return true;
    if (pmid && name.includes(pmid)) return true;
    if (safeDoi && name.toLowerCase().includes(safeDoi)) return true;
    return false;
  };

  if (notesDir) {
    const names = await listDirNames(notesDir);
    const found = names.find((n) => !n.endsWith("-中文翻譯.md") && matchesPaper(n, ".md"));
    if (found) notePath = `Research/${targetTopic}/notes/${found}`;
  }
  if (sourcesDir) {
    const names = await listDirNames(sourcesDir);
    const found = names.find((n) => matchesPaper(n, ".md"));
    if (found) sourcePath = `Research/${targetTopic}/sources/${found}`;
  }
  if (pdfsDir) {
    const names = await listDirNames(pdfsDir);
    const found = names.find((n) => matchesPaper(n, ".pdf"));
    if (found) pdfPath = `Research/${targetTopic}/sources/etc/${found}`;
  }

  updateStatusMatrix({
    obsidian: {
      has_note: Boolean(notePath),
      note_path: notePath,
      has_source: Boolean(sourcePath),
      source_path: sourcePath,
    },
    pdf: {
      has_pdf: Boolean(pdfPath),
      pdf_path: pdfPath,
    },
    zotero: {
      has_item: false,
      key: null,
    },
  });
}


// ── Native Messaging Communication ──────────────────────────────────────────

function connectToNativeHost() {
  try {
    if (nativePort) {
      try { nativePort.disconnect(); } catch (e) {}
    }
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener((msg) => {
      console.log("Native host message received:", msg);
      handleNativeResponse(msg);
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : "Disconnected";
      const wasOnline = isNativeHostOnline;
      isNativeHostOnline = false;
      nativePort = null;
      updateBrowserVaultBadge();
      // Browser-only File System Access mode is expected to run with no host
      // installed. connectNative then disconnects immediately ("Specified native
      // messaging host not found."). That is not a session failure — stay quiet
      // and let the panel fall back to the vault-folder badge. Warn only if a
      // host that had already answered ping drops mid-session.
      if (wasOnline) {
        console.warn("Native host disconnected:", err);
      }
      if (isIngesting && !vaultDirHandle) {
        showError("本地入庫進程通訊已結束。");
      }
    });

    // Send ping to verify connection
    nativePort.postMessage({ action: "ping", payload: {} });
  } catch (err) {
    console.error("Failed to connect to native host:", err);
    isNativeHostOnline = false;
    updateBrowserVaultBadge();
  }
}

function sendNativeMessage(action, payload) {
  if (!nativePort && !(action === "check_status" && !isNativeHostOnline && vaultDirHandle)) {
    connectToNativeHost();
  }
  if (nativePort) {
    try {
      nativePort.postMessage({ action, payload });
    } catch (e) {
      connectToNativeHost();
      setTimeout(() => {
        if (nativePort) nativePort.postMessage({ action, payload });
      }, 150);
    }
  } else if (action === "check_status" && vaultDirHandle && currentArticleData) {
    checkBrowserVaultStatus(currentArticleData.metadata, payload.topic);
  } else if (action !== "check_status" && action !== "ping") {
    showError("無法連線至本地 Native Messaging Host，請點選「📂 選擇 Vault 資料夾」直接寫入，或依 README 執行 ./install.sh。");
  }
}

function handleNativeResponse(msg) {
  if (msg.transfer_id && msg.completed !== undefined) {
    if (msg.status === "error") console.warn("PDF upload rejected:", msg.message);
    return;
  }
  if (msg.pdf_inspection) {
    if (msg.status !== "ok") {
      showEmpty(msg.message || "無法辨識 PDF 書目資料。");
      return;
    }
    currentArticleData = {
      metadata: msg.metadata, sections: msg.sections || [], figures: [], tables: [],
      downloaded_file_path: msg.downloaded_file_path,
    };
    optSource.checked = true;
    renderArticle(currentArticleData);
    sendNativeMessage("check_status", {
      doi: msg.metadata.doi, pmid: msg.metadata.pmid,
      title: msg.metadata.title, url: msg.metadata.url,
      topic: topicSelect.value,
    });
    return;
  }
  if (msg.status === "ok" && msg.version) {
    // Ping response
    isNativeHostOnline = true;
    if (msg.vault_name) currentVaultName = msg.vault_name;
    hostBadge.textContent = `● 本地庫已連線 (Zotero: ${msg.zotero_indexed_dois} 篇)`;
    hostBadge.className = "badge badge-connected";
  } else if (msg.status === "ok" && msg.obsidian && msg.zotero) {
    // Check status response
    if (currentArticleData && currentArticleData.metadata && msg.pmid) {
      const currentDoi = (currentArticleData.metadata.doi || "").toLowerCase();
      if (!currentDoi || !msg.doi || msg.doi.toLowerCase() === currentDoi || currentDoi.includes(msg.doi.toLowerCase())) {
        currentArticleData.metadata.pmid = msg.pmid;
        artPmid.textContent = `PMID: ${msg.pmid}`;
      }
    }
    updateStatusMatrix(msg);
  } else if (msg.status === "success" && msg.target_type) {
    // Reading note or translation save response
    handleSaveNoteResponse(msg);
  } else if (msg.status === "success") {
    // Ingestion response
    handleIngestionSuccess(msg);
  } else if (msg.status === "error") {
    showError(msg.message || "處理過程發生錯誤。");
  }
}


// ── Active Tab Extraction ───────────────────────────────────────────────────

async function requestTabOriginPermission(url) {
  if (!url || !chrome.permissions || !chrome.permissions.request) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return await chrome.permissions.request({ origins: [`${parsed.origin}/*`] });
  } catch (e) {
    return false;
  }
}

// Chrome omits tab.url / tab.title / tab.pendingUrl unless this extension has
// activeTab for that tab, a host permission for the origin, or the "tabs"
// permission. "tabs" is intentionally not requested: it would expose every
// tab URL ("Read your browsing history") at install time. The toolbar click
// grants activeTab; the「重新整理」button can ask for the optional host
// permissions already declared in the manifest.
const TAB_URL_UNAVAILABLE_HINT =
  "無法讀取此分頁的網址，因此無法檢測文獻。請點「🔄 重新整理」並允許存取此網站；若這是瀏覽器內部頁面，請改開一般網頁。";

function readTabUrl(tab) {
  if (!tab) return "";
  if (typeof tab.url === "string" && tab.url) return tab.url;
  if (typeof tab.pendingUrl === "string" && tab.pendingUrl) return tab.pendingUrl;
  return "";
}

function isInternalBrowserUrl(url) {
  return url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("chrome-untrusted://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://");
}

async function requestOptionalWebAccess() {
  if (!chrome.permissions || typeof chrome.permissions.request !== "function") return false;
  try {
    return Boolean(await chrome.permissions.request({
      origins: ["https://*/*", "http://*/*"],
    }));
  } catch (e) {
    return false;
  }
}

async function resolveActiveTab(fromUserGesture) {
  const queried = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = queried && queried[0];
  if (!tab || !tab.id) return { tab: null, url: "" };

  let url = readTabUrl(tab);
  // A side-panel button click is a user gesture for permissions.request, but
  // it does not grant activeTab. Without a URL we cannot name this origin, so
  // ask for the optional http(s) host permissions; after they are granted,
  // tabs.query includes url for ordinary web pages.
  if (!url && fromUserGesture) {
    const granted = await requestOptionalWebAccess();
    if (granted) {
      const retried = await chrome.tabs.query({ active: true, currentWindow: true });
      if (retried && retried[0] && retried[0].id) tab = retried[0];
      url = readTabUrl(tab);
    }
  }
  if (url && tab.url !== url) {
    tab = Object.assign({}, tab, { url: url });
  }
  return { tab: tab, url: url };
}

async function detectActiveTab(fromUserGesture = false) {
  if (!nativePort) {
    connectToNativeHost();
  }
  btnDetect.textContent = "⏳ 檢測中...";
  btnDetect.disabled = true;

  try {
    const resolved = await resolveActiveTab(fromUserGesture);
    const tab = resolved.tab;
    const url = resolved.url;
    if (!tab || !tab.id) {
      showEmpty("找不到目前啟用的瀏覽器分頁。");
      return;
    }

    if (!url) {
      showEmpty(TAB_URL_UNAVAILABLE_HINT);
      return;
    }

    if (isInternalBrowserUrl(url)) {
      showEmpty("無法在瀏覽器系統頁面上擷取文獻。");
      return;
    }

    // Chrome's built-in PDF viewer does not expose publisher citation meta tags.
    if (isPdfTabUrl(url)) {
      await inspectPdfTab(tab);
      return;
    }

    // Execute content script in active tab (request origin permission on user gesture if needed)
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content_script.js"],
      });
    } catch (scriptErr) {
      if (fromUserGesture && await requestTabOriginPermission(url)) {
        results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content_script.js"],
        });
      } else {
        showEmpty(TAB_URL_UNAVAILABLE_HINT);
        return;
      }
    }

    if (results && results[0] && results[0].result) {
      const data = results[0].result;
      currentArticleData = data;
      renderArticle(data);

      // Query native host for vault status
      sendNativeMessage("check_status", {
        doi: data.metadata.doi,
        pmid: data.metadata.pmid,
        title: data.metadata.title,
        url: data.metadata.url,
        topic: topicSelect ? topicSelect.value : "Neurology",
      });
    } else {
      showEmpty("未能從當前網頁中解析出學術論文資訊。");
    }
  } catch (err) {
    console.error("Detection error:", err);
    showEmpty(`檢測出錯: ${err.message}`);
  } finally {
    btnDetect.textContent = "🔄 重新整理";
    btnDetect.disabled = false;
  }
}

function isPdfTabUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith(".pdf") || path.includes("/articlepdf/") ||
      path.includes("/doi/pdf/") || path.includes("/pdf/");
  } catch (_) { return false; }
}

function queueInspectionPdf(base64, url) {
  const chunkSize = 400 * 1024;
  const totalChunks = Math.ceil(base64.length / chunkSize);
  const transferId = `inspect_${Date.now()}`;
  for (let index = 0; index < totalChunks; index++) {
    sendNativeMessage("upload_pdf_chunk", {
      transfer_id: transferId,
      chunk_index: index,
      total_chunks: totalChunks,
      chunk_base64: base64.slice(index * chunkSize, (index + 1) * chunkSize),
      inspection: true,
    });
  }
  sendNativeMessage("inspect_pdf", { uploaded_transfer_id: transferId, url });
}

async function inspectPdfTab(tab) {
  showEmpty("正在取得 PDF 並辨識書目資料...");
  let captureFailure = "目前工作階段無法直接讀取 PDF";
  // Fetch in the browser session first so publisher cookies and referer rules
  // are honored; Chrome's download manager can otherwise interrupt PDF URLs.
  try {
    const [capture] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (url) => {
        try {
          const response = await fetch(url, { credentials: "include" });
          if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
          const blob = await response.blob();
          const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
          if (blob.size <= 1024 || !String.fromCharCode(...head).includes("%PDF")) {
            return { ok: false, reason: "response is not a PDF" };
          }
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          return { ok: true, base64: dataUrl.split(",", 2)[1] };
        } catch (error) {
          return { ok: false, reason: String(error) };
        }
      },
      args: [tab.url],
    });
    if (capture && capture.result && capture.result.ok && capture.result.base64) {
      queueInspectionPdf(capture.result.base64, tab.url);
      return;
    }
    captureFailure = capture && capture.result && capture.result.reason || captureFailure;
  } catch (error) {
    captureFailure = String(error);
    console.warn("PDF fetch in publisher tab failed:", error);
  }

  // The PDF viewer may block script injection. Try from the extension context
  // with the user's browser cookies before falling back to downloads.download.
  try {
    const response = await fetch(tab.url, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const header = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
    if (blob.size <= 1024 || !String.fromCharCode(...header).includes("%PDF")) {
      throw new Error("伺服器回傳的內容不是 PDF");
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    queueInspectionPdf(dataUrl.split(",", 2)[1], tab.url);
    return;
  } catch (error) {
    captureFailure = String(error);
    console.warn("PDF fetch in extension context failed:", error);
  }

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: tab.url,
      filename: `OB_Ingest/inspection_${Date.now()}.pdf`,
      conflictAction: "uniquify",
      saveAs: false,
    });
  } catch (error) {
    throw new Error(`PDF 無法取得。瀏覽器工作階段：${captureFailure}；Chrome 下載：${error.message || error}`);
  }
  if (!downloadId) throw new Error("無法下載目前的 PDF。");
  const filePath = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      reject(new Error("等待 PDF 下載逾時。"));
    }, 60000);
    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current !== "complete" && delta.state.current !== "interrupted") return;
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (delta.state.current === "interrupted") {
        const errorCode = delta.error && delta.error.current;
        reject(new Error(`PDF 下載中斷${errorCode ? `（${errorCode}）` : ""}。瀏覽器工作階段抓取失敗：${captureFailure}`));
      } else {
        chrome.downloads.search({ id: downloadId }, (items) => {
          const path = items && items[0] && items[0].filename;
          path ? resolve(path) : reject(new Error("找不到下載的 PDF。"));
        });
      }
    }
    chrome.downloads.onChanged.addListener(onChanged);
  });
  sendNativeMessage("inspect_pdf", { downloaded_file_path: filePath, url: tab.url });
}

function renderArticle(data) {
  const meta = data.metadata;
  articleEmpty.classList.add("hidden");
  articleContent.classList.remove("hidden");

  artTitle.textContent = meta.title || "（未知標題）";
  const authorShort = meta.authors ? meta.authors.split(",").slice(0, 3).join(", ") + (meta.authors.includes(",") ? " 等" : "") : "未知作者";
  const journalYear = `${meta.journal || "未知期刊"} ${meta.year ? `(${meta.year})` : ""}`;
  artMeta.textContent = `${authorShort} • ${journalYear}`;

  artDoi.textContent = meta.doi ? `DOI: ${meta.doi}` : "DOI: 無";
  artPmid.textContent = meta.pmid ? `PMID: ${meta.pmid}` : "PMID: 無";

  btnIngest.disabled = false;
  if (btnCopyMd) btnCopyMd.disabled = false;
}

function showEmpty(message) {
  articleEmpty.classList.remove("hidden");
  articleEmpty.querySelector("p").textContent = message;
  articleContent.classList.add("hidden");
  btnIngest.disabled = true;
  if (btnCopyMd) btnCopyMd.disabled = true;

  statusNote.textContent = "未核對";
  statusNote.className = "matrix-val val-unknown";
  statusSource.textContent = "未核對";
  statusSource.className = "matrix-val val-unknown";
  statusPdf.textContent = "未核對";
  statusPdf.className = "matrix-val val-unknown";
  statusZotero.textContent = "未核對";
  statusZotero.className = "matrix-val val-unknown";
}


// ── Status Matrix Rendering ─────────────────────────────────────────────────

function updateStatusMatrix(data) {
  const ob = data.obsidian;
  const zot = data.zotero;
  const pdf = data.pdf;

  // Note
  if (ob.has_note) {
    statusNote.textContent = "已建立筆記 ✓";
    statusNote.className = "matrix-val val-yes";
    statusNote.title = ob.note_path;
  } else {
    statusNote.textContent = "尚未建立";
    statusNote.className = "matrix-val val-no";
  }

  // Source
  if (ob.has_source) {
    statusSource.textContent = "已有全文快照 ✓";
    statusSource.className = "matrix-val val-yes";
    statusSource.title = ob.source_path;
  } else {
    statusSource.textContent = "尚未擷取";
    statusSource.className = "matrix-val val-no";
  }

  // PDF
  if (pdf && pdf.has_pdf) {
    statusPdf.textContent = "已有原廠 PDF ✓";
    statusPdf.className = "matrix-val val-yes";
    statusPdf.title = pdf.pdf_path;
  } else {
    statusPdf.textContent = "尚未下載";
    statusPdf.className = "matrix-val val-no";
  }

  // Zotero
  if (zot.has_item) {
    statusZotero.textContent = `已收藏 (${zot.key}) ✓`;
    statusZotero.className = "matrix-val val-yes";
  } else {
    statusZotero.textContent = "尚未收藏";
    statusZotero.className = "matrix-val val-no";
  }
}


// ── PDF Transfer & Ingestion Execution ──────────────────────────────────────

function cleanArticleTitle(text, maxLen = 120) {
  if (!text) return "paper";
  let s = text.replace(/'/g, "");
  s = s.replace(/[\\/*?:"<>|#^\[\]\n\r\t]/g, "");
  s = s.replace(/[\s_\-]+/g, "_").replace(/^_+|_+$/g, "");
  if (s.length <= maxLen) return s;
  let truncated = s.slice(0, maxLen);
  if (truncated.includes("_")) {
    truncated = truncated.slice(0, truncated.lastIndexOf("_"));
  }
  return truncated || s.slice(0, maxLen);
}

function extractLeadAuthor(authorsStr) {
  if (!authorsStr) return "Unknown";
  const rawFirst = authorsStr.split(",")[0].trim();
  let parts = rawFirst.split(/\s+/).filter(p => p.length > 0);
  const honorifics = new Set(["dr", "prof", "mr", "ms", "mrs"]);
  while (parts.length > 0 && honorifics.has(parts[0].toLowerCase().replace(/\.$/, ""))) {
    parts.shift();
  }
  if (parts.length === 0) return "Unknown";
  let surname = "Unknown";
  if (parts.length === 1) {
    surname = parts[0];
  } else {
    const p0Clean = parts[0].replace(/[^a-zA-Z]/g, "");
    const pLastClean = parts[parts.length - 1].replace(/[^a-zA-Z]/g, "");
    const isLastInitials = (
      pLastClean.length <= 3 && (parts[parts.length - 1].endsWith(".") || parts[parts.length - 1] === parts[parts.length - 1].toUpperCase() || pLastClean.length <= 2)
    );
    const isFirstInitials = (
      p0Clean.length <= 2 || parts[0].endsWith(".")
    );
    if (isLastInitials && !isFirstInitials) {
      surname = parts[0];
    } else if (isFirstInitials) {
      surname = parts[parts.length - 1];
    } else {
      surname = parts[parts.length - 1];
    }
  }
  let clean = surname.replace(/[^a-zA-Z0-9]/g, "");
  if (clean && clean === clean.toLowerCase()) {
    clean = clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  return clean || "Unknown";
}

function computeStem(metadata) {
  const pmid = metadata.pmid;
  const doi = metadata.doi;
  const author = extractLeadAuthor(metadata.authors);
  const year = metadata.year || new Date().getFullYear();
  const articleName = cleanArticleTitle(metadata.title);

  if (pmid) return `${pmid}_${author}_${articleName}_${year}`;
  if (doi) return `${doi.replace(/[^\w.\-]+/g, "_")}_${author}_${articleName}_${year}`;
  return `${author}_${articleName}_${year}`;
}

async function downloadAndUploadPdf(pdfUrl, metadata, topic) {
  try {
    let b64 = null;
    let publisherRejected = false;
    const publisherHost = new URL(pdfUrl).hostname;
    const publisherProtected = publisherHost === "jamanetwork.com" || publisherHost.endsWith(".jamanetwork.com") ||
      publisherHost === "nejm.org" || publisherHost.endsWith(".nejm.org");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    const isPdf = async (blob) => {
      if (blob.size <= 1024) return false;
      const header = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
      return String.fromCharCode(...header).includes("%PDF");
    };

    // Attempt 1: Fetch inside active tab context (uses logged-in browser session/cookies)
    if (tab && tab.id) {
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (url) => {
            try {
              const r = await fetch(url, { credentials: 'include' });
              if (!r.ok) return { ok: false, status: r.status };
              const b = await r.blob();
              if (b.size <= 1024 || !String.fromCharCode(...new Uint8Array(await b.slice(0, 1024).arrayBuffer())).includes("%PDF")) {
                return { ok: false, reason: "response is not a PDF" };
              }
              return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                  const resStr = reader.result;
                  const base64Data = resStr.includes(',') ? resStr.split(',')[1] : resStr;
                  resolve({ ok: true, base64: base64Data, size: b.size });
                };
                reader.onerror = () => resolve({ ok: false, error: "Reader error" });
                reader.readAsDataURL(b);
              });
            } catch (err) {
              return { ok: false, error: err.toString() };
            }
          },
          args: [pdfUrl],
        });
        if (res && res.result && res.result.ok && res.result.base64) {
          b64 = res.result.base64;
          console.log(`[PDF] Successfully fetched PDF via active tab (${res.result.size} bytes)`);
        } else if (res && res.result && (res.result.status || res.result.reason)) {
          publisherRejected = true;
        }
      } catch (e) {
        console.warn("[PDF] Tab script fetch failed:", e);
      }
    }

    // Attempt 2: Fetch directly in extension sidepanel context (bypasses CORS via <all_urls>)
    if (!b64) {
      try {
        const r = await fetch(pdfUrl);
        if (r.ok) {
          const b = await r.blob();
          if (await isPdf(b)) {
            b64 = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                const resStr = reader.result;
                const base64Data = resStr.includes(',') ? resStr.split(',')[1] : resStr;
                resolve(base64Data);
              };
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(b);
            });
            if (b64) console.log(`[PDF] Successfully fetched PDF via sidepanel context (${b.size} bytes)`);
          } else {
            publisherRejected = true;
          }
        } else {
          publisherRejected = true;
        }
      } catch (e) {
        console.warn("[PDF] Sidepanel fetch failed:", e);
      }
    }

    const stem = computeStem(metadata);

    // If Attempt 1 or 2 succeeded, chunk and upload
    if (b64) {
      const CHUNK_SIZE = 400 * 1024;
      const totalChunks = Math.ceil(b64.length / CHUNK_SIZE);
      const transferId = `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      for (let i = 0; i < totalChunks; i++) {
        const chunkStr = b64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        sendNativeMessage("upload_pdf_chunk", {
          transfer_id: transferId,
          chunk_index: i,
          total_chunks: totalChunks,
          chunk_base64: chunkStr,
          topic: topic,
          stem: stem,
        });
        if (totalChunks > 1) {
          await new Promise((r) => setTimeout(r, 30));
        }
      }

      console.log(`[PDF] Uploaded all ${totalChunks} chunks for ${stem}`);
      return { ok: true, method: "base64_chunks", uploadedStem: stem };
    }

    // A publisher page that returned HTML/403 will make Chrome save an .html error page.
    if (publisherProtected) {
      return { ok: false, reason: publisherRejected ? "publisher_rejected" : "publisher_pdf_unavailable" };
    }

    // Attempt 3: Chrome Native Downloads API
    // Bypasses Cloudflare JA3 & CORS redirects by delegating to Chrome's native browser download engine
    try {
      console.log(`[PDF] Initiating Chrome native download for: ${pdfUrl}`);
      const downloadFilename = `OB_Ingest/${stem}.pdf`;

      const downloadId = await chrome.downloads.download({
        url: pdfUrl,
        filename: downloadFilename,
        conflictAction: "overwrite",
        saveAs: false,
      });

      if (downloadId) {
        const downloadedFilePath = await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            chrome.downloads.onChanged.removeListener(onDownloadChanged);
            resolve(null);
          }, 30000);

          function onDownloadChanged(delta) {
            if (delta.id === downloadId) {
              if (delta.state && delta.state.current === "complete") {
                clearTimeout(timeout);
                chrome.downloads.onChanged.removeListener(onDownloadChanged);
                chrome.downloads.search({ id: downloadId }, (items) => {
                  if (items && items[0] && items[0].filename) {
                    resolve(items[0].filename);
                  } else {
                    resolve(null);
                  }
                });
              } else if (delta.error || (delta.state && delta.state.current === "interrupted")) {
                clearTimeout(timeout);
                chrome.downloads.onChanged.removeListener(onDownloadChanged);
                console.warn(`[PDF] Chrome download interrupted/failed:`, delta.error || (delta.state && delta.state.current));
                resolve(null);
              }
            }
          }

          chrome.downloads.onChanged.addListener(onDownloadChanged);
        });

        if (downloadedFilePath) {
          console.log(`[PDF] Downloaded successfully via Chrome downloads manager: ${downloadedFilePath}`);
          return { ok: true, method: "chrome_downloads", downloadedFilePath: downloadedFilePath };
        }
      }
    } catch (dlErr) {
      console.warn("[PDF] Chrome downloads attempt failed:", dlErr);
    }

    console.warn("[PDF] In-browser captures failed, falling back to Native OA resolvers.");
    return { ok: false };
  } catch (err) {
    console.error("[PDF] downloadAndUploadPdf error:", err);
    return { ok: false };
  }
}

function generateCitekeyInBrowser(meta) {
  let firstAuthor = "unknown";
  if (meta && meta.authors) {
    firstAuthor = extractLeadAuthor(meta.authors).toLowerCase().replace(/[^\w]/g, "") || "unknown";
  }
  const yearStr = meta && meta.year ? String(meta.year) : "";
  const stopWords = new Set(["a", "an", "the", "of", "in", "on", "for", "and", "to", "with", "is", "at", "by"]);
  const words = String((meta && meta.title) || "")
    .split(/\W+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w && !stopWords.has(w));
  const keyword = words.length > 0 ? words[0].replace(/[^\w]/g, "") : "";
  return `${firstAuthor}${yearStr}${keyword}`;
}

function detectImageExtension(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ".png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return ".gif";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return ".webp";
  }
  return null;
}

function isValidPdfBytes(bytes) {
  if (!bytes || bytes.length <= 1024) return false;
  const head = bytes.subarray ? bytes.subarray(0, 1024) : new Uint8Array(bytes.slice(0, 1024));
  let str = "";
  for (let i = 0; i < head.length; i++) str += String.fromCharCode(head[i]);
  return str.includes("%PDF");
}

async function fetchPdfBytesForBrowserVault(pdfUrl, doi) {
  const tryFetchUrl = async (url) => {
    if (!url || typeof fetch !== "function") return null;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const ab = await r.arrayBuffer();
      const bytes = new Uint8Array(ab);
      return isValidPdfBytes(bytes) ? bytes : null;
    } catch (e) {
      return null;
    }
  };

  // 1. Active tab session fetch
  if (pdfUrl && chrome.tabs && chrome.scripting) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (url) => {
            try {
              const r = await fetch(url, { credentials: "include" });
              if (!r.ok) return null;
              const b = await r.blob();
              if (b.size <= 1024) return null;
              return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                  const s = String(reader.result || "");
                  resolve(s.includes(",") ? s.split(",")[1] : s);
                };
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(b);
              });
            } catch (e) {
              return null;
            }
          },
          args: [pdfUrl],
        });
        if (res && res.result) {
          const binStr = atob(res.result);
          const bytes = new Uint8Array(binStr.length);
          for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
          if (isValidPdfBytes(bytes)) return { bytes, source: "browser_capture" };
        }
      }
    } catch (e) {}
  }

  // 2. Direct fetch in sidepanel context
  if (pdfUrl) {
    const direct = await tryFetchUrl(pdfUrl);
    if (direct) return { bytes: direct, source: "webpage_link" };
  }

  // 3. Unpaywall Open Access
  if (doi && typeof fetch === "function") {
    try {
      const cleanDoi = String(doi).trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
      const r = await fetch(`https://api.unpaywall.org/v2/${encodeURIComponent(cleanDoi)}?email=academic-ingest@ob-vault.local`);
      if (r.ok) {
        const data = await r.json();
        const bestUrl = data && data.best_oa_location && data.best_oa_location.url_for_pdf;
        if (bestUrl) {
          const oaBytes = await tryFetchUrl(bestUrl);
          if (oaBytes) return { bytes: oaBytes, source: "unpaywall_oa" };
        }
      }
    } catch (e) {}
  }

  return null;
}

async function ingestViaBrowserFileSystem() {
  if (!vaultDirHandle) {
    const picked = await pickVaultDirectory();
    if (!picked) {
      showError("請先選擇本地 Obsidian Vault 資料夾以寫入檔案。");
      return;
    }
  }
  const granted = await ensureVaultPermission(vaultDirHandle, "readwrite", true);
  if (!granted) {
    showError("未取得本地 Vault 資料夾的讀寫授權。");
    return;
  }

  try {
    const topic = topicSelect ? topicSelect.value : "Neurology";
    const saveSource = optSource ? optSource.checked : false;
    const shouldDownloadPdf = optPdf ? optPdf.checked : true;
    const shouldDownloadFigures = optFigures ? optFigures.checked : true;

    const meta = Object.assign({}, currentArticleData.metadata || {});
    if (!meta.citekey) meta.citekey = generateCitekeyInBrowser(meta);
    const stem = computeStem(meta);

    const sourcesDir = await getSubDirHandle(vaultDirHandle, ["Research", topic, "sources"], true);
    const pdfsDir = await getSubDirHandle(vaultDirHandle, ["Research", topic, "sources", "etc"], true);
    const figures = currentArticleData.figures || [];
    const downloadedFigs = [];

    // 1. Download Figures
    if (shouldDownloadFigures && figures.length > 0 && typeof fetch === "function") {
      progressText.textContent = `正在下載 ${figures.length} 張高解析度圖表至本地 Vault...`;
      const assetsDir = await getSubDirHandle(vaultDirHandle, ["Research", topic, "sources", "_assets", stem], true);
      for (let i = 0; i < figures.length; i++) {
        const fig = figures[i];
        if (!fig || !fig.src) continue;
        const label = fig.label || `Fig_${i + 1}`;
        const cleanLabel = String(label).replace(/[\\/*?:"<>|]/g, "").replace(/[\s_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || `Fig_${i + 1}`;
        try {
          const r = await fetch(fig.src);
          if (!r.ok) continue;
          const bytes = new Uint8Array(await r.arrayBuffer());
          const ext = detectImageExtension(bytes);
          if (!ext) continue;
          const imgFilename = `${cleanLabel}_${i + 1}${ext}`;
          await writeFileToDir(assetsDir, imgFilename, bytes);
          downloadedFigs.push({
            original_src: fig.src,
            local_rel_path: `_assets/${stem}/${imgFilename}`,
            label: label,
            caption: fig.caption || "",
          });
        } catch (e) {
          console.warn("Figure download failed in browser mode:", e);
        }
      }
    }

    // 2. Download / Save PDF
    let savedPdf = false;
    let pdfSource = null;
    if (shouldDownloadPdf && pdfsDir) {
      progressText.textContent = "正在下載並驗證論文原始 PDF...";
      const pdfRes = await fetchPdfBytesForBrowserVault(meta.pdf_url, meta.doi);
      if (pdfRes && pdfRes.bytes) {
        await writeFileToDir(pdfsDir, `${stem}.pdf`, pdfRes.bytes);
        savedPdf = true;
        pdfSource = pdfRes.source;
      } else {
        pdfSource = "未能自動下載（請確認期刊權限或開放取用狀態）";
      }
    }

    // 3. Write Source Markdown
    const sourceRelPath = `Research/${topic}/sources/${stem}.md`;
    if (saveSource && sourcesDir) {
      const articleForMd = {
        metadata: meta,
        sections: currentArticleData.sections || [],
        figures: downloadedFigs.length > 0
          ? downloadedFigs.map((f) => ({ src: f.local_rel_path, label: f.label, caption: f.caption }))
          : figures,
        tables: currentArticleData.tables || [],
      };
      const mdText = buildStructuredMarkdown(articleForMd, topic, {
        citekey: meta.citekey,
        pdfRelPath: savedPdf ? `Research/${topic}/sources/etc/${stem}.pdf` : null,
      });
      await writeFileToDir(sourcesDir, `${stem}.md`, mdText);
    }

    const pdfRelPath = `Research/${topic}/sources/etc/${stem}.pdf`;
    handleIngestionSuccess({
      status: "success",
      stem: stem,
      metadata: meta,
      source: {
        created: saveSource,
        path: saveSource ? sourceRelPath : null,
        figures_found: figures.length,
        figures_requested: shouldDownloadFigures,
        figures_downloaded: downloadedFigs.length,
      },
      pdf: {
        saved: savedPdf,
        source: pdfSource,
        path: savedPdf ? pdfRelPath : null,
        obsidian_uri: savedPdf
          ? `obsidian://open?vault=${encodeURIComponent(currentVaultName)}&file=${encodeURIComponent(pdfRelPath)}`
          : null,
      },
      note: { created: false, updated: false },
      zotero: { key: null, url: null },
    });
  } catch (err) {
    console.error("Browser File System ingestion error:", err);
    showError(`瀏覽器直連寫入失敗: ${err.message || err}`);
  }
}

async function startIngestion() {
  if (!currentArticleData || isIngesting) return;

  isIngesting = true;
  btnIngest.disabled = true;
  resultCard.classList.remove("hidden");
  progressSpinner.classList.remove("hidden");
  resultSuccess.classList.add("hidden");
  resultError.classList.add("hidden");

  // Use zero-Python Browser File System Access API mode when Native Host is not connected
  if (!nativePort && !isNativeHostOnline && (vaultDirHandle || (typeof window !== "undefined" && typeof window.showDirectoryPicker === "function"))) {
    await ingestViaBrowserFileSystem();
    return;
  }

  const figCount = currentArticleData.figures ? currentArticleData.figures.length : 0;
  const topic = topicSelect.value;
  const pdfUrl = currentArticleData.metadata ? currentArticleData.metadata.pdf_url : null;
  const shouldDownloadPdf = optPdf ? optPdf.checked : true;
  const stem = computeStem(currentArticleData.metadata);

  // In-browser PDF capture if PDF URL is available
  let dlResult = shouldDownloadPdf && currentArticleData.downloaded_file_path
    ? { ok: true, downloadedFilePath: currentArticleData.downloaded_file_path }
    : null;
  if (!dlResult && shouldDownloadPdf && pdfUrl) {
    progressText.textContent = "正在透過瀏覽器工作階段安全下載論文 PDF...";
    try {
      dlResult = await downloadAndUploadPdf(pdfUrl, currentArticleData.metadata, topic);
      if (dlResult && dlResult.ok) {
        progressText.textContent = "PDF 已傳送，正在由本地端驗證並入庫...";
      }
    } catch (e) {
      console.warn("Browser PDF capture skipped or failed:", e);
    }
  }

  if (!dlResult || !dlResult.ok) {
    progressText.textContent = `正在擷取全文、下載 PDF 與 ${figCount} 張圖表...`;
  }

  const payload = {
    metadata: currentArticleData.metadata,
    sections: currentArticleData.sections,
    figures: currentArticleData.figures,
    tables: currentArticleData.tables,
    pdf_url: pdfUrl,
    stem: stem,
    uploaded_pdf_stem: dlResult && dlResult.uploadedStem ? dlResult.uploadedStem : null,
    downloaded_file_path: dlResult && dlResult.downloadedFilePath ? dlResult.downloadedFilePath : null,
    browser_pdf_failure: dlResult && dlResult.reason ? dlResult.reason : null,
    options: {
      topic: topic,
      save_source: optSource.checked,
      download_figures: optFigures.checked,
      download_pdf: shouldDownloadPdf,
      save_note: false,
      save_zotero: optZotero.checked,
    },
  };

  sendNativeMessage("ingest_webpage", payload);
}

function handleIngestionSuccess(res) {
  isIngesting = false;
  btnIngest.disabled = false;
  progressSpinner.classList.add("hidden");
  resultSuccess.classList.remove("hidden");

  if (currentArticleData) {
    if (res.metadata) {
      currentArticleData.metadata = Object.assign({}, currentArticleData.metadata, res.metadata);
    }
    if (res.stem) {
      currentArticleData.ingested_stem = res.stem;
    }
  }

  const desc = [];
  if (res.source && res.source.created) {
    desc.push(`全文 Markdown: ${res.source.path}`);
  }
  if (res.source && res.source.figures_requested) {
    const found = res.source.figures_found || 0;
    const downloaded = res.source.figures_downloaded || 0;
    desc.push(found === 0 ? "⚠️ 網頁未找到圖表" :
      downloaded < found ? `⚠️ 圖表已下載 ${downloaded}/${found} 張` : `圖表已下載 ${downloaded}/${found} 張`);
  }
  if (res.pdf && res.pdf.saved) {
    desc.push(`📄 原廠 PDF 已入庫 (${res.pdf.source || "已儲存"})`);
  } else if (res.pdf && !res.pdf.saved) {
    desc.push(`⚠️ PDF: ${res.pdf.source || "未能自動下載"}`);
  }
  if (res.note && res.note.created) {
    desc.push(`筆記已建立: ${res.note.path}`);
  } else if (res.note && res.note.updated) {
    desc.push(`既有筆記 frontmatter 已更新: ${res.note.path}`);
  }
  if (res.zotero && res.zotero.key) {
    desc.push(`Zotero 書目對齊: ${res.zotero.key}`);
  }

  document.getElementById("result-desc").textContent = desc.join(" | ");

  // Link Buttons
  if (res.note && res.note.obsidian_uri) {
    linkObNote.href = res.note.obsidian_uri;
    linkObNote.classList.remove("hidden");
  } else {
    linkObNote.classList.add("hidden");
  }

  if (res.pdf && res.pdf.saved && (res.pdf.obsidian_uri || res.pdf.path)) {
    linkObPdf.href = res.pdf.obsidian_uri || `obsidian://open?vault=${encodeURIComponent(currentVaultName)}&file=${encodeURIComponent(res.pdf.path)}`;
    linkObPdf.classList.remove("hidden");
  } else {
    linkObPdf.classList.add("hidden");
  }

  if (res.zotero && res.zotero.url) {
    linkZotero.href = res.zotero.url;
    linkZotero.classList.remove("hidden");
  } else {
    linkZotero.classList.add("hidden");
  }

  // Refresh status
  if (currentArticleData) {
    sendNativeMessage("check_status", {
      doi: currentArticleData.metadata.doi,
      pmid: currentArticleData.metadata.pmid,
      topic: topicSelect ? topicSelect.value : "Neurology",
    });
  }
}

function showError(msg) {
  isIngesting = false;
  btnIngest.disabled = false;
  progressSpinner.classList.add("hidden");
  resultError.classList.remove("hidden");
  errorText.textContent = msg;
}


// ── Clipboard & Gemini Reading Note Import ──────────────────────────────────

async function pasteFromClipboard() {
  try {
    let text = "";
    let isHtml = false;

    if (navigator.clipboard && navigator.clipboard.read) {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes("text/html") && optAutoHtml.checked) {
            const blob = await item.getType("text/html");
            const htmlText = await blob.text();
            if (htmlText && (htmlText.includes("<p") || htmlText.includes("<h") || htmlText.includes("<table") || htmlText.includes("<div"))) {
              text = htmlText;
              isHtml = true;
              break;
            }
          }
          if (item.types.includes("text/plain")) {
            const blob = await item.getType("text/plain");
            text = await blob.text();
            break;
          }
        }
      } catch (e) {
        console.warn("clipboard.read() fallback:", e);
      }
    }

    if (!text && navigator.clipboard && navigator.clipboard.readText) {
      text = await navigator.clipboard.readText();
    }

    if (!text) {
      alert("剪貼簿目前為空，請先在 Gemini 或網頁中複製內容！");
      return;
    }

    pasteContent.value = text;
    btnSaveNote.disabled = false;
    pasteResult.classList.remove("hidden");
    pasteResultIcon.textContent = "📋";
    pasteResultMsg.textContent = isHtml
      ? "已讀取 HTML 內容（寫入時將自動轉為 Markdown）"
      : `已讀取剪貼簿內容 (${text.length} 字元)`;
    linkPasteOb.classList.add("hidden");
  } catch (err) {
    console.error("Paste error:", err);
    alert("讀取剪貼簿出錯，請直接在文字框中按 Cmd+V 貼上。");
  }
}

function buildStructuredMarkdown(articleData, topic, extraFrontmatter = {}) {
  const meta = (articleData && articleData.metadata) || {};
  const sections = (articleData && articleData.sections) || [];
  const figures = (articleData && articleData.figures) || [];
  const tables = (articleData && articleData.tables) || [];
  const quoteYaml = (val) => `"${String(val || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ").trim()}"`;

  const lines = ["---"];
  lines.push(`title: ${quoteYaml(meta.title || "Untitled Article")}`);
  if (meta.authors) lines.push(`authors: ${quoteYaml(meta.authors)}`);
  if (meta.journal) lines.push(`journal: ${quoteYaml(meta.journal)}`);
  if (meta.year) lines.push(`year: ${meta.year}`);
  if (meta.doi) lines.push(`doi: ${meta.doi}`);
  if (meta.pmid) lines.push(`pmid: ${meta.pmid}`);
  if (extraFrontmatter.citekey || meta.citekey) lines.push(`citekey: ${extraFrontmatter.citekey || meta.citekey}`);
  if (meta.url) lines.push(`url: ${meta.url}`);
  if (extraFrontmatter.pdfRelPath) lines.push(`pdf: ${extraFrontmatter.pdfRelPath}`);
  lines.push(`captured_date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push("type: source-snapshot");
  lines.push(`tags: [source, ${(topic || "neurology").toLowerCase()}, full-text]`);
  lines.push("---", "", `# ${meta.title || "Untitled Article"}`, "");

  if (meta.abstract) {
    lines.push("## Abstract", meta.abstract, "");
  }
  for (const sec of sections) {
    const heading = (sec.heading || "").trim();
    const level = sec.level || 2;
    const text = (sec.text || "").trim();
    if (heading) lines.push(`${"#".repeat(level)} ${heading}`);
    if (text) lines.push(text, "");
  }
  if (figures.length > 0) {
    lines.push("## Figures & Captions");
    for (let i = 0; i < figures.length; i++) {
      const fig = figures[i];
      const label = fig.label || `Figure_${i + 1}`;
      lines.push(`### ${label}`);
      if (fig.src) lines.push(`![${label}](${fig.src})`);
      if (fig.caption) lines.push(`> 📌 **${label}**: ${fig.caption}`);
      lines.push("");
    }
  }
  if (tables.length > 0) {
    lines.push("## Tables");
    for (const tbl of tables) {
      lines.push(`### ${tbl.caption || "Table"}`);
      if (tbl.markdown) lines.push(tbl.markdown.trim());
      lines.push("");
    }
  }
  return lines.join("\n");
}

async function copyStructuredMarkdown() {
  if (!currentArticleData) return;
  const topic = topicSelect ? topicSelect.value : "Neurology";
  const md = buildStructuredMarkdown(currentArticleData, topic);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(md);
    } else if (pasteContent) {
      pasteContent.value = md;
    }
    if (btnCopyMd) {
      const orig = btnCopyMd.textContent;
      btnCopyMd.textContent = "✅ 已複製全文 Markdown 至剪貼簿！";
      setTimeout(() => { btnCopyMd.textContent = orig; }, 2200);
    }
  } catch (e) {
    if (pasteContent) {
      pasteContent.value = md;
      btnSaveNote.disabled = false;
    }
  }
}

function cleanPdfTextInBrowser(text) {
  let cleaned = String(text || "").replace(/(\b\w+)-\s*\n\s*(\w+\b)/g, "$1$2");
  const lines = cleaned.split(/\r?\n/);
  const joined = [];
  const mdBlockRe = /^(?:#{1,6}\s|\||>|[-*+]\s|\d+\.\s|---+$|```)/;
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) {
      joined.push("");
      continue;
    }
    const prev = joined.length > 0 ? joined[joined.length - 1] : "";
    if (
      prev &&
      !mdBlockRe.test(prev) &&
      !mdBlockRe.test(stripped) &&
      !/([.。?!:：]|\b\d+\.|\b[-*#])\s*$/.test(prev) &&
      /^[a-zA-Z0-9\u4e00-\u9fa5]/.test(stripped)
    ) {
      joined[joined.length - 1] = `${prev} ${stripped}`;
      continue;
    }
    joined.push(stripped);
  }
  return joined.join("\n");
}

function cleanHtmlToMdInBrowser(htmlStr) {
  let s = String(htmlStr || "");
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => `\n\`\`\`\n${inner.replace(/<[^>]+>/g, "").trim()}\n\`\`\`\n`);
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${inner.replace(/<[^>]+>/g, "").trim()}\``);
  s = s.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_, inner) => `**${inner.replace(/<[^>]+>/g, "").trim()}**`);
  s = s.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_, inner) => `*${inner.replace(/<[^>]+>/g, "").trim()}*`);
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => `\n\n${"#".repeat(Number(lvl))} ${inner.replace(/<[^>]+>/g, "").trim()}\n\n`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${inner.replace(/<[^>]+>/g, "").trim()}`);
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => `\n\n${inner.replace(/<[^>]+>/g, "").trim()}\n\n`);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function splitNoteFrontmatter(text) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines.length > 0 && lines[0].trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        return {
          hasFrontmatter: true,
          frontmatterBlock: lines.slice(0, i + 1).join("\n"),
          body: lines.slice(i + 1).join("\n").trim(),
        };
      }
    }
  }
  return { hasFrontmatter: false, frontmatterBlock: "", body: String(text || "").trim() };
}

async function saveReadingNoteViaBrowserFileSystem(payload) {
  if (!vaultDirHandle) {
    const picked = await pickVaultDirectory();
    if (!picked) {
      btnSaveNote.disabled = false;
      btnSaveNote.textContent = "💾 寫入 Obsidian 筆記";
      return;
    }
  }
  const granted = await ensureVaultPermission(vaultDirHandle, "readwrite", true);
  if (!granted) {
    btnSaveNote.disabled = false;
    btnSaveNote.textContent = "💾 寫入 Obsidian 筆記";
    showError("未取得本地 Vault 資料夾的讀寫授權。");
    return;
  }

  try {
    const topic = payload.topic || "Neurology";
    const targetType = payload.target_type || "note";
    const rawContent = String(payload.content || "").trim();
    const looksLikeHtml = /<\s*(?:p|div|h[1-6]|table|tr|td|th|ul|ol|li|strong|b|em|i|blockquote|pre|code|br|article|section|span)\b[^>]*>/i.test(rawContent);

    let processed = rawContent;
    if (looksLikeHtml && payload.is_html) {
      processed = cleanHtmlToMdInBrowser(rawContent);
    } else if (payload.is_pdf && !looksLikeHtml) {
      processed = cleanPdfTextInBrowser(rawContent);
    }

    const incoming = splitNoteFrontmatter(processed);
    const bodyToWrite = incoming.body;

    const notesDir = await getSubDirHandle(vaultDirHandle, ["Research", topic, "notes"], true);
    const baseName = payload.stem || payload.citekey || (payload.pmid ? `pmid_${payload.pmid}` : "unknown");
    const filename = targetType === "note" ? `${baseName}.md` : `${baseName}-中文翻譯.md`;

    const existingText = await readFileTextFromDir(notesDir, filename);
    let finalContent = "";
    if (existingText !== null) {
      const existingParsed = splitNoteFrontmatter(existingText);
      if (existingParsed.hasFrontmatter) {
        finalContent = `${existingParsed.frontmatterBlock}\n\n${bodyToWrite}\n`;
      } else {
        finalContent = `${bodyToWrite}\n`;
      }
    } else {
      const citekey = payload.citekey || (currentArticleData && currentArticleData.metadata ? generateCitekeyInBrowser(currentArticleData.metadata) : "");
      if (targetType === "note") {
        finalContent = `---\ncitekey: ${citekey}\ndoi: ${payload.doi || ""}\npmid: ${payload.pmid || ""}\ntopic: ${topic.toLowerCase()}\ntype: reading-note\n---\n\n${bodyToWrite}\n`;
      } else {
        finalContent = `---\ntype: paper-translation\ncitekey: ${citekey}\ndoi: ${payload.doi || ""}\npmid: ${payload.pmid || ""}\ntopic: ${topic.toLowerCase()}\n---\n\n${bodyToWrite}\n`;
      }
    }

    await writeFileToDir(notesDir, filename, finalContent);
    const relPath = `Research/${topic}/notes/${filename}`;
    handleSaveNoteResponse({
      status: "success",
      message: `筆記內容已直接寫入 ${filename}！`,
      note_path: relPath,
      obsidian_uri: `obsidian://open?vault=${encodeURIComponent(currentVaultName)}&file=${encodeURIComponent(relPath)}`,
      target_type: targetType,
    });
  } catch (err) {
    btnSaveNote.disabled = false;
    btnSaveNote.textContent = "💾 寫入 Obsidian 筆記";
    showError(`寫入筆記失敗: ${err.message || err}`);
  }
}

async function saveReadingNote() {
  const content = pasteContent.value.trim();
  if (!content) {
    alert("請先貼上或輸入筆記內容！");
    return;
  }

  btnSaveNote.disabled = true;
  btnSaveNote.textContent = "⏳ 儲存中...";

  const targetRadio = document.querySelector('input[name="import-target"]:checked');
  const targetType = targetRadio ? targetRadio.value : "note";
  const stem = currentArticleData
    ? (currentArticleData.ingested_stem || (currentArticleData.metadata ? computeStem(currentArticleData.metadata) : null))
    : null;

  const payload = {
    topic: topicSelect ? topicSelect.value : "Neurology",
    stem: stem,
    citekey: currentArticleData ? currentArticleData.metadata.citekey : null,
    doi: currentArticleData ? currentArticleData.metadata.doi : null,
    pmid: currentArticleData ? currentArticleData.metadata.pmid : null,
    target_type: targetType,
    content: content,
    is_html: optAutoHtml.checked,
    is_pdf: optAutoPdf.checked,
  };

  if (!nativePort && !isNativeHostOnline && (vaultDirHandle || (typeof window !== "undefined" && typeof window.showDirectoryPicker === "function"))) {
    await saveReadingNoteViaBrowserFileSystem(payload);
    return;
  }

  sendNativeMessage("save_reading_note", payload);
}

function handleSaveNoteResponse(msg) {
  btnSaveNote.disabled = false;
  btnSaveNote.textContent = "💾 寫入 Obsidian 筆記";
  pasteResult.classList.remove("hidden");
  pasteResultIcon.textContent = "✅";
  pasteResultMsg.textContent = msg.message || "筆記已成功寫入！";

  if (msg.obsidian_uri) {
    linkPasteOb.href = msg.obsidian_uri;
    linkPasteOb.classList.remove("hidden");
  }

  // Refresh status matrix
  if (currentArticleData) {
    sendNativeMessage("check_status", {
      doi: currentArticleData.metadata.doi,
      pmid: currentArticleData.metadata.pmid,
      topic: topicSelect ? topicSelect.value : "Neurology",
    });
  }
}


// ── Event Listeners ─────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const savedHandle = await loadVaultHandleFromIdb();
  if (savedHandle) {
    vaultDirHandle = savedHandle;
    currentVaultName = savedHandle.name || currentVaultName;
    updateBrowserVaultBadge();
  }
  connectToNativeHost();
  detectActiveTab();

  if (btnPickVault) {
    btnPickVault.addEventListener("click", () => {
      pickVaultDirectory();
    });
  }

  hostBadge.addEventListener("click", () => {
    if (!isNativeHostOnline && !vaultDirHandle && typeof window !== "undefined" && typeof window.showDirectoryPicker === "function") {
      pickVaultDirectory();
      return;
    }
    connectToNativeHost();
    if (currentArticleData) {
      sendNativeMessage("check_status", {
        doi: currentArticleData.metadata.doi,
        pmid: currentArticleData.metadata.pmid,
        topic: topicSelect ? topicSelect.value : "Neurology",
      });
    }
  });

  topicSelect.addEventListener("change", () => {
    if (currentArticleData && currentArticleData.metadata) {
      sendNativeMessage("check_status", {
        doi: currentArticleData.metadata.doi,
        pmid: currentArticleData.metadata.pmid,
        title: currentArticleData.metadata.title,
        url: currentArticleData.metadata.url,
        topic: topicSelect.value,
      });
    }
  });

  btnDetect.addEventListener("click", () => {
    detectActiveTab(true);
  });

  btnIngest.addEventListener("click", () => {
    startIngestion();
  });

  if (btnCopyMd) {
    btnCopyMd.addEventListener("click", () => {
      copyStructuredMarkdown();
    });
  }

  // Clipboard & Note Import Events
  btnPasteClip.addEventListener("click", () => {
    pasteFromClipboard();
  });

  btnSaveNote.addEventListener("click", () => {
    saveReadingNote();
  });

  pasteContent.addEventListener("input", () => {
    btnSaveNote.disabled = pasteContent.value.trim().length === 0;
  });
});
