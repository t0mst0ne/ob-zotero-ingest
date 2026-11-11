/**
 * OB-Zotero Academic Ingestion - Background Service Worker
 * Opens the side panel when the toolbar icon is clicked.
 *
 * Letting Chrome open the panel from the toolbar icon does not grant activeTab
 * (crbug.com/40916430). Without that grant — and without the broad "tabs"
 * permission — chrome.tabs.query omits tab.url. Handling the click here and
 * calling sidePanel.open() is the user gesture that grants activeTab for the
 * current page.
 */

chrome.action.onClicked.addListener((tab) => {
  if (!tab || typeof tab.windowId !== "number" || !chrome.sidePanel || !chrome.sidePanel.open) return;
  // Must be called synchronously in this handler so the user gesture is kept.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
    console.error("Error opening side panel:", error);
  });
});

// Listen for messages from sidepanel or content scripts if needed
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "get_active_tab_id") {
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
