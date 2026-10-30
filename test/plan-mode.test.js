'use strict';
// Plan mode (applyMode 'plan', turn mode 'plan'): a read-only turn like Manual (the reading tools, no writing tool, no
// remember, no draft or revise), whose instructions carry TOOLS_PLAN_RULES (not the Manual rules, no remember note);
// writes and remember are refused if called anyway; a finished Plan answer is marked _plan, a Manual or Auto one is not.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, routeDocs, fresh;
const names = (mode, snap = as) => T.toolsFor(mode, snap).map((t) => t.function.name);
const call = (name, args, id = 'c' + Math.random().toString(36).slice(2, 6)) => ({ id, function: { name, arguments: JSON.stringify(args) } });

before(async () => {
  env = await load();
  ({ T, state } = env);
  ident = installIdentity(env);
  ({ routeDocs, fresh } = docsBench(env, ident, ref));
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true; state.applyMode = 'plan';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'k-T' });
});

test('Plan offers the reading tools of Manual without remember; no writing, draft or revise tool', async () => {
  await fresh();
  const plan = names('plan');
  deq(plan, names('manual').filter((n) => n !== 'remember'));
  for (const n of [...T.WRITE_TOOLS, T.REPLACE_TOOL.function.name, 'remember', 'draft', 'revise_section']) assert.ok(!plan.includes(n), n);
  assert.ok(names('edit').includes('draft') && names('edit').includes('revise_section')); // offered in Edit automatically
  assert.ok(plan.includes('read_lines') && plan.includes('ask_user') && plan.includes('open_document'));
});

test('Plan instructions: TOOLS_PLAN_RULES, not the Manual rules, no remember note; static and short', async () => {
  await fresh();
  const head = T.buildSystemParts('plan', 1e5, as).head;
  assert.ok(head.includes(T.TOOLS_PLAN_RULES));
  assert.ok(!head.includes(T.TOOLS_MANUAL_RULES) && !head.includes('<replacement>...</replacement>'));
  assert.ok(!head.includes(T.REMEMBER_NOTE));
  const manual = T.buildSystemParts('manual', 1e5, as).head;
  assert.ok(manual.includes(T.TOOLS_MANUAL_RULES) && manual.includes(T.REMEMBER_NOTE));
  assert.ok(!manual.includes(T.TOOLS_PLAN_RULES));
  assert.ok(T.TOOLS_PLAN_RULES.includes('numbered plan of edits') && T.TOOLS_PLAN_RULES.includes('ask_user'));
  assert.ok(!/\$\{/.test(T.TOOLS_PLAN_RULES));
  // about 120 tokens (the panel's estimate counts 3 characters per token, so it reads higher)
  assert.ok(T.TOOLS_PLAN_RULES.length <= 560, String(T.TOOLS_PLAN_RULES.length));
});

test('writes and remember called in Plan anyway are refused; the document stays as it was', async () => {
  await fresh();
  const before0 = fake.text('t.0');
  const w = await T.executeTool(call('replace_text', { old_text: 'Alpha beta gamma.', new_text: 'Changed.', doc: null }), 'plan', as, {});
  assert.strictEqual(w._ok, false);
  assert.match(w.content, /^Error: the document cannot be modified in this mode/);
  const r = await T.executeTool(call('remember', { action: 'add', text: 'Always use British spelling.' }), 'plan', as, {});
  assert.strictEqual(r._ok, false);
  assert.match(r.content, /^Error: remember is not available in Plan mode/);
  assert.strictEqual(fake.text('t.0'), before0);
});

test('a Plan turn: reading tools only in the request, the answer is marked _plan; a Manual answer is not', async () => {
  await fresh();
  const bodies = [];
  const rounds = [msgStart + tu(0, 'toolu_r', 'read_lines', { start: 1, end: 4, doc: null }) + stopTool, textRound('1. Line 4: shorten the sentence, because it repeats line 3.')];
  env.ctx.fetch = routeDocs(async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1] || textRound('ok')); });
  state.applyMode = 'plan';
  await T.createChat();
  T.el.input.value = 'Plan how to tighten the introduction';
  await T.sendMessage();
  assert.strictEqual(bodies.length, 2);
  const tools = bodies[0].tools.map((t) => t.name);
  assert.ok(!tools.some((n) => T.WRITE_TOOLS.includes(n) || n === 'replace_selection' || n === 'remember'), tools.join());
  assert.ok(bodies[0].system.some((b) => b.text.includes(T.TOOLS_PLAN_RULES)));
  const last = state.messages[state.messages.length - 1];
  deq([last.role, last._plan], ['assistant', true]);
  bodies.length = 0;
  rounds.splice(0, rounds.length, textRound('A synonym: brief.'));
  state.applyMode = 'manual';
  T.el.input.value = 'Suggest a synonym';
  await T.sendMessage();
  assert.strictEqual(state.messages[state.messages.length - 1]._plan, undefined);
  state.applyMode = 'plan';
});
