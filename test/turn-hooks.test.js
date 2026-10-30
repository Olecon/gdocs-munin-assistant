'use strict';
// The beforeTurn and beforeWrite hook points of the registry: lines in the turn context (not the static head),
// a refuse before any card or Docs API write, notes appended to a successful result, best effort for a hook
// that throws; with Anthropic and Munin.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');
const { muTool, muText } = require('./lib/context');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, routeDocs, exec, fresh;
const warned = [];
const hooks = { turn: false, write: false, seen: [] };

before(async () => {
  env = await load();
  ({ T, state } = env);
  env.ctx.console = { ...console, warn: (...a) => warned.push(a.map(String).join(' ')) };
  ident = installIdentity(env);
  ({ routeDocs, exec, fresh } = docsBench(env, ident, ref));
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' }
    : msg.type === 'GET_DOC_TEXT' ? { ok: true, text: 'export', format: 'markdown', title: 'My Doc' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  // beforeTurn: a plain line, an async one, an empty answer and one that throws
  T.registerTurnHook('beforeTurn', (mode) => (hooks.turn ? `Hook line: ${mode}` : ''));
  T.registerTurnHook('beforeTurn', async () => (hooks.turn ? 'Async\nline' : null));
  T.registerTurnHook('beforeTurn', () => { if (hooks.turn) throw new Error('turn hook bug'); return ''; });
  // beforeWrite: records every call; refuses new_text "BLOCK"; notes on inserts; one that throws
  T.registerTurnHook('beforeWrite', (name, plan, args, snap) => {
    if (!hooks.write) return null;
    hooks.seen.push({ name, region: plan && plan.region, args, hasSnap: !!(snap && snap.prov) });
    if (args.new_text === 'BLOCK') return { refuse: 'blocked by the test.' };
    if (name === 'insert_after_line' || name === 'remember') return { notes: ['first note', '', 'second note'] };
    return null;
  });
  T.registerTurnHook('beforeWrite', () => { if (hooks.write) throw new Error('write hook bug'); return null; });
});

test('registerTurnHook knows the four events', () => {
  assert.throws(() => T.registerTurnHook('beforeEverything', () => null), /unknown event "beforeEverything"/);
});

// One chat turn on the fake Docs API document with provider prov; rounds: the SSE texts. Returns the request bodies.
async function turn(prov, rounds, text = 'Please edit') {
  fake = fakeDocsServer(docSpec());
  await T.createChat();
  ident.granted = true; state.googleConnected = true; state.applyMode = 'auto'; state.settings.provider = prov;
  Object.assign(state.settings.providers[prov], { apiKey: 'k-T' });
  const bodies = [];
  env.ctx.fetch = routeDocs(async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); });
  T.el.input.value = text;
  await T.sendMessage();
  await new Promise((r) => setTimeout(r, 20));
  return bodies;
}

test('beforeTurn: the lines go into the turn context before the selection line, never into the static head; a throwing hook is skipped and logged', async () => {
  hooks.turn = true; warned.length = 0;
  for (const prov of ['anthropic', 'munin']) {
    const bodies = await turn(prov, [prov === 'munin' ? muText('OK.') : textRound('OK.')]);
    const ctx = state.messages[0]._context;
    assert.ok(ctx.includes('\nHook line: edit\nAsync line\nCurrent selection in the document:'), ctx);
    const sent = JSON.stringify(bodies[0]);
    assert.ok(sent.includes('Hook line: edit'), prov);
    const system = prov === 'munin' ? bodies[0].messages.filter((m) => m.role === 'system').map((m) => m.content).join('') : JSON.stringify(bodies[0].system);
    assert.ok(system.length > 1000 && !system.includes('Hook line'), `${prov}: not in the system prompt`);
  }
  assert.ok(warned.some((w) => w.includes('a beforeTurn hook failed; skipped') && w.includes('turn hook bug')), warned.join('\n'));
  hooks.turn = false;
  await turn('anthropic', [textRound('OK.')]);
  assert.ok(!state.messages[0]._context.includes('Hook line'));
});

test('beforeWrite: a refuse ends the call before the gate and the Docs API; notes follow a successful result (Anthropic)', async () => {
  hooks.write = true; hooks.seen = []; warned.length = 0;
  const bodies = await turn('anthropic', [
    msgStart + tu(0, 'toolu_b', 'replace_text', { old_text: 'beta gamma', new_text: 'BLOCK' }) + stopTool,
    msgStart + tu(0, 'toolu_i', 'insert_after_line', { line: 4, text: 'A new line.' }) + stopTool,
    textRound('Done.'),
  ]);
  hooks.write = false;
  assert.strictEqual(bodies.length, 3);
  const refused = bodies[1].messages[2].content[0];
  deq([refused.tool_use_id, refused.content, refused.is_error], ['toolu_b', 'Refused by a check: blocked by the test.', true]);
  const inserted = bodies[2].messages[4].content[0];
  assert.ok(inserted.content.startsWith('Done: inserted'), inserted.content);
  assert.ok(inserted.content.endsWith('\nNote: first note\nNote: second note'), inserted.content);
  assert.strictEqual(fake.log.filter((x) => x.method === 'POST').length, 1); // only the insert was written
  assert.ok(fake.text('t.0').includes('A new line.') && fake.text('t.0').includes('beta gamma'));
  // the hook saw the tool, the plan, the parsed arguments and the snapshot
  deq(hooks.seen.map((s) => [s.name, s.args, s.hasSnap]), [
    ['replace_text', { old_text: 'beta gamma', new_text: 'BLOCK' }, true],
    ['insert_after_line', { line: 4, text: 'A new line.' }, true],
  ]);
  assert.ok(Array.isArray(hooks.seen[0].region));
  const tool = state.messages.find((m) => m.role === 'tool');
  deq([tool._ok, tool._message, tool._decision], [false, 'Refused by a check', undefined]);
  assert.ok(warned.some((w) => w.includes('a beforeWrite hook failed; skipped')), warned.join('\n'));
});

test('beforeWrite with Munin: the same refusal and notes', async () => {
  hooks.write = true; hooks.seen = [];
  const bodies = await turn('munin', [
    muTool('c1', 'replace_text', { old_text: 'beta gamma', new_text: 'BLOCK' }),
    muTool('c2', 'insert_after_line', { line: 4, text: 'A new line.' }),
    muText('Done.'),
  ]);
  hooks.write = false;
  const tools = bodies[2].messages.filter((m) => m.role === 'tool');
  assert.strictEqual(tools[0].content, 'Refused by a check: blocked by the test.');
  assert.ok(tools[1].content.endsWith('\nNote: first note\nNote: second note'), tools[1].content);
});

test('beforeWrite: remember goes through it too; a failed write gets no notes', async () => {
  await fresh();
  hooks.write = true; hooks.seen = [];
  const r = await T.executeTool({ id: 'm1', function: { name: 'remember', arguments: JSON.stringify({ action: 'add', text: 'Use British English.' }) } }, 'edit', as, {});
  assert.ok(r._ok && r.content.endsWith('\nNote: first note\nNote: second note'), r.content);
  deq(hooks.seen.map((s) => s.name), ['remember']);
  // insert_after_line beyond the document: an error before the gate, so no hook and no notes
  const bad = await exec('insert_after_line', { line: 99, text: 'x' });
  assert.ok(!bad._ok && !bad.content.includes('Note:'), bad.content);
  hooks.write = false;
});

test('the notes are not appended after a paste (it cannot be redone in this turn) or a failure', () => {
  const ui = { notes: ['a', 'b'] };
  const paste = { content: '{"ok":true}', _ok: true };
  T.appendCheckNotes(paste, 'replace_selection', ui);
  assert.strictEqual(paste.content, '{"ok":true}');
  const api = { content: 'Done.', _ok: true, _edit: {} };
  T.appendCheckNotes(api, 'replace_selection', ui);
  assert.strictEqual(api.content, 'Done.\nNote: a\nNote: b');
  const failed = { content: 'Error: x', _ok: false };
  T.appendCheckNotes(failed, 'replace_text', ui);
  assert.strictEqual(failed.content, 'Error: x');
});
