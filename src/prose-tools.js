'use strict';
// Module prose-tools.js: the prose helpers around the write path and two tools.
// - The section note: the first write of a turn that puts a sentence of prose into a section (not a changed number, a
//   marker, a caption or a formatting batch) gets one note naming the section, its first sentence
//   and, for a classic section type, what that type does (sectionExpectation of src/doc-conventions.js). The beforeWrite
//   hook finds the section on the model before the write; the afterWrite hook (registry.js) adds the note once the write
//   succeeded, so a refused write does not use up the section's note. Once per section per turn (snap.sectionNoted); in
//   the model's turns only (a chat turn: snap.mainTurn, or an agent's).
// - The connectivity check: after a write that puts new paragraphs in (insert_after_line, replace_section, a
//   replace of 2+ paragraphs), one quiet request (no tools, about 400 tokens) asks whether the new text continues the
//   paragraph before it and leads into the one after it, each side cut at sentence boundaries (connectRequest); an
//   answer other than OK becomes a note. At most
//   CONNECT_MAX_PER_TURN per turn; only in a main chat turn (snap.mainTurn: not agents, the self-test, /side or the card
//   writes); on Munin and custom servers only for 2+ paragraphs.
// - trim_to_words: one quiet request cuts a span of lines to a target word count; the panel counts the words (countWords)
//   and asks once more with the real count when the answer is off by more than TRIM_TOLERANCE; the result is written as
//   one replace through the write path (the beforeWrite checks, the gate, the verified write, the undo journal).
// - phrase_usage: how many works in OpenAlex use an exact phrase in their title or abstract, with two examples (the
//   References grant, like the other OpenAlex lookups; at most PHRASE_MAX_PER_TURN calls per turn).
// - The criteria line of a vague improve request on a classic section (criteriaLine of src/doc-conventions.js) joins the
//   turn context through a beforeTurn hook.
/* global apiEditing, citationsInRanges, ckGetJson, commitEdit, countWords, criteriaLine, docInstructionsBlock, DOCUMENT_WRITING_RULES,
   endsSentence, errorClause, fmtNum, gateEdit, sectionHeadAt, lastSentText, OBJECT_CHAR, offersOpenDocument, onDemandOffer,
   onDemandProvider, oneLine, OPENALEX_URL, rangeLabel, rawError, registerTools, registerTurnHook, replacePlan, reviseAsk,
   sectionExpectation, sentenceSpans, setStatus, showText, textCheckParts, textExcerpt, UNTRUSTED_DATA_NOTE, withReferences, wordDiff */
/* exported SECTION_NOTE_TOOLS, sectionNoteBefore, sectionNoteAfter, CONNECT_HEAD, connectivityCheck, connectParas, TRIM_DEF,
   TRIM_HEAD, trimToWords, trimAnswerText, trimAsked, PHRASE_DEF, phraseUsage, phraseAsked, phraseUsageText */

// ---- The section note ----------------------------------------------------------------------------------------------
const SECTION_NOTE_TOOLS = ['replace_text', 'replace_all', 'replace_section', 'insert_after_line', 'edit_document', 'trim_to_words'];
const sectionKey = (h) => `${h.heading}\u0000${String(h.text).replace(/\s+/g, ' ').trim().toLowerCase()}`;
const SECTION_NOTE_MIN_WORDS = 8; // a changed number, a marker, a caption or a label has no register to continue
// Whether a write part brings a sentence of prose: a text with a sentence end, and words enough for a sentence among
// those it adds (a replace's words it keeps from the old text do not count).
function writesProse(p) {
  if (!sentenceSpans(p.newText).some((sp) => endsSentence(sp.text))) return false;
  const added = p.oldText.trim() ? wordDiff(p.oldText, p.newText).filter(([op]) => op > 0).map(([, t]) => t).join(' ') : p.newText;
  return countWords(added) >= SECTION_NOTE_MIN_WORDS;
}
// beforeWrite: the section of the write's first new prose on the model before the write (snap.sectionPending), unless it
// was noted in this turn. Never a note itself: the note waits for the write to succeed. trim_to_words writes as
// replace_text (its own name is pending from its run).
function sectionNoteBefore(name, plan, args, snap) {
  if (!snap || !snap.model || !SECTION_NOTE_TOOLS.includes(name) || !(snap.mainTurn || snap.agent)) return null;
  if (snap.sectionPending && snap.sectionPending.owner) return null; // trim_to_words set its own
  snap.sectionPending = null;
  let line = 0;
  try {
    const part = textCheckParts(name, plan, args, snap).find((p) => p.newText.trim() && writesProse(p));
    line = part ? part.line : 0;
  } catch (e) { line = 0; }
  const pending = sectionPendingAt(snap, line);
  if (pending) snap.sectionPending = { ...pending, name };
  return null;
}
// { key, text } of the section that holds line n, or null (no heading above, noted already, nothing worth saying).
function sectionPendingAt(snap, n) {
  const h = n >= 1 ? sectionHeadAt(snap.model, n) : null;
  if (!h) return null;
  const key = sectionKey(h);
  if (snap.sectionNoted && snap.sectionNoted.has(key)) return null;
  const text = sectionExpectation(snap.model, n);
  // Only a section with a sentence to go by: its register is what the note is for (a bare name or "empty so far" is not).
  if (!text || !text.includes(': continue its register;')) return null;
  return { key, text };
}
// afterWrite: the pending section's note on the successful write it was found for.
function sectionNoteAfter(name, args, result, snap) {
  const p = snap && snap.sectionPending;
  if (!p) return null;
  snap.sectionPending = null;
  if (p.name !== name) return null;
  (snap.sectionNoted || (snap.sectionNoted = new Set())).add(p.key);
  return { notes: [p.text] };
}
registerTurnHook('beforeWrite', sectionNoteBefore);
registerTurnHook('afterWrite', sectionNoteAfter);

// ---- Quiet requests -------------------------------------------------------------------------------------------------
// The standing instructions and the untrusted-data rule close every system text: the document text is data.
const ptTail = (snap) => [docInstructionsBlock(snap), UNTRUSTED_DATA_NOTE].filter(Boolean).join('\n\n');
const ptClean = (raw) => {
  let t = String(raw == null ? '' : raw).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(t);
  return fence ? fence[1].trim() : t;
};
const ptClip = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };

// ---- The connectivity check ------------------------------------------------------------------------------------------
const CONNECT_TOOLS = ['insert_after_line', 'replace_section', 'replace_text', 'edit_document'];
const CONNECT_MAX_PER_TURN = 2;
const CONNECT_PARA_CHARS = 400; // each side of a join: about 400 tokens in all
const CONNECT_ANSWER_CHARS = 220;
const CONNECT_HEAD = 'You check how new text joins a document. Does the first sentence of the new text continue the thought of the paragraph before it, and does its last sentence lead into the paragraph after it? Long paragraphs are excerpts: […] marks text left out, which is not a gap. Answer OK, or one sentence naming the gap.';
const CONNECT_MIN_WORDS = 8; // a caption or a label has no thought to continue
const connectBody = (l) => !!l && !l.heading && !l.cell && !String(l.text).includes(OBJECT_CHAR) && countWords(l.text) >= CONNECT_MIN_WORDS;
// The paragraphs around and inside the written lines [from, to] of the model after the write: { prev, paras, next };
// prev and next stop at a heading (a new section owes nothing to the one before it), and new text that starts with a
// heading has no paragraph before it.
function connectParas(model, from, to) {
  const lines = model.lines;
  const paras = lines.slice(from - 1, to).filter(connectBody);
  let prev = null;
  const startsSection = !!(lines[from - 1] && lines[from - 1].heading);
  for (let n = from - 1; n >= 1 && !startsSection; n--) { const l = lines[n - 1]; if (l.heading || l.cell) break; if (connectBody(l)) { prev = l; break; } }
  let next = null;
  for (let n = to + 1; n <= lines.length; n++) { const l = lines[n - 1]; if (l.heading || l.cell) break; if (connectBody(l)) { next = l; break; } }
  return { prev, paras, next };
}
// afterWrite: the connectivity note of a write, or null.
async function connectivityCheck(name, args, result, snap, mode) {
  if (!snap || !snap.mainTurn || mode !== 'edit' || !CONNECT_TOOLS.includes(name) || snap.agent || snap.quiet || snap.side || !snap.model || !snap.responseWrite) return null;
  if ((snap.connectAsked || 0) >= CONNECT_MAX_PER_TURN || (snap.signal && snap.signal.aborted)) return null;
  const { from, to } = snap.responseWrite;
  const { prev, paras, next } = connectParas(snap.model, from, to);
  // A new paragraph or section always counts; a replace only when it wrote 2+ paragraphs; Munin and custom servers (no
  // cache, a small window) skip single paragraphs.
  const insert = name === 'insert_after_line' || name === 'replace_section';
  const min = insert && !onDemandProvider(snap) ? 1 : 2;
  if (paras.length < min || (!prev && !next)) return null;
  snap.connectAsked = (snap.connectAsked || 0) + 1;
  const user = connectRequest(prev, paras, next);
  setStatus('Checking how the new text connects…');
  let answer;
  try { answer = await reviseAsk(snap, `${CONNECT_HEAD}\n\n${ptTail(snap)}`, user, { profile: 'summary', maxTokens: 1024 }); } catch (e) {
    if (!(e && e.name === 'AbortError')) console.warn('Munin: the connectivity check failed:', rawError(e));
    return null;
  }
  const t = ptClean(answer.content).replace(/\s+/g, ' ').trim();
  if (!t || /^ok\b/i.test(t.replace(/^["'«“*]+/, ''))) return null;
  return { notes: [`Connectivity: ${textExcerpt(t, CONNECT_ANSWER_CHARS)}`] };
}
// The judge's message: each side of a join cut at sentence boundaries (textExcerpt): the END of the paragraph before and
// the START of the one after, the new text's first sentences and its last ones (one new paragraph: both ends of it).
function connectRequest(prev, paras, next) {
  const first = paras[0];
  const last = paras[paras.length - 1];
  return [
    prev ? `Paragraph before:\n${textExcerpt(prev.text, CONNECT_PARA_CHARS, 'end')}` : 'Paragraph before: none (the section starts here).',
    last === first ? `New text:\n${textExcerpt(first.text, 2 * CONNECT_PARA_CHARS, 'both')}`
      : `New text, first paragraph:\n${textExcerpt(first.text, CONNECT_PARA_CHARS)}\n\nNew text, last paragraph:\n${textExcerpt(last.text, CONNECT_PARA_CHARS, 'end')}`,
    next ? `Paragraph after:\n${textExcerpt(next.text, CONNECT_PARA_CHARS)}` : 'Paragraph after: none (the section ends here).',
  ].join('\n\n');
}
registerTurnHook('afterWrite', connectivityCheck);

// ---- trim_to_words ----------------------------------------------------------------------------------------------------
const TRIM_TOLERANCE = 0.1; // the answer counts within ±10% of the target
const TRIM_MIN_WORDS = 5;
const TRIM_KEEP_CHARS = 300;
const TRIM_HEAD = 'You cut a passage of a document to a target length. Answer with the shortened passage only, as plain text in its language: no quotes, labels, comments or Markdown; separate paragraphs with one empty line and keep their order. Drop repetition, filler and minor detail first. Keep every number, unit, citation and name, and keep each claim exactly as strong as written.';
// Offered on demand on Munin and custom servers: the message asks to trim or shorten, or names a word count.
const TRIM_WORDS_RE = /\b(?:trim|shorten|shorter|condense|cut(?: it| this| them)?(?: down)? to|words?)\b|сократ|ужм|короче|\bдо \d+ слов|слов/iu;
const trimAsked = (t) => TRIM_WORDS_RE.test(String(t || ''));
const trimNorm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
// The passage of an answer: paragraphs joined with one newline (the document's paragraph breaks), or '' when empty.
function trimAnswerText(raw) {
  let t = ptClean(raw).replace(/^(?:shortened passage|shortened text|passage|text)\s*:\s*/i, '');
  if (/^["«“][\s\S]*["»”]$/.test(t)) t = t.slice(1, -1).trim();
  return t.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).join('\n');
}
async function trimToWords(args, snap, ui = {}, call = {}) {
  const model = snap.model;
  if (!model) return 'Error: trim_to_words needs the Google Docs API, which is not available for this message.';
  const a = Number(args.line_start);
  const b = Number(args.line_end);
  const target = Number(args.words);
  const n = model.lines.length;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > n) return `Error: line_start and line_end must be line numbers with line_start ≤ line_end; the document has ${n} lines.`;
  if (!Number.isInteger(target) || target < TRIM_MIN_WORDS) return `Error: words must be a whole number of at least ${TRIM_MIN_WORDS}.`;
  const lines = model.lines.slice(a - 1, b);
  const bad = lines.find((l) => l.heading || l.cell || l.suggested || l.exact === false || String(l.text).includes(OBJECT_CHAR) || String(l.text).includes('\u000b'));
  if (bad) {
    const what = bad.heading ? 'a heading' : bad.cell ? 'a table cell' : bad.suggested ? 'a suggested change' : 'an image, a break or another object';
    return `Error: line ${bad.line} is ${what}; trim_to_words rewrites body paragraphs only. Give a span without it.`;
  }
  const oldText = model.text.slice(lines[0].off, lines[lines.length - 1].off + lines[lines.length - 1].text.length);
  const before = countWords(oldText);
  const range = rangeLabel(a, b);
  if (before <= target * (1 + TRIM_TOLERANCE)) {
    return { content: `${range[0].toUpperCase()}${range.slice(1)} ${a === b ? 'has' : 'have'} ${before} word${before === 1 ? '' : 's'}, within 10% of ${target} or under it; nothing changed.`, _ok: true, _message: 'Nothing to trim' };
  }
  const keep = typeof args.keep === 'string' && args.keep.trim() ? args.keep.trim().slice(0, TRIM_KEEP_CHARS) : '';
  if (keep && !trimNorm(oldText).includes(trimNorm(keep))) return `Error: keep must be text from ${range}; «${oneLine(keep, 80)}» is not there.`;
  const where = sectionExpectation(model, a, { hint: false });
  const system = `${TRIM_HEAD}\n\n${DOCUMENT_WRITING_RULES}\n\n${ptTail(snap)}`;
  const paras = lines.filter((l) => String(l.text).trim()).map((l) => l.text);
  const base = [where, `Target: about ${target} words (the passage has ${before}).`, keep ? `Keep word for word: «${keep}»` : '',
    `Passage:\n${paras.join('\n\n')}`].filter(Boolean).join('\n');
  const got = [];
  let tokens = 0;
  let text = '';
  for (let k = 0; k < 2; k++) {
    if (snap.signal && snap.signal.aborted) return { content: 'Error: cancelled by the user.', _ok: false, _message: 'Cancelled by the user' };
    const user = k === 0 ? base : `${base}\n\nYou wrote ${got[0]} words; the target is ${target}.${keepLost(text, keep) ? ' You also dropped the text to keep.' : ''} Cut the passage again to about ${target} words.`;
    if (snap.onCallProgress) snap.onCallProgress(k === 0 ? 'Trimming…' : 'Trimming: a second try…');
    let answer;
    try { answer = await reviseAsk(snap, system, user); } catch (e) {
      if (e && e.name === 'AbortError') return { content: 'Error: cancelled by the user.', _ok: false, _message: 'Cancelled by the user' };
      return `Error: the trim request failed (${errorClause(e)}); the span was not changed.`;
    }
    tokens += answer.tokens;
    text = trimAnswerText(answer.content);
    const count = countWords(text);
    got.push(count);
    if (text && Math.abs(count - target) <= target * TRIM_TOLERANCE && !keepLost(text, keep)) return trimWrite(snap, ui, call, { a, b, range, oldText, text, before, count, target, tries: k + 1, tokens });
  }
  const lost = keepLost(text, keep) ? '; the text to keep was dropped' : '';
  return { content: `Error: could not reach ${target} words (got ${got[0]} then ${got[1]})${lost}; the span was not changed. Shorten it with replace_text instead.`, _ok: false, _message: `Trim: could not reach ${target} words` };
}
const keepLost = (text, keep) => !!keep && !trimNorm(text).includes(trimNorm(keep));
// The trimmed passage as one verified replace: the checks and the gate of replace_text (ui.args is the replace's while it
// runs), then commitEdit. The result names the real count.
async function trimWrite(snap, ui, call, t) {
  const first = snap.model.lines[t.a - 1];
  const p = replacePlan(snap.model, first.off, t.oldText, t.text);
  if (p.error) return `Error: ${p.error}; the span was not changed.`;
  const plan = { ...p, title: `Trimmed ${t.range}`, done: `trimmed ${t.range} from ${t.before} to ${t.count} words (target ${t.target})`, cardText: showText(t.text), cardLabel: 'New text' };
  if (plan.removed && plan.removed.length) {
    try { plan.citations = await citationsInRanges(snap.model, plan.removed); } catch (e) { plan.citations = []; }
  }
  const args = ui.args;
  ui.args = { old_text: t.oldText, new_text: t.text };
  // The section note is found for this write, under the tool's own name (the afterWrite hook sees trim_to_words).
  const pending = snap.mainTurn || snap.agent ? sectionPendingAt(snap, t.a) : null;
  snap.sectionPending = pending ? { ...pending, name: 'trim_to_words', owner: true } : null;
  let refused;
  try { refused = await gateEdit('replace_text', plan, snap, ui); } finally { ui.args = args; if (snap.sectionPending) delete snap.sectionPending.owner; }
  if (refused) {
    snap.sectionPending = null;
    return { ...refused, content: `${refused.content}${/\.$/.test(refused.content) ? '' : '.'} The span was not changed.` };
  }
  const res = await commitEdit(snap, plan, call.id || 'trim');
  if (!res._ok) { snap.sectionPending = null; return res; }
  const { _notSent, ...out } = res;
  return { ...out, _detail: `${t.tries} request${t.tries === 1 ? '' : 's'}, ${t.tokens.toLocaleString('en-US')} tokens` };
}
const TRIM_DEF = { type: 'function', function: {
  name: 'trim_to_words',
  description: 'Cut body lines line_start–line_end to about `words` words in one rewrite; the panel counts the words and retries once. Keeps numbers, citations and claim strength.',
  parameters: {
    type: 'object',
    properties: {
      line_start: { type: 'integer' },
      line_end: { type: 'integer' },
      words: { type: 'integer', description: 'The target word count.' },
      keep: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Short text that must stay word for word; null: none.' },
    },
    required: ['line_start', 'line_end', 'words', 'keep'],
    additionalProperties: false,
  },
} };
const trimRuns = (mode, snap) => !!snap && !snap.side && apiEditing(mode, snap);
registerTools([TRIM_DEF], {
  offer: (mode, snap) => trimRuns(mode, snap) && onDemandOffer(snap, trimAsked),
  runs: trimRuns,
  reading: false,
  usesLines: () => true,
  run: (name, args, snap, ui, call) => trimToWords(args, snap, ui, call),
  summary: (name, args) => (Number.isInteger(args.line_start) && Number.isInteger(args.words) ? `${rangeLabel(args.line_start, Number.isInteger(args.line_end) ? args.line_end : args.line_start)} to ${args.words} words` : ''),
  pending: 'Trimming…',
});

// ---- phrase_usage -------------------------------------------------------------------------------------------------------
const PHRASE_MAX_PER_TURN = 3;
const PHRASE_MIN_WORDS = 3;
const PHRASE_MAX_WORDS = 8;
const PHRASE_EXAMPLES = 2;
// Offered on demand on Munin and custom servers: the message asks whether wording is idiomatic or common.
const PHRASE_WORDS_RE = /\b(?:idiomatic\w*|phrases?|phrasing|usage|wording|natural(?:ly)?|is it common|commonly used)\b|употреб|фраз|так говорят|так пишут/iu;
const phraseAsked = (t) => PHRASE_WORDS_RE.test(String(t || ''));
// The phrase as OpenAlex's filter takes it: no quotes, commas, pipes or colons (the filter syntax), single spaces.
const phraseQuery = (p) => String(p).replace(/["“”«»,|:]+/g, ' ').replace(/\s+/g, ' ').trim();
// The tool's text from an OpenAlex works response.
function phraseUsageText(phrase, data) {
  const count = Number(data && data.meta && data.meta.count) || 0;
  if (!count) return 'No works found with that exact phrase.';
  const ex = ((data && data.results) || []).filter((w) => w && w.display_name).slice(0, PHRASE_EXAMPLES)
    .map((w) => `"${ptClip(w.display_name, 120)}"${w.publication_year ? ` (${w.publication_year})` : ''}`);
  return `About ${fmtNum(count)} work${count === 1 ? '' : 's'} use “${phrase}” in the title or abstract${ex.length ? `; e.g. ${ex.join(', ')}` : ''}.`;
}
async function phraseUsage(args, snap) {
  const phrase = phraseQuery(typeof args.phrase === 'string' ? args.phrase : '');
  const n = countWords(phrase);
  if (n < PHRASE_MIN_WORDS || n > PHRASE_MAX_WORDS) return `Error: phrase must have ${PHRASE_MIN_WORDS} to ${PHRASE_MAX_WORDS} words (it has ${n}).`;
  const url = `${OPENALEX_URL}/works?filter=title_and_abstract.search:${encodeURIComponent(`"${phrase}"`)}&per-page=3&select=id,display_name,publication_year`;
  try {
    const data = await ckGetJson(url, snap.signal || null);
    return { content: phraseUsageText(phrase, data), _ok: true };
  } catch (e) {
    if (e && e.name === 'AbortError') return { content: 'Error: cancelled by the user.', _ok: false, _message: 'Cancelled by the user' };
    return { content: `Error: the OpenAlex lookup failed (${errorClause(e)}). Judge the phrase without it.`, _ok: false, _message: 'OpenAlex lookup failed' };
  }
}
const PHRASE_DEF = { type: 'function', function: {
  name: 'phrase_usage',
  description: 'How many published works (OpenAlex titles and abstracts) use an exact phrase, with two examples: is the wording idiomatic? At most 3 calls per message.',
  parameters: {
    type: 'object',
    properties: { phrase: { type: 'string', description: '3 to 8 words.' } },
    required: ['phrase'],
    additionalProperties: false,
  },
} };
const phraseRuns = (mode, snap) => !!snap && (mode === 'edit' || mode === 'manual' || mode === 'plan') && offersOpenDocument(mode, snap);
registerTools([PHRASE_DEF], {
  offer: (mode, snap) => phraseRuns(mode, snap) && onDemandOffer(snap, phraseAsked),
  runs: phraseRuns,
  reading: true,
  summary: (name, args) => (typeof args.phrase === 'string' ? `"${oneLine(args.phrase, 60)}"` : ''),
  run: (name, args, snap, ui) => {
    snap.phraseCalls = (snap.phraseCalls || 0) + 1;
    if (snap.phraseCalls > PHRASE_MAX_PER_TURN) return `Error: at most ${PHRASE_MAX_PER_TURN} phrase_usage calls per message; decide with what you have.`;
    return withReferences(snap, ui, 'To look up how often a phrase is used in published work.', () => phraseUsage(args, snap), ['OpenAlex']);
  },
});

// ---- The criteria line ------------------------------------------------------------------------------------------------
// A vague improve request on a classic section (an editing turn, Plan or a read-only chat turn other than /side; not a
// document pass): one context line.
registerTurnHook('beforeTurn', (mode, snap) => (snap && !snap.side && (mode === 'edit' || mode === 'manual' || mode === 'plan') ? criteriaLine(snap, lastSentText()) : ''));
