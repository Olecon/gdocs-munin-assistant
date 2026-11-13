'use strict';
// The remember tool: its definition and where it is offered, add / remove / replace / duplicate / limit / not found in
// both scopes (main: every document; document, also for a missing or unknown scope), the result text, storage and the
// panel state, its action-log row (no card, no Revert), the action-log summary and a turn whose remember call is not
// a document edit (no responseWrite, this turn's prompt unchanged) but is journaled (kind 'remember', undone with the
// edits: test/remember-undo.test.js); the edit gate in a tainted turn.
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

test('definition: offered with the reading tools in Auto and the read-only chat turn (not to Munin persona turns); main document only', () => {
  deq(T.TOOL_DEFS.remember.function, {
    name: 'remember',
    description: 'Add, remove or change one line of MAIN.md or DOC.md, the standing instructions. Only when the user explicitly asks to remember, forget, review or change a rule for the future ("always", "from now on", "remember", "don\'t … anymore"), never on your own initiative; store lasting preferences, not one-off requests; confirm in one line. A new rule that contradicts a line added earlier replaces that line; never rewrite lines the user wrote by hand unless asked. ' +
      'Asked to learn or match the user\'s style ("learn my style", "write like me"): read two or three paragraphs they wrote and remember one compact style line (register, rhythm, we/I/impersonal, hedging, citations, punctuation, what to avoid), replacing an earlier style line.',
    parameters: { type: 'object', additionalProperties: false, required: ['scope', 'action', 'text', 'old'], properties: {
      scope: { type: 'string', enum: ['main', 'document'], description: 'main: MAIN.md (every document); document: DOC.md' },
      action: { type: 'string', enum: ['add', 'remove', 'replace'], description: 'replace: the line equal to old becomes text' },
      text: { type: 'string', description: "one line in English, close to the user's words" },
      old: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'replace: the current line; else null' },
    } },
  });
  assert.strictEqual(T.TOOL_DEFS.remember.function.parameters.properties.doc, undefined); // no "doc": the main document only
  for (const [mode, prov] of [['edit', 'anthropic'], ['manual', 'anthropic'], ['edit', 'munin'], ['manual', 'openai'], ['research', 'anthropic']]) {
    state.settings.provider = prov;
    const s = snap();
    assert.ok(T.toolsFor(mode, s).some((t) => t.function.name === 'remember'), `${mode}/${prov}`);
    assert.ok(`${T.buildSystemParts(mode, 1000, s).head}\n\n`.includes(`\n\n${T.REMEMBER_NOTE}\n\n`), `${mode}/${prov}: the rule`);
  }
  state.settings.provider = 'munin';
  deq(T.toolsFor('code', snap()), []); // Munin persona turns: no client tools, no rule
  assert.ok(!T.buildSystemParts('code', 1000, snap()).head.includes('remember('));
  state.settings.provider = 'anthropic';
});

test('add: one line appended (hand-written text kept), the result names the line, its number and the file\'s size, the panel follows', async () => {
  setInstructions('Use British English.\nTarget journal: Nature.');
  const s = snap();
  const r = await T.executeTool(call('r1', { action: 'add', text: '  Always write\n "per cent"  in full. ' }), 'manual', s, {});
  assert.strictEqual(r.content, 'Added line 3 of DOC.md (3 lines): Always write "per cent" in full.');
  assert.ok(r._ok); assert.strictEqual(r._message, 'Added to DOC.md: «Always write "per cent" in full.»');
  assert.strictEqual(r._icon, '📌');
  deq(r._remember, { scope: 'document', action: 'add', text: 'Always write "per cent" in full.', index: 2 });
  deq(r._edit, { id: 'r1', kind: 'remember', docId: 'DOC123', tabId: null, scope: 'document', action: 'add', text: 'Always write "per cent" in full.', index: 2,
    title: 'Added to DOC.md: «Always write "per cent" in full.»', undone: false }); // journaled for undo
  assert.strictEqual(s.responseWrite, undefined); // not a document edit
  assert.strictEqual(storage[KEY], 'Use British English.\nTarget journal: Nature.\nAlways write "per cent" in full.');
  assert.strictEqual(state.docInstructions, storage[KEY]);
  assert.strictEqual(s.docInstructions, 'Use British English.\nTarget journal: Nature.'); // this turn keeps its instructions
  assert.ok(!T.buildSystemParts('manual', 1000, s).head.includes('per cent'));
  assert.ok(T.buildSystemParts('manual', 1000, snap()).head.includes('Always write "per cent" in full.')); // the next message
  // the first rule of an empty document
  setInstructions('');
  const first = await run('r2', { action: 'add', text: 'Use Oxford commas.' });
  assert.strictEqual(first.content, 'Added line 1 of DOC.md (1 line): Use Oxford commas.');
  assert.strictEqual(storage[KEY], 'Use Oxford commas.');
});

test('every change by remember stores the save time next to the text (both scopes)', async () => {
  const realNow = env.run('Date.now');
  env.run('Date.now = () => 1777000000000');
  setInstructions('');
  delete storage['muninDocInstructionsAt:DOC123'];
  await run('t1', { action: 'add', text: 'Use Oxford commas.' });
  assert.strictEqual(storage['muninDocInstructionsAt:DOC123'], 1777000000000);
  env.run('Date.now = () => 1777000001000');
  await run('t2', { scope: 'main', action: 'add', text: 'Answer briefly.' });
  assert.strictEqual(storage.muninMainInstructionsAt, 1777000001000);
  await run('t3', { action: 'replace', old: 'Use Oxford commas.', text: 'No Oxford commas.' });
  assert.strictEqual(storage['muninDocInstructionsAt:DOC123'], 1777000001000);
  await run('t4', { scope: 'main', action: 'remove', text: 'Answer briefly.' });
  assert.ok(!('muninMainInstructions' in storage) && storage.muninMainInstructionsAt === 1777000001000);
  env.run('Date').now = realNow;
  setInstructions('');
});

test('add: duplicate, empty, invalid action, over the limit', async () => {
  setInstructions('Use British English.\nTarget journal: Nature.');
  let r = await run('d1', { action: 'add', text: ' Target journal: Nature. ' });
  assert.ok(r._ok && !r._remember);
  assert.strictEqual(r.content, 'Already in DOC.md as line 2 (2 lines); nothing changed.');
  assert.strictEqual(r._message, 'Already in DOC.md: «Target journal: Nature.»');
  r = await run('d2', { action: 'add', text: ' \n ' });
  assert.ok(!r._ok); assert.strictEqual(r.content, 'Error: the rule is empty.');
  r = await run('d3', { action: 'rename', text: 'x' });
  assert.ok(!r._ok); assert.strictEqual(r.content, 'Error: action must be "add", "remove" or "replace".');
  setInstructions('x'.repeat(7990));
  r = await run('d4', { action: 'add', text: 'A rule that does not fit.' });
  assert.ok(!r._ok);
  assert.strictEqual(r.content, 'Error: DOC.md would exceed the limit of 8,000 characters (now 7,990). Shorten the rule or remove one first.');
  assert.strictEqual(r._message, 'DOC.md is full (8,000 characters)');
  assert.strictEqual(storage[KEY].length, 7990); // unchanged
});

test('remove: the first exact line (case-sensitive); not found lists the closest lines; empty instructions', async () => {
  setInstructions('Use British English.\nKeep the term "lipid raft".\nTarget journal: Nature.\nUse British English.');
  let r = await run('m1', { action: 'remove', text: ' Use British English. ' });
  assert.ok(r._ok);
  assert.strictEqual(r.content, 'Removed line 1 of DOC.md (now 3 lines): Use British English.');
  assert.strictEqual(r._message, 'Removed from DOC.md: «Use British English.»');
  deq(r._remember, { scope: 'document', action: 'remove', text: 'Use British English.', index: 0 });
  r = await run('m2', { action: 'remove', text: 'use british english' });
  assert.ok(!r._ok);
  assert.strictEqual(r.content, 'Error: no line of DOC.md is exactly "use british english". Closest lines:\n' +
    'Use British English.\nKeep the term "lipid raft".\nTarget journal: Nature.\nCall remember again with the exact text of the line to remove.');
  assert.strictEqual(r._message, 'Not in DOC.md: «use british english»');
  setInstructions('Use British English.');
  r = await run('m3', { action: 'remove', text: 'Use British English.' });
  assert.strictEqual(r.content, 'Removed line 1 of DOC.md (now empty): Use British English.');
  assert.ok(!(KEY in storage)); assert.strictEqual(state.docInstructions, ''); // the key is removed, as by an empty Save
  r = await run('m4', { action: 'remove', text: 'Anything' });
  assert.strictEqual(r.content, 'Error: DOC.md is empty.');
});

test('no Revert: a change is undone by another remember or by Undo; a success is a row (no card), a failure its failed row', async () => {
  setInstructions('One.\nTwo.\nThree.');
  const r = await run('v1', { action: 'remove', text: 'Two.' });
  const tc = call('v1', { action: 'remove', text: 'Two.' });
  assert.ok(r._ok && !('reverted' in r._remember));
  assert.strictEqual(T.toolCardFor(tc, r).nodeType, 11); // an empty fragment: the row is the record
  const w = T.writeRowInfo(tc, r);
  deq({ message: w.message, text: w.text, detail: w.detail, label: w.label, diff: w.diff, editId: w.editId },
    { message: 'Removed from DOC.md: «Two.»', text: 'Two.', detail: 'DOC.md (scope document), action remove', label: 'Removed rule', diff: null, editId: 'v1' }); // its journal entry: Undo like any write's
  assert.strictEqual(w.undoText, 'Undo puts «Two.» back into DOC.md.');
  const back = await run('v2', { action: 'add', text: 'Two.' }); // the user asks for it back
  assert.ok(back._ok);
  assert.strictEqual(storage[KEY], 'One.\nThree.\nTwo.');
  // a failed call has no card: its failed log row (the result in its fold), without a button
  const bad = await run('v3', { action: 'remove', text: 'Nope.' });
  assert.strictEqual(T.writeRowInfo(call('v3', { action: 'remove', text: 'Nope.' }), bad), null);
  const card = T.toolCardFor(call('v3', { action: 'remove', text: 'Nope.' }), bad);
  assert.strictEqual(card.nodeType, 11);
  const e = T.logEntry(call('v3', { action: 'remove', text: 'Nope.' }), bad);
  deq([e.status, e.result], ['fail', bad.content]);
  setInstructions('');
});

test('action log: the file and the change, without an icon: DOC.md: add «text» / MAIN.md: remove «text»', () => {
  const entries = T.actionLogFromToolCalls([call('a1', { action: 'add', text: 'Use British English.' }), call('a2', { action: 'remove', scope: 'main', text: 'Old rule' })]);
  deq(entries.map((e) => e.summary), ['DOC.md: add «Use British English.»', 'MAIN.md: remove «Old rule»']);
});

test('a turn with a remember call: no card, no responseWrite, one journal entry; the next message carries the rule', async () => {
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
  assert.ok(r._ok && r._remember && r._edit && r._edit.kind === 'remember');
  assert.strictEqual(T.latestUndoable(messages), r); // the journal entry, id of the call
  assert.strictEqual(r._edit.id, 'toolu_rem');
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
  assert.ok(html.includes('remember') && html.includes('Adds a line to DOC.md. Earlier in this answer') && html.includes('<pre>Always cite DOIs.</pre>'), html);
  assert.strictEqual(r.content, T.EDIT_DENIED_TEXT); assert.strictEqual(r._decision, 'rejected'); assert.ok(!r._ok && !r._remember);
  assert.strictEqual(storage[KEY], 'Use British English.');
  ({ r, html } = await decide(T.executeTool(call('g2', { action: 'remove', text: 'Use British English.' }), 'manual', tainted(), {}), 'reject'));
  assert.ok(html.includes('Removes a line from DOC.md.'));
  assert.strictEqual(r.content, T.EDIT_DENIED_TEXT); assert.strictEqual(storage[KEY], 'Use British English.');
  // Allow: applied, with the instructions read again after the wait (a hand edit meanwhile is kept)
  const p = T.executeTool(call('g3', { action: 'add', text: 'Always cite DOIs.' }), 'edit', tainted(), {});
  await waitFor(() => T.pendingPreviews.size === 1, 'the gate card');
  storage[KEY] = 'Use British English.\nTarget journal: Nature.';
  ({ r } = await decide(p, 'accept'));
  assert.ok(r._ok && r._remember); assert.strictEqual(r._decision, 'accepted');
  assert.strictEqual(storage[KEY], 'Use British English.\nTarget journal: Nature.\nAlways cite DOIs.');
  // a clean turn: no card, in Manual too (remember is no document edit: it asks only in a tainted turn)
  r = await run('g4', { action: 'remove', text: 'Always cite DOIs.' });
  assert.ok(r._ok); assert.strictEqual(r._decision, undefined); assert.strictEqual(T.pendingPreviews.size, 0);
  r = await T.executeTool(call('g5', { action: 'add', text: 'Always cite DOIs.' }), 'edit', Object.assign(snap(), { askEdits: true }), {});
  assert.ok(r._ok, r.content); assert.strictEqual(r._decision, undefined); assert.strictEqual(T.pendingPreviews.size, 0);
  setInstructions('');
});
