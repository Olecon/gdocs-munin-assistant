'use strict';
// The live bubble's slots (render.js addAssistantBubble, paintBubble; jsdom): activity, answer, waiting cards, extra and
// the footer (the status with the reasoning, the token line), in one fixed order that never changes while the turn runs.
// Recorded at every mutation of a real turn: the footer is the last line and shows its status at every step while the
// panel is busy, its token line never does (only once the turn has ended), each round's action row
// stays where it appeared and a new round's item appends below (the timeline rail only grows downwards, one live dot), a
// waiting card is never inside the activity, and a click on a round's action row while a card waits folds and unfolds it
// like any other time.
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
  state.applyMode = 'auto'; T.applyApplyMode('auto');
});
after(() => env.close());

const think = (t) => ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } }) + ev('content_block_stop', { type: 'content_block_stop', index: 0 });
const SLOTS = ['activity', 'msg-answer', 'msg-cards', 'msg-extra', 'msg-foot'];
const slotOf = (c) => SLOTS.find((k) => c.classList.contains(k)) || c.className;
const hidden = (n) => !!n.closest('.hidden');
const lastBubble = () => [...el.chat.querySelectorAll('.msg.assistant')].pop();

// Every distinct state of the live bubble while the panel is busy: the order of its children, the visible slots, the
// status text, the first visible line of the activity, and where the waiting cards are.
function record() {
  const steps = [];
  const look = () => {
    const b = lastBubble();
    if (!b || !b._live || !state.busy) return;
    const act = b.querySelector('.activity');
    const orb = b.querySelector('.msg-foot > .thinking > summary > canvas.orb');
    // each shown round's action row: "Actions N" or its one call's name
    const rounds = hidden(act) ? [] : [...act.querySelectorAll('.activity-rows > .stage')].filter((x) => !hidden(x)).map((x) => (!hidden(x.querySelector('.stage-head'))
      ? x.querySelector('.stage-line').textContent : x.querySelector('.activity-row .activity-name').textContent));
    // the timeline rail: the shown items in order (R round, A answer), the live one, the line's ends
    const tag = (n) => (n.classList.contains('stage') ? 'R' : 'A');
    const items = [...b.querySelectorAll('.tl-item')].filter((n) => !hidden(n));
    const s = {
      order: [...b.children].map(slotOf).join(' '),
      visible: [...b.children].filter((c) => !c.classList.contains('hidden')).map(slotOf).join(' '),
      status: hidden(b.querySelector('.thinking-label')) ? '' : b.querySelector('.thinking-label').textContent,
      orb: orb && !orb.classList.contains('hidden') ? orb.dataset.orb : null,
      meta: !hidden(b.querySelector('.msg-meta')),
      last: b.lastElementChild.className,
      rounds: rounds.join(' | '),
      rail: items.map(tag).join(''),
      live: items.filter((n) => n.classList.contains('tl-live')).map(tag).join(''),
      ends: [items.findIndex((n) => n.classList.contains('tl-first')), items.findIndex((n) => n.classList.contains('tl-last'))].join(','),
      lasts: items.filter((n) => n.classList.contains('tl-last')).length,
      cardsInActivity: b.querySelectorAll('.activity .tool-card.preview:not(.decided)').length,
    };
    const key = JSON.stringify(s);
    if (!steps.length || steps[steps.length - 1].key !== key) steps.push({ ...s, key });
  };
  const obs = new env.window.MutationObserver(look);
  obs.observe(el.chat, { childList: true, subtree: true, characterData: true, attributes: true });
  return { steps, stop: () => obs.disconnect() };
}

test('a two-round turn: one slot order throughout, the footer last with its status at every step, no tokens while busy, each round\'s item stays and the next appends below', async () => {
  let n = 0;
  env.ctx.fetch = async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };
    const i = n++;
    await new Promise((r) => setTimeout(r, 20));
    if (i === 0) return sseResponse(msgStart + think('Plan.') + tu(1, 't1', 'get_outline', {}) + stopTool);
    if (i === 1) return sseResponse(msgStart + think('More.') + tu(1, 't2', 'find_in_document', { query: 'Delta', doc: null }) + stopTool);
    return sseResponse(textRound('Done.'));
  };
  await T.createChat();
  const rec = record();
  typeInto(el.input, 'Go'); key(el.input, 'Enter');
  await waitFor(() => !state.busy, 'the end of the turn', 5000);
  rec.stop();
  const { steps } = rec;
  assert.ok(steps.length >= 4, JSON.stringify(steps.map((s) => s.visible)));
  for (const s of steps) {
    assert.strictEqual(s.order, SLOTS.join(' '), 'the slots never move');
    assert.ok(s.visible.endsWith('msg-foot'), `the footer shows, last: ${s.key}`);
    assert.match(s.last, /^msg-foot\b/, `the footer is the bubble's last child: ${s.key}`);
    assert.ok(s.status, `the footer's status has words: ${s.key}`);
    assert.ok(s.orb, `the orb shows: ${s.key}`);
    assert.ok(!s.meta, `no tokens while busy: ${s.key}`);
    // the rail: the rounds then the answer (the footer is not an item), at most one live dot, the line from the
    // first item to the last
    assert.ok(/^R*A?$/.test(s.rail), `the rail's order: ${s.key}`);
    assert.ok(s.live.length <= 1, `at most one live item: ${s.key}`);
    if (s.rail) { assert.strictEqual(s.ends, `0,${s.rail.length - 1}`, `the line's ends: ${s.key}`); assert.strictEqual(s.lasts, 1); } else assert.strictEqual(s.lasts, 0);
  }
  // the rounds' action rows: each stays where it appeared, a new round appends below (append-only, no jump)
  const seq = steps.map((s) => s.rounds).filter(Boolean);
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i].startsWith(seq[i - 1]), JSON.stringify(seq));
  assert.strictEqual(seq[seq.length - 1], 'get_outline | find_in_document');
  // the running call's round is the live item while it runs
  assert.ok(steps.some((s) => s.rail === 'R' && s.live === 'R'), JSON.stringify(steps.map((s) => [s.rail, s.live, s.status])));
  // the answer comes under the activity and stays to the end
  const withAnswer = steps.findIndex((s) => s.visible.includes('msg-answer'));
  assert.ok(withAnswer > 0 && steps.slice(withAnswer).every((s) => s.visible.includes('activity msg-answer')));
  // the end: the bubble from the history has its meta line and past tense
  await tick(10);
  const b = lastBubble();
  assert.ok(!b._live);
  assert.match(b.querySelector('.msg-foot .thinking-label').textContent, /^Worked for \d+s$/);
  assert.ok(!b.querySelector('.msg-foot > .msg-meta').classList.contains('hidden'), 'the tokens come with the end, in the footer');
  assert.strictEqual(b.lastElementChild, b.querySelector('.msg-foot'));
});

test('a card waits: never inside the activity; its round is the live item; a click on the round\'s action row folds and unfolds it while the card waits', async () => {
  let n = 0;
  env.ctx.fetch = async (url) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };
    const i = n++;
    if (i === 0) return sseResponse(msgStart + tu(0, 'w1', 'get_outline', {}) + tu(1, 'w2', 'ask_user', { question: 'Which?', options: ['A', 'B'] }) + stopTool);
    return sseResponse(textRound('Done.'));
  };
  await T.createChat();
  const rec = record();
  typeInto(el.input, 'Ask me'); key(el.input, 'Enter');
  await waitFor(() => T.pendingPreviews.size === 1, 'the question card');
  const b = lastBubble();
  const card = b.querySelector('.tool-card.preview.ask');
  assert.strictEqual(card.parentElement, b.querySelector('.msg-cards'));
  const stage = b.querySelector('.activity-rows > .stage');
  const toggle = stage.querySelector('.stage-head > .stage-line');
  assert.match(toggle.textContent, /^Actions 2\b/);
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(stage.classList.contains('tl-live') && !b.querySelector('.msg-foot').classList.contains('tl-live'), 'the waiting call\'s round has the live dot');
  assert.ok(!card.closest('.tl-item'), 'the waiting card is outside the rail');
  click(toggle);
  await tick();
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true', 'the click opens the round');
  assert.ok(!stage.querySelector('.stage-rows').classList.contains('hidden'));
  click(toggle);
  await tick();
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false', 'a second click folds it, the card still waiting');
  assert.ok(stage.querySelector('.stage-rows').classList.contains('hidden'));
  assert.ok(!hidden(card), 'the question stays in view');
  assert.strictEqual(b.querySelector('.thinking canvas.orb').dataset.orb, 'wave');
  click(card.querySelectorAll('button[data-ask]')[0]);
  await waitFor(() => !state.busy, 'the end of the turn');
  rec.stop();
  assert.ok(rec.steps.length > 1);
  for (const s of rec.steps) {
    assert.strictEqual(s.cardsInActivity, 0, `never inside the activity: ${s.key}`);
    assert.strictEqual(s.order, SLOTS.join(' '));
  }
  assert.ok(rec.steps.some((s) => s.visible.includes('msg-cards')), 'the cards slot showed');
  // decided: its answered row after the ask_user row, in the activity
  const row = [...el.chat.querySelectorAll('.answered-row')].pop();
  assert.ok(row.closest('.activity'));
  assert.strictEqual(row.previousElementSibling.querySelector('.activity-name').textContent, 'ask_user');
});
