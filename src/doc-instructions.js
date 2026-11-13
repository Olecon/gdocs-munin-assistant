'use strict';
// Module doc-instructions.js: the Files panel (header button → a section like Settings) and the user's standing
// instructions, shown there as two files: MAIN.md (every document, MAIN_INSTRUCTIONS_KEY) and DOC.md (the document's,
// per document). The list also holds the document's attached files (src/attachments.js owns them): an entry opens
// in place of the list, the instructions in one box with autosave, an attachment in a read-only viewer of its numbered
// lines; meanwhile + Add file reads Close (back to the list). Every row shows its last-modified date (fileDate).
// readDocInstructions, readMainInstructions, openFiles, closeFiles, openFileEntry, closeFilePane, onFilesAdd,
// renderFilesList, saveInstructions (auto-save: onInstructionsInput), writeDocInstructions, writeMainInstructions,
// watchInstructionsStorage, the remember tool (rememberTool), and the checks' ignore list of DOC.md (checkIgnores,
// textCheckIgnored).
/* global addError, closeSettings, DOC_INSTRUCTIONS_MAX, docFileMeta, docInstructionsKey, el, fmtNum, gateEdit,
   MAIN_INSTRUCTIONS_KEY, oneLine, openFilePicker, pendingDocFiles, readDocFileText, registerUndoHandler, removeDocFile, state */
/* exported readDocInstructions, readMainInstructions, onInstructionsInput, openFiles, closeFiles, openFileEntry,
   closeFilePane, onFilesAdd, renderFilesList, saveInstructions, writeDocInstructions, writeMainInstructions,
   watchInstructionsStorage, rememberTool, rememberUndoText, rememberUndoCheck, fileDate, MAIN_INSTRUCTIONS_AT_KEY,
   docInstructionsAtKey, checkIgnores, checkRuleIgnored, textCheckIgnored */

// ---------------------------------------------------------------------------
// Files (header button → a section like Settings)
// ---------------------------------------------------------------------------
// The document's text is read when a document is opened (refreshContext), the main text when the panel starts (init);
// both are frozen per turn by snapshotDocument, so an edit while an answer runs takes effect from the next message.
// All chats of the document share its instructions and its files; every document shares MAIN.md.
// The box saves itself after a typing pause (INSTRUCTIONS_SAVE_MS), when it is left, when another entry opens, when
// the entry closes and when the section closes.
const INSTRUCTIONS_SAVE_MS = 1000;
// open: the section shows; entry: what the pane below the list shows (null, 'main', 'document' or a file's alias);
// confirm: the alias whose Remove waits for a confirmation; viewSeq: the latest viewer load (an older one is dropped).
const filesForm = { open: false, entry: null, confirm: null, viewSeq: 0 };
// The instructions box: open (it shows), scope 'main' | 'document', docId (the document of a 'document' box), base
// (the stored text the box was opened with or last synced to: the box differs from it only by the user's typing).
const instructionsForm = { open: false, scope: 'document', docId: null, timer: 0, base: '' };
const INSTRUCTIONS_SCOPE_UI = {
  main: { name: 'MAIN.md', meta: 'Every document', placeholder: 'For every document. For example: Answer briefly. Run agents on gpt-5-mini. Use British English.' },
  document: { name: 'DOC.md', meta: 'This document', placeholder: 'For this document. For example: Target journal: Biophysical Journal. Keep the term "lipid raft". Do not change the Methods section.' },
};
const isInstructionsEntry = (entry) => entry === 'main' || entry === 'document';
const VIEWER_CHUNK = 5000; // lines drawn at once in the viewer; more on request
const capInstructions = (v) => String(v == null ? '' : v).slice(0, DOC_INSTRUCTIONS_MAX).trim();

async function readStoredText(key) {
  try {
    const v = (await chrome.storage.local.get(key))[key];
    return typeof v === 'string' ? v.slice(0, DOC_INSTRUCTIONS_MAX) : '';
  } catch (e) {
    return '';
  }
}
const readDocInstructions = async (docId) => (docId ? readStoredText(docInstructionsKey(docId)) : '');
const readMainInstructions = () => readStoredText(MAIN_INSTRUCTIONS_KEY);

// The time of the last save of each text (epoch ms), stored next to it by writeInstructions (the box, remember, the
// first-run pass), for the date in the list. None stored (a text from an earlier build): no date.
const MAIN_INSTRUCTIONS_AT_KEY = 'muninMainInstructionsAt';
const docInstructionsAtKey = (docId) => 'muninDocInstructionsAt:' + docId;
const instructionsAtKey = (scope, docId) => (scope === 'main' ? MAIN_INSTRUCTIONS_AT_KEY : docInstructionsAtKey(docId));
// key -> ms (0: none). A key is read on its first show; writes here and storage events keep it current.
const savedAt = new Map();
function savedTime(key) {
  if (savedAt.has(key)) return savedAt.get(key);
  savedAt.set(key, 0);
  Promise.resolve(chrome.storage.local.get(key)).then((got) => {
    const v = Number(got && got[key]);
    if (v > 0 && !savedAt.get(key)) { savedAt.set(key, v); renderFilesList(); } // a save meanwhile is newer
  }).catch(() => {});
  return 0;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Like a file explorer, in local time: today "14:02", this year "30 Oct", earlier "30 Oct 2025"; no time: ''.
function fileDate(ms, now = Date.now()) {
  if (!(Number(ms) > 0)) return '';
  const d = new Date(Number(ms));
  const n = new Date(now);
  const pad = (x) => String(x).padStart(2, '0');
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === n.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}
// The tooltip: the full date and time.
const fullDate = (ms) => (Number(ms) > 0 ? `${fileDate(ms, 0)}, ${fileDate(ms, ms)}` : '');

// Typing: the text is saved after the pause.
function onInstructionsInput() {
  setInstructionsNote('');
  clearTimeout(instructionsForm.timer);
  instructionsForm.timer = setTimeout(saveInstructions, INSTRUCTIONS_SAVE_MS);
}

// entry: 'main' | 'document' | an attachment's alias to open at once; none: the list alone.
function openFiles(entry) {
  closeSettings();
  filesForm.open = true;
  filesForm.confirm = null;
  el.files.classList.remove('hidden');
  renderFilesList();
  if (entry) openFileEntry(entry);
}

function closeFiles() {
  closeFilePane(); // saves the box (it reads the text before it awaits anything)
  el.files.classList.add('hidden');
  filesForm.open = false;
  filesForm.confirm = null;
}

// Opens an entry below the list: the box for MAIN.md / DOC.md (DOC.md needs a document), the viewer for a file.
function openFileEntry(entry) {
  if (!filesForm.open || entry === filesForm.entry) return;
  if (entry === 'document' && !state.docId) return;
  const file = isInstructionsEntry(entry) ? null : (state.docFiles || []).find((f) => f.alias === entry);
  if (!isInstructionsEntry(entry) && !file) return;
  closeFilePane();
  filesForm.entry = entry;
  filesForm.confirm = null;
  el.filesList.classList.add('hidden');
  el.filesPane.classList.remove('hidden');
  if (file) showViewer(file); else showEditor(entry);
  renderFilesList();
}

// The button at the right of the heading: + Add file (the composer's picker; the files go to the list), or Close
// while an entry is open.
function onFilesAdd() {
  if (filesForm.entry) closeFilePane();
  else openFilePicker('files');
}

// Back to the list: the box is saved first.
function closeFilePane() {
  saveInstructions();
  instructionsForm.open = false;
  instructionsForm.docId = null;
  instructionsForm.base = '';
  setInstructionsNote('');
  filesForm.entry = null;
  filesForm.viewSeq++;
  el.instructionsText.classList.add('hidden');
  el.fileViewer.classList.add('hidden');
  el.fileViewer.textContent = '';
  el.filesPane.classList.add('hidden');
  el.filesList.classList.remove('hidden');
  renderFilesList();
}

function showEditor(scope) {
  const ui = INSTRUCTIONS_SCOPE_UI[scope];
  const text = (scope === 'main' ? state.mainInstructions : state.docInstructions) || '';
  Object.assign(instructionsForm, { open: true, scope, docId: scope === 'document' ? state.docId : null, base: text });
  el.filesPaneName.textContent = `${ui.name} · ${ui.meta.toLowerCase()}`;
  el.filesPaneName.dataset.tip = ui.name;
  setInstructionsNote('');
  el.instructionsText.value = text;
  el.instructionsText.placeholder = ui.placeholder;
  el.instructionsText.setAttribute('aria-label', ui.name);
  el.instructionsText.classList.remove('hidden');
  el.instructionsText.focus();
}

// The viewer: the stored text as the reading tools number it (one row per line, "[page N]" rows for a PDF).
async function showViewer(file) {
  const seq = ++filesForm.viewSeq;
  const docId = state.docId;
  el.filesPaneName.textContent = `${file.title} · ${file.alias} · ${filesPlural(file.lines, 'line')}`;
  el.filesPaneName.dataset.tip = file.title;
  el.fileViewer.setAttribute('aria-label', `${file.title} (read-only)`);
  el.fileViewer.textContent = 'Reading…';
  el.fileViewer.classList.remove('hidden');
  el.fileViewer.focus(); // the row that had the focus is hidden now
  const text = await readDocFileText(docId, file.alias);
  if (seq !== filesForm.viewSeq || docId !== state.docId) return;
  el.fileViewer.textContent = '';
  if (text == null) { el.fileViewer.textContent = 'The text of this file is no longer stored. Remove it and add it again.'; return; }
  drawViewerLines(text.split('\n'), 0);
}
function drawViewerLines(lines, from) {
  const to = Math.min(lines.length, from + VIEWER_CHUNK);
  for (let i = from; i < to; i++) {
    const row = document.createElement('div');
    row.className = 'fv-line';
    row.dataset.n = String(i + 1);
    row.textContent = lines[i];
    el.fileViewer.appendChild(row);
  }
  if (to >= lines.length) return;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'btn small fv-more';
  more.textContent = `Show ${filesPlural(Math.min(VIEWER_CHUNK, lines.length - to), 'more line')}`;
  more.addEventListener('click', () => { more.remove(); drawViewerLines(lines, to); });
  el.fileViewer.appendChild(more);
}

const filesPlural = (n, word) => `${fmtNum(n)} ${word}${n === 1 ? '' : 's'}`;
const lineCount = (text) => (text ? filesPlural(text.split('\n').length, 'line') : 'empty');
const filesButton = (cls, text, onClick) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
};
// One row of the list: a button that opens the entry (name, meta and the date at the right), and for a file its
// Remove control. entry null: a file still being read (nothing to open yet).
function fileRow({ entry, name, meta, title, at = 0, disabled = false, removable = false }) {
  const active = !!entry && filesForm.entry === entry;
  const row = document.createElement('div');
  row.className = 'file-row' + (active ? ' active' : '');
  row.setAttribute('role', 'listitem');
  if (entry) row.dataset.entry = entry;
  const open = filesButton('file-open', '', () => openFileEntry(entry));
  open.disabled = disabled || !entry;
  open.dataset.tip = title || name;
  if (active) open.setAttribute('aria-current', 'true');
  const n = document.createElement('span');
  n.className = 'file-name';
  n.textContent = name;
  const m = document.createElement('span');
  m.className = 'file-meta';
  m.textContent = meta;
  const d = document.createElement('span');
  d.className = 'file-date';
  d.textContent = fileDate(at);
  if (d.textContent) d.dataset.tip = fullDate(at);
  open.append(n, m, d);
  row.appendChild(open);
  if (removable) {
    const x = filesButton('file-remove', '×', () => { filesForm.confirm = filesForm.confirm === entry ? null : entry; renderFilesList(); });
    x.dataset.tip = 'Remove';
    x.setAttribute('aria-label', `Remove ${name}`);
    row.appendChild(x);
  }
  return row;
}
// The confirmation under a file's row: Remove deletes its text, its bytes and its entry.
function confirmRow(file) {
  const box = document.createElement('div');
  box.className = 'file-confirm';
  box.setAttribute('role', 'listitem');
  const q = document.createElement('span');
  q.textContent = `Remove ${file.title}? No chat can read it then.`;
  const docId = state.docId;
  const yes = filesButton('btn small danger', 'Remove', async () => {
    filesForm.confirm = null;
    if (filesForm.entry === file.alias) closeFilePane();
    await removeDocFile(docId, file.alias);
    renderFilesList();
  });
  const no = filesButton('btn small ghost', 'Cancel', () => { filesForm.confirm = null; renderFilesList(); });
  box.append(q, yes, no);
  return box;
}

// The list: MAIN.md, DOC.md, then the document's files (and those still being read); nothing more when there are no
// files. Called again whenever one of them changes (here or in another tab); an open file that is gone closes.
function renderFilesList() {
  if (!filesForm.open) return;
  const files = state.docId ? state.docFiles || [] : [];
  const entry = filesForm.entry;
  if (entry && (entry === 'document' ? !state.docId : !isInstructionsEntry(entry) && !files.some((f) => f.alias === entry))) {
    closeFilePane(); // renders the list again
    return;
  }
  const list = el.filesList;
  // The rows are drawn anew: a keyboard user keeps the row they were on.
  const active = document.activeElement;
  const focused = list.contains(active) && active.closest('[data-entry]');
  const refocus = focused ? `[data-entry="${focused.dataset.entry}"] ${active.classList.contains('file-remove') ? '.file-remove' : '.file-open'}` : '';
  list.textContent = '';
  list.appendChild(fileRow({ entry: 'main', name: 'MAIN.md', meta: `${INSTRUCTIONS_SCOPE_UI.main.meta} · ${lineCount(state.mainInstructions)}`,
    title: 'Your instructions for every document', at: savedTime(MAIN_INSTRUCTIONS_AT_KEY) }));
  list.appendChild(fileRow({ entry: 'document', name: 'DOC.md', disabled: !state.docId,
    meta: state.docId ? `${INSTRUCTIONS_SCOPE_UI.document.meta} · ${lineCount(state.docInstructions)}` : 'No document',
    title: state.docId ? 'Your instructions for this document' : 'Open a Google Docs document first',
    at: state.docId ? savedTime(docInstructionsAtKey(state.docId)) : 0 }));
  for (const f of files) {
    list.appendChild(fileRow({ entry: f.alias, name: f.title, meta: docFileMeta(f), title: `${f.title}: show the text the model reads`,
      at: f.addedAt, removable: true }));
    if (filesForm.confirm === f.alias) list.appendChild(confirmRow(f));
  }
  const pending = state.docId ? pendingDocFiles(state.docId) : [];
  for (const p of pending) list.appendChild(fileRow({ entry: null, name: p.name, meta: 'reading…' }));
  renderFilesAdd();
  const again = refocus && list.querySelector(refocus);
  if (again && !again.disabled) again.focus();
}

// + Add file, or Close in the same place while an entry is open.
function renderFilesAdd() {
  const open = !!filesForm.entry;
  el.filesAdd.textContent = open ? 'Close' : '+ Add file';
  el.filesAdd.dataset.tip = open ? 'Back to the list'
    : state.docId ? 'Text, Markdown, .docx or .pdf' : 'Open a document first';
  el.filesAdd.disabled = !open && !state.docId;
}

// Whether the open box shows this scope (and, for 'document', this document).
const boxShows = (scope, docId) => instructionsForm.open && instructionsForm.scope === scope && (scope === 'main' || instructionsForm.docId === docId);

// Stores one scope's instructions (capped, trimmed; an empty text removes the key) and shows them at once: the
// list, and the open box unless the text comes from the box or the box holds typed text not saved yet (the save
// merges it then). Returns the stored text; throws when storage fails.
async function writeInstructions(scope, docId, value, fromForm = false) {
  const text = capInstructions(value);
  const key = scope === 'main' ? MAIN_INSTRUCTIONS_KEY : docInstructionsKey(docId);
  const atKey = instructionsAtKey(scope, docId);
  const at = Date.now();
  if (text) await chrome.storage.local.set({ [key]: text, [atKey]: at });
  else { await chrome.storage.local.remove(key); await chrome.storage.local.set({ [atKey]: at }); } // emptying is a save too
  savedAt.set(atKey, at);
  showInstructions(scope, docId, text, fromForm);
  return text;
}
function showInstructions(scope, docId, text, fromForm = false) {
  if (scope === 'main') state.mainInstructions = text;
  else if (docId === state.docId) state.docInstructions = text;
  else return;
  if (boxShows(scope, docId)) {
    if (fromForm) instructionsForm.base = text;
    else if (capInstructions(el.instructionsText.value) === instructionsForm.base) { // nothing typed: follow
      el.instructionsText.value = text;
      instructionsForm.base = text;
    }
  }
  renderFilesList();
}
// The short notice next to the box's name ('' hides it).
function setInstructionsNote(text) {
  if (!el.filesPaneNote) return;
  el.filesPaneNote.textContent = text;
  el.filesPaneNote.classList.toggle('hidden', !text);
}

// Line-level three-way merge for the box: base (what the box started from), mine (the box), theirs (stored meanwhile
// by remember, the first-run pass or another tab). Each side is one changed block of lines (common head and tail
// cut off); blocks that do not overlap both apply (two insertions at the same place: theirs first). Returns the
// merged text, or null when the blocks overlap.
function changedBlock(base, other) {
  let head = 0;
  while (head < base.length && head < other.length && base[head] === other[head]) head++;
  let tail = 0;
  while (tail < base.length - head && tail < other.length - head
    && base[base.length - 1 - tail] === other[other.length - 1 - tail]) tail++;
  return { from: head, to: base.length - tail, lines: other.slice(head, other.length - tail) };
}
function mergeInstructions(base, mine, theirs) {
  if (mine === theirs || mine === base) return theirs;
  if (theirs === base) return mine;
  const b = instructionLines(base);
  const m = changedBlock(b, instructionLines(mine));
  const t = changedBlock(b, instructionLines(theirs));
  const sameInsert = m.from === m.to && t.from === t.to && m.from === t.from;
  if (m.from < t.to && t.from < m.to) return null; // overlapping ranges (an insertion strictly inside the other too)
  if (sameInsert) return [...b.slice(0, t.from), ...t.lines, ...m.lines, ...b.slice(t.from)].join('\n');
  const [first, second] = m.from < t.from || (m.from === t.from && m.to <= t.from) ? [m, t] : [t, m];
  return [...b.slice(0, first.from), ...first.lines, ...b.slice(first.to, second.from), ...second.lines, ...b.slice(second.to)].join('\n');
}
const writeDocInstructions = (docId, value, fromForm = false) => writeInstructions('document', docId, value, fromForm);
const writeMainInstructions = (value, fromForm = false) => writeInstructions('main', null, value, fromForm);

// Saves the box (trimmed, capped) under its scope's key; an empty text removes the key. Nothing is written when the
// box was not edited. When the stored text changed meanwhile (remember, the first-run pass, another tab) the edit is
// merged onto it; an edit that cannot be merged is dropped, the stored text shows and a notice says so: a stored
// line is never lost.
async function saveInstructions() {
  clearTimeout(instructionsForm.timer);
  instructionsForm.timer = 0;
  if (!instructionsForm.open) return;
  const { scope, docId } = instructionsForm;
  if (scope === 'document' && !docId) return;
  const value = capInstructions(el.instructionsText.value);
  const base = instructionsForm.base;
  if (value === base) return;
  const current = scope === 'main' ? state.mainInstructions : docId === state.docId ? state.docInstructions : base;
  let next = value;
  if (current !== base) {
    const merged = mergeInstructions(base, value, current);
    const box = el.instructionsText;
    const { selectionStart: a, selectionEnd: b } = box;
    if (merged == null || merged.length > DOC_INSTRUCTIONS_MAX) { // the cap would cut a stored line
      box.value = current;
      instructionsForm.base = current;
      setInstructionsNote('Changed meanwhile (the assistant or another tab); your last edit was not saved');
      return;
    }
    if (merged === current) { instructionsForm.base = current; return; } // the same change on both sides
    next = merged;
    if (capInstructions(merged) !== value) {
      box.value = merged;
      if (typeof a === 'number') { box.selectionStart = Math.min(a, merged.length); box.selectionEnd = Math.min(b, merged.length); }
    }
    setInstructionsNote('Changed meanwhile (the assistant or another tab); your edit was added');
  }
  try {
    await writeInstructions(scope, docId, next, true);
  } catch (e) {
    addError(`Could not save ${INSTRUCTIONS_SCOPE_UI[scope].name}: ${e.message}`);
  }
}

// Another panel (tab) changed the main instructions or this document's: this one follows, so its next turn sends
// them too (its own writes arrive here as well and change nothing).
let instructionsWatched = false;
function watchInstructionsStorage() {
  const ev = chrome.storage && chrome.storage.onChanged;
  if (instructionsWatched || !ev || typeof ev.addListener !== 'function') return;
  instructionsWatched = true;
  ev.addListener((changes, area) => {
    if ((area && area !== 'local') || !changes) return;
    const follow = (scope, key, docId) => {
      if (!changes[key]) return;
      const v = changes[key].newValue;
      const text = typeof v === 'string' ? capInstructions(v) : '';
      if (text !== (scope === 'main' ? state.mainInstructions : state.docInstructions)) showInstructions(scope, docId, text);
    };
    let dated = false;
    for (const key of Object.keys(changes)) {
      if (key !== MAIN_INSTRUCTIONS_AT_KEY && !key.startsWith(docInstructionsAtKey(''))) continue;
      const v = Number(changes[key].newValue);
      savedAt.set(key, v > 0 ? v : 0);
      dated = true;
    }
    if (dated) renderFilesList();
    follow('main', MAIN_INSTRUCTIONS_KEY, null);
    if (state.docId && !state.loadingCtx) follow('document', docInstructionsKey(state.docId), state.docId);
  });
}

// ---- remember: the model adds, removes or replaces one line on the user's explicit request ------------------
// Stored like an edit in the section (other tabs see it the same way); the running turn keeps the
// instructions it started with (snapshotDocument). The tool message keeps _remember {scope, action, text, index,
// old? (replace)} for its action-log row (render.js rememberRowInfo) and a journal entry (_edit, kind 'remember': the
// same fields), so the Undo arrow, Undo all and undo_last_edit take a change back in order with the document edits
// (undoRemember); another remember or the Files panel can change it too.
// scope "main": MAIN.md, the main instructions (every document); "document" (also a missing or unknown scope):
// DOC.md, this document's.
const REMEMBER_SCOPES = {
  main: { title: 'MAIN.md', read: () => readMainInstructions(), write: (docId, text) => writeMainInstructions(text) },
  document: { title: 'DOC.md', read: (docId) => readDocInstructions(docId), write: (docId, text) => writeDocInstructions(docId, text) },
};
const rememberScope = (v) => (v === 'main' ? 'main' : 'document');
const instructionLines = (text) => (text ? text.split('\n') : []);
// The result names only the changed line, its number and the file's size (the file itself is in every head).
function rememberResult(sc, saved, change) {
  const n = change.index + 1;
  if (change.action === 'remove') return `Removed line ${n} of ${sc.title} (now ${lineCount(saved)}): ${change.text}`;
  return `${change.action === 'add' ? 'Added' : 'Changed'} line ${n} of ${sc.title} (${lineCount(saved)}): ${instructionLines(saved)[change.index] || change.text}`;
}
const ruleLine = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const wordsOf = (t) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
// Up to 3 lines most like text (share of common words), for the "not found" error.
function closestLines(lines, text) {
  const want = wordsOf(text);
  const score = (l) => { const w = wordsOf(l); let n = 0; for (const x of w) if (want.has(x)) n++; return n / Math.max(w.size, want.size, 1); };
  return lines.map((l) => l.trim()).filter(Boolean).map((l, i) => ({ l, s: score(l), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 3).map((x) => x.l);
}

// remember({scope, action, text, old}): returns the tool message fields. In a tainted turn the change waits for the
// edit gate (gateEdit); after Allow the instructions are read again (they may have changed while the card waited).
// gated: the gate already allowed this call.
async function rememberTool(args, snap, ui = {}, gated = false) {
  const text = ruleLine(args.text);
  const action = args.action;
  const scope = rememberScope(args.scope);
  const sc = REMEMBER_SCOPES[scope];
  const old = action === 'replace' ? ruleLine(args.old) : '';
  const quote = `«${oneLine(text, 80)}»`;
  const fail = (content, message) => ({ content: `Error: ${content}`, _ok: false, _message: message, _cardText: '' });
  if (!['add', 'remove', 'replace'].includes(action)) return fail('action must be "add", "remove" or "replace".', 'Invalid tool arguments');
  if (!text) return fail('the rule is empty.', 'Empty rule');
  if (action === 'replace' && !old) return fail('replace needs old: the exact line to change.', 'Invalid tool arguments');
  if (scope === 'document' && !snap.docId) return fail('no document is open.', 'No document');
  const current = await sc.read(snap.docId);
  const lines = instructionLines(current);
  const find = (t) => lines.findIndex((l) => l.trim() === t);
  const index = find(action === 'replace' ? old : text);
  const gate = async () => {
    if (gated) return null;
    const refused = await gateEdit('remember', { scope, action, text, ...(old ? { old } : {}) }, snap, ui);
    if (refused) return { ...refused, _cardText: '' };
    return ui.decision ? rememberTool(args, snap, ui, true) : null;
  };
  const tooLong = (next) => (next.length > DOC_INSTRUCTIONS_MAX
    ? fail(`${sc.title} would exceed the limit of ${fmtNum(DOC_INSTRUCTIONS_MAX)} characters (now ${fmtNum(current.length)}). Shorten the rule or remove one first.`,
      `${sc.title} is full (${fmtNum(DOC_INSTRUCTIONS_MAX)} characters)`)
    : null);
  if (action === 'add') {
    if (index >= 0) {
      return { content: `Already in ${sc.title} as line ${index + 1} (${lineCount(current)}); nothing changed.`, _ok: true,
        _message: `Already in ${sc.title}: ${quote}`, _icon: '📌', _cardText: '' };
    }
    const next = current.trimEnd() ? `${current.trimEnd()}\n${text}` : text;
    return tooLong(next) || (await gate()) ||
      rememberDone(sc, snap.docId, next, { scope, action, text, index: instructionLines(next).length - 1 }, `Added to ${sc.title}: ${quote}`);
  }
  if (index < 0) {
    const missing = action === 'replace' ? old : text;
    const near = closestLines(lines, missing);
    return fail(near.length
      ? `no line of ${sc.title} is exactly "${missing}". Closest lines:\n${near.join('\n')}\nCall remember again with the exact text of the line to ${action}.`
      : `${sc.title} is empty.`, `Not in ${sc.title}: «${oneLine(missing, 80)}»`);
  }
  if (action === 'replace') {
    if (old === text) {
      return { content: `Line ${index + 1} of ${sc.title} (${lineCount(current)}) is already "${text}"; nothing changed.`, _ok: true,
        _message: `Already in ${sc.title}: ${quote}`, _icon: '📌', _cardText: '' };
    }
    const next = lines.map((l, i) => (i === index ? text : l)).join('\n');
    return tooLong(next) || (await gate()) ||
      rememberDone(sc, snap.docId, next, { scope, action, text, old, index }, `Changed in ${sc.title}: «${oneLine(old, 60)}» → «${oneLine(text, 60)}»`);
  }
  const after = await gate();
  if (after) return after;
  lines.splice(index, 1);
  return rememberDone(sc, snap.docId, lines.join('\n'), { scope, action, text, index }, `Removed from ${sc.title}: ${quote}`);
}
async function rememberDone(sc, docId, next, change, message) {
  let saved;
  try { saved = await sc.write(docId, next); } catch (e) {
    return { content: `Error: ${sc.title} could not be saved (${e.message}).`, _ok: false, _message: `Could not save ${sc.title}`, _cardText: '' };
  }
  // The journal entry; its id (the call's) is set by the caller (turn.js runToolCall).
  const edit = { id: '', kind: 'remember', docId: docId || null, tabId: null, ...change, title: message, undone: false };
  return { content: rememberResult(sc, saved, change), _ok: true, _message: message, _icon: '📌', _cardText: '', _remember: change, _edit: edit };
}

// ---- Undo of a remember (a journal entry of kind 'remember') ----------------------------------------------------
// The inverse of the change on the file as stored now: an added line is removed, a removed line is put back at its
// place (its index, or the end when the file is shorter now), a changed line gets its old text back. The line is found
// by its text (at its index first, else the first equal line); when it is no longer there (the file was edited
// meanwhile) the undo is refused. The file is read again afterwards to verify the change.
// What the undo does, for the row's fold ("removes «rule» from DOC.md") or, past, its result ("removed …").
function rememberUndoText(ch, past = false) {
  const c = ch && typeof ch === 'object' ? ch : {};
  const sc = REMEMBER_SCOPES[rememberScope(c.scope)];
  const text = `«${oneLine(String(c.text || ''), 60)}»`;
  if (c.action === 'remove') return `${past ? 'put' : 'puts'} ${text} back into ${sc.title}`;
  if (c.action === 'replace') return `${past ? 'changed' : 'changes'} ${text} in ${sc.title} back to «${oneLine(String(c.old || ''), 60)}»`;
  return `${past ? 'removed' : 'removes'} ${text} from ${sc.title}`;
}
// The file's lines after undoing edit, from its lines now; throws the refusal.
function rememberUndoLines(edit, lines) {
  const sc = REMEMBER_SCOPES[rememberScope(edit.scope)];
  const text = ruleLine(edit.text);
  const at = (t) => (lines[edit.index] != null && lines[edit.index].trim() === t ? edit.index : lines.findIndex((l) => l.trim() === t));
  const quote = `«${oneLine(text, 60)}»`;
  const gone = () => new Error(`the line ${quote} is no longer in ${sc.title} (it was changed meanwhile), so there is nothing to undo. Edit ${sc.title} in the Files panel instead.`);
  if (edit.action === 'remove') {
    if (at(text) >= 0) throw new Error(`the line ${quote} is in ${sc.title} again, so there is nothing to undo.`);
    const out = [...lines];
    out.splice(Math.max(0, Math.min(Number(edit.index) || 0, out.length)), 0, text);
    return out;
  }
  const i = at(text);
  if (i < 0) throw gone();
  const out = [...lines];
  if (edit.action === 'replace') out[i] = ruleLine(edit.old);
  else out.splice(i, 1);
  return out;
}
// Checks that edit can be undone now (Undo all's dry run); throws the refusal.
async function rememberUndoCheck(edit) {
  const sc = REMEMBER_SCOPES[rememberScope(edit.scope)];
  rememberUndoLines(edit, instructionLines(await sc.read(edit.docId)));
}
async function undoRemember(edit) {
  const sc = REMEMBER_SCOPES[rememberScope(edit.scope)];
  const next = rememberUndoLines(edit, instructionLines(await sc.read(edit.docId))).join('\n');
  if (next.length > DOC_INSTRUCTIONS_MAX) throw new Error(`${sc.title} would exceed the limit of ${fmtNum(DOC_INSTRUCTIONS_MAX)} characters; remove a line in the Files panel first.`);
  await sc.write(edit.docId, next);
  const now = await sc.read(edit.docId);
  if (now !== capInstructions(next)) throw new Error(`${sc.title} was saved, but reading it again shows other text; check it in the Files panel.`);
  // model: null, the document is untouched (the callers keep their document model).
  return { model: null, restored: '', lostObjects: false, what: `undid remember: ${rememberUndoText(edit, true)}`, instructions: true };
}
registerUndoHandler('remember', undoRemember);

// ---------------------------------------------------------------------------
// The checks' ignore list: "Checks: ignore <rule-id>, <rule-id>; accept <term>, <term>"
// ---------------------------------------------------------------------------
// A line of DOC.md (written by hand or through remember) that /check and the per-write notes read: ignore silences
// rule ids (a prefix with its dash counts too: "variant" silences variant-numeral), accept names terms that are never
// flagged (and that the variant pass never rewrites). Several lines add up; case does not matter.
// { rules: Set, terms: Set }, both lowercased (terms with their spaces collapsed).
function checkIgnores(text) {
  const rules = new Set();
  const terms = new Set();
  const clean = (t) => t.trim().replace(/^["'«“`]+|["'»”`.]+$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  for (const m of String(text || '').matchAll(/^\s*(?:[-*]\s+)?checks?\s*:\s*(.+)$/gimu)) {
    for (const part of m[1].split(';')) {
      const p = /^\s*(ignore|accept)\s*:?\s+(.+)$/iu.exec(part);
      if (!p) continue;
      const ignore = p[1].toLowerCase() === 'ignore';
      for (const t of p[2].split(ignore ? /[,\s]+/ : ',')) { const v = clean(t); if (v) (ignore ? rules : terms).add(v); }
    }
  }
  return { rules, terms };
}
// Whether a rule id is silenced by the ignore list (the id itself or a prefix of it before a dash).
function checkRuleIgnored(rules, id) {
  const r = String(id || '').toLowerCase();
  if (!r || !rules || !rules.size) return false;
  for (const x of rules) if (r === x || r.startsWith(x + '-')) return true;
  return false;
}
// For the per-write notes: whether a note of this rule id (kind) about this text (the flagged word or phrase) is
// silenced by the "Checks:" line of the given instructions (default: the open document's DOC.md). The text is
// silenced when it is an accepted term or holds one as a whole word or phrase.
function textCheckIgnored(kind, text, instructions = state.docInstructions) {
  const { rules, terms } = checkIgnores(instructions);
  if (checkRuleIgnored(rules, kind)) return true;
  const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t || !terms.size) return false;
  for (const term of terms) {
    if (t === term) return true;
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'u').test(t)) return true;
  }
  return false;
}
