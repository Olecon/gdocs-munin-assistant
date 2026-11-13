'use strict';
// Module attachments.js: files the user attaches (the + button of the composer, a drop on the chat or the composer, a
// paste into the input, or Add file in the Files panel). They belong to the document: every chat of it lists them in its turn context and reads them like documents
// opened with open_document (an alias doc2, doc3, … shared with those, kind 'file' in the turn's docs; read with the doc
// parameter of read_document and find_in_document). They are read-only material for the model.
// Nothing is sent anywhere but the text the reading tools return. Extraction runs in the panel without network:
// text files (UTF-8, windows-1251 when UTF-8 fails), .docx (word/document.xml through a small zip reader and the
// built-in DecompressionStream), .pdf (the vendored pdf.js, loaded on the first PDF).
// Entry points: bindAttachments (main.js), openFilePicker (the + buttons), takeAttachments (runTurn: the chips go with
// the message), attachOnlyText (startTurn: a message with files only), hasAttachments (the Send button),
// readDocFiles / docFileEntries (refreshContext, snapshotDocument), loadAttachmentView (loadOpenDoc), attachedLine
// (the user bubble), docFileMeta / pendingDocFiles / readDocFileText / removeDocFile (the Files panel,
// doc-instructions.js), migrateChatFiles (refreshContext: files attached in chats by an earlier build), watchFilesStorage,
// sweepAttachmentBytes (the storage cleanup); the extraction: extractAttachment, decodeText, unzipEntry, docxText,
// pdfPageText, pdfText, loadPdfJs.
// Storage: the list under muninFiles:<docId> ([{alias, title, lines, pages?, size, addedAt}]), the extracted text under
// muninAttach:<docId>:<alias> ({name, format, text}; the lines and the outline are rebuilt from it), the original
// bytes in IndexedDB (database munin-files, store files, key <docId>:<alias>), kept for a later re-read. A list change
// runs under the Web Lock "munin:files:<docId>".
/* global $, addError, chatsKey, docOutline, el, FILES_PREFIX, fmtNum, MAX_DOC_FILES, nextDocAlias, renderFilesList,
   setStatus, state, updateActionState, withChatLock, withLock, ATTACH_PREFIX */
/* exported ATTACH_ACCEPT, ATTACH_MAX_CHARS, ATTACH_TRUNCATED, attachKey, attachBytesKey, filesKey, attachKind, decodeText, capText,
   unzipEntry, docxText, pdfPageText, joinHyphenated, pdfText, loadPdfJs, extractAttachment, addAttachmentFiles,
   removeAttachment, hasAttachments, attachOnlyText, takeAttachments, loadAttachmentView, attachedLine, readDocFiles,
   docFileEntries, docFileMeta, pendingDocFiles, readDocFileText, removeDocFile, openFilePicker, migrateChatFiles,
   sweepAttachmentBytes, bindAttachments, watchFilesStorage, attachState */

const ATTACH_MAX_CHARS = 2000000; // extracted characters kept per file
const ATTACH_MAX_BYTES = 50 * 1024 * 1024;
const ATTACH_TRUNCATED = '[truncated: the file has more text]';
const ATTACH_TEXT_EXTS = ['md', 'txt', 'csv', 'tsv', 'json', 'tex', 'bib', 'yaml', 'yml', 'xml', 'html', 'log'];
const ATTACH_ACCEPT = ['text/*', ...ATTACH_TEXT_EXTS.map((e) => '.' + e), '.docx', '.pdf'].join(',');
// pdf.js 5.7.284 (Apache-2.0): build/pdf.min.mjs and build/pdf.worker.min.mjs of
// https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-5.7.284.tgz (the npm package of the GitHub release v5.7.284 of
// mozilla/pdf.js), unmodified; licence and SHA-256 in vendor/NOTICES.txt.
const PDFJS_LIB = 'vendor/pdf.min.mjs';
const PDFJS_WORKER = 'vendor/pdf.worker.min.mjs';
const ATTACH_DB = 'munin-files';
const ATTACH_STORE = 'files';

const attachKey = (docId, alias) => `${ATTACH_PREFIX}${docId}:${alias}`;
const attachBytesKey = (docId, alias) => `${docId}:${alias}`;
const filesKey = (docId) => FILES_PREFIX + docId;
const filesLock = (docId, fn) => withLock('munin:files:' + docId, fn);
const isFileDoc = (d) => !!d && d.kind === 'file';
// Bytes from any realm (ArrayBuffer or a typed array) as a Uint8Array of this one.
const toBytes = (b) => (ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b));
const attachPlural = (n, word) => `${fmtNum(n)} ${word}${n === 1 ? '' : 's'}`;
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

// 'text' | 'markdown' | 'docx' | 'pdf' | 'doc' (refused) | null (not supported), by the extension, else a text/* type.
function attachKind(name, type) {
  const ext = ((/\.([a-z0-9]+)$/i.exec(String(name || '')) || [])[1] || '').toLowerCase();
  if (ext === 'doc' || ext === 'docx' || ext === 'pdf') return ext;
  if (ext === 'md') return 'markdown';
  if (ATTACH_TEXT_EXTS.includes(ext) || /^text\//i.test(String(type || ''))) return 'text';
  return null;
}

// ---- Extraction --------------------------------------------------------------------------------------
// UTF-8; a file that does not decode as UTF-8 but decodes cleanly as windows-1251 (no C1 controls, some Cyrillic)
// is an old Russian text file.
function decodeText(bytes) {
  const u8 = toBytes(bytes);
  const utf8 = new TextDecoder('utf-8').decode(u8);
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const cp = new TextDecoder('windows-1251', { fatal: true }).decode(u8);
    if (!/[\u0080-\u009f\ufffd]/.test(cp) && /[\u0400-\u04ff]/.test(cp)) return cp;
  } catch (e) { /* not windows-1251 either */ }
  return utf8;
}

// At most ATTACH_MAX_CHARS characters, cut at a line end, with a last line that says so.
function capText(text) {
  if (text.length <= ATTACH_MAX_CHARS) return text;
  const cut = text.slice(0, ATTACH_MAX_CHARS);
  const nl = cut.lastIndexOf('\n');
  return (nl > ATTACH_MAX_CHARS * 0.9 ? cut.slice(0, nl) : cut) + '\n' + ATTACH_TRUNCATED;
}

// One entry of a zip archive (its central directory, then the local header): the bytes, or null when the archive has
// no such entry. Stored (0) and deflated (8) entries; no ZIP64, no encryption (a .docx needs neither).
async function unzipEntry(bytes, wanted) {
  const u8 = toBytes(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('it is not a zip archive');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('its zip directory is damaged');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const skip = nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + skip;
    if (name !== wanted) continue;
    if (local + 30 > u8.length || dv.getUint32(local, true) !== 0x04034b50) throw new Error('its zip entry is damaged');
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = u8.subarray(start, start + size);
    if (method === 0) return data;
    if (method === 8) return inflateRaw(data);
    throw new Error(`its zip entry uses an unsupported compression (method ${method})`);
  }
  return null;
}
async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(data).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' };
const xmlText = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return XML_ENTITIES[e] != null ? XML_ENTITIES[e] : m;
  const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
});
const xmlAttr = (attrs, name) => (new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs || '') || [])[1];
// "heading 1" / "Heading1" -> 1, "Title" -> 1, others 0.
const docxHeadingLevel = (name) => {
  const s = String(name || '').toLowerCase().replace(/\s+/g, '');
  if (s === 'title') return 1;
  const m = /^heading([1-9])$/.exec(s);
  return m ? Math.min(6, Number(m[1])) : 0;
};
// styleId -> heading level from word/styles.xml: a localized Word names its styles "heading 1" but may give them
// other ids.
function docxHeadingStyles(stylesXml) {
  const map = new Map();
  for (const m of String(stylesXml || '').matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = xmlAttr(m[1], 'w:styleId');
    const lvl = docxHeadingLevel(xmlAttr((/<w:name\b([^>]*)>/.exec(m[2]) || [])[1], 'w:val'));
    if (id && lvl) map.set(id, lvl);
  }
  return map;
}

// The text of word/document.xml: one line per paragraph, headings as Markdown headings ("## Methods"), tables cell by
// cell ("[table 1]", then "[r1c2] text"), tabs kept, line breaks as spaces. Footnotes (word/footnotes.xml), deleted
// text of tracked changes (w:delText) and field codes are not read; the fallback copies of text boxes are skipped.
function docxText(xml, stylesXml = '') {
  const styles = docxHeadingStyles(stylesXml);
  const lines = [];
  const paras = []; // open paragraphs (a text box inside a run holds paragraphs of its own)
  const tables = []; // open tables: { no, row, col, cell: [texts] | null }
  let tableNo = 0;
  let inText = false;
  let inTabs = false; // the tab stops of a paragraph's properties (w:tabs) are no tabs
  let fallback = 0; // inside mc:Fallback (a second copy of what mc:Choice holds)
  const endPara = () => {
    const p = paras.pop();
    if (!p) return;
    const t = tables[tables.length - 1];
    const text = p.text.replace(/\s+$/, '');
    if (t && t.cell) { if (text.trim()) t.cell.push(text.trim()); return; }
    lines.push(p.level && text.trim() ? `${'#'.repeat(p.level)} ${text.trim()}` : text);
  };
  for (const m of String(xml).matchAll(/<(\/?)([\w:.-]+)((?:[^>"]|"[^"]*")*?)(\/?)>|([^<]+)/g)) {
    if (m[5] != null) {
      if (inText && !fallback && paras.length) paras[paras.length - 1].text += xmlText(m[5]);
      continue;
    }
    const [, close, tag, attrs, self] = m;
    if (tag === 'mc:Fallback') { if (!self) fallback += close ? -1 : 1; continue; }
    if (fallback) continue;
    const p = paras[paras.length - 1];
    const t = tables[tables.length - 1];
    switch (tag) {
      case 'w:p':
        if (!close) paras.push({ text: '', level: 0 });
        if (close || self) endPara();
        break;
      case 'w:pStyle':
        if (p) { const v = xmlAttr(attrs, 'w:val'); p.level = styles.get(v) || docxHeadingLevel(v); }
        break;
      case 'w:t': inText = !close && !self; break;
      case 'w:tabs': inTabs = !close && !self; break;
      case 'w:tab': if (p && !close && !inTabs) p.text += '\t'; break;
      case 'w:br': case 'w:cr': if (p && !close) p.text += ' '; break;
      case 'w:noBreakHyphen': if (p && !close) p.text += '-'; break;
      case 'w:tbl':
        if (!close) { tables.push({ no: ++tableNo, row: 0, col: 0, cell: null }); lines.push(`[table ${tableNo}]`); } else tables.pop();
        break;
      case 'w:tr': if (t && !close) { t.row++; t.col = 0; } break;
      case 'w:tc':
        if (!t) break;
        if (!close) { t.col++; t.cell = []; } else if (t.cell) { lines.push(`[r${t.row}c${t.col}] ${t.cell.join(' ')}`.trimEnd()); t.cell = null; }
        break;
    }
  }
  // Runs of empty paragraphs become one empty line.
  return lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim())).join('\n').trim();
}

// The text of one PDF page from pdf.js's getTextContent(): items in reading order; a new line at hasEOL or when the
// baseline moves, a space where a gap separates two items of one line; hyphenated line breaks joined (joinHyphenated).
function pdfPageText(content) {
  const out = [];
  let line = '';
  let lastY = null;
  let lastEnd = null;
  for (const it of (content && content.items) || []) {
    if (!it || typeof it.str !== 'string') continue; // marked-content items
    const tr = Array.isArray(it.transform) ? it.transform : null;
    const x = tr ? tr[4] : null;
    const y = tr ? tr[5] : null;
    const h = Math.abs(Number(it.height) || 0);
    if (line && lastY != null && y != null && Math.abs(y - lastY) > Math.max(1, h / 2)) {
      out.push(line); line = ''; lastEnd = null;
    } else if (line && it.str && lastEnd != null && x != null && x - lastEnd > Math.max(0.5, h * 0.15) && !/\s$/.test(line) && !/^\s/.test(it.str)) {
      line += ' ';
    }
    line += it.str;
    if (y != null) lastY = y;
    lastEnd = x != null ? x + (Number(it.width) || 0) : null;
    if (it.hasEOL) { out.push(line); line = ''; lastY = null; lastEnd = null; }
  }
  if (line) out.push(line);
  const lines = joinHyphenated(out.map((l) => l.replace(/\s+$/, '')));
  return lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim())).join('\n').trim();
}
// A word broken over two lines ("exam-" / "ple of …") is joined on the first line ("example" / "of …"), only when a
// lowercase letter stands on both sides of the hyphen (a soft hyphen too); "COVID-" / "19" stays.
function joinHyphenated(lines) {
  const out = lines.slice();
  for (let i = 0; i < out.length - 1; i++) {
    if (!/\p{Ll}[-\u00ad]$/u.test(out[i])) continue;
    const m = /^(\p{Ll}[\p{L}\p{M}'’]*[.,;:!?)\]]*)\s*(.*)$/u.exec(out[i + 1]);
    if (!m) continue;
    out[i] = out[i].slice(0, -1) + m[1];
    if (m[2]) out[i + 1] = m[2]; else out.splice(i + 1, 1);
  }
  return out;
}

// pdf.js, imported once on the first PDF (an ES module from the extension's own files; its worker is a module too).
// pdfjsImport is a seam for the tests (the vm bench has no dynamic import).
let pdfjsImport = (url) => import(url);
let pdfjsLoading = null;
function loadPdfJs() {
  if (!pdfjsLoading) {
    pdfjsLoading = Promise.resolve()
      .then(() => pdfjsImport(chrome.runtime.getURL(PDFJS_LIB)))
      .then((lib) => {
        if (!lib || typeof lib.getDocument !== 'function') throw new Error('the module has no getDocument');
        lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(PDFJS_WORKER);
        return lib;
      })
      .catch((e) => {
        pdfjsLoading = null; // the next PDF tries again
        throw new Error(`the PDF reader could not be loaded (${e && e.message ? e.message : e}). Reload the panel and attach the file again.`);
      });
  }
  return pdfjsLoading;
}

// The text of a PDF: "[page N]" before every page. Returns { text, pages }.
async function pdfText(bytes) {
  const lib = await loadPdfJs();
  let doc;
  try {
    doc = await lib.getDocument({ data: toBytes(bytes).slice(), isEvalSupported: false }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('the PDF is password-protected. Save a copy without the password and attach that.');
    throw new Error(`the PDF could not be opened (${e && e.message ? e.message : e}). Check that the file is a complete PDF.`);
  }
  try {
    const parts = [];
    let chars = 0;
    let words = 0;
    for (let n = 1; n <= doc.numPages && chars <= ATTACH_MAX_CHARS; n++) {
      const page = await doc.getPage(n);
      const text = pdfPageText(await page.getTextContent());
      if (typeof page.cleanup === 'function') page.cleanup();
      parts.push(`[page ${n}]`, text);
      chars += text.length + 10;
      if (/\p{L}/u.test(text)) words++;
    }
    if (!words) throw new Error('the PDF has no text layer (a scan?). Run text recognition (OCR) on it and attach the result.');
    return { text: parts.join('\n'), pages: doc.numPages };
  } finally {
    try { doc.destroy(); } catch (e) { /* ignore */ }
  }
}

// The text of a file: { text, format ('text' | 'markdown' | 'pdf'), lines, pages? }. Throws an Error whose message
// tells the user what to do.
async function extractAttachment(name, type, bytes) {
  const kind = attachKind(name, type);
  if (kind === 'doc') throw new Error('Word 97–2003 files (.doc) cannot be read. Save it as .docx first.');
  if (!kind) throw new Error('this file type cannot be attached. Attach text, Markdown, .docx or .pdf files.');
  let text;
  let pages;
  if (kind === 'docx') {
    let xml;
    let styles = null;
    try {
      xml = await unzipEntry(bytes, 'word/document.xml');
      styles = await unzipEntry(bytes, 'word/styles.xml').catch(() => null);
    } catch (e) { throw new Error(`it is not a valid .docx file (${e.message}). Open it in Word and save it as .docx again.`); }
    if (!xml) throw new Error('it has no document text (word/document.xml). Open it in Word and save it as .docx again.');
    text = docxText(new TextDecoder().decode(xml), styles ? new TextDecoder().decode(styles) : '');
  } else if (kind === 'pdf') {
    ({ text, pages } = await pdfText(bytes));
  } else {
    text = decodeText(bytes);
  }
  text = capText(String(text).replace(/\r\n?/g, '\n'));
  if (!text.trim()) throw new Error('the file has no text.');
  const format = kind === 'pdf' ? 'pdf' : kind === 'text' ? 'text' : 'markdown';
  return { text, format, lines: text.split('\n').length, ...(pages ? { pages } : {}) };
}

// ---- Adding files: chips before sending, or straight into the document's list ----------------------------------
// items: { id, name, size, type, status 'reading' | 'ready' | 'failed', promise, result, bytes, removed?, docId? }; per
// panel, never stored. attachState.items: the composer's chips (they go with the next message); attachState.pending:
// files added in the Files panel (docId: their document), stored as soon as they are read. target: where the picker's
// files go ('chat' | 'files'; openFilePicker).
const attachState = { items: [], pending: [], seq: 0, target: 'chat' };
const hasAttachments = () => attachState.items.length > 0;
const pendingDocFiles = (docId) => attachState.pending.filter((x) => x.docId === docId);

// target 'chat': chips in the composer; 'files': into the open document's list at once (the Files panel).
function addAttachmentFiles(files, target = 'chat') {
  const docId = state.docId;
  if (target === 'files' && !docId) return;
  for (const f of Array.from(files || [])) {
    const kind = attachKind(f.name, f.type);
    if (kind === 'doc') { addError(`${f.name} is an old Word file (.doc). Save it as .docx first.`); continue; }
    if (!kind) { addError(`${f.name} cannot be attached. Attach text, Markdown, .docx or .pdf files.`); continue; }
    if (f.size > ATTACH_MAX_BYTES) { addError(`${f.name} is larger than ${fmtSize(ATTACH_MAX_BYTES)} and cannot be attached.`); continue; }
    const item = { id: ++attachState.seq, name: f.name, size: f.size, type: f.type || '', status: 'reading', result: null, bytes: null };
    if (target === 'files') { item.docId = docId; attachState.pending.push(item); } else attachState.items.push(item);
    item.promise = readAttachment(item, f);
  }
  renderAttachChips();
  renderFilesList();
}

async function readAttachment(item, file) {
  try {
    const bytes = toBytes(await file.arrayBuffer());
    item.result = await extractAttachment(item.name, item.type, bytes);
    item.bytes = bytes;
    item.status = 'ready';
  } catch (e) {
    item.status = 'failed';
    if (!item.removed) addError(`Could not read ${item.name}: ${e && e.message ? e.message : e}`);
    attachState.items = attachState.items.filter((x) => x !== item);
  }
  if (item.docId) { // added in the Files panel: stored now
    if (item.status === 'ready') await storeDocFiles(item.docId, [item]);
    attachState.pending = attachState.pending.filter((x) => x !== item);
  }
  renderAttachChips();
  renderFilesList();
}

function removeAttachment(id) {
  const item = attachState.items.find((x) => x.id === id);
  if (item) item.removed = true;
  attachState.items = attachState.items.filter((x) => x.id !== id);
  renderAttachChips();
}

function renderAttachChips() {
  const row = $('attachRow');
  if (!row) return;
  row.textContent = '';
  for (const item of attachState.items) {
    const chip = document.createElement('span');
    chip.className = 'attach-chip' + (item.status === 'reading' ? ' reading' : '');
    chip.dataset.id = String(item.id);
    const name = document.createElement('span');
    name.className = 'attach-name';
    name.textContent = item.name;
    name.dataset.tip = item.name;
    const meta = document.createElement('span');
    meta.className = 'attach-meta';
    meta.textContent = item.status === 'reading' ? 'reading…' : item.result && item.result.pages ? attachPlural(item.result.pages, 'page') : fmtSize(item.size);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'attach-remove';
    x.textContent = '×';
    x.dataset.tip = 'Remove';
    x.setAttribute('aria-label', `Remove ${item.name}`);
    x.addEventListener('click', () => removeAttachment(item.id));
    chip.append(name, meta, x);
    row.appendChild(chip);
  }
  row.classList.toggle('hidden', !attachState.items.length);
  if (typeof updateActionState === 'function') updateActionState();
}

// The text of a message sent with files only: "Attached notes.pdf" (startTurn), or '' without files.
const attachOnlyText = () => (attachState.items.length ? 'Attached ' + attachState.items.map((x) => x.name).join(', ') : '');

// The chips go with the turn's message (runTurn): the read files join the document's list (storeDocFiles). Returns the
// message's _files: [{alias, title, lines, pages?}].
async function takeAttachments(chatCtx) {
  if (!attachState.items.length) return [];
  const items = attachState.items.slice();
  if (items.some((x) => x.status === 'reading')) setStatus('Reading the attached files…');
  await Promise.all(items.map((x) => x.promise));
  attachState.items = attachState.items.filter((x) => !items.includes(x));
  renderAttachChips();
  const ready = items.filter((x) => x.status === 'ready' && !x.removed);
  if (!ready.length || !chatCtx || !chatCtx.docId) return [];
  return storeDocFiles(chatCtx.docId, ready);
}

// ---- The document's list ----------------------------------------------------------------------------------
const isAlias = (a) => typeof a === 'string' && /^doc\d+$/.test(a);
const validFiles = (v) => (Array.isArray(v) ? v.filter((f) => f && isAlias(f.alias) && typeof f.title === 'string' && Number.isFinite(f.lines)) : []);
// The documents opened with open_document in the chats (their aliases are taken for the document's files too).
const openedDocs = (chats) => (chats || []).flatMap((c) => (c && Array.isArray(c.docs) ? c.docs : [])).filter((d) => d && isAlias(d.alias) && !isFileDoc(d));

async function readDocFiles(docId) {
  if (!docId) return [];
  try { return validFiles((await chrome.storage.local.get(filesKey(docId)))[filesKey(docId)]); } catch (e) { return []; }
}
// The files as entries of a turn's docs (snapshotDocument): read like opened documents, marked "(file)".
const docFileEntries = (files) => validFiles(files).map((f) => ({
  alias: f.alias, id: 'file:' + f.alias, kind: 'file', title: f.title, lines: f.lines, size: f.size, ...(f.pages ? { pages: f.pages } : {}),
}));
// "12 pages · doc2" / "14 KB · doc3": the meta of a row in the Files list.
const docFileMeta = (f) => `${f.pages ? attachPlural(f.pages, 'page') : fmtSize(Number(f.size) || 0)} · ${f.alias}`;

// Adds read files (items with result, name, size, type, bytes) to the document's list: each gets the next alias free in
// the list and among the documents opened in its chats, its text a key, its bytes an IndexedDB record. Returns
// [{alias, title, lines, pages?}] of the stored files.
function storeDocFiles(docId, items) {
  return filesLock(docId, async () => {
    let list;
    let chats;
    try {
      const got = await chrome.storage.local.get([filesKey(docId), chatsKey(docId)]);
      list = validFiles(got[filesKey(docId)]);
      chats = Array.isArray(got[chatsKey(docId)]) ? got[chatsKey(docId)] : [];
    } catch (e) {
      addError('Could not store the attached files. Free some browser storage and attach them again.');
      return [];
    }
    const opened = openedDocs(docId === state.docId ? [...chats, ...state.chats] : chats);
    const added = [];
    const texts = {};
    const bytes = [];
    for (const it of items) {
      if (list.length >= MAX_DOC_FILES) {
        addError(`${it.name} was not added: a document holds at most ${MAX_DOC_FILES} files. Remove one in Files first.`);
        continue;
      }
      const r = it.result;
      const alias = nextDocAlias([...opened, ...list]);
      const pages = r.pages ? { pages: r.pages } : {};
      list.push({ alias, title: it.name, lines: r.lines, ...pages, size: it.size, addedAt: Date.now() });
      texts[attachKey(docId, alias)] = { name: it.name, format: r.format, text: r.text };
      bytes.push([attachBytesKey(docId, alias), { name: it.name, type: it.type, size: it.size, bytes: it.bytes, addedAt: Date.now() }]);
      added.push({ alias, title: it.name, lines: r.lines, ...pages });
    }
    if (!added.length) return [];
    try {
      await chrome.storage.local.set({ ...texts, [filesKey(docId)]: list });
    } catch (e) {
      addError('Could not store the attached files. Free some browser storage and attach them again.');
      return [];
    }
    if (docId === state.docId) { state.docFiles = list; renderFilesList(); }
    // The original bytes are a convenience (nothing reads them yet): a failure is not the user's problem.
    for (const [key, value] of bytes) await putAttachmentBytes(key, value).catch((e) => console.warn('Munin: file bytes not stored:', e && e.message));
    return added;
  });
}

// Remove in the Files panel: the entry, the text and the bytes. Returns whether it was removed.
function removeDocFile(docId, alias) {
  if (!docId) return Promise.resolve(false);
  return filesLock(docId, async () => {
    try {
      const next = validFiles((await chrome.storage.local.get(filesKey(docId)))[filesKey(docId)]).filter((f) => f.alias !== alias);
      if (next.length) await chrome.storage.local.set({ [filesKey(docId)]: next }); else await chrome.storage.local.remove(filesKey(docId));
      await chrome.storage.local.remove(attachKey(docId, alias));
      if (docId === state.docId) state.docFiles = next;
    } catch (e) {
      addError(`Could not remove the file (${e.message}). Try again.`);
      return false;
    }
    await deleteAttachmentBytes([attachBytesKey(docId, alias)]).catch(() => {}); // else the storage cleanup sweeps them
    renderFilesList();
    return true;
  });
}

// The stored text of a file (the Files viewer), or null when it is gone.
async function readDocFileText(docId, alias) {
  if (!docId) return null;
  try {
    const v = (await chrome.storage.local.get(attachKey(docId, alias)))[attachKey(docId, alias)];
    return v && typeof v.text === 'string' ? v.text : null;
  } catch (e) {
    return null;
  }
}

// Files attached in a chat by an earlier build (a chat meta's docs entry {alias, id: 'file:<chatId>:<alias>', kind:
// 'file', title, lines, size, pages?}, the text under muninAttach:<docId>:<chatId>:<alias>, the bytes under
// <docId>:<chatId>:<alias>) move to the document's list once, silently, when the document opens. In the order they were
// attached, a file keeps its alias unless an earlier file or a document opened in any chat of the document holds it;
// the others get the next free alias. An entry whose text is gone is dropped. Runs under the files lock, then the chat
// list's (the only place that holds both).
async function migrateChatFiles(docId) {
  try {
    const peek = (await chrome.storage.local.get(chatsKey(docId)))[chatsKey(docId)];
    if (!Array.isArray(peek) || !peek.some((c) => c && Array.isArray(c.docs) && c.docs.some(isFileDoc))) return;
    await filesLock(docId, () => withChatLock(docId, async () => {
      const got = await chrome.storage.local.get([chatsKey(docId), filesKey(docId)]);
      const chats = Array.isArray(got[chatsKey(docId)]) ? got[chatsKey(docId)] : [];
      const list = validFiles(got[filesKey(docId)]);
      const moves = [];
      for (const c of chats) {
        for (const d of (c && Array.isArray(c.docs) ? c.docs : []).filter(isFileDoc)) {
          const from = `${docId}:${c.id}:${d.alias}`;
          const rec = await getAttachmentBytes(from).catch(() => null);
          moves.push({ d, from, oldKey: ATTACH_PREFIX + from, at: (rec && rec.addedAt) || c.createdAt || 0 });
        }
      }
      if (!moves.length) return;
      moves.sort((a, b) => a.at - b.at || (Number(String(a.d.alias).slice(3)) || 0) - (Number(String(b.d.alias).slice(3)) || 0));
      const opened = openedDocs(chats);
      const taken = (a) => opened.some((x) => x.alias === a) || list.some((x) => x.alias === a);
      const texts = await chrome.storage.local.get(moves.map((m) => m.oldKey));
      const items = {};
      const bytes = [];
      for (const m of moves) {
        const t = texts[m.oldKey];
        if (!t || typeof t.text !== 'string') continue; // its text is gone: nothing to move
        const alias = isAlias(m.d.alias) && !taken(m.d.alias) ? m.d.alias : nextDocAlias([...opened, ...list]);
        list.push({ alias, title: String(m.d.title || t.name || 'file'), lines: Number.isFinite(m.d.lines) ? m.d.lines : t.text.split('\n').length,
          ...(m.d.pages ? { pages: m.d.pages } : {}), size: Number(m.d.size) || 0, addedAt: m.at || Date.now() });
        items[attachKey(docId, alias)] = t;
        bytes.push([m.from, attachBytesKey(docId, alias)]);
      }
      for (const c of chats) if (c && Array.isArray(c.docs)) c.docs = c.docs.filter((d) => !isFileDoc(d));
      await chrome.storage.local.set({ ...items, [filesKey(docId)]: list, [chatsKey(docId)]: chats });
      await chrome.storage.local.remove(moves.map((m) => m.oldKey));
      for (const [from, to] of bytes) await moveAttachmentBytes(from, to).catch(() => {}); // else the cleanup sweeps them
    }));
  } catch (e) {
    console.warn('Munin: attached files not moved to the document:', e && e.message);
  }
}

// "Attached: notes.pdf (12 pages, 430 lines)": a line of the user bubble per file of the message.
const attachedLine = (f) => `Attached: ${f.title} (${f.pages ? attachPlural(f.pages, 'page') + ', ' : ''}${attachPlural(f.lines, 'line')})`;

// ---- Reading (loadOpenDoc) ----------------------------------------------------------------------------
// The view of an attached file for the reading tools, read from storage once per turn (snap.fileCache: not docCache,
// whose entries taint the turn; the user's own files do not). Returns the view or { error }.
async function loadAttachmentView(entry, snap) {
  const cache = snap.fileCache || (snap.fileCache = new Map());
  if (cache.has(entry.alias)) return cache.get(entry.alias);
  const key = attachKey(snap.docId || state.docId, entry.alias);
  let stored = null;
  try { stored = (await chrome.storage.local.get(key))[key]; } catch (e) { /* missing below */ }
  if (!stored || typeof stored.text !== 'string') return { error: `the attached file "${entry.title}" is no longer stored. Ask the user to attach it again.` };
  const docText = stored.text;
  const view = { docText, docFormat: stored.format === 'markdown' ? 'markdown' : 'text', model: null, title: entry.title, lines: null, selection: '', docError: '' };
  view.outline = stored.format === 'pdf' ? pageOutline(docText) : stored.format === 'markdown' ? docOutline({ docText, docFormat: 'markdown' }) : [];
  cache.set(entry.alias, view);
  return view;
}
// The "[page N]" lines of a PDF's text as its outline.
function pageOutline(text) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    const m = /^\[page (\d+)\]$/.exec(l);
    if (m) out.push({ line: i + 1, level: 1, title: `Page ${m[1]}` });
  });
  return out;
}

// ---- Storage: IndexedDB for the bytes, cleanup ------------------------------------------------------------
let attachDbOpening = null;
function attachDb() {
  if (!attachDbOpening) {
    attachDbOpening = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('IndexedDB is not available')); return; }
      const req = indexedDB.open(ATTACH_DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(ATTACH_STORE)) req.result.createObjectStore(ATTACH_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB could not be opened'));
    }).catch((e) => { attachDbOpening = null; throw e; });
  }
  return attachDbOpening;
}
async function attachStore(mode, fn) {
  const db = await attachDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ATTACH_STORE, mode);
    const req = fn(tx.objectStore(ATTACH_STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = tx.onerror;
  });
}
const putAttachmentBytes = (key, value) => attachStore('readwrite', (s) => s.put(value, key));
const getAttachmentBytes = (key) => attachStore('readonly', (s) => s.get(key));
const attachmentByteKeys = () => attachStore('readonly', (s) => s.getAllKeys());
const deleteAttachmentBytes = (keys) => (keys.length ? attachStore('readwrite', (s) => { keys.forEach((k) => s.delete(k)); }) : Promise.resolve());
async function moveAttachmentBytes(from, to) {
  const value = await getAttachmentBytes(from);
  if (value !== undefined) await putAttachmentBytes(to, value);
  await deleteAttachmentBytes([from]);
}

// The storage cleanup (runStorageCleanup): bytes whose file is gone (<docId>:<alias> not in the document's list) and
// bytes of an earlier build's chat file (<docId>:<chatId>:<alias>) whose chat is gone. Returns the removed keys.
async function sweepAttachmentBytes() {
  let keys;
  try { keys = await attachmentByteKeys(); } catch (e) { return []; }
  const byDoc = new Map();
  for (const k of keys) {
    const parts = String(k).split(':');
    if (!byDoc.has(parts[0])) byDoc.set(parts[0], []);
    byDoc.get(parts[0]).push({ k, parts });
  }
  const drop = [];
  for (const [docId, list] of byDoc) {
    const got = await chrome.storage.local.get([chatsKey(docId), filesKey(docId)]);
    const ids = new Set(Array.isArray(got[chatsKey(docId)]) ? got[chatsKey(docId)].map((c) => c && c.id) : []);
    const aliases = new Set(validFiles(got[filesKey(docId)]).map((f) => f.alias));
    for (const { k, parts } of list) if (parts.length > 2 ? !ids.has(parts[1]) : !aliases.has(parts[1])) drop.push(k);
  }
  try { await deleteAttachmentBytes(drop); } catch (e) { return []; }
  return drop;
}

// ---- Wiring --------------------------------------------------------------------------------------------
const hasDraggedFiles = (e) => !!(e && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
// Where a dropped file is attached: the messages (the empty state and the cards in them), the splitter and the composer.
// The layers over the chat (Settings, Files, the menus) are other nodes: a drop there attaches nothing.
const inDropArea = (node) => !!node && [el.chat, el.splitter, el.composer].some((n) => n && n.contains(node));
const setDropTint = (on) => el.composer.classList.toggle('drop-target', on);
// The files of a paste into the input (copied in a file manager); an image among them is refused like a dropped one.
// Text with only images beside it is a text paste (cells copied from a spreadsheet carry a picture of themselves).
function pastedFiles(e) {
  const cd = e && e.clipboardData;
  const files = Array.from((cd && cd.files) || []);
  if (!files.length) return [];
  const text = Array.from(cd.types || []).includes('text/plain');
  return text && files.every((f) => /^image\//i.test(f.type || '')) ? [] : files;
}
// The one file picker: target 'chat' (the composer's +: chips) or 'files' (Add file in the Files panel).
function openFilePicker(target = 'chat') {
  const input = $('attachInput');
  if (!input) return;
  attachState.target = target === 'files' ? 'files' : 'chat';
  input.click();
}
function bindAttachments() {
  const btn = $('attachBtn');
  const input = $('attachInput');
  if (!btn || !input || !el.composer || !el.input) return;
  input.accept = ATTACH_ACCEPT;
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // the input box keeps the focus
  btn.addEventListener('click', () => openFilePicker('chat'));
  input.addEventListener('change', () => { addAttachmentFiles(input.files, attachState.target); input.value = ''; attachState.target = 'chat'; });
  // Files dragged anywhere in the panel are stopped (a file dropped on the page would replace it); over the chat area
  // the composer's tint shows that a drop attaches them.
  document.addEventListener('dragover', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    const on = inDropArea(e.target);
    if (on) e.dataTransfer.dropEffect = 'copy';
    setDropTint(on);
  });
  document.addEventListener('dragleave', (e) => { if (!inDropArea(e.relatedTarget)) setDropTint(false); });
  document.addEventListener('drop', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    setDropTint(false);
    const files = e.dataTransfer.files;
    if (files && files.length && inDropArea(e.target)) addAttachmentFiles(files);
  });
  el.input.addEventListener('paste', (e) => {
    const files = pastedFiles(e);
    if (!files.length) return; // text: the browser pastes it
    e.preventDefault();
    addAttachmentFiles(files);
  });
}

// Another tab added or removed a file of this document: the list (and the next turn) follow. Registered once, by
// refreshContext (like watchInstructionsStorage).
let filesWatched = false;
function watchFilesStorage() {
  const ev = chrome.storage && chrome.storage.onChanged;
  if (filesWatched || !ev || typeof ev.addListener !== 'function') return;
  filesWatched = true;
  ev.addListener((changes, area) => {
    if ((area && area !== 'local') || !changes || !state.docId || state.loadingCtx) return;
    const c = changes[filesKey(state.docId)];
    if (!c) return;
    state.docFiles = validFiles(c.newValue);
    renderFilesList();
  });
}
