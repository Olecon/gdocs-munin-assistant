'use strict';
// revise_section (src/revise.js): the definition, offer and prompt line, the section-type detection, the loop the panel
// drives (one quiet request per paragraph without chat history: the writing rules, the section prompt, the title,
// keywords, goal and paragraph), changed paragraphs written as verified edits and unchanged ones left alone, a paragraph
// refused by the writing check skipped with a note, the transitions pass, Stop between paragraphs, the journal entry
// (one 'multi' entry: Undo restores the section) and Undo all over a whole answer.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity, waitFor } = require('./lib/sandbox');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, routeDocs, fresh;

const P1 = 'We grew the cells in a standard medium for two days.';
const P2 = 'We then stained them with Laurdan at 5 µM for thirty minutes.';
const P3 = 'Images were taken on a confocal microscope and analysed in Fiji.';
const R1 = 'We grew the cells in standard medium for two days.';
const R3 = 'We imaged them on a confocal microscope and analysed the images in Fiji.';
const T3 = 'After staining, we imaged them on a confocal microscope and analysed the images in Fiji.';
const ITEMS = [
  { p: 'Membrane order', style: 'TITLE' },
  { p: 'Keywords: lipid, order' },
  { p: 'Methods', style: 'HEADING_1' },
  { p: P1 }, { p: P2 }, { p: P3 },
  { p: 'Results', style: 'HEADING_1' },
  { p: 'Order rose in all the cells we measured.' },
];
const ORIGINAL = ['Membrane order', 'Keywords: lipid, order', 'Methods', P1, P2, P3, 'Results', 'Order rose in all the cells we measured.'].join('\n');
const call = (args, id = 'rv' + Math.random().toString(36).slice(2, 6)) => ({ id, function: { name: 'revise_section', arguments: JSON.stringify({ goal: null, ...args }) } });
const pairs = (list) => '```json\n' + JSON.stringify(list) + '\n```';

before(async () => {
  env = await load();
  ({ T, state } = env);
  ident = installIdentity(env);
  ({ routeDocs, fresh } = docsBench(env, ident, ref));
  installDocTab(env);
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true, title: 'My Doc' });
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true; state.applyMode = 'auto';
  Object.assign(state.settings.providers.anthropic, { apiKey: 'k-T' });
  Object.assign(state.settings.providers.munin, { apiKey: 'k-T' });
});

// The fake document; the provider answers the revise requests with answers[i] (Anthropic text rounds). onPost: called on
// every Docs batchUpdate. Returns the provider request bodies.
async function bench(answers, onPost) {
  await fresh(docSpec({ items: ITEMS }));
  as.chatCtx = { docId: 'DOC123', chatId: state.chatId, messages: [] };
  const bodies = [];
  env.ctx.fetch = async (url, init) => {
    if (String(url).startsWith('https://docs.googleapis.com/') && init && init.method === 'POST' && onPost) onPost();
    return (await fake.fetch(url, init)) || (bodies.push(JSON.parse(init.body)), sseResponse(textRound(answers[bodies.length - 1])));
  };
  return bodies;
}

test('definition, offer (Auto with the Docs API, Munin included) and the prompt line', async () => {
  await fresh();
  const names = (mode, snap) => T.toolsFor(mode, snap).map((t) => t.function.name);
  const def = T.toolsFor('edit', as).find((t) => t.function.name === 'revise_section');
  assert.ok(def);
  deq([def.function.parameters.required, def.function.parameters.additionalProperties], [['heading', 'goal'], false]);
  const line = '\n- revise_section(heading, goal): a whole section, paragraph by paragraph, then its transitions (one request per paragraph, 1–2k tokens each); for a few sentences use replace_text.\n';
  assert.ok(T.buildSystemParts('edit', 1e5, as).head.includes(line));
  assert.ok(!names('manual', as).includes('revise_section'));
  assert.ok(!T.buildSystemParts('manual', 1e5, as).head.includes('revise_section'));
  assert.ok(!names('edit', { ...as, side: true }).includes('revise_section'));
  const exported = { ...as, docFormat: 'markdown', model: null, promptView: { ...as.promptView, docFormat: 'markdown', model: null } };
  assert.ok(!names('edit', exported).includes('revise_section'));
  state.settings.provider = 'munin';
  const mu = T.takeSnapshot(); T.snapshotDocument(mu);
  assert.ok(names('edit', mu).includes('revise_section'));
  state.settings.provider = 'anthropic';
});

test('section type from the heading, in English and Russian', () => {
  const kinds = ['Abstract', 'Summary', 'Аннотация', '1. Introduction', 'Background', 'Введение', 'Materials and Methods', 'Experimental section',
    'Методы исследования', 'Results', 'Результаты', 'Discussion', 'Conclusions', 'Заключение', 'Acknowledgements', 'Related work'].map((h) => T.reviseSectionKind(h));
  deq(kinds, ['abstract', 'abstract', 'abstract', 'introduction', 'introduction', 'introduction', 'methods', 'methods', 'methods', 'results', 'results',
    'discussion', 'discussion', 'discussion', 'other', 'other']);
  for (const k of Object.keys(T.REVISE_SECTION_PROMPTS)) assert.ok(T.REVISE_SECTION_PROMPTS[k].length < 330, k); // about 60 tokens each
});

test('three paragraphs: two changed, one unchanged, one transition pair; quiet requests with the section prompt; Undo restores the section', async () => {
  const bodies = await bench([R1, P2, R3, pairs([{ old: R3, new: T3 }])]);
  const r = await T.executeTool(call({ heading: 'methods', goal: 'shorter' }, 'rv1'), 'edit', as, {});
  assert.ok(r._ok, r.content);
  assert.ok(r.content.startsWith('Revised the section «Methods» (lines 3–6) paragraph by paragraph: 2 of 3 paragraphs changed, 1 unchanged, 0 skipped; 1 transition fixed.'), r.content);
  assert.ok(r.content.endsWith('\nThe line numbers did not change. Do not call revise_section on this section again in this message.'), r.content);
  assert.strictEqual(fake.text('t.0'), ORIGINAL.replace(P1, R1).replace(P3, T3));
  deq([r._message, r._detail, r._edit.kind, r._edit.parts.length, r._edit.id], ['Revised «Methods»: 2 of 3 paragraphs changed', '4 requests, 212 tokens', 'multi', 3, 'rv1']);
  assert.strictEqual(r._cardText, [R1, R3, T3].join('\n\n'));
  // the requests: no chat history, the writing rules and the methods prompt in the system text, the document lines
  assert.strictEqual(bodies.length, 4);
  for (const b of bodies) { assert.strictEqual(b.messages.length, 1); assert.ok(!b.tools); assert.ok(b.system.includes('W1. Write like this document')); }
  assert.ok(bodies[0].system.startsWith('You revise one paragraph of a document.'));
  assert.ok(bodies[0].system.endsWith(T.REVISE_SECTION_PROMPTS.methods));
  assert.strictEqual(bodies[0].messages[0].content, `Document: Membrane order\nKeywords: lipid, order\nSection: Methods\nGoal: shorter\nParagraph to revise:\n${P1}`);
  assert.ok(bodies[1].messages[0].content.includes(`Previous paragraph (context only, do not revise it):\n${R1}\nParagraph to revise:\n${P2}`));
  assert.ok(bodies[3].system.startsWith('You check only the transitions'));
  assert.ok(bodies[3].messages[0].content.endsWith(`Section: Methods\n\n${R1}\n\n${P2}\n\n${R3}`));
  // one journal entry: Undo puts the whole section back
  const res = await T.undoEdit(r._edit);
  assert.ok(res.model);
  assert.strictEqual(fake.text('t.0'), ORIGINAL);
});

test('a paragraph refused by the writing check is skipped with a note; a bad answer is left as it was; unknown heading', async () => {
  // paragraph 2 drops "5 µM": the prose check refuses it; paragraph 3 comes back as two paragraphs
  await bench([R1, 'We then stained them with Laurdan for thirty minutes.', `${R3}\n\nI also fixed the tense.`, '[]']);
  const r = await T.executeTool(call({ heading: 'Methods' }), 'edit', as, {});
  assert.ok(r.content.startsWith('Revised the section «Methods» (lines 3–6) paragraph by paragraph: 1 of 3 paragraphs changed, 0 unchanged, 2 skipped; 0 transitions fixed.'), r.content);
  assert.ok(/\n- paragraph 2: refused by a check: the new text drops 5 µM/.test(r.content), r.content);
  assert.ok(r.content.includes('\n- paragraph 3: the answer had several paragraphs; left as it was'), r.content);
  assert.strictEqual(fake.text('t.0'), ORIGINAL.replace(P1, R1));
  assert.strictEqual(r._edit.parts.length, 1);
  // nothing to revise / no such heading
  const e1 = await T.executeTool(call({ heading: 'Conclusion' }), 'edit', as, {});
  assert.ok(e1.content.startsWith('Error: no heading reads "Conclusion".'), e1.content);
  const e2 = await T.executeTool(call({ heading: 'Membrane order' }), 'edit', as, {});
  deq([e2._ok, e2.content], [false, 'Error: the section «Membrane order» has no paragraphs to revise (subheadings, tables, images and lines under 5 words are left alone).']);
});

test('Stop after paragraph 1: the loop ends before the next request, the written paragraph stays undoable', async () => {
  const ac = new AbortController();
  const bodies = await bench([R1, P2, R3, '[]'], () => ac.abort());
  as.signal = ac.signal;
  const r = await T.executeTool(call({ heading: 'Methods' }), 'edit', as, {});
  as.signal = null;
  assert.strictEqual(bodies.length, 1);
  assert.ok(r.content.startsWith('Revised the section «Methods» (lines 3–6) paragraph by paragraph: 1 of 3 paragraphs changed, 0 unchanged, 0 skipped. Stopped by the user before paragraph 2; the rest is as it was.'), r.content);
  deq([r._message, r._edit.parts.length], ['Revised «Methods»: 1 of 3 paragraphs changed (stopped)', 1]);
  assert.strictEqual(fake.text('t.0'), ORIGINAL.replace(P1, R1));
  await T.undoEdit(r._edit);
  assert.strictEqual(fake.text('t.0'), ORIGINAL);
});

test('a whole turn: revise_section and one more edit; progress on the status line; Undo all restores the document', async () => {
  await fresh(docSpec({ items: ITEMS }));
  await T.createChat();
  T.el.chat.children.length = 0;
  const aTool = (i, name, args) => msgStart + tu(0, 'toolu_' + i, name, args) + stopTool;
  const rounds = [
    aTool('rv', 'revise_section', { heading: 'Methods', goal: null }),
    textRound(R1), textRound(P2), textRound(R3), textRound(pairs([{ old: R3, new: T3 }])),
    aTool('rt', 'replace_text', { old_text: 'Order rose in all the cells we measured.', new_text: 'Order rose in every cell we measured.' }),
    textRound('Revised.'),
  ];
  const bodies = [];
  const statuses = [];
  const setStatus = T.setStatus;
  env.ctx.setStatus = (t, w) => { statuses.push(t); return setStatus(t, w); };
  env.ctx.fetch = routeDocs(async (url, init) => { bodies.push(JSON.parse(init.body)); return sseResponse(rounds[bodies.length - 1]); });
  T.el.input.value = 'Polish the Methods';
  await T.sendMessage();
  await new Promise((r) => setTimeout(r, 20));
  env.ctx.setStatus = setStatus;
  assert.strictEqual(bodies.length, 7);
  deq(statuses.filter((s) => s.startsWith('Revising')), ['Revising Methods: paragraph 1 of 3', 'Revising Methods: paragraph 2 of 3', 'Revising Methods: paragraph 3 of 3', 'Revising Methods: transitions']);
  const tool = state.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'toolu_rv');
  assert.ok(tool._ok && tool._edit && tool._edit.kind === 'multi', tool.content);
  // the next round of the turn got the result
  assert.ok(JSON.stringify(bodies[5]).includes('2 of 3 paragraphs changed'));
  assert.strictEqual(fake.text('t.0'), ORIGINAL.replace(P1, R1).replace(P3, T3).replace('in all the cells', 'in every cell'));
  deq(T.answerEdits('toolu_rt').map((m) => m.tool_call_id), ['toolu_rt', 'toolu_rv']);
  const p = T.undoAllFromButton('toolu_rt', null);
  await waitFor(() => T.pendingPreviews.size === 1, 'the Undo all card');
  const [[id]] = [...T.pendingPreviews.entries()];
  assert.ok(T.decidePreview(id, 'accept'));
  assert.ok(await p);
  assert.strictEqual(fake.text('t.0'), ORIGINAL);
});
