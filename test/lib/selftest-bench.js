'use strict';
// The self-test bench (test/selftest-model.test.js, test/selftest-interactive.test.js): a panel on DOC123 with
// Munin, the fake Docs API or the export only, a stub content script (GET_SIGNAL_STATE: SIGNAL_STATE), a scripted model (GOOD per scenario) and
// a simulated user for the Your-turn cards (GOOD_USER), plus the row lists of both modes.
const { deq, load, installDocTab, installIdentity } = require('./sandbox');
const { sseResponse } = require('./streams');
const { fakeDocsServer, docSpec } = require('./fake-docs');
require('./fake-tables'); // the table rows of the requests the Write: table row sends
const { webLocks } = require('./shared-storage');

const json = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj), headers: { get: () => '' } });
const EMPTY = () => docSpec({ items: [{ p: '' }] });
const PASTE = 'Self-test paragraph: the quick brown fox jumps over the lazy dog.';

// The content script's GET_SIGNAL_STATE reply on a page where everything was found.
const SIGNAL_STATE = { ok: true, tracking: true, panel: true, editor: true, editorSelector: '.kix-appview-editor', observing: true, iframe: true, iframeDoc: true, listening: true, stats: { keydownFrame: 3, keydownPage: 0, beforeinput: 0, input: 0, mutations: 2, typedSent: 1, changedPage: 1, changedInput: 1, iframeSwaps: 0 } };

// Munin (Chat Completions) rounds with usage.
const cc = (o) => `data: ${JSON.stringify(o)}\n\n`;
const usage = cc({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
let seq = 0;
const call = (name, args) => cc({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${++seq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) +
  cc({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + usage + 'data: [DONE]\n\n';
const say = (t) => cc({ choices: [{ index: 0, delta: { content: t } }] }) + cc({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + usage + 'data: [DONE]\n\n';

// format_lines arguments with every property null except over.
const lines = (start, end, over) => ({ start, end, style: null, align: null, list: null, indent_start: null, indent_first_line: null, space_above: null, space_below: null, line_spacing: null, ...over });
const headLine = (b) => b.lines().indexOf('Self-test section') + 1;
// The correct behavior per scenario: a list of rounds, each (b) => SSE text (b.lines(): the document now).
const GOOD = {
  write: [(b) => call('insert_after_line', { line: b.lines().length, text: 'Self-test section\nThe quick brown fox jumps over the lazy dog.' }), () => say('Done.')],
  replace: [() => call('replace_text', { old_text: 'quick brown fox', new_text: 'slow green turtle' }), () => say('Done.')],
  format: [() => call('format_text', { old_text: 'lazy dog', bold: true, italic: null, underline: null }), () => say('Done.')],
  heading: [(b) => call('format_lines', lines(headLine(b), headLine(b), { style: 'h2' })), () => say('Done.')],
  replaceAll: [() => call('replace_all', { old_text: 'turtle', new_text: 'tortoise' }), () => say('Done.')],
  list: [(b) => call('format_lines', lines(headLine(b) + 1, headLine(b) + 2, { list: 'number' })), () => say('Done.')],
  // The turn context gives the selection by its line range only: the model reads it first.
  selection: [() => call('get_selection', {}), () => call('replace_selection', { text: 'THE SLOW GREEN TORTOISE JUMPS OVER THE LAZY DOG.' }), () => say('Done.')],
  question: [(b) => call('read_lines', { start: 1, end: b.lines().length }), () => say('3')],
  delete: [(b) => call('delete_lines', { start: b.lines().indexOf('Self-test section') + 1, end: b.lines().length }), () => say('Deleted.')],
  insert: [() => call('replace_selection', { text: PASTE }), () => say('Inserted.')],
  questionExport: [() => call('find_in_document', { query: 'Self-test paragraph' }), (b) => say(String(b.doc.split('\n').findIndex((l) => l.startsWith('Self-test paragraph')) + 1))],
  replaceSelection: [() => call('get_selection', {}), () => call('replace_selection', { text: 'red cat' }), () => say('Replaced.')],
};

// The simulated user of the Your-turn cards: what they do per step, then the button ('continue' / 'skip'; a
// falsy value leaves the card waiting). opts.user overrides a step with a decision or a function (b, pending card) => decision.
const YOUR_TURN_STEP = (text) => (text.includes('«brown fox»') ? 'select' : text.includes('Ctrl+B') ? 'bold' : text.startsWith('Remove the test paragraph') ? 'remove'
  : text.includes('type a few letters') ? 'typing' : '?');
// Makes the first «word» of the fake Docs document bold (the user's Ctrl+B): one revision more.
function boldInFake(fake, word) {
  for (const para of fake.tabs[0].blocks[0].paras) {
    const at = para.text.indexOf(word);
    if (at < 0) continue;
    para.chars = Array.from({ length: para.text.length }, (_, i) => (para.chars || [])[i]);
    for (let i = at; i < at + word.length; i++) para.chars[i] = { ...para.chars[i], bold: true };
    fake.revision++;
    return;
  }
}
const GOOD_USER = {
  select: (b) => { b.selection = 'brown fox'; return 'continue'; },
  bold: (b) => { if (b.connected) boldInFake(b.fake, 'quick'); else b.doc = b.doc.replace('quick', '**quick**'); return 'continue'; },
  remove: (b) => { b.doc = ''; return 'continue'; },
  // Types «abc» (three DOC_TYPED, a DOC_CHANGED from each source; the document changes), deletes it, then Continue.
  typing: (b, p, id) => {
    const before = b.doc;
    b.signal({ type: 'DOC_TYPED', dChars: 3, dWords: 0 });
    b.signal({ type: 'DOC_TYPED', dChars: 2, dWords: 0 });
    if (b.connected) b.fake.revision++; else b.doc = b.doc.replace('lazy dog.', 'lazy dog.abc');
    b.signal({ type: 'DOC_CHANGED', source: 'page', remote: false });
    b.signal({ type: 'DOC_CHANGED', source: 'input' });
    setTimeout(() => {
      b.signal({ type: 'DOC_TYPED', dChars: -5, dWords: 0 });
      if (!b.connected) b.doc = before;
      b.T.decidePreview(id, 'continue');
    }, 80);
    return null;
  },
};

// A panel on DOC123 with Munin (qwen3.8-27b), the fake Docs API (connected) or the export only, a stub
// content script and a scripted model. opts.script overrides GOOD per scenario; opts.onRequest(b, key, round,
// init) may return a response (Stop, hanging requests).
// opts.panelExportStatus: the panel's own export answers that HTTP status (the content script's export is the
// fallback). b.events logs the export requests ('export') and the export waits ('sleep <ms>', resolved at once).
// opts.pasteTimes: the stub content script inserts each pasted text that many times on one line (the paste
// dispatched to several targets), reporting that many insertion attempts.
// opts.hash: '#tabId=7' embeds the panel in the stub tab (HOST_TAB_ID), so b.push(text) delivers SELECTION_UPDATE.
async function bench({ hash = '', connected = true, spec = EMPTY(), script = {}, onRequest = null, selection = '', tabExportError = '', panelExportStatus = 0, pasteTimes = 1, user = {} } = {}) {
  const env = await load({ hash });
  const { T, state, chrome, ctx } = env;
  const ident = installIdentity(env);
  ident.granted = true;
  installDocTab(env);
  ctx.navigator.locks = webLocks();
  T.ST_MODEL.exportWaitMs = 5;
  T.ST_MODEL.apiWaitMs = 5;
  Object.assign(T.ST_SIGNAL, { apiEveryMs: 5, exportEveryMs: 5 });
  const b = { env, T, state, ctx, connected, fake: fakeDocsServer(spec), bodies: [], keys: [], pastes: [], doc: '', selection, statuses: [], events: [], turns: [] };
  ctx.exportSleep = async (ms) => { b.events.push(`sleep ${ms}`); };
  b.push = (text) => T.onRuntimeMessage({ type: 'SELECTION_UPDATE', tabId: 7, docId: 'DOC123', text });
  // A message of the content script: through onRuntimeMessage when the panel is embedded in tab 7, else to the tap.
  b.signal = (msg) => {
    const m = { tabId: 7, docId: 'DOC123', ...msg };
    if (T.HOST_TAB_ID === 7) T.onRuntimeMessage(m); else if (T.docSignalTap) T.docSignalTap(m);
  };
  b.lines = () => b.fake.raw('t.0').split('\n');
  b.exportText = () => (connected ? b.lines().filter(Boolean).join('\n\n') + (b.lines().some(Boolean) ? '\n' : '') : b.doc);
  chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, docId: 'DOC123', title: 'My Doc' };
      case 'GET_SIGNAL_STATE': return SIGNAL_STATE;
      case 'GET_SELECTION': return { ok: true, text: b.selection };
      case 'GET_DOC_TEXT':
        b.events.push('export');
        return tabExportError ? { ok: false, error: tabExportError, title: 'My Doc' } : { ok: true, text: b.exportText(), format: 'markdown', title: 'My Doc' };
      case 'REPLACE_SELECTION': {
        b.pastes.push(msg);
        if (msg.expected) { // a paste over the selection: the content script compares it first
          if (msg.expected !== b.selection || !b.doc.includes(msg.expected)) return { ok: false, reason: 'selection-changed', error: 'the selection changed while the answer was being generated' };
          b.doc = b.doc.replace(msg.expected, msg.text);
          b.selection = '';
          return { ok: true, method: 'paste', verified: false, attempts: 1, detail: '' };
        }
        const t = msg.text.repeat(pasteTimes);
        b.doc = b.doc ? `${b.doc.replace(/\n+$/, '')}\n\n${t}\n` : `${t}\n`; // the cursor at the end
        return { ok: true, method: 'paste', detail: 'inserted via paste event', attempts: pasteTimes };
      }
      default: return { ok: true };
    }
  };
  const prompts = T.ST_PROMPTS;
  const keyOf = (text) => Object.keys(prompts).find((k) => String(text).endsWith(prompts[k])) || (String(text).includes('single word OK') ? 'probe' : '?');
  ctx.fetch = async (url, init = {}) => {
    const r = await b.fake.fetch(url, init);
    if (r) return r;
    if (url.includes('/export?')) {
      b.events.push('export');
      if (panelExportStatus) return json({ error: 'export failed' }, panelExportStatus);
      return { ok: true, status: 200, text: async () => b.exportText(), headers: { get: () => '' } };
    }
    if (url.endsWith('/models')) return json({ data: [{ id: 'qwen3.8-27b' }] });
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(init.body);
      b.bodies.push(body);
      const users = body.messages.filter((m) => m.role === 'user');
      const last = users[users.length - 1];
      const key = keyOf(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
      const round = body.messages.slice(body.messages.lastIndexOf(last)).filter((m) => m.role === 'assistant').length;
      b.keys.push(`${key}:${round}`);
      if (onRequest) { const x = await onRequest(b, key, round, init); if (x) return x; }
      if (key === 'probe') return sseResponse(say('OK'));
      const rounds = script[key] || GOOD[key];
      if (!rounds) throw new Error('no script for ' + key);
      return sseResponse(rounds[Math.min(round, rounds.length - 1)](b));
    }
    throw new Error('unexpected fetch ' + url);
  };
  state.settings.provider = 'munin';
  Object.assign(state.settings.providers.munin, { apiKey: 'k-munin', model: 'qwen3.8-27b' });
  state.googleConnected = connected;
  await T.refreshContext({ force: true });
  const setStatus = ctx.setStatus;
  ctx.setStatus = (text, warn) => { b.statuses.push(text); return setStatus(text, warn); };
  // No permission card may appear (the self-test has none): any card is recorded in b.cards and denied. The
  // Your-turn cards (p.yourTurn: the instruction) go to the simulated user (b.turns logs them).
  b.cards = [];
  const answered = new Set();
  b.run = async (command) => {
    const t = setInterval(() => {
      for (const [id, p] of T.pendingPreviews) {
        if (p.yourTurn) {
          if (answered.has(id)) continue;
          answered.add(id);
          b.turns.push(p.yourTurn);
          const step = YOUR_TURN_STEP(p.yourTurn);
          const act = step in user ? user[step] : GOOD_USER[step];
          const d = typeof act === 'function' ? act(b, p, id) : act;
          if (d) T.decidePreview(id, d);
          continue;
        }
        b.cards.push(p.card.innerHTML); T.decidePreview(id, 'reject');
      }
    }, 2);
    try {
      T.el.input.value = command;
      await T.sendMessage();
    } finally { clearInterval(t); }
    return b.card();
  };
  b.card = () => T.el.chat.children.find((c) => c && c.classList && c.classList.contains('selftest'));
  b.rows = () => b.card()._selfTest.rows;
  b.row = (name) => b.rows().find((r) => r.name === name);
  b.posts = () => b.fake.log.filter((x) => x.method === 'POST');
  return b;
}
const statusOf = (rows) => Object.fromEntries(rows.map((r) => [r.name, r.status]));
const HEAD = ['Environment', 'Content script', 'Change signal', 'Selection', 'Export read', 'Docs API read', 'Model list', 'Completion', 'Empty document'];
const READING = ['get_outline', 'read_lines', 'find_in_document', 'get_selection', 'read_formatting', 'Matching'];
const EDITS = ['Write: replace_text', 'Write: format_text', 'Write: text styles', 'Write: format_lines', 'Write: lists', 'Write: delete_lines', 'Write: undo_last_edit'];
// The registered Docs API rows (registerSelfTestRows) after "Write: lists".
const API_EDITS = [...EDITS.slice(0, EDITS.indexOf('Write: lists') + 1), 'Write: table', 'Write: page parts', ...EDITS.slice(EDITS.indexOf('Write: lists') + 1)];
const WRITE_ROWS = ['Write: insert_after_line', ...EDITS];
const MODEL_ROWS = ['Model: write a section', 'Model: replace a phrase', 'Model: format', 'Model: heading', 'Model: replace all', 'Model: list',
  'Model: selection', 'Model: question', 'Model: delete', 'Model: cleanup'];
const HANDS = ['Your turn: select text', 'Model: replace the selection', 'Your turn: make text bold', 'Your turn: typing signal'];
const API_ROWS = [...HEAD, 'Write: insert_after_line', ...READING, ...HANDS, ...API_EDITS, ...MODEL_ROWS, 'Multi-tab'];
const EXPORT_ROWS = [...HEAD, ...WRITE_ROWS, 'Model: insert at the cursor', ...READING, ...HANDS, 'Model: question', 'Your turn: remove the test text', 'Multi-tab'];

module.exports = { SIGNAL_STATE, bench, GOOD_USER, boldInFake, call, say, json, PASTE, statusOf, HEAD, READING, EDITS, API_EDITS, lines,
  WRITE_ROWS, MODEL_ROWS, HANDS, API_ROWS, EXPORT_ROWS, deq };
