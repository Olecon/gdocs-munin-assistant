'use strict';
// Module word-diff.js: a small word-level diff for the record of an applied edit (the "What changed" fold of an edit
// card, render.js). Our own LCS over word tokens: words (letters, digits, marks, underscore, any script), runs of
// whitespace, and single punctuation characters. The common head and tail are cut off first, so only the middle
// goes through the quadratic table; a middle too large for it is shown as one deletion and one insertion.
// No top-level dependencies.
/* global escapeHtml */
/* exported wordDiff, wordDiffHtml, WORD_DIFF_SHOW_CHARS */

const WORD_DIFF_MAX_CELLS = 250000; // the LCS table of the middle (500 × 500 tokens)
const WORD_DIFF_SHOW_CHARS = 400; // the card shows this much of the diff, then "…"
const WORD_TOKEN_RE = /[\p{L}\p{N}\p{M}_]+|\s+|[^\p{L}\p{N}\p{M}_\s]/gu;

const wordTokens = (s) => String(s == null ? '' : s).match(WORD_TOKEN_RE) || [];

// [[op, text]] with op -1 (removed), 0 (kept), 1 (inserted); neighbours with the same op are merged.
function wordDiff(oldText, newText) {
  const a = wordTokens(oldText);
  const b = wordTokens(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const ops = [];
  const push = (op, t) => {
    if (!t) return;
    const last = ops[ops.length - 1];
    if (last && last[0] === op) last[1] += t; else ops.push([op, t]);
  };
  push(0, a.slice(0, head).join(''));
  if (am.length * bm.length > WORD_DIFF_MAX_CELLS) {
    push(-1, am.join(''));
    push(1, bm.join(''));
  } else {
    for (const [op, t] of lcsOps(am, bm)) push(op, t);
  }
  push(0, a.slice(a.length - tail).join(''));
  return cleanupWhitespace(ops);
}

// The edit script of two token lists from their LCS table (suffix lengths, so the walk goes forward).
function lcsOps(a, b) {
  const n = a.length, m = b.length;
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([0, a[i]]); i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) out.push([-1, a[i++]]);
    else out.push([1, b[j++]]);
  }
  while (i < n) out.push([-1, a[i++]]);
  while (j < m) out.push([1, b[j++]]);
  return out;
}

// One deletion and one insertion per change: a kept run of only whitespace between two changes goes into both
// ("a b" -> "c d" shows as "a b" removed, "c d" inserted, not as two pairs around a kept space).
function cleanupWhitespace(ops) {
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === 0) { out.push([0, ops[k][1]]); k++; continue; }
    let del = '', ins = '';
    for (; k < ops.length; k++) {
      const [op, t] = ops[k];
      if (op === -1) del += t;
      else if (op === 1) ins += t;
      else if (/^\s+$/.test(t) && k + 1 < ops.length && ops[k + 1][0] !== 0) { del += t; ins += t; }
      else break;
    }
    if (del) out.push([-1, del]);
    if (ins) out.push([1, ins]);
  }
  return out;
}

// The diff as escaped HTML: <del> and <ins> spans in kept text; at most maxChars characters of text, then "…".
function wordDiffHtml(ops, maxChars = WORD_DIFF_SHOW_CHARS) {
  let html = '';
  let left = maxChars;
  for (const [op, t] of ops) {
    if (left <= 0) break;
    const part = t.length > left ? t.slice(0, left) : t;
    left -= part.length;
    const esc = escapeHtml(part);
    html += op === -1 ? `<del>${esc}</del>` : op === 1 ? `<ins>${esc}</ins>` : esc;
  }
  const total = ops.reduce((n, [, t]) => n + t.length, 0);
  return total > maxChars ? html + '…' : html;
}
