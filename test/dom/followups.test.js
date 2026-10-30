'use strict';
// After a /research answer on a real DOM: "Ask about" chips for the sources the answer did not use (none without
// sources or when all are used), one click sends one /research message in the question's language through the Send
// path, the chips are not stored and go with the next message; the key findings notice.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');
const { useProvider, send, oaText } = require('../lib/context');
const { sseResponse, ev } = require('../lib/streams');

let env, T, state, el, chrome, bodies, replies;
const DOC = '# Notes\n\nRafts.';
const SOURCES = [
  { url: 'https://example.org/a', title: 'Lipid rafts in membranes' },
  { url: 'https://example.org/b', title: 'Raft dynamics | Nature' },
  { url: 'https://example.org/c', title: 'Cholesterol and order' },
];
// An OpenAI answer whose message item cites the given sources (url_citation annotations: the Sources list).
function oaCited(text, sources) {
  const msg = { type: 'message', id: 'msg_c', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text,
    annotations: sources.map((s) => ({ type: 'url_citation', start_index: 0, end_index: 1, url: s.url, title: s.title })) }] };
  return ev('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, delta: text }) +
    ev('response.completed', { type: 'response.completed', response: { status: 'completed', output: [msg], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
}
const chips = () => [...el.chat.querySelectorAll('.followups .followup-chip')];
const notices = () => [...el.chat.querySelectorAll('.msg.notice')].map((n) => n.textContent);
const idle = () => waitFor(() => !state.busy, 'the panel to be idle').then(() => tick(80));

before(async () => {
  env = await load();
  ({ T, state, el, chrome } = env);
  installDocTab(env);
  chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: DOC, format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  useProvider(env, 'openai');
  state.applyMode = 'manual';
  bodies = [];
  replies = [];
  env.window.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(replies.shift() || oaText('Done.')); };
});
after(() => env.close());

test('chips for the unused sources only, under the answer, never stored', async () => {
  await T.createChat();
  replies.push(oaCited('Rafts are ordered ([Lipid rafts in membranes](https://example.org/a)).', SOURCES));
  await send(env, '/research How long do lipid rafts live?');
  await idle();
  assert.deepStrictEqual(chips().map((c) => c.textContent), ['Ask about: Raft dynamics', 'Ask about: Cholesterol and order']);
  const box = el.chat.querySelector('.followups');
  assert.ok(box.previousElementSibling.classList.contains('assistant'), 'right under the answer');
  assert.strictEqual(chips()[0].title, '/research What does «Raft dynamics» add to the question: How long do lipid rafts live?');
  assert.ok(!JSON.stringify(state.messages).includes('Ask about'));
  // A re-render (chat switch, reload) does not bring them back.
  T.renderHistory();
  assert.strictEqual(chips().length, 0);
});

test('a click sends one /research message through the Send path; the chips go', async () => {
  await T.createChat();
  replies.push(oaCited('See [Lipid rafts in membranes](https://example.org/a).', SOURCES));
  await send(env, '/research How long do lipid rafts live?');
  await idle();
  const n = bodies.length;
  replies.push(oaText('Raft dynamics adds lifetimes.'));
  const chip = chips()[0];
  click(chip);
  click(chip); // a second click on the same chip sends nothing
  await idle();
  assert.strictEqual(bodies.length, n + 1);
  const user = state.messages.filter((m) => m.role === 'user').pop();
  assert.strictEqual(user._persona, 'research');
  assert.strictEqual(user.content, 'What does «Raft dynamics» add to the question: How long do lipid rafts live?');
  assert.ok(bodies[n].tools.some((t) => t.type === 'web_search'));
  // The answer to the chip used no source: no chips from it (it has none), and the old ones are gone.
  assert.strictEqual(chips().length, 0);
});

test('the next message removes the chips; none without sources or when every source is used', async () => {
  await T.createChat();
  replies.push(oaCited('Nothing linked.', SOURCES.slice(0, 1)));
  await send(env, '/research Rafts?');
  await idle();
  assert.strictEqual(chips().length, 1);
  replies.push(oaText('Plain.'));
  const turn = send(env, 'thanks');
  await waitFor(() => chips().length === 0, 'the chips to go when the next turn starts');
  await turn;
  await idle();
  // No sources at all.
  replies.push(oaText('An answer without sources.'));
  await send(env, '/research Rafts?');
  await idle();
  assert.strictEqual(chips().length, 0);
  // Every source used (by URL or title).
  replies.push(oaCited('See https://example.org/a, Raft dynamics and Cholesterol and order.', SOURCES));
  await send(env, '/research Rafts?');
  await idle();
  assert.strictEqual(chips().length, 0);
  // Not after another persona.
  replies.push(oaCited('Nothing linked.', SOURCES));
  await send(env, '/chat Rafts?');
  await idle();
  assert.strictEqual(chips().length, 0);
});

test('a Russian question gets a Russian follow-up', async () => {
  await T.createChat();
  replies.push(oaCited('Плоты упорядочены.', SOURCES.slice(1, 2)));
  await send(env, '/research Сколько живут липидные рафты?');
  await idle();
  assert.strictEqual(chips().length, 1);
  assert.strictEqual(chips()[0].textContent, 'Ask about: Raft dynamics');
  replies.push(oaText('Ответ.'));
  click(chips()[0]);
  await idle();
  const user = state.messages.filter((m) => m.role === 'user').pop();
  assert.strictEqual(user.content, 'Что добавляет «Raft dynamics» к вопросу: Сколько живут липидные рафты?');
});

test('the key findings notice counts the bullets without a source link', async () => {
  await T.createChat();
  const answer = '## TL;DR\nRafts are small.\n\n## Key findings\n- Ordered ([a](https://example.org/a)).\n- Short-lived.\n- Small.\n\n## Details\nMore.';
  replies.push(oaCited(answer, SOURCES.slice(0, 1)));
  await send(env, '/research Rafts?');
  await idle();
  assert.ok(notices().includes('2 key findings have no source link.'), notices().join(' | '));
  replies.push(oaCited('## Key findings\n- Ordered ([a](https://example.org/a)).', SOURCES.slice(0, 1)));
  await send(env, '/research Rafts?');
  await idle();
  assert.ok(!notices().some((t) => /key finding/.test(t)), 'every finding linked: no notice');
});
