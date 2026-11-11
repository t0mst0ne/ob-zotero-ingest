/**
 * OB-Zotero Academic Ingestion - Background Service Worker
 * Opens the side panel when the toolbar icon (or the unpinned puzzle-menu
 * icon) is clicked.
 *
 * That click is an extension invocation, so activeTab applies here and the
 * Tab passed to this listener includes url. The side panel's own tabs.query
 * often still omits url (crbug.com/40916430 / crbug.com/1453437), and a button
 * inside the panel cannot grant activeTab. Remember the invoked tab so the
 * panel can request that one origin later — never every website, and without
 * the "tabs" permission.
 */

let invokedTab = null;
let invokedEpoch = 0;

function rememberInvokedTab(tab) {
  if (!tab || !tab.id) return;
  invokedEpoch += 1;
  invokedTab = {
    id: tab.id,
    windowId: typeof tab.windowId === "number" ? tab.windowId : null,
    url: typeof tab.url === "string" ? tab.url : "",
    epoch: invokedEpoch,
  };
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab || typeof tab.windowId !== "number" || !chrome.sidePanel || !chrome.sidePanel.open) return;
  rememberInvokedTab(tab);
  // Must be called synchronously in this handler so the user gesture is kept.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
    console.error("Error opening side panel:", error);
  });
  notifyInvokedTab();
  // The click grants activeTab in this worker even when the Tab object omits
  // url. Read the live href here, then hand that one origin to the panel.
  if (!invokedTab.url && tab.id && chrome.scripting && typeof chrome.scripting.executeScript === "function") {
    const epoch = invokedTab.epoch;
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => location.href,
    }).then((injected) => {
      const href = injected && injected[0] && injected[0].result;
      if (typeof href !== "string" || !href || !invokedTab || invokedTab.epoch !== epoch) return;
      invokedTab = { id: tab.id, windowId: tab.windowId, url: href, epoch: epoch };
      notifyInvokedTab();
    }).catch(() => {});
  }
});

function notifyInvokedTab() {
  if (!invokedTab || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") return;
  chrome.runtime.sendMessage({ action: "invoked_tab", tab: invokedTab }).catch(() => {});
}

// A navigation drops the activeTab grant when the origin changes. Forget the
// captured URL so the panel cannot keep acting on the previous page. status
// is visible without the "tabs" permission; url often is not.
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!invokedTab || invokedTab.id !== tabId || !changeInfo) return;
    if (changeInfo.status === "loading") {
      invokedEpoch += 1;
      invokedTab = { id: tabId, windowId: invokedTab.windowId, url: "", epoch: invokedEpoch };
    }
  });
}

// Listen for messages from sidepanel or content scripts if needed
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === "get_invoked_tab") {
    sendResponse({ tab: invokedTab });
    return;
  }
  if (message && message.action === "get_active_tab_id") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const active = tabs && tabs[0];
      if (active && active.id) {
        const response = { tabId: active.id };
        if (typeof active.url === "string" && active.url) response.url = active.url;
        sendResponse(response);
      } else {
        sendResponse({ error: "No active tab" });
      }
    });
    return true; // Keep message channel open for async response
  }
});
