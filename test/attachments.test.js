'use strict';
// Attached files (src/attachments.js): a file attached to a message joins the document's files (an alias shared with
// open_document, kind 'file' in a turn's docs), listed in the turn context of every chat of the document with "(file)"
// and read with the doc parameter; it does not taint the turn. The
// extraction: Markdown, .docx (a zip built here with zlib), windows-1251 text, the 2 MB cap, the .doc refusal, the PDF
// page text (pdf.js cannot run in the vm: a fake getTextContent result and a fake pdf.js module) and the lazy loader's
// error path. Storage: the document's list and the text key survive a reload; deleting a chat keeps them; Remove deletes
// the text, the bytes and the entry; the storage cleanup sweeps orphans; per-chat files of an earlier build move once.
const { test, before } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { load, deq, waitFor } = require('./lib/sandbox');
const { docBench, recordFetch, useProvider, send, oaTool, oaText } = require('./lib/context');

let env, T, state, storage;
const bytesOf = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
// A File as the panel sees it (name, size, type, arrayBuffer()).
const fakeFile = (name, data, type = '') => {
  const b = typeof data === 'string' ? bytesOf(data) : data;
  return { name, size: b.length, type, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
};
const errors = () => T.el.chat.children.filter((c) => c.classList && c.classList.contains('error')).map((c) => c.innerHTML);
const fileBytes = (e) => (e.idb.dbs.get('munin-files') || new Map()).get('files') || new Map();

before(async () => {
  env = await load();
  ({ T, state, storage } = env);
  docBench(env).doc.text = '# My Doc\n\nMain text.';
  await T.refreshContext({ force: true });
});

// ---- A zip archive (stored or deflated entries) for the .docx tests -------------------------------------
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text, method = 8] of entries) {
    const raw = Buffer.from(text, 'utf8');
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cdBuf, eocd]));
}
const W = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="x" xmlns:mc="y"><w:body>${body}</w:body></w:document>`;
const para = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const DOCX_XML = W(
  para('A tiny paper', 'Title') +
  para('Introduction', 'Heading1') +
  '<w:p><w:r><w:t>Rafts are </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>small</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:t xml:space="preserve"> &amp; fast.</w:t></w:r></w:p>' +
  '<w:p/><w:p/>' +
  para('Methods', 'Berschrift2') +
  '<w:p><w:r><w:t>Step</w:t><w:tab/><w:t>one</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>' +
  '<w:p><w:r><mc:AlternateContent><mc:Choice><w:txbxContent><w:p><w:r><w:t>Box text</w:t></w:r></w:p></w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent><w:p><w:r><w:t>Box text</w:t></w:r></w:p></w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p>' +
  '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Size</w:t></w:r></w:p></w:tc></w:tr>' +
  '<w:tr><w:tc><w:p><w:r><w:t>Raft</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10</w:t></w:r></w:p><w:p><w:r><w:t>nm</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
  para('The end.'));
// A localized Word: the style id "Berschrift2" is named "heading 2".
const STYLES_XML = '<w:styles><w:style w:type="paragraph" w:styleId="Berschrift2"><w:name w:val="heading 2"/></w:style></w:styles>';

test('.docx: paragraphs as lines, headings from the styles (also a localized id), tables cell by cell; footnote marks, deleted text, tab stops and the fallback copy skipped', async () => {
  const bytes = zip([['[Content_Types].xml', '<Types/>', 0], ['word/document.xml', DOCX_XML], ['word/styles.xml', STYLES_XML]]);
  const r = await T.extractAttachment('paper.docx', '', bytes);
  assert.strictEqual(r.format, 'markdown');
  deq(r.text.split('\n'), [
    '# A tiny paper', '# Introduction', 'Rafts are small & fast.', '', '## Methods', 'Step\tone', 'Box text', '',
    '[table 1]', '[r1c1] Name', '[r1c2] Size', '[r2c1] Raft', '[r2c2] 10 nm', 'The end.',
  ]); // the text box's paragraph comes first, its empty outer paragraph after it
  assert.strictEqual(r.lines, r.text.split('\n').length);
  // Not a zip, or a zip without word/document.xml: a readable error.
  await assert.rejects(T.extractAttachment('bad.docx', '', bytesOf('not a zip at all, just some text here')), /not a valid \.docx file.*save it as \.docx again/i);
  await assert.rejects(T.extractAttachment('empty.docx', '', zip([['a.txt', 'x']])), /no document text/);
});

test('text files: UTF-8; windows-1251 when UTF-8 fails; CRLF; the 2 MB cap with the truncation line', async () => {
  const r = await T.extractAttachment('notes.txt', 'text/plain', bytesOf('One\r\nTwo\r\n'));
  deq([r.text, r.format, r.lines], ['One\nTwo\n', 'text', 3]);
  // "Привет, мир" in windows-1251: А..я = 0xC0..0xFF.
  const cp = Uint8Array.from([...'Привет, мир'].map((c) => (c >= 'А' && c <= 'я' ? c.charCodeAt(0) - 0x410 + 0xc0 : c.charCodeAt(0))));
  assert.strictEqual((await T.extractAttachment('old.txt', '', cp)).text, 'Привет, мир');
  assert.strictEqual(T.decodeText(bytesOf('Привет')), 'Привет');
  // Bytes that are neither UTF-8 nor Cyrillic windows-1251: the UTF-8 reading with replacement characters stays.
  assert.ok(T.decodeText(Uint8Array.from([0x41, 0x98, 0x42])).includes('\uFFFD'));
  const big = ('x'.repeat(99) + '\n').repeat(21000); // 2.1 million characters
  const capped = await T.extractAttachment('big.log', '', bytesOf(big));
  assert.ok(capped.text.endsWith('\n[truncated: the file has more text]'));
  assert.ok(capped.text.length <= T.ATTACH_MAX_CHARS + 40 && capped.text.length > T.ATTACH_MAX_CHARS * 0.9);
  // Types: by extension, else text/*; .doc refused with what to do.
  deq(['a.md', 'a.TXT', 'a.bib', 'a.docx', 'a.pdf', 'a.doc', 'a.py', 'a.zip'].map((n) => T.attachKind(n, n === 'a.py' ? 'text/x-python' : '')),
    ['markdown', 'text', 'text', 'docx', 'pdf', 'doc', 'text', null]);
  await assert.rejects(T.extractAttachment('old.doc', '', bytesOf('x')), /Save it as \.docx first\./);
});

test('the + flow: a .doc is refused with an error, an unknown type too; a read file becomes a ready chip, × removes it', async () => {
  T.addAttachmentFiles([fakeFile('old.doc', 'x'), fakeFile('photo.png', 'x', 'image/png')]);
  assert.strictEqual(T.attachState.items.length, 0);
  const n = errors();
  assert.ok(n.some((t) => t.includes('old.doc is an old Word file (.doc). Save it as .docx first.')));
  assert.ok(n.some((t) => t.includes('photo.png cannot be attached.')));
  T.addAttachmentFiles([fakeFile('draft.md', '# Draft\n\nText.')]);
  assert.strictEqual(T.attachState.items[0].status, 'reading');
  await T.attachState.items[0].promise;
  assert.strictEqual(T.attachState.items[0].status, 'ready');
  T.removeAttachment(T.attachState.items[0].id);
  assert.strictEqual(T.attachState.items.length, 0);
  // A file that cannot be read leaves an error with its name and no chip.
  T.addAttachmentFiles([fakeFile('blank.txt', '   ')]);
  await T.attachState.items[0].promise;
  assert.strictEqual(T.attachState.items.length, 0);
  assert.ok(errors().some((t) => t.includes('Could not read blank.txt: the file has no text.')));
});

test('a .md file attached: the next request lists it as a file, read_lines(doc: alias) returns its lines; no taint; stored with the document', async () => {
  useProvider(env, 'openai');
  T.addAttachmentFiles([fakeFile('notes.md', '# Notes\n\nFirst point.\n\n## Part two\n\nSecond point.')]);
  const bodies = recordFetch(env, [oaTool('c1', 'read_document', { scope: { start: 1, end: 7 }, include: ['text'], doc: 'doc2' }), oaText('Read it.')]);
  await send(env, '');
  const user = state.messages.find((m) => m.role === 'user');
  assert.strictEqual(user.content, 'Attached notes.md'); // an empty message with a file
  deq(user._files, [{ alias: 'doc2', title: 'notes.md', lines: 7 }]);
  assert.ok(user._context.includes('doc2 "notes.md" (file) (7 lines)'), user._context);
  assert.ok(JSON.stringify(bodies[0]).includes('doc2 \\"notes.md\\" (file) (7 lines)'));
  const out = state.messages.find((m) => m.role === 'tool');
  assert.ok(out.content.startsWith('Lines 1-7 of 7:\n1: # Notes\n2: \n3: First point.'), out.content);
  assert.strictEqual(T.attachState.items.length, 0); // the chips went with the message
  // Stored with the document: the list, the text under its key, the bytes in IndexedDB; nothing on the chat meta.
  const list = storage['muninFiles:DOC123'];
  assert.ok(Number.isFinite(list[0].addedAt));
  deq(list.map(({ addedAt, ...f }) => f), [{ alias: 'doc2', title: 'notes.md', lines: 7, size: 49 }]);
  deq(state.docFiles, list);
  const meta = storage['muninChats:DOC123'].find((c) => c.id === state.chatId);
  assert.ok(!(meta.docs || []).length, JSON.stringify(meta.docs));
  deq(storage['muninAttach:DOC123:doc2'], { name: 'notes.md', format: 'markdown', text: '# Notes\n\nFirst point.\n\n## Part two\n\nSecond point.' });
  assert.ok(fileBytes(env).has('DOC123:doc2'));
  // Read in a turn snapshot: the outline from its headings, get_selection refused, and the turn is not tainted.
  const snap = T.takeSnapshot(); T.snapshotDocument(snap);
  snap.chatCtx = { docId: 'DOC123', chatId: state.chatId, messages: state.messages };
  const call = (name, args) => T.executeTool({ id: 'x' + name, function: { name, arguments: JSON.stringify(args) } }, 'edit', snap);
  const outline = await call('read_document', { scope: 'outline', include: null, doc: 'doc2' });
  assert.ok(outline.content.includes('L1: # Notes') && outline.content.includes('L5: ## Part two'), outline.content);
  const found = await call('find_in_document', { query: 'Second point', doc: 'doc2' });
  assert.ok(found._ok && found.content.includes('7'), found.content);
  assert.ok((await call('get_selection', { doc: 'doc2' })).content.startsWith('Error: get_selection works only on the main document'));
  assert.ok(!snap.tainted, 'an attached file does not taint the turn');
  assert.strictEqual(snap.docCache.size, 0);
});

test('a file attached in chat A is listed in the turn context of chat B and read there by alias; aliases stay unique in the document', async () => {
  const chatA = state.chatId;
  await T.createChat();
  assert.notStrictEqual(state.chatId, chatA);
  const snap = T.takeSnapshot(); T.snapshotDocument(snap);
  deq(snap.docs.map((d) => [d.alias, d.kind, d.title]), [['doc2', 'file', 'notes.md']]);
  assert.ok(T.buildTurnContext('edit', snap, null).includes('doc2 "notes.md" (file) (7 lines)'));
  const r = await T.readingTarget('read_document', { doc: 'doc2' }, snap);
  deq(T.docLines(r.target).slice(0, 3), ['# Notes', '', 'First point.']);
  // A document opened in chat A holds doc3: the next file of the document skips it, and open_document in chat B
  // continues after the files.
  const metaA = state.chats.find((c) => c.id === chatA);
  metaA.docs = [{ alias: 'doc3', id: 'GDOC3', title: 'Ref', lines: 4 }];
  await T.storageSet({ 'muninChats:DOC123': state.chats });
  const item = { name: 'more.txt', size: 3, type: 'text/plain', bytes: bytesOf('abc'), result: { text: 'abc', format: 'text', lines: 1 } };
  deq(await T.storeDocFiles('DOC123', [item]), [{ alias: 'doc4', title: 'more.txt', lines: 1 }]);
  deq(state.docFiles.map((f) => f.alias), ['doc2', 'doc4']);
  const snapB = T.takeSnapshot(); T.snapshotDocument(snapB);
  deq(snapB.docs.map((d) => d.alias), ['doc2', 'doc4']);
  assert.strictEqual(T.nextDocAlias(snapB.docs), 'doc5');
  // The persisted meta of a chat never takes the files (rememberChatDocs).
  snapB.chatCtx = { docId: 'DOC123', chatId: state.chatId };
  await T.rememberChatDocs(snapB);
  assert.ok(!(state.chats.find((c) => c.id === state.chatId).docs || []).some((d) => d.kind === 'file'));
  state.chats.find((c) => c.id === chatA).docs = []; // storageSet adopted a merged copy of the list
  await T.storageSet({ 'muninChats:DOC123': state.chats });
  assert.strictEqual(await T.removeDocFile('DOC123', 'doc4'), true);
  await T.switchChat(chatA);
});

test('a reload rebuilds the attachment from storage; a file whose text is gone gives a readable error', async () => {
  const chatId = state.chatId;
  const env2 = await load();
  Object.assign(env2.storage, JSON.parse(JSON.stringify(storage)));
  docBench(env2);
  await env2.T.refreshContext({ force: true });
  assert.strictEqual(env2.state.chatId, chatId);
  const snap = env2.T.takeSnapshot(); env2.T.snapshotDocument(snap);
  deq(snap.docs.map((d) => [d.alias, d.kind, d.title]), [['doc2', 'file', 'notes.md']]);
  assert.ok(env2.T.buildTurnContext('edit', snap, null).includes('doc2 "notes.md" (file) (7 lines)'));
  const r = await env2.T.readingTarget('read_document', { doc: 'doc2' }, snap);
  deq(env2.T.docLines(r.target), ['# Notes', '', 'First point.', '', '## Part two', '', 'Second point.']);
  // The history shows the "Attached:" line from _files.
  assert.strictEqual(env2.T.attachedLine({ title: 'notes.md', lines: 7 }), 'Attached: notes.md (7 lines)');
  assert.strictEqual(env2.T.attachedLine({ title: 'p.pdf', lines: 1, pages: 12 }), 'Attached: p.pdf (12 pages, 1 line)');
  delete env2.storage['muninAttach:DOC123:doc2'];
  const snap2 = env2.T.takeSnapshot(); env2.T.snapshotDocument(snap2);
  const gone = await env2.T.readingTarget('read_document', { doc: 'doc2' }, snap2);
  assert.match(gone.error, /no longer stored\. Ask the user to attach it again\./);
});

test('deleting a chat keeps the document\'s files; Remove deletes the text, the bytes and the entry; the cleanup sweeps orphans', async () => {
  const chatId = state.chatId;
  await T.createChat(); // a second chat, so the first can go
  await T.deleteChat(chatId);
  assert.ok(!state.chats.some((c) => c.id === chatId));
  assert.ok(storage['muninAttach:DOC123:doc2'] && fileBytes(env).has('DOC123:doc2'));
  deq(state.docFiles.map((f) => f.alias), ['doc2']);
  // Orphans: bytes and a text without an entry in the list, an earlier build's chat file of a chat that is gone, bytes
  // of a document without a chat list; the listed file stays.
  const files = fileBytes(env);
  files.set('DOC123:doc9', { name: 'x' });
  files.set('DOC123:gonechat:doc2', { name: 'y' });
  files.set('NODOC:doc2', { name: 'z' });
  storage['muninAttach:DOC123:doc9'] = { name: 'x', format: 'text', text: 'x' };
  storage['muninAttach:DOC123:gonechat:doc2'] = { name: 'y', format: 'text', text: 'y' };
  env.chrome.storage.local.getKeys = async () => Object.keys(storage); // Chrome lists the keys
  await T.runStorageCleanup(Date.now() + 3 * 24 * 3600 * 1000);
  deq([...files.keys()], ['DOC123:doc2']);
  assert.ok(!('muninAttach:DOC123:doc9' in storage) && !('muninAttach:DOC123:gonechat:doc2' in storage));
  assert.ok(storage['muninAttach:DOC123:doc2'] && storage['muninFiles:DOC123']);
  deq(T.parseChatKey('muninAttach:DOC123:abc:doc2'), { prefix: 'muninAttach:', docId: 'DOC123', chatId: 'abc' });
  deq(T.parseChatKey('muninAttach:DOC123:doc2'), { prefix: 'muninAttach:', docId: 'DOC123', chatId: null, alias: 'doc2' });
  deq(T.parseChatKey('muninFiles:DOC123'), { prefix: 'muninFiles:', docId: 'DOC123', chatId: null });
  // Remove: the text, the bytes and the list entry go; the next turn no longer lists it.
  assert.strictEqual(await T.removeDocFile('DOC123', 'doc2'), true);
  assert.ok(!('muninAttach:DOC123:doc2' in storage) && !('muninFiles:DOC123' in storage));
  await waitFor(() => !fileBytes(env).has('DOC123:doc2'), 'the bytes removed');
  deq(state.docFiles, []);
  const snap = T.takeSnapshot(); T.snapshotDocument(snap);
  deq(snap.docs, []);
});

test('migration: files attached in chats by an earlier build move to the document once (first come keeps its alias, the rest re-aliased)', async () => {
  const e = await load();
  const at = (n) => 1700000000000 + n;
  const docs1 = [{ alias: 'doc2', id: 'file:c1:doc2', kind: 'file', title: 'a.md', lines: 2, size: 9 },
    { alias: 'doc3', id: 'GDOC3', title: 'Ref', lines: 4 }];
  const docs2 = [{ alias: 'doc2', id: 'file:c2:doc2', kind: 'file', title: 'b.txt', lines: 1, size: 3 },
    { alias: 'doc3', id: 'file:c2:doc3', kind: 'file', title: 'c.pdf', lines: 2, size: 900, pages: 1 },
    { alias: 'doc4', id: 'file:c2:doc4', kind: 'file', title: 'gone.md', lines: 1, size: 1 }];
  Object.assign(e.storage, {
    'muninChats:DOC123': [{ id: 'c2', title: 'Two', createdAt: at(20), updatedAt: at(30), docs: docs2 },
      { id: 'c1', title: 'One', createdAt: at(10), updatedAt: at(15), docs: docs1 }],
    'muninChatHistory:DOC123:c1': [], 'muninChatHistory:DOC123:c2': [], 'muninCurrentChat:DOC123': 'c2',
    'muninAttach:DOC123:c1:doc2': { name: 'a.md', format: 'markdown', text: '# A\nx' },
    'muninAttach:DOC123:c2:doc2': { name: 'b.txt', format: 'text', text: 'b' },
    'muninAttach:DOC123:c2:doc3': { name: 'c.pdf', format: 'pdf', text: '[page 1]\nc' },
  });
  e.idb.dbs.set('munin-files', new Map([['files', new Map([
    ['DOC123:c1:doc2', { name: 'a.md', addedAt: at(11) }], ['DOC123:c2:doc2', { name: 'b.txt', addedAt: at(21) }],
    ['DOC123:c2:doc3', { name: 'c.pdf', addedAt: at(22) }]])]]));
  docBench(e);
  await e.T.refreshContext({ force: true });
  const s = e.storage;
  deq(s['muninFiles:DOC123'], [
    { alias: 'doc2', title: 'a.md', lines: 2, size: 9, addedAt: at(11) },
    { alias: 'doc4', title: 'b.txt', lines: 1, size: 3, addedAt: at(21) },
    { alias: 'doc5', title: 'c.pdf', lines: 2, pages: 1, size: 900, addedAt: at(22) }]);
  deq([s['muninAttach:DOC123:doc2'].text, s['muninAttach:DOC123:doc4'].text, s['muninAttach:DOC123:doc5'].text], ['# A\nx', 'b', '[page 1]\nc']);
  deq(Object.keys(s).filter((k) => /^muninAttach:DOC123:c\d/.test(k)), []);
  deq([...fileBytes(e).keys()].sort(), ['DOC123:doc2', 'DOC123:doc4', 'DOC123:doc5']);
  deq(fileBytes(e).get('DOC123:doc4'), { name: 'b.txt', addedAt: at(21) });
  const metas = Object.fromEntries(s['muninChats:DOC123'].map((c) => [c.id, c]));
  deq([metas.c1.docs, metas.c2.docs, metas.c2.updatedAt], [[{ alias: 'doc3', id: 'GDOC3', title: 'Ref', lines: 4 }], [], at(30)]);
  // The open chat (c2) lists every file of the document; chat c1 too, after its opened document.
  assert.strictEqual(e.state.chatId, 'c2');
  let snap = e.T.takeSnapshot(); e.T.snapshotDocument(snap);
  deq(snap.docs.map((d) => [d.alias, d.title]), [['doc2', 'a.md'], ['doc4', 'b.txt'], ['doc5', 'c.pdf']]);
  const r = await e.T.readingTarget('read_document', { doc: 'doc5' }, snap);
  deq(e.T.docLines(r.target), ['[page 1]', 'c']);
  await e.T.switchChat('c1');
  snap = e.T.takeSnapshot(); e.T.snapshotDocument(snap);
  deq(snap.docs.map((d) => [d.alias, d.title]), [['doc3', 'Ref'], ['doc2', 'a.md'], ['doc4', 'b.txt'], ['doc5', 'c.pdf']]);
  // Once: a second load changes nothing.
  const before = JSON.stringify(s);
  await e.T.migrateChatFiles('DOC123');
  assert.strictEqual(JSON.stringify(s), before);
});

test('PDF: the page text from getTextContent (lines, gaps, hyphenation, marked content); [page N] lines; the loader error path', async () => {
  const item = (str, x, y, w, extra = {}) => ({ str, transform: [10, 0, 0, 10, x, y], width: w, height: 10, hasEOL: false, ...extra });
  const content = { items: [
    { type: 'beginMarkedContent' },
    item('Lipid', 50, 700, 25), item('rafts', 78, 700, 24), item(' are exam-', 102, 700, 50, { hasEOL: true }),
    item('ple domains.', 50, 688, 60), // a new baseline: a new line
    item('COVID-', 50, 676, 30, { hasEOL: true }), item('19 is not joined.', 50, 664, 80, { hasEOL: true }),
    item('', 50, 652, 0, { hasEOL: true }), item('', 50, 640, 0, { hasEOL: true }),
    item('Next paragraph.', 50, 628, 70),
    { type: 'endMarkedContent' },
  ] };
  deq(T.pdfPageText(content).split('\n'), ['Lipid rafts are example', 'domains.', 'COVID-', '19 is not joined.', '', 'Next paragraph.']);
  deq(T.joinHyphenated(['a well-', 'known fact']), ['a wellknown', 'fact']);
  // The loader: the vm has no dynamic import, so the first PDF fails with what to do; the next one tries again.
  await assert.rejects(T.extractAttachment('a.pdf', '', bytesOf('%PDF-1.7')), /the PDF reader could not be loaded \(.*\)\. Reload the panel and attach the file again\./);
  assert.strictEqual(env.run('pdfjsLoading'), null);
  // A fake pdf.js module: two pages, "[page N]" before each, the page count, the worker URL set once.
  const pages = [{ items: [item('First page.', 0, 0, 50, { hasEOL: true })] }, { items: [item('Second page.', 0, 0, 50)] }];
  const lib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({
    numPages: 2, destroy() { lib.destroyed = true; },
    getPage: async (n) => ({ getTextContent: async () => pages[n - 1], cleanup() {} }),
  }) }) };
  env.chrome.runtime.getURL = (p) => 'chrome-extension://testextid/' + p;
  env.ctx.__fakePdfLib = lib;
  env.run('pdfjsImport = async (url) => { __fakePdfUrl = url; return __fakePdfLib; }');
  const r = await T.extractAttachment('two.pdf', 'application/pdf', bytesOf('%PDF'));
  deq([r.text, r.format, r.pages, r.lines], ['[page 1]\nFirst page.\n[page 2]\nSecond page.', 'pdf', 2, 4]);
  deq([env.run('__fakePdfUrl'), lib.GlobalWorkerOptions.workerSrc, lib.destroyed],
    ['chrome-extension://testextid/vendor/pdf.min.mjs', 'chrome-extension://testextid/vendor/pdf.worker.min.mjs', true]);
  // Its outline: the page lines.
  const key = 'muninAttach:DOC123:doc5';
  storage[key] = { name: 'two.pdf', format: 'pdf', text: r.text };
  const snap = T.takeSnapshot(); T.snapshotDocument(snap);
  const view = await T.loadAttachmentView({ alias: 'doc5', id: 'file:doc5', kind: 'file', title: 'two.pdf' }, snap);
  deq(T.docOutline(view).map((h) => [h.line, h.title]), [[1, 'Page 1'], [3, 'Page 2']]);
  // A scan without a text layer.
  pages[0] = { items: [] }; pages[1] = { items: [item('  ', 0, 0, 5)] };
  await assert.rejects(T.extractAttachment('scan.pdf', '', bytesOf('%PDF')), /no text layer \(a scan\?\)\. Run text recognition \(OCR\)/);
  delete storage[key];
});
