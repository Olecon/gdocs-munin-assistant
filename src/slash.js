'use strict';
// Module slash.js: slash commands: parseSlashCommand and the autocomplete popup (updatePopup,
// handlePopupKey, bindPopup), which also lists Zotero items for "@smi" with the References grant (references.js; without it the chat asks once).
/* global activeProvider, COMMAND_RE, el, PERSONAS, zoteroAtReady, SELFTEST_COMMANDS, SELFTEST_RE, SIDE_COMMANDS, SIDE_RE, updateActionState,
   zoteroPickItems, zoteroToken */
/* exported parseSlashCommand, positionPopup, closePopup, handlePopupKey, bindPopup, toggleCommandList, CHECK_COMMANDS,
   commandUnavailable, MUNIN_ONLY_NOTICE */

// The built-in pre-submission report (not a persona): /check runs the deterministic checks on the open document
// without a model call (runCheck in src/check.js); anything typed after it is ignored.
const CHECK_COMMANDS = {
  check: { emoji: '☑️', desc: 'Pre-submission report: acronyms, figures, citations, budgets, placeholders; no model call' },
};
const CHECK_RE = /^\/check(?=\s|$)/i;

// A command of PERSONAS with muninOnly (/code) needs the Munin provider (PROVIDERS[…].personas). commandUnavailable
// gives the popup row's note ('' when the command works now); a typed one is refused with MUNIN_ONLY_NOTICE (startTurn).
const MUNIN_ONLY_NOTE = 'Munin only';
const MUNIN_ONLY_NOTICE = (name) => `/${name} works with the Munin provider only. Switch the provider in the settings or use /chat.`;
function commandUnavailable(name) {
  const p = PERSONAS[name];
  return p && p.muninOnly && !activeProvider().personas ? MUNIN_ONLY_NOTE : '';
}

// Parses a slash command at the start of the message (leading whitespace ignored, case-insensitive,
// the command must be followed by whitespace or the end). Returns { persona, text }; persona is null
// when there is no known command (unknown "/words" are sent as ordinary text). The built-in /test
// (SELFTEST_RE) gives { persona: null, selftest: true, text: '' } (anything typed after it is ignored); the
// built-in /side (SIDE_RE) gives { persona: null, side: true, text } (the side question, '' when none); /check (CHECK_RE)
// gives { persona: null, check: true, text: '' }.
function parseSlashCommand(raw) {
  const s = String(raw || '').replace(/^\s+/, '');
  if (SELFTEST_RE.test(s)) return { persona: null, selftest: true, text: '' };
  if (CHECK_RE.test(s)) return { persona: null, check: true, text: '' };
  const side = SIDE_RE.exec(s);
  if (side) return { persona: null, side: true, text: s.slice(side[0].length).trim() };
  const m = COMMAND_RE.exec(s);
  if (!m) return { persona: null, text: String(raw || '').trim() };
  const persona = m[1].toLowerCase();
  // A bare command with a default message ("/review") sends that message.
  return { persona, text: s.slice(m[0].length).trim() || (PERSONAS[persona] && PERSONAS[persona].defaultText) || '' };
}

// ---------------------------------------------------------------------------
// Slash-command autocomplete popup
// ---------------------------------------------------------------------------
// Shown while the input starts with "/" and the caret is inside that first token, or (kind 'zotero') while the caret
// ends "@" plus 2+ letters with the References grant (zoteroAtReady asks for it once per panel load). Everything works by mouse (a click on a row picks it); while it is
// open, ArrowUp/ArrowDown move the highlight (wrapping), Enter/Tab insert the highlighted entry (without sending),
// Escape closes it. The [/] button (toggleCommandList) opens the full command list without a "/" typed: it stays
// open (pinned) until the input text changes, a pick, Escape, a second click or the input losing the focus.
const popup = { open: false, kind: 'cmd', items: [], index: 0, at: null, pinned: null };

function commandToken(value) {
  const m = /^\/\S*/.exec(value);
  return m ? m[0] : null;
}

function updatePopup() {
  const v = el.input.value;
  if (popup.pinned != null) {
    if (popup.open && v === popup.pinned) return; // a caret move or a click in the input keeps the list
    popup.pinned = null;
  }
  const token = commandToken(v);
  const caret = el.input.selectionStart;
  if (token == null || el.input.selectionStart !== el.input.selectionEnd || caret < 1 || caret > token.length) {
    updateZoteroPopup();
    return;
  }
  popup.kind = 'cmd';
  const prefix = token.slice(1).toLowerCase();
  const items = popupNames().filter((name) => name.startsWith(prefix));
  if (!items.length) { closePopup(); return; }
  const current = popup.open ? popup.items[popup.index] : null;
  popup.items = items;
  popup.index = items.indexOf(current) >= 0 ? items.indexOf(current) : firstEnabled(items);
  popup.open = true;
  renderPopup();
}

// The popup lists the personas, then the built-in /side, /check and /test commands.
const popupNames = () => [...Object.keys(PERSONAS), ...Object.keys(SIDE_COMMANDS), ...Object.keys(CHECK_COMMANDS), ...Object.keys(SELFTEST_COMMANDS)];
// The first row that can be picked (a dimmed /code is skipped by the highlight).
const firstEnabled = (items) => Math.max(0, items.findIndex((name) => !commandUnavailable(name)));
const popupEntry = (name) => PERSONAS[name] || SIDE_COMMANDS[name] || CHECK_COMMANDS[name] || SELFTEST_COMMANDS[name];

function renderPopup() {
  const box = el.cmdPopup;
  box.textContent = '';
  box.setAttribute('aria-label', popup.kind === 'zotero' ? 'Zotero items' : 'Slash commands');
  if (popup.kind === 'zotero') { renderZoteroRows(box); return; }
  popup.items.forEach((name, i) => {
    const p = popupEntry(name);
    const note = commandUnavailable(name);
    const row = document.createElement('div');
    row.className = 'cmd-row' + (note ? ' disabled' : i === popup.index ? ' active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(!note && i === popup.index));
    if (note) row.setAttribute('aria-disabled', 'true');
    row.dataset.idx = String(i);
    const emoji = document.createElement('span');
    emoji.className = 'cmd-emoji';
    emoji.textContent = p.emoji;
    const cmd = document.createElement('span');
    cmd.className = 'cmd-name';
    cmd.textContent = '/' + name;
    const desc = document.createElement('span');
    desc.className = 'cmd-desc';
    desc.textContent = p.desc;
    row.append(emoji, cmd, desc);
    if (note) {
      const tag = document.createElement('span');
      tag.className = 'cmd-note';
      tag.textContent = note;
      row.appendChild(tag);
    }
    box.appendChild(row);
  });
  box.classList.remove('hidden');
  positionPopup();
}

// Anchored above the input, as wide as the composer (fixed positioning: the composer clips overflow).
function positionPopup() {
  if (!popup.open) return;
  const c = el.composer.getBoundingClientRect();
  const i = el.input.getBoundingClientRect();
  el.cmdPopup.style.left = Math.round(c.left + 10) + 'px';
  el.cmdPopup.style.width = Math.max(160, Math.round(c.width - 20)) + 'px';
  el.cmdPopup.style.bottom = Math.round(window.innerHeight - i.top + 4) + 'px';
}

function closePopup() {
  popup.open = false;
  popup.kind = 'cmd';
  popup.items = [];
  popup.index = 0;
  popup.at = null;
  popup.pinned = null;
  el.cmdPopup.classList.add('hidden');
  el.cmdBtn.setAttribute('aria-expanded', 'false');
  el.cmdPopup.textContent = '';
}

// Skips the dimmed rows (a command list never consists of dimmed rows only).
function movePopup(delta) {
  const n = popup.items.length;
  if (!n) return;
  let i = popup.index;
  for (let k = 0; k < n; k++) {
    i = (i + delta + n) % n;
    if (popup.kind === 'zotero' || !commandUnavailable(popup.items[i])) break;
  }
  popup.index = i;
  renderPopup();
}

// The [/] button: all commands (a pick puts the command in front of the text typed so far); a second click closes.
function toggleCommandList() {
  if (popup.open && popup.kind === 'cmd' && popup.pinned != null) { closePopup(); return; }
  cancelZotero();
  if (document.activeElement !== el.input) el.input.focus();
  popup.kind = 'cmd';
  popup.items = popupNames();
  popup.index = firstEnabled(popup.items);
  popup.at = null;
  popup.open = true;
  popup.pinned = el.input.value;
  el.cmdBtn.setAttribute('aria-expanded', 'true');
  renderPopup();
}

// Replaces the typed "/prefix" with the full command plus a space; does not send.
function applyCommand(name) {
  const v = el.input.value;
  const token = commandToken(v) || '';
  const rest = v.slice(token.length).replace(/^[ \t]+/, '');
  el.input.value = '/' + name + ' ' + rest;
  const caret = name.length + 2;
  el.input.setSelectionRange(caret, caret);
  updateActionState();
  closePopup();
  el.input.focus();
}

// ---- "@" Zotero picks ---------------------------------------------------------------------------------------------
// The "@query" right before the caret (at the start or after whitespace, 2+ letters or digits), or null.
const ZOTERO_AT_RE = /(^|\s)@([\p{L}\p{N}][\p{L}\p{N}'’-]+)$/u;
function zoteroQueryAt(value, caret) {
  const m = ZOTERO_AT_RE.exec(String(value).slice(0, caret));
  return m ? { start: m.index + m[1].length, end: caret, query: m[2] } : null;
}
const ZOTERO_DEBOUNCE_MS = 300;
// The search in flight or waiting (the newest wins); none: the last query without matches (not asked again).
const zoteroAsk = { timer: null, seq: 0, query: null, none: null };
function updateZoteroPopup() {
  const q = el.input.selectionStart === el.input.selectionEnd ? zoteroQueryAt(el.input.value, el.input.selectionStart) : null;
  const at = q && zoteroAtReady(updateZoteroPopup) ? q : null;
  if (!at) { cancelZotero(); zoteroAsk.none = null; closePopup(); return; }
  if (zoteroAsk.none === at.query) return;
  if (popup.kind === 'zotero' && popup.open && popup.at && popup.at.query === at.query) { popup.at = at; return; }
  if (zoteroAsk.query === at.query) return; // already asked
  if (popup.kind !== 'zotero') closePopup();
  cancelZotero();
  zoteroAsk.query = at.query;
  const seq = ++zoteroAsk.seq;
  zoteroAsk.timer = setTimeout(async () => {
    zoteroAsk.timer = null;
    let items = [];
    try { items = await zoteroPickItems(at.query); } catch (e) { items = []; }
    if (seq !== zoteroAsk.seq) return; // typed on meanwhile
    zoteroAsk.query = null;
    const now = el.input.selectionStart === el.input.selectionEnd ? zoteroQueryAt(el.input.value, el.input.selectionStart) : null;
    if (!items.length) zoteroAsk.none = at.query;
    if (!now || now.query !== at.query || !items.length) { if (popup.kind === 'zotero') closePopup(); return; }
    popup.kind = 'zotero';
    popup.items = items;
    popup.index = 0;
    popup.at = now;
    popup.open = true;
    renderPopup();
  }, ZOTERO_DEBOUNCE_MS);
}
function cancelZotero() {
  if (zoteroAsk.timer) clearTimeout(zoteroAsk.timer);
  zoteroAsk.timer = null;
  zoteroAsk.query = null;
  zoteroAsk.seq++;
}
// A row per item: "Smith & Lee 2020" and the title start.
function renderZoteroRows(box) {
  popup.items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'cmd-row zotero-row' + (i === popup.index ? ' active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === popup.index));
    row.dataset.idx = String(i);
    row.title = `${it.who} (${it.year}). ${it.title}`;
    const icon = document.createElement('span');
    icon.className = 'cmd-emoji';
    icon.textContent = '📚';
    const who = document.createElement('span');
    who.className = 'cmd-name';
    who.textContent = `${it.who} ${it.year}`;
    const title = document.createElement('span');
    title.className = 'cmd-desc';
    title.textContent = it.title;
    row.append(icon, who, title);
    box.appendChild(row);
  });
  box.classList.remove('hidden');
  positionPopup();
}
// Replaces the typed "@query" with the item's token plus a space; does not send.
function applyZotero(item) {
  const at = popup.at;
  if (!item || !at) { closePopup(); return; }
  const v = el.input.value;
  const token = zoteroToken(item) + ' ';
  el.input.value = v.slice(0, at.start) + token + v.slice(at.end).replace(/^ /, '');
  const caret = at.start + token.length;
  el.input.setSelectionRange(caret, caret);
  cancelZotero();
  closePopup();
  updateActionState();
  el.input.focus();
}
// The highlighted (or clicked) entry of either popup.
function pickPopup(i) {
  if (popup.kind === 'zotero') applyZotero(popup.items[i]);
  else if (!commandUnavailable(popup.items[i])) applyCommand(popup.items[i]); // a dimmed row does nothing
}

// Keydown handling for the input. Returns true when the event was consumed by the popup.
function handlePopupKey(e) {
  if (!popup.open) return false;
  if (e.key === 'ArrowDown') { e.preventDefault(); movePopup(1); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); movePopup(-1); return true; }
  if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || (e.key === 'Tab' && !e.shiftKey)) {
    e.preventDefault();
    pickPopup(popup.index);
    return true;
  }
  if (e.key === 'Escape') { e.preventDefault(); closePopup(); return true; }
  return false;
}

function bindPopup() {
  el.input.addEventListener('input', updatePopup);
  el.input.addEventListener('click', updatePopup);
  el.input.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') updatePopup();
  });
  el.input.addEventListener('blur', () => { cancelZotero(); closePopup(); });
  // Catch every other caret/selection move (Ctrl+A, PageUp/Down, ArrowUp/Down between lines,
  // drag-selecting) so the popup never stays open with the caret outside the command token.
  document.addEventListener('selectionchange', () => { if (document.activeElement === el.input) updatePopup(); });
  el.cmdPopup.addEventListener('mouseover', (e) => {
    const row = e.target.closest('.cmd-row');
    if (!row || row.getAttribute('aria-disabled') === 'true') return;
    const i = Number(row.dataset.idx);
    if (i !== popup.index) { popup.index = i; renderPopup(); }
  });
  // mousedown (not click) with preventDefault keeps the focus in the input.
  el.cmdPopup.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.cmd-row');
    e.preventDefault();
    if (row) pickPopup(Number(row.dataset.idx));
  });
  // mousedown keeps the focus in the input (its blur would close the list before the click toggles it).
  el.cmdBtn.addEventListener('mousedown', (e) => e.preventDefault());
  el.cmdBtn.addEventListener('click', toggleCommandList);
  window.addEventListener('resize', positionPopup);
}
