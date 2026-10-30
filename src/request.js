'use strict';
// Module request.js: provider-neutral request building: mode predicates, toolsFor, the turn snapshot
// (takeSnapshot), the document outline and selection blocks, the static system prompt (buildSystemParts),
// the per-turn context of the user message (buildTurnContext, docFacts, docChangesNote, userContent), the
// context budget (fitMessages) and the provider dispatch (buildRequest; the Munin request is built here).
/* global activeConfig, activeProvider, apiEditRules, buildAnthropicRequest, buildOpenAiRequest, CHARS_PER_TOKEN,
   chatDocs, CONTEXT_SHORT_SELECTION_CHARS, DOC_CHANGES_MAX_HEADINGS, DOC_INSTRUCTIONS_MAX, DOC_INSTRUCTIONS_NOTE,
   EDIT_SAFETY_TOKENS, el, escapeHtml, EXTRA_TOOLS, extraPromptLines, extraToolDefs, fmtNum, FORMAT_READING_TOOL,
   isExtraReading, isMainDocRef, lineDecoratorNotes, MIN_BUDGET_TOKENS, parseToolArgs,
   OBJECT_CHAR, OUTLINE_MAX_ITEMS, PERSONA_DOC_CHAR_LIMIT, PERSONA_OVERHEAD_TOKENS,
   PERSONA_SAFETY_TOKENS, personaInstructions, PERSONAS, PROMPT_SELECTION_MAX, QUIET_TOOLS, RAW_REPLAY_KEYS, READ_MAX_CHARS,
   READ_MAX_LINES, READING_TOOLS, REMEMBER_NOTE, REPLACE_TOOL, SELECTION_EXCERPT_CHARS, SELECTION_INLINE_MAX, showText,
   SOFT_BREAK_MARK, state, STUB_MIN_CHARS, STYLE_MIN_WORDS, STYLE_SAMPLE_CHARS, TOOL_DEFS, TOOLS_EDIT_RULES, TOOLS_MANUAL_RULES, TOOLS_PLAN_RULES, TOOLS_PERSONA_NOTE,
   TURN_RESULTS_KEPT, UNTRUSTED_DATA_NOTE, WEB_SEARCH_PROVIDERS, WRITE_TOOLS, MUNIN_REASONING_EFFORT,
   offered, countWords, endsSentence, splitSentences, DOC_PASS_HEADS, DOC_PASS_INLINE_SHARE, DOC_PASS_MODES, DOC_PASS_READ_NOTE,
   DOC_PASS_TASKS, runReadingTool */
/* exported canEdit, offersRemember, apiEditing, isMuninPersona, isDocPass, docPassInline, webSearchTurn, offersOpenDocument,
   toolsFor, toOpenAiTool, toAnthropicTool, isReadingTool, offersWriteTools, takeSnapshot, snapshotDocument,
   docLines, hasOutline, docOutline, formatOutline, locateSelection, buildSystemParts, joinSystem,
   readLimits, cachesPrompt, buildTurnContext, docFacts, userContent, shortContext, docStyleStats, styleLine, samplingFields,
   personaMessages,
   toolNamesById, readingStub, previousUserIndex, docFitsRequest,
   buildApiMessages, estimateTokens, tokenBudget, fitMessages, activeHistory, lastUserIndex, noteTrim,
   apiUrl, bearerHeaders, buildRequest, requireToolCall, withoutReplay */

// ---------------------------------------------------------------------------
// Request building: provider-neutral part (system prompt, tools, history, context budget)
// ---------------------------------------------------------------------------
// A turn's mode is "edit" (Edit automatically: replace_selection tool), "manual" (Manual: no editing, chat-only
// replies), "plan" (Plan: no editing, no remember; a numbered plan of edits) or a persona name from PERSONAS (slash commands). With Munin a persona turn goes through
// Munin's own persona pipeline (server-side web + paper search, no client tools); with the other
// providers it is an ordinary chat-only turn that uses the persona's instructions.
// Document access: the text stays out of the prompt; the model gets the outline plus the reading
// tools. Munin persona turns have no client tools and get a document excerpt in the prompt instead.
const isPersonaMode = (mode) => Object.prototype.hasOwnProperty.call(PERSONAS, mode);
const canEdit = (mode) => mode === 'edit';
// Auto turn on a document read through the Docs API: the precise writing tools are offered.
const apiEditing = (mode, snap) => canEdit(mode) && snap.docFormat === 'docs-api' && !!snap.model;
// Document passes (/review, the paper card build: DOC_PASS_MODES) never use Munin's persona pipeline: they need the
// exact document text and a JSON answer, so Munin runs them in raw mode like any tools turn.
const isDocPass = (mode) => DOC_PASS_MODES.includes(mode);
const isMuninPersona = (mode, snap) => isPersonaMode(mode) && !isDocPass(mode) && snap.prov.personas;
// read_formatting: the main document was read through the Docs API (the export has no runs).
const offersFormatting = (mode, snap) => offersOpenDocument(mode, snap) && snap.docFormat === 'docs-api' && !!snap.model;
// Per-call limits of read_lines / read_formatting for a provider (the defaults when it is not known).
const readLimits = (prov) => ({
  chars: (prov && prov.readMaxChars) || READ_MAX_CHARS,
  lines: (prov && prov.readMaxLines) || READ_MAX_LINES,
});
// Providers with a prompt cache (OpenAI, Anthropic): older turns are sent exactly as they were, so the
// cached prefix stays valid. Munin has none: the context of older turns is sent shortened (shortContext).
const cachesPrompt = (prov) => prov.id !== 'munin';
// /research with OpenAI or Anthropic: the provider's server-side web search tool is added.
const webSearchTurn = (mode, snap) => mode === 'research' && WEB_SEARCH_PROVIDERS.includes(snap.prov.id);
// Every turn with client tools: the reading tools, open_document (and the "doc" parameter of the
// reading tools); Munin persona turns get a document excerpt in the prompt instead.
const offersOpenDocument = (mode, snap) => !isMuninPersona(mode, snap);
// remember: every turn with open_document except a side question (/side leaves nothing behind) and Plan (read-only).
const offersRemember = (mode, snap) => offersOpenDocument(mode, snap) && !snap.side && mode !== 'plan';

// The tools of a turn, in Chat Completions format (converted per provider below): the reading tools,
// open_document, remember, replace_selection in Auto, plus the writing tools when the document was read through
// the Docs API. Munin persona turns have none.
function toolsFor(mode, snap) {
  // A document pass reads only the main document, and only when its text did not fit into the request.
  if (isDocPass(mode)) return docPassInline(snap) ? [] : READING_TOOLS.map((n) => TOOL_DEFS[n]);
  const names = [];
  if (offersOpenDocument(mode, snap)) names.push(...READING_TOOLS);
  if (offersFormatting(mode, snap)) names.push(FORMAT_READING_TOOL);
  if (offersOpenDocument(mode, snap)) names.push('open_document', ...(offersRemember(mode, snap) ? ['remember'] : []));
  if (apiEditing(mode, snap)) names.push(...WRITE_TOOLS);
  if (canEdit(mode)) names.push(REPLACE_TOOL.function.name);
  // Registered tools (registerTools) after the built-in ones, so the built-in prefix of the request stays as it was.
  return [...names.map((n) => TOOL_DEFS[n]), ...(offersOpenDocument(mode, snap) ? extraToolDefs(mode, snap) : [])];
}
const toOpenAiTool = (t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: true });
const toAnthropicTool = (t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters, strict: true });
const isReadingTool = (tc) => !!(tc && tc.function && (QUIET_TOOLS.includes(tc.function.name) || isExtraReading(tc.function.name, parseToolArgs(tc).args)));
const offersWriteTools = (tools) => tools.some((t) => WRITE_TOOLS.includes(t.function.name));

// Everything a turn's requests depend on, captured once per turn (sendMessage) so that every round
// of the tool loop sends the same provider settings, system prompt and tools: the selection is
// cleared after a successful replacement, and settings can be saved while a request runs. A stable
// prefix also keeps the providers' prompt caches warm and keeps replayed Anthropic thinking blocks valid.
// The reading tools read from this snapshot too.
// With the Docs API the writing tools update the snapshot's document after every edit (so the reading
// tools see it); the system prompt keeps using the state at the start of the turn (promptView).
function takeSnapshot() {
  const prov = activeProvider();
  return {
    prov, cfg: { ...activeConfig() },
    signal: null, // the turn's abort signal: Stop rejects a pending open_document card
    docText: null, docFormat: 'text', docTitle: '', docError: '', selection: '', lines: null, model: null, promptView: null,
    // Document instructions, the documents opened in the chat (open_document: the list grows during the
    // turn, the prompt keeps the list from the start) and their content read in this turn (alias -> doc).
    docInstructions: '', docId: null, docs: [], docCache: new Map(), googleConnected: false, chatCtx: null, mainUrl: '',
    openAll: false, // "Allow all in this turn" on an open_document card
    pasteDone: false, // replace_selection pasted in this turn: a second paste is refused (runToolCall)
  };
}
function snapshotDocument(snap) {
  Object.assign(snap, {
    docText: state.docText, docFormat: state.docFormat, docTitle: state.docTitle, docError: state.docError,
    selection: state.selection, lines: null, model: state.docFormat === 'docs-api' ? state.docModel : null,
    docInstructions: String(state.docInstructions || '').slice(0, DOC_INSTRUCTIONS_MAX), docId: state.docId,
    docs: chatDocs(state.chatId), docCache: new Map(), googleConnected: state.googleConnected,
  });
  const { docText, docFormat, docTitle, docError, selection, model } = snap;
  snap.promptView = { docText, docFormat, docTitle, docError, selection, model, lines: null, docs: snap.docs.map((d) => ({ ...d })) };
}
const docLines = (snap) => snap.lines || (snap.lines = (snap.docText || '').split('\n'));

// ---- Document structure (tools mode) -------------------------------------------------------
// Headings with the 1-based line where each section starts: from the paragraph styles (Docs API),
// or Markdown headings (export; code fences are skipped). Empty for a plain-text export.
const hasOutline = (snap) => snap.docFormat === 'markdown' || (snap.docFormat === 'docs-api' && !!snap.model);
function docOutline(snap) {
  if (snap.docText == null) return [];
  if (snap.docFormat === 'docs-api' && snap.model) {
    return snap.model.lines.filter((l) => l.heading && l.text.trim())
      .map((l) => ({ line: l.line, level: l.heading, title: l.text.trim(), style: l.style }));
  }
  if (snap.docFormat !== 'markdown') return [];
  const out = [];
  let inFence = false;
  docLines(snap).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ line: i + 1, level: m[1].length, title: m[2].trim() });
  });
  return out;
}
// Markdown items as "L5: ## Methods", Docs API items with their style: "L1: [Title] ...", "L5: [H2] Methods".
const styleLabel = (style) => (style === 'TITLE' ? 'Title' : style === 'SUBTITLE' ? 'Subtitle' : 'H' + String(style).replace('HEADING_', ''));
const formatOutline = (items) => items.map((h) => `L${h.line}: ${h.style ? `[${styleLabel(h.style)}]` : '#'.repeat(h.level)} ${h.title}`).join('\n');

// Line range of the selection in the document ({start, end}, 1-based) or null when it cannot be
// found. The selection comes from the editor as plain text with one newline between paragraphs,
// the export is Markdown with markup and blank lines, so lines are compared without markup and the
// first and last selected lines are located separately. null too when the selection occurs several times.
function locateSelection(snap) {
  const span = selectionSpan(snap);
  return span && !(span.occurrences > 1) ? { start: span.start, end: span.end } : null;
}
const SELECTION_MARKUP_RE = /[*_`#>\\[\]]/;
const normLine = (s) => s.replace(/[*_`#>\\[\]]/g, '').replace(/\s+/g, ' ').trim();
// normLine with a map from every normalized character to its index in the raw line.
function normLineMap(raw) {
  let text = '';
  const map = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (SELECTION_MARKUP_RE.test(c)) continue;
    if (/\s/.test(c)) {
      if (text && text[text.length - 1] !== ' ') { text += ' '; map.push(i); }
      continue;
    }
    text += c;
    map.push(i);
  }
  if (text.endsWith(' ')) { text = text.slice(0, -1); map.pop(); }
  return { text, map };
}
// The selection's position: {start, end} lines plus startChar / endChar, the 1-based offsets of its first
// and last characters inside the first and last lines, and approx when the match is not exact (markup or
// whitespace differences, short edge lines skipped, last line not found). null when it cannot be found.
function selectionSpan(snap) {
  if (snap.docText == null || !snap.selection) return null;
  const raw = docLines(snap);
  const doc = raw.map(normLine);
  const selRaw = snap.selection.split('\n').map((s) => s.trim()).filter((s) => normLine(s).length >= 3);
  const sel = selRaw.map(normLine);
  if (!sel.length) return null;
  const findFrom = (needle, from) => {
    for (let i = from; i < doc.length; i++) if (doc[i] && (doc[i] === needle || doc[i].includes(needle))) return i;
    return -1;
  };
  // The only place where all selected lines follow each other, else the first line's first occurrence.
  const places = selectionPlaces(doc, sel, findFrom);
  const occurrences = places.length;
  const start = occurrences === 1 ? places[0] : findFrom(sel[0], 0);
  if (start < 0) return null;
  const last = sel.length - 1;
  const found = sel.length === 1 ? start : findFrom(sel[last], start);
  const end = found < 0 ? start : found;
  const first = normLineMap(raw[start]);
  const k0 = first.text.indexOf(sel[0]);
  const lastLine = end === start ? first : normLineMap(raw[end]);
  // The last selected line ends the match; when it was not found the first line's match is used.
  let needle = sel[last];
  let k1 = sel.length === 1 ? k0 : end === start ? first.text.indexOf(needle, k0 + sel[0].length) : lastLine.text.indexOf(needle);
  if (found < 0 || k1 < 0) { needle = sel[0]; k1 = k0; }
  const startChar = first.map[k0] + 1;
  const endChar = lastLine.map[k1 + needle.length - 1] + 1;
  const sliced = snap.selection.trim().split('\n').map((s) => s.trim());
  const approx = needle !== sel[last] || sliced[0] !== selRaw[0] || sliced[sliced.length - 1] !== selRaw[last] ||
    raw[start].slice(startChar - 1, startChar - 1 + selRaw[0].length) !== selRaw[0] ||
    raw[end].slice(endChar - selRaw[last].length, endChar) !== selRaw[last];
  return { start: start + 1, end: end + 1, startChar, endChar, approx, ...(occurrences > 1 ? { occurrences } : {}) };
}
// The lines (0-based) where the selection could start: for a one-line selection the lines that contain its
// text (repeats within one line do not make its line number ambiguous), for a longer one the lines with
// its first line from which the other selected lines follow in order, with only blank or very short lines
// (the ones a selection skips too) between them.
function selectionPlaces(doc, sel, findFrom) {
  const out = [];
  if (sel.length === 1) {
    doc.forEach((d, i) => { if (d && d.includes(sel[0])) out.push(i); });
    return out;
  }
  const next = (needle, from) => {
    for (let k = from; k < doc.length; k++) {
      if (doc[k] && doc[k].includes(needle)) return k;
      if (doc[k].length >= 3) return -1;
    }
    return -1;
  };
  for (let i = findFrom(sel[0], 0); i >= 0; i = findFrom(sel[0], i + 1)) {
    let j = i;
    for (let k = 1; k < sel.length && j >= 0; k++) j = next(sel[k], j + 1);
    if (j >= 0) out.push(i);
  }
  return out;
}
// The selection line of a tools-mode turn context: where the selection is and how big it is, never its
// text (the model reads it with get_selection or read_lines), e.g. "Selection: lines 12–48 (3,215 characters)".
function selectionLine(snap) {
  const size = `${fmtNum(snap.selection.length)} character${snap.selection.length === 1 ? '' : 's'}`;
  const span = selectionSpan(snap);
  if (!span) return `Selection: ${size}; its position in the document was not found (read it with get_selection).`;
  // Several occurrences: no line numbers (they might be another occurrence's).
  if (span.occurrences > 1) {
    return `Selection: ${size}; the selected text occurs in ${span.occurrences} places in the document, so which one is selected is not known. Read it with get_selection and locate the right occurrence with find_in_document before editing near it; replace_selection replaces exactly what the user selected.`;
  }
  const where = span.start === span.end ? `line ${span.start}` : `lines ${span.start}–${span.end}`;
  return `Selection: ${where} (${size}${span.approx ? '; position approximate' : ''})`;
}
// The <selection> block of a Munin persona prompt. Those turns have no reading tools, so the selection
// is given as text: in full when short; a longer one that lies within the excerpt's shownLines complete
// lines by its position plus its first and last characters; otherwise shortened to PROMPT_SELECTION_MAX.
function selectionBlock(snap, opts) {
  const text = snap.selection;
  if (text.length <= SELECTION_INLINE_MAX) return `<selection>\n${text}\n</selection>`;
  const span = selectionSpan(snap);
  if (span && span.end <= opts.shownLines) {
    const range = `${span.start}-${span.end}`;
    const attrs = ` lines="${range}" characters="${text.length}" start="line ${span.start}, character ${span.startChar}" end="line ${span.end}, character ${span.endChar}"`;
    const approx = span.approx ? ' The position is approximate: the selection was matched ignoring formatting.' : '';
    const flat = text.replace(/\s+/g, ' ').trim();
    const head = flat.slice(0, SELECTION_EXCERPT_CHARS).trimEnd();
    const tail = flat.slice(-SELECTION_EXCERPT_CHARS).trimStart();
    return `<selection${attrs}>\n[Long selection: only its position is given; its text is lines ${range} of the <document> above.${approx}]\n` +
      `Begins: "${head}…"\nEnds: "…${tail}"\n</selection>`;
  }
  const shown = text.length > PROMPT_SELECTION_MAX
    ? text.slice(0, PROMPT_SELECTION_MAX) + `\n[... shortened: ${fmtNum(text.length)} characters in total]`
    : text;
  return `<selection>\n${shown}\n</selection>`;
}

// ---- System prompt -------------------------------------------------------------------------
// Instructions for a tools-mode turn ("edit", "manual" or "plan"): how to read the document, then the rules. The tools
// themselves are described only by their definitions (tools.js); the prompt adds the provider's per-call limits
// and the registered tools' lines (registerPromptLine).
function toolsInstructions(mode, snap) {
  const api = snap.docFormat === 'docs-api';
  const format = snap.docFormat === 'markdown'
    ? 'exported as Markdown (headings start with "#", emphasis uses * or _, links are [text](url))'
    : api ? `read through the Google Docs API as plain text: one line per paragraph (table cells are separate lines${lineDecoratorNotes()}, in reading order), headings are listed in the outline with their style, inline formatting such as bold, italics and links, lists and alignment are not shown (read_formatting shows them), and embedded objects (images, chips, page breaks) appear as "${OBJECT_CHAR}"; "${SOFT_BREAK_MARK}" marks a soft line break inside a paragraph`
      : 'exported as plain text';
  const fresh = api
    ? 'The text is re-read at the start of every user message and after every edit you make, so the reading tools always show the current text; line numbers change after an insertion or deletion. The outline in a user message is from the moment it was sent; call get_outline() for the current one.'
    : 'The text is re-read at the start of every user message; within one message a replacement is not yet visible to the reading tools.';
  const limits = readLimits(snap.prov);
  const intro = `You are an editing assistant built into a panel next to a Google Docs document.
The document text is NOT included in the messages; you read it with tools. Lines are numbered from 1.
Each user message begins with the state of the document when it was sent: <document> (title, size and outline), the selection (its line range and size), the documents opened in this chat and, when the document changed since your previous answer, <document_changes>. The user's own text follows.
read_lines${offersFormatting(mode, snap) ? ' and read_formatting return' : ' returns'} at most ${limits.lines} lines or about ${fmtNum(limits.chars)} characters per call; read a longer part in several calls.${extraPromptLines('reading', mode, snap).map((l) => '\n' + l).join('')}
The user's selection is given as a line range and size; read it with get_selection (all of it) or read_lines (parts). Read what you need before answering or editing: usually the selection and the lines around it, or the relevant section. Do not read the whole document unless the request needs it. The document is ${format}. ${fresh}
Results of reading tools from earlier messages are replaced by a short note ("content omitted"); read the text again when you need it.`;
  const rules = mode === 'manual' ? TOOLS_MANUAL_RULES : mode === 'plan' ? TOOLS_PLAN_RULES : apiEditing(mode, snap) ? apiEditRules(extraPromptLines('edit', mode, snap)) : TOOLS_EDIT_RULES;
  return `${intro}\n\n${rules}`;
}

// The document text placed in a Munin persona prompt (from the turn's start); soft breaks are shown
// as a mark when the document was read through the Docs API.
function promptDocText(mode, liveSnap) {
  const snap = { ...liveSnap, ...(liveSnap.promptView || {}) };
  if (snap.docText == null) return null;
  return snap.docFormat === 'docs-api' ? showText(snap.docText) : snap.docText;
}
// Note about lines with suggested changes (Docs API), or ''.
function suggestionsNote(snap) {
  const n = snap.docFormat === 'docs-api' && snap.model ? snap.model.lines.filter((l) => l.suggested).length : 0;
  return n ? `\n[${n} line${n === 1 ? '' : 's'} contain${n === 1 ? 's' : ''} suggested changes (suggesting mode): their text shows suggested insertions and deletions together, and they cannot be edited until the suggestions are accepted or rejected.]` : '';
}

const docTitleAttrs = (snap) => {
  const format = snap.docFormat === 'markdown' || snap.docFormat === 'docs-api' ? snap.docFormat : 'text';
  const tabAttr = format === 'docs-api' && snap.model && snap.model.tabCount > 1 ? ` tab="${escapeHtml(snap.model.tabTitle)}"` : '';
  return { title: escapeHtml(snap.docTitle), format, tabAttr };
};
const noSelectionBlock = (mode) => (canEdit(mode)
  ? '<selection>[Nothing is selected. replace_selection would insert text at the cursor position.]</selection>'
  : '<selection>[Nothing is selected.]</selection>');

// System prompt for the given mode, in two parts. Tools mode (every turn with client tools): head is
// the static part (instructions, the open_document note, the document instructions), the same on every
// round and turn of a chat with the same mode, provider and document instructions, so the providers'
// prompt caches can reuse it; tail is empty, because the document summary and the selection travel in
// the turn's user message (buildTurnContext). Munin persona turns (no client tools, one request per
// turn): head = instructions + the document excerpt (+ the style line), tail = the selection; buildRequest
// sends them at the start of the newest user message, not as a system message (personaMessages). docLimit:
// maximum number of document characters in the excerpt (Munin persona turns).
function buildSystemParts(mode, docLimit, liveSnap) {
  // The document part comes from the state at the start of the turn (edits during the turn change
  // the live snapshot only); mode, provider and tools come from the live snapshot.
  const snap = { ...liveSnap, ...(liveSnap.promptView || {}) };
  const persona = isPersonaMode(mode);
  const { title, format, tabAttr } = docTitleAttrs(snap);

  if (!offersOpenDocument(mode, snap)) {
    // Munin persona turns: a document excerpt goes into the prompt (no client tools).
    const instructions = personaInstructions(mode, webSearchTurn(mode, snap));
    let docBlock;
    let shownLines = 0;
    if (snap.docText != null) {
      let text = promptDocText(mode, liveSnap);
      let note = suggestionsNote(snap);
      shownLines = text.split('\n').length;
      if (text.length > docLimit) {
        note += `\n[The document was truncated: only the first ${fmtNum(docLimit)} of ${fmtNum(text.length)} characters are shown.]`;
        text = text.slice(0, docLimit);
        shownLines = text.split('\n').length - 1; // the last line may be cut
      }
      docBlock = `<document title="${title}"${tabAttr} format="${format}">\n${text}\n</document>${note}`;
    } else {
      docBlock = `<document title="${title}">[Document text is unavailable: ${snap.docError || 'loading error'}]</document>`;
    }
    const style = styleLine(snap);
    if (style) docBlock += `\n${style}`; // the measured style line (tools turns have it in the turn context)
    const sel = snap.selection ? selectionBlock(snap, { shownLines }) : noSelectionBlock(mode);
    return { head: promptHead(instructions, docBlock, mode, snap), tail: `Current selection in the document:\n${sel}` };
  }

  // A document pass: its own short head (no remember note, no writing rules), the document instructions, the
  // untrusted-data note; the task and the document travel in the user message (docPassContext).
  if (isDocPass(mode)) {
    const head = [DOC_PASS_HEADS[mode] + (docPassInline(liveSnap) ? '' : `\n${DOC_PASS_READ_NOTE}`)];
    const di = mode === 'review' ? docInstructionsBlock(snap) : '';
    if (di) head.push(di);
    head.push(UNTRUSTED_DATA_NOTE);
    return { head: head.join('\n\n'), tail: '' };
  }
  // Tools mode: only the static instructions; the document summary and the selection are in the turn context.
  const instructions = persona ? `${personaInstructions(mode, webSearchTurn(mode, snap), true)}\n${TOOLS_PERSONA_NOTE}` : toolsInstructions(mode, snap);
  return { head: promptHead(instructions, '', mode, snap), tail: '' };
}
const joinSystem = (parts) => (parts.tail ? `${parts.head}\n\n${parts.tail}` : parts.head);

// The <document> block of the turn context: title, size and outline (tools mode).
function documentBlock(snap) {
  const { title, format, tabAttr } = docTitleAttrs(snap);
  if (snap.docText == null) {
    return `<document title="${title}">[Document text is unavailable: ${snap.docError || 'loading error'}. The reading tools will fail.]</document>`;
  }
  const lines = docLines(snap);
  const items = docOutline(snap);
  let outline;
  if (!hasOutline(snap)) outline = '[Outline unavailable: the document could only be exported as plain text. Use find_in_document and read_lines.]';
  else if (!items.length) outline = '[The document has no headings.]';
  else {
    outline = 'Outline (line: heading):\n' + formatOutline(items.slice(0, OUTLINE_MAX_ITEMS)) +
      (items.length > OUTLINE_MAX_ITEMS ? `\n[${items.length - OUTLINE_MAX_ITEMS} more headings: call get_outline()]` : '');
  }
  return `<document title="${title}"${tabAttr} format="${format}" lines="${lines.length}" characters="${snap.docText.length}">\n${outline}\n</document>${suggestionsNote(snap)}`;
}

// The per-turn context placed at the start of the turn's user message (tools mode; '' for Munin persona
// turns, whose system prompt carries the excerpt and the selection): the <document> block (plus the
// documents opened in the chat), the <document_changes> note when the document changed since the previous
// turn (prevFacts: docFacts stored at the end of that turn), the lines of the beforeTurn hooks (snap.turnLines,
// asked by the turn just before) and the selection. Built once, at send time, from the state at the start of
// the turn, and stored on the user message (_context), so that the requests of later rounds and turns repeat
// it byte for byte.
function buildTurnContext(mode, liveSnap, prevFacts) {
  if (!offersOpenDocument(mode, liveSnap)) return '';
  const snap = { ...liveSnap, ...(liveSnap.promptView || {}), lines: null };
  if (mode === 'card') return documentBlock(snap); // the paper card build: the document only (docPassContext adds the rest)
  const parts = [documentBlock(snap) + extraDocNotes(mode, snap) + (offersOpenDocument(mode, snap) ? openedDocsNote(snap) : '')];
  const style = styleLine(snap);
  if (style) parts.push(style);
  const changes = docChangesNote(prevFacts, docFacts(snap));
  if (changes) parts.push(changes);
  // The beforeTurn hooks' lines (registry.js), asked by the turn before this call.
  for (const line of liveSnap.turnLines || []) parts.push(line);
  // Only where the selection is and its size, not its text: every turn with a context has reading tools.
  parts.push(snap.selection ? selectionLine(snap) : `Current selection in the document:\n${noSelectionBlock(mode)}`);
  return parts.join('\n');
}

// ---- Measured style of the document ---------------------------------------------------------
// A few numbers the writing rules can be matched against, from the first STYLE_SAMPLE_CHARS characters of the
// text. Sentences and words come from src/text-segments.js (Intl.Segmenter with the abbreviation merge pass:
// "3.5", "Fig. 3", "e.g. the" and "рис. 2" do not split a sentence; "well-known" and "1,000" are one word); a line
// without a final . ! ? or … (a heading, a list item) is not counted as a sentence. Dashes: every em dash, plus an
// en dash or a hyphen with spaces on both sides (a range like "1–3" is not a dash). Returns null below
// STYLE_MIN_WORDS or with fewer than STYLE_MIN_SENTENCES sentences (a list or a table, not prose).
const STYLE_MIN_SENTENCES = 5;
function docStyleStats(text) {
  const sample = String(text || '').slice(0, STYLE_SAMPLE_CHARS);
  const words = countWords(sample);
  if (words < STYLE_MIN_WORDS) return null;
  let sentences = 0;
  let sentenceWords = 0;
  for (const s of splitSentences(sample)) {
    if (!endsSentence(s)) continue;
    const n = countWords(s);
    if (n) { sentences++; sentenceWords += n; }
  }
  if (sentences < STYLE_MIN_SENTENCES) return null;
  const dashes = (sample.match(/—|(?<=\s)[–-](?=\s)/g) || []).length;
  const quoteKinds = [
    ['"straight"', (sample.match(/"/g) || []).length],
    ['«guillemets»', (sample.match(/[«»]/g) || []).length],
    ['“curly”', (sample.match(/[“”„]/g) || []).length],
  ].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return {
    words,
    sentenceWords: Math.round(sentenceWords / sentences),
    dashesPer1000: Math.round((dashes * 10000) / words) / 10,
    quotes: quoteKinds.length ? quoteKinds[0][0] : null,
  };
}
// Bold text in non-heading lines of the Docs API line model (true / false), or null without the model.
function bodyBold(snap) {
  if (snap.docFormat !== 'docs-api' || !snap.model || !Array.isArray(snap.model.lines)) return null;
  return snap.model.lines.some((l) => !l.heading && (l.runs || []).some((r) => r.bold && r.e > r.s && String(l.text).slice(r.s, r.e).trim()));
}
// The style line of the turn context (Munin persona turns: after the excerpt), or '' for a short or missing text.
function styleLine(snap) {
  if (snap.docText == null) return '';
  const st = docStyleStats(snap.docText);
  if (!st) return '';
  const parts = [`average sentence ${st.sentenceWords} words`];
  parts.push(`dashes ${st.dashesPer1000} per 1,000 words`);
  if (st.quotes) parts.push(`quotes ${st.quotes}`);
  const bold = bodyBold(snap);
  if (bold != null) parts.push(`bold in body: ${bold ? 'yes' : 'no'}`);
  return `Style of the document: ${parts.join('; ')}.`;
}

// The docNote lines of the registered tools offered in this turn ("\n[Also: …]"), or ''. Best effort, like the turn
// hooks: a note that throws is left out instead of failing the turn.
function extraDocNotes(mode, snap) {
  if (snap.docText == null) return '';
  const note = (t) => { try { return t.docNote(snap); } catch (e) { return ''; } };
  const notes = EXTRA_TOOLS.filter((t) => t.docNote && offered(t, mode, snap)).map(note).filter(Boolean);
  return notes.map((n) => '\n' + n).join('');
}

// What the next turn compares against for <document_changes>: the main document's size, its outline
// ([line, title] pairs) and the Docs API revision when known. null without a document text.
function docFacts(snap) {
  if (!snap || snap.docText == null) return null;
  const f = {
    format: snap.docFormat, chars: snap.docText.length, lines: docLines(snap).length,
    outline: docOutline(snap).map((h) => [h.line, h.title]),
  };
  if (snap.docFormat === 'docs-api' && snap.model) {
    if (snap.model.revisionId) f.revisionId = snap.model.revisionId;
    if (snap.model.tabCount > 1) f.tab = String(snap.model.tabTitle || '');
  }
  return f;
}

// One line about what changed between two docFacts, or '' (no previous facts, nothing changed, or the
// two are not comparable: another reading format or document tab). Headings are matched by their title,
// in order; each list (moved / new / removed) names at most DOC_CHANGES_MAX_HEADINGS.
function docChangesNote(prev, cur) {
  if (!prev || !cur || prev.format !== cur.format || (prev.tab || '') !== (cur.tab || '')) return '';
  if (prev.revisionId && cur.revisionId && prev.revisionId === cur.revisionId) return '';
  const signed = (n, unit) => `${n > 0 ? '+' : ''}${n} ${unit}${Math.abs(n) === 1 ? '' : 's'}`;
  const name = (t) => JSON.stringify(String(t).length > 80 ? String(t).slice(0, 80) + '…' : String(t));
  const parts = [];
  const size = [];
  if (cur.chars !== prev.chars) size.push(signed(cur.chars - prev.chars, 'character'));
  if (cur.lines !== prev.lines) size.push(signed(cur.lines - prev.lines, 'line'));
  if (size.length) parts.push(size.join(', '));
  const pool = new Map();
  for (const [line, title] of prev.outline || []) {
    if (!pool.has(title)) pool.set(title, []);
    pool.get(title).push(line);
  }
  const moved = [];
  const added = [];
  for (const [line, title] of cur.outline || []) {
    const was = pool.has(title) ? pool.get(title).shift() : undefined;
    if (was === undefined) added.push(`${name(title)} (line ${line})`);
    else if (was !== line) moved.push(`${name(title)} ${was}→${line}`);
  }
  const removed = [];
  for (const [title, left] of pool) for (let i = 0; i < left.length; i++) removed.push(name(title));
  const list = (label, items) => {
    if (!items.length) return;
    const more = items.length - DOC_CHANGES_MAX_HEADINGS;
    parts.push(`${label}: ${items.slice(0, DOC_CHANGES_MAX_HEADINGS).join(', ')}${more > 0 ? ` and ${more} more` : ''}`);
  };
  list('headings moved', moved);
  list('new headings', added);
  list('removed headings', removed);
  if (!parts.length) {
    if (!prev.revisionId || !cur.revisionId) return '';
    parts.push('the text was edited (its size and headings are unchanged)');
  }
  return `<document_changes>Since your last turn: ${parts.join('; ')}.</document_changes>`;
}

// The text of a user message as sent: its turn context (when it has one) before the user's own text.
// short: the shortened context (Munin, older turns).
function userContent(m, short) {
  const ctx = typeof m._context === 'string' ? m._context : '';
  if (!ctx) return m.content;
  return `${short ? shortContext(ctx) : ctx}\n\n${m.content}`;
}
// A turn context without the outline and without a long selection text (positions and sizes stay; only
// contexts stored before the selection became a line range carry its text).
function shortContext(ctx) {
  return String(ctx)
    .replace(/\nStyle of the document: [^\n]*/, '')
    .replace(/(<document\b[^>]*>)[\s\S]*?(<\/document>)/, '$1[outline omitted: from an earlier message]$2')
    .replace(/(<selection\b[^>]*>)([\s\S]*)(<\/selection>)/, (all, open, body, close) => (body.length > CONTEXT_SHORT_SELECTION_CHARS
      ? `${open}[selected text omitted: from an earlier message]${close}` : all));
}

// The system prompt head: the role instructions (plus the remember note when the turn offers that tool),
// the document instructions (when set), then, in Munin persona turns, the <document> excerpt, then the
// untrusted-data note (every turn: what the assistant reads is data).
function promptHead(instructions, docBlock, mode, snap) {
  // The remember note only where the tool is offered (toolsFor): not in a side question or in Plan.
  const parts = [offersRemember(mode, snap) ? `${instructions}\n\n${REMEMBER_NOTE}` : instructions];
  const di = docInstructionsBlock(snap);
  if (di) parts.push(di);
  if (docBlock) parts.push(docBlock); // Munin persona turns only: they have no open_document
  parts.push(UNTRUSTED_DATA_NOTE); // every turn: what the assistant reads is data (static, so it stays cached)
  return parts.join('\n\n');
}
function docInstructionsBlock(snap) {
  const text = String(snap.docInstructions || '').slice(0, DOC_INSTRUCTIONS_MAX).trim();
  return text ? `${DOC_INSTRUCTIONS_NOTE}\n<document_instructions>\n${text}\n</document_instructions>` : '';
}
// The documents opened in this chat before the turn (the prompt's copy; see snapshotDocument), or ''.
function openedDocsNote(snap) {
  const docs = Array.isArray(snap.docs) ? snap.docs : [];
  if (!docs.length) return '';
  const items = docs.map((d) => `${d.alias} ${JSON.stringify(d.title || 'Untitled document')}${Number.isFinite(d.lines) ? ` (${fmtNum(d.lines)} lines)` : ''}`);
  return `\n[Documents opened in this chat with open_document (read them with doc: "<alias>"; no need to open them again): ${items.join('; ')}.]`;
}

// Converts history to Chat Completions messages (the provider-neutral shape: sent as-is by Munin,
// used for size estimation by all providers): only role/content (and tool fields) are copied, so
// UI-only "_" fields (_reasoning, _usage, _toolActivity, _persona, _anthropicBlocks, _openaiItems, ...)
// are never sent. Requests without tools (Munin persona turns)
// cannot carry tool calls, so the tool history is left out of them; requests with tools keep it.
// A user message carries its turn context (userContent); shortOld: shortened for the turns before the
// newest user message (Munin, which has no prompt cache to keep valid).
function buildApiMessages(hasTools, history, systemText, { shortOld = false } = {}) {
  const lastUser = shortOld ? lastUserIndex(history) : -1;
  const out = [{ role: 'system', content: systemText }];
  history.forEach((m, i) => {
    const o = apiMessage(m, !hasTools, i < lastUser);
    if (o) out.push(o);
  });
  return out;
}
// One history message as sent, or null when it is left out (a tool message without tools, an assistant message
// with neither text nor tool calls). short: a user message's turn context shortened.
function apiMessage(m, stripTools, short) {
  if (m.role === 'user') return { role: 'user', content: userContent(m, short) };
  if (m.role === 'tool') return stripTools ? null : { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
  if (m.role !== 'assistant') return null;
  const withCalls = !stripTools && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  const content = m.content || '';
  if (!withCalls && !content.trim()) return null; // e.g. a reply that was only reasoning or a tool call
  const o = { role: 'assistant', content: content || null };
  if (withCalls) {
    o.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id, type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments || '' },
    }));
  }
  return o;
}
// The characters of every history message as buildApiMessages sends it (0 when left out), for fitMessages to
// estimate a trimmed request without rebuilding it.
function sentSizes(hasTools, history, { shortOld = false } = {}) {
  const lastUser = shortOld ? lastUserIndex(history) : -1;
  return history.map((m, i) => {
    const o = apiMessage(m, !hasTools, i < lastUser);
    return o ? messageChars(o) : 0;
  });
}

// Rough token estimate: ceil(chars / 3), a safe multilingual approximation. A message's provider replay
// payload (_openaiItems / _anthropicBlocks, when present) counts too.
function estimateTokens(messages, extraChars = 0) {
  let chars = extraChars;
  for (const m of messages) chars += messageChars(m);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
const messageChars = (m) => (m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + replayChars(m);
const replayChars = (m) => RAW_REPLAY_KEYS.reduce((n, k) => n + (Array.isArray(m[k]) && m[k].length ? JSON.stringify(m[k]).length : 0), 0);
// The replay payloads a request sends: those of the current turn's rounds (after the newest user message;
// older turns are rebuilt from text and tool calls), for the active provider.
function sentReplayChars(history, prov) {
  const key = prov.id === 'openai' ? '_openaiItems' : prov.id === 'anthropic' ? '_anthropicBlocks' : null;
  if (!key) return 0;
  const lastUser = lastUserIndex(history);
  return history.reduce((n, m, i) => n + (i > lastUser && Array.isArray(m[key]) && m[key].length ? JSON.stringify(m[key]).length : 0), 0);
}

// The hard budget of a request: the context window minus the reply and a margin (the compaction trigger
// of OpenAI and Anthropic is lower, see compactionBudget).
function tokenBudget(mode, snap) {
  const ctx = snap.prov.contextTokens;
  const b = isMuninPersona(mode, snap)
    ? ctx - PERSONA_OVERHEAD_TOKENS - PERSONA_SAFETY_TOKENS
    : ctx - snap.prov.maxTokens - EDIT_SAFETY_TOKENS;
  return Math.max(b, MIN_BUDGET_TOKENS);
}

// Whether the document text at the start of the turn fits into one request of this mode: at most DOC_PASS_INLINE_SHARE of
// the request budget, the share a document pass puts inline. Longer documents get find_relevant_sections (section-scores.js).
function docFitsRequest(mode, liveSnap) {
  const text = (liveSnap.promptView || liveSnap).docText;
  return text == null || Math.ceil(text.length / CHARS_PER_TOKEN) <= DOC_PASS_INLINE_SHARE * tokenBudget(mode, liveSnap);
}

// Tool names by tool_call_id, from the assistant messages of a history.
function toolNamesById(history) {
  const names = new Map();
  for (const m of history) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) if (tc && tc.function) names.set(tc.id, tc.function);
  }
  return names;
}
// The short text that replaces a reading tool's result ("[read_lines 40–75: content omitted after the
// turn; re-read if needed]"); why: "after the turn" or "to fit the context window". open_document keeps
// its first line (alias, title, size). fn: the tool call's function ({name, arguments}).
function readingStub(fn, content, why) {
  const name = fn.name;
  let args = {};
  try { args = JSON.parse(fn.arguments || '{}') || {}; } catch (e) { args = {}; }
  const doc = isMainDocRef(args.doc) ? '' : ` (${String(args.doc).trim()})`;
  if (name === 'open_document') {
    return `${String(content).split('\n')[0]}\n[The rest of this result was omitted ${why}; call get_outline with this alias if needed.]`;
  }
  const what = name === 'read_lines' || name === FORMAT_READING_TOOL ? `${name} ${args.start}–${args.end}${doc}`
    : name === 'find_in_document' ? `${name} ${JSON.stringify(String(args.query == null ? '' : args.query))}${doc}`
      : `${name}${doc}`;
  return `[${what}: content omitted ${why}; re-read if needed]`;
}
// In-turn overflow: copies of the history in which the reading results of the current turn, except the
// last TURN_RESULTS_KEPT, are replaced by their stub (the stored messages are not changed; replay
// payloads are never touched). null when nothing could be replaced.
function stubTurnResults(history) {
  const lastUser = lastUserIndex(history);
  const names = toolNamesById(history.slice(lastUser + 1));
  const idx = [];
  history.forEach((m, i) => { if (i > lastUser && m.role === 'tool') idx.push(i); });
  const older = new Set(idx.slice(0, Math.max(0, idx.length - TURN_RESULTS_KEPT)));
  let changed = false;
  const out = history.map((m, i) => {
    const fn = names.get(m.tool_call_id);
    if (!older.has(i) || !fn || !isReadingTool({ function: fn }) || m._omittedChars || String(m.content || '').length <= STUB_MIN_CHARS) return m;
    changed = true;
    return { ...m, content: readingStub(fn, m.content, 'to fit the context window'), _omittedChars: m.content.length };
  });
  return changed ? out : null;
}

// Builds the tools, the history and the system prompt that fit the context budget. The stored
// history is not modified: when a request inside a turn is over budget, the older reading results of
// the turn are stubbed first (stubTurnResults), then the oldest messages are dropped from the request.
// Never drops the newest user message; drops whole turns (from a user message to the next one). If that is not enough, the document text in the system prompt is shortened further
// (Munin persona turns). Returns { history, system, messages, tools, trimmed, docCut, stubbed } (messages:
// Chat Completions shape). Messages replaced by a summary (_compacted) are never sent. reserve: tokens
// kept free (compaction plan); budget: the budget to fit (default tokenBudget); history: the messages to
// send instead of the chat's (the self-test's probe request); noTools: a request without tools.
function fitMessages(mode, snap, { reserve = 0, budget: limit, history: own = null, noTools = false } = {}) {
  const budget = (limit != null ? limit : tokenBudget(mode, snap)) - reserve;
  const tools = noTools ? [] : toolsFor(mode, snap);
  const hasTools = tools.length > 0;
  let history = activeHistory(own || state.messages);
  if (isDocPass(mode)) history = docPassHistory(mode, snap, history);
  const extraChars = (hasTools ? JSON.stringify(tools).length : 0) + sentReplayChars(history, snap.prov);
  const build = { shortOld: !cachesPrompt(snap.prov) };
  let docLimit = PERSONA_DOC_CHAR_LIMIT;
  let system = buildSystemParts(mode, docLimit, snap);
  const systemChars = joinSystem(system).length;
  let trimmed = false;
  let docCut = false;
  let stubbed = false;
  // The request is estimated from the size of each message as sent (the same sum as estimateTokens of the built
  // request), so dropping turns does not rebuild it every time.
  let sizes = sentSizes(hasTools, history, build);
  let chars = systemChars + extraChars + sizes.reduce((a, b) => a + b, 0);
  const over = () => Math.ceil(chars / CHARS_PER_TOKEN) > budget;

  if (over()) {
    const slim = stubTurnResults(history);
    if (slim) {
      history = slim;
      stubbed = true;
      sizes = sentSizes(hasTools, history, build);
      chars = systemChars + extraChars + sizes.reduce((a, b) => a + b, 0);
    }
  }

  // Whole turns: the request must start with a user message (Anthropic drops leading assistant messages, and
  // their tool results would be left without their calls); an automatic continuation (_auto) belongs to its turn.
  const lastUser = lastUserIndex(history);
  let first = 0;
  while (over() && first < lastUser) {
    do { chars -= sizes[first]; first++; } while (first < lastUser && (history[first].role !== 'user' || history[first]._auto));
    trimmed = true;
  }
  if (first) history = history.slice(first);
  let messages = buildApiMessages(hasTools, history, joinSystem(system), build);

  // The cut is computed on the text the prompt actually carries (the turn's start state), so every
  // round of a turn gets the same system prompt.
  const promptText = offersOpenDocument(mode, snap) ? null : promptDocText(mode, snap);
  for (let attempt = 0; attempt < 4 && promptText != null; attempt++) {
    const over = estimateTokens(messages, extraChars) - budget;
    if (over <= 0) break;
    const current = Math.min(docLimit, promptText.length);
    if (current <= 0) break;
    docLimit = Math.max(0, current - over * CHARS_PER_TOKEN - 500);
    docCut = true;
    system = buildSystemParts(mode, docLimit, snap);
    messages = buildApiMessages(hasTools, history, joinSystem(system), build);
  }
  return { history, system, messages, tools, trimmed, docCut, stubbed };
}

// Index of the user message before the newest one (the start of the previous turn), or -1.
function previousUserIndex(history) {
  let seen = false;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'user') continue;
    if (seen) return i;
    seen = true;
  }
  return -1;
}

// The history that requests are built from: without the messages a summary replaced.
const activeHistory = (messages) => messages.filter((m) => !m._compacted);

// Index of the newest user message in a history. Assistant entries after it are the rounds of the
// current turn (the tool loop in progress).
function lastUserIndex(history) {
  // An _auto message (the auto-continue after a length cut) is part of its turn, not a new one: the
  // turn's real user message keeps its full context, replay payloads and the cached prefix.
  for (let i = history.length - 1; i >= 0; i--) if (history[i].role === 'user' && !history[i]._auto) return i;
  return -1;
}

// ---- Document passes (/review, the paper card build) ----------------------------------------------------------
// The request of a document pass starts at the turn's user message: the chat history before it is never sent. The
// request copy of that message gets the pass's context (docPassContext) in place of its stored turn context; the
// stored message keeps the ordinary one, so later turns resend only that.
function docPassHistory(mode, snap, history) {
  const at = lastUserIndex(history);
  if (at < 0) return history;
  const turn = history.slice(at);
  turn[0] = { ...turn[0], _context: docPassContext(mode, snap, turn[0]._context) };
  return turn;
}
// The numbered text of the document at the start of the turn ("1: …", as read_lines shows it), or null without one.
function docPassText(liveSnap) {
  const snap = { ...liveSnap, ...(liveSnap.promptView || {}), lines: null };
  if (snap.docText == null) return null;
  return runReadingTool('read_lines', { start: 1, end: Number.MAX_SAFE_INTEGER }, snap, { chars: Infinity, lines: Infinity }).replace(/^Lines [^\n]*\n/, '');
}
// Whether the whole numbered text goes into the request: it takes at most DOC_PASS_INLINE_SHARE of the context
// budget. Decided once per turn (snap.docPass), so every round sends the same tools and head.
function docPassInline(snap) {
  if (!snap.docPass) {
    const text = docPassText(snap);
    const fits = text != null && Math.ceil(text.length / CHARS_PER_TOKEN) <= DOC_PASS_INLINE_SHARE * tokenBudget('review', snap);
    snap.docPass = { inline: fits, text: fits ? text : null };
  }
  return snap.docPass.inline;
}
// The user-message context of a document pass: the whole numbered document (or, when it is too long, the stored
// turn context with its outline and a note to read in parts), then the pass's task (the /review rubric, the paper
// card's fields). The user's own words follow it (userContent).
function docPassContext(mode, liveSnap, stored) {
  const snap = { ...liveSnap, ...(liveSnap.promptView || {}), lines: null };
  const task = DOC_PASS_TASKS[mode];
  if (!docPassInline(liveSnap)) {
    const ctx = typeof stored === 'string' && stored ? stored : documentBlock(snap);
    return `${ctx}\n[The document is too long for one message (${fmtNum(docLines(snap).length)} lines): read it in parts with read_lines.]\n\n${task}`;
  }
  const { title, format, tabAttr } = docTitleAttrs(snap);
  const lines = docLines(snap).length;
  // The beforeTurn lines (hidden text, for one) stay with the document they describe.
  const notes = (liveSnap.turnLines || []).map((l) => '\n' + l).join('');
  return `<document title="${title}"${tabAttr} format="${format}" lines="${lines}">\n${liveSnap.docPass.text}\n</document>${suggestionsNote(snap)}${notes}\n\n${task}`;
}

// Shows the one-line trimming notice above the input (reset at the start of every send).
function noteTrim(req) {
  if (!req.trimmed && !req.docCut && !req.stubbed) return;
  const parts = [];
  if (req.stubbed) parts.push('Earlier reading results of this answer were omitted');
  if (req.trimmed) parts.push('Older messages were trimmed');
  if (req.docCut) parts.push('The document excerpt was shortened');
  const text = parts.map((p, i) => (i ? p[0].toLowerCase() + p.slice(1) : p)).join('; ') + ' to fit the context window';
  el.trimNote.textContent = text;
  el.trimNote.title = el.trimNote.textContent;
  el.trimNote.classList.remove('hidden');
}

// Munin persona turns: Munin's /v1 gateway marks them ephemeral, and its ephemeral path keeps only user and
// assistant messages with string content, so a system message would be dropped server-side (the model would
// never see the document). The system text goes at the start of the newest user message instead, in a
// delimited block, after which Munin adds its own persona prompt.
function personaMessages(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const out = messages.filter((m) => m.role !== 'system').map((m) => ({ ...m }));
  if (!system) return out;
  let i = out.length - 1;
  while (i >= 0 && out[i].role !== 'user') i--;
  const block = `<instructions>\n${system}\n</instructions>`;
  if (i < 0) out.unshift({ role: 'user', content: block });
  else out[i].content = `${block}\n\n${out[i].content || ''}`;
  return out;
}

// Sampling fields of a provider's request body ({} when the provider has no PROVIDERS[*].sampling: the
// server default is used).
function samplingFields(prov) {
  const s = prov && prov.sampling;
  if (!s) return {};
  const out = {};
  for (const k of ['temperature', 'top_p', 'top_k', 'presence_penalty']) if (typeof s[k] === 'number') out[k] = s[k];
  return out;
}

// Every endpoint is fixed (PROVIDERS[*].baseUrl); a stored Base URL is removed by the settings migration.
const apiUrl = (snap, path) => snap.prov.baseUrl + path;
const bearerHeaders = (cfg) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` });

// Munin raw mode sends PROVIDERS.munin.sampling and, with tools, chat_template_kwargs.reasoning_effort.
// Builds the request for the turn's provider and mode. Returns { kind, url, headers, body, tools, trimmed, docCut }.
// kind: 'chat' (OpenAI-compatible Chat Completions SSE: Munin raw mode), 'persona' (Munin persona
// stream), 'responses' (OpenAI Responses API SSE) or 'anthropic' (Anthropic Messages API SSE).
// opts (the self-test's probe request): history and noTools as in fitMessages, maxTokens instead of the
// provider's reply limit.
function buildRequest(mode, snap, opts = {}) {
  const { prov, cfg } = snap;
  if (prov.id === 'openai') return buildOpenAiRequest(mode, snap, opts);
  if (prov.id === 'anthropic') return buildAnthropicRequest(mode, snap, opts);
  // Munin.
  const fit = fitMessages(mode, snap, opts);
  if (isMuninPersona(mode, snap)) {
    // Persona pipeline: always streams its own SSE format; server-side tools; no tools/stream fields.
    return {
      ...fit, kind: 'persona', url: apiUrl(snap, '/chat/completions'), headers: bearerHeaders(cfg),
      body: { model: cfg.model, persona: mode, messages: personaMessages(fit.messages) },
    };
  }
  const body = {
    model: cfg.model,
    persona: 'raw', // required: without it Munin runs its own pipeline and a non-OpenAI stream format
    messages: fit.messages,
    max_tokens: opts.maxTokens || prov.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  Object.assign(body, samplingFields(prov));
  if (fit.tools.length) {
    body.tools = fit.tools;
    // Reasoning counts against max_tokens and the 64k window is shared: edits do not need deep thinking.
    body.chat_template_kwargs = { reasoning_effort: MUNIN_REASONING_EFFORT };
  }
  // Edits one at a time (line numbers shift). An OpenAI-compatible field; assumed to be accepted by Munin.
  if (offersWriteTools(fit.tools)) body.parallel_tool_calls = false;
  return { ...fit, kind: 'chat', url: apiUrl(snap, '/chat/completions'), headers: bearerHeaders(cfg), body };
}

// The nudge round (toolLoop) asks the provider to call a tool where the field is known to work: OpenAI's
// tool_choice "required", and Anthropic's {type: "any"} only without thinking (the API refuses a forced tool choice
// with extended or adaptive thinking). Munin raw mode gets the nudge message alone: no field it may reject.
function requireToolCall(req) {
  if (!req || !req.body || !req.tools || !req.tools.length) return req;
  if (req.kind === 'responses') req.body.tool_choice = 'required';
  else if (req.kind === 'anthropic' && !req.body.thinking) req.body.tool_choice = { type: 'any', disable_parallel_tool_use: true };
  return req;
}

// Copies of the messages without the providers' replay payloads (_openaiItems, _anthropicBlocks): the wrap-up
// request has no tools, so the rounds of the turn are rebuilt from text (a replayed reasoning item or thinking block
// without the call it led to would make the request invalid).
const withoutReplay = (messages) => messages.map((m) => {
  if (!RAW_REPLAY_KEYS.some((k) => k in m)) return m;
  const c = { ...m };
  for (const k of RAW_REPLAY_KEYS) delete c[k];
  return c;
});
