'use strict';
// The remember tool: its definition and where it is offered, add / remove / duplicate / limit / not found, the
// result text, storage and the panel state, the card's Revert (one-shot), the action-log summary and a turn
// whose remember call is not a document edit (no responseWrite, no journal, this turn's prompt unchanged); the edit
// gate in a tainted turn.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, waitFor } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');

let env, T, state, storage, sandbox;
const KEY = 'muninDocInstructions:DOC123';
const snap = () => { const s = T.takeSnapshot(); T.snapshotDocument(s); return s; };
const call = (id, args) => ({ id, type: 'function', function: { name: 'remember', arguments: JSON.stringify(args) } });
const run = (id, args, mode = 'edit') => T.executeTool(call(id, args), mode, snap(), {});
const setInstructions = (t) => { if (t) storage[KEY] = t; else delete storage[KEY]; state.docInstructions = t; };

before(async () => {
  env = await load();
  ({ T, state, storage } = env);
  sandbox = env.ctx;
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_DOC_TEXT'
    ? { ok: true, text: '# My Doc\n\nThe quick brown fox.', format: 'markdown', title: 'My Doc' }
    : msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  assert.strictEqual(state.docId, 'DOC123');
});

test('definition: offered with the reading tools in Auto and Manual (not to Munin persona turns); main document only', () => {
  deq(T.TOOL_DEFS.remember.function, {
    name: 'remember',
    description: "Add a standing rule to this document's instructions (sent with every message), or remove one. Only when the user asks to remember or forget something for the future.",
    parameters: { type: 'object', additionalProperties: false, required: ['action', 'text'], properties: {
      action: { type: 'string', enum: ['add', 'remove'], description: 'add appends the rule as a new line; remove deletes the line that matches text exactly.' },
      text: { type: 'string', description: "The rule, one line, in the user's wording." },
    } },
  });
  assert.strictEqual(T.TOOL_DEFS.remember.function.parameters.properties.doc, undefined); // no "doc": the main document only
  for (const [mode, prov] of [['edit', 'anthropic'], ['manual', 'anthropic'], ['edit', 'munin'], ['manual', 'openai'], ['research', 'anthropic']]) {
    state.settings.provider = prov;
    const s = snap();
    assert.ok(T.toolsFor(mode, s).some((t) => t.function.name === 'remember'), `${mode}/${prov}`);
    assert.ok(T.buildSystemParts(mode, 1000, s).head.includes(`\n\n${T.REMEMBER_NOTE}\n\n`), `${mode}/${prov}: the rule`);
  }
  state.settings.provider = 'munin';
  deq(T.toolsFor('code', snap()), []); // Munin persona turns: no client tools, no rule
  assert.ok(!T.buildSystemParts('code', 1000, snap()).head.includes('remember('));
  state.settings.provider = 'anthropic';
});

test('add: one line appended (hand-written text kept), the result shows the whole instructions, the panel follows', async () => {
  setInstructions('Use British English.\nTarget journal: Nature.');
  const s = snap();
  const r = await T.executeTool(call('r1', { action: 'add', text: '  Always write\n "per cent"  in full. ' }), 'manual', s, {});
  assert.strictEqual(r.content, 'Document instructions now:\nUse British English.\nTarget journal: Nature.\nAlways write "per cent" in full.');
  assert.ok(r._ok); assert.strictEqual(r._message, 'Added to Document instructions: «Always write "per cent" in full.»');
  assert.strictEqual(r._icon, '📌');
  deq(r._remember, { action: 'add', text: 'Always write "per cent" in full.', index: 2 });
  assert.strictEqual(r._edit, undefined); assert.strictEqual(s.responseWrite, undefined); // not a document edit
  assert.strictEqual(storage[KEY], 'Use British English.\nTarget journal: Nature.\nAlways write "per cent" in full.');
  assert.strictEqual(state.docInstructions, storage[KEY]);
  assert.strictEqual(s.docInstructions, 'Use British English.\nTarget journal: Nature.'); // this turn keeps its instructions
  assert.ok(!T.buildSystemParts('manual', 1000, s).head.includes('per cent'));
  assert.ok(T.buildSystemParts('manual', 1000, snap()).head.includes('Always write "per cent" in full.')); // the next message
  // the first rule of an empty document
  setInstructions('');
  const first = await run('r2', { action: 'add', text: 'Use Oxford commas.' });
  assert.strictEqual(first.content, 'Document instructions now:\nUse Oxford commas.');
  assert.strictEqual(storage[KEY], 'Use Oxford commas.'); assert.ok(!T.el.instructionsDot.classList.contains('hidden'));
});

test('add: duplicate, empty, invalid action, over the limit', async () => {
  setInstructions('Use British English.\nTarget journal: Nature.');
  let r = await run('d1', { action: 'add', text: ' Target journal: Nature. ' });
  assert.ok(r._ok && !r._remember);
  assert.strictEqual(r.content, 'Already in the document instructions (line 2); nothing changed.\nDocument instructions now:\nUse British English.\nTarget journal: Nature.');
  assert.strictEqual(r._message, 'Already in Document instructions: «Target journal: Nature.»');
  r = await run('d2', { action: 'add', text: ' \n ' });
  assert.ok(!r._ok); assert.strictEqual(r.content, 'Error: the rule is empty.');
  r = await run('d3', { action: 'replace', text: 'x' });
  assert.ok(!r._ok); assert.strictEqual(r.content, 'Error: action must be "add" or "remove".');
  setInstructions('x'.repeat(7990));
  r = await run('d4', { action: 'add', text: 'A rule that does not fit.' });
  assert.ok(!r._ok);
  assert.strictEqual(r.content, 'Error: the document instructions would exceed the limit of 8,000 characters (now 7,990). Shorten the rule or remove one first.');
  assert.strictEqual(r._message, 'Document instructions are full (8,000 characters)');
  assert.strictEqual(storage[KEY].length, 7990); // unchanged
});

test('remove: the first exact line (case-sensitive); not found lists the closest lines; empty instructions', async () => {
  setInstructions('Use British English.\nKeep the term "lipid raft".\nTarget journal: Nature.\nUse British English.');
  let r = await run('m1', { action: 'remove', text: ' Use British English. ' });
  assert.ok(r._ok);
  assert.strictEqual(r.content, 'Document instructions now:\nKeep the term "lipid raft".\nTarget journal: Nature.\nUse British English.');
  assert.strictEqual(r._message, 'Removed from Document instructions: «Use British English.»');
  deq(r._remember, { action: 'remove', text: 'Use British English.', index: 0 });
  r = await run('m2', { action: 'remove', text: 'use british english' });
  assert.ok(!r._ok);
  assert.strictEqual(r.content, 'Error: no line of the document instructions is exactly "use british english". Closest lines:\n' +
    'Use British English.\nKeep the term "lipid raft".\nTarget journal: Nature.\nCall remember again with the exact text of the line to remove.');
  assert.strictEqual(r._message, 'Not in Document instructions: «use british english»');
  setInstructions('Use British English.');
  r = await run('m3', { action: 'remove', text: 'Use British English.' });
  assert.strictEqual(r.content, 'Document instructions now:\n(empty)');
  assert.ok(!(KEY in storage)); assert.strictEqual(state.docInstructions, ''); // the key is removed, as by an empty Save
  assert.ok(T.el.instructionsDot.classList.contains('hidden'));
  r = await run('m4', { action: 'remove', text: 'Anything' });
  assert.strictEqual(r.content, 'Error: the document instructions are empty.');
});

test('Revert: undoes exactly that change once (a removed line goes back to its place)', async () => {
  setInstructions('One.\nTwo.\nThree.');
  const r = await run('v1', { action: 'remove', text: 'Two.' });
  state.messages = [{ role: 'user', content: 'Forget rule two' }, { role: 'assistant', content: null, tool_calls: [call('v1', { action: 'remove', text: 'Two.' })] }, r];
  await T.saveHistory();
  setInstructions('One.\nThree.\nFour.'); // edited by hand meanwhile
  assert.strictEqual(await T.revertRememberFromButton('v1', null), true);
  assert.strictEqual(storage[KEY], 'One.\nTwo.\nThree.\nFour.');
  assert.strictEqual(state.messages[2]._remember.reverted, true);
  assert.ok(state.messages[2].content.endsWith('\n[Later the user reverted this change with the Revert button.]'));
  assert.strictEqual(await T.revertRememberFromButton('v1', null), false);
  assert.strictEqual(storage[KEY], 'One.\nTwo.\nThree.\nFour.');
  const card = T.toolCardFor(state.messages[1].tool_calls[0], state.messages[2]);
  assert.ok(card.innerHTML.includes('data-act="revert-remember" data-call="v1" disabled'));
  assert.ok(card.innerHTML.includes('>Reverted</button>'));
  // a failed call has no Revert button
  const bad = await run('v2', { action: 'remove', text: 'Nope.' });
  assert.ok(!T.toolCardFor(call('v2', { action: 'remove', text: 'Nope.' }), bad).innerHTML.includes('revert-remember'));
  state.messages = [];
});

test('action log: add: «text» / remove: «text» with the 📌 icon', () => {
  const entries = T.actionLogFromToolCalls([call('a1', { action: 'add', text: 'Use British English.' }), call('a2', { action: 'remove', text: 'Old rule' })]);
  deq(entries.map((e) => e.summary), ['add: «Use British English.»', 'remove: «Old rule»']);
  assert.strictEqual(T.EDIT_TOOL_ICONS.remember, '📌');
});

test('a turn with a remember call: a card, no journal, no responseWrite; the next message carries the rule', async () => {
  setInstructions('Use British English.');
  state.settings.provider = 'anthropic';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'sk-ant-x', model: 'claude-opus-5-5', baseUrl: 'https://api.anthropic.com/v1' });
  const bodies = [];
  const rounds = [msgStart + tu(0, 'toolu_rem', 'remember', { action: 'add', text: 'Always use SI units.' }) + stopTool, textRound('Noted.')];
  sandbox.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); };
  const s = snap();
  const messages = [{ role: 'user', content: 'From now on, always use SI units.' }];
  const out = await T.toolLoop('edit', s, new AbortController().signal, { messages, save: async () => {} });
  assert.strictEqual(bodies.length, 2);
  deq(out.tools, ['remember']); assert.strictEqual(out.replaced, false);
  assert.strictEqual(s.responseWrite, null); // reset per response, never set by remember
  const r = messages.find((m) => m.role === 'tool');
  assert.ok(r._ok && r._remember && !r._edit);
  assert.strictEqual(T.latestUndoable(messages), null); // nothing in the edit journal
  assert.strictEqual(bodies[1].system[0].text, bodies[0].system[0].text); // this turn's prompt is unchanged
  assert.ok(!bodies[1].system[0].text.includes('Always use SI units.'));
  assert.strictEqual(storage[KEY], 'Use British English.\nAlways use SI units.');
  assert.ok(T.buildRequest('edit', snap()).body.system[0].text.includes('Use British English.\nAlways use SI units.'));
  setInstructions('');
});

test('edit gate: a tainted turn asks (add and remove; Deny leaves the instructions unchanged, Allow applies), a clean turn does not', async () => {
  const decide = async (promise, decision) => {
    await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
    const [[id, p]] = [...T.pendingPreviews.entries()];
    const html = p.card.innerHTML;
    assert.ok(T.decidePreview(id, decision));
    return { r: await promise, html };
  };
  const tainted = () => Object.assign(snap(), { tainted: true });
  setInstructions('Use British English.');
  // Deny: the usual refusal, nothing stored
  let { r, html } = await decide(T.executeTool(call('g1', { action: 'add', text: 'Always cite DOIs.' }), 'edit', tainted(), {}), 'reject');
  assert.ok(html.includes('remember') && html.includes('This edit adds a line to the document instructions.') && html.includes('Always cite DOIs.'));
  assert.strictEqual(r.content, T.EDIT_DENIED_TEXT); assert.strictEqual(r._decision, 'rejected'); assert.ok(!r._ok && !r._remember);
  assert.strictEqual(storage[KEY], 'Use British English.');
  ({ r, html } = await decide(T.executeTool(call('g2', { action: 'remove', text: 'Use British English.' }), 'manual', tainted(), {}), 'reject'));
  assert.ok(html.includes('This edit removes a line from the document instructions.'));
  assert.strictEqual(r.content, T.EDIT_DENIED_TEXT); assert.strictEqual(storage[KEY], 'Use British English.');
  // Allow: applied, with the instructions read again after the wait (a hand edit meanwhile is kept)
  const p = T.executeTool(call('g3', { action: 'add', text: 'Always cite DOIs.' }), 'edit', tainted(), {});
  await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
  storage[KEY] = 'Use British English.\nTarget journal: Nature.';
  ({ r } = await decide(p, 'accept'));
  assert.ok(r._ok && r._remember); assert.strictEqual(r._decision, 'accepted');
  assert.strictEqual(storage[KEY], 'Use British English.\nTarget journal: Nature.\nAlways cite DOIs.');
  // a clean turn: no card
  r = await run('g4', { action: 'remove', text: 'Always cite DOIs.' });
  assert.ok(r._ok); assert.strictEqual(r._decision, undefined); assert.strictEqual(T.pendingPreviews.size, 0);
  setInstructions('');
});
