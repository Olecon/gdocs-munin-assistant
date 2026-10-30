'use strict';
// Module own-changes.js: what the user changed in the document since this panel's previous turn (no model call), as
// a beforeTurn line: the text at the end of the previous turn (with the model's own edits, so only the user's changes
// remain) against the text of this turn's snapshot, by line, with each side clipped around the change. Above
// OWN_CHANGES_MAX_RANGES ranges or about 400 tokens only the count of changed lines is given. A changed line with
// several sentences is shown by its changed sentences only (sentenceChanges of doc-history.js).
// The baseline is kept in memory at 'finish' (the document-history record is written asynchronously, and a queued
// message may start before it lands); the stored record (doc-history.js) tells whether another panel of the document
// finished a turn since, whose edits would otherwise look like the user's. A turn that pasted leaves no baseline: the
// paste cannot be read back in that turn, so its text would be reported as the user's.
/* global DOC_HISTORY_SESSION, diffBlocks, fmtNum, latestDocEntry, lineDiff, registerTurnHook, sentenceChanges */
/* exported OWN_CHANGES_MAX_RANGES, ownChangesLine */

const OWN_CHANGES_MAX_RANGES = 5;
const OWN_CHANGES_MAX_CHARS = 1600; // about 400 tokens
const OWN_CHANGES_SIDE_CHARS = 120; // per side of a change
const OWN_CHANGES_CONTEXT = 30; // characters kept before and after the changed part of a long line
const ownBaselines = new Map(); // docId -> { text, format, tab, at, stale }

const ownTab = (snap) => (snap.docFormat === 'docs-api' && snap.model ? String(snap.model.tabId || '') : '');
const ownFlat = (lines) => lines.map((l) => String(l.text).split('\u000b').join(' ')).join(' / ');
const ownLines = (a, b) => (a === b ? `line ${a}` : `lines ${a}–${b}`);

function ownClip(t) {
  return t.length > OWN_CHANGES_SIDE_CHARS ? t.slice(0, OWN_CHANGES_SIDE_CHARS - 1) + '…' : t;
}
// Both sides of a change, cut to the changed middle with some context when either is long.
function ownClipPair(a, b) {
  if (a.length <= OWN_CHANGES_SIDE_CHARS && b.length <= OWN_CHANGES_SIDE_CHARS) return [a, b];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const from = Math.max(0, p - OWN_CHANGES_CONTEXT);
  const cut = (t) => {
    const to = Math.min(t.length, t.length - s + OWN_CHANGES_CONTEXT);
    return ownClip((from > 0 ? '…' : '') + t.slice(from, to) + (to < t.length ? '…' : ''));
  };
  return [cut(a), cut(b)];
}

// One changed line by its changed sentences: ["changed line 12: «old» → «new»", "deleted from line 12: «…»", …] or null.
function ownSentenceParts(b) {
  const flat = (t) => String(t).split('\u000b').join(' ');
  const ch = sentenceChanges(flat(b.dels[0].text), flat(b.adds[0].text));
  if (!ch) return null;
  const at = `line ${b.pos}`;
  return ch.map((c) => {
    if (c.t === 'pair') { const [o, n] = ownClipPair(c.old, c.new); return `changed ${at}: «${o}» → «${n}»`; }
    if (c.t === 'removed') return `deleted from ${at}: «${ownClip(c.old)}»`;
    return `${c.t === 'moved' ? 'moved within' : 'added to'} ${at}: «${ownClip(c.new)}»`;
  });
}

// The turn-context line for the text at the end of the previous turn (before) and now (after); '' when equal.
function ownChangesLine(before, after) {
  if (before === after) return '';
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const { ops, coarse } = lineDiff(oldLines, newLines);
  const blocks = diffBlocks(ops, oldLines, newLines);
  if (!blocks.length) return '';
  const changed = blocks.reduce((n, b) => n + Math.max(b.dels.length, b.adds.length), 0);
  const tooMany = `You changed about ${fmtNum(changed)} line${changed === 1 ? '' : 's'} since your last message (too many to list).`;
  if (coarse || blocks.length > OWN_CHANGES_MAX_RANGES) return tooMany;
  const parts = blocks.flatMap((b) => {
    const bySentence = b.dels.length === 1 && b.adds.length === 1 ? ownSentenceParts(b) : null;
    if (bySentence) return bySentence;
    if (b.dels.length && b.adds.length) {
      const [o, n] = ownClipPair(ownFlat(b.dels), ownFlat(b.adds));
      return `changed ${ownLines(b.pos, b.end)}: «${o}» → «${n}»`;
    }
    if (b.adds.length) return `added ${ownLines(b.pos, b.end)}: «${ownClip(ownFlat(b.adds))}»`;
    return `deleted at line ${b.pos}: «${ownClip(ownFlat(b.dels))}»`;
  });
  const line = `Since your last message you ${parts.join('; ')}.`;
  return line.length > OWN_CHANGES_MAX_CHARS ? tooMany : line;
}

registerTurnHook('beforeTurn', async (mode, snap) => {
  if (!snap || !snap.docId || snap.docText == null) return '';
  const base = ownBaselines.get(snap.docId);
  if (!base || base.stale || base.format !== snap.docFormat || base.tab !== ownTab(snap)) return '';
  const latest = await latestDocEntry(snap.docId);
  if (latest && latest.session !== DOC_HISTORY_SESSION && latest.at > base.at) return ''; // another panel's turn since
  return ownChangesLine(base.text, String(snap.docText));
});
registerTurnHook('finish', (userMsg, snap) => {
  if (!snap || !snap.docId) return;
  if (snap.docText == null) { ownBaselines.delete(snap.docId); return; }
  ownBaselines.set(snap.docId, { text: String(snap.docText), format: snap.docFormat, tab: ownTab(snap), at: Date.now(), stale: !!snap.pasteDone });
});
