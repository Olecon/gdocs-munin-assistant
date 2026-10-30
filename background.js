// Service worker: the toolbar icon toggles the in-page Munin panel (an iframe injected by
// content.js) and is enabled only on Google Docs document tabs. It also tells the content
// script its own tab ID and re-injects it into open Docs tabs after an unpacked reload.
// No state is kept in memory (the worker is ephemeral).

const DOC_RE = /^https:\/\/docs\.google\.com\/document\//;

function isDocUrl(url) {
  return typeof url === 'string' && DOC_RE.test(url);
}

async function applyForTab(tabId, url) {
  if (tabId == null || tabId < 0) return;
  try {
    if (isDocUrl(url)) await chrome.action.enable(tabId);
    else await chrome.action.disable(tabId);
  } catch (e) {
    // The tab may have been closed; not critical.
  }
}

async function init() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((t) => applyForTab(t.id, t.url)));
  } catch (e) {
    console.warn('tabs init failed', e);
  }
}

// An update (reloading an unpacked extension counts as one) orphans the content script in open Docs
// tabs: their panel iframe is dead. Unpacked installs (developer mode, see src/dev-reload.js) inject a
// fresh content.js, which removes the old panel and restores the saved one; store builds are left alone.
async function reinjectDocTabs() {
  try {
    if (chrome.runtime.getManifest().update_url) return;
    const tabs = await chrome.tabs.query({ url: 'https://docs.google.com/document/*' });
    await Promise.all(tabs.filter((t) => isDocUrl(t.url)).map((t) =>
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] })
        .catch(() => { /* discarded or still loading: the toolbar click injects later */ })));
  } catch (e) {
    console.warn('content script re-injection failed', e);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const reason = details && details.reason;
  await Promise.all([init(), reason === 'update' || reason === 'install' ? reinjectDocTabs() : null]);
});
chrome.runtime.onStartup.addListener(init);

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'loading' || info.status === 'complete') {
    applyForTab(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    applyForTab(tabId, tab.url);
  } catch (e) { /* ignore */ }
});

// Toolbar icon: toggle the in-page panel. If the content script is missing (the tab was
// opened before the extension was installed or reloaded), inject it first.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null || !isDocUrl(tab.url)) return;
  const toggle = () => chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  try {
    await toggle();
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await toggle();
    } catch (e2) {
      console.warn('Could not open the Munin panel; reload the document tab.', e2);
    }
  }
});

// The content script asks for its tab ID (passed to the panel iframe as #tabId=N).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender.tab ? sender.tab.id : null });
  }
  return false;
});
