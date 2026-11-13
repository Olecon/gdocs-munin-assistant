'use strict';
// Module request.js: provider-neutral request building: mode predicates, toolsFor, the turn snapshot
// (takeSnapshot), the document outline and selection blocks, the static system prompt (buildSystemParts),
// the per-turn context of the user message (buildTurnContext, docFacts, docChangesNote, userContent), the
// context budget (fitMessages) and the provider dispatch (buildRequest; the Munin request is built here).
/* global activeConfig, activeProvider, anthropicForcedToolOk, anthropicRunsCode, apiEditRules, coreRules, buildAnthropicRequest, buildOpenAiRequest, CHARS_PER_TOKEN,
   chatDocs, docFileEntries, docTitleHeading, CONTEXT_SHORT_SELECTION_CHARS, DOC_CHANGES_MAX_HEADINGS, DOC_INSTRUCTIONS_MAX, DOC_INSTRUCTIONS_NOTE, MAIN_INSTRUCTIONS_NOTE,
   EDIT_SAFETY_TOKENS, el, escapeHtml, OLD_ARG_CHARS, EXTRA_TOOLS, extraPromptLines, extraToolDefs, fmtNum,
   isExtraReading, isMainDocRef, lineDecoratorNotes, MIN_BUDGET_TOKENS, noteRead, parseToolArgs, readingDigest, compactSchema,
   OBJECT_CHAR, OUTLINE_MAX_ITEMS, PERSONA_DOC_CHAR_LIMIT, PERSONA_OVERHEAD_TOKENS,
   PERSONA_SAFETY_TOKENS, personaInstructions, PERSONAS, PROMPT_SELECTION_MAX, QUIET_TOOLS, RAW_REPLAY_KEYS, READ_MAX_CHARS,
   READ_MAX_LINES, READING_TOOLS, REMEMBER_NOTE, REPLACE_TOOL, SELECTION_EXCERPT_CHARS, SELECTION_INLINE_MAX, showText,
   SOFT_BREAK_MARK, state, STUB_MIN_CHARS, compactTool, STYLE_MIN_WORDS, STYLE_SAMPLE_CHARS, TOOL_DEFS, TOOLS_EDIT_RULES, TOOLS_MANUAL_RULES, TOOLS_PLAN_RULES, TOOLS_PERSONA_NOTE,
   TURN_RESULTS_KEPT, UNTRUSTED_DATA_NOTE, conventionsLine, glossaryLine, hedgeCount, isPassive, memoByText, WEB_SEARCH_PROVIDERS, WRITE_TOOLS, MUNIN_REASONING_EFFORT,
   offered, countWords, endsSentence, splitSentences, textLang, DOC_PASS_HEADS, DOC_PASS_INLINE_SHARE, DOC_PASS_MODES, DOC_PASS_READ_NOTE,
   DOC_PASS_TASKS, lastSentText, PLAN_DO_TEXT, registerTurnHook, runReadingTool, readingSummary, AGENT_PREFACE, AGENT_REPORT_RULE, WEB_SEARCH_NOTE, WRITING_RULES, agentsLine, agentsRunningLine */
/* exported canEdit, offersRemember, chatAsked, onDemandOffer, onDemandProvider, stickyOffer, apiEditing, isMuninPersona, isDocPass, docPassInline, webSearchTurn, offersOpenDocument,
   toolsFor, toOpenAiTool, toAnthropicTool, isReadingTool, offersWriteTools, offersEditTools, takeSnapshot, snapshotDocument, runAsLine, runAsTag, runAsDue,
   docLines, hasOutline, docOutline, formatOutline, styleLabel, locateSelection, selectionSpan, selectionPlacesText, selectionContextOf, pickByContext, buildSystemParts, joinSystem,
   readLimits, cachesPrompt, sentTools, docInstructionsBlock, chatBody, buildTurnContext, docFacts, userContent, shortContext, docStyleStats, styleLine, samplingFields,
   personaMessages,
   toolNamesById, readingStub, previousUserIndex, docFitsRequest,
   buildApiMessages, estimateTokens, tokenBudget, fitMessages, activeHistory, lastUserIndex, noteTrim,
   apiUrl, bearerHeaders, buildRequest, requireToolCall, withoutReplay */

// ---------------------------------------------------------------------------
// Request building: provider-neutral part (system prompt, tools, history, context budget)
// ---------------------------------------------------------------------------
// A turn's mode is "edit" (the mode button's Manual and Auto: the writing tools; in Manual, snap.askEdits, every write
// asks on a card), "manual" (a read-only chat turn: /side, a read agent, a persona turn's agent; replies with an edit
// block), "plan" (Plan: no editing, no remember; a numbered plan of edits) or a persona name from PERSONAS (slash commands). With Munin a persona turn goes through
// Munin's own persona pipeline (server-side web + paper search, no client tools); with the other
// providers it is an ordinary chat-only turn that uses the persona's instructions.
// Document access: the text stays out of the prompt; the model gets the outline plus the reading
// tools. Munin persona turns have no client tools and get a document excerpt in the prompt instead.
const isPersonaMode = (mode) => Object.prototype.hasOwnProperty.call(PERSONAS, mode);
const canEdit = (mode) => mode === 'edit';
// An editing turn (Manual or Auto) on a document read through the Docs API: the precise writing tools are offered.
const apiEditing = (mode, snap) => canEdit(mode) && snap.docFormat === 'docs-api' && !!snap.model;
// Document passes (/review, the paper card build: DOC_PASS_MODES) never use Munin's persona pipeline: they need the
// exact document text and a JSON answer, so Munin runs them in raw mode like any tools turn.
const isDocPass = (mode) => DOC_PASS_MODES.includes(mode);
const isMuninPersona = (mode, snap) => isPersonaMode(mode) && !isDocPass(mode) && snap.prov.personas;
// Per-call limits of the line views of read_document for a provider (the defaults when it is not known).
const readLimits = (prov) => ({
  chars: (prov && prov.readMaxChars) || READ_MAX_CHARS,
  lines: (prov && prov.readMaxLines) || READ_MAX_LINES,
});
// Providers with a prompt cache (OpenAI, Anthropic): older turns are sent exactly as they were, so the
// cached prefix stays valid. Munin has none: the context of older turns is sent shortened (shortContext).
// Munin has no prompt cache and a custom server's is unknown (its window is small too): they get the lean history.
const cachesPrompt = (prov) => prov.id === 'openai' || prov.id === 'anthropic';
// The tools as a request sends them: strict schemas for OpenAI and Anthropic, compact ones (tools.js compactSchema) for
// Munin and custom servers (no strict mode, no prompt cache: about a sixth of the tool block, and Qwen stops writing
// a null for every unused field). OpenAI and Anthropic get their tools that are not strict compact too (strictFor).
const sentTools = (tools, prov) => tools.map((t) => (cachesPrompt(prov) && strictFor(t, prov) ? t : compactTool(t)));
// The provider's server-side web search tool (OpenAI, Anthropic): every main turn with client tools (Manual, Auto, Plan,
// /side, /research and /chat; the model decides when to search), an agent only when started with search
// (agents.js: snap.agentSearch). Not in the quiet loops (the self-test's scenarios, guideline coverage), the document
// passes or Munin's persona pipeline (no client tools). The request builders also leave it out of a request without
// tools (the self-test's probe, the wrap-up round).
const webSearchTurn = (mode, snap) => WEB_SEARCH_PROVIDERS.includes(snap.prov.id) && !isDocPass(mode) &&
  (snap.agent ? !!snap.agentSearch : !snap.quiet);
// Every turn with client tools: the reading tools, open_document (and the "doc" parameter of the
// reading tools); Munin persona turns get a document excerpt in the prompt instead.
const offersOpenDocument = (mode, snap) => !isMuninPersona(mode, snap);
// remember: every turn with open_document except a side question (/side leaves nothing behind), Plan (read-only) and a
// read-only agent (agents.js).
const offersRemember = (mode, snap) => offersOpenDocument(mode, snap) && !snap.side && mode !== 'plan' && !(snap.agent && snap.agent.access === 'read');

// Keyword offers (the reference tools, guideline_coverage, chat_title): whether the chat's user messages ask for a
// feature. On a provider with a prompt cache (OpenAI, Anthropic: tools, then system, then messages form the cached
// prefix) an offer made once in a chat stays for the rest of it: any earlier user message of the chat counts, so the
// tool list and the head do not change back on the next turn and rewrite the cache of the whole chat. Munin and custom
// servers have no cache: only the newest message counts, so an unrelated turn's request stays small. The history is
// the chat's own (compacted messages included: they stay in it), so nothing extra is stored. current: the newest
// message's text when it is not in the history yet (a beforeTurn hook); else the newest user message counts.
function chatAsked(snap, test, current) {
  const msgs = ((snap && snap.chatCtx && snap.chatCtx.messages) || []).filter((m) => m && m.role === 'user' && !m._auto && !m._summary);
  const newest = current !== undefined ? current : msgs.length ? msgs[msgs.length - 1].content : '';
  if (test(String(newest || ''))) return true;
  if (!snap || !snap.prov || !cachesPrompt(snap.prov)) return false;
  return msgs.some((m) => test(String(m.content || '')));
}

// On-demand offers (table, page_parts, models, style_map, document_styles): on Munin and custom servers (no prompt cache,
// a small window) a tool with a large definition and a rare use is offered only when the turn needs it: the newest user
// message (with an agent's brief) names its subject (test), or extra says so (the document has the object, a Formatting
// line…). A short reply ("yes", "do it") or Do it counts with the answer it replies to, which named the subject. Every
// round of a turn asks the same question, so the tool list stays the same within it. Providers with a prompt cache keep
// such a tool always on: the cached prefix stays valid. A call of the tool when it is not offered still runs
// (registerTools runs: its old condition).
const ON_DEMAND_SHORT_WORDS = 12;
const onDemandProvider = (snap) => !!snap && !!snap.prov && !cachesPrompt(snap.prov);
function onDemandText(snap) {
  const msgs = (snap && snap.chatCtx && snap.chatCtx.messages) || [];
  const brief = snap && snap.agent && typeof snap.agent.task === 'string' ? snap.agent.task + '\n' : '';
  let u = msgs.length - 1;
  while (u >= 0 && !(msgs[u] && msgs[u].role === 'user' && !msgs[u]._auto && !msgs[u]._summary)) u--;
  if (u < 0) return brief + String(lastSentText() || ''); // a snapshot without the chat: the message being sent
  const text = String(msgs[u].content || '');
  if (text !== PLAN_DO_TEXT && countWords(text) > ON_DEMAND_SHORT_WORDS) return brief + text;
  for (let i = u - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'user' && !m._auto) break;
    if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return `${brief}${m.content}\n${text}`;
  }
  return brief + text;
}
function onDemandOffer(snap, test, extra = false) {
  if (!onDemandProvider(snap) || extra) return true;
  try { return !!test(onDemandText(snap)); } catch (e) { return false; }
}

// Sticky offers (comment, find_relevant_sections): on a provider with a prompt cache an offer made once in a chat stays
// for the rest of it, as chatAsked keeps a keyword offer, so the tool list does not change back and rewrite the cache.
// The offer is recorded on the turn's user message (_offers, never sent) by the finish hook below. On Munin and custom
// servers each turn decides on its own (now).
function stickyOffer(snap, key, now) {
  if (!snap || !snap.prov || !cachesPrompt(snap.prov)) return !!now;
  if (now) { (snap.stickyOffers || (snap.stickyOffers = new Set())).add(key); return true; }
  const msgs = (snap.chatCtx && snap.chatCtx.messages) || [];
  return msgs.some((m) => m && m.role === 'user' && Array.isArray(m._offers) && m._offers.includes(key));
}
registerTurnHook('finish', (userMsg, snap) => {
  if (!userMsg || !snap || !snap.stickyOffers || !snap.stickyOffers.size) return;
  userMsg._offers = [...new Set([...(Array.isArray(userMsg._offers) ? userMsg._offers : []), ...snap.stickyOffers])];
});

// The tools of a turn, in Chat Completions format (converted per provider below): the reading tools,
// open_document, remember, replace_selection in an editing turn (Manual or Auto), plus there the writing tools when the
// document was read through the Docs API. Munin persona turns have none.
function toolsFor(mode, snap) {
  // A document pass reads only the main document, and only when its text did not fit into the request.
  if (isDocPass(mode)) return docPassInline(snap) ? [] : READING_TOOLS.map((n) => TOOL_DEFS[n]);
  const names = [];
  if (offersOpenDocument(mode, snap)) names.push(...READING_TOOLS);
  if (offersOpenDocument(mode, snap)) names.push('open_document', ...(offersRemember(mode, snap) ? ['remember'] : []));
  if (apiEditing(mode, snap)) names.push(...WRITE_TOOLS);
  if (canEdit(mode)) names.push(REPLACE_TOOL.function.name);
  // Registered tools (registerTools) after the built-in ones, so the built-in prefix of the request stays as it was.
  const extra = offersOpenDocument(mode, snap) ? extraToolDefs(mode, snap) : [];
  // An agent (agents.js) does not ask the user: a blocked agent ends with "Blocked: <question>" for the main model.
  return [...names.map((n) => TOOL_DEFS[n]), ...(snap.agent ? extra.filter((t) => t.function.name !== 'ask_user') : extra)];
}
// Strict mode is per tool on both providers. edit_document goes without it, with its compact schema (Munin's): strict, a
// provider writes every field of an operation's variant, mostly null (a typical batch of 22 operations: 4,277 characters
// strict, 1,808 compact), and the definition is less than half as long (4,194 characters strict, 1,949 compact). The run
// code reads a missing field as null and checks every operation itself (docs-write.js planOperation).
const LOOSE_TOOLS = ['edit_document'];
// Anthropic compiles the strict schemas of a request together, with limits across all of them: 20 strict tools, 24
// optional parameters, 16 parameters with a union type (anyOf: every nullable field here). The whole set has about 60 such
// fields, so only these stay strict there: the writing tools with few nullable fields, then the tools whose scope, enums or
// nested questions models get wrong (10 union fields: test/anthropic-strict.test.js). The others go compact, edit_document's
// way; format_text and format_lines too (11 and 14 nullable fields, the same fields edit_document's operations take loose).
// A fixed list, never per turn: the tool block opens the cached prefix.
const ANTHROPIC_STRICT_TOOLS = ['replace_text', 'replace_all', 'replace_section', 'insert_after_line', 'delete_lines', 'replace_selection',
  'read_document', 'style_map', 'document_styles', 'remember', 'ask_user'];
// Whether a tool goes strict to a provider with strict mode (OpenAI, Anthropic); the others get it compact.
const strictFor = (t, prov) => (prov.id === 'anthropic' ? ANTHROPIC_STRICT_TOOLS.includes(t.function.name) : !LOOSE_TOOLS.includes(t.function.name));
const providerSchema = (t, strict) => (strict ? { schema: t.function.parameters, strict: true } : { schema: compactSchema(t.function.parameters), strict: false });
const toOpenAiTool = (t) => { const { schema, strict } = providerSchema(t, strictFor(t, { id: 'openai' })); return { type: 'function', name: t.function.name, description: t.function.description, parameters: schema, strict }; };
// loose: no tool strict (the API refused the strict ones for the account's model: anthropicStrictRefused). A tool that is
// not strict goes without the field (the API's advice where strict mode is not available: leave it out).
function toAnthropicTool(t, loose = false) {
  const { schema, strict } = providerSchema(t, !loose && strictFor(t, { id: 'anthropic' }));
  return { name: t.function.name, description: t.function.description, input_schema: schema, ...(strict ? { strict } : {}) };
}
const isReadingTool = (tc) => !!(tc && tc.function && (QUIET_TOOLS.includes(tc.function.name) || isExtraReading(tc.function.name, parseToolArgs(tc).args)));
const offersWriteTools = (tools) => tools.some((t) => WRITE_TOOLS.includes(t.function.name));
// The tools that write document text: the Docs API writing tools or replace_selection (the export path's paste).
const offersEditTools = (tools) => offersWriteTools(tools) || tools.some((t) => t.function.name === REPLACE_TOOL.function.name);

// Everything a turn's requests depend on, captured once per turn (sendMessage) so that every round
// of the tool loop sends the same provider settings, system prompt and tools: the selection is
// cleared after a successful replacement, and settings can be saved while a request runs. A stable
// prefix also keeps the providers' prompt caches warm and keeps replayed Anthropic thinking blocks valid.
// The reading tools read from this snapshot too.
// With the Docs API the writing tools update the snapshot's document after every edit (so the reading
// tools see it); the system prompt keeps using the state at the start of the turn (promptView).
// prov: the PROVIDERS entry of the chat's account type; cfg: { apiKey, model, accountId, name, baseUrl? } of the chat's
// account and model (settings.js activeConfig; accountId null when the chat has no account).
function takeSnapshot() {
  const prov = activeProvider();
  return {
    prov, cfg: { ...activeConfig() },
    signal: null, // the turn's abort signal: Stop rejects a pending open_document card
    docText: null, docFormat: 'text', docTitle: '', docError: '', selection: '', lines: null, model: null, promptView: null,
    selectionCtx: null, // the selection's surroundings in the editor's text (tab-bridge.js readSelectionContext)
    // Document instructions, the documents opened in the chat (open_document: the list grows during the
    // turn, the prompt keeps the list from the start) with the document's attached files, and their content read in
    // this turn (alias -> doc).
    docInstructions: '', mainInstructions: '', docId: null, docs: [], docCache: new Map(), googleConnected: false, chatCtx: null, mainUrl: '',
    openAll: false, // "Allow all in this turn" on an open_document card
    pasteDone: false, // replace_selection pasted in this turn: a second paste is refused (runToolCall)
    askEdits: false, // Manual: every write asks on a permission card (gate.js gateAsks); startTurn sets it for a Manual message
  };
}
function snapshotDocument(snap) {
  Object.assign(snap, {
    docText: state.docText, docFormat: state.docFormat, docTitle: state.docTitle, docError: state.docError,
    selection: state.selection, selectionCtx: state.selectionCtx || null, lines: null, model: state.docFormat === 'docs-api' ? state.docModel : null,
    docInstructions: String(state.docInstructions || '').slice(0, DOC_INSTRUCTIONS_MAX),
    mainInstructions: String(state.mainInstructions || '').slice(0, DOC_INSTRUCTIONS_MAX), docId: state.docId,
    docs: turnDocs(), docCache: new Map(), googleConnected: state.googleConnected,
  });
  const { docText, docFormat, docTitle, docError, selection, model } = snap;
  snap.promptView = { docText, docFormat, docTitle, docError, selection, model, lines: null, docs: snap.docs.map((d) => ({ ...d })) };
}
// The chat's opened documents, then the document's files (every chat of the document sees them; a file whose alias an
// opened document of this chat holds is left out, so an alias always names one thing).
function turnDocs() {
  const docs = chatDocs(state.chatId);
  return [...docs, ...docFileEntries(state.docId ? state.docFiles : []).filter((f) => !docs.some((d) => d.alias === f.alias))];
}
const docLines = (snap) => snap.lines || (snap.lines = (snap.docText || '').split('\n'));

// ---- Document structure (tools mode) -------------------------------------------------------
// Headings with the 1-based line where each section starts: from the paragraph styles (Docs API),
// or Markdown headings (export; code fences are skipped). Empty for a plain-text export.
// An attached file's view brings its own outline (attachments.js: headings or its PDF pages).
const hasOutline = (snap) => Array.isArray(snap.outline) || snap.docFormat === 'markdown' || (snap.docFormat === 'docs-api' && !!snap.model);
function docOutline(snap) {
  if (Array.isArray(snap.outline)) return snap.outline;
  if (snap.docText == null) return [];
  if (snap.docFormat === 'docs-api' && snap.model) {
    // The document's title: a lone top-level heading before the others (docTitleHeading), not a section heading.
    const top = docTitleHeading(snap.model);
    return snap.model.lines.filter((l) => l.heading && l.text.trim())
      .map((l) => ({ line: l.line, level: l.heading, title: l.text.trim(), style: l.style, ...(top === l ? { docTitle: true } : {}) }));
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
// Markdown items as "L5: ## Methods", Docs API items with their style: "L1: [Title] ...", "L5: [H2] Methods", a heading
// that is the document's title "L1: [H1 title] Report".
const styleLabel = (style) => (style === 'TITLE' ? 'Title' : style === 'SUBTITLE' ? 'Subtitle' : 'H' + String(style).replace('HEADING_', ''));
const formatOutline = (items) => items.map((h) => `L${h.line}: ${h.style ? `[${styleLabel(h.style)}${h.docTitle ? ' title' : ''}]` : '#'.repeat(h.level)} ${h.title}`).join('\n');

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
  // The only place where all selected lines follow each other, else the first line's first occurrence; of several
  // places, the one the selection's surroundings in Docs point to (placeByContext), when they clearly do.
  const ends = [];
  const places = selectionPlaces(doc, sel, findFrom, ends);
  const picked = places.length > 1 ? placeByContext(snap, raw, sel, places, ends) : null;
  const occurrences = picked ? 1 : places.length;
  const start = picked ? picked.line : occurrences === 1 ? places[0] : findFrom(sel[0], 0);
  if (start < 0) return null;
  const last = sel.length - 1;
  const found = picked ? picked.end : sel.length === 1 ? start : findFrom(sel[last], start);
  const end = found < 0 ? start : found;
  const first = normLineMap(raw[start]);
  const k0 = picked ? picked.k : first.text.indexOf(sel[0]);
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
  return { start: start + 1, end: end + 1, startChar, endChar, approx, ...(occurrences > 1 ? { occurrences, places: places.map((i) => i + 1) } : {}) };
}
// Where an ambiguous selection (span.occurrences > 1) may be: "the same text is on lines 8 and 17" ("starts on" for a
// selection of several lines), at most SELECTION_PLACES_SHOWN lines named.
const SELECTION_PLACES_SHOWN = 6;
function selectionPlacesText(span) {
  const shown = span.places.slice(0, SELECTION_PLACES_SHOWN);
  const more = span.places.length - shown.length;
  const list = more > 0 ? `${shown.join(', ')} and ${more} more` : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return `the same text ${span.end > span.start ? 'starts' : 'is'} on lines ${list}`;
}
// The lines (0-based) where the selection could start: for a one-line selection the lines that contain its
// text (repeats within one line do not make its line number ambiguous), for a longer one the lines with
// its first line from which the other selected lines follow in order, with only blank or very short lines
// (the ones a selection skips too) between them. ends receives the last line of each place.
function selectionPlaces(doc, sel, findFrom, ends = []) {
  const out = [];
  if (sel.length === 1) {
    doc.forEach((d, i) => { if (d && d.includes(sel[0])) { out.push(i); ends.push(i); } });
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
    if (j >= 0) { out.push(i); ends.push(j); }
  }
  return out;
}

// ---- The selection's place from its surroundings -------------------------------------------------------------------
// When the selected text is in several places, its surroundings in Docs' own text (snap.selectionCtx: the editor's text
// just before and after the selection, tab-bridge.js readSelectionContext) choose one: the place whose document text
// around it reads the same, when it clearly does. Only letters and digits are compared, lower-cased: Docs' structure
// marks, whitespace, punctuation and the export's Markdown (link targets, list markers, footnote marks) differ between
// the two texts. The surroundings belong to one selection text (ctx.text): any other selection ignores them.
const SELECTION_CONTEXT_MARGIN = 12; // letters and digits the winner must match beyond any place elsewhere
const SELECTION_CONTEXT_WINDOW = 400; // characters of document text read on each side (Markdown takes room)
const SELECTION_CONTEXT_MAX_PLACES = 1000; // more occurrences than this: not compared (the place stays unknown)
const selectionContextOf = (selection, ctx) => (ctx && selection && ctx.text === selection &&
  typeof ctx.before === 'string' && typeof ctx.after === 'string' ? ctx : null);
function contextPlain(s, format) {
  let t = String(s || '');
  if (format !== 'docs-api') {
    t = t.replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, '') // images
      .replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, ']') // link targets
      .replace(/\[\^[^\]]*\]/g, '') // footnote marks
      .replace(/^[ \t]*(?:\d+[.)]|[-*+])[ \t]+/gm, ''); // list markers
  }
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
const commonEnd = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };
const commonStart = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
// Of the candidates ({ from, to: the occurrence's offsets in text, group: its place }) the one whose surroundings match
// ctx ({ before, after }: Docs' text, compared as it is) best, when it beats every candidate of another place by
// SELECTION_CONTEXT_MARGIN; else null. format: the document text's (snap.docFormat; the export's Markdown is stripped).
function pickByContext(text, cands, ctx, format) {
  if (!ctx || cands.length < 2 || cands.length > SELECTION_CONTEXT_MAX_PLACES) return null;
  const before = contextPlain(ctx.before, 'docs-api');
  const after = contextPlain(ctx.after, 'docs-api');
  let best = null;
  const scored = cands.map((c) => {
    const s = commonEnd(before, contextPlain(text.slice(Math.max(0, c.from - SELECTION_CONTEXT_WINDOW), c.from), format)) +
      commonStart(after, contextPlain(text.slice(c.to, c.to + SELECTION_CONTEXT_WINDOW), format));
    const x = { c, s };
    if (!best || s > best.s) best = x;
    return x;
  });
  const rival = scored.reduce((m, x) => (x.c.group !== best.c.group && x.s > m ? x.s : m), 0);
  return best.s - rival >= SELECTION_CONTEXT_MARGIN ? best.c : null;
}
// Of several places (0-based first lines; ends: their last lines) the one the selection's surroundings point to:
// { line, end, k (where the selection starts in the line's normLine text) }, or null.
function placeByContext(snap, raw, sel, places, ends) {
  const ctx = selectionContextOf(snap.selection, snap.selectionCtx);
  if (!ctx) return null;
  const lineAt = [];
  for (let i = 0, off = 0; i < raw.length; off += raw[i].length + 1, i++) lineAt.push(off);
  const last = sel.length - 1;
  const cands = [];
  places.forEach((i, n) => {
    const a = normLineMap(raw[i]);
    const b = ends[n] === i ? a : normLineMap(raw[ends[n]]);
    const k1 = sel.length === 1 ? 0 : b.text.indexOf(sel[last]);
    if (k1 < 0) return;
    // One line: every occurrence in it; several: where the first selected line starts (it runs to the line's end).
    for (let k = a.text.indexOf(sel[0]); k >= 0; k = sel.length === 1 ? a.text.indexOf(sel[0], k + 1) : -1) {
      const e = sel.length === 1 ? k + sel[0].length - 1 : k1 + sel[last].length - 1;
      cands.push({ group: i, line: i, end: ends[n], k, from: lineAt[i] + a.map[k], to: lineAt[ends[n]] + b.map[e] + 1 });
    }
  });
  // Edge lines the search skips (under three characters) are part of the selection, not of its surroundings.
  const lines = snap.selection.split('\n');
  const kept = lines.map((l, x) => (normLine(l.trim()).length >= 3 ? x : -1)).filter((x) => x >= 0);
  const head = lines.slice(0, kept[0]).join('\n');
  const tail = lines.slice(kept[kept.length - 1] + 1).join('\n');
  return pickByContext(snap.docText, cands, { before: ctx.before + head, after: tail + ctx.after }, snap.docFormat);
}
// The selection line of a tools-mode turn context: where the selection is and how big it is, e.g. "Selection: lines
// 12–48 (3,215 characters)", and the text of a short one (selectionText) in a <selection> block after it. Without the
// text the model reads it with get_selection or read_document: on Munin a round that resends the whole request (about
// 8,200 tokens in Auto with the Docs API) where the text costs at most 500 tokens per round.
// liveSnap: the turn's snapshot, told that the text was shown (noteSelectionShown); omitted, nothing is noted.
const SELECTION_TEXT_LEAD = 'Its text (no need for get_selection):';
const SELECTION_PLACES_EDIT = 'Other edits: only the place the request means ("this heading": the heading line), or ask the user; never all of them.';
function selectionLine(snap, liveSnap = null) {
  const size = `${fmtNum(snap.selection.length)} character${snap.selection.length === 1 ? '' : 's'}`;
  const span = selectionSpan(snap);
  const text = selectionText(snap);
  if (text && liveSnap) noteSelectionShown(liveSnap, span);
  const shown = text ? `\n${SELECTION_TEXT_LEAD}\n<selection>\n${text}\n</selection>` : '';
  if (!span) return `Selection: ${size}; its position in the document was not found${shown ? `.${shown}` : ' (read it with get_selection).'}`;
  // Several occurrences: their lines, none of them as the selection's. Any other edit goes to one of them: a live Qwen,
  // told only about replace_selection, formatted every occurrence (format_text all).
  if (span.occurrences > 1) {
    return `Selection: ${size}; ${selectionPlacesText(span)}, so which one is selected is not known. ${shown ? '' : 'Read it with get_selection; '}replace_selection replaces exactly what the user selected. ${SELECTION_PLACES_EDIT}${shown}`;
  }
  const where = span.start === span.end ? `line ${span.start}` : `lines ${span.start}–${span.end}`;
  return `Selection: ${where} (${size}${span.approx ? '; position approximate' : ''})${shown}`;
}
// The selection's text for the turn context, or '' when it is longer than CONTEXT_SELECTION_TEXT_MAX or would break out
// of its <selection> block (document text is data: the block is where it ends).
const CONTEXT_SELECTION_TEXT_MAX = 1500;
function selectionText(snap) {
  const text = String(snap.selection || '');
  return text.trim() && text.length <= CONTEXT_SELECTION_TEXT_MAX && !/<\/?selection\b/i.test(text) ? text : '';
}
// The model already has the selection's text: its get_selection call is answered with a pointer to it (tools.js
// readAgain; the identical call after that reads), and the selected lines count as read for the read-first check of
// gate.js, as after a get_selection.
const SELECTION_SHOWN_TEXT = 'The selection is in the user message, in full (<selection>).';
function noteSelectionShown(snap, span) {
  noteRead('get_selection', {}, snap, SELECTION_SHOWN_TEXT);
  if (!span || span.occurrences > 1) return;
  const seen = snap.seenLines || (snap.seenLines = new Set());
  for (let i = span.start; i <= span.end; i++) seen.add(i);
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
// The opening of a tools-mode head: who the assistant is and one line on what the panel offers, so the model can point
// the user to the other modes and the commands (it cannot switch or run them itself). Names only: the user sees what
// each does in the panel. Static per mode; the undo clause follows the Docs API path (undo needs it). delegate has no
// line here: its definition says what an agent is for. An agent (snap.agent) reports to the main assistant, never to
// the user: it gets only the first sentence.
const CAPABILITY_INTRO = 'You are an editing assistant in the Munin Assistant panel next to a Google Docs document. You read the document with tools and help the user write, revise and check it.';
const CAPABILITY_COMMANDS = '; commands: /check, /review, /research, /side';
// The mode menu's names (in its order) by turn mode; an editing turn sent in Manual (snap.askEdits) is Manual.
const MODE_NAMES = { manual: 'Manual', edit: 'Auto', plan: 'Plan' };
// Manual: the user allows each write on a card, so many small calls mean many clicks.
const MANUAL_ASKS_CLAUSE = '; the user allows each edit on a card, so group related changes into one call';
function capabilityParagraph(mode, snap) {
  if (snap.agent) return CAPABILITY_INTRO;
  const lead = `${CAPABILITY_INTRO}\nThe panel (mention it when it helps; you cannot switch modes or run commands yourself): `;
  // The read-only chat turn (/side; the self-test's question) is no mode of the menu, whatever the mode button shows: it
  // names the modes a normal message runs in. No undo clause: it makes no edit.
  if (mode === 'manual') return `${lead}this is a read-only ${snap.side ? 'side question' : 'turn'}; modes for normal messages: ${Object.values(MODE_NAMES).join(', ')}${CAPABILITY_COMMANDS}.`;
  const cur = canEdit(mode) ? (snap.askEdits ? 'manual' : 'edit') : mode;
  const undo = snap.docFormat === 'docs-api' ? '; every edit can be undone' : '';
  const asks = canEdit(mode) && snap.askEdits ? MANUAL_ASKS_CLAUSE : '';
  const others = Object.keys(MODE_NAMES).filter((m) => m !== cur).map((m) => MODE_NAMES[m]).join(', ');
  // Plan stays short (no writing rules either): no commands.
  return `${lead}this is ${MODE_NAMES[cur]} mode${undo}${asks}; other modes: ${others}${mode === 'plan' ? '' : CAPABILITY_COMMANDS}.`;
}

// Instructions for a tools-mode turn ("edit", "manual" or "plan"), in the order mandatory rules, mode, document context
// (promptHead adds MAIN.md and DOC.md; the task is the user message): the capability paragraph, coreRules, how the
// document is read, then the mode's rules. The tools themselves are described only by their definitions (tools.js);
// the prompt adds the provider's per-call limits and the registered tools' lines (registerPromptLine).
// When to use ask_user (its definition says how): the questions a reply would otherwise end with go on its card.
// Agents cannot ask the user (no ask_user), so their head leaves it out.
const ASK_RULE = 'Questions you need answered before writing go in one ask_user call, not in your answer text.';
function toolsInstructions(mode, snap) {
  const api = snap.docFormat === 'docs-api';
  const edit = canEdit(mode);
  const format = snap.docFormat === 'markdown'
    ? 'exported as Markdown (headings start with "#", emphasis uses * or _, links are [text](url))'
    : api ? `read through the Google Docs API as plain text: one line per paragraph (table cells are separate lines${lineDecoratorNotes()}, in reading order); "${OBJECT_CHAR}" is an embedded object (image, chip, page break; you see only an image's alt text, and the chat takes no images), "${SOFT_BREAK_MARK}" a soft line break inside a paragraph`
      : 'exported as plain text';
  // Plan and the read-only chat turns make no edits and read the frozen snapshot, so the outline of the message is current all turn.
  const fresh = api && edit
    ? 'The reading tools always show the current text: it is re-read at every user message and after every edit you make. An insertion or deletion shifts the later line numbers; the outline in the user message is from when it was sent (read_document scope "outline" gives the current one).'
    : api ? 'The text is re-read at the start of every user message.'
      : 'The text is re-read at the start of every user message; within one message a replacement is not yet visible to the reading tools.';
  const act = mode === 'manual' ? 'answer with the block' : mode === 'plan' ? 'give the plan' : 'edit the document';
  const limits = readLimits(snap.prov);
  const reading = `The document text is NOT included in the messages; you read it with tools. It is ${format}. ${fresh}
read_document returns at most ${limits.lines} lines or about ${fmtNum(limits.chars)} characters per call.${extraPromptLines('reading', mode, snap).map((l) => '\n' + l).join('')}
Read what you need before answering${edit ? ' or editing' : ''}: usually the selection (get_selection) and the lines around it, or the relevant section (for structure or content questions, the outline and the relevant lines); build on what is there, and do not read the whole document unless the request needs it.
When the user approves your proposal ("ok", "fine", "go ahead"), ${act} in this turn; do not ask again unless something essential is missing.${snap.agent ? '' : `\n${ASK_RULE}`}`;
  const rules = snap.agent ? agentModeRules(mode, snap)
    : mode === 'manual' ? TOOLS_MANUAL_RULES : mode === 'plan' ? TOOLS_PLAN_RULES : apiEditing(mode, snap) ? apiEditRules(extraPromptLines('edit', mode, snap)) : TOOLS_EDIT_RULES;
  // Web search (OpenAI, Anthropic) right after the reading section: static per provider, so the head stays cached.
  const search = webSearchTurn(mode, snap) ? `\n\n${WEB_SEARCH_NOTE}` : '';
  return `${capabilityParagraph(mode, snap)}\n\n${coreRules(mode)}\n\n${reading}${search}\n\n${rules}`;
}

// An agent's mode rules: the main turn's, without what shapes an answer to the user (an editing turn's "add nothing", a
// read-only turn's <replacement> blocks and "suggest Auto or Plan", Plan's plan and ask_user step): its last message is the report
// AGENT_PREFACE describes (AGENT_REPORT_RULE).
function agentModeRules(mode, snap) {
  if (canEdit(mode)) {
    return apiEditing(mode, snap) ? apiEditRules(extraPromptLines('edit', mode, snap), AGENT_REPORT_RULE)
      : TOOLS_EDIT_RULES.replace('When it returns Done, add nothing: the edit card already shows what changed.', AGENT_REPORT_RULE);
  }
  if (mode === 'plan') return `${TOOLS_PLAN_RULES.split('\n')[0]}\n${AGENT_REPORT_RULE}`;
  return `${TOOLS_MANUAL_RULES.split('\n')[0]}\n${AGENT_REPORT_RULE}\n\n${WRITING_RULES}`;
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
    const style = measuredLines(snap);
    if (style) docBlock += `\n${style}`; // the measured lines (tools turns have them in the turn context)
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
  // An agent (agents.js) gets its preface first; the main turn's head stays as it was (prompt caching).
  const preface = snap.agent ? `${AGENT_PREFACE}\n\n` : '';
  return { head: promptHead(preface + instructions, '', mode, snap), tail: '' };
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
  if (!hasOutline(snap)) outline = '[Outline unavailable: the document could only be exported as plain text. Use find_in_document and read_document.]';
  else if (!items.length) outline = '[The document has no headings.]';
  else {
    outline = 'Outline (line: heading):\n' + formatOutline(items.slice(0, OUTLINE_MAX_ITEMS)) +
      (items.length > OUTLINE_MAX_ITEMS ? `\n[${items.length - OUTLINE_MAX_ITEMS} more headings: call read_document with scope "outline"]` : '');
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
// opts.runAs: the line that names the model (runAsLine) is added: a chat's first turn, a turn after a model change, an
// agent's first message.
function buildTurnContext(mode, liveSnap, prevFacts, opts = {}) {
  if (!offersOpenDocument(mode, liveSnap)) return '';
  const snap = { ...liveSnap, ...(liveSnap.promptView || {}), lines: null };
  if (mode === 'card') return documentBlock(snap); // the paper card build: the document only (docPassContext adds the rest)
  const parts = [documentBlock(snap) + extraDocNotes(mode, snap) + (offersOpenDocument(mode, snap) ? openedDocsNote(snap) : '')];
  const style = measuredLines(snap);
  if (style) parts.push(style);
  const changes = docChangesNote(prevFacts, docFacts(snap));
  if (changes) parts.push(changes);
  // The beforeTurn hooks' lines (registry.js), asked by the turn before this call.
  for (const line of liveSnap.turnLines || []) parts.push(line);
  // Where the selection is and its size, and the text of a short one (selectionLine).
  parts.push(snap.selection ? selectionLine(snap, liveSnap) : `Current selection in the document:\n${noSelectionBlock(mode)}`);
  // The model this turn runs on (the head names the panel, not the model).
  if (opts.runAs) { const line = runAsLine(liveSnap); if (line) parts.push(line); }
  // Last, after the state of the document: the models delegate can run on (agents.js), when another account has a key.
  const agents = agentsLine(mode, liveSnap);
  if (agents) parts.push(agents);
  // The agents of this document still running (agents.js): their reports come later; the model should not start them again.
  const running = agentsRunningLine(liveSnap);
  if (running) parts.push(running);
  return parts.join('\n');
}

// "You run as <model> (<type label>, account <name>)." for the snapshot's account, or '' without one.
function runAsLine(snap) {
  const cfg = snap && snap.cfg;
  if (!cfg || !cfg.model || !snap.prov) return '';
  // The account is named only when it is not the type's default name (one account of the type: nothing to tell apart).
  const own = cfg.name && cfg.name !== snap.prov.name ? `, account ${cfg.name}` : '';
  return `You run as ${cfg.model} (${snap.prov.label}${own}).`;
}
// What a user message records of the model it was sent to (_model): "<account id>/<model>".
const runAsTag = (snap) => `${(snap.cfg && snap.cfg.accountId) || snap.prov.id}/${(snap.cfg && snap.cfg.model) || ''}`;
// The run-as line is due when the chat's previous user message was sent to another model (or there is none).
function runAsDue(messages, snap) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user' && !messages[i]._auto) return messages[i]._model !== runAsTag(snap);
  return true;
}

// ---- Measured style of the document ---------------------------------------------------------
// A few numbers the writing rules can be matched against, from the first STYLE_SAMPLE_CHARS characters of the
// text. Sentences and words come from src/text-segments.js (Intl.Segmenter with the abbreviation merge pass:
// "3.5", "Fig. 3", "e.g. the" and "рис. 2" do not split a sentence; "well-known" and "1,000" are one word); a line
// without a final . ! ? or … (a heading, a list item) is not counted as a sentence. Dashes: every em dash, plus an
// en dash or a hyphen with spaces on both sides (a range like "1–3" is not a dash). Hedges per 100 words and the share
// of sentences with a passive come from src/doc-conventions.js (passive: English only, null for a Russian text).
// Returns null below STYLE_MIN_WORDS or with fewer than STYLE_MIN_SENTENCES sentences (a list or a table, not prose).
// Cached per text: the turn context and the per-write checks of a snapshot measure it once.
const STYLE_MIN_SENTENCES = 5;
const docStyleStats = memoByText((text) => {
  const sample = String(text || '').slice(0, STYLE_SAMPLE_CHARS);
  const words = countWords(sample);
  if (words < STYLE_MIN_WORDS) return null;
  const lang = textLang(sample);
  let sentences = 0;
  let sentenceWords = 0;
  let passive = 0;
  for (const s of splitSentences(sample, lang)) {
    if (!endsSentence(s)) continue;
    const n = countWords(s);
    if (n) { sentences++; sentenceWords += n; if (isPassive(s)) passive++; }
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
    hedgesPer100: Math.round((hedgeCount(sample) * 1000) / words) / 10,
    passivePercent: lang === 'ru' ? null : Math.round((passive * 100) / sentences),
    quotes: quoteKinds.length ? quoteKinds[0][0] : null,
  };
});
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
  parts.push(`hedges ${st.hedgesPer100}/100 words`);
  if (st.passivePercent != null) parts.push(`passive ${st.passivePercent}%`);
  if (st.quotes) parts.push(`quotes ${st.quotes}`);
  const bold = bodyBold(snap);
  if (bold != null) parts.push(`bold in body: ${bold ? 'yes' : 'no'}`);
  return `Style of the document: ${parts.join('; ')}.`;
}
// The measured lines of a document long enough to measure: the style line, then the conventions and the glossary lines
// (src/doc-conventions.js), each only when it found something; '' for a short or missing text.
function measuredLines(snap) {
  const style = styleLine(snap);
  if (!style) return '';
  return [style, conventionsLine(snap), glossaryLine(snap)].filter(Boolean).join('\n');
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
// A turn context without the <document> block, the style, conventions and terms lines, the run-as line, the Agents and Agents running lines (the
// current turn has its own) and the selection's text (selectionLine: its position and size stay, so the texts of a
// chat's selections do not add up; a context stored before the selection became a line range keeps a short one). The
// selection line and <document_changes> stay: they say what that message was about.
const SHOWN_SELECTION_RE = new RegExp(`\\n${SELECTION_TEXT_LEAD.replace(/[()]/g, '\\$&')}\\n<selection>\\n[\\s\\S]*?\\n</selection>`);
function shortContext(ctx) {
  return String(ctx)
    .replace(SHOWN_SELECTION_RE, '')
    .replace(/\nStyle of the document: [^\n]*/, '')
    .replace(/\nConventions: [^\n]*/, '')
    .replace(/\nTerms: [^\n]*/, '')
    .replace(/\nYou run as [^\n]*/, '')
    .replace(/\nAgents: delegate runs on [^\n]*/, '')
    .replace(/\nAgents running: [^\n]*/, '')
    .replace(/^<document\b[^>]*>[\s\S]*?<\/document>\n?/, '')
    .replace(/(<selection\b[^>]*>)([\s\S]*)(<\/selection>)/, (all, open, body, close) => (body.length > CONTEXT_SHORT_SELECTION_CHARS
      ? `${open}[selected text omitted: from an earlier message]${close}` : all));
}

// The system prompt head: the role instructions (plus the remember note when the turn offers that tool),
// the main and the document instructions (when set), then, in Munin persona turns, the <document> excerpt, then the
// untrusted-data note (every turn: what the assistant reads is data). A tools-mode head (toolsInstructions) has the
// note among its core rules at the top and ends with MAIN.md and DOC.md, next to the user's message.
function promptHead(instructions, docBlock, mode, snap) {
  // The remember note only where the tool is offered (toolsFor): not in a side question or in Plan.
  // Not for an agent: it works on its brief, and the note's "ask whether to add it" has nobody to ask.
  const parts = [offersRemember(mode, snap) && !snap.agent ? `${instructions}\n\n${REMEMBER_NOTE}` : instructions];
  const di = docInstructionsBlock(snap);
  if (di) parts.push(di);
  if (docBlock) parts.push(docBlock); // Munin persona turns only: they have no open_document
  if (!instructions.includes(UNTRUSTED_DATA_NOTE)) parts.push(UNTRUSTED_DATA_NOTE); // static, so it stays cached
  return parts.join('\n\n');
}
// The main instructions (MAIN.md), then the document's (DOC.md); '' when both are empty.
function docInstructionsBlock(snap) {
  const main = String(snap.mainInstructions || '').slice(0, DOC_INSTRUCTIONS_MAX).trim();
  const text = String(snap.docInstructions || '').slice(0, DOC_INSTRUCTIONS_MAX).trim();
  return [main ? `${MAIN_INSTRUCTIONS_NOTE}\n<MAIN.md>\n${main}\n</MAIN.md>` : '',
    text ? `${DOC_INSTRUCTIONS_NOTE}\n<DOC.md>\n${text}\n</DOC.md>` : ''].filter(Boolean).join('\n\n');
}
// The documents opened in this chat before the turn (the prompt's copy; see snapshotDocument), or ''.
function openedDocsNote(snap) {
  const docs = Array.isArray(snap.docs) ? snap.docs : [];
  if (!docs.length) return '';
  const items = docs.map((d) => `${d.alias} ${JSON.stringify(d.title || 'Untitled document')}${d.kind === 'file' ? ' (file)' : ''}${Number.isFinite(d.lines) ? ` (${fmtNum(d.lines)} lines)` : ''}`);
  return `\n[Documents opened in this chat with open_document (read them with doc: "<alias>"; no need to open them again): ${items.join('; ')}.]`;
}

// Converts history to Chat Completions messages (the provider-neutral shape: sent as-is by Munin,
// used for size estimation by all providers): only role/content (and tool fields) are copied, so
// UI-only "_" fields (_reasoning, _usage, _toolActivity, _persona, _anthropicBlocks, _openaiItems, _log, ...)
// are never sent. Requests without tools (Munin persona turns)
// cannot carry tool calls, so the tool history is left out of them; requests with tools keep it.
// A user message carries its turn context (userContent); shortOld: shortened for the turns before the
// newest user message (Munin, which has no prompt cache to keep valid).
function buildApiMessages(hasTools, history, systemText, { shortOld = false } = {}) {
  const lastUser = shortOld ? lastUserIndex(history) : -1;
  const plain = oldDigestStubs(history, lastUser);
  const out = [{ role: 'system', content: systemText }];
  history.forEach((m, i) => {
    const o = apiMessage(plain.has(i) ? { ...m, content: plain.get(i) } : m, !hasTools, i < lastUser);
    if (o) out.push(o);
  });
  return out;
}
// The lookup digests of the older turns (_digest, slimHistory) that go as the plain stub when the history is sent short
// (lastUser >= 0: Munin and custom servers, no prompt cache): all but the newest DIGEST_KEEP, so the digests of a long
// chat do not add up in a 64k window. The stored message keeps its digest. index -> the plain stub.
const DIGEST_KEEP = 5;
function oldDigestStubs(history, lastUser) {
  const out = new Map();
  let names = null;
  let kept = 0;
  for (let i = lastUser - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || m.role !== 'tool' || !m._digest || ++kept <= DIGEST_KEEP) continue;
    names = names || toolNamesById(history);
    const fn = names.get(m.tool_call_id);
    if (fn) out.set(i, readingStub(fn, m.content, 'after the turn', { plain: true }));
  }
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
    // Arguments that are not valid JSON (the call got an error result) go as '{}': OpenAI-compatible servers (vLLM)
    // parse the history's arguments and would refuse every later request of the chat (Anthropic gets {} too).
    o.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id, type: 'function',
      function: { name: tc.function.name, arguments: parseToolArgs(tc).error !== null ? '{}' : short && !isReadingTool(tc) ? clippedArgs(tc) : tc.function.arguments || '' },
    }));
  }
  return o;
}
// An older turn's write call as Munin gets it (short): every string value cut to OLD_ARG_CHARS ("…" marks the cut), sent
// as valid JSON. The text it wrote is in the document now (or was undone); the call's shape and target are what the model
// needs from it. Only the sent copy: the history and the undo journal keep the whole arguments.
function clippedArgs(tc) {
  const raw = tc.function.arguments || '';
  if (raw.length <= OLD_ARG_CHARS) return raw;
  const { args } = parseToolArgs(tc);
  let cut = false;
  const clip = (v) => {
    if (typeof v === 'string') { if (v.length <= OLD_ARG_CHARS) return v; cut = true; return v.slice(0, OLD_ARG_CHARS) + '…'; }
    if (Array.isArray(v)) return v.map(clip);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]));
    return v;
  };
  const out = clip(args);
  return cut ? JSON.stringify(out) : raw;
}
// The characters of every history message as buildApiMessages sends it (0 when left out), for fitMessages to
// estimate a trimmed request without rebuilding it.
function sentSizes(hasTools, history, { shortOld = false } = {}) {
  const lastUser = shortOld ? lastUserIndex(history) : -1;
  const plain = oldDigestStubs(history, lastUser);
  return history.map((m, i) => {
    const o = apiMessage(plain.has(i) ? { ...m, content: plain.get(i) } : m, !hasTools, i < lastUser);
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
// its first line (alias, title, size). fn: the tool call's function ({name, arguments}). A registered tool's own
// digest (registry.js readingDigest: an external lookup keeps what it found) comes first, when shorter than the
// result; plain: the plain stub only.
function readingStub(fn, content, why, { plain = false } = {}) {
  const name = fn.name;
  let args = {};
  try { args = JSON.parse(fn.arguments || '{}') || {}; } catch (e) { args = {}; }
  const digest = plain ? '' : readingDigest(name, args, content, why);
  if (digest && digest.length < String(content == null ? '' : content).length) return digest;
  const doc = isMainDocRef(args.doc) ? '' : ` (${String(args.doc).trim()})`;
  if (name === 'open_document') {
    return `${String(content).split('\n')[0]}\n[The rest of this result was omitted ${why}; read_document with this alias reads it again if needed.]`;
  }
  // read_document: "read_document lines 40–75 + formatting (doc2)"; the legacy names of stored chats as they were.
  const what = name === 'read_document' ? `${name} ${readingSummary(name, args)}`
    : name === 'read_lines' || name === 'read_formatting' ? `${name} ${args.start}–${args.end}${doc}`
    : name === 'find_in_document' ? `${name} ${JSON.stringify(String(args.query == null ? '' : args.query))}${doc}`
      : `${name}${doc}`;
  return `[${what}: content omitted ${why}; re-read if needed]`;
}
// In-turn overflow: copies of the history in which the reading results of the current turn, except the
// last `kept` (TURN_RESULTS_KEPT; 0 after the server refused a request as too long), are replaced by their stub (the
// stored messages are not changed; replay payloads are never touched). null when nothing could be replaced.
function stubTurnResults(history, kept = TURN_RESULTS_KEPT) {
  const lastUser = lastUserIndex(history);
  const names = toolNamesById(history.slice(lastUser + 1));
  const idx = [];
  history.forEach((m, i) => { if (i > lastUser && m.role === 'tool') idx.push(i); });
  const older = new Set(idx.slice(0, Math.max(0, idx.length - kept)));
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
// send instead of the chat's (the self-test's probe request); noTools: a request without tools; stubAll: every reading
// result of the turn is stubbed, over budget or not (the resend after the server refused the request as too long).
// The default budget is scaled by snap.budgetScale (set by that resend for the rest of the turn).
function fitMessages(mode, snap, { reserve = 0, budget: limit, history: own = null, noTools = false, stubAll = false } = {}) {
  const scale = snap.budgetScale > 0 && snap.budgetScale < 1 ? snap.budgetScale : 1;
  const budget = (limit != null ? limit : Math.floor(tokenBudget(mode, snap) * scale)) - reserve;
  const tools = noTools ? [] : toolsFor(mode, snap);
  const hasTools = tools.length > 0;
  let history = activeHistory(own || state.messages);
  if (isDocPass(mode)) history = docPassHistory(mode, snap, history);
  const extraChars = (hasTools ? JSON.stringify(sentTools(tools, snap.prov)).length : 0) + sentReplayChars(history, snap.prov);
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

  if (stubAll || over()) {
    const slim = stubTurnResults(history, stubAll ? 0 : TURN_RESULTS_KEPT);
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
// The numbered text of the document at the start of the turn ("1: …", as the read_lines view shows it), or null without one.
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
    return `${ctx}\n[The document is too long for one message (${fmtNum(docLines(snap).length)} lines): read it in parts with read_document.]\n\n${task}`;
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
  el.trimNote.dataset.tip = el.trimNote.textContent;
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
// server default is used). profile: 'prose' (the default: answers without tools, the wrap-up), 'tools' (a request
// that offers client tools, and revise_section's paragraphs: toolSampling) or 'summary' (summaries and notes: summarySampling); a profile the
// provider does not define falls back to its sampling.
function samplingFields(prov, profile = 'prose') {
  const s = prov && ((profile === 'tools' && prov.toolSampling) || (profile === 'summary' && prov.summarySampling) || prov.sampling);
  if (!s) return {};
  const out = {};
  for (const k of ['temperature', 'top_p', 'top_k', 'presence_penalty']) if (typeof s[k] === 'number') out[k] = s[k];
  return out;
}

// The type's endpoint (PROVIDERS[*].baseUrl), or the account's own server (a Munin or custom account's URL: cfg.baseUrl).
const apiUrl = (snap, path) => ((snap.cfg && snap.cfg.baseUrl) || snap.prov.baseUrl) + path;
// No key (a local custom server): no Authorization header at all, since some servers refuse "Bearer " with nothing.
// A custom account's extra headers (cfg.headers) go first: Content-Type and the key win over them.
const bearerHeaders = (cfg) => ({ ...(cfg.headers || {}), 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) });
// A Chat Completions body for the account's type: a custom server gets it without Munin's own fields (persona,
// chat_template_kwargs), which a plain OpenAI-compatible server may refuse.
function chatBody(prov, body) {
  if (prov.id === 'munin') return body;
  const out = { ...body };
  delete out.persona;
  delete out.chat_template_kwargs;
  return out;
}

// Munin raw mode sends a sampling profile of PROVIDERS.munin (samplingFields) and chat_template_kwargs.reasoning_effort.
// Builds the request for the turn's provider and mode. Returns { kind, url, headers, body, tools, trimmed, docCut }.
// kind: 'chat' (OpenAI-compatible Chat Completions SSE: Munin raw mode, custom servers), 'persona' (Munin persona
// stream), 'responses' (OpenAI Responses API SSE) or 'anthropic' (Anthropic Messages API SSE).
// opts (the self-test's probe request): history and noTools as in fitMessages, maxTokens instead of the
// provider's reply limit.
function buildRequest(mode, snap, opts = {}) {
  const { prov, cfg } = snap;
  if (prov.id === 'openai') return buildOpenAiRequest(mode, snap, opts);
  if (prov.id === 'anthropic') return buildAnthropicRequest(mode, snap, opts);
  // Munin, or a custom server (chatBody drops Munin's fields; it has no personas and no sampling of its own).
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
  // Any request with client tools (Manual and Plan too): the arguments copy document text (old_text, scopes), which the
  // prose profile's presence penalty pushes off course.
  Object.assign(body, samplingFields(prov, fit.tools.length ? 'tools' : isDocPass(mode) ? 'summary' : 'prose'));
  if (fit.tools.length) body.tools = sentTools(fit.tools, prov);
  // Reasoning counts against max_tokens and the 64k window is shared: edits do not need deep thinking, and a request
  // without tools (the wrap-up, a document pass) gets the same explicit effort (Munin injects "medium" when none is sent).
  body.chat_template_kwargs = { reasoning_effort: MUNIN_REASONING_EFFORT };
  // Edits one at a time (line numbers shift). An OpenAI-compatible field; assumed to be accepted by Munin.
  if (offersWriteTools(fit.tools)) body.parallel_tool_calls = false;
  return { ...fit, kind: 'chat', url: apiUrl(snap, '/chat/completions'), headers: bearerHeaders(cfg), body: chatBody(prov, body) };
}

// The nudge round (toolLoop) asks the provider to call a tool where the field is known to work: OpenAI's
// tool_choice "required", and Anthropic's {type: "any"} only without thinking (the API refuses a forced tool choice
// with extended or adaptive thinking), on a model that takes a forced tool choice at all (anthropicForcedToolOk: not
// the line of Claude Fable 5.1, Opus 5.5 and Sonnet 5.5) and without a tool that runs code (programmatic tool calling
// refuses both fields). Elsewhere the nudge message alone asks for the call, as with Munin raw mode.
function requireToolCall(req) {
  if (!req || !req.body || !req.tools || !req.tools.length) return req;
  if (req.kind === 'responses') req.body.tool_choice = 'required';
  else if (req.kind === 'anthropic' && !req.body.thinking && anthropicForcedToolOk(req.body.model) && !anthropicRunsCode(req.body)) {
    req.body.tool_choice = { type: 'any', disable_parallel_tool_use: true };
  }
  return req;
}

// Copies of the messages without the providers' replay payloads (_openaiItems, _anthropicBlocks): the wrap-up
// request has no tools, so the rounds of the turn are rebuilt from text (a replayed reasoning item or thinking block
// without the call it led to would make the request invalid). upTo: only the messages before this index (a switch of the
// chat's model inside a tool loop, src/accounts.js: the rounds of the other provider go as plain messages).
const withoutReplay = (messages, upTo = Infinity) => messages.map((m, i) => {
  if (i >= upTo || !RAW_REPLAY_KEYS.some((k) => k in m)) return m;
  const c = { ...m };
  for (const k of RAW_REPLAY_KEYS) delete c[k];
  return c;
});
