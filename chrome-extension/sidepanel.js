/**
 * OB-Zotero Academic Ingestion - Side Panel Controller
 * Handles UI interactions, content extraction from active tab,
 * and IPC communication with the Python Native Messaging Host.
 */

const NATIVE_HOST_NAME = "com.ob.zotero.ingest";

// State
let nativePort = null;
let currentArticleData = null;
let isIngesting = false;
let currentVaultName = "OB";

// DOM Elements
const hostBadge = document.getElementById("host-badge");
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
      console.warn("Native host disconnected:", err);
      hostBadge.textContent = "○ 點此重新連線";
      hostBadge.className = "badge badge-disconnected cursor-pointer";
      nativePort = null;
      if (isIngesting) {
        showError("本地入庫進程通訊已結束。");
      }
    });

    // Send ping to verify connection
    nativePort.postMessage({ action: "ping", payload: {} });
  } catch (err) {
    console.error("Failed to connect to native host:", err);
    hostBadge.textContent = "○ 點此重新連線";
    hostBadge.className = "badge badge-disconnected cursor-pointer";
  }
}

function sendNativeMessage(action, payload) {
  if (!nativePort) {
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
  } else if (action !== "check_status" && action !== "ping") {
    showError("無法連線至本地 Native Messaging Host，請先依 README 執行 ./install.sh 並設定 Vault（或使用上方「複製結構化全文 Markdown」）。");
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

async function detectActiveTab(fromUserGesture = false) {
  if (!nativePort) {
    connectToNativeHost();
  }
  btnDetect.textContent = "⏳ 檢測中...";
  btnDetect.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      showEmpty("找不到目前啟用的瀏覽器分頁。");
      return;
    }

    if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
      showEmpty("無法在瀏覽器系統頁面上擷取文獻。");
      return;
    }

    // Chrome's built-in PDF viewer does not expose publisher citation meta tags.
    if (isPdfTabUrl(tab.url)) {
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
      if (fromUserGesture && await requestTabOriginPermission(tab.url)) {
        results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content_script.js"],
        });
      } else {
        throw scriptErr;
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

async function startIngestion() {
  if (!currentArticleData || isIngesting) return;

  isIngesting = true;
  btnIngest.disabled = true;
  resultCard.classList.remove("hidden");
  progressSpinner.classList.remove("hidden");
  resultSuccess.classList.add("hidden");
  resultError.classList.add("hidden");

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

function buildStructuredMarkdown(articleData, topic) {
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
  if (meta.url) lines.push(`url: ${meta.url}`);
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

function saveReadingNote() {
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

document.addEventListener("DOMContentLoaded", () => {
  connectToNativeHost();
  detectActiveTab();

  hostBadge.addEventListener("click", () => {
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
