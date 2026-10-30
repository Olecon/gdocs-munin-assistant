// Content script for https://docs.google.com/document/*
// Hosts the in-page Munin panel (TOGGLE_PANEL / COLLAPSE_PANEL, the raven button, the resize grip), answers panel messages
// (GET_DOC_TEXT, GET_SELECTION, REPLACE_SELECTION, ATTENTION, PING, GET_SIGNAL_STATE, SCROLL_TO_LINE), keeps a cache of the document
// selection and pushes changes to the panel (SELECTION_UPDATE), and reports changes of the document (DOC_TYPED typing estimates; DOC_CHANGED from the
// key and input events and from an observer of the drawn page, which also sees collaborators' edits).
// Wrapped in an IIFE so that re-injection (chrome.scripting.executeScript) does not fail
// on redeclared constants.
(() => {
  // Guard against double registration: if a live instance of this same extension is
  // already running, exit. In an "orphaned" script (after the extension was reloaded)
  // chrome.runtime.id becomes undefined, and then we register again.
  try {
    if (typeof window.__gdcaAlive === 'function' && window.__gdcaAlive()) return;
  } catch (e) { /* the old context is unavailable, continue */ }
  const alive = () => {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  };
  window.__gdcaAlive = alive;

  // Zero-width characters that Docs inserts into its hidden editor.
  const ZW_RE = /[\u200B-\u200D\uFEFF]/g;

  function getDocId() {
    const m = location.pathname.match(/\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  }

  function getAuthUser() {
    const m = location.pathname.match(/\/document\/u\/(\d+)\//);
    if (m) return m[1];
    const q = new URLSearchParams(location.search).get('authuser');
    return q || null;
  }

  // Strips the " - Google Docs" suffix (also localized variants: Russian, Ukrainian, German, Spanish/Portuguese).
  const TITLE_SUFFIX_RE = new RegExp(
    '\\s*[-\u2013\u2014]\\s*Google\\s+(Docs|' +
    '\u0414\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u044b|' +
    '\u0414\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u0438|' +
    'Dokumente|Documentos)\\s*$', 'i');

  function getTitle() {
    return (document.title || '').replace(TITLE_SUFFIX_RE, '').trim();
  }

  // authuser: the Google account index to export with (default: the one of this tab).
  function exportUrl(id, format = 'txt', authuser) {
    const au = authuser != null ? authuser : getAuthUser();
    return `https://docs.google.com/document/d/${id}/export?format=${format}` + (au ? `&authuser=${au}` : '');
  }

  // The export as text. With withTitle, returns { text, title } (title from the download file name in
  // Content-Disposition when it is readable, else ''). Errors carry .network (the request itself failed,
  // e.g. a cross-origin redirect this page cannot follow), or .status and .retryAfter (an HTTP error).
  async function fetchExport(id, format, authuser, withTitle) {
    let resp;
    try {
      resp = await fetch(exportUrl(id, format, authuser), { credentials: 'include' });
    } catch (e) {
      const err = new Error(e && e.message ? e.message : String(e));
      err.network = true;
      throw err;
    }
    if (!resp.ok) {
      const err = new Error(`Document export: HTTP ${resp.status}`);
      err.status = resp.status;
      const ra = resp.headers && resp.headers.get('retry-after');
      if (ra) err.retryAfter = ra;
      throw err;
    }
    const ct = resp.headers.get('content-type') || '';
    let text = await resp.text();
    if (ct.includes('text/html') && /<html/i.test(text.slice(0, 500))) {
      throw new Error('Export returned HTML (no access or sign-in required)');
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    text = text.replace(/\r\n/g, '\n');
    return withTitle ? { text, title: fileTitle(resp.headers.get('content-disposition')) } : text;
  }

  // A network error or a rate limit (HTTP 429) on the Markdown export would hit the plain-text export too:
  // it is not tried then (that only adds requests).
  const noTextFallback = (e) => !!(e && (e.network || e.status === 429));

  function fileTitle(cd) {
    const s = String(cd || '');
    let name = '';
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(s);
    if (star) { try { name = decodeURIComponent(star[1].trim()); } catch (e) { name = star[1].trim(); } }
    else { const plain = /filename\s*=\s*"([^"]*)"/.exec(s) || /filename\s*=\s*([^;]+)/.exec(s); if (plain) name = plain[1].trim(); }
    return name.replace(/\.(md|txt)$/i, '');
  }

  // Another document (opened by the panel's open_document), exported from this page so that the
  // request is same-origin with the user's session: Markdown first, plain text as a fallback.
  // Returns { text, format, title }.
  async function getOtherDocText(id, authuser) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(id || ''))) throw new Error('Invalid document ID');
    const au = authuser != null && /^\d+$/.test(String(authuser)) ? String(authuser) : null;
    try {
      return { ...(await fetchExport(id, 'md', au, true)), format: 'markdown' };
    } catch (e) {
      if (noTextFallback(e)) throw e;
      /* no Markdown export (or no access: the plain-text export reports it) */
    }
    return { ...(await fetchExport(id, 'txt', au, true)), format: 'text' };
  }

  // The document as Markdown (headings, emphasis, lists and links survive, which the panel uses for
  // the outline and line-based reading), falling back to plain text when the Markdown export is
  // unavailable. Returns { text, format: 'markdown' | 'text', requests }; an error carries .requests too
  // (the export requests made, for the panel's self-test count).
  let markdownUnavailable = false;
  async function getDocText() {
    const id = getDocId();
    if (!id) throw new Error('Could not determine the document ID from the URL');
    let requests = 0;
    const get = (format) => { requests++; return fetchExport(id, format); };
    try {
      if (!markdownUnavailable) {
        try {
          return { text: await get('md'), format: 'markdown', requests };
        } catch (e) {
          if (noTextFallback(e)) throw e;
          // An access problem would fail the plain-text export too; anything else means no Markdown export here.
          if (!/HTML|HTTP 401|HTTP 403/.test(e.message)) markdownUnavailable = true;
        }
      }
      return { text: await get('txt'), format: 'text', requests };
    } catch (e) {
      e.requests = requests;
      throw e;
    }
  }

  // The failure fields of a GET_DOC_TEXT answer: network, status, retryAfter, requests (when known).
  function exportFailure(e) {
    const out = { ok: false, error: e && e.message ? e.message : String(e) };
    if (e && e.network) out.network = true;
    if (e && e.status) out.status = e.status;
    if (e && e.retryAfter) out.retryAfter = e.retryAfter;
    if (e && e.requests != null) out.requests = e.requests;
    return out;
  }

  function getEditorIframe() {
    return document.querySelector('iframe.docs-texteventtarget-iframe');
  }

  function clean(s) {
    return (s || '').replace(ZW_RE, '').replace(/\u00A0/g, ' ').trim();
  }

  // Reads the selection. Several strategies, each wrapped in try/catch.
  function getSelectionText() {
    let iframe, doc;
    try {
      iframe = getEditorIframe();
      doc = iframe && iframe.contentDocument;
    } catch (e) { return ''; }
    if (!doc) return '';

    // 1) Selection inside the hidden contenteditable.
    try {
      const s = clean(doc.getSelection && doc.getSelection().toString());
      if (s) return s;
    } catch (e) { /* ignore */ }

    // 2) Synthetic copy event: the Docs handler puts the selection into the clipboardData
    //    of our own DataTransfer (the real clipboard is not touched).
    try {
      const target = doc.activeElement || doc.body;
      const dt = new DataTransfer();
      const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      let s = clean(dt.getData('text/plain'));
      if (!s) {
        const html = dt.getData('text/html');
        if (html) {
          const tmp = new DOMParser().parseFromString(html, 'text/html');
          s = clean(tmp.body ? tmp.body.innerText || tmp.body.textContent : '');
        }
      }
      if (s) return s;
    } catch (e) { /* ignore */ }

    // 3) Contents of the hidden input field.
    try {
      const s = clean(doc.body && doc.body.innerText);
      if (s) return s;
    } catch (e) { /* ignore */ }
    return '';
  }

  function focusEditor(iframe) {
    try { iframe.focus(); } catch (e) { /* ignore */ }
    try { iframe.contentWindow && iframe.contentWindow.focus(); } catch (e) { /* ignore */ }
    try {
      const doc = iframe.contentDocument;
      const el = doc && (doc.querySelector('[contenteditable="true"]') || doc.body);
      if (el && el.focus) el.focus();
    } catch (e) { /* ignore */ }
  }

  // -------------------------------------------------------------------------
  // Selection cache. The panel is an iframe inside this page: clicking it moves the focus out of
  // the Docs editor, after which the copy trick above returns nothing. So the selection is
  // captured while the user is still working in the DOCUMENT (mouse release, selection keys) and
  // remembered; GET_SELECTION falls back to it. Typing in the document clears it.
  // The listeners are attached only once the panel UI (panel or round button) has been created
  // on this page, so pages where the extension is never opened are not affected.
  // -------------------------------------------------------------------------
  const CAPTURE_DELAY = 250; // ms debounce after mouseup / selection keys
  const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
  const TYPING_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab']);
  let selCache = { text: '', ts: 0 };
  let lastPushed = null; // last text sent to the panel as SELECTION_UPDATE
  let captureTimer = 0;
  let replacing = false; // guard: our own synthetic paste must not churn the cache
  let trackingEnabled = false;

  const isOwnElement = (t) => !!(t && t.closest && t.closest('[id^="munin-"]'));

  // An orphaned copy (the extension was reloaded, or a fresh copy took over) would go on reading the selection on
  // every mouse-up (a synthetic copy event in the editor) and repositioning a detached panel: its page listeners
  // come off at the first event they get (its key listeners in the editor iframe stay, returning at once). Returns
  // true when this copy is retired.
  let retired = false;
  function retireIfOrphaned() {
    if (retired) return true;
    if (window.__gdcaAlive === alive && alive()) return false;
    retired = true;
    clearTimeout(captureTimer);
    clearTimeout(changeTimer);
    clearTimeout(typedTimer);
    stopSignals();
    window.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('resize', reposition);
    if (headerObserver) headerObserver.disconnect();
    return true;
  }

  function editorHasFocus() {
    const iframe = getEditorIframe();
    return !!iframe && document.activeElement === iframe && document.hasFocus();
  }

  function setCache(text) {
    selCache = { text: text || '', ts: Date.now() };
    pushSelection();
  }

  // Captures the live selection now (only while the editor has focus, i.e. the read is reliable;
  // otherwise the cache is kept, e.g. after clicking the Docs title field or a comment box).
  function captureNow() {
    if (replacing || !editorHasFocus()) return;
    setCache(getSelectionText());
  }

  // The selection as GET_SELECTION reports it: the live read first (works while the editor has focus),
  // otherwise the remembered selection. Returns { text, cached } (text cleaned by clean()).
  function currentSelection() {
    const live = replacing ? '' : getSelectionText();
    if (live) {
      if (live !== selCache.text) setCache(live);
      return { text: live, cached: false };
    }
    return { text: selCache.text, cached: !!selCache.text };
  }

  function scheduleCapture() {
    if (replacing) return;
    clearTimeout(captureTimer);
    captureTimer = setTimeout(captureNow, CAPTURE_DELAY);
  }

  function clearCacheNow() {
    clearTimeout(captureTimer);
    if (selCache.text) setCache('');
  }

  async function pushSelection() {
    if (!host || selCache.text === lastPushed) return; // no panel yet: it reads the cache when it starts
    const text = selCache.text;
    lastPushed = text;
    const tabId = await getTabId();
    if (tabId == null) return; // the panel still reads the cache at the start of a turn
    try {
      await chrome.runtime.sendMessage({ type: 'SELECTION_UPDATE', tabId, docId: getDocId(), text });
    } catch (e) { /* no receiver / extension reloaded */ }
  }

  function onMouseUp(e) {
    if (retireIfOrphaned() || isOwnElement(e.target)) return;
    attachEditorListeners(); // the editor iframe can be recreated by Docs
    lastTypedChar = null; // the caret may have moved
    lastKeyChar = null;
    scheduleCapture();
  }

  function onKeyDown(e) {
    if (retireIfOrphaned() || isOwnElement(e.target)) return;
    countKey(e);
    // Typing in other Docs fields (title, comment box, find bar) does not touch the document
    // selection, so it must not clear the cache.
    if (e.currentTarget === document && !editorHasFocus()) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key || '';
    if (mod && !e.altKey && (key === 'a' || key === 'A')) { scheduleCapture(); return; } // select all
    // Typing (printable characters, AltGr combos included), Enter/Backspace/Delete/Tab,
    // and cut/paste replace or collapse the selection: forget it right away.
    const printable = key.length === 1 && (!mod || (e.ctrlKey && e.altKey));
    const cutPaste = mod && !e.altKey && /^[xv]$/i.test(key);
    if (printable || TYPING_KEYS.has(key) || cutPaste) {
      replacedSel = selCache.text; // what this key replaces or deletes: the typing estimate subtracts it once
      clearCacheNow();
    }
  }

  function onKeyUp(e) {
    if (retireIfOrphaned() || isOwnElement(e.target)) return;
    // Arrow/Home/End/Page keys change the selection (with Shift) or collapse it (without).
    if (NAV_KEYS.has(e.key)) { lastTypedChar = null; lastKeyChar = null; scheduleCapture(); }
  }

  // Counters of what this page delivered (GET_SIGNAL_STATE, for the self-test's report).
  const signalStats = { keydownFrame: 0, keydownPage: 0, beforeinput: 0, input: 0, mutations: 0, typedSent: 0, changedPage: 0, changedInput: 0, iframeSwaps: 0 };
  let localAt = 0; // the last key or input event of this page in the document (for DOC_CHANGED.remote)

  // Local typing: key and input events of the document. After CHANGE_QUIET of quiet, one DOC_CHANGED { source:
  // 'input' } tells the panel to re-read the document (its live document line; src/doc-live.js). The page observer
  // below is the other source (it also sees a collaborator's edits).
  const CHANGE_QUIET = 2000;
  let changeTimer = 0;
  function noteLocalChange() {
    localAt = Date.now();
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => pushDocChanged('input'), CHANGE_QUIET);
  }
  function onEditorInput(e) {
    if (retireIfOrphaned()) return;
    noteLocalChange();
    if (e) {
      if (e.type === 'beforeinput') signalStats.beforeinput++;
      else if (e.type === 'input') signalStats.input++;
      countTyped(e);
    }
  }

  // The typing estimate: the panel adds these deltas to its last exact counts at once, until its next read of the
  // document replaces them (src/doc-live.js). Two estimates per TYPED_COALESCE window: the keydown one (keys of the
  // hidden iframe's document and of the page) and the exact one of the input events (beforeinput / input, which did
  // not fire in every Chrome); when an input event was seen in the window, its lengths win and the keydown estimate
  // of that window is dropped. Paste and cut events add to either. Input events: inserted text +length, a paragraph
  // or line break +1, a deletion -1 (or the length of the selection it removes, when known). Keys: a printable key
  // +1, Enter +1, Backspace / Delete -1 (or the selection), Ctrl+V / X / Z / Y 0 (the read decides). Words: a
  // whitespace character typed after a non-space ends a word (+1); a paste adds the words of the pasted text; a
  // removed selection takes its words. Edits counted 0 still tell the panel to read soon. At most one DOC_TYPED per
  // TYPED_COALESCE ms.
  const TYPED_COALESCE = 250;
  const KEY_TWIN_MS = 15; // the same key seen in both documents within this time is one key
  const WORD_RE = /[\p{L}\p{N}]+(?:['’\-‐‑.,][\p{L}\p{N}]+)*/gu;
  const isSpace = (c) => /\s/.test(c);
  let typed = null; // { key, input, extra: { dChars, dWords }, sawInput } waiting to be sent
  let typedTimer = 0;
  let lastTypedChar = null; // the character before the caret, when the input events showed it typed
  let lastKeyChar = null; // the same for the keydown estimate
  let lastKey = { key: '', at: 0, page: false };
  let replacedSel = ''; // the selection the last typing key replaced (from the selection cache)
  let sawBeforeInput = false; // an input event after a beforeinput was counted already
  let pasteCounted = false; // a paste event was counted: its insertFromPaste input events are not

  const wordsIn = (text) => (String(text || '').match(WORD_RE) || []).length;

  function takeReplaced() {
    const sel = replacedSel;
    replacedSel = '';
    return sel ? { chars: sel.length, words: wordsIn(sel) } : null;
  }

  // kind: 'input' (input events), 'key' (the keydown estimate) or 'extra' (paste / cut events: always counted).
  function addTyped(dChars, dWords, kind = 'input') {
    if (!host) return; // no panel on this page
    if (!typed) typed = { key: { dChars: 0, dWords: 0 }, input: { dChars: 0, dWords: 0 }, extra: { dChars: 0, dWords: 0 }, sawInput: false };
    typed[kind].dChars += dChars;
    typed[kind].dWords += dWords;
    if (kind === 'input') typed.sawInput = true;
    if (!typedTimer) typedTimer = setTimeout(pushDocTyped, TYPED_COALESCE);
  }

  // Typed text: +length; each whitespace after a non-space ends a word.
  function typedText(text) {
    let words = 0;
    for (const c of text) {
      if (isSpace(c) && lastTypedChar != null && !isSpace(lastTypedChar)) words++;
      lastTypedChar = c;
    }
    return { chars: text.length, words };
  }

  const eventText = (e) => {
    if (typeof e.data === 'string' && e.data) return e.data;
    try { return (e.dataTransfer && e.dataTransfer.getData('text/plain')) || ''; } catch (err) { return ''; }
  };

  function countTyped(e) {
    if (replacing) return; // our own paste: the panel reads the document after it
    if (e.type === 'input' && sawBeforeInput) { sawBeforeInput = false; return; }
    if (e.type === 'beforeinput') sawBeforeInput = true;
    const kind = String(e.inputType || '');
    if (kind === 'insertFromPaste' && pasteCounted) { pasteCounted = false; return; }
    pasteCounted = false;
    const sel = /^(insert|delete)/.test(kind) && kind !== 'insertCompositionText' ? takeReplaced() : null;
    let dChars = sel ? -sel.chars : 0;
    let dWords = sel ? -sel.words : 0;
    if (kind === 'insertFromPaste' || kind === 'insertFromDrop' || kind === 'insertFromYank') {
      const text = eventText(e);
      dChars += text.length;
      dWords += wordsIn(text);
      lastTypedChar = null; // the pasted text's last word is counted already
    } else if (kind === 'insertParagraph' || kind === 'insertLineBreak') {
      const t = typedText('\n');
      dChars += t.chars;
      dWords += t.words;
    } else if (kind.startsWith('insert') && kind !== 'insertCompositionText') {
      const t = typedText(eventText(e));
      dChars += t.chars;
      dWords += t.words;
    } else if (kind.startsWith('delete')) {
      if (!sel) dChars -= 1;
      lastTypedChar = null;
    } else {
      lastTypedChar = null; // undo, redo, formatting: the read decides
    }
    addTyped(dChars, dWords);
  }

  // A key of the page's own document counts while the editor iframe has the focus (Docs forwarding it) or when it
  // happens in the editor area outside any text field (the title, a comment box, the find bar are not the document).
  function pageKeyInDocument(e) {
    if (editorHasFocus()) return true;
    const t = e.target;
    if (!t || !t.closest) return t === document;
    if (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return false;
    return t === document.body || !!t.closest(EDITOR_SEL);
  }

  // The keydown estimate (see above). The selection the key replaces is the one onKeyDown takes from the cache
  // (replacedSel, left for the input events, which take it).
  function countKey(e) {
    if (replacing || e.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified') return;
    const page = e.currentTarget === document;
    if (page && !pageKeyInDocument(e)) return;
    const key = e.key || '';
    const now = Date.now();
    if (key === lastKey.key && lastKey.page !== page && now - lastKey.at < KEY_TWIN_MS) return; // one key, two documents
    lastKey = { key, at: now, page };
    const mod = e.ctrlKey || e.metaKey;
    const printable = key.length === 1 && (!mod || (e.ctrlKey && e.altKey)); // AltGr combos type characters
    const editKey = mod && !e.altKey && /^[vxzy]$/i.test(key);
    if (!printable && !editKey && !TYPING_KEYS.has(key)) return;
    if (page) signalStats.keydownPage++; else signalStats.keydownFrame++;
    noteLocalChange();
    const selText = !page || editorHasFocus() ? replacedSel : '';
    const sel = selText && (printable || TYPING_KEYS.has(key)) ? { chars: selText.length, words: wordsIn(selText) } : { chars: 0, words: 0 };
    if (printable || key === 'Enter') {
      const c = key === 'Enter' ? '\n' : key;
      const word = isSpace(c) && lastKeyChar != null && !isSpace(lastKeyChar) ? 1 : 0;
      lastKeyChar = c;
      addTyped(1 - sel.chars, word - sel.words, 'key');
    } else if (key === 'Backspace' || key === 'Delete') {
      lastKeyChar = null;
      addTyped(sel.chars ? -sel.chars : -1, -sel.words, 'key');
    } else {
      lastKeyChar = null; // Tab, paste, cut, undo, redo: the read decides
      addTyped(-sel.chars, -sel.words, 'key');
    }
  }

  // A paste or cut the editor handles itself (no input events): the clipboard's text, the cut selection.
  function onEditorPaste(e) {
    if (retireIfOrphaned() || replacing) return;
    let text = '';
    try { text = (e.clipboardData && e.clipboardData.getData('text/plain')) || ''; } catch (err) { text = ''; }
    const sel = takeReplaced();
    pasteCounted = true;
    lastTypedChar = null;
    lastKeyChar = null;
    if (typed) typed.key = { dChars: 0, dWords: 0 }; // the Ctrl+V key's guess (the selection it replaces) is in here
    addTyped(text.length - (sel ? sel.chars : 0), wordsIn(text) - (sel ? sel.words : 0), 'extra');
    onEditorInput();
  }

  function onEditorCut() {
    if (retireIfOrphaned() || replacing) return;
    const sel = takeReplaced();
    lastTypedChar = null;
    lastKeyChar = null;
    if (typed) typed.key = { dChars: 0, dWords: 0 };
    addTyped(sel ? -sel.chars : 0, sel ? -sel.words : 0, 'extra');
    onEditorInput();
  }

  async function pushDocTyped() {
    typedTimer = 0;
    const t = typed;
    typed = null;
    if (!t || !host) return;
    const base = t.sawInput ? t.input : t.key;
    const dChars = base.dChars + t.extra.dChars;
    const dWords = base.dWords + t.extra.dWords;
    const tabId = await getTabId();
    if (tabId == null) return;
    signalStats.typedSent++;
    try {
      await chrome.runtime.sendMessage({ type: 'DOC_TYPED', tabId, docId: getDocId(), dChars, dWords });
    } catch (e) { /* no receiver / extension reloaded */ }
  }

  // source: 'input' (this page's key and input events) or 'page' (the observer of the drawn document); remote: a
  // page change without a key or input event of this page in the REMOTE_QUIET ms before (a collaborator, most likely).
  async function pushDocChanged(source, remote) {
    if (!host) return; // no panel on this page
    const tabId = await getTabId();
    if (tabId == null) return;
    if (source === 'page') signalStats.changedPage++; else signalStats.changedInput++;
    const msg = { type: 'DOC_CHANGED', tabId, docId: getDocId(), source };
    if (source === 'page') msg.remote = !!remote;
    try {
      await chrome.runtime.sendMessage(msg);
    } catch (e) { /* no receiver / extension reloaded */ }
  }

  // Keyboard and input events of the editor fire inside its hidden iframe, not in this document. The iframe (or its
  // document) can be replaced by Docs, and a document.open() drops its listeners: attaching again is a no-op for
  // listeners that are still there, so this runs whenever a new iframe may have appeared (the body observer, the
  // iframe's load event, every SIGNAL_RECHECK ms).
  const seenIframes = new WeakSet();
  let listenedDoc = null;
  function attachEditorListeners() {
    let f = null;
    let doc = null;
    try { f = getEditorIframe(); doc = f && f.contentDocument; } catch (e) { doc = null; }
    if (f && !seenIframes.has(f)) {
      seenIframes.add(f);
      if (listenedDoc) signalStats.iframeSwaps++;
      f.addEventListener('load', attachEditorListeners);
    }
    if (!doc) return;
    listenedDoc = doc;
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('keyup', onKeyUp, true);
    doc.addEventListener('beforeinput', onEditorInput, true);
    doc.addEventListener('input', onEditorInput, true);
    doc.addEventListener('paste', onEditorPaste, true);
    doc.addEventListener('cut', onEditorCut, true);
  }

  // -------------------------------------------------------------------------
  // The page observer: Docs draws the document in the editor container (.kix-appview-editor: the HTML rendering's
  // line views, the canvas rendering's tiles with their aria-label layer). A MutationObserver on it sees every change
  // that is drawn, the user's typing and a collaborator's alike: at most one DOC_CHANGED { source: 'page' } per
  // PAGE_CHANGE_GAP ms while the mutations go on, the last one at most PAGE_CHANGE_GAP ms after they stop.
  // Mutations of cursors and selection overlays, of the editor iframe node, within RENDER_QUIET ms after a scroll or
  // a resize (tiles being drawn) and during the panel's own paste (and PASTE_TAIL ms after it) are not counted; what
  // slips through only costs the panel a revision check (its reads have a floor).
  // -------------------------------------------------------------------------
  const EDITOR_SEL = '.kix-appview-editor';
  const PAGE_CHANGE_GAP = 1000;
  const RENDER_QUIET = 500;
  const PASTE_TAIL = 1000;
  const REMOTE_QUIET = 2000;
  const SIGNAL_RECHECK = 3000; // the iframe listeners and the observed container are checked this often
  const IGNORED_SEL = '.kix-cursor, .kix-selection-overlay, [id^="munin-"]';
  let pageObserver = null;
  let observedEditor = null;
  let pageTimer = 0;
  let renderUntil = 0;
  let pasteEndAt = 0;
  let bodyObserver = null;
  let recheckTimer = 0;

  function ignoredNode(n) {
    const elOf = n && (n.nodeType === 1 ? n : n.parentElement);
    return !elOf || elOf.nodeName === 'IFRAME' || !!(elOf.closest && elOf.closest(IGNORED_SEL));
  }
  function countsAsChange(r) {
    if (r.type !== 'childList') return !ignoredNode(r.target);
    const nodes = [...r.addedNodes, ...r.removedNodes];
    return nodes.length ? nodes.some((n) => !ignoredNode(n) && !ignoredNode(r.target)) : false;
  }
  function onPageMutations(records) {
    if (retireIfOrphaned()) return;
    const now = Date.now();
    if (replacing || now < renderUntil || now < pasteEndAt + PASTE_TAIL) return;
    if (!records.some(countsAsChange)) return;
    signalStats.mutations++;
    if (!pageTimer) pageTimer = setTimeout(pushPageChanged, PAGE_CHANGE_GAP);
  }
  function pushPageChanged() {
    pageTimer = 0;
    if (replacing) return;
    pushDocChanged('page', Date.now() - localAt > REMOTE_QUIET);
  }
  const onRenderEvent = () => { renderUntil = Date.now() + RENDER_QUIET; };

  // Observes the editor container; found again when Docs replaced it.
  function observePage() {
    const node = document.querySelector(EDITOR_SEL);
    if (node && node === observedEditor) return;
    if (pageObserver) pageObserver.disconnect();
    observedEditor = node;
    if (!node || typeof MutationObserver !== 'function') return;
    if (!pageObserver) pageObserver = new MutationObserver(onPageMutations);
    pageObserver.observe(node, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
  }

  // New iframe nodes anywhere in the page: attach to the editor iframe again.
  function onBodyMutations(records) {
    if (retireIfOrphaned()) return;
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && (n.nodeName === 'IFRAME' || (n.getElementsByTagName && n.getElementsByTagName('iframe').length))) {
          attachEditorListeners();
          observePage();
          return;
        }
      }
    }
  }

  function startSignals() {
    attachEditorListeners();
    observePage();
    document.addEventListener('scroll', onRenderEvent, true);
    window.addEventListener('resize', onRenderEvent);
    if (typeof MutationObserver === 'function' && document.body) {
      bodyObserver = new MutationObserver(onBodyMutations);
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
    recheckTimer = setInterval(() => { if (!retireIfOrphaned()) { attachEditorListeners(); observePage(); } }, SIGNAL_RECHECK);
  }

  function stopSignals() {
    clearTimeout(pageTimer);
    clearInterval(recheckTimer);
    if (pageObserver) pageObserver.disconnect();
    if (bodyObserver) bodyObserver.disconnect();
    document.removeEventListener('scroll', onRenderEvent, true);
    window.removeEventListener('resize', onRenderEvent);
  }

  // GET_SIGNAL_STATE: what the change signal found on this page (the self-test's "Change signal" row).
  function signalState() {
    let iframe = null;
    let doc = null;
    try { iframe = getEditorIframe(); doc = iframe && iframe.contentDocument; } catch (e) { doc = null; }
    return {
      ok: true, tracking: trackingEnabled, panel: !!host,
      editor: !!(observedEditor && observedEditor.isConnected), editorSelector: EDITOR_SEL, observing: !!(pageObserver && observedEditor),
      iframe: !!iframe, iframeDoc: !!doc, listening: !!doc && doc === listenedDoc,
      stats: { ...signalStats },
    };
  }

  function enableSelectionTracking() {
    if (trackingEnabled) return;
    trackingEnabled = true;
    window.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    startSignals();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // -------------------------------------------------------------------------
  // Inserting text into the document (replacing the selection).
  // 1. The focus is returned to the Docs editor and we WAIT until it has really landed.
  // 2. ONE synthetic "paste" event is dispatched, on the editor's active element when it is an element of the
  //    hidden iframe, else on its body (a dispatch on the iframe document does nothing in Chrome). Nothing is
  //    ever dispatched a second time and there is no execCommand / textInput fallback after it: Docs inserts a
  //    synthetic paste on the editable without calling preventDefault and without any DOM or getData trace
  //    we can see (it renders on a canvas, a moment later), so every further attempt inserted another copy
  //    (seen in Chrome: the paragraph three times on one line, while the content script reported a failure).
  //    The result is { ok: true, verified, attempts: 1 }: verified when Docs called preventDefault, or (extra
  //    evidence only, never a reason to dispatch again) the editor iframe changed or the handler read the
  //    pasted text. Unverified is still ok: the panel re-reads the document instead of copying to the clipboard.
  //    Only a failure before the dispatch (no editor, no focus) or a dispatch that throws is { ok: false }.
  // Calls are queued: a second REPLACE_SELECTION waits for the first one to finish.
  // -------------------------------------------------------------------------
  const FOCUS_POLL_MS = 50;
  const FOCUS_TIMEOUT_MS = 600;
  const PASTE_SETTLE_MS = 40; // after a dispatch without preventDefault: time for a handler that changes the editor a moment later
  const PASTE_UNVERIFIED = ''; // no detail line for the normal case: Docs never confirms a synthetic paste
  let replaceQueue = Promise.resolve();

  function editorFocused(iframe, doc) {
    try {
      if (document.activeElement !== iframe || !doc.hasFocus()) return false;
      const a = doc.activeElement;
      return !!a && (a === doc.body || a.isContentEditable || (a.getAttribute && a.getAttribute('contenteditable') === 'true'));
    } catch (e) {
      return false;
    }
  }

  // Focuses the editor and polls until the focus is verified (or the timeout passes).
  async function focusEditorVerified(iframe, doc) {
    const deadline = Date.now() + FOCUS_TIMEOUT_MS;
    let lastFocusCall = 0;
    while (Date.now() <= deadline) {
      if (editorFocused(iframe, doc)) return true;
      if (Date.now() - lastFocusCall >= 150) { focusEditor(iframe); lastFocusCall = Date.now(); }
      await sleep(FOCUS_POLL_MS);
    }
    return editorFocused(iframe, doc);
  }

  // The one paste target: the editor's active element when it is an element of the hidden iframe (the
  // editable Docs listens on), else its body. Never the iframe document: a paste dispatched there does nothing.
  function pasteTarget(doc) {
    const a = doc.activeElement;
    if (a && a.nodeType === 1 && a.ownerDocument === doc) return a;
    return doc.body || null;
  }

  // Watches the editor iframe for a trace of an insertion attempt, from just before it until changed()
  // is asked. Why these signals: the iframe is the only part of the editor this script reads (see
  // getSelectionText), and it is Docs' input sink: the hidden contenteditable that receives the typing,
  // the paste and the copy, and that Docs fills with the selected text and empties or rewrites when it
  // takes an input. Nothing else touches it while an attempt runs (the `replacing` guard holds our own
  // selection tracking back), so ANY change there right after our attempt is Docs reacting to it:
  //  - DOM mutations of the iframe document (childList / characterData, attributes ignored: focus and
  //    ARIA updates are not insertions), read synchronously with takeRecords();
  //  - its text (body.textContent) or its selection text differing from before the attempt.
  // This is only asked when the dispatch did NOT report preventDefault, and only as extra evidence for
  // "verified": the paste is never dispatched again, whatever it says.
  function watchEditor(doc) {
    const textNow = () => { try { return (doc.body && doc.body.textContent) || ''; } catch (e) { return ''; } };
    const selNow = () => { try { return doc.getSelection ? String(doc.getSelection()) : ''; } catch (e) { return ''; } };
    const text0 = textNow();
    const sel0 = selNow();
    let mutations = 0;
    let observer = null;
    try {
      observer = new MutationObserver((records) => { mutations += records.length; });
      observer.observe(doc.documentElement || doc, { subtree: true, childList: true, characterData: true });
    } catch (e) { observer = null; }
    return {
      changed() {
        if (observer) { try { mutations += observer.takeRecords().length; } catch (e) { /* ignore */ } }
        return mutations > 0 || textNow() !== text0 || selNow() !== sel0;
      },
      stop() { if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } } },
    };
  }

  // Counts the reads of the pasted text by the page's paste handler (getData of text/plain returning it):
  // a handler that reads the clipboard data of a paste event is taking that paste.
  function countReads(dt, onRead) {
    if (!dt || typeof dt.getData !== 'function') return;
    const getData = dt.getData;
    try {
      Object.defineProperty(dt, 'getData', {
        configurable: true,
        value: function (type) { const v = getData.call(dt, type); if (v) onRead(); return v; },
      });
    } catch (e) { /* the read signal is then not available; the editor watch still is */ }
  }

  // Dispatches one synthetic paste on target. Returns { prevented (Docs called preventDefault), read (the
  // handler read the pasted text) }.
  function tryPaste(target, text) {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    let read = false;
    countReads(dt, () => { read = true; });
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    if (ev.clipboardData && ev.clipboardData !== dt) countReads(ev.clipboardData, () => { read = true; });
    target.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented === true, read };
  }

  const errText = (e) => (e && e.message ? e.message : String(e));

  async function insertText(text) {
    const iframe = getEditorIframe();
    if (!iframe) return { ok: false, error: 'Google Docs editor not found (iframe.docs-texteventtarget-iframe)', attempts: 0 };
    let doc;
    try { doc = iframe.contentDocument; } catch (e) { doc = null; }
    if (!doc) return { ok: false, error: 'No access to the editor contentDocument', attempts: 0 };

    if (!(await focusEditorVerified(iframe, doc))) return { ok: false, error: 'Could not focus the Docs editor', attempts: 0 };
    const target = pasteTarget(doc);
    if (!target) return { ok: false, error: 'The Docs editor has nothing to paste into', attempts: 0 };

    // The one dispatch, under watch. The watch only decides "verified"; it never leads to another attempt.
    const watch = watchEditor(doc);
    let p;
    try {
      p = tryPaste(target, text);
    } catch (e) {
      watch.stop();
      return { ok: false, error: 'paste event failed (' + errText(e) + ')', attempts: 1 };
    }
    let verified = p.prevented;
    try {
      if (!verified) verified = watch.changed() || p.read;
      if (!verified) { await sleep(PASTE_SETTLE_MS); verified = watch.changed(); }
    } finally {
      watch.stop();
    }
    return { ok: true, method: 'paste', verified, attempts: 1, detail: verified ? 'inserted via paste event' : PASTE_UNVERIFIED };
  }

  // Replaces the selection. The whole sequence (up to ~1.5 s) runs under the `replacing` guard,
  // and calls are serialized. Returns {ok, method?, detail?} or {ok: false, error, reason?}.
  // expected: the selection the panel's model saw. When it is non-empty and the current selection (read
  // as GET_SELECTION reads it, same cleaning) differs, nothing is pasted: {ok: false, reason:
  // 'selection-changed'}. Without it the text goes wherever the cursor is, as before.
  function replaceSelection(text, expected) {
    const run = replaceQueue.then(() => replaceSelectionNow(text, expected));
    replaceQueue = run.catch(() => {});
    return run;
  }

  async function replaceSelectionNow(text, expected) {
    if (typeof text !== 'string') return { ok: false, error: 'No text to paste' };
    const want = typeof expected === 'string' ? clean(expected) : '';
    if (want && currentSelection().text !== want) {
      return { ok: false, reason: 'selection-changed', error: 'the selection changed while the answer was being generated' };
    }
    replacing = true;
    clearTimeout(captureTimer); // a pending capture must not run in the middle of the insertion
    let result;
    try {
      result = await insertText(text);
    } catch (e) {
      result = { ok: false, error: 'Insertion failed: ' + (e && e.message ? e.message : String(e)) };
    } finally {
      replacing = false;
      pasteEndAt = Date.now(); // the page observer leaves the paste's drawing alone (PASTE_TAIL)
    }
    if (result.ok) {
      clearTimeout(captureTimer);
      selCache = { text: '', ts: Date.now() }; // the selection was replaced
      pushSelection();
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // In-page panel host: a fixed container on the right, below the Docs header, holding an
  // iframe of the extension's sidepanel.html. Collapsing hides the container and shows a small round
  // raven button. Toggled by: the toolbar icon (TOGGLE_PANEL from background.js), the raven in the
  // panel header (COLLAPSE_PANEL sent by the iframe via chrome.tabs.sendMessage), and the round button.
  // The open state is saved in chrome.storage.local; so is the width set with the grip on the panel's
  // left edge.
  // -------------------------------------------------------------------------
  const PANEL_KEY = 'muninPanelOpen';
  const WIDTH_KEY = 'muninPanelWidth'; // PANEL_WIDTH_KEY in src/constants.js
  const DEFAULT_WIDTH = 400; // px; never wider than 90% of a narrow viewport
  const MIN_WIDTH = 280;
  const MAX_WIDTH_SHARE = 0.7; // of the viewport width
  const FAB_LABEL = 'Munin: show the panel';
  const HOST_ID = 'munin-panel-host';
  const FAB_ID = 'munin-panel-fab';
  const PANEL_GAP = 8; // px between the Docs header and the panel
  const FALLBACK_HEADER_BOTTOM = 112;
  let host = null;
  let fab = null;
  let panelOpen = false;
  let panelWidth = null; // px set with the grip; null: the default
  // ATTENTION from the panel: a permission card waits for the user. Shown as a dot on the round button,
  // which is visible only while the panel is collapsed (an open panel shows the card itself).
  let attention = false;
  let fabDot = null;
  function renderAttention() {
    if (!fab || !fabDot) return;
    const waiting = attention && !panelOpen;
    fabDot.style.display = waiting ? 'block' : 'none';
    const label = waiting ? 'Munin Assistant is waiting for your decision' : FAB_LABEL;
    fab.title = label;
    fab.setAttribute('aria-label', label);
  }
  let tabIdPromise = null;
  let headerObserver = null;
  let observedHeader = null;

  // Leftovers from an orphaned instance (after the extension was reloaded) are removed.
  for (const id of [HOST_ID, FAB_ID]) document.getElementById(id)?.remove();

  function getTabId() {
    if (!tabIdPromise) {
      tabIdPromise = chrome.runtime.sendMessage({ type: 'GET_TAB_ID' })
        .then((r) => (r && r.tabId != null ? r.tabId : null))
        .catch(() => null);
    }
    return tabIdPromise;
  }

  function getHeaderEl() {
    return document.getElementById('docs-chrome') ||
      document.getElementById('docs-toolbar-wrapper') ||
      document.querySelector('.docs-toolbar-wrapper, #docs-toolbar');
  }

  function panelTop() {
    const h = getHeaderEl();
    if (h) {
      const r = h.getBoundingClientRect();
      if (r.height > 0 && r.bottom > 0) return Math.round(r.bottom) + PANEL_GAP;
    }
    return FALLBACK_HEADER_BOTTOM + PANEL_GAP;
  }

  // The width actually used: the stored one clamped to the current viewport, or the default.
  function currentWidth() {
    const vw = window.innerWidth || 1024;
    if (panelWidth == null) return Math.round(Math.min(DEFAULT_WIDTH, vw * 0.9));
    return Math.round(Math.max(MIN_WIDTH, Math.min(panelWidth, vw * MAX_WIDTH_SHARE)));
  }

  function applyWidth() {
    if (host) host.style.width = currentWidth() + 'px';
  }

  // Nothing to place before the panel or its round button exists (most Docs pages never open it).
  function reposition() {
    if (retireIfOrphaned() || (!host && !fab)) return;
    const top = panelTop() + 'px';
    if (host) host.style.top = top;
    if (fab) fab.style.top = top;
    applyWidth();
    // The header element can be replaced by Docs; keep observing the current one.
    const h = getHeaderEl();
    if (h !== observedHeader && typeof ResizeObserver === 'function') {
      if (!headerObserver) headerObserver = new ResizeObserver(() => reposition());
      if (observedHeader) headerObserver.unobserve(observedHeader);
      if (h) headerObserver.observe(h);
      observedHeader = h;
    }
  }

  // Concurrent callers (restore on load + TOGGLE_PANEL, fast double clicks) share one creation,
  // otherwise each would await getTabId() and append its own panel.
  let hostPromise = null;
  function ensureHost() {
    if (host && host.isConnected) return Promise.resolve(host);
    if (!hostPromise) hostPromise = createHost().finally(() => { hostPromise = null; });
    return hostPromise;
  }

  async function readWidth() {
    try {
      const w = (await chrome.storage.local.get(WIDTH_KEY))[WIDTH_KEY];
      return Number.isFinite(w) && w > 0 ? w : null;
    } catch (e) { return null; }
  }

  async function createHost() {
    const [tabId, savedWidth] = await Promise.all([getTabId(), readWidth()]);
    if (host && host.isConnected) return host;
    // The stored width is applied before the panel is shown, so it does not jump.
    panelWidth = savedWidth;
    host = document.createElement('div');
    host.id = HOST_ID;
    Object.assign(host.style, {
      position: 'fixed', right: '0', bottom: '0', top: panelTop() + 'px',
      width: currentWidth() + 'px', zIndex: '2147483000', display: 'none',
      background: '#0e1116', borderLeft: '1px solid #2d333d', borderTop: '1px solid #2d333d',
      borderTopLeftRadius: '10px', boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.35)',
      overflow: 'hidden', boxSizing: 'border-box',
    });
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('sidepanel.html') + (tabId != null ? '#tabId=' + tabId : '');
    iframe.title = 'Munin Assistant';
    iframe.allow = 'clipboard-write';
    Object.assign(iframe.style, {
      width: '100%', height: '100%', border: '0', display: 'block', background: '#0e1116',
    });
    host.appendChild(iframe);
    host.appendChild(createGrip(iframe));
    document.body.appendChild(host);
    enableSelectionTracking();
    return host;
  }

  // The resize handle on the panel's left edge, above the iframe. The transparent border widens the
  // hit area beyond the visible 6 px bar. Dragging left widens the panel; double-click resets it.
  function createGrip(iframe) {
    const grip = document.createElement('div');
    grip.className = 'munin-panel-grip';
    grip.title = 'Drag to resize; double-click to reset';
    const idle = 'rgba(128, 128, 128, 0.55)';
    Object.assign(grip.style, {
      position: 'absolute', left: '0', top: '50%', transform: 'translateY(-50%)', width: '6px', height: '48px',
      border: '4px solid transparent', borderRadius: '7px', backgroundColor: idle, backgroundClip: 'padding-box',
      cursor: 'ew-resize', touchAction: 'none', zIndex: '1',
    });
    let drag = null; // { id, x, w, moved } while dragging
    const hover = (on) => { grip.style.backgroundColor = on || drag ? 'rgba(128, 128, 128, 0.85)' : idle; };
    grip.addEventListener('pointerenter', () => hover(true));
    grip.addEventListener('pointerleave', () => hover(false));
    // Docs' document-level handlers must not see the drag, and no text gets selected.
    grip.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); });
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      drag = { id: e.pointerId, x: e.clientX, w: currentWidth(), moved: false };
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* capture is best effort */ }
      // Over the iframe the pointer events would go to the panel document and the drag would stall.
      iframe.style.pointerEvents = 'none';
      hover(true);
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      panelWidth = drag.w + (drag.x - e.clientX);
      panelWidth = currentWidth(); // kept clamped
      drag.moved = true;
      applyWidth();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { moved } = drag;
      drag = null;
      iframe.style.pointerEvents = '';
      try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
      hover(false);
      if (moved) try { chrome.storage.local.set({ [WIDTH_KEY]: panelWidth }); } catch (err) { /* context gone */ }
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      panelWidth = null;
      applyWidth();
      try { chrome.storage.local.remove(WIDTH_KEY); } catch (err) { /* context gone */ }
    });
    return grip;
  }

  function ensureFab() {
    if (fab && fab.isConnected) return fab;
    fab = document.createElement('button');
    fab.id = FAB_ID;
    fab.type = 'button';
    Object.assign(fab.style, {
      position: 'fixed', right: '16px', top: panelTop() + 'px', width: '36px', height: '36px',
      padding: '0', margin: '0', borderRadius: '50%', border: '1px solid #2d333d',
      background: '#0e1116', boxShadow: '0 2px 10px rgba(0, 0, 0, 0.35)', cursor: 'pointer',
      display: 'none', alignItems: 'center', justifyContent: 'center', zIndex: '2147483001',
    });
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/icon48-dark.png');
    img.alt = '';
    img.width = 22;
    img.height = 22;
    Object.assign(img.style, { width: '22px', height: '22px', display: 'block', pointerEvents: 'none' });
    fab.appendChild(img);
    fabDot = document.createElement('span'); // the attention dot (see renderAttention)
    Object.assign(fabDot.style, {
      position: 'absolute', top: '-2px', right: '-2px', width: '10px', height: '10px', borderRadius: '50%',
      background: '#f5a623', border: '2px solid #0e1116', boxSizing: 'border-box', display: 'none', pointerEvents: 'none',
    });
    fab.appendChild(fabDot);
    renderAttention();
    // Keep Docs' document-level mouse handlers from reacting to clicks on the button, and keep the
    // focus in the editor (preventDefault) so the selection can still be read. The selection is
    // captured here, before the panel opens and the user clicks into it.
    fab.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); captureNow(); });
    fab.addEventListener('click', (e) => { e.stopPropagation(); setPanelOpen(true); });
    document.body.appendChild(fab);
    enableSelectionTracking();
    return fab;
  }

  let userActed = false; // a user action wins over the (asynchronous) state restore on load

  async function setPanelOpen(open, persist = true) {
    panelOpen = !!open;
    if (persist) userActed = true;
    try {
      if (panelOpen) await ensureHost();
      // Apply the latest requested state (it may have changed while the host was being created),
      // so the panel and the round button are never visible together.
      if (panelOpen) {
        if (host) host.style.display = 'block';
        if (fab) fab.style.display = 'none';
      } else {
        if (host) host.style.display = 'none';
        ensureFab().style.display = 'flex';
      }
      renderAttention();
      reposition();
    } catch (e) { /* extension context gone (reloaded); ignore */ }
    if (persist) {
      try { await chrome.storage.local.set({ [PANEL_KEY]: panelOpen }); } catch (e) { /* ignore */ }
    }
  }

  window.addEventListener('resize', reposition);

  // Restore the last state: open -> create the panel; collapsed -> show only the round button.
  (async () => {
    let saved;
    try { saved = (await chrome.storage.local.get(PANEL_KEY))[PANEL_KEY]; } catch (e) { return; }
    if (userActed) { /* e.g. the toolbar icon was clicked right after injection */ }
    else if (saved === true) await setPanelOpen(true, false);
    else if (saved === false) await setPanelOpen(false, false);
    // The Docs header may still be settling after load.
    setTimeout(reposition, 1500);
  })();

  // -------------------------------------------------------------------------
  // SCROLL_TO_LINE { line, text, of }: bring a document line into view. Docs draws the text on a canvas, so there is
  // nothing to address by line number; what the page exposes is searched by the line's text instead (its first
  // LINE_PROBE_CHARS characters, normalized): the HTML rendering's line views (.kix-lineview, one per visual line) and,
  // in the canvas rendering, the accessibility layer Docs draws over the tiles (SVG groups and rects whose aria-label
  // holds the text). Only the pages near the viewport are drawn: when nothing matches, the editor is first scrolled
  // to about line / of of its height, and the search is repeated once the tiles had time to draw; a miss restores the
  // scroll position. A match is scrolled to the middle and outlined for a moment (selecting it would need synthetic
  // clicks in the editor, which Docs does not trust).
  // -------------------------------------------------------------------------
  const LINE_PROBE_CHARS = 40;
  const LINE_DRAW_WAIT = 450; // ms for the tiles of a new scroll position to draw
  const LINE_FLASH_MS = 1600;
  const probeText = (s) => clean(s).replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”«»„]/g, '"').replace(/[–—]/g, '-').toLowerCase();
  function lineCandidates() {
    const root = document.querySelector('.kix-appview-editor') || document.body;
    const out = [];
    for (const node of root.querySelectorAll('.kix-lineview')) out.push({ node, text: node.textContent || '', how: 'lineview' });
    for (const g of root.querySelectorAll('.kix-canvas-tile-content g[role="paragraph"]')) {
      const parts = [...g.querySelectorAll('[aria-label]')].map((r) => r.getAttribute('aria-label') || '');
      out.push({ node: g, text: parts.join(' ') || g.getAttribute('aria-label') || '', how: 'aria-paragraph' });
    }
    if (!out.length) {
      for (const node of root.querySelectorAll('.kix-canvas-tile-content [aria-label], .kix-page [aria-label]')) out.push({ node, text: node.getAttribute('aria-label') || '', how: 'aria-label' });
    }
    return out;
  }
  const scroller = () => document.querySelector('.kix-appview-editor');
  // The best candidate for the probe: its text contains the probe, or it is the start of the probe (a wrapped
  // paragraph drawn as several visual lines); several matches: the one nearest the expected position.
  function findLine(probe, ratio) {
    const hits = lineCandidates().filter((c) => {
      const t = probeText(c.text);
      return t && (t.includes(probe) || (t.length >= 12 && probe.startsWith(t)));
    });
    if (hits.length < 2 || ratio == null) return hits[0] || null;
    const sc = scroller();
    const want = sc ? ratio * sc.scrollHeight : 0;
    const top = (c) => { try { return c.node.getBoundingClientRect().top + (sc ? sc.scrollTop : 0); } catch (e) { return 0; } };
    return hits.reduce((a, b) => (Math.abs(top(b) - want) < Math.abs(top(a) - want) ? b : a));
  }
  function flashLine(node) {
    try {
      const r = node.getBoundingClientRect();
      if (!r || (!r.width && !r.height)) return;
      const box = document.createElement('div');
      box.id = 'munin-line-flash';
      box.style.cssText = `position:fixed;left:${r.left - 3}px;top:${r.top - 2}px;width:${r.width + 6}px;height:${r.height + 4}px;` +
        'border:2px solid #8b7ff5;border-radius:4px;background:rgba(139,127,245,0.12);pointer-events:none;z-index:2147483646;transition:opacity .4s';
      document.getElementById('munin-line-flash')?.remove();
      document.body.appendChild(box);
      setTimeout(() => { box.style.opacity = '0'; setTimeout(() => box.remove(), 450); }, LINE_FLASH_MS);
    } catch (e) { /* ignore */ }
  }
  function showLine(hit) {
    console.debug('Munin: line found via', hit.how); // for real-Chrome reports (the page console, Verbose level)
    if (typeof hit.node.scrollIntoView === 'function') hit.node.scrollIntoView({ block: 'center' });
    setTimeout(() => flashLine(hit.node), 60);
    return { ok: true, how: hit.how, selected: false };
  }
  async function scrollToLine(msg) {
    const probe = probeText(msg.text).slice(0, LINE_PROBE_CHARS);
    if (probe.length < 3) return { ok: false, reason: 'no-text' };
    const ratio = msg.of > 1 && msg.line > 0 ? Math.min(1, (msg.line - 1) / msg.of) : null;
    let hit = findLine(probe, ratio);
    if (hit) return showLine(hit);
    const sc = scroller();
    if (!sc || ratio == null) return { ok: false, reason: 'not-found' };
    const before = sc.scrollTop;
    sc.scrollTop = Math.max(0, ratio * (sc.scrollHeight - sc.clientHeight));
    await new Promise((r) => setTimeout(r, LINE_DRAW_WAIT));
    hit = findLine(probe, ratio);
    if (hit) return showLine(hit);
    sc.scrollTop = before;
    return { ok: false, reason: 'not-found' };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    switch (msg.type) {
      case 'TOGGLE_PANEL':
        // The toolbar icon does not move the page focus: capture the selection before opening.
        if (!panelOpen) captureNow();
        setPanelOpen(!panelOpen).then(() => sendResponse({ ok: true, open: panelOpen }));
        return true;
      case 'COLLAPSE_PANEL':
        setPanelOpen(false).then(() => sendResponse({ ok: true, open: false }));
        return true;
      case 'PING':
        sendResponse({ ok: true, docId: getDocId(), title: getTitle() });
        return false;
      case 'GET_SIGNAL_STATE':
        sendResponse(signalState());
        return false;
      case 'GET_SELECTION': {
        const { text, cached } = currentSelection();
        sendResponse(cached ? { ok: true, text, cached: true } : { ok: true, text });
        return false;
      }
      case 'ATTENTION':
        // A permission card waits in the panel (pending) or was decided: the dot on the round button.
        attention = !!msg.pending;
        renderAttention();
        sendResponse({ ok: true });
        return false;
      case 'REPLACE_SELECTION':
        // Exactly one response: replaceSelection never rejects (errors become {ok: false}),
        // and the rejection handler is only a safety net.
        replaceSelection(msg.text, msg.expected).then(sendResponse,
          (e) => sendResponse({ ok: false, error: 'Insertion failed: ' + (e && e.message ? e.message : String(e)) }));
        return true; // asynchronous response
      case 'SCROLL_TO_LINE':
        scrollToLine(msg || {}).then(sendResponse, (e) => sendResponse({ ok: false, reason: 'error', error: e && e.message ? e.message : String(e) }));
        return true; // asynchronous response
      case 'GET_DOC_TEXT':
        // With docId (another document, for the panel's open_document): that document's export.
        if (msg.docId && msg.docId !== getDocId()) {
          getOtherDocText(msg.docId, msg.authuser)
            .then(({ text, format, title }) => sendResponse({ ok: true, text, format, title, docId: msg.docId }))
            .catch((e) => sendResponse({ ...exportFailure(e), docId: msg.docId }));
          return true; // asynchronous response
        }
        getDocText()
          .then(({ text, format, requests }) => sendResponse({ ok: true, text, format, requests, docId: getDocId(), title: getTitle() }))
          .catch((e) => sendResponse({ ...exportFailure(e), docId: getDocId(), title: getTitle() }));
        return true; // asynchronous response
      default:
        return false;
    }
  });
})();
