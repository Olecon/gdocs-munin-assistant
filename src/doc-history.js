'use strict';
// Module doc-history.js: what changed in the main document since the previous session (the tool
// document_changes), from a local text baseline per document. The Docs API revisionId is opaque and valid for
// 24 hours only, and Drive revisions need a restricted scope and may be incomplete, so the panel stores the
// document text itself (chrome.storage.local, DOC_TEXT_PREFIX + docId):
//   { previous: entry | null, latest: entry }   entry = { text, at, format, tab, chars, lines, hash, session }
// latest: the text at the end of the newest turn (turn hook 'finish'); previous: the latest of an earlier panel
// session, promoted when a panel first loads the document's chats (turn hook 'panelDoc'), once per panel.
// A text over DOC_HISTORY_MAX_CHARS is stored without its text (tooLarge: sizes only).
// The diff is by line, and a changed line pair is shown by sentence (sentenceChanges: splitSentences of
// text-segments.js), so a one-word fix in a long paragraph costs one short entry.
/* global DOC_TEXT_PREFIX, fmtNum, readLimits, registerTools, registerTurnHook, showText, splitSentences, state, textLang, withLock */
/* exported lineDiff, diffBlocks, sentenceChanges, renderDocChanges, docChangesResult, docHistoryNote, saveDocText, startDocHistory,
   latestDocEntry, DOC_HISTORY_SESSION */

const DOC_HISTORY_MAX_CHARS = 2000000; // a larger text is not stored (sizes only)
const DOC_DIFF_MAX_EDITS = 1000; // Myers edit steps; more: one coarse block (see lineDiff)
const DOC_DIFF_LINE_CLIP = 300; // characters of a shown line
const DOC_DIFF_CONTEXT = 60; // characters kept around the changed part of a long changed line

// This panel's session id: the latest text it wrote is never promoted to previous by the same panel.
const DOC_HISTORY_SESSION = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const docHistoryLoads = new Map(); // docId -> Promise<previous entry | null>, started once per panel
const docHistoryPrevious = new Map(); // docId -> previous entry | null, once loaded (docNote and summary are sync)

const docTextKey = (docId) => DOC_TEXT_PREFIX + docId;

// FNV-1a over the UTF-16 code units: lets the per-turn note tell a same-length edit without a diff.
function textHash(t) {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

// The baseline entry of a snapshot's main document (null without a text).
function docTextEntry(snap, at = Date.now()) {
  if (!snap || snap.docText == null) return null;
  const text = String(snap.docText);
  const e = {
    at, session: DOC_HISTORY_SESSION, format: snap.docFormat || 'text',
    tab: snap.docFormat === 'docs-api' && snap.model ? String(snap.model.tabId || '') : '',
    chars: text.length, lines: text.split('\n').length, hash: textHash(text),
  };
  if (text.length > DOC_HISTORY_MAX_CHARS) e.tooLarge = true;
  else e.text = text;
  return e;
}

// 'finish' hook: the document text at the end of the turn (after its edits) becomes latest. When latest already
// holds this text from this panel, nothing is written (the record can be 2 MB, and most turns change nothing). Its
// at then stays the end of the first turn that saw the text; document_changes shows it as the time of the previous
// session's text, and the text was the same from then to the session's last turn, so the diff and its time hold.
async function saveDocText(snap) {
  const docId = snap && snap.docId;
  const entry = docTextEntry(snap);
  if (!docId || !entry) return;
  await startDocHistory(docId); // a promotion still running must not overwrite this turn's text
  await withLock('munin:doctext:' + docId, async () => {
    const rec = (await chrome.storage.local.get(docTextKey(docId)))[docTextKey(docId)];
    if (rec && sameDocText(rec.latest, entry)) return;
    const previous = rec && rec.previous ? rec.previous : null;
    await chrome.storage.local.set({ [docTextKey(docId)]: { previous, latest: entry } });
  });
}
// The stored entry a holds the text of entry b and was written by this panel (an entry of another session is still
// replaced: latest is this panel's own after its turns). A text too large to store compares by its hash.
const sameDocText = (a, b) => !!a && a.session === b.session && a.format === b.format && a.tab === b.tab && a.chars === b.chars
  && a.hash === b.hash && !!a.tooLarge === !!b.tooLarge && (b.tooLarge || a.text === b.text);

// The latest stored entry of a document ({ text, at, session, … }) or null. own-changes.js asks it whether another
// panel of the document finished a turn after this panel's last one (entry.session is then not DOC_HISTORY_SESSION).
async function latestDocEntry(docId) {
  if (!docId) return null;
  try {
    const rec = (await chrome.storage.local.get(docTextKey(docId)))[docTextKey(docId)];
    return (rec && rec.latest) || null;
  } catch (e) { return null; }
}

// 'panelDoc' hook: the first time this panel loads the document, the latest text of an earlier session becomes
// previous (the baseline of document_changes). Reloading the chat list later in the same panel does nothing.
function startDocHistory(docId) {
  if (!docId) return Promise.resolve(null);
  if (docHistoryLoads.has(docId)) return docHistoryLoads.get(docId);
  const p = withLock('munin:doctext:' + docId, async () => {
    const key = docTextKey(docId);
    const rec = (await chrome.storage.local.get(key))[key];
    let previous = rec && rec.previous ? rec.previous : null;
    if (rec && rec.latest && rec.latest.session !== DOC_HISTORY_SESSION) {
      previous = rec.latest;
      await chrome.storage.local.set({ [key]: { previous, latest: rec.latest } });
    }
    return previous;
  }).catch(() => null).then((previous) => { docHistoryPrevious.set(docId, previous); return previous; });
  docHistoryLoads.set(docId, p);
  return p;
}

// ---- Line diff -------------------------------------------------------------------------------------
// lineDiff(a, b) -> { ops: [{ t: '=' | '-' | '+', o (old line, 1-based; '=' and '-'), n (new line; '=' and '+') }],
// coarse }. Common leading and trailing lines are matched first; the rest goes through Myers' O(ND) diff. When
// that needs more than DOC_DIFF_MAX_EDITS removed plus added lines, the region between the first and the last
// difference is given as one block (all of it removed, then all of it added) and coarse is true.
function lineDiff(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ t: '=', o: i + 1, n: i + 1 });
  // Lines as integers (equal text, equal id), so the inner loop compares numbers.
  const ids = new Map();
  const idOf = (s) => { let v = ids.get(s); if (v === undefined) { v = ids.size; ids.set(s, v); } return v; };
  const ma = Int32Array.from(a.slice(pre, a.length - suf), idOf);
  const mb = Int32Array.from(b.slice(pre, b.length - suf), idOf);
  let mid = myers(ma, mb, DOC_DIFF_MAX_EDITS);
  const coarse = !mid;
  if (!mid) {
    mid = [];
    for (let i = 0; i < ma.length; i++) mid.push(['-', i, -1]);
    for (let j = 0; j < mb.length; j++) mid.push(['+', -1, j]);
  }
  for (const [t, i, j] of mid) ops.push({ t, o: t === '+' ? undefined : pre + i + 1, n: t === '-' ? undefined : pre + j + 1 });
  for (let i = 0; i < suf; i++) ops.push({ t: '=', o: a.length - suf + i + 1, n: b.length - suf + i + 1 });
  return { ops, coarse };
}

// Myers' greedy diff of two integer arrays: [['=' | '-' | '+', i, j]] (0-based; -1 where it does not apply), or
// null when it needs more than maxD edits. The trace keeps V for every step: O(D²) memory, so D is capped.
function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD) && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) return null;
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d - 1];
    const at = (k) => pv[k + d - 1];
    const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > px && y > py) { x--; y--; ops.push(['=', x, y]); }
    if (x === px) { y--; ops.push(['+', -1, y]); } else { x--; ops.push(['-', x, -1]); }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push(['=', x, y]); }
  return ops.reverse();
}

// ---- Rendering -------------------------------------------------------------------------------------------
const clipLine = (t) => (t.length > DOC_DIFF_LINE_CLIP ? t.slice(0, DOC_DIFF_LINE_CLIP) + `… (${fmtNum(t.length)} characters)` : t);
// A long changed line: only its changed part with some context, so a one-word edit in a long paragraph stays short.
function clipPair(oldT, newT) {
  if (oldT.length <= DOC_DIFF_LINE_CLIP && newT.length <= DOC_DIFF_LINE_CLIP) return [oldT, newT];
  let p = 0;
  while (p < oldT.length && p < newT.length && oldT[p] === newT[p]) p++;
  let s = 0;
  while (s < oldT.length - p && s < newT.length - p && oldT[oldT.length - 1 - s] === newT[newT.length - 1 - s]) s++;
  const from = Math.max(0, p - DOC_DIFF_CONTEXT);
  const cut = (t) => {
    const to = Math.min(t.length, t.length - s + DOC_DIFF_CONTEXT);
    return clipLine((from > 0 ? '…' : '') + t.slice(from, to) + (to < t.length ? '…' : ''));
  };
  return [cut(oldT), cut(newT)];
}

// Blocks of consecutive changes: { dels: [{o, text}], adds: [{n, text}], pos (the current line where the block
// sits: its first added line, or the line after a removal), end, eqBefore (unchanged lines since the last block) }.
function diffBlocks(ops, oldLines, newLines) {
  const blocks = [];
  let cur = null;
  let next = 1; // the current line after the last op
  for (const op of ops) {
    if (op.t === '=') { cur = null; next = op.n + 1; continue; }
    if (!cur) { cur = { dels: [], adds: [], pos: next, end: next - 1 }; blocks.push(cur); }
    if (op.t === '-') cur.dels.push({ o: op.o, text: oldLines[op.o - 1] });
    else {
      if (!cur.adds.length) cur.pos = op.n;
      cur.adds.push({ n: op.n, text: newLines[op.n - 1] });
      cur.end = op.n;
      next = op.n + 1;
    }
  }
  for (const b of blocks) if (!b.adds.length) b.end = b.pos;
  return blocks;
}

// ---- Sentences of a changed line ---------------------------------------------------------------------------
// sentenceChanges(oldLine, newLine) -> [{ t: 'pair' | 'removed' | 'added' | 'moved', old?, new? }] (the changed
// sentences only, in the order of the new line; a removed sentence where it was), or null when the lines are better
// shown whole: neither has two sentences, no sentence is unchanged, or only the spacing between sentences changed.
// A sentence removed in one place and added in another is one 'moved' entry. Both lines are split with the same
// language (abbreviation-aware: "Dr. Smith", "рис. 3", "т. е." do not split).
function sentenceChanges(oldLine, newLine) {
  if (typeof splitSentences !== 'function') return null;
  const lang = textLang(`${oldLine} ${newLine}`);
  const a = splitSentences(oldLine, lang);
  const b = splitSentences(newLine, lang);
  if (a.length < 2 && b.length < 2) return null;
  const { ops, coarse } = lineDiff(a, b);
  if (coarse || !ops.some((o) => o.t === '=')) return null;
  const blocks = diffBlocks(ops, a, b);
  const count = (list) => list.reduce((m, x) => m.set(x.text, (m.get(x.text) || 0) + 1), new Map());
  const dels = count(blocks.flatMap((x) => x.dels));
  const adds = count(blocks.flatMap((x) => x.adds));
  const moved = new Map([...adds].filter(([t]) => dels.has(t)).map(([t, n]) => [t, Math.min(n, dels.get(t))]));
  const movedDels = new Map(moved);
  const take = (m, t) => { const n = m.get(t) || 0; if (n) m.set(t, n - 1); return n > 0; };
  const out = [];
  for (const x of blocks) {
    const ds = x.dels.filter((d) => !take(movedDels, d.text)).map((d) => d.text);
    const as = [];
    for (const d of x.adds) {
      if (take(moved, d.text)) out.push({ t: 'moved', new: d.text });
      else as.push(d.text);
    }
    const p = Math.min(ds.length, as.length);
    for (let i = 0; i < p; i++) out.push({ t: 'pair', old: ds[i], new: as[i] });
    for (const t of ds.slice(p)) out.push({ t: 'removed', old: t });
    for (const t of as.slice(p)) out.push({ t: 'added', new: t });
  }
  return out.length ? out : null;
}

// The entries of a changed line pair shown by sentence: "~ 12: «old» → «new»", "~ 12: removed «…»", "~ 12: added
// «…»", "~ 12: moved «…»" ("~ 12 (was 10)" when the line moved). null: show the pair whole.
function sentenceText(del, add, show) {
  const ch = sentenceChanges(del.text, add.text);
  if (!ch) return null;
  const at = `~ ${add.n}${del.o !== add.n ? ` (was ${del.o})` : ''}:`;
  return ch.map((c) => {
    if (c.t === 'pair') { const [o, n] = clipPair(show(c.old), show(c.new)); return `${at} «${o}» → «${n}»`; }
    return `${at} ${c.t} «${clipLine(show(c.t === 'removed' ? c.old : c.new))}»`;
  });
}

// The diff text lines of a block: changed lines as pairs ("- was 12: old" / "+ 12: new", or by sentence), then the rest.
function blockText(b, show) {
  const out = [];
  const pairs = Math.min(b.dels.length, b.adds.length);
  for (let i = 0; i < pairs; i++) {
    const bySentence = sentenceText(b.dels[i], b.adds[i], show);
    if (bySentence) { out.push(...bySentence); continue; }
    const [o, n] = clipPair(show(b.dels[i].text), show(b.adds[i].text));
    out.push(`- was ${b.dels[i].o}: ${o}`, `+ ${b.adds[i].n}: ${n}`);
  }
  for (const d of b.dels.slice(pairs)) out.push(`- was ${d.o}: ${clipLine(show(d.text))}`);
  for (const a of b.adds.slice(pairs)) out.push(`+ ${a.n}: ${clipLine(show(a.text))}`);
  return out;
}

const unchangedLine = (n) => `… ${fmtNum(n)} unchanged line${n === 1 ? '' : 's'} …`;
const plural = (n, w) => `${fmtNum(n)} ${w}${n === 1 ? '' : 's'}`;

// "2026-10-22 18:40" (local time).
function fmtStamp(at) {
  const d = new Date(at);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// "lines" argument: "120-180", "120–180", "120" -> { start, end } | null (whole document) | { error }.
function parseLineRange(v) {
  if (v == null || String(v).trim() === '' || String(v).trim() === 'null') return null;
  const m = /^\s*(\d+)\s*(?:[-–—]|\.\.)?\s*(\d+)?\s*$/.exec(String(v));
  if (!m) return { error: `Error: lines must be a range of current line numbers like "120-180" (got "${String(v).slice(0, 40)}").` };
  const start = Math.max(1, Number(m[1]));
  const end = m[2] ? Number(m[2]) : start;
  if (end < start) return { error: `Error: the range "${v}" ends before it starts.` };
  return { start, end };
}

// The result of document_changes for a stored previous entry and the current text. opts: { format, tab, range,
// limits: {lines, chars}, api (Docs API text: soft breaks shown as a mark) }.
function renderDocChanges(prev, text, opts = {}) {
  const limits = opts.limits || { lines: 300, chars: 24000 };
  const when = fmtStamp(prev.at);
  const cur = String(text);
  const newLines = cur.split('\n');
  const sizes = `${fmtNum(prev.chars)} → ${fmtNum(cur.length)} characters, ${fmtNum(prev.lines)} → ${fmtNum(newLines.length)} lines`;
  if (prev.tooLarge || prev.text == null) {
    return `The document was too large to store at the end of the previous session (${when}), so only sizes are compared: ${sizes}.`;
  }
  const format = opts.format || 'text';
  if (prev.format !== format) {
    const how = (f) => (f === 'docs-api' ? 'the Google Docs API' : 'the export');
    if (how(prev.format) !== how(format)) {
      return `The previous session (${when}) read the document through ${how(prev.format)} and this one through ${how(format)}; the texts differ in form, so only sizes are compared: ${sizes}.`;
    }
  }
  if ((prev.tab || '') !== (opts.tab || '')) {
    return `The previous session (${when}) read another tab of this document; only sizes are compared: ${sizes}.`;
  }
  if (prev.text === cur) return `No changes since the previous session (${when}).`;
  const oldLines = prev.text.split('\n');
  const { ops, coarse } = lineDiff(oldLines, newLines);
  const blocks = diffBlocks(ops, oldLines, newLines);
  let changed = 0;
  let removed = 0;
  let added = 0;
  for (const b of blocks) {
    const p = Math.min(b.dels.length, b.adds.length);
    changed += p; removed += b.dels.length - p; added += b.adds.length - p;
  }
  const counts = [added && `${plural(added, 'line')} added`, removed && `${plural(removed, 'line')} removed`, changed && `${plural(changed, 'line')} changed`].filter(Boolean).join(', ');
  const range = opts.range || null;
  const lo = range ? range.start : 1;
  const hi = range ? Math.min(range.end, newLines.length) : newLines.length;
  const head = `Changes since ${when} (end of the previous session): ${counts || 'only line breaks'}; now ${plural(newLines.length, 'line')} (was ${fmtNum(oldLines.length)}).` +
    (coarse ? ' Too many differences for a line-by-line comparison: everything between the first and the last difference is shown as one block.' : '') +
    (range ? ` Showing lines ${lo}-${hi}.` : '');
  const legend = (lines) => ` ("- was N": old line N; "+ N": current line N${lines.some((l) => l.startsWith('~ ')) ? '; "~ N": the changed sentences of line N, «old» → «new»' : ''}.)`;
  const show = opts.api && typeof showText === 'function' ? showText : (t) => t;
  const inRange = (b) => b.end >= lo && b.pos <= hi;
  const out = [];
  let chars = 0;
  let diffLines = 0;
  let last = lo - 1; // the current line up to which unchanged lines were accounted for
  let stopAt = 0;
  for (const b of blocks) {
    if (!inRange(b)) continue;
    const body = blockText(b, show);
    const size = body.reduce((s, l) => s + l.length + 1, 0);
    const over = diffLines + body.length > limits.lines || chars + size > limits.chars;
    if (over && diffLines) { stopAt = b.pos; break; }
    const gap = Math.max(0, b.pos - 1 - last);
    if (gap > 0) out.push(unchangedLine(gap));
    if (over) {
      // the first block shown is over the limit by itself: cut inside it
      let c = 0;
      let k = 0;
      while (k < body.length && (!k || (k < limits.lines && c + body[k].length <= limits.chars))) { c += body[k].length + 1; k++; }
      out.push(...body.slice(0, k));
      const after = b.end + 1;
      out.push(`[Stopped inside the change at current lines ${b.pos}-${b.end} (limit per call). Read the current text with read_lines(${b.pos}, ${b.end})${after <= hi ? `, then call document_changes with lines "${after}-${hi}"` : ''}.]`);
      return `${head}${legend(out)}\n${out.join('\n')}`;
    }
    out.push(...body);
    chars += size; diffLines += body.length;
    last = Math.max(last, b.adds.length ? b.end : b.pos - 1);
  }
  if (stopAt) {
    out.push(`[Stopped at current line ${stopAt} (limit per call). Call document_changes with lines "${stopAt}-${hi}" to continue.]`);
  } else if (hi > last) {
    out.push(unchangedLine(hi - last));
  }
  if (!out.some((l) => /^[-+~] /.test(l))) return `${head}${legend(out)}\nNo changes in lines ${lo}-${hi}.`;
  return `${head}${legend(out)}\n${out.join('\n')}`;
}

const NO_BASELINE_TEXT = 'No earlier session is stored for this document yet; changes are tracked from now on.';

// The tool: the main document of the turn snapshot (with this turn's edits) against the stored previous text.
async function docChangesResult(args, snap) {
  if (snap.docText == null) return `Error: the document text is unavailable (${snap.docError || 'export failed'}).`;
  const range = parseLineRange(args && args.lines);
  if (range && range.error) return range.error;
  const prev = await startDocHistory(snap.docId);
  if (!prev) return { content: NO_BASELINE_TEXT, _ok: true, _message: 'no earlier session stored' };
  const total = String(snap.docText).split('\n').length;
  if (range && range.start > total) return `Error: the document has only ${total} lines.`;
  const content = renderDocChanges(prev, snap.docText, {
    format: snap.docFormat, tab: snap.docFormat === 'docs-api' && snap.model ? String(snap.model.tabId || '') : '',
    range, limits: readLimits(snap.prov), api: snap.docFormat === 'docs-api',
  });
  return { content, _ok: true, _message: docChangesSummary(args, prev) };
}

function docChangesSummary(args, prev) {
  const p = prev !== undefined ? prev : docHistoryPrevious.get(state.docId);
  const range = parseLineRange(args && args.lines);
  return (p ? `changes since ${fmtStamp(p.at)}` : 'changes since the previous session') + (range && !range.error ? ` (lines ${range.start}–${range.end})` : '');
}

// The line after the <document> block: only when the previous text is loaded and differs from the text at the
// start of this turn (length first, then the stored hash: no diff per turn).
function docHistoryNote(snap) {
  const prev = snap && snap.docId ? docHistoryPrevious.get(snap.docId) : null;
  if (!prev || snap.docText == null) return '';
  const text = String(snap.docText);
  if (prev.chars === text.length && prev.hash === textHash(text)) return '';
  return 'The document changed since the previous session; document_changes shows the diff.';
}

const DOC_CHANGES_DEF = { type: 'function', function: {
  name: 'document_changes',
  description: 'What changed in the main document since the end of the previous session with this panel: a line diff (removed lines with their old numbers, added lines with their current numbers, changed sentences of a changed line, unchanged runs collapsed). Use it when the user asks what changed or what collaborators did.',
  parameters: {
    type: 'object',
    properties: {
      lines: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'A range of current line numbers like "120-180" to show only the changes there, or null for the whole document.' },
    },
    required: ['lines'],
    additionalProperties: false,
  },
} };

registerTools([DOC_CHANGES_DEF], {
  // Only once an earlier session's text is loaded for this document: without one the tool has nothing to say,
  // and Munin's prompt stays lean. The baseline of a document does not change while the panel shows it, so the
  // offer is the same in every round of a turn (the load starts with the chat list, long before a send).
  offer: (mode, snap) => !!(snap && snap.docId && docHistoryPrevious.get(snap.docId)),
  reading: true,
  run: (name, args, snap) => docChangesResult(args, snap),
  summary: (name, args) => docChangesSummary(args),
  icon: '🕓',
  prompt: [{ section: 'reading', line: '- document_changes(lines): what changed in the document since the end of your previous session (removed/added lines). Use it when the user asks what changed or what collaborators did.' }],
  docNote: docHistoryNote,
});
registerTurnHook('finish', (userMsg, snap) => saveDocText(snap));
registerTurnHook('panelDoc', (docId) => startDocHistory(docId));
