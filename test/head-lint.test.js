'use strict';
// Head lint: the heads of every mode and provider (Auto on the Docs API and on the export path, Manual, Plan, the
// personas) never carry a curated pair of contradicting instructions, and no sentence of 8 or more words is said both
// in a head and in a tool description offered with it (the head says when, the definition how; architecture.md: each
// rule is said once). DUPLICATES_ALLOWED lists the deliberate repeats.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load } = require('./lib/sandbox');
const { fakeDocsServer, docSpec } = require('./lib/fake-docs');

let T, state;
before(async () => { ({ T, state } = await load()); });

// [a, b]: a head that says a must not say b.
const CONTRADICTIONS = [
  ['simplify it', 'not a simpler sentence'],
  ['rewrite it with replace_text', 'revise_section'],
];
// Sentences (lower case, normalized) that the head and a definition both say on purpose. The paste rule: the
// paste cannot be verified in the same message, so both the export rules and replace_selection say it
// (test/prompts-safety.test.js pins both).
const DUPLICATES_ALLOWED = [
  /paste cannot be verified/,
];

function snaps() {
  const spec = docSpec();
  const model = T.buildLineModel(fakeDocsServer(spec).render(true), 't.0', spec.documentId);
  const out = [];
  for (const prov of ['munin', 'openai', 'anthropic']) {
    state.settings.provider = prov;
    const base = { ...T.takeSnapshot(), docTitle: spec.title, lines: null, selection: '', docId: spec.documentId, googleConnected: true,
      chatCtx: { docId: spec.documentId, chatId: 'c1', messages: [{ role: 'user', content: 'Rename the chat and add references.' }] } };
    out.push([`${prov}/api`, { ...base, docText: model.text, docFormat: 'docs-api', model }]);
    out.push([`${prov}/export`, { ...base, docText: '# Doc\n\nText.', docFormat: 'markdown', model: null }]);
  }
  return out;
}
const MODES = ['edit', 'manual', 'plan', 'research', 'chat'];
const norm = (s) => s.toLowerCase().replace(/[“”"«»]/g, '"').replace(/\s+/g, ' ').trim();
const sentences = (text) => String(text).split(/(?<=[.!?;:])\s+|\n+/).map(norm).filter((s) => s.split(' ').length >= 8);
// Every run of 8 words (punctuation dropped) of a text: a repeated clause is caught even inside a longer sentence.
const shingles = (text) => {
  const w = norm(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 8 <= w.length; i++) out.add(w.slice(i, i + 8).join(' '));
  return out;
};

test('no head carries a contradicting pair', () => {
  for (const [name, snap] of snaps()) {
    for (const mode of MODES) {
      const head = T.buildSystemParts(mode, 1e5, snap).head;
      for (const [a, b] of CONTRADICTIONS) assert.ok(!(head.includes(a) && head.includes(b)), `${name} ${mode}: "${a}" with "${b}"`);
    }
  }
});

test('no run of 8+ words is said both in the head and in an offered tool description (allow-list aside)', () => {
  const found = [];
  for (const [, snap] of snaps()) {
    for (const mode of MODES) {
      const head = shingles(T.buildSystemParts(mode, 1e5, snap).head);
      for (const t of T.toolsFor(mode, snap)) {
        for (const s of shingles(t.function.description)) {
          if (head.has(s) && !DUPLICATES_ALLOWED.some((re) => re.test(s))) found.push(`${t.function.name}: ${s}`);
        }
      }
    }
  }
  assert.deepStrictEqual([...new Set(found)], []);
});

test('the lint catches a duplicate and a contradiction (self-check)', () => {
  const head = new Set(sentences('Rule one. Read the lines before editing them and keep every number as it is.'));
  assert.ok(sentences('Read the lines before editing them and keep every number as it is.').some((s) => head.has(s)));
  assert.ok(sentences('Short one here.').length === 0);
  const h = shingles('Always: read the lines before editing them, and keep every number.');
  assert.ok([...shingles('Note that you read the lines before editing them, and keep it.')].some((x) => h.has(x)));
});
