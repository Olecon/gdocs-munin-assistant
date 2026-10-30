'use strict';
// Prompt budget: the static system prompt and the tool definitions of an Edit automatically turn with the Docs API, of a
// Manual turn and of a Plan turn (Munin, the 64k provider without a prompt cache) stay under a ceiling of about the current size
// plus 10%, so that growth of the static head shows up in the test run. Raise a ceiling deliberately, with the
// new numbers from the failure message.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, installDocTab, installIdentity } = require('./lib/sandbox');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');

// Ceilings in estimated tokens (estimateTokens: characters / CHARS_PER_TOKEN).
const BUDGET = {
  edit: { system: 3760, tools: 6120 }, // measured 3,586 and 5,830 (with draft and the provenance line)
  manual: { system: 2770, tools: 2490 }, // measured 2,520 and 2,262
  plan: { system: 1150, tools: 2280 }, // measured 1,044 and 2,070 (no writing rules, no remember)
};

let T, state, model;

before(async () => {
  const env = await load();
  ({ T, state } = env);
  const ident = installIdentity(env);
  let fake; let as;
  const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
  const { routeDocs } = docsBench(env, ident, ref);
  Object.assign(env.storage, { muninProvider: 'munin', muninApiKey: 'k-munin' });
  await T.loadSettings();
  installDocTab(env);
  await T.refreshContext({ force: true });
  fake = fakeDocsServer(docSpec()); // headings, a table, an image: every Docs API feature tool is offered
  env.ctx.fetch = routeDocs();
  ident.granted = true; state.googleConnected = true;
  model = await T.fetchDocModel('DOC123', null);
});

// The system text and the tools of a Munin turn on the Docs API document.
function sizes(mode) {
  state.settings.provider = 'munin';
  Object.assign(state, { docId: 'DOC123', docTitle: 'My Doc', docError: '', selection: '', docModel: model, docText: model.text, docFormat: 'docs-api' });
  const snap = T.takeSnapshot(); T.snapshotDocument(snap);
  const system = T.joinSystem(T.buildSystemParts(mode, 4000, snap));
  const tools = JSON.stringify(T.toolsFor(mode, snap));
  return {
    systemChars: system.length, system: T.estimateTokens([{ content: system }]),
    toolsChars: tools.length, tools: T.estimateTokens([], tools.length),
  };
}

for (const mode of ['edit', 'manual', 'plan']) {
  test(`prompt budget: ${{ edit: 'Edit automatically', manual: 'Manual', plan: 'Plan' }[mode]} with the Docs API stays under its ceiling`, () => {
    const s = sizes(mode);
    const b = BUDGET[mode];
    const msg = `${mode}: system ${s.system} tokens (${s.systemChars} characters, ceiling ${b.system}); ` +
      `tools ${s.tools} tokens (${s.toolsChars} characters, ceiling ${b.tools})`;
    assert.ok(s.system <= b.system && s.tools <= b.tools, msg);
    // a floor too: a prompt that suddenly lost half its text is a bug as well
    assert.ok(s.system > b.system / 2 && s.tools > b.tools / 2, msg);
  });
}
