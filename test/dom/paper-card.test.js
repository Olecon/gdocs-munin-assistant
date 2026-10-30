'use strict';
// The paper card in the Document instructions section on a real DOM: Build paper card (one request), the draft as
// editable fields, Save (stored under muninPaperCard:<docId>, edits included), Discard (the draft goes, the saved
// card stays), Rebuild, the stale notice after large changes, and saving empty fields removes the card.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { load, click, tick } = require('../lib/dom-sandbox');
const { installDocTab } = require('../lib/sandbox');
const { recordFetch, useProvider, muText } = require('../lib/context');

let env, T, state, el, chrome, docText;
const DOC = '# Fatigue trial\n\nDoes drug X reduce fatigue?\n\n## Results\n\nFatigue scores fell by 12% versus placebo.';
const CARD = '{"question":"Does drug X reduce fatigue?","population_or_system":"adults","design":"RCT","comparator":"placebo","outcomes":"fatigue score",' +
  '"main_claims":[{"text":"Drug X reduced fatigue","line":7}],"headline_numbers":[{"value":"12%","meaning":"drop in fatigue score","line":7}]}';
const KEY = 'muninPaperCard:DOC123';
const $ = (id) => env.document.getElementById(id);
const field = (f) => $('paperCard_' + f);
const shown = (id) => !$(id).classList.contains('hidden');

before(async () => {
  env = await load();
  ({ T, state, el, chrome } = env);
  installDocTab(env);
  docText = DOC;
  chrome.tabs.sendMessage = async (id, msg) => {
    switch (msg.type) {
      case 'PING': return { ok: true, title: 'My Doc' };
      case 'GET_SELECTION': return { ok: true, text: '' };
      case 'GET_DOC_TEXT': return { ok: true, text: docText, format: 'markdown', title: 'My Doc' };
      default: return { ok: true };
    }
  };
  await T.refreshContext({ force: true });
  useProvider(env, 'munin');
  await T.fetchDocText();
});
after(() => env.close());

test('Build → the draft as fields → edit → Save stores it; Rebuild → Discard keeps the saved card', async () => {
  click(el.instructionsBtn);
  assert.ok(shown('instructions'));
  assert.strictEqual($('paperCardBuild').textContent, 'Build paper card');
  assert.ok(!shown('paperCardFields') && !shown('paperCardSave') && !shown('paperCardDiscard') && !shown('paperCardStale'));
  const bodies = recordFetch(env, [muText('Here:\n```json\n' + CARD + '\n```')]);
  click($('paperCardBuild'));
  for (let i = 0; i < 100 && state.busy; i++) await tick(5);
  assert.strictEqual(bodies.length, 1);
  assert.ok(shown('paperCardFields') && shown('paperCardSave') && shown('paperCardDiscard'));
  assert.strictEqual($('paperCardBuild').textContent, 'Rebuild');
  assert.strictEqual(field('question').value, 'Does drug X reduce fatigue?');
  assert.strictEqual(field('headline_numbers').value, '12%: drop in fatigue score (line 7)');
  assert.ok($('paperCardHint').textContent.startsWith('Check and correct the card, then Save.'));
  assert.ok(!(KEY in env.storage), 'nothing stored before Save');
  // the user corrects a field, then saves
  field('design').value = 'randomized placebo-controlled trial';
  click($('paperCardSave'));
  await tick(5);
  assert.strictEqual(env.storage[KEY].card.design, 'randomized placebo-controlled trial');
  assert.deepStrictEqual(env.storage[KEY].card.headline_numbers, [{ value: '12%', meaning: 'drop in fatigue score', line: 7 }]);
  assert.ok(Array.isArray(env.storage[KEY].facts.hashes) && env.storage[KEY].builtAt > 0);
  assert.ok($('paperCardHint').textContent.startsWith('Sent with every message'));
  // Rebuild gives a new draft; Discard drops it and shows the saved card again
  recordFetch(env, [muText(CARD.replace('"RCT"', '"cohort study"'))]);
  click($('paperCardBuild'));
  for (let i = 0; i < 100 && state.busy; i++) await tick(5);
  assert.strictEqual(field('design').value, 'cohort study');
  click($('paperCardDiscard'));
  assert.strictEqual(field('design').value, 'randomized placebo-controlled trial');
  assert.strictEqual(env.storage[KEY].card.design, 'randomized placebo-controlled trial');
});

test('the stale notice after large changes, with Rebuild; saving empty fields removes the card', async () => {
  docText = DOC + '\n' + Array.from({ length: 12 }, (_, i) => `A new paragraph number ${i}.`).join('\n');
  await T.fetchDocText();
  T.closeInstructions();
  click(el.instructionsBtn);
  assert.ok(shown('paperCardStale'));
  assert.strictEqual($('paperCardStale').textContent, 'The document changed since this card was built.');
  assert.strictEqual($('paperCardBuild').textContent, 'Rebuild');
  for (const f of T.PAPER_CARD_FIELDS) field(f[0]).value = '';
  click($('paperCardSave'));
  await tick(5);
  assert.ok(!(KEY in env.storage));
  assert.ok(!shown('paperCardFields') && !shown('paperCardStale'));
  assert.strictEqual($('paperCardBuild').textContent, 'Build paper card');
  docText = DOC;
});

test('a build that does not come back as a card says so in the section; the button is off while it runs and a queued message comes back', async () => {
  recordFetch(env, [muText('Sorry, no card.')]);
  click($('paperCardBuild'));
  assert.ok(state.busy && $('paperCardBuild').disabled && $('paperCardBuild').textContent === 'Building…');
  // a message typed meanwhile is queued, and goes back into the input box when the build ends
  el.input.value = 'a question typed while it builds';
  T.queueInput();
  assert.strictEqual(state.queued.text, 'a question typed while it builds');
  for (let i = 0; i < 100 && state.busy; i++) await tick(5);
  assert.strictEqual(state.queued, null);
  assert.strictEqual(el.input.value, 'a question typed while it builds');
  el.input.value = '';
  assert.strictEqual($('paperCardHint').textContent, 'The card did not come back as JSON. Try Rebuild.');
  assert.ok($('paperCardHint').classList.contains('warn'));
  assert.ok(!shown('paperCardFields'));
});
