'use strict';
// The timeline rail of a turn's bubble (render.js syncRail, jsdom): each shown round and the answer (not the footer) are
// the items (.tl-item: a dot and a piece of the line in sidepanel.css), the first and the last marked (the line runs
// between their dots; a lone item has its dot only), the live one marked for the accent dot; the waiting cards, extra
// and the footer stand outside. And the Sources fold of a round (web-search.js renderSources): inside the round's item,
// where its searches ran, live and after a reload; collapsed by default, a click opens the links, a re-render keeps it
// open. The answer and a round's own text are message text (.msg-text), not rows.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, key, typeInto, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');
const { sseResponse, ev, tu, msgStart, stopTool, textRound } = require('../lib/streams');

let env, T, state, el;
before(async () => {
  env = await load();
  ({ T, state, el } = env);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: '# My Doc\n\nAlpha line.\n\nDelta line.', format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' });
});
after(() => env.close());

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const hidden = (n) => !!n.closest('.hidden');
const bubbles = () => [...el.chat.querySelectorAll('.msg.assistant')];
const tag = (n) => (n.classList.contains('stage') ? 'round' : n.classList.contains('msg-answer') ? 'answer' : n.className);
// The rail as drawn: the shown items in order with their marks.
const rail = (b) => [...b.querySelectorAll('.tl-item')].filter((n) => !hidden(n))
  .map((n) => [tag(n), ['tl-first', 'tl-last', 'tl-live'].filter((c) => n.classList.contains(c)).join(' ')]);
const SOURCES = [{ url: 'https://example.org/a', title: 'Page A' }, { url: 'https://example.org/b', title: 'Page B' }];

// Round 1 reads once (and its web search found two pages); round 2 reads twice; then the answer (with reasoning, so the
// footer's status has a body).
function history() {
  return [
    { role: 'user', content: 'Read.' },
    { role: 'assistant', content: 'Let me read it first.', reasoning: 'Plan.', _thoughtMs: 1000, tool_calls: [call('a1', 'read_lines', { start: 1, end: 2 })], _sources: SOURCES },
    { role: 'tool', tool_call_id: 'a1', content: 'Lines 1-2', _ok: true, _reading: true },
    { role: 'assistant', content: null, tool_calls: [call('b1', 'read_lines', { start: 3, end: 4 }), call('b2', 'get_outline', {})] },
    { role: 'tool', tool_call_id: 'b1', content: 'Lines 3-4', _ok: true, _reading: true },
    { role: 'tool', tool_call_id: 'b2', content: 'Outline', _ok: true, _reading: true },
    { role: 'assistant', content: 'All set.', _workedMs: 3000, _usage: { total_tokens: 20, prompt_tokens: 18, completion_tokens: 2 } },
  ];
}

test('an ended two-round turn: round 1, round 2, answer on one rail; the cards, extra and the footer outside; Sources in round 1', () => {
  state.messages = history();
  T.renderHistory();
  const b = bubbles()[0];
  assert.deepStrictEqual(rail(b), [['round', 'tl-first'], ['round', ''], ['answer', 'tl-last']]);
  // the items are the bubble's sequence: the stages, then the answer, in DOM order; the footer is not one
  const items = [...b.querySelectorAll('.tl-item')];
  assert.strictEqual(items[0], b.querySelector('.activity .stage'));
  assert.ok(!b.querySelector(':scope > .msg-foot').classList.contains('tl-item'));
  assert.ok(b.classList.contains('has-rail'));
  assert.strictEqual(items[items.length - 1], b.querySelector(':scope > .msg-answer'));
  for (const sel of [':scope > .msg-cards', ':scope > .msg-extra', ':scope > .msg-foot', ':scope > .msg-foot > .msg-meta']) {
    const n = b.querySelector(sel);
    assert.ok(n, sel);
    assert.ok(!n.classList.contains('tl-item') && !n.closest('.tl-item') && !n.querySelector('.tl-item'), `${sel} is outside the rail`);
  }
  assert.strictEqual(b.lastElementChild, b.querySelector(':scope > .msg-foot'), 'the footer is the last line');
  // a round's own text sits in its item first (it came before its calls), then its action row, then its Sources
  const s1 = b.querySelectorAll('.stage')[0];
  const src = s1.querySelector(':scope > .sources');
  assert.ok(src, 'round 1 holds its Sources');
  assert.strictEqual(s1.firstElementChild, s1.querySelector('.stage-text'), 'its own text first');
  assert.ok(s1.querySelector('.stage-text').compareDocumentPosition(s1.querySelector('.stage-rows')) & 4, 'its rows under its text');
  assert.ok(s1.querySelector('.stage-rows').compareDocumentPosition(src) & 4, 'its Sources after its rows');
  assert.strictEqual(s1.lastElementChild, src, 'the Sources last');
  assert.strictEqual(b.querySelectorAll('.sources').length, 1, 'nowhere else');
  assert.ok(!b.querySelector(':scope > .sources'), 'not under the answer');
});

test('the answer and a round\'s own text are message text: Markdown in the .msg-text style, not the row class', () => {
  state.messages = history();
  state.messages[1].content = 'Let me **read** it first.';
  T.renderHistory();
  const b = bubbles()[0];
  const md = b.querySelector('.msg-answer > .md');
  assert.ok(md.classList.contains('msg-text') && !md.classList.contains('activity-row') && !md.closest('.activity-row'));
  const text = b.querySelector('.stage .stage-text');
  assert.ok(text.classList.contains('msg-text') && !text.closest('.activity-row'));
  assert.strictEqual(text.innerHTML, '<p>Let me <strong>read</strong> it first.</p>', 'rendered as Markdown');
});

test('a two-round turn with a web search in round 1: "Sources · N" inside round 1\'s item live and after a reload', async () => {
  const cite = { type: 'web_search_result_location', url: 'https://example.org/a', title: 'Page A', encrypted_index: 'EI', cited_text: 'A.' };
  const round1 = msgStart +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv1', name: 'web_search' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: 'alpha' }) } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [{ type: 'web_search_result', url: 'https://example.org/a', title: 'Page A', encrypted_content: 'E' }] } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 1 }) +
    ev('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: cite } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Found it.' } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 2 }) +
    tu(3, 'c1', 'get_outline', {}) + stopTool;
  let n = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  env.ctx.fetch = async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };
    const i = n++;
    if (i === 0) return sseResponse(round1);
    await gate; // round 2 waits, so the live bubble can be looked at between the rounds
    return sseResponse(textRound('Done.'));
  };
  await T.createChat();
  typeInto(el.input, 'Search'); key(el.input, 'Enter');
  await waitFor(() => n === 2, 'round 2 requested');
  await tick(5);
  let b = bubbles().pop();
  assert.ok(b._live, 'the turn still runs');
  const stage1 = b.querySelector('.activity .stage');
  let src = stage1.querySelector(':scope > .sources');
  assert.ok(src, 'live: round 1 holds its Sources');
  assert.strictEqual(src.querySelector('summary').textContent, 'Sources · 1');
  assert.strictEqual(src.open, false, 'collapsed by default');
  assert.ok(stage1.classList.contains('tl-item') && !b.querySelector(':scope > .sources'));
  release();
  await waitFor(() => !state.busy, 'the end of the turn', 5000);
  await tick(5);
  const check = () => {
    b = bubbles().pop();
    const stages = [...b.querySelectorAll('.activity .stage')].filter((x) => !hidden(x));
    src = stages[0].querySelector(':scope > .sources');
    assert.ok(src, 'round 1 holds its Sources');
    assert.strictEqual(src.querySelectorAll('a').length, 1);
    assert.strictEqual(src.querySelector('a').getAttribute('href'), 'https://example.org/a');
    assert.strictEqual(b.querySelectorAll('.sources').length, 1, 'once, in round 1 only');
    assert.deepStrictEqual(rail(b).map(([t]) => t), ['round', 'answer']);
  };
  check(); // the end of the turn draws the bubble from the history
  el.chat.textContent = '';
  T.renderHistory(); // a reload
  check();
});

test('a history re-render draws the same rail', () => {
  const shape = () => rail(bubbles()[0]);
  T.renderHistory();
  const before = shape();
  el.chat.textContent = '';
  T.renderHistory();
  assert.deepStrictEqual(shape(), before);
  assert.strictEqual(bubbles().length, 1);
});

test('a lone answer has its dot and no line; a turn stopped before anything came has no rail', () => {
  state.messages = [{ role: 'user', content: 'Hi.' }, { role: 'assistant', content: 'Hello.' }];
  T.renderHistory();
  assert.deepStrictEqual(rail(bubbles()[0]), [['answer', 'tl-first tl-last']]);
  el.chat.textContent = '';
  const b = T.addAssistantBubble();
  T.endAssistantBubble(b, { workedMs: 2000, stopped: true });
  assert.deepStrictEqual(rail(b), []);
  assert.ok(!b.classList.contains('has-rail'));
});

test('live: no rail while thinking, the running call\'s round is the live item while it runs, the answer while it streams; new items append below', () => {
  el.chat.textContent = '';
  const b = T.addAssistantBubble();
  b._live = true;
  const pending = (id, name) => ({ log: true, id, name, summary: '', args: {}, result: null, status: 'pending' });
  const done = (id, name) => ({ ...pending(id, name), result: 'ok', status: 'ok' });
  T.updateAssistantBubble(b, { streaming: true, last: 'reasoning', reasoning: 'Hmm' });
  assert.deepStrictEqual(rail(b), []);
  T.updateAssistantBubble(b, { reasoning: 'Hmm', activity: [pending('r1', 'read_lines')] });
  assert.deepStrictEqual(rail(b), [['round', 'tl-first tl-last tl-live']]);
  const round1 = b.querySelector('.stage');
  T.updateAssistantBubble(b, { reasoning: 'Hmm', activity: [done('r1', 'read_lines')] });
  assert.deepStrictEqual(rail(b), [['round', 'tl-first tl-last']], 'between calls: no live dot, the footer\'s orb says Working…');
  T.startAssistantRound(b);
  T.updateAssistantBubble(b, { activity: [done('r2', 'read_lines'), pending('r3', 'get_outline')] });
  assert.deepStrictEqual(rail(b), [['round', 'tl-first'], ['round', 'tl-last tl-live']]);
  assert.strictEqual(b.querySelector('.stage'), round1, 'round 1 keeps its place');
  T.updateAssistantBubble(b, { activity: [done('r2', 'read_lines'), done('r3', 'get_outline')] });
  T.startAssistantRound(b);
  T.updateAssistantBubble(b, { streaming: true, last: 'text', text: 'All' });
  assert.deepStrictEqual(rail(b), [['round', 'tl-first'], ['round', ''], ['answer', 'tl-last tl-live']]);
  T.endAssistantBubble(b, { workedMs: 3000 });
  assert.deepStrictEqual(rail(b), [['round', 'tl-first'], ['round', ''], ['answer', 'tl-last']], 'ended: no live dot');
});

test('Sources: a fold "Sources · N" in its round, collapsed by default; a click opens the links; a re-render keeps it open', async () => {
  state.messages = history();
  T.renderHistory();
  let b = bubbles()[0];
  const S1 = ':scope .stage > .sources';
  let src = b.querySelector(S1);
  assert.strictEqual(src.tagName, 'DETAILS');
  const sum = src.querySelector(':scope > summary.sources-title');
  assert.strictEqual(sum.textContent, 'Sources · 2');
  assert.strictEqual(sum.querySelector('.sources-count').textContent, ' · 2');
  assert.strictEqual(src.open, false, 'collapsed by default');
  assert.strictEqual(src.previousElementSibling, b.querySelector('.stage .stage-rows'), 'after the round\'s rows (its own text leads the round)');
  click(sum);
  await tick(5);
  assert.strictEqual(src.open, true, 'a click opens it');
  const links = [...src.querySelectorAll('ol > li > a')];
  assert.deepStrictEqual(links.map((a) => [a.textContent, a.getAttribute('href'), a.target]),
    [['Page A', 'https://example.org/a', '_blank'], ['Page B', 'https://example.org/b', '_blank']]);
  // a re-render (the end of a turn, a reload): the same list in the same round, still open
  T.renderHistory();
  b = bubbles()[0];
  src = b.querySelector(S1);
  assert.strictEqual(b.querySelectorAll('.sources').length, 1);
  assert.strictEqual(src.open, true, 'kept across a re-render');
  assert.strictEqual(src.querySelectorAll('a').length, 2);
  click(src.querySelector('summary'));
  await tick(5);
  T.renderHistory();
  b = bubbles()[0];
  assert.strictEqual(b.querySelector(S1).open, false, 'folded again');
  assert.strictEqual(b.querySelector('.sources').closest('.tl-item'), b.querySelector('.stage'), 'in round 1\'s item');
});
