'use strict';
// The selection's place from Google Docs itself: the page's window._docs_annotate_getAnnotatedText() gives the editor's
// text and the selection's offsets in it; the panel runs a probe in the page's main world (chrome.scripting.executeScript)
// and keeps the text just before and after the selection (state.selectionCtx), which then chooses among the places the
// text search found (request.js selectionSpan, docs-write.js planApiSelection). Without it, or when it does not fit,
// everything is as before.
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { deq, load, installIdentity } = require('./lib/sandbox');
const { textRound } = require('./lib/streams');
const { docBench, recordFetch, useProvider, send } = require('./lib/context');
const { ORIGINAL, docsBench } = require('./lib/fake-docs');

let env, T, state, doc, page;
const ETX = String.fromCharCode(3); // the first character of Docs' getText()

// A fake Docs page for chrome.scripting.executeScript: the probe's source runs in a context of its own (so it can use
// nothing of the panel) whose window has page.fn as _docs_annotate_getAnnotatedText (undefined: no such function).
// page.calls logs every call; page.leftover lists the globals the probe left in the page.
function installPage(e) {
  const p = { fn: undefined, calls: [], leftover: null, reject: null };
  e.chrome.scripting.executeScript = async (opts) => {
    p.calls.push({ target: opts.target, world: opts.world, args: opts.args, files: opts.files });
    if (opts.files) return [];
    if (p.reject) throw new Error(p.reject);
    const win = {};
    if (p.fn !== undefined) win._docs_annotate_getAnnotatedText = p.fn;
    win.window = win;
    const ctx = vm.createContext(win);
    const keys = Object.keys(win).sort();
    const func = vm.runInContext(`(${opts.func.toString()})`, ctx);
    const result = await func(...opts.args);
    p.leftover = Object.keys(win).sort().filter((k) => !keys.includes(k));
    return [{ frameId: 0, documentId: 'd', result: JSON.parse(JSON.stringify(result)) }];
  };
  return p;
}
// The page's annotated text: getText() is the text, getSelection() one range { start, end } (keys: other key names).
const annotated = (text, start, end, keys = ['start', 'end']) => async () => ({
  getText: () => text, getSelection: () => [{ [keys[0]]: start, [keys[1]]: end }], setSelection() {}, getAnnotations: () => [],
});
// The page's text for paragraphs, and the page function with the n-th (0-based) occurrence of word selected.
const pageText = (paras) => ETX + paras.join('\n') + '\n';
function selectNth(paras, word, n) {
  const text = pageText(paras);
  let at = -1;
  for (let i = 0; i <= n; i++) at = text.indexOf(word, at + 1);
  assert.ok(at > 0, `${word} #${n} in the page text`);
  return annotated(text, at, at + word.length);
}

before(async () => {
  env = await load({ hash: '#tabId=7', consts: { SELECTION_CONTEXT_TIMEOUT_MS: 80 } });
  T = env.T;
  state = env.state;
  ({ doc } = docBench(env));
  page = installPage(env);
  await T.refreshContext({ force: true });
});
beforeEach(() => { page.fn = undefined; page.calls.length = 0; page.reject = null; });

const snapNow = () => { const s = T.takeSnapshot(); T.snapshotDocument(s); return s; };

test('the page side: a self-contained probe of the page function; nothing left in the page', async () => {
  const probe = async (fn, max = 20000) => {
    const win = fn === undefined ? {} : { _docs_annotate_getAnnotatedText: fn };
    win.window = win;
    const ctx = vm.createContext(win);
    const keys = Object.keys(win).sort();
    const r = await vm.runInContext(`(${T.docsSelectionProbe.toString()})`, ctx)(80, max);
    deq(Object.keys(win).sort(), keys, 'no global left behind');
    return JSON.parse(JSON.stringify(r));
  };
  const text = pageText(['Title', 'See the results below.']);
  deq(await probe(undefined), { ok: false, reason: 'unavailable' });
  deq(await probe(() => { throw new Error('boom'); }), { ok: false, reason: 'error' });
  deq(await probe(async () => { throw new Error('boom'); }), { ok: false, reason: 'error' });
  deq(await probe(async () => null), { ok: false, reason: 'shape' });
  deq(await probe(async () => ({ getText: () => text, getSelection: () => [] })), { ok: false, reason: 'ranges' });
  deq(await probe(async () => ({ getText: () => text, getSelection: () => [{ start: 1, end: 2 }, { start: 4, end: 5 }] })), { ok: false, reason: 'ranges' });
  deq(await probe(async () => ({ getText: () => text, getSelection: () => [{ start: '1', end: 2 }] })), { ok: false, reason: 'shape' });
  // start/end (what Docs gave in Chrome 153), anchor/focus and base/extent, in either direction
  const at = text.indexOf('the results');
  const want = { ok: true, start: at, end: at + 11, sel: 'the results', before: ETX + 'Title\nSee ', after: ' below.\n' };
  deq(await probe(annotated(text, at, at + 11)), want);
  deq(await probe(annotated(text, at + 11, at, ['anchor', 'focus'])), want);
  deq(await probe(annotated(text, at, at + 11, ['base', 'extent'])), want);
  // a caret: an empty selection; at most 80 characters on each side; a long selection gets nothing
  deq(await probe(annotated(text, at, at)), { ok: true, start: at, end: at, sel: '', before: ETX + 'Title\nSee ', after: 'the results below.\n' });
  const long = pageText(['x'.repeat(100) + 'MID' + 'y'.repeat(100)]);
  const r = await probe(annotated(long, 101, 104));
  assert.strictEqual(r.sel, 'MID'); assert.strictEqual(r.before, 'x'.repeat(80)); assert.strictEqual(r.after, 'y'.repeat(80));
  deq(await probe(annotated(long, 1, 150), 100), { ok: false, reason: 'long' });
});

test('refreshSelection: the surroundings are kept only for the same selection (absent, throwing, slow, mismatch, caret)', async () => {
  const paras = ['Title', 'See the results below.', 'Middle', 'And the results again.'];
  doc.selection = 'the results';
  page.fn = selectNth(paras, 'the results', 1);
  await T.refreshSelection();
  deq(state.selectionCtx, { text: 'the results', before: ETX + 'Title\nSee the results below.\nMiddle\nAnd ', after: ' again.\n' });
  // run in the document tab's top frame, in the page's main world, with nothing of the panel but two numbers
  deq(page.calls, [{ target: { tabId: 7, frameIds: [0] }, world: 'MAIN', args: [80, 20000] }]);
  deq(page.leftover, []);
  // no function, a throwing one, one that never answers (the timeout), executeScript refused: no surroundings. The
  // probe's time limit (SELECTION_CONTEXT_TIMEOUT_MS) ends only the one that never answers (counted, not timed)
  const limit = T.SELECTION_CONTEXT_TIMEOUT_MS;
  const fired = [];
  const setT = env.ctx.setTimeout;
  env.ctx.setTimeout = (fn, ms, ...a) => (ms === limit ? setT((...x) => { fired.push(ms); fn(...x); }, ms, ...a) : setT(fn, ms, ...a));
  try {
    for (const [what, set] of [['absent', () => { page.fn = undefined; }], ['throwing', () => { page.fn = () => { throw new Error('x'); }; }],
      ['slow', () => { page.fn = () => new Promise(() => {}); }], ['refused', () => { page.fn = selectNth(paras, 'the results', 1); page.reject = 'Cannot access contents of the page'; }]]) {
      set();
      fired.length = 0;
      const out = await T.refreshSelection();
      assert.strictEqual(state.selectionCtx, null, what);
      assert.strictEqual(out.text, 'the results', what); // the selection itself is read as before
      deq(fired, what === 'slow' ? [limit] : [], what);
      page.reject = null;
    }
  } finally { env.ctx.setTimeout = setT; }
  // the page's selection is another one: a different text, a caret
  page.fn = selectNth(paras, 'results', 1);
  await T.refreshSelection();
  assert.strictEqual(state.selectionCtx, null, 'text mismatch');
  const text = pageText(paras);
  page.fn = annotated(text, 10, 10);
  await T.refreshSelection();
  assert.strictEqual(state.selectionCtx, null, 'caret');
  // whitespace, NBSP and zero-width characters do not make a mismatch (content.js cleans the copied text so)
  doc.selection = 'the  results';
  page.fn = annotated(pageText(['the' + String.fromCharCode(0xA0) + 'res' + String.fromCharCode(0x200B) + 'ults x']), 1, 13);
  await T.refreshSelection();
  assert.strictEqual(state.selectionCtx && state.selectionCtx.text, 'the  results');
  // nothing selected: the page is not asked
  doc.selection = '';
  page.calls.length = 0;
  await T.refreshSelection();
  assert.strictEqual(state.selectionCtx, null); deq(page.calls, []);
});

test('SELECTION_UPDATE: another text drops the surroundings, the same text keeps them; also when applied after a turn', async () => {
  doc.selection = 'the results';
  page.fn = selectNth(['See the results.', 'And the results.'], 'the results', 0);
  await T.refreshSelection();
  assert.ok(state.selectionCtx);
  const ctx = state.selectionCtx;
  T.onRuntimeMessage({ type: 'SELECTION_UPDATE', tabId: 7, text: 'the results' });
  assert.strictEqual(state.selectionCtx, ctx);
  T.onRuntimeMessage({ type: 'SELECTION_UPDATE', tabId: 7, text: 'other' });
  assert.strictEqual(state.selectionCtx, null);
  await T.refreshSelection();
  state.pendingSelection = 'something else';
  T.applyPendingSelection();
  assert.strictEqual(state.selection, 'something else'); assert.strictEqual(state.selectionCtx, null);
});

// The export path (no Google account): Markdown with the same phrase in two paragraphs.
const MD = ['# Report', '', '## Methods', '', 'We measured the results twice.', '', '## Results', '', 'Here the results hold.'].join('\n');
const PAGE = ['Report', 'Methods', 'We measured the results twice.', 'Results', 'Here the results hold.'];
const SHOWN = '\nIts text (no need for get_selection):\n<selection>\nthe results\n</selection>';

test('export path: a turn names the one line the surroundings point to; without them, or when they fit no place, as before', async () => {
  useProvider(env, 'anthropic');
  for (const id of ['openai', 'munin']) state.settings.providers[id].apiKey = '';
  const turn = async () => {
    await T.createChat(); T.el.chat.children.length = 0;
    recordFetch(env, [textRound('OK.')]);
    await send(env, 'rewrite it');
    return String(state.messages[0]._context).split('\n').filter((l) => l.startsWith('Selection')).join('\n');
  };
  doc.text = MD; doc.selection = 'the results';
  page.fn = selectNth(PAGE, 'the results', 1);
  assert.strictEqual(await turn(), 'Selection: line 9 (11 characters)');
  assert.ok(String(state.messages[0]._context).includes('Selection: line 9 (11 characters)' + SHOWN));
  page.fn = selectNth(PAGE, 'the results', 0);
  assert.strictEqual(await turn(), 'Selection: line 5 (11 characters)');
  const ambiguous = 'Selection: 11 characters; the same text is on lines 5 and 9, so which one is selected is not known. replace_selection replaces exactly what the user selected. ' +
    'Other edits: only the place the request means ("this heading": the heading line), or ask the user; never all of them.';
  page.fn = undefined; // no page function
  assert.strictEqual(await turn(), ambiguous);
  page.fn = selectNth(['Another', 'text where the results', 'differ entirely'], 'the results', 0); // surroundings that fit no place
  assert.strictEqual(await turn(), ambiguous);
  page.fn = selectNth(PAGE, 'results', 1); // the page's selection is another text
  assert.strictEqual(await turn(), ambiguous);
});

test('export path: get_selection, locateSelection and the span report the chosen place; a stale context is ignored', async () => {
  doc.text = MD; doc.selection = 'the results';
  page.fn = selectNth(PAGE, 'the results', 1);
  await T.fetchDocText(); await T.refreshSelection();
  let s = snapNow();
  deq(T.selectionSpan(s), { start: 9, end: 9, startChar: 6, endChar: 16, approx: false });
  deq(T.locateSelection(s), { start: 9, end: 9 });
  assert.strictEqual(T.runReadingTool('get_selection', {}, s), 'Selection (lines 9-9, 11 characters):\nthe results');
  // surroundings recorded for another selection text: not used
  s.selection = 'the  results';
  assert.strictEqual(T.selectionSpan(s).occurrences, 2);
  // a margin too small (10 letters, at the start of the document): the place stays unknown
  doc.text = ['Sample doc', 'Sample doe'].join('\n');
  doc.selection = 'Sample';
  await T.fetchDocText();
  for (const n of [0, 1]) {
    page.fn = selectNth(['Sample doc', 'Sample doe'], 'Sample', n);
    await T.refreshSelection();
    assert.ok(state.selectionCtx);
    deq(T.selectionSpan(snapNow()).places, [1, 2]);
  }
});

test('nothing changes for a unique selection, with or without surroundings (even ones pointing elsewhere)', async () => {
  doc.text = MD; doc.selection = 'measured the results';
  await T.fetchDocText();
  page.fn = undefined;
  await T.refreshSelection();
  const plain = snapNow();
  page.fn = selectNth(['We measured the results twice, and we measured the results'], 'measured the results', 1);
  await T.refreshSelection();
  assert.ok(state.selectionCtx);
  const withCtx = snapNow();
  deq(T.selectionSpan(withCtx), T.selectionSpan(plain));
  deq(T.selectionSpan(withCtx), { start: 5, end: 5, startChar: 4, endChar: 23, approx: false });
  assert.strictEqual(T.runReadingTool('get_selection', {}, withCtx), T.runReadingTool('get_selection', {}, plain));
});

test('a selection across two paragraphs: the surroundings pick the right pair of lines; skipped short edge lines count as selected', async () => {
  const lines = ['Head', 'Alpha one', 'Beta two', 'X', 'Alpha one', 'Beta two', 'Y', 'Alpha one', 'Beta two'];
  Object.assign(state, { docFormat: 'text', docText: lines.join('\n'), docModel: null });
  const at = (sel, ctx) => { Object.assign(state, { selection: sel, selectionCtx: ctx }); return T.selectionSpan(snapNow()); };
  const ctxFor = (sel, n) => {
    const text = pageText(lines);
    let i = -1;
    for (let k = 0; k <= n; k++) i = text.indexOf(sel, i + 1);
    return { text: sel, before: text.slice(Math.max(0, i - 80), i), after: text.slice(i + sel.length, i + sel.length + 80) };
  };
  deq(at('Alpha one\nBeta two', null).places, [2, 5, 8]);
  for (const [n, line] of [[0, 2], [1, 5], [2, 8]]) {
    const span = at('Alpha one\nBeta two', ctxFor('Alpha one\nBeta two', n));
    deq([span.start, span.end, span.occurrences], [line, line + 1, undefined], `occurrence ${n}`);
  }
  // "X" (one character) is not searched for: the text search finds three places; the surroundings, with the X as part
  // of the selection, only the first
  deq(at('one\nBeta two\nX', null).places, [2, 5, 8]);
  const span = at('one\nBeta two\nX', ctxFor('one\nBeta two\nX', 0));
  deq([span.start, span.end, span.startChar, span.occurrences], [2, 3, 7, undefined]);
  Object.assign(state, { selection: '', selectionCtx: null });
});

test('export path: a heading and its line in the table of contents (Markdown link) are told apart', async () => {
  const md = ['# Paper', '', '[Introduction](#heading=h.a1)', '', '[Methods](#heading=h.b2)', '', '## Introduction', '', 'Some text.', '', '## Methods', '', 'We did it.'].join('\n');
  const paras = ['Paper', 'Introduction', 'Methods', 'Introduction', 'Some text.', 'Methods', 'We did it.'];
  Object.assign(state, { docFormat: 'markdown', docText: md, docModel: null, selection: 'Methods' });
  const ctxAt = (n) => {
    const text = pageText(paras);
    let i = -1;
    for (let k = 0; k <= n; k++) i = text.indexOf('Methods', i + 1);
    return { text: 'Methods', before: text.slice(Math.max(0, i - 80), i), after: text.slice(i + 7, i + 87) };
  };
  state.selectionCtx = null;
  deq(T.selectionSpan(snapNow()).places, [5, 11]);
  state.selectionCtx = ctxAt(1); // the heading
  deq(T.locateSelection(snapNow()), { start: 11, end: 11 });
  state.selectionCtx = ctxAt(0); // the contents' entry
  deq(T.locateSelection(snapNow()), { start: 5, end: 5 });
  Object.assign(state, { selection: '', selectionCtx: null });
});

test('Docs API path: replace_selection goes through the API (verified, undoable) for a text that occurs twice', async () => {
  const ident = installIdentity(env);
  const ref = { fake: null, as: null };
  const bench = docsBench(env, ident, { get fake() { return ref.fake; }, set fake(v) { ref.fake = v; }, get as() { return ref.as; }, set as(v) { ref.as = v; } });
  const pasted = [];
  const sel = { text: 'Alpha beta' };
  env.chrome.tabs.sendMessage = async (id, msg) => {
    if (msg.type === 'GET_SELECTION') return { ok: true, text: sel.text };
    if (msg.type === 'REPLACE_SELECTION') { pasted.push(msg.text); return { ok: true }; }
    return { ok: true, title: 'My Doc' };
  };
  state.settings.provider = 'anthropic'; state.googleConnected = true;
  await bench.fresh();
  // the page's text: the body as Docs shows it (the table's structure as control characters)
  const paras = ORIGINAL.map((l) => (l.startsWith('Cell') ? String.fromCharCode(0x1c) + l : l));
  page.fn = selectNth(paras, 'Alpha beta', 1); // the second one: "Alpha beta delta." on line 5
  await T.refreshSelection();
  assert.ok(state.selectionCtx);
  const s = snapNow();
  deq(T.locateSelection(s), { start: 5, end: 5 });
  assert.strictEqual(T.runReadingTool('get_selection', {}, s), 'Selection (lines 5-5, 10 characters):\nAlpha beta');
  let w = await bench.exec('replace_selection', { text: 'Omega' }, 'rs1');
  bench.pushTool(w);
  assert.ok(w._ok && w._edit && w._message === 'Replaced the selection (line 5)', w.content);
  assert.ok(ref.fake.text('t.0').includes('Alpha beta gamma.\nOmega delta.'), ref.fake.text('t.0'));
  deq(pasted, []);
  w = bench.pushTool(await bench.exec('undo_last_edit', {}, 'rs1u'));
  assert.ok(w._ok && ref.fake.text('t.0').includes('Alpha beta gamma.\nAlpha beta delta.'), w.content);
  // the first one
  await bench.fresh();
  page.fn = selectNth(paras, 'Alpha beta', 0);
  await T.refreshSelection();
  w = await bench.exec('replace_selection', { text: 'Omega' }, 'rs2');
  assert.ok(w._ok && w._edit && w._message === 'Replaced the selection (line 4)', w.content);
  assert.ok(ref.fake.text('t.0').includes('Omega gamma.\nAlpha beta delta.'));
  // no page function: pasted, as before
  await bench.fresh();
  page.fn = undefined;
  await T.refreshSelection();
  w = await bench.exec('replace_selection', { text: 'Sigma' }, 'rs3');
  assert.ok(w._ok && !w._edit && w.content === T.PASTE_DONE_NOTE, w.content);
  deq(pasted, ['Sigma']);
  // surroundings that fit neither place: pasted
  await bench.fresh();
  page.fn = selectNth(['Nothing like it', 'Alpha beta zeta', 'at all'], 'Alpha beta', 0);
  await T.refreshSelection();
  assert.ok(state.selectionCtx);
  w = await bench.exec('replace_selection', { text: 'Tau' }, 'rs4');
  assert.ok(w._ok && !w._edit, w.content);
  deq(pasted, ['Sigma', 'Tau']);
  Object.assign(state, { selection: '', selectionCtx: null, googleConnected: false, docModel: null });
});
