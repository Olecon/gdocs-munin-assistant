'use strict';
// The Do it button of a Plan answer (jsdom): under the latest Plan answer only, with Copy and without Apply; a click
// switches the mode to Edit automatically (stored) and sends PLAN_DO_TEXT once through the Send path, as an Edit
// automatically turn; Manual and Edit automatically answers have no Do it; ignored while an answer runs.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, key, typeInto, tick } = require('../lib/dom-sandbox');
const { installDocTab, waitFor } = require('../lib/sandbox');
const { sseResponse, textRound } = require('../lib/streams');

let env, T, state, el, bodies;
before(async () => {
  env = await load();
  ({ T, state, el } = env);
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: '# My Doc\n\nAlpha line.\nBeta line.', format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' });
  bodies = [];
  env.ctx.fetch = async (url, init) => {
    if (!String(url).includes('api.anthropic.com')) return { ok: false, status: 404, text: async () => '' };
    bodies.push(JSON.parse(init.body));
    return sseResponse(textRound(bodies.length === 1 ? '1. Line 3: merge it into line 2, because both say the same.' : 'Done.'));
  };
});
after(() => env.close());

const $$ = (sel) => [...env.document.querySelectorAll(sel)];
async function send(text) {
  typeInto(el.input, text);
  key(el.input, 'Enter');
  await waitFor(() => !state.busy && !el.action.classList.contains('stopping'), 'the end of the turn');
  await tick(5);
}

test('a Plan answer gets Do it and Copy; Do it switches to Edit automatically and sends once', async () => {
  T.applyApplyMode('plan');
  await T.createChat();
  await send('Plan how to tighten this');
  const last = $$('.msg.assistant').pop();
  const doIt = last.querySelector('button[data-act="plan-do"]');
  assert.ok(doIt);
  assert.strictEqual(doIt.textContent, 'Do it');
  assert.ok(last.querySelector('button[data-act="copy-msg"]'));
  assert.strictEqual(last.querySelector('button[data-act="apply-msg"]'), null);
  assert.ok(!bodies[0].tools.some((t) => t.name === 'replace_selection' || t.name === 'remember'));
  // ignored while an answer runs
  state.busy = true;
  await T.doPlanFromButton(doIt);
  state.busy = false;
  assert.strictEqual(bodies.length, 1);
  assert.strictEqual(state.applyMode, 'plan');
  click(doIt);
  await waitFor(() => bodies.length === 2 && !state.busy, 'the Do it turn');
  await tick(5);
  assert.strictEqual(state.applyMode, 'auto');
  assert.strictEqual(env.storage.muninApplyMode, 'auto');
  assert.strictEqual(el.modeLabel.textContent, 'Edit automatically');
  const users = state.messages.filter((m) => m.role === 'user' && !m._auto);
  assert.strictEqual(users.length, 2);
  assert.strictEqual(users[1].content, T.PLAN_DO_TEXT);
  assert.strictEqual(T.PLAN_DO_TEXT, 'Carry out the plan above, step by step, one edit per step.');
  assert.ok(bodies[1].tools.some((t) => t.name === 'replace_selection')); // an Edit automatically turn
  // the plan is no longer the latest message, and the Edit automatically answer has none
  assert.strictEqual($$('button[data-act="plan-do"]').length, 0);
  assert.ok(state.messages.some((m) => m._plan));
  assert.strictEqual(state.messages[state.messages.length - 1]._plan, undefined);
});

test('a Manual answer has no Do it (Apply and Copy as before)', async () => {
  T.applyApplyMode('manual');
  bodies.length = 0;
  await T.createChat();
  await send('Suggest a title');
  const last = $$('.msg.assistant').pop();
  assert.strictEqual(last.querySelector('button[data-act="plan-do"]'), null);
  assert.ok(last.querySelector('button[data-act="apply-msg"]'));
});
