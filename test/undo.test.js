'use strict';
// Undo of Docs API edits refused after outside changes; embedded objects are not re-inserted.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, waitFor, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { OC, ORIGINAL, ORIGINAL_STYLES, docSpec, docsBench } = require('./lib/fake-docs');
const { sseResponse, tu, msgStart, stopTool, textRound } = require('./lib/streams');

let fake; let as; // the fake Docs server and the turn snapshot; fresh() replaces both
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, fresh, exec, pushTool, w;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  ident = installIdentity(env);
  ({ fresh, exec, pushTool } = docsBench(env, ident, ref));
  // the Docs tab and the provider as the old harness had them at this point
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

test('undo refused after an outside change (delete, empty replacement)', async () => {
  // --- undo is refused after an outside change near the edit: a delete and an empty-new_text replace
  await fresh();
  pushTool(await exec('delete_lines', { start: 9, end: 9 }, 'd1'));
  // the user edits the line right before the deleted one (inside the anchor; a paragraph typed further
  // above no longer blocks the undo: see "anchor relocation" below)
  fake.tabs[0].blocks[2].paras[0].text = 'Details!'; fake.revision++;
  const afterTyping = fake.text('t.0');
  w = await exec('undo_last_edit', {}, 'd1u');
  assert.ok(!w._ok && /changed near that edit/.test(w.content) && /Ctrl\+Z/.test(w.content), w.content);
  assert.strictEqual(fake.text('t.0'), afterTyping);
  await fresh();
  pushTool(await exec('replace_text', { old_text: ' beta delta', new_text: '' }, 'e1'));
  assert.ok(fake.text('t.0').includes('\nAlpha.\n'));
  fake.tabs[0].blocks[0].paras[4].text = 'Alpha!'; fake.revision++; // the user edits right at the spot
  w = await exec('undo_last_edit', {}, 'e1u');
  assert.ok(!w._ok && /changed near that edit/.test(w.content));
  assert.ok(fake.text('t.0').includes('\nAlpha!\n') && !fake.text('t.0').includes('beta delta'));
  // ... but an unrelated later edit of the panel itself does not block the stack
  await fresh();
  pushTool(await exec('replace_text', { old_text: 'Last line', new_text: 'Final line' }, 'f1'));
  pushTool(await exec('replace_text', { old_text: 'Intro', new_text: 'Preface' }, 'f2'));
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'f2u'))._ok && pushTool(await exec('undo_last_edit', {}, 'f1u'))._ok);
  deq(fake.text('t.0').split('\n'), ORIGINAL);
});

test('undo does not insert embedded-object placeholders', async () => {
  // --- undo of a deletion that contained an inline object: the placeholder is not inserted
  await fresh();
  pushTool(await exec('delete_lines', { start: 9, end: 9 }, 'o1'));
  w = pushTool(await exec('undo_last_edit', {}, 'o1u'));
  assert.ok(w._ok && /Embedded objects .* could not be restored/.test(w.content) && /could not be restored/.test(w._detail));
  assert.strictEqual(fake.raw('t.0').split('\n')[8], 'Image  done'); // no literal U+FFFC in the document
  assert.ok(!fake.raw('t.0').includes(OC));
});

test('anchor relocation: an edit moved by text typed above is undone where it is now', async () => {
  await fresh();
  const at0 = pushTool(await exec('replace_text', { old_text: 'Last line', new_text: 'Final line' }, 'r1'))._edit.index;
  fake.typeParagraph(1, 'Typed by the user'); // above the edit: its index moves by 18
  w = pushTool(await exec('undo_last_edit', {}, 'r1u'));
  assert.ok(w._ok, w.content);
  deq(fake.text('t.0').split('\n'), [ORIGINAL[0], 'Typed by the user', ...ORIGINAL.slice(1)]);
  assert.strictEqual(state.messages.find((m) => m._edit && m._edit.id === 'r1')._edit.index, at0 + 18); // the journal follows the move
  // multi-paragraph edit with styles, moved by a paragraph typed at the top
  await fresh();
  pushTool(await exec('replace_text', { old_text: 'text.\nMethods', new_text: 'text. Methods' }, 'r2'));
  fake.typeParagraph(0, 'Typed');
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'r2u'))._ok);
  deq(fake.text('t.0').split('\n'), ['Typed', ...ORIGINAL]);
  deq(fake.styles('t.0'), ['NORMAL_TEXT', ...ORIGINAL_STYLES]);
  // the context now occurs twice: which one is the edit is unknown, so the undo is refused
  await fresh(docSpec({ items: [{ p: 'Title', style: 'TITLE' }, { p: 'Some context line' }, { p: 'Unique words here and more text' }, { p: 'Tail' }] }));
  pushTool(await exec('replace_text', { old_text: 'Unique words', new_text: 'Changed words' }, 'r3'));
  // a copy of the edited paragraph with its context below it, and a paragraph typed above (the index moves)
  fake.typeParagraph(3, 'Changed words here and more text'); fake.typeParagraph(3, 'Some context line'); fake.typeParagraph(3, 'Title');
  fake.typeParagraph(0, 'Typed');
  const before2 = fake.text('t.0');
  w = await exec('undo_last_edit', {}, 'r3u');
  assert.ok(!w._ok && /changed near that edit/.test(w.content), w.content);
  assert.strictEqual(fake.text('t.0'), before2);
});

// One chat turn with the Anthropic stream rounds given; the Docs API is the fake server.
async function runTurn(rounds, onDocsPost) {
  const bodies = [];
  const docs = env.ctx.fetch; // fresh() routed the Docs API to the fake server
  env.ctx.fetch = async (url, init) => {
    if (url.startsWith('https://docs.googleapis.com/') && init && init.method === 'POST' && onDocsPost) onDocsPost();
    if (url.startsWith('https://docs.googleapis.com/')) return docs(url, init);
    bodies.push(JSON.parse(init.body));
    return sseResponse(rounds[bodies.length - 1]);
  };
  T.el.input.value = 'Edit it';
  await T.sendMessage();
  await new Promise((r) => setTimeout(r, 20));
  env.ctx.fetch = docs;
  return bodies;
}
// Undo all with its confirmation card decided ('accept' or 'reject'); returns { r, html } (html: the card).
async function undoAll(editId, decision = 'accept') {
  const p = T.undoAllFromButton(editId, null);
  await waitFor(() => T.pendingPreviews.size === 1, 'the Undo all card');
  const [[id, pv]] = [...T.pendingPreviews.entries()];
  const html = pv.card.innerHTML;
  assert.ok(T.decidePreview(id, decision));
  return { r: await p, html };
}
const lastCard = () => T.el.chat.children.filter((c) => c && c.className && c.className.includes('tool-card')).pop();

test('the journal is saved right after each edit; Undo all reverts the edits of an answer', async () => {
  env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'PING' ? { ok: true, title: 'My Doc' } : msg.type === 'GET_SELECTION' ? { ok: true, text: '' } : { ok: true });
  await fresh();
  await T.createChat();
  state.applyMode = 'auto';
  state.settings.provider = 'anthropic'; state.settings.providers.anthropic.apiKey = 'k-anthropic';
  const key = () => 'muninChatHistory:DOC123:' + state.chatId;
  const saved = [];
  let posts = 0;
  // two edits in one response; when the second is sent, the first is already in storage
  await runTurn([
    msgStart + tu(0, 'toolu_a', 'replace_text', { old_text: 'Intro', new_text: 'Preface' }) + tu(1, 'toolu_b', 'replace_text', { old_text: 'Last line', new_text: 'Final line' }) + stopTool,
    textRound('Done.'),
  ], () => { posts++; if (posts === 2) saved.push(JSON.parse(JSON.stringify(env.storage[key()] || []))); });
  assert.strictEqual(posts, 2);
  const firstSaved = saved[0].find((m) => m._edit && m._edit.id === 'toolu_a');
  assert.ok(firstSaved && firstSaved._edit.restore === 'Intro', JSON.stringify(saved[0]));
  assert.ok(!saved[0].some((m) => m._edit && m._edit.id === 'toolu_b'));
  // the latest card has Undo and "Undo all (2)"; the older one neither
  T.el.chat.children.length = 0;
  T.renderHistory();
  const cards = T.el.chat.children.filter((c) => c.className.includes('tool-card'));
  assert.strictEqual(cards.length, 2);
  assert.ok(cards[1].innerHTML.includes('data-act="undo-all" data-edit="toolu_b"') && cards[1].innerHTML.includes('Undo all (2)'), cards[1].innerHTML);
  assert.ok(!cards[0].innerHTML.includes('data-act="undo'));
  deq(T.answerEdits('toolu_a'), []); // only from the most recent edit
  // Undo all: newest to oldest, the document is back, the card says so
  assert.strictEqual((await undoAll('toolu_b')).r, true);
  deq(fake.text('t.0').split('\n'), ORIGINAL);
  assert.ok(lastCard().innerHTML.includes('Undid all 2 edits of this answer') && lastCard().innerHTML.includes('- Replaced line 10\n- Replaced line 2'), lastCard().innerHTML);
  const hist = env.storage[key()];
  assert.ok(hist.filter((m) => m._edit).every((m) => m._edit.undone && /Undo all button/.test(m.content)));
  // one edit in an answer: no "Undo all"
  await runTurn([msgStart + tu(0, 'toolu_c', 'replace_text', { old_text: 'Intro', new_text: 'Preface' }) + stopTool, textRound('Done.')]);
  T.el.chat.children.length = 0;
  T.renderHistory();
  assert.ok(lastCard().innerHTML.includes('data-act="undo-edit" data-edit="toolu_c"') && !lastCard().innerHTML.includes('undo-all'));
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'toolu_cu'))._ok);
  // stops at the first edit that cannot be undone and says what was undone and what was not
  await runTurn([
    msgStart + tu(0, 'toolu_d', 'replace_text', { old_text: 'Intro', new_text: 'Preface' }) + tu(1, 'toolu_e', 'replace_text', { old_text: 'Last line', new_text: 'Final line' }) + stopTool,
    textRound('Done.'),
  ]);
  fake.tabs[0].blocks[0].paras[1].text = 'Preface!! 😀 text.'; fake.revision++; // the user edits right at the older edit
  assert.strictEqual((await undoAll('toolu_e')).r, false);
  assert.ok(fake.text('t.0').endsWith('\nLast line') && fake.text('t.0').includes('Preface!!'));
  const card = lastCard();
  assert.ok(card.className.includes('fail') && card.innerHTML.includes('Undid 1 of 2 edits of this answer'), card.innerHTML);
  assert.ok(card.innerHTML.includes('Undone (newest first):\n- Replaced line 10\nNot undone (still in the document):\n- Replaced line 2'), card.innerHTML);
  assert.ok(/Stopped at &quot;Replaced line 2&quot;: the document changed near that edit/.test(card.innerHTML), card.innerHTML);
});
