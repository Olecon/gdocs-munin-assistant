'use strict';
// The composer bar on a real DOM (jsdom): the mode menu above the mode button (three modes with descriptions, a
// check on the current one, a pick persists, a click outside or Escape closes, nothing while busy), the [/] button
// that lists every slash command (left of the mode button; /code dimmed with "Munin only" for the other providers), and the CSS of the mode label (primary text) and the Google account chip.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { load, click, mouse, key, typeInto, tick } = require('../lib/dom-sandbox');
const { deq, installDocTab } = require('../lib/sandbox');

let env, T, state, el, document, storage;
const menuRows = () => [...el.modeMenu.querySelectorAll('.mode-row')];
const menuOpen = () => !el.modeMenu.classList.contains('hidden');
const cmdRows = () => [...el.cmdPopup.querySelectorAll('.cmd-row')];
const cmdOpen = () => !el.cmdPopup.classList.contains('hidden');
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'sidepanel.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// The declarations of the rule whose selector list is exactly sel.
const ruleBody = (sel) => {
  const m = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((r) => r[1].split(',').map((x) => x.trim()).includes(sel));
  return m ? m[2] : '';
};

before(async () => {
  env = await load();
  ({ T, state, el, document, storage } = env);
  installDocTab(env);
  await T.refreshContext({ force: true });
});
after(() => env.close());

test('mode menu: opens above the button with the three modes, descriptions and a check on the current one', async () => {
  T.applyApplyMode('manual');
  assert.ok(!menuOpen());
  click(el.modeCycle);
  assert.ok(menuOpen());
  assert.strictEqual(el.modeCycle.getAttribute('aria-expanded'), 'true');
  deq(menuRows().map((r) => [r.dataset.mode, r.querySelector('.mode-row-title').textContent, r.querySelector('.mode-row-desc').textContent]), [
    ['manual', 'Manual', 'The assistant answers in the chat; you apply its text with one click.'],
    ['auto', 'Edit automatically', 'The assistant edits the document; large or risky edits ask first.'],
    ['plan', 'Plan', 'The assistant reads and proposes a numbered plan of edits; Do it carries it out.'],
  ]);
  deq(menuRows().map((r) => [r.getAttribute('aria-checked'), r.querySelector('.mode-check').textContent, r.classList.contains('active')]),
    [['true', '✓', true], ['false', '', false], ['false', '', false]]);
  assert.ok(el.modeMenu.style.bottom.endsWith('px') && el.modeMenu.style.left.endsWith('px')); // anchored above the button
  // a second click on the button closes it
  click(el.modeCycle);
  assert.ok(!menuOpen());
  assert.strictEqual(el.modeCycle.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(el.modeMenu.children.length, 0);
});

test('mode menu: a pick sets the mode, persists it and closes; the check follows', async () => {
  T.applyApplyMode('manual');
  click(el.modeCycle);
  click(menuRows()[2].querySelector('.mode-row-desc')); // a click anywhere in the row
  await tick(5);
  assert.ok(!menuOpen());
  deq([state.applyMode, storage.muninApplyMode, el.modeLabel.textContent, el.modeCycle.dataset.mode], ['plan', 'plan', 'Plan', 'plan']);
  click(el.modeCycle);
  deq(menuRows().map((r) => r.getAttribute('aria-checked')), ['false', 'false', 'true']);
  click(menuRows()[1]);
  await tick(5);
  deq([state.applyMode, storage.muninApplyMode, el.modeLabel.textContent], ['auto', 'auto', 'Edit automatically']);
  // the current mode again: closes, nothing changes
  click(el.modeCycle);
  click(menuRows()[1]);
  await tick(5);
  assert.ok(!menuOpen());
  assert.strictEqual(state.applyMode, 'auto');
  await T.setApplyMode('manual');
});

test('mode menu: a click outside or Escape closes it; nothing while an answer runs', async () => {
  click(el.modeCycle);
  assert.ok(menuOpen());
  mouse(el.modeMenu, 'mousedown'); // inside: stays
  assert.ok(menuOpen());
  mouse(el.chat, 'mousedown');
  assert.ok(!menuOpen());
  click(el.modeCycle);
  key(document.body, 'Escape');
  assert.ok(!menuOpen());
  assert.strictEqual(document.activeElement, el.modeCycle);
  // a turn starting while the menu is open closes it; the disabled button opens nothing
  click(el.modeCycle);
  T.setBusy(true);
  assert.ok(!menuOpen() && el.modeCycle.disabled);
  click(el.modeCycle);
  assert.ok(!menuOpen());
  T.setBusy(false);
  assert.strictEqual(state.applyMode, 'manual');
});

test('[/] button: lists every command, a pick goes in front of the text, a second click closes', async () => {
  assert.strictEqual(el.cmdBtn.title, 'Commands');
  assert.strictEqual(el.cmdBtn.textContent, '/');
  el.input.value = '';
  el.input.blur();
  click(el.cmdBtn);
  assert.ok(cmdOpen());
  assert.strictEqual(document.activeElement, el.input); // the focus is in the input, so a pick inserts there
  assert.strictEqual(el.cmdBtn.getAttribute('aria-expanded'), 'true');
  deq(cmdRows().map((r) => r.querySelector('.cmd-name').textContent), ['/research', '/code', '/chat', '/review', '/side', '/check', '/test']);
  // a click in the input or a caret move keeps it; a second click on the button closes it
  click(el.input);
  document.dispatchEvent(new env.window.Event('selectionchange'));
  assert.ok(cmdOpen());
  // the button's mousedown does not take the focus away from the input (its blur would close the list)
  assert.ok(mouse(el.cmdBtn, 'mousedown') === false);
  click(el.cmdBtn);
  assert.ok(!cmdOpen());
  assert.strictEqual(el.cmdBtn.getAttribute('aria-expanded'), 'false');
  // a mouse pick with text already typed: the command goes in front, nothing is sent
  typeInto(el.input, 'shorten this');
  click(el.cmdBtn);
  mouse(cmdRows()[3], 'mousedown');
  assert.strictEqual(el.input.value, '/review shorten this');
  assert.ok(!cmdOpen());
  // typing closes the pinned list (the normal "/" autocomplete takes over)
  typeInto(el.input, '');
  click(el.cmdBtn);
  typeInto(el.input, 'x');
  assert.ok(!cmdOpen());
  typeInto(el.input, '/');
  assert.strictEqual(cmdRows().length, 7);
  key(el.input, 'Escape');
  // the input losing the focus closes it
  typeInto(el.input, '');
  click(el.cmdBtn);
  el.input.blur();
  assert.ok(!cmdOpen());
  // Escape closes the pinned list too
  click(el.cmdBtn);
  key(el.input, 'Escape');
  assert.ok(!cmdOpen());
  el.input.value = '';
});

test('bar order: [/] button, mode button, context gauge, Send/Stop', () => {
  deq([...document.querySelector('.input-bar').children].map((c) => c.id), ['cmdBtn', 'modeCycle', 'contextGauge', 'actionBtn']);
});

test('/code row: dimmed with "Munin only" and not pickable for OpenAI and Anthropic, active for Munin', async () => {
  const saved = state.settings.provider;
  const codeRow = () => cmdRows().find((r) => r.querySelector('.cmd-name').textContent === '/code');
  try {
    for (const prov of ['openai', 'anthropic']) {
      state.settings.provider = prov;
      el.input.value = '';
      click(el.cmdBtn);
      const row = codeRow();
      assert.ok(row.classList.contains('disabled') && !row.classList.contains('active'), prov);
      assert.strictEqual(row.getAttribute('aria-disabled'), 'true');
      assert.strictEqual(row.querySelector('.cmd-note').textContent, 'Munin only');
      // hover does not highlight it, a click inserts nothing and keeps the list
      mouse(row, 'mouseover');
      assert.ok(!codeRow().classList.contains('active'));
      mouse(codeRow(), 'mousedown');
      assert.strictEqual(el.input.value, '');
      assert.ok(cmdOpen());
      key(el.input, 'Escape');
      // the filter keeps the dimmed row; the highlight starts on /chat and the arrows skip /code
      typeInto(el.input, '/c');
      deq(cmdRows().map((r) => r.querySelector('.cmd-name').textContent), ['/code', '/chat', '/check']);
      assert.ok(cmdRows()[1].classList.contains('active'));
      key(el.input, 'ArrowUp');
      assert.ok(cmdRows()[2].classList.contains('active'));
      key(el.input, 'ArrowDown');
      assert.ok(cmdRows()[1].classList.contains('active'));
      key(el.input, 'Escape');
      el.input.value = '';
    }
    state.settings.provider = 'munin';
    click(el.cmdBtn);
    const row = codeRow();
    assert.ok(!row.classList.contains('disabled') && !row.hasAttribute('aria-disabled') && !row.querySelector('.cmd-note'));
    mouse(row, 'mousedown');
    assert.strictEqual(el.input.value, '/code ');
  } finally {
    state.settings.provider = saved;
    el.input.value = '';
  }
});

test('CSS: the mode label is primary text; the Google account label is a framed chip without the help cursor', () => {
  assert.match(ruleBody('.mode-label'), /(^|[\s;])color:\s*var\(--fg\)/);
  assert.match(ruleBody('.mode-cycle'), /(^|[\s;])color:\s*var\(--fg\)/);
  assert.ok(!/cursor:\s*help/.test(css));
  const chip = ruleBody('.google-row .google-label');
  assert.match(chip, /cursor:\s*default/);
  assert.match(chip, /border:\s*1px solid/);
  assert.match(chip, /padding:/);
  // the [/] button and the mode button share one height
  assert.match(ruleBody('.cmd-btn'), /height:\s*24px/);
  assert.match(ruleBody('.mode-cycle'), /height:\s*24px/);
  // the tooltip with the account stays
  assert.strictEqual(el.googleStatus.title, 'Not signed in');
});
