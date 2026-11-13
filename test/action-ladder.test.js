'use strict';
// The ladder of a bubble's action log in sidepanel.css (jsdom lays nothing out, so the rules themselves are pinned): the
// folds of the log have no marker (only the footer's reasoning fold keeps its ▸, one step wide with its gap), a level's
// children start one step (--fold-step) in from its text, a card's border and padding make one step, and nothing else
// adds a horizontal offset; the status line's marker gives way to the orb by a class, not by a :has() rule. The rows,
// "Actions N", "Sources · N", the answered rows and the agent log share one type. The timeline rail sits left of all that: one
// gutter on every item, a dot and a piece of the line per item, the ends set by classes. The footer, the message text
// style and the frameless assistant turn are pinned here too.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// The declarations of the rule whose selector list is exactly sel.
function rule(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(CSS);
  assert.ok(m, `no rule for ${sel}`);
  return m[1];
}
const has = (sel, decl) => assert.ok(rule(sel).replace(/\s+/g, ' ').includes(decl), `${sel} { ${decl} }: ${rule(sel)}`);

test('one step: the variable; the log\'s folds have no marker, the footer\'s reasoning fold keeps the only ▸', () => {
  assert.match(CSS, /--fold-step:\s*12px;/);
  // no ▸ (nor any ::before) on a row, "Actions N", "Sources · N" or the agent log's summary
  for (const sel of ['.log-row > summary', '.log-fold > summary', '.stage-line', '.sources-title', '.agent-log > summary']) {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.ok(!new RegExp(`${esc}::before`).test(CSS), `${sel} has no marker`);
  }
  assert.strictEqual((CSS.match(/content: "▸"/g) || []).length, 0, 'no ▸ left in the stylesheet (the footer lost its marker too)');
  // still clickable-looking: the hover underline and the focus ring
  for (const sel of ['.stage-line:hover', '.sources-title:hover', '.agent-log > summary:hover', '.log-row > summary:hover, .log-fold > summary:hover']) has(sel, 'text-decoration: underline');
  for (const sel of ['.stage-line:focus-visible', '.sources-title:focus-visible', '.agent-log > summary:focus-visible', '.log-row > summary:focus-visible, .log-fold > summary:focus-visible']) has(sel, 'outline: 2px solid var(--accent-ring)');
  // the footer's label ("Worked for Ns") has no marker either: the hover underline says it opens; the reasoning's text
  // starts where the label starts
  assert.ok(!/\.thinking > summary::before/.test(CSS), 'no marker on the footer label');
  has('.thinking > summary:hover', 'text-decoration: underline');
  has('.thinking > summary', 'gap: 5px');
  has('.msg-foot > .thinking-body', 'margin: 5px 0 0;');
  // no :has() on the DOM
  has('.thinking > summary', 'min-height: 20px');
  has('.thinking > summary', 'line-height: 20px');
  assert.ok(!/:has\(/.test(CSS), 'no rule depends on what an element holds');
});

test('the levels: a multi-call round\'s rows (only under its shown action row), the lines without a marker', () => {
  assert.ok(!/\.tool-group|\.tg-toggle/.test(CSS), 'no per-turn group row');
  has('.stage-head:not(.hidden) + .stage-rows', 'padding-left: var(--fold-step)');
  assert.ok(!/(^|\})\s*\.stage-head \+ \.stage-rows\s*\{/.test(CSS), 'a hidden action row must not indent a single-call round');
  // without markers a running row or a search row starts where a folding row's text does: no pad of its own
  assert.ok(!/\.activity-row:not\(details\)/.test(CSS), 'no marker to make room for');
  assert.ok(!/padding-left/.test(rule('.log-row.pending')), 'the running row has no step of its own');
  assert.ok(!/padding-left/.test(rule('.activity-row')));
  // the round's own text is message text, not a row: it starts where the answer's text does, no step of the ladder
  assert.ok(!/padding|margin-left/.test(rule('.stage > .stage-text')), 'the round\'s own text: no offset of its own');
  assert.ok(!/(^|\})\s*\.stage-text\s*\{/.test(CSS), 'no rule pads or dims the round\'s text by itself');
  // a waiting card (the cards slot) and a result card (its stage): border (1 px) and padding one step, so the head
  // starts one step in, where the rows' text does
  has('.msg-cards > .tool-card', 'padding-left: calc(var(--fold-step) - 1px)');
  has('.stage-rows > .tool-card', 'padding-left: calc(var(--fold-step) - 1px)');
  has('.tool-card', 'border: 1px solid var(--border)');
  // the agent block's log: its entries one step in from its text
  has('.agent-log .activity-row', 'padding-left: var(--fold-step)');
  has('.agent-log > .answered-row', 'padding-left: var(--fold-step)');
  has('.agent-log > .tool-card', 'margin-left: var(--fold-step)');
});

test('one type for the fold lines: rows, "Actions N", "Sources · N", answered rows, the agent log, the waiting card\'s head', () => {
  assert.match(CSS, /--row-size:\s*11\.5px;/);
  assert.match(CSS, /--row-lh:\s*1\.45;/);
  for (const sel of ['.activity-row', '.stage-head', '.sources-title', '.answered-row', '.agent-log', '.pv-head']) {
    has(sel, 'font-size: var(--row-size)');
    has(sel, 'line-height: var(--row-lh)');
  }
  // "Actions N" takes the head's type; no line of the log is set heavier than the others
  has('.stage-line', 'font: inherit');
  for (const sel of ['.activity-row', '.activity-name', '.stage-head', '.stage-line', '.sources-title', '.answered-row', '.agent-log', '.pv-head', '.pv-tool']) {
    assert.ok(!/font-weight:\s*(5|6|7)00|bold/.test(rule(sel)), `${sel}: ${rule(sel)}`);
  }
  has('.activity-name', 'font-weight: 400'); // the tool names are set to the normal weight outright
  has('.activity-name', 'color: inherit'); // the tool name is not brighter than its row either
  // the footer's label stands in the rail's text column, as if it had a dot; the chat keeps the scrollbar's room
  has('.msg-foot > .thinking', 'padding-left: var(--tl-gutter)');
  has('.chat', 'scrollbar-gutter: stable');
});

test('the decision cards in the row typography: the waiting card\'s head, the answered row; no monospace tool name', () => {
  assert.ok(!/font-family|var\(--mono\)/.test(rule('.pv-tool')), rule('.pv-tool'));
  has('.answered-row', 'color: var(--fg-3)');
  assert.ok(!/border|background|padding/.test(rule('.answered-row')), 'no box');
  assert.ok(!/\.tool-card\.preview\.answered|\.pv-answer|\.pv-asked/.test(CSS), 'the boxed answered state is gone');
});

test('the timeline rail: a gutter on every item, a small muted dot, the accent on the live one (no green), one line between the ends', () => {
  assert.match(CSS, /--tl-gutter:\s*14px;/);
  assert.match(CSS, /--tl-dot:\s*7px;/);
  assert.match(CSS, /--tl-gap:\s*7\.5px;/);
  // the gap a piece of the line reaches over is the bubble's gap between its slots, and more than the rounds' gap: no
  // hole in the line
  assert.match(CSS, /\.msg\.assistant \{ display: flex; flex-direction: column; gap: var\(--tl-gap\);/);
  has('.activity-rows', 'gap: 2.5px');
  has('.tl-item', 'padding-left: var(--tl-gutter)');
  has('.tl-item', 'position: relative');
  has('.tl-item::before', 'width: var(--tl-dot)');
  has('.tl-item::before', 'border-radius: 50%');
  has('.tl-item::before', 'background: var(--fg-3)');
  has('.tl-item.tl-live::before', 'background: var(--accent)');
  const railRules = CSS.split('}').map((r) => r.split('{')).filter(([sel]) => /\.tl-/.test(sel || ''));
  assert.ok(railRules.length >= 6);
  for (const [sel, body] of railRules) assert.ok(!/--ok-/.test(body), `no green on the rail: ${sel}`);
  has('.tl-item::after', 'top: calc(-1 * var(--tl-gap))');
  has('.tl-item.tl-first::after', 'top: var(--tl-dot-y)');
  has('.tl-item.tl-last::after', 'height: calc(var(--tl-gap) + var(--tl-dot-y))');
  has('.tl-item.tl-first.tl-last::after', 'content: none');
  has('.tl-item.tl-first.tl-last::before', 'content: none'); // a lone item: no dot, no line
  // the dot and the line sit in the gutter, left of the ladder: the ladder's own rules stay as they are
  has('.tl-item::before', 'left: 0');
  // the answer's ::after is the rail's: the typing cursor moved onto its text, at the end of its last line (a line of its
  // own would go when the text stops and move what is under it)
  has('.msg.typing > .msg-answer > .md > :is(p, h1, h2, h3, h4, h5, h6, blockquote):last-child::after,\n.msg.typing > .msg-answer > .md > :is(ul, ol):last-child > li:last-child::after', 'content: "▍"');
  assert.ok(!/\.msg-answer::after/.test(CSS));
  assert.ok(!/\.md::after/.test(CSS), 'no line of its own under the text');
  // the waiting cards line up with the rail's items (a gutter only while the bubble has a rail); the meta line has none
  has('.msg.assistant.has-rail > .msg-cards', 'padding-left: var(--tl-gutter)');
  assert.ok(!/padding-left|tl-/.test(rule('.msg-meta')));
  assert.ok(!/\.thinking\.tl-item|\.msg-foot\.tl-item/.test(CSS), 'the footer is not a rail item');
});

test('the footer: the last line, chrome; the status left, the token line right on the status\'s line; the opened reasoning a row below', () => {
  has('.msg-foot', 'display: grid');
  has('.msg-foot', 'user-select: none');
  // row 1: the status takes what the token line leaves (minmax 0, so the line never wraps), the token line at the right;
  // the reasoning is row 2 across both columns, so opening it never moves the token line
  has('.msg-foot', 'grid-template-columns: minmax(0, 1fr) auto');
  has('.msg-foot > .thinking', 'grid-column: 1');
  has('.msg-meta', 'grid-column: 2');
  has('.msg-foot > .thinking-body', 'grid-column: 1 / -1');
  has('.msg-foot > .thinking-body', 'padding-left: var(--tl-gutter)'); // its text starts where the label starts
  assert.ok(!/flex-wrap|flex-basis/.test(rule('.msg-foot') + rule('.msg-foot > .thinking')), 'no wrapping row');
  assert.ok(!/\.thinking\[open\]/.test(CSS), 'opening the details changes no layout rule');
  has('.msg-meta', 'margin-left: auto');
  has('.msg-meta', 'line-height: 20px');
  has('.msg-meta', 'user-select: none');
  assert.ok(!/padding-left|tl-/.test(rule('.msg-foot')), 'the footer has no gutter and no dot');
});

test('the assistant\'s text in one message style, in full; the reasoning too; no frame on the assistant', () => {
  // the answer and every round's own text: the message style (the body's 13px/1.5 and the primary colour), never the rows'
  has('.msg-text', 'font-size: 13px');
  has('.msg-text', 'line-height: 1.5');
  has('.msg-text', 'color: var(--fg)');
  // no inner scroll box, no clip and no line clamp on the answer or a round's text, however long (the chat scrolls)
  const clip = /max-height|overflow(-y)?:\s*(auto|scroll|hidden)|line-clamp/;
  for (const [sel, body] of CSS.split('}').map((r) => r.split('{'))) {
    if (!sel || body == null) continue;
    if (/(^|[\s,>])\.(md|msg-text|stage-text|msg-answer)\b/.test(sel) && !/\.agent-answer|code|pre|\.sources/.test(sel)) assert.ok(!clip.test(body), `${sel.trim()} must not clip: ${body}`);
  }
  // the reasoning opens in full too (the owner's choice): no scroll box of its own, long words wrap
  assert.ok(!clip.test(rule('.msg-foot > .thinking-body')), rule('.msg-foot > .thinking-body'));
  has('.msg-foot > .thinking-body', 'white-space: pre-wrap');
  has('.msg-foot > .thinking-body', 'overflow-wrap: anywhere');
  // the assistant's turn has no frame: no border, background or box padding (the user's bubble keeps its own)
  has('.msg.assistant', 'background: none');
  has('.msg.assistant', 'border: 0');
  has('.msg.assistant', 'padding: 0');
  assert.ok(!/box-shadow/.test(rule('.msg.assistant')));
  has('.msg.user', 'background: var(--user-bg)');
});
