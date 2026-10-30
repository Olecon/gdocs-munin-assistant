'use strict';
// Module main.js: buttons under messages, tab context (refreshContext), the resizable bottom pane and
// the initialization (bindUi, init). Loaded last: it wires the events and starts the panel.
/* global $, activeConfig, activeProvider, addError, applyTheme, applyToDocument, bindChatMenu, bindModeMenu, bindPopup, runTurnHooks,
   CHAT_MIN_HEIGHT, checkModels, continueFromButton, doPlanFromButton, closeChatMenu, closeInstructions, closeSettings, connectGoogle, createChat, decidePreview,
   discardQueued, disconnectGoogle, docIdFromUrl, docLineReady, docStatusText, editQueued, el, getDocTab, handlePopupKey, HOST_TAB_ID, INPUT_HEIGHT_DEFAULT,
   INPUT_HEIGHT_KEY, INPUT_HEIGHT_MIN, INPUT_ROW_MIN, loadApplyMode, loadChatStore, loadSettings, loadTheme,
   onApiKeyBlur, onApiKeyInput, onChatCopy, onInstructionsInput, onModelChange, onRuntimeMessage, openInstructions, openSettings, positionPopup, queueInput, readDocInstructions,
   refreshSelection, renderChatSwitcher, renderContextGauge, renderEmpty, revertRememberFromButton, renderHistory, renderInstructionsBadge, renderSelection,
   saveInstructions, saveSettings, sendMessage, sendToTab, startDocLive, setDocTitle, setStatus, state,
   switchGoogleAccount, switchSettingsProvider, syncQueueChat, SYSTEM_THEME_QUERY, systemTheme, toggleTheme, toolCard, undoAllFromButton, undoFromButton,
   updateActionState */
/* exported refreshContext */

// ---------------------------------------------------------------------------
// Buttons under messages (event delegation)
// ---------------------------------------------------------------------------
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { btn.classList.add('done'); setTimeout(() => btn.classList.remove('done'), 1200); } // check mark for a moment
  } catch (e) {
    addError('Could not copy: ' + e.message);
  }
}

async function applyFromButton(text, btn) {
  if (!text) return;
  if (btn) btn.disabled = true;
  const res = await applyToDocument(text);
  if (btn) btn.disabled = false;
  if (res.ok) toolCard('ok', res.message, text, res.detail); // detail: how it was pasted; message: confirmed or not
  else toolCard('fail', res.message, text); // the message already includes the detail
  if (res.ok) setTimeout(() => refreshSelection(), 400);
}

el.chat.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'undo-edit') { undoFromButton(btn.dataset.edit, btn); return; }
  if (btn.dataset.act === 'undo-all') { undoAllFromButton(btn.dataset.edit, btn); return; }
  if (btn.dataset.act === 'revert-remember') { revertRememberFromButton(btn.dataset.call, btn); return; }
  if (btn.dataset.act === 'continue-turn') { continueFromButton(btn); return; } // the tool-budget notice
  if (btn.dataset.act === 'plan-do') { doPlanFromButton(btn); return; } // under the latest Plan answer
  const decision = { 'preview-accept': 'accept', 'preview-reject': 'reject', 'preview-accept-all': 'accept-all',
    'preview-continue': 'continue', 'preview-skip': 'skip' }[btn.dataset.act]; // permission and Your-turn cards
  if (decision) { decidePreview(btn.dataset.preview, decision); return; }
  const bubble = btn.closest('.msg');
  if (!bubble) return;
  const act = btn.dataset.act;
  // bubble._text is the answer only (reasoning is kept separately and never copied/applied).
  if (act === 'copy-msg') copyText(bubble._text || '', btn);
  else if (act === 'copy-selftest') copyText(bubble._report || '', btn); // the self-test report as Markdown
  else if (act === 'apply-msg') applyFromButton(bubble._text || '', btn);
  else if (act === 'copy-code' || act === 'apply-code') {
    const code = (bubble._codes || [])[Number(btn.dataset.idx)];
    if (code == null) return;
    if (act === 'copy-code') copyText(code, btn); else applyFromButton(code, btn);
  }
});
// Ctrl+C on a chat selection: plain text and clean HTML, without the panel's colours and fonts.
el.chat.addEventListener('copy', onChatCopy);

// ---------------------------------------------------------------------------
// Tab context and initialization
// ---------------------------------------------------------------------------
async function refreshContext({ force = false } = {}) {
  let tab;
  try {
    tab = await getDocTab();
  } catch (e) {
    setStatus(e.message, true);
    return;
  }
  const id = docIdFromUrl(tab.url);
  state.tabId = tab.id;
  setDocTitle((tab.title || '').replace(/\s*[-–—]\s*Google\s+\S+\s*$/i, '') || 'Document');
  if (id !== state.docId || force) {
    closeChatMenu();
    state.docId = id;
    if (id) {
      // sendMessage waits for this, so an early send cannot capture a half-loaded chat
      // (chatId null / the array that is about to be replaced) and lose its turn.
      const load = Promise.all([loadChatStore(id), readDocInstructions(id)]);
      state.loadingCtx = load;
      let store;
      let instructions;
      try { [store, instructions] = await load; } finally { if (state.loadingCtx === load) state.loadingCtx = null; }
      state.chats = store.chats;
      state.chatId = store.chatId;
      state.messages = store.messages;
      state.docInstructions = instructions;
      runTurnHooks('panelDoc', id); // registerTurnHook (best effort)
    } else {
      state.chats = []; state.chatId = null; state.messages = []; state.docInstructions = '';
    }
    closeInstructions(); // the form belonged to the previous document
    renderInstructionsBadge();
    state.selection = '';
    renderHistory();
    renderSelection();
    renderChatSwitcher();
    syncQueueChat(); // a message queued for the previous document goes back into the input box
  }
  try {
    const r = await sendToTab({ type: 'PING' });
    if (r && r.title) setDocTitle(r.title);
    setStatus(docLineReady() ? docStatusText() : 'Ready'); // keep the live document line (src/doc-live.js)
  } catch (e) {
    setStatus(e.message, true);
  }
  refreshSelection();
}

// ---------------------------------------------------------------------------
// Resizable bottom pane (drag splitter between the chat and the composer)
// ---------------------------------------------------------------------------
function maxInputHeight() {
  const topbar = document.querySelector('.topbar');
  const settingsH = (el.settings.classList.contains('hidden') ? 0 : el.settings.offsetHeight) +
    (el.instructions.classList.contains('hidden') ? 0 : el.instructions.offsetHeight);
  const avail = window.innerHeight - (topbar ? topbar.offsetHeight : 0) - settingsH -
    el.splitter.offsetHeight - CHAT_MIN_HEIGHT;
  return Math.max(minInputHeight(), avail);
}

// Smallest bottom-pane height at which nothing clips: the composer's padding plus every visible
// child at its natural height (Selected row, possibly expanded, trim note, control bar), with the
// textarea row at INPUT_ROW_MIN. Falls back to INPUT_HEIGHT_MIN while the panel is hidden.
function minInputHeight() {
  try {
    if (!el.composer.offsetHeight || typeof getComputedStyle !== 'function') return INPUT_HEIGHT_MIN;
    const px = (v) => parseFloat(v) || 0;
    const cs = getComputedStyle(el.composer);
    let h = px(cs.paddingTop) + px(cs.paddingBottom);
    for (const child of el.composer.children) {
      const ccs = getComputedStyle(child);
      if (ccs.display === 'none') continue;
      const margins = px(ccs.marginTop) + px(ccs.marginBottom);
      h += margins + (child.classList.contains('input-row') ? INPUT_ROW_MIN : child.offsetHeight);
    }
    return Math.max(100, Math.ceil(h));
  } catch (e) {
    return INPUT_HEIGHT_MIN;
  }
}

// The user's preferred height is remembered separately from the clamped, displayed one, so a
// temporarily small panel (e.g. hidden while collapsed) does not overwrite the preference.
let desiredInputHeight = INPUT_HEIGHT_DEFAULT;

function setInputHeight(h, remember = true) {
  const minH = minInputHeight();
  const want = Math.max(minH, Number(h) || INPUT_HEIGHT_DEFAULT);
  // Never below the content minimum (that would clip), even if the chat must shrink for it.
  const v = Math.round(Math.max(minH, Math.min(maxInputHeight(), want)));
  if (remember) desiredInputHeight = v;
  el.composer.style.height = v + 'px';
  el.splitter.setAttribute('aria-valuenow', String(v));
  positionPopup(); // keep the slash-command popup anchored to the input
  return v;
}

function saveInputHeight() {
  try { chrome.storage.local.set({ [INPUT_HEIGHT_KEY]: desiredInputHeight }); } catch (e) { /* ignore */ }
}

async function loadInputHeight() {
  let h = INPUT_HEIGHT_DEFAULT;
  try {
    const got = await chrome.storage.local.get(INPUT_HEIGHT_KEY);
    if (Number.isFinite(Number(got[INPUT_HEIGHT_KEY]))) h = Number(got[INPUT_HEIGHT_KEY]);
  } catch (e) { /* ignore */ }
  desiredInputHeight = Math.max(INPUT_HEIGHT_MIN, h);
  setInputHeight(desiredInputHeight, false);
}

function bindSplitter() {
  let startY = 0;
  let startH = 0;
  let dragging = false;
  el.splitter.setAttribute('aria-valuemin', String(INPUT_HEIGHT_MIN));
  el.splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startH = el.composer.offsetHeight;
    el.splitter.setPointerCapture(e.pointerId);
    el.splitter.classList.add('dragging');
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  el.splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setInputHeight(startH + (startY - e.clientY)); // dragging up makes the pane taller
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { el.splitter.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    el.splitter.classList.remove('dragging');
    document.body.classList.remove('resizing');
    saveInputHeight();
  };
  el.splitter.addEventListener('pointerup', end);
  el.splitter.addEventListener('pointercancel', end);
  // Keyboard: arrow keys resize in 16px steps.
  el.splitter.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    setInputHeight(el.composer.offsetHeight + (e.key === 'ArrowUp' ? 16 : -16));
    saveInputHeight();
  });
  // Re-clamp the preferred height when the panel (iframe) is resized or shown again.
  window.addEventListener('resize', () => { if (window.innerHeight > 0) setInputHeight(desiredInputHeight, false); });
  // Opening/closing the settings section changes the space available: re-clamp too, so the
  // bottom pane cannot squeeze the chat to zero or push the page into overflow.
  const reclampOnSection = new MutationObserver(() => { if (window.innerHeight > 0) setInputHeight(desiredInputHeight, false); });
  reclampOnSection.observe(el.settings, { attributes: true, attributeFilter: ['class'] });
  reclampOnSection.observe(el.instructions, { attributes: true, attributeFilter: ['class'] });
  // Expanding the Selected preview or showing the trim note raises the content minimum: re-clamp
  // so the pane grows instead of clipping the textarea or the control bar.
  const reclampOnContent = new MutationObserver(() => { if (window.innerHeight > 0) setInputHeight(desiredInputHeight, false); });
  reclampOnContent.observe(el.selBox, { attributes: true, attributeFilter: ['open'] });
  reclampOnContent.observe(el.trimNote, { attributes: true, attributeFilter: ['class'] });
  reclampOnContent.observe($('queueRow'), { attributes: true, attributeFilter: ['class'] });
  reclampOnContent.observe(el.selFull, { childList: true, characterData: true, subtree: true });
}

function bindUi() {
  $('themeBtn').addEventListener('click', () => toggleTheme());
  if (SYSTEM_THEME_QUERY) {
    SYSTEM_THEME_QUERY.addEventListener('change', () => { if (state.themeFollowsSystem) applyTheme(systemTheme()); });
  }
  $('settingsBtn').addEventListener('click', () => {
    closeChatMenu();
    closeInstructions();
    if (el.settings.classList.contains('hidden')) openSettings(); else closeSettings();
  });
  // A press anywhere outside the settings (chat, composer, header, a dialog) closes them; the gear toggles itself.
  document.addEventListener('pointerdown', (e) => {
    if (el.settings.classList.contains('hidden')) return;
    if (el.settings.contains(e.target) || $('settingsBtn').contains(e.target)) return;
    closeSettings();
  }, true);
  el.instructionsBtn.addEventListener('click', () => {
    closeChatMenu();
    if (el.instructions.classList.contains('hidden')) openInstructions(); else closeInstructions();
  });
  el.instructionsText.addEventListener('input', onInstructionsInput);
  el.instructionsText.addEventListener('blur', () => saveInstructions());
  $('closeInstructions').addEventListener('click', closeInstructions);
  el.apiKey.addEventListener('input', onApiKeyInput);
  el.apiKey.addEventListener('blur', () => onApiKeyBlur());
  // The gauge's window and compaction point belong to the active provider.
  el.provider.addEventListener('change', async () => { await switchSettingsProvider(el.provider.value); renderContextGauge(); });
  el.modelSelect.addEventListener('change', async () => { await onModelChange(); renderContextGauge(); });
  // The panel goes away (tab closed, extension reloaded): keep what is still waiting for a typing pause.
  window.addEventListener('pagehide', () => { saveSettings(); saveInstructions(); });
  el.checkModels.addEventListener('click', () => checkModels());
  el.googleConnect.addEventListener('click', () => connectGoogle());
  el.googleSwitch.addEventListener('click', () => switchGoogleAccount());
  el.googleDisconnect.addEventListener('click', () => disconnectGoogle());
  el.newChatBtn.addEventListener('click', () => createChat());
  bindChatMenu();
  // The raven in the header (overlay mode only): the content script hides the panel and shows its
  // round raven button in the page.
  if (HOST_TAB_ID != null) {
    el.collapseBtn.disabled = false;
    el.collapseBtn.title = 'Hide the panel';
    el.collapseBtn.setAttribute('aria-label', 'Hide the panel');
    el.collapseBtn.addEventListener('click', () => {
      chrome.tabs.sendMessage(HOST_TAB_ID, { type: 'COLLAPSE_PANEL' }).catch(() => {});
    });
  }
  bindSplitter();
  bindPopup();
  el.action.addEventListener('click', () => {
    if (state.busy) { if (state.abort) state.abort.abort(); } else sendMessage();
  });
  el.input.addEventListener('input', updateActionState);
  bindModeMenu(renderContextGauge); // Manual and Plan offer fewer tools
  // The content script pushes the document selection as soon as the user finishes selecting.
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  el.input.addEventListener('keydown', (e) => {
    // While the slash-command popup is open, its keys (Enter included) select instead of sending.
    if (handlePopupKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // While a turn runs (or waits for another tab), Enter queues the message; Stop stays on the button.
      if (state.busy) queueInput(); else sendMessage();
    }
  });
  $('queueEdit').addEventListener('click', () => { editQueued(); el.input.focus(); });
  $('queueText').addEventListener('click', () => { editQueued(); el.input.focus(); });
  $('queueDiscard').addEventListener('click', () => discardQueued());
  // A chat switch re-renders the switcher title (renderChatSwitcher): a queued message of another chat
  // goes back into the input box then.
  new MutationObserver(() => syncQueueChat()).observe(el.chatSwitchTitle, { childList: true, characterData: true, subtree: true });

  // Without a host tab (fallback mode) the panel follows the active tab.
  if (HOST_TAB_ID == null) chrome.tabs.onActivated.addListener(() => { if (!state.busy) refreshContext(); });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId === state.tabId && info.status === 'complete' && !state.busy) refreshContext();
  });
}

(async function init() {
  bindUi();
  // Theme and animations together, before the first render, so the panel never shows the wrong state.
  await loadTheme();
  updateActionState();
  renderEmpty();
  renderSelection();
  await loadSettings();
  await loadApplyMode();
  await loadInputHeight();
  await refreshContext({ force: true });
  startDocLive(); // the live document line: a first read, then the poll while visible and idle
  if (!activeConfig().apiKey) addError(`To get started, add your ${activeProvider().label} API key in the settings.`, true);
})();
