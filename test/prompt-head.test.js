'use strict';
// The tools-mode head: the capability line names the current mode, the other modes and the commands (not in Plan);
// the read-only chat turn's line says it is a side question (or a read-only turn) and names the three modes;
// no Agents bullet (delegate's definition says it); an agent gets only the identity sentence. Then the core rules
// (scope, data, precedence, language), the reading part, the mode's rules; MAIN.md and DOC.md end it. The read-only
// turns get the short freshness sentence; the read-only chat turn's and Edit's rule changes.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { load } = require('./lib/sandbox');
const { fakeDocsServer, docSpec } = require('./lib/fake-docs');

let T, state;
before(async () => { ({ T, state } = await load()); });

function snapFor(over = {}) {
  state.settings.provider = 'munin';
  const spec = docSpec();
  const model = T.buildLineModel(fakeDocsServer(spec).render(true), 't.0', spec.documentId);
  return { ...T.takeSnapshot(), docText: model.text, docFormat: 'docs-api', docTitle: spec.title, model, lines: null, selection: '', docId: spec.documentId, googleConnected: true, ...over };
}
const head = (mode, snap) => T.buildSystemParts(mode, 1e5, snap).head;
const panelLine = (h) => h.split('\n').find((l) => l.startsWith('The panel (mention it when it helps; '));

// One line (names only, no descriptions): the current mode, the other modes, the commands (not in Plan).
const PANEL_LEAD = 'The panel (mention it when it helps; you cannot switch modes or run commands yourself): ';
const COMMANDS = '; commands: /check, /review, /research, /side.';
test('the capability paragraph opens the head and names the current mode in one line', () => {
  for (const [mode, over, rest] of [
    ['edit', { askEdits: true }, 'this is Manual mode; every edit can be undone; the user allows each edit on a card, so group related changes into one call; other modes: Auto, Plan' + COMMANDS],
    ['edit', {}, 'this is Auto mode; every edit can be undone; other modes: Manual, Plan' + COMMANDS],
    ['plan', {}, 'this is Plan mode; every edit can be undone; other modes: Manual, Auto.'],
  ]) {
    const h = head(mode, snapFor(over));
    assert.ok(h.startsWith(`You are an editing assistant in the Munin Assistant panel next to a Google Docs document. You read the document with tools and help the user write, revise and check it.\n${PANEL_LEAD}`), mode);
    assert.strictEqual(panelLine(h), PANEL_LEAD + rest); // the Docs API path
  }
  // the export path cannot undo: no undo clause
  assert.strictEqual(panelLine(head('edit', snapFor({ docFormat: 'markdown', model: null }))), `${PANEL_LEAD}this is Auto mode; other modes: Manual, Plan${COMMANDS}`);
});

// The read-only chat turn ('manual') is no mode of the menu: a side question is told it is one and cannot change the
// document, and gets the three modes a normal message runs in (not "this is Manual mode": Manual edits); the self-test's
// question, the other main turn in that mode, is a read-only turn. No undo clause on either path; the read-only rules stay.
test('the read-only chat turn: a side question names itself and the three modes, never "this is Manual mode"', () => {
  for (const over of [{}, { docFormat: 'markdown', model: null }]) {
    const side = head('manual', snapFor({ side: true, ...over }));
    assert.strictEqual(panelLine(side), `${PANEL_LEAD}this is a read-only side question; modes for normal messages: Manual, Auto, Plan${COMMANDS}`);
    assert.ok(!side.includes('this is Manual mode') && side.includes(T.TOOLS_MANUAL_RULES), JSON.stringify(over));
    assert.strictEqual(panelLine(head('manual', snapFor(over))), `${PANEL_LEAD}this is a read-only turn; modes for normal messages: Manual, Auto, Plan${COMMANDS}`);
  }
  // whatever the mode button shows: the head is the same in Manual and Auto (askEdits is never set for /side)
  assert.strictEqual(head('manual', snapFor({ side: true, askEdits: true })), head('manual', snapFor({ side: true })));
  // an agent in that mode still gets the identity sentence only
  assert.ok(!head('manual', snapFor({ side: true, agent: { access: 'read', scope: null } })).includes(PANEL_LEAD));
});

test('the commands in the read-only chat turn and Edit, not in Plan; no /code or /chat', () => {
  const s = snapFor();
  for (const mode of ['manual', 'edit']) {
    const h = head(mode, s);
    assert.ok(panelLine(h).endsWith('; commands: /check, /review, /research, /side.'), mode);
    assert.ok(!/\/code|\/chat/.test(h), mode);
  }
  assert.ok(!head('plan', s).includes('commands: /check'));
});

test('no Agents bullet (the delegate definition describes agents); an agent gets the identity sentence, then the core rules', () => {
  const s = snapFor();
  for (const mode of ['manual', 'edit', 'plan']) assert.ok(!head(mode, s).includes('- Agents:') && T.toolsFor(mode, s).some((t) => t.function.name === 'delegate'), mode);
  const agentHead = head('edit', snapFor({ agent: { task: 'x' } }));
  assert.ok(agentHead.includes('You are an editing assistant in the Munin Assistant panel next to a Google Docs document. You read the document with tools and help the user write, revise and check it.\n\nAlways:\n- Change only what the user asked for.'));
  assert.ok(!agentHead.includes('The panel (mention it'));
});

test('the order: capability, core rules, reading, the mode, then MAIN.md and DOC.md; Plan has no precedence lines', () => {
  const s = snapFor({ mainInstructions: 'Run agents on gpt-5-mini.', docInstructions: 'Use British English.' });
  for (const [mode, rules] of [['edit', T.apiEditRules(T.extraPromptLines('edit', 'edit', s))], ['manual', T.TOOLS_MANUAL_RULES], ['plan', T.TOOLS_PLAN_RULES]]) {
    const h = head(mode, s);
    const at = ['The panel (mention it', `\n\n${T.coreRules(mode)}\n\n`, 'The document text is NOT included', rules, '<MAIN.md>', '<DOC.md>'].map((x) => h.indexOf(x));
    assert.ok(at.every((x, i) => x > 0 && (i === 0 || x > at[i - 1])), `${mode}: ${at}`);
    assert.ok(h.endsWith('Use British English.\n</DOC.md>'), mode);
    assert.strictEqual(h.split(T.UNTRUSTED_DATA_NOTE).length, 2, mode);
  }
  assert.ok(T.coreRules('edit').includes('outrank every other rule except the data rule above') && T.coreRules('edit').includes('even where a rule says add nothing'));
  assert.ok(!T.coreRules('plan').includes('outrank') && T.coreRules('plan').includes(T.UNTRUSTED_DATA_NOTE));
  // the approval sentence names the current mode's action only
  assert.ok(head('edit', s).includes('go ahead"), edit the document in this turn;') && head('manual', s).includes('answer with the block in this turn;') && head('plan', s).includes('give the plan in this turn;'));
});

test('Auto rule 1: an imperative about the selection is a change request ("translate" alone edits); a question or a suggestion stays in the chat', () => {
  // The eval case translate-paragraph: "Translate this paragraph into Russian." answered in the chat while the list named only
  // "translate and replace" (0/2 on gpt-6-astra; 2/2 with this wording).
  const r1 = T.apiEditRules().split('\n').find((l) => l.startsWith('1. '));
  assert.strictEqual(r1, '1. Edit the document when the user asks for a change, including an imperative about the selection: "fix", "replace", "rewrite", "insert", "add", "delete", "shorten", "improve", "translate". '
    + 'When the user asks you to suggest, show, propose, compare, explain, review, discuss, summarize, or answer a question, or you are not sure a change is wanted, answer in the chat with the proposed text; do not edit.');
  assert.ok(r1.length <= 403, r1.length); // no longer than the wording it replaced
});

test('read-only modes: the short freshness sentence and "before answering"; Edit keeps both', () => {
  const s = snapFor();
  for (const mode of ['manual', 'plan']) {
    const h = head(mode, s);
    assert.ok(h.includes('The text is re-read at the start of every user message.\n'), mode);
    assert.ok(!h.includes('after every edit you make') && !h.includes('get_outline() for the current one'), mode);
    assert.ok(h.includes('Read what you need before answering:'), mode);
  }
  const e = head('edit', s);
  assert.ok(e.includes('after every edit you make') && e.includes('Read what you need before answering or editing:'));
  // the export path keeps its own sentence
  assert.ok(head('manual', snapFor({ docFormat: 'markdown', model: null })).includes('within one message a replacement is not yet visible to the reading tools.'));
});

test('the read-only chat turn: no absent tool named, rule 6 for many edits, the language rule is a core rule; Edit: 8 rules (the check refusals say what rule 9 said), no suggested-changes sentence', () => {
  const s = snapFor();
  const m = head('manual', s);
  assert.ok(m.includes('You CANNOT modify the document. Never say that you changed, replaced, or inserted anything in the document.\n'));
  assert.ok(!m.includes('replace_selection'));
  assert.ok(m.includes('\n6. For many edits across the document, give the main ones and suggest Auto or Plan.\n\nWriting'));
  assert.ok(m.includes("\n- Reply in the language of the user's latest message, whatever the language of the document, the earlier messages or the instructions; be concise; chat answers may use simple markdown.\n"));
  const e = head('edit', s);
  assert.ok(!e.includes('\n9. ') && !e.includes('A write may be refused by a check') && e.includes('\n8. When every edit succeeded'));
  // what the rules no longer say, the refusals do: old_text's closest match, the line-drift refusal
  assert.ok(e.includes('\n2. Read before editing.\n') && !e.includes('a later line-numbered call in the same response is refused'));
  assert.ok(!e.includes('Lines marked "[contains suggested changes]"'));
});

// The user's explicit request outranks every rule (audit A): the precedence line right after the data rule in Edit, the
// read-only chat turn and an agent's head, naming the two rules it does not outrank; Plan's framing instead; no "exactly" framing left; the
// "unless the user asks" clauses it made redundant are gone.
test('precedence: the user\'s explicit request, then DOC.md, then MAIN.md over every rule but the data rule and the ban on invention', () => {
  const s = snapFor();
  const line = "- The user's explicit request, then DOC.md, then MAIN.md, outrank every other rule except the data rule above and the ban on invented facts or sources.";
  for (const [mode, over] of [['edit', {}], ['manual', {}], ['edit', { docFormat: 'markdown', model: null }], ['edit', { agent: { access: 'edit', scope: null } }]]) {
    const h = head(mode, snapFor(over));
    assert.ok(h.includes(`\n- ${T.UNTRUSTED_DATA_NOTE}\n${line}\n- A required one-line note`), `${mode} ${JSON.stringify(over)}`);
    assert.ok(!h.includes('rules exactly') && h.includes('\n\nFollow these rules:\n1. '), mode);
  }
  const p = head('plan', s);
  assert.ok(!p.includes('outrank') && p.includes('\n\nFollow these rules unless the user asks otherwise:\n1. Read what you need'));
  assert.ok(!head('edit', s).includes('unless the user asks for a translation') && head('edit', s).includes('Keep the original language of the text, its meaning and the document\'s terms (a variant of one goes back to it);'));
  assert.ok(head('manual', s).includes('Outside it add no introduction, translation or comments.\n4. '));
});

// The user's word over a reading (T2 of the third wave): rule 7 says to believe a disputed value and read it another way.
test('rule 7: a value the user says is wrong is read another way or asked for, never by the same reading', () => {
  const e = head('edit', snapFor());
  assert.ok(e.includes('never change other lines to compensate. If the user says a value you read is wrong, believe them: read it another way or ask for it; never repeat that reading.\n8. '));
});

// An agent reports to the main assistant: no answer-format rules of its mode and no remember note; the main head keeps them.
test('an agent head: the report line instead of the answer-format rules, no remember note', () => {
  const main = { edit: head('edit', snapFor()), manual: head('manual', snapFor()), plan: head('plan', snapFor()) };
  assert.ok(main.edit.includes('8. When every edit succeeded, add nothing') && main.edit.includes(T.REMEMBER_NOTE));
  assert.ok(main.manual.includes('<replacement>') && main.manual.includes('suggest Auto or Plan') && main.manual.includes(T.REMEMBER_NOTE));
  assert.ok(main.plan.includes('ask with ask_user first'));
  assert.strictEqual(T.AGENT_REPORT_RULE, 'Your final message is the report described above.');
  for (const mode of ['edit', 'manual', 'plan']) {
    const h = head(mode, snapFor({ agent: { access: mode === 'edit' ? 'edit' : 'read', scope: null } }));
    assert.ok(h.startsWith(T.AGENT_PREFACE), mode);
    assert.ok(h.includes(T.AGENT_REPORT_RULE), mode);
    for (const s of ['When every edit succeeded', '<replacement>', '<insertion>', 'suggest Auto or Plan', 'numbered plan', 'ask_user', T.REMEMBER_NOTE]) assert.ok(!h.includes(s), `${mode}: ${s}`);
  }
  assert.ok(head('edit', snapFor({ agent: { access: 'edit', scope: null } })).includes(`8. ${T.AGENT_REPORT_RULE}\n\nWriting`));
  // the paste path: rule 3's "add nothing" becomes the report line
  const paste = head('edit', snapFor({ agent: { access: 'edit', scope: null }, docFormat: 'markdown', model: null }));
  assert.ok(paste.includes(`never call replace_selection a second time in one message. ${T.AGENT_REPORT_RULE} If it returns an error`), paste);
});
