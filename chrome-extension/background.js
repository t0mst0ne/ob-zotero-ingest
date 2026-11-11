/**
 * OB-Zotero Academic Ingestion - Background Service Worker
 * Configures Side Panel behavior to open when extension action icon is clicked.
 */

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Error setting panel behavior:", error));

// Listen for messages from sidepanel or content scripts if needed
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "get_active_tab_id") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        sendResponse({ tabId: tabs[0].id, url: tabs[0].url });
      } else {
        sendResponse({ error: "No active tab" });
      }
    });
    return true; // Keep message channel open for async response
  }
});
