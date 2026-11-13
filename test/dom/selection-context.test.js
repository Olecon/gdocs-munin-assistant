'use strict';
// The selection's place from Google Docs, end to end on the real-DOM bench: content.js on a fake Docs page (jsdom) whose
// page script defines window._docs_annotate_getAnnotatedText over its own editor (getText() and the DOM selection as
// offsets, as Docs does), the panel in a second jsdom window that reads the selection through the content script
// (GET_SELECTION) and the probe through chrome.scripting.executeScript, run in the page's window. The panel then names
// the line the surroundings point to; the page keeps no trace of the probe.
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { load, loadContent } = require('../lib/dom-sandbox');

const PARAS = ['Report', 'Methods', 'We measured the results twice.', 'Results', 'Here the results hold.'];
const MD = ['# Report', '', '## Methods', '', 'We measured the results twice.', '', '## Results', '', 'Here the results hold.'].join('\n');

// The page script of the fake Docs page: an editor of paragraphs and the annotated-text function over it.
const PAGE_SCRIPT = `(() => {
  const ed = document.createElement('div');
  ed.id = 'ed';
  for (const t of ${JSON.stringify(PARAS)}) { const d = document.createElement('div'); d.textContent = t; ed.appendChild(d); }
  document.body.appendChild(ed);
  const paras = () => [...ed.children];
  const text = () => String.fromCharCode(3) + paras().map((d) => d.textContent).join('\\n') + '\\n';
  const offsetOf = (node, off) => {
    let base = 1;
    for (const d of paras()) {
      if (d === node || d.contains(node)) { const r = document.createRange(); r.setStart(d, 0); r.setEnd(node, off); return base + r.toString().length; }
      base += d.textContent.length + 1;
    }
    return null;
  };
  window._docs_annotate_getAnnotatedText = async () => ({
    getText: text,
    getSelection: () => {
      const s = getSelection();
      if (!s.rangeCount || !ed.contains(s.anchorNode)) return [];
      const a = offsetOf(s.anchorNode, s.anchorOffset);
      const b = offsetOf(s.focusNode, s.focusOffset);
      return [{ start: Math.min(a, b), end: Math.max(a, b) }];
    },
    setSelection() {}, getAnnotations: () => [],
  });
})()`;

async function bench() {
  const c = await loadContent();
  const pageCtx = c.dom.getInternalVMContext();
  vm.runInContext(PAGE_SCRIPT, pageCtx);
  const p = await load({ hash: '#tabId=7' });
  const tab = { id: 7, url: 'https://docs.google.com/document/d/DOC123/edit', title: 'My Doc - Google Docs' };
  p.chrome.tabs.get = async (id) => { if (id === 7) return tab; throw new Error('no tab'); };
  p.chrome.tabs.query = async () => [tab];
  // The export comes from the content script's route (the panel's own fetch fails here); everything else is content.js.
  p.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_DOC_TEXT' ? { ok: true, text: MD, format: 'markdown', title: 'My Doc' } : c.send(msg));
  const calls = [];
  p.chrome.scripting.executeScript = async (opts) => {
    calls.push(JSON.parse(JSON.stringify({ target: opts.target, world: opts.world })));
    const func = vm.runInContext(`(${opts.func.toString()})`, pageCtx);
    return [{ frameId: 0, result: JSON.parse(JSON.stringify(await func(...opts.args))) }];
  };
  // Selects the n-th occurrence of word in the page's editor, and puts its text in the hidden editor iframe the way
  // Docs does (content.js reads the selection there).
  const select = (word, n) => {
    const d = c.document;
    const hits = [...d.getElementById('ed').children].flatMap((el) => {
      const out = [];
      for (let i = el.textContent.indexOf(word); i >= 0; i = el.textContent.indexOf(word, i + 1)) out.push([el.firstChild, i]);
      return out;
    });
    const [node, at] = hits[n];
    const r = d.createRange();
    r.setStart(node, at); r.setEnd(node, at + word.length);
    c.window.getSelection().removeAllRanges(); c.window.getSelection().addRange(r);
    c.editorDoc.body.textContent = word;
    c.editorDoc.getSelection().selectAllChildren(c.editorDoc.body);
  };
  const close = () => { p.close(); c.close(); };
  return { c, p, calls, select, close };
}

const snapOf = (T) => { const s = T.takeSnapshot(); T.snapshotDocument(s); return s; };

test('content script, page function and panel: the selected occurrence is named; the page is left as it was', async () => {
  const b = await bench();
  try {
    const { p, c, select } = b;
    await p.T.fetchDocText();
    const keys = Object.getOwnPropertyNames(c.window).sort();
    select('the results', 1);
    const r = await p.T.refreshSelection();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { text: 'the results', cached: false });
    assert.deepStrictEqual(b.calls, [{ target: { tabId: 7, frameIds: [0] }, world: 'MAIN' }]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.state.selectionCtx)),
      { text: 'the results', before: String.fromCharCode(3) + 'Report\nMethods\nWe measured the results twice.\nResults\nHere ', after: ' hold.\n' });
    let s = snapOf(p.T);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.T.locateSelection(s))), { start: 9, end: 9 });
    assert.strictEqual(p.T.runReadingTool('get_selection', {}, s), 'Selection (lines 9-9, 11 characters):\nthe results');
    assert.strictEqual(p.el.selPreview.textContent, 'the results (11 chars)'); // the Selected line as before
    assert.deepStrictEqual(Object.getOwnPropertyNames(c.window).sort(), keys, 'no global left in the page');
    // the first occurrence
    select('the results', 0);
    await p.T.refreshSelection();
    s = snapOf(p.T);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.T.locateSelection(s))), { start: 5, end: 5 });
    // a collapsed caret in the page while the copied text says otherwise (the cache): no surroundings, as before
    c.window.getSelection().collapseToStart();
    await p.T.refreshSelection();
    assert.strictEqual(p.state.selectionCtx, null);
    s = snapOf(p.T);
    assert.strictEqual(p.T.runReadingTool('get_selection', {}, s), 'Selection (the same text is on lines 5 and 9, 11 characters):\nthe results');
    // a page without the function, and one whose function throws: as before
    for (const set of ['delete window._docs_annotate_getAnnotatedText', "window._docs_annotate_getAnnotatedText = () => { throw new Error('gone'); }"]) {
      vm.runInContext(set, c.dom.getInternalVMContext());
      select('the results', 1);
      await p.T.refreshSelection();
      assert.strictEqual(p.state.selectionCtx, null, set);
      assert.strictEqual(p.T.locateSelection(snapOf(p.T)), null, set);
    }
  } finally {
    b.close();
  }
});
