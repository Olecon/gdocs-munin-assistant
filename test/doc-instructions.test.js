'use strict';
// Document instructions (form, storage, prompt head) and the open_document note in the prompt.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab } = require('./lib/sandbox');

let env, T, C, state, storage;

before(async () => {
  env = await load();
  T = C = env.T;
  state = env.state;
  storage = env.storage;
  installDocTab(env);
});

test('document instructions: form, storage per document, cap, removal, badge', async () => {
  // --- document instructions: the form, storage per document, cap, removal, badge
  state.docId = 'DOC123'; state.docInstructions = ''; state.busy = false;
  T.el.chat.children.length = 0;
  C.renderInstructionsBadge();
  assert.ok(T.el.instructionsDot.classList.contains('hidden'));
  C.openInstructions();
  assert.ok(!T.el.instructions.classList.contains('hidden') && T.el.settings.classList.contains('hidden'));
  assert.strictEqual(T.el.instructionsText.value, '');
  T.el.instructionsText.value = '  Use British English.\n';
  C.updateInstructionsCount();
  assert.strictEqual(T.el.instructionsCount.textContent, '23 / 8,000 characters');
  await C.saveInstructions();
  assert.strictEqual(storage['muninDocInstructions:DOC123'], 'Use British English.'); // trimmed
  assert.strictEqual(state.docInstructions, 'Use British English.');
  assert.ok(!T.el.instructions.classList.contains('hidden')); // saving does not close the section
  assert.strictEqual(T.el.instructionsText.value, '  Use British English.\n'); // the typed text is left as it is
  assert.ok(!T.el.instructionsDot.classList.contains('hidden')); // the badge shows that instructions exist
  assert.strictEqual(T.el.instructionsBtn.title, 'Document instructions (set)');
  assert.strictEqual(T.el.chat.children.length, 0); // no notice for an automatic save
  assert.strictEqual(await C.readDocInstructions('DOC123'), 'Use British English.');
  assert.strictEqual(await C.readDocInstructions('OTHERDOC'), ''); // per document
  C.closeInstructions();
  C.openInstructions();
  assert.strictEqual(T.el.instructionsText.value, 'Use British English.');
  T.el.instructionsText.value = 'x'.repeat(9000);
  C.updateInstructionsCount();
  assert.strictEqual(T.el.instructionsCount.textContent, '9,000 / 8,000 characters'); assert.ok(T.el.instructionsCount.classList.contains('warn'));
  await C.saveInstructions();
  assert.strictEqual(storage['muninDocInstructions:DOC123'].length, 8000); // capped
  // closing the section saves what it shows
  T.el.instructionsText.value = '  \n ';
  C.closeInstructions();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(T.el.instructions.classList.contains('hidden'));
  assert.ok(!('muninDocInstructions:DOC123' in storage)); // empty text removes the key
  assert.strictEqual(state.docInstructions, ''); assert.ok(T.el.instructionsDot.classList.contains('hidden'));
  // an unchanged text is not written again
  C.openInstructions();
  storage['muninDocInstructions:DOC123'] = 'outside';
  await C.saveInstructions();
  assert.strictEqual(storage['muninDocInstructions:DOC123'], 'outside');
  delete storage['muninDocInstructions:DOC123'];
  C.closeInstructions();
  // reopening the document reads them back (refreshContext)
  storage['muninDocInstructions:DOC123'] = 'Target journal: Nature.';
  await T.refreshContext({ force: true });
  assert.strictEqual(state.docInstructions, 'Target journal: Nature.'); assert.ok(!T.el.instructionsDot.classList.contains('hidden'));
});

test('document instructions in the system prompt head (Auto, Manual, persona on Anthropic, Munin persona), frozen, capped', async () => {
  // --- document instructions in the system prompt head: Auto, Manual, a persona turn on Anthropic, a Munin persona turn
  state.googleConnected = false; state.docModel = null;
  state.docFormat = 'markdown'; state.docText = '# Paper\n\nIntro.\n\n## Methods\n\nText.'; state.docTitle = 'Paper'; state.docError = ''; state.selection = '';
  state.docInstructions = 'Use British English.';
  const DI_BLOCK = 'The user has written standing instructions for this document (inside <document_instructions>). Follow them in every answer and every edit.\n' +
    '<document_instructions>\nUse British English.\n</document_instructions>';
  const headOf = (mode, prov) => {
    state.settings.provider = prov;
    const sn = T.takeSnapshot(); T.snapshotDocument(sn);
    const rq = T.buildRequest(mode, sn);
    if (rq.kind === 'persona') return /^<instructions>\n([\s\S]*)\n<\/instructions>/.exec(rq.body.messages.at(-1).content)[1]; // no system role
    return prov === 'anthropic' ? rq.body.system[0].text : prov === 'openai' ? rq.body.instructions : rq.body.messages[0].content;
  };
  for (const [mode, prov] of [['edit', 'anthropic'], ['manual', 'anthropic'], ['research', 'anthropic'], ['edit', 'openai'], ['edit', 'munin'], ['code', 'munin']]) {
    const head = headOf(mode, prov);
    const at = head.indexOf(DI_BLOCK);
    assert.ok(at > 0, `${mode}/${prov}: instructions block`);
    // feat/context: in tools mode the block ends the static system prompt (the <document> block is in the
    // turn context of the user message); the Munin persona prompt still has the excerpt right after it
    if (mode === 'code' && prov === 'munin') assert.ok(head.indexOf('<document title="Paper"') === at + DI_BLOCK.length + 2, `${mode}/${prov}: right before <document>`);
    else assert.ok(head.endsWith(`${DI_BLOCK}\n\n${T.UNTRUSTED_DATA_NOTE}`) && !head.includes('<document title='), `${mode}/${prov}: at the end of the static head, before the untrusted-data note`);
    assert.ok(head.startsWith(mode === 'code' ? 'The user is working on a Google Docs document' : mode === 'research' ? 'The user is working' : 'You are an editing assistant'));
  }
  // the Munin persona request (its own pipeline, no client tools) carries the block too, without the open_document note
  state.settings.provider = 'munin';
  let snI = T.takeSnapshot(); T.snapshotDocument(snI);
  let rqI = T.buildRequest('code', snI);
  assert.strictEqual(rqI.kind, 'persona'); assert.ok(rqI.body.messages[0].content.includes(DI_BLOCK)); assert.ok(!rqI.body.messages[0].content.includes('open_document'));
  // frozen per turn: a later change does not reach this turn's requests
  state.docInstructions = 'Changed meanwhile.';
  assert.ok(T.buildRequest('code', snI).body.messages[0].content.includes('Use British English.'));
  // capped in the prompt as well; nothing at all when empty
  state.docInstructions = 'y'.repeat(9000);
  assert.ok(new RegExp('<document_instructions>\\ny{8000}\\n</document_instructions>').test(headOf('edit', 'anthropic')));
  state.docInstructions = '';
  assert.ok(!headOf('edit', 'anthropic').includes('document_instructions'));
});

test('prompts: open_document note and the "doc" parameter of the reading tools', async () => {
  // --- the open_document note follows the instructions; the reading tools take "doc"
  state.settings.provider = 'anthropic';
  let toolsSnap = T.takeSnapshot(); T.snapshotDocument(toolsSnap);
  const toolsHead = T.buildRequest('edit', toolsSnap).body.system[0].text;
  assert.ok(toolsHead.endsWith(`In chat answers you may use simple markdown.\n\n${C.WRITING_RULES}\n\n${C.REMEMBER_NOTE}\n\n${T.UNTRUSTED_DATA_NOTE}`)); // <document> is in the turn context; the untrusted-data note ends the head
  // open_document has no prompt note: its description carries the rule of when to open a document
  assert.ok(!toolsHead.includes('open_document'));
  assert.ok(T.TOOL_DEFS.open_document.function.description.includes('only a document the user can open in Google Docs), and only when the user asks for it or points you to it.'));
  const defs = T.TOOL_DEFS;
  deq(defs.read_lines.function.parameters.required, ['start', 'end', 'doc']);
  deq(defs.find_in_document.function.parameters.required, ['query', 'doc']);
  deq(defs.get_outline.function.parameters.required, ['doc']);
  deq(defs.read_lines.function.parameters.properties.doc.anyOf, [{ type: 'string' }, { type: 'null' }]);
  deq(defs.open_document.function.parameters, { type: 'object', properties: { url: { type: 'string', description: 'The document link or its document ID.' } }, required: ['url'], additionalProperties: false });
  for (const n of ['get_selection', 'read_formatting', 'replace_selection', 'replace_text', 'replace_all', 'format_text', 'insert_after_line', 'delete_lines', 'undo_last_edit']) {
    assert.ok(defs[n].function.description.endsWith('Main document only.'), n);
    assert.strictEqual(defs[n].function.parameters.properties.doc, undefined, n);
  }
});
