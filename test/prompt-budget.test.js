'use strict';
// Prompt budget: the static system prompt and the tool definitions of an Auto turn with the Docs API, of a
// read-only chat turn and of a Plan turn (Munin, the 64k provider without a prompt cache) stay under a ceiling of about the current size
// plus 10%, so that growth of the static head shows up in the test run. Raise a ceiling deliberately, with the
// new numbers from the failure message.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load, installDocTab, installIdentity } = require('./lib/sandbox');
const { fakeDocsServer, docSpec, docsBench } = require('./lib/fake-docs');

// Ceilings in estimated tokens (estimateTokens: characters / CHARS_PER_TOKEN).
const BUDGET = {
  // read_document for four reading tools, edit_document for the five batch fields, short descriptions: Auto's tools
  // went from 8,330 to 5,890 (-29%).
  // The head audit (core rules once, no tool mechanics or prompt lines that repeat a definition): Auto's system text
  // went from 4,271 to 3,398 (-20%), the read-only chat turn's from 2,882 to 2,508 (-13%), Plan's from 1,264 to 1,013 (-20%).
  // The formatting sheet (src/style-sheet.js: its Edit-rules line, format_lines apply_sheet) added 50 and 51 tokens to
  // Auto (3,402 -> 3,452 and 6,161 -> 6,212); the ceilings grew by that plus 10%.
  // The numbers entry of the sheet (its sentence in the Edit-rules line and in format_lines) added 32 and 14 tokens.
  // The sheet's alignment and spacing (a grammar example in the Edit-rules line, "align, space" in apply_sheet) added 23
  // and 9 tokens; the ceilings grew by 26 and 10.
  // The ask_user questionnaire (the questions schema, the head's ask rule) added about 59 and 61 tokens to every set;
  // the ceilings grew by that plus 10%.
  // document_styles (src/named-styles.js: read and apply of the named styles, offered with the Docs API in every mode)
  // added 140 tokens to every set; the ceilings grew by that plus 10% (154).
  // style_map (src/style-map.js: where each value of a style parameter occurs, offered with the Docs API in every mode)
  // added 267 tokens to every set; the ceilings grew by that plus 10% (294).
  // The search tool (src/munin-search.js, offered with a keyed Munin account) added about 110 tokens to every set.
  // The lean pass: the tools are measured as Munin receives them (compact schemas, tools.js compactSchema), models only
  // with two usable models, a shorter delegate, the head deduplicated against the definitions (a one-line capability
  // paragraph, rules 2 and 5, the ask rule, the remember note, the draft procedure moved into its definition, the [[?]]
  // rule once in W13): Auto 3,566 -> 3,045 and 6,702 -> 5,491; read-only 2,571 -> 2,357 and 2,970 -> 2,439; Plan 1,075 -> 987
  // and 2,722 -> 2,161. The ceilings came down to the new numbers plus 10%.
  // line and all (replace_text, format_text and their edit_document operations: pick one occurrence, format every one)
  // added 95 tokens to Auto's tools (6,018 -> 6,113); the operations of edit_document as one object per op (strict), merged
  // into one loose object for Munin with the descriptions of line and style naming their op, 40 more (6,153); the ceiling
  // grew by both plus 10%.
  // fill on insert_after_line and the insert operation (write into an empty line; its clause in the description) added
  // 41 tokens to Auto's tools (6,153 -> 6,194); the ceiling grew by that plus 10% (45).
  // The token wave: on Munin table, page_parts, models, style_map and document_styles are offered on demand (this
  // document has a table, the request no message: table only), shorter descriptions, rule 9 and the stub, comments and
  // message-structure sentences gone from the head, the remember note folded into remember's definition, the writing
  // rules merged to W1..W15, read-only page_parts, document_styles and delegate in the read-only turn and Plan: Auto 3,045 -> 2,739
  // and 5,491 -> 5,349; read-only 2,357 -> 2,089 and 2,439 -> 1,849; Plan 987 -> 888 and 2,161 -> 1,422. The ceilings came
  // down to the new numbers plus 10%.
  // The precedence wave: the user's explicit request over every rule (+23), " exactly" dropped (-3), the clauses it made
  // redundant deleted (the scope rule's translation one -14; the read-only rules' explanation one -13), Plan's framing (+8) and rule 7's
  // disputed reading (+40): Auto 2,772 -> 2,818, read-only 2,133 -> 2,126, Plan 909 -> 903; the ceilings stay.
  edit: { system: 3015, tools: 5885 }, // measured 2,818 and 5,422
  manual: { system: 2300, tools: 2035 }, // measured 2,126 and 1,854 (with search)
  plan: { system: 980, tools: 1565 }, // measured 903 and 1,422 (with search)
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
  const tools = JSON.stringify(T.sentTools(T.toolsFor(mode, snap), snap.prov)); // as Munin receives them (compact schemas)
  return {
    systemChars: system.length, system: T.estimateTokens([{ content: system }]),
    toolsChars: tools.length, tools: T.estimateTokens([], tools.length),
  };
}

for (const mode of ['edit', 'manual', 'plan']) {
  test(`prompt budget: ${{ edit: 'Auto', manual: 'the read-only chat turn', plan: 'Plan' }[mode]} with the Docs API stays under its ceiling`, (t) => {
    const s = sizes(mode);
    t.diagnostic(`${mode}: system ${s.system} tokens, tools ${s.tools} tokens`);
    const b = BUDGET[mode];
    const msg = `${mode}: system ${s.system} tokens (${s.systemChars} characters, ceiling ${b.system}); ` +
      `tools ${s.tools} tokens (${s.toolsChars} characters, ceiling ${b.tools})`;
    assert.ok(s.system <= b.system && s.tools <= b.tools, msg);
    // a floor too: a prompt that suddenly lost half its text is a bug as well
    assert.ok(s.system > b.system / 2 && s.tools > b.tools / 2, msg);
  });
}

// The measured lines of the turn context (src/doc-conventions.js, styleLine): each stays under its ceiling on a long
// document that has every convention, a term with a variant and several abbreviations.
const MEASURED_CEILINGS = { style: 42, conventions: 47, terms: 62 }; // tokens; measured 37, 43 and 60 (terms: its 200-character cap)
test('prompt budget: the style, conventions and terms lines stay under their ceilings', (t) => {
  const para = 'The spin labels were attached at sites 45, 78, and 120 as described in [12], and the spin-label rotamers were modelled ' +
    'with molecular dynamics (MD) at 25 °C in 50 mM phosphate (Fig. 2). Double electron–electron resonance (DEER) gave distances of 2–6 nm ' +
    'with 10% error (Table 1) [13]. Root mean square deviation (RMSD) values and the electron paramagnetic resonance (EPR) spectra ' +
    'of the spin labels may suggest a mobile loop whose behaviour was analysed in [14].\n';
  const text = para.repeat(6);
  const snap = { docText: text };
  const lines = { style: T.styleLine(snap), conventions: T.conventionsLine(snap), terms: T.glossaryLine(snap) };
  for (const [k, line] of Object.entries(lines)) {
    const n = T.estimateTokens([{ content: line }]);
    t.diagnostic(`${k}: ${n} tokens: ${line}`);
    assert.ok(line && n <= MEASURED_CEILINGS[k], `${k}: ${n} tokens (ceiling ${MEASURED_CEILINGS[k]}): ${line}`);
  }
});
