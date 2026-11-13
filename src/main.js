'use strict';
// Module main.js: buttons under messages, tab context (refreshContext), the resizable bottom pane and
// the initialization (bindUi, init). Loaded last: it wires the events and starts the panel.
/* global bindAgentMap, $, canRequest, accounts, activeConfig, bindModelMenu, chatAccount, addError, bindAttachments, applyTheme, applyToDocument, bindChatMenu, bindModeMenu, bindPopup, bindSettingsForm, runTurnHooks,
   CHAT_MIN_HEIGHT, continueFromButton, doPlanFromButton, closeChatMenu, closeFiles, closeSettings, connectGoogle, createChat, decidePreview,
   discardQueued, disconnectGoogle, migrateChatFiles, readDocFiles, docIdFromUrl, docLineReady, docStatusText, editQueued, el, getDocTab, handlePopupKey, HOST_TAB_ID, INPUT_HEIGHT_DEFAULT,
   INPUT_HEIGHT_KEY, INPUT_HEIGHT_MIN, INPUT_ROW_MIN, loadApplyMode, loadChatStore, loadSettings, loadTheme,
   onChatCopy, onFilesAdd, onInstructionsInput, onRuntimeMessage, openFiles, openSettings, positionPopup, queueInput, readDocInstructions, readMainInstructions,
   refreshSelection, renderChatSwitcher, renderContextGauge, renderEmpty, renderHistory, renderSelection,
   saveInstructions, saveSettings, sendMessage, sendToTab, startDocLive, setDocTitle, setStatus, state,
   switchGoogleAccount, syncQueueChat, SYSTEM_THEME_QUERY, systemTheme, toggleTheme, toolCard, undoAllFromButton, undoFromButton,
   updateActionState, watchFilesStorage, watchInstructionsStorage */
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
  // The user clicked it, so a success needs no card: the button's check mark is the confirmation. A failure keeps its card.
  if (!res.ok) { toolCard('fail', res.message, text); return; } // the message already includes the detail
  if (btn) { btn.classList.add('done'); setTimeout(() => btn.classList.remove('done'), 1200); }
  setTimeout(() => refreshSelection(), 400);
}

el.chat.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'undo-edit') { undoFromButton(btn.dataset.edit, btn); return; }
  if (btn.dataset.act === 'undo-all') { undoAllFromButton(btn.dataset.edit, btn); return; }
  if (btn.dataset.act === 'continue-turn') { continueFromButton(btn); return; } // the wrap-up row of the turn
  if (btn.dataset.act === 'plan-do') { doPlanFromButton(btn); return; } // under the latest Plan answer
  const decision = { 'preview-accept': 'accept', 'preview-reject': 'reject', 'preview-accept-all': 'accept-all',
    'preview-skip': 'skip' }[btn.dataset.act]; // permission and Your-turn cards
  if (decision) { decidePreview(btn.dataset.preview, decision); return; }
  const bubble = btn.closest('.msg');
  if (!bubble) return;
  const act = btn.dataset.act;
  // bubble._text is the answer only (reasoning is kept separately and never copied). Apply exists only for an edit
  // block or a code block (apply-code): an ordinary answer is no text for the document.
  if (act === 'copy-msg') copyText(bubble._text || '', btn);
  else if (act === 'copy-selftest') copyText(bubble._report || '', btn); // the self-test report as Markdown
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
let pingErrorShown = ''; // the content-script error last put into the chat (refreshContext)
async function refreshContext({ force = false } = {}) {
  watchInstructionsStorage(); // once: another tab changed the instructions
  watchFilesStorage(); // once: another tab added or removed a file of the document
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
      // Files attached in chats by an earlier build move to the document first (once; attachments.js).
      const load = migrateChatFiles(id).then(() => Promise.all([loadChatStore(id), readDocInstructions(id), readDocFiles(id)]));
      state.loadingCtx = load;
      let store;
      let instructions;
      let files;
      try { [store, instructions, files] = await load; } finally { if (state.loadingCtx === load) state.loadingCtx = null; }
      state.chats = store.chats;
      state.chatId = store.chatId;
      state.messages = store.messages;
      state.docInstructions = instructions;
      state.docFiles = files;
      runTurnHooks('panelDoc', id); // registerTurnHook (best effort)
    } else {
      state.chats = []; state.chatId = null; state.messages = []; state.docInstructions = ''; state.docFiles = [];
    }
    closeFiles(); // the list and the open entry belonged to the previous document
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
    pingErrorShown = '';
  } catch (e) {
    setStatus(e.message, true);
    // "Reload the document tab (F5)": the line under the title shows no such text, so it goes to the chat, once
    // while it repeats (every tab switch runs refreshContext).
    if (e.message !== pingErrorShown) addError(e.message);
    pingErrorShown = e.message;
  }
  refreshSelection();
}

// ---------------------------------------------------------------------------
// Resizable bottom pane (drag splitter between the chat and the composer)
// ---------------------------------------------------------------------------
function maxInputHeight() {
  const topbar = document.querySelector('.topbar');
  // The Settings and Files sections open over the chat (an overlay): they take no height.
  const avail = window.innerHeight - (topbar ? topbar.offsetHeight : 0) -
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
  // Expanding the Selected preview or showing the trim note raises the content minimum: re-clamp
  // so the pane grows instead of clipping the textarea or the control bar.
  const reclampOnContent = new MutationObserver(() => { if (window.innerHeight > 0) setInputHeight(desiredInputHeight, false); });
  reclampOnContent.observe(el.selBox, { attributes: true, attributeFilter: ['open'] });
  // Nothing selected: the Selected line opens nothing (Enter on the summary arrives as a click too).
  el.selBox.addEventListener('click', (ev) => { if (!state.selection && ev.target.closest && ev.target.closest('summary')) ev.preventDefault(); });
  reclampOnContent.observe(el.trimNote, { attributes: true, attributeFilter: ['class'] });
  reclampOnContent.observe($('queueRow'), { attributes: true, attributeFilter: ['class'] });
  reclampOnContent.observe($('attachRow'), { attributes: true, attributeFilter: ['class'] });
  reclampOnContent.observe(el.selFull, { childList: true, characterData: true, subtree: true });
}

function bindUi() {
  $('themeBtn').addEventListener('click', () => toggleTheme());
  if (SYSTEM_THEME_QUERY) {
    SYSTEM_THEME_QUERY.addEventListener('change', () => { if (state.themeFollowsSystem) applyTheme(systemTheme()); });
  }
  $('settingsBtn').addEventListener('click', () => {
    closeChatMenu();
    closeFiles();
    if (el.settings.classList.contains('hidden')) openSettings(); else closeSettings();
  });
  // A press anywhere outside an open layer (Settings, Files: the chat, the composer, the header, a dialog)
  // closes it; its own header button toggles it. Both save as they go, so nothing is lost.
  const closeOnPressOutside = (section, button, close) => document.addEventListener('pointerdown', (e) => {
    if (section.classList.contains('hidden')) return;
    if (section.contains(e.target) || button.contains(e.target)) return;
    close();
  }, true);
  closeOnPressOutside(el.settings, $('settingsBtn'), closeSettings);
  closeOnPressOutside(el.files, el.filesBtn, closeFiles);
  el.filesBtn.addEventListener('click', () => {
    closeChatMenu();
    if (el.files.classList.contains('hidden')) openFiles(); else closeFiles();
  });
  el.instructionsText.addEventListener('input', onInstructionsInput);
  el.instructionsText.addEventListener('blur', () => saveInstructions());
  el.filesAdd.addEventListener('click', () => onFilesAdd()); // + Add file (the composer's picker), or Close while an entry is open
  bindSettingsForm();
  // The panel goes away (tab closed, extension reloaded): keep what is still waiting for a typing pause.
  window.addEventListener('pagehide', () => { saveSettings(); saveInstructions(); });
  el.googleConnect.addEventListener('click', () => connectGoogle());
  el.googleSwitch.addEventListener('click', () => switchGoogleAccount());
  el.googleDisconnect.addEventListener('click', () => disconnectGoogle());
  el.newChatBtn.addEventListener('click', () => createChat());
  bindChatMenu();
  // The raven in the header (overlay mode only): the content script hides the panel and shows its
  // round raven button in the page.
  if (HOST_TAB_ID != null) {
    el.collapseBtn.disabled = false;
    el.collapseBtn.setAttribute('aria-label', 'Hide the panel');
    el.collapseBtn.addEventListener('click', () => {
      chrome.tabs.sendMessage(HOST_TAB_ID, { type: 'COLLAPSE_PANEL' }).catch(() => {});
    });
  }
  bindSplitter();
  bindPopup();
  bindAttachments();
  el.action.addEventListener('click', () => {
    if (state.busy) { if (state.abort) state.abort.abort(); } else sendMessage();
  });
  el.input.addEventListener('input', updateActionState);
  bindModeMenu(renderContextGauge); // Plan offers fewer tools
  bindAgentMap(); // the agents pill and the agent map (agent-map.js)
  bindModelMenu();
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
  state.mainInstructions = await readMainInstructions(); // after loadSettings: it moves the old notes for all documents
  await loadApplyMode();
  await loadInputHeight();
  await refreshContext({ force: true });
  startDocLive(); // the live document line: a first read, then the poll while visible and idle
  if (!accounts().length) addError('To get started, add a provider and its API key in the settings.', true);
  else if (chatAccount() && !canRequest(activeConfig())) addError(`To get started, add your ${activeConfig().name} API key in the settings.`, true);
})();
