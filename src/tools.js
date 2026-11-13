'use strict';
// Module tools.js: client tool definitions (TOOL_DEFS, REPLACE_TOOL, tool name lists), the
// reading tools (runReadingTool) and additional documents (open_document: openDocumentTool, loadOpenDoc,
// readingTarget). toolsFor (the tool set of a turn) stays in request.js. Feature modules add tools through
// registerTools (src/registry.js), not here.
/* global askUser, chatsKey, cleanDocText, confirmOpen, decorated, loadAttachmentView, docLines, docOutline, docsTabFromUrl, fetchDocModel,
   fetchDocTextFromPanel, FIND_MAX_RESULTS, FIND_SNIPPET_CHARS, fmtNum, formatNote, formatOutline, hasOutline,
   locateSelection, selectionSpan, selectionPlacesText, MAIN_DOC_REFS, markedText, MAX_OPEN_DOCS, oneLine, OPEN_DENIED_TEXT, OPEN_STOPPED_TEXT,
   OUTLINE_MAX_ITEMS, readLimits, registerTools, sendToTab, setStatus, showText, spanDefault, state, storageSet,
   SUGGESTED_NOTE, styleLabel, readComments, COMMENTS_MAX_CHARS, extraTool, knowUnmarkedFont, docTitleHeading, numberingShown, styleSheetFor */
/* global errorClause, rawError */
/* exported REPLACE_TOOL, TOOL_DEFS, compactSchema, compactTool, ASK_USER_TOOL, askQuestionsOf, WRITE_TOOLS, READING_TOOLS, LEGACY_READING_TOOLS,
   QUIET_TOOLS, runReadingTool, readDocumentTool, readScope, readIncludes, listMarks, READ_DEFAULT_INCLUDE, readingSummary, isMainDocRef, openDocumentTool, readingTarget, nextDocAlias,
   READ_AGAIN_TEXT, READ_AGAIN_STOP_TEXT, READ_LOOP_REPEATS, readAgain, noteRead, forgetStubbedReads, toolRequiredFields */

const REPLACE_TOOL = {
  type: 'function',
  function: {
    name: 'replace_selection',
    description:
      'Replace the user\'s selection (or insert at the cursor when nothing is selected) with text: the complete new ' +
      'plain text, no markdown, quotes or comments. The paste cannot be verified in the same message (the reading tools ' +
      'show the document as it was before it), so call it at most once per message.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
};

// Reading tools (tools document mode). Same Chat Completions format as REPLACE_TOOL; the schemas
// satisfy strict mode (every property required, no additional properties).
const noArgs = { type: 'object', properties: {}, required: [], additionalProperties: false };
// "doc" selects a document opened with open_document (strict mode: required, null = the main document).
const DOC_PARAM = { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'null: the main document; or an alias ("doc2") from open_document.' };
// read_document's include values; null (or an empty list) means READ_DEFAULT_INCLUDE.
const READ_INCLUDES = ['text', 'headings', 'lists', 'formatting', 'comments'];
const READ_DEFAULT_INCLUDE = ['text', 'headings', 'lists'];
const TOOL_DEFS = {
  replace_selection: REPLACE_TOOL,
  // One reading tool for the views get_outline, read_lines, read_formatting and read_comments gave (runReadingTool keeps
  // them as internal views; readDocumentTool adds the comments).
  read_document: { type: 'function', function: {
    name: 'read_document',
    description: 'Read the document. scope: {"start":N,"end":M} (lines, 1-based, inclusive), "outline" (headings with line numbers) or "all". Lines come as "N: text"; a result cut by the per-call limit says where to continue. include (null = text, headings, lists): headings labels heading lines, lists shows list markers, formatting shows the formatting, comments adds the comment threads anchored in the scope. Labels, markers and tags are not document text: never copy them into old_text.',
    parameters: {
      type: 'object',
      properties: {
        scope: { anyOf: [{ type: 'object', properties: { start: { type: 'integer' }, end: { type: 'integer' } }, required: ['start', 'end'], additionalProperties: false },
          { type: 'string', enum: ['outline', 'all'] }] },
        include: { anyOf: [{ type: 'array', items: { type: 'string', enum: READ_INCLUDES } }, { type: 'null' }] },
        doc: DOC_PARAM,
      },
      required: ['scope', 'include', 'doc'],
      additionalProperties: false,
    },
  } },
  find_in_document: { type: 'function', function: {
    name: 'find_in_document',
    description: 'The lines containing query (case-insensitive), with line numbers and a snippet; up to 40.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, doc: DOC_PARAM },
      required: ['query', 'doc'],
      additionalProperties: false,
    },
  } },
  get_selection: { type: 'function', function: {
    name: 'get_selection',
    description: 'The full text the user selected and its line range.',
    parameters: noArgs,
  } },
  open_document: { type: 'function', function: {
    name: 'open_document',
    description: 'Open another Google Docs document read-only, only when the user asks for it or points you to it. Returns its alias ("doc2") for the doc parameter, title, size and outline. It stays open for the whole chat: do not open it again.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Its link or document ID.' } },
      required: ['url'],
      additionalProperties: false,
    },
  } },
};
// Writing tools (an editing turn, Manual or Auto, with a connected Google account): precise edits through the Docs API.
// Descriptions are kept short (Munin: 64k window, no prompt cache); what the rules need is in the editing rules
// (prompts.js apiEditRules).
const nullable = (type, description, extra = {}) => ({ anyOf: [{ type, ...extra }, { type: 'null' }], ...(description ? { description } : {}) });
const STR = { type: 'string' };
const INT = { type: 'integer' };
const LINE_STYLES = ['title', 'subtitle', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'normal'];
const ALIGNS = ['left', 'center', 'right', 'justify'];
const LISTS = ['bullet', 'number', 'checklist', 'none'];
const NUMBERS = ['set', 'typed', 'clear'];
// The letters of typed heading numbers ("S" → S1, S1.1); no description: the edit rule names it (prompts.js rule 5).
const NUMBER_PREFIX = nullable('string');
const BOXES = ['shaded', 'bordered', 'none'];
// The text properties of format_text (and of an edit_document format_text op): null leaves a property as it is. script:
// superscript or subscript (an affiliation or footnote marker, a chemical formula); the enum alone explains it.
const SCRIPTS = ['super', 'sub', 'none'];
const TEXT_FORMAT_PROPS = (d = true) => ({
  bold: nullable('boolean'), italic: nullable('boolean'), underline: nullable('boolean'),
  font: nullable('string', d && '"Arial"…; "default" resets'), size: nullable('number', d && 'pt; 0 resets'),
  color: nullable('string', d && '"#RRGGBB" or a name; "none" resets'), highlight: nullable('string', d && 'like color'),
  script: nullable('string', '', { enum: SCRIPTS }), link: nullable('string', d && 'URL; "none" removes'),
});
// The paragraph properties of format_lines (and of an edit_document format_lines op). d: with the short descriptions
// (edit_document leaves them to format_text and format_lines). An indent is points or "style", which removes the line's
// own value so it inherits again (the compact schema keeps the number and the description).
const indentProp = (d) => ({ anyOf: [{ type: 'number' }, { type: 'string', enum: ['style'] }, { type: 'null' }], ...(d ? { description: 'pt; "style" = inherit' } : {}) });
const LINE_FORMAT_PROPS = (style, d = true) => ({
  style, align: nullable('string', '', { enum: ALIGNS }), list: nullable('string', d && 'none removes', { enum: LISTS }),
  indent_start: indentProp(d), indent_first_line: indentProp(d),
  space_above: nullable('number', d && 'pt'), space_below: nullable('number', d && 'pt'), line_spacing: nullable('number', d && '1, 1.15, 1.5, 2'),
  indent_end: nullable('number', d && 'pt, right'), box: nullable('string', '', { enum: BOXES }), page_break_before: nullable('boolean'),
});
const strict = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
TOOL_DEFS.replace_text = { type: 'function', function: {
  name: 'replace_text',
  description: 'Replace old_text (the smallest unique piece, a few words around the change, copied exactly as read without the "N: " prefix; may span lines) with new_text (plain text; a newline starts a paragraph; empty deletes). Only the differing part is rewritten. line: search only that line when the text occurs several times. Returns where the lines are now.',
  parameters: strict({ old_text: STR, new_text: STR, line: nullable('integer') }),
} };
TOOL_DEFS.replace_all = { type: 'function', function: {
  name: 'replace_all',
  description: 'Replace EVERY occurrence of old_text with new_text in one atomic edit (terminology across the document); both within one paragraph. Returns how many and on which lines.',
  parameters: strict({ old_text: STR, new_text: STR }),
} };
TOOL_DEFS.replace_section = { type: 'function', function: {
  name: 'replace_section',
  description: 'Replace the body of the section under heading (as the outline shows it) up to the next heading of the same or a higher level; the heading stays. new_text is plain text; empty empties the section.',
  parameters: strict({ heading: STR, new_text: STR }),
} };
TOOL_DEFS.format_text = { type: 'function', function: {
  name: 'format_text',
  description: 'Character formatting of old_text (exact, unique). line: search only that line when the text occurs several times; all: true formats every occurrence. null leaves a property as it is. Returns what was formatted.',
  parameters: strict({ old_text: STR, line: nullable('integer'), all: nullable('boolean'), ...TEXT_FORMAT_PROPS() }),
} };
// Paragraph formatting of whole lines (format_lines, docs-write.js planFormatLines).
TOOL_DEFS.format_lines = { type: 'function', function: {
  name: 'format_lines',
  description: 'Paragraph formatting of lines start..end; null leaves a property as it is. box: grey shading or a thin border; page_break_before: start on a new page. numbers: set = Docs numbering of the headings (1., 1.1.), typed = numbers written into the heading text, clear = remove.',
  parameters: strict({ start: INT, end: INT, ...LINE_FORMAT_PROPS(nullable('string', '', { enum: LINE_STYLES })), numbers: nullable('string', 'set: the sheet entry "numbers 0.6/0.9/1.2" (cm) or "numbers docs" sets where the heading text starts', { enum: NUMBERS }),
    prefix: NUMBER_PREFIX, apply_sheet: nullable('boolean', 'true: each line gets the formatting sheet of its type (font, size, align, space)') }),
} };
TOOL_DEFS.insert_after_line = { type: 'function', function: {
  name: 'insert_after_line',
  description: 'Insert text as new paragraph(s) after line (0 = at the beginning); fill: true writes it into line when empty (an empty document: line 1). Returns the new line numbers.',
  parameters: strict({ line: INT, text: STR, style: nullable('string', 'null = normal; h1-h6, title, subtitle: every line; outline: "# ", "## "… lines headings, others normal'),
    fill: nullable('boolean') }),
} };
TOOL_DEFS.delete_lines = { type: 'function', function: {
  name: 'delete_lines',
  description: 'Delete lines start..end (whole paragraphs).',
  parameters: strict({ start: INT, end: INT }),
} };
// edit_document: several edits of the kinds above in one call, planned on the frozen snapshot, one batchUpdate, one
// re-read, one undo entry (docs-write.js planEditDocument). An operation is one of six strict objects (anyOf, told apart
// by op, a one-value enum), each with only its op's fields; the fields an op needs are plain types, its optional ones
// nullable. Every provider receives it compact (compactSchema merges the variants into one loose object; OpenAI and
// Anthropic get it not strict, request.js LOOSE_TOOLS), so no operation has to carry a null for every field it leaves
// alone. The per-field descriptions stay tiny (line and style name their op), the shared explanation is the description.
const opVariant = (op, properties) => strict({ op: { type: 'string', enum: [op] }, ...properties });
const LINE_OF_TEXT = nullable('integer', 'replace, format_text: picks the occurrence on it');
const EDIT_OP_VARIANTS = [
  opVariant('replace', { old_text: STR, new_text: STR, line: LINE_OF_TEXT }),
  opVariant('insert', { line: { type: 'integer', description: 'insert: after it, 0 = at the start' }, text: STR,
    style: nullable('string', 'insert: h1-h6, title, subtitle (every line), outline'), fill: nullable('boolean') }),
  opVariant('delete', { start: INT, end: nullable('integer') }),
  opVariant('format_text', { old_text: STR, line: LINE_OF_TEXT, all: nullable('boolean', 'every occurrence'), ...TEXT_FORMAT_PROPS(false) }),
  opVariant('format_lines', { start: INT, end: INT, ...LINE_FORMAT_PROPS(nullable('string', 'format_lines: also normal', { enum: LINE_STYLES }), false) }),
  opVariant('number_headings', { start: nullable('integer'), end: nullable('integer'), numbers: { type: 'string', enum: NUMBERS }, prefix: NUMBER_PREFIX }),
];
TOOL_DEFS.edit_document = { type: 'function', function: {
  name: 'edit_document',
  description: 'Several edits in one call, applied and undone together. operations: [{op, …}], null leaves a field unchanged: replace (old_text, new_text, line), insert (line, text, style), delete (start, end), format_text (old_text, line, all, bold…link), format_lines (start, end, style…), number_headings (start, end, numbers). Lines and texts as read before the call.',
  parameters: strict({ operations: { type: 'array', items: { anyOf: EDIT_OP_VARIANTS } } }),
} };
TOOL_DEFS.undo_last_edit = { type: 'function', function: {
  name: 'undo_last_edit',
  description: 'Revert the most recent edit of this chat that is not undone yet.',
  parameters: noArgs,
} };
// remember: a standing rule added to, removed from or changed in MAIN.md (the main instructions, every document) or
// DOC.md (this document's; doc-instructions.js rememberTool). Not a document edit, but journaled (undone with the edits); the gate asks only in a tainted
// turn. Offered with the reading tools.
TOOL_DEFS.remember = { type: 'function', function: {
  name: 'remember',
  description: 'Add, remove or change one line of MAIN.md or DOC.md, the standing instructions. Only when the user explicitly asks to remember, forget, review or change a rule for the future ("always", "from now on", "remember", "don\'t … anymore"), never on your own initiative; store lasting preferences, not one-off requests; confirm in one line. A new rule that contradicts a line added earlier replaces that line; never rewrite lines the user wrote by hand unless asked. ' +
    'Asked to learn or match the user\'s style ("learn my style", "write like me"): read two or three paragraphs they wrote and remember one compact style line (register, rhythm, we/I/impersonal, hedging, citations, punctuation, what to avoid), replacing an earlier style line.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['scope', 'action', 'text', 'old'], // strict mode wants every property; a missing scope still means "document"
    properties: {
      scope: { type: 'string', enum: ['main', 'document'], description: 'main: MAIN.md (every document); document: DOC.md' },
      action: { type: 'string', enum: ['add', 'remove', 'replace'], description: 'replace: the line equal to old becomes text' },
      text: { type: 'string', description: "one line in English, close to the user's words" },
      old: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'replace: the current line; else null' },
    },
  },
} };
// ask_user: a questionnaire card that blocks the model (gate.js askUser): up to 4 questions, each with the model's
// suggested answers (one, or several when multiple is true) and an Other field. Reads and writes nothing, so it is offered in every turn with client tools
// (Plan and side questions included). Registered (registerTools, below) rather than in TOOL_DEFS, since toolsFor
// offers the built-in tools by mode: it comes after the built-in tools, so their prefix of the tool list stays as it
// was, and before the feature modules' tools. Not a reading tool: its answer survives slimHistory and the call gets a
// card. runToolCall (turn.js) calls askUser itself (runExtraTool would refuse a non-reading tool outside an editing
// turn). The counts are checked when it runs (strict schemas cannot bound array sizes on every provider).
const ASK_USER_TOOL = { type: 'function', function: {
  name: 'ask_user',
  description: 'Ask the user up to 4 questions in one card, each with 2–4 suggested answers (a few words each); the user can also type their own. Use it before writing when you need facts or choices from the user. At most once per message.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            multiple: { anyOf: [{ type: 'boolean' }, { type: 'null' }], description: 'the user may pick several answers' },
          },
          required: ['question', 'options', 'multiple'],
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
} };
// The questions of a call: the questions list, or the one question of a call stored before the questionnaire.
const askQuestionsOf = (args) => (Array.isArray(args.questions) ? args.questions : typeof args.question === 'string' ? [{ question: args.question, options: args.options }] : []);
registerTools(ASK_USER_TOOL, {
  offer: () => true,
  reading: false,
  run: (name, args, snap, ui) => askUser(args, snap, ui), // required by registerTools; runToolCall calls askUser first
  summary: (name, args) => {
    const first = askQuestionsOf(args)[0];
    return first && typeof first.question === 'string' ? oneLine(first.question, 60) : '';
  },
  pending: 'Preparing a question…',
  // No prompt line: the description says how to ask; the reading section of the head says when (request.js).
});
// ---- Compact schemas (providers without strict mode) -----------------------------------------------------------------
// The definitions are strict (OpenAI, Anthropic): every property required, the optional ones nullable, no additional
// properties. A provider without strict mode and without a prompt cache (Munin, a custom server: request.js cachesPrompt)
// gets them compact instead: a nullable property ({anyOf: [T, {type: "null"}]}) becomes T and leaves required, and
// additionalProperties goes. Only the schema text changes, never a value: the handlers already read a missing field as
// null (looseNull, readScope, readIncludes). A union of two real types (read_document's scope) stays as it is.
const isNullType = (x) => !!x && typeof x === 'object' && x.type === 'null' && Object.keys(x).length === 1;
function compactSchema(schema) {
  if (Array.isArray(schema)) return schema.map(compactSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const k of Object.keys(schema)) { // a getter (delegate's search description) is read here, at request time
    const v = schema[k];
    if (k === 'additionalProperties') continue;
    if (k === 'anyOf' && compactNullable(schema)) {
      Object.assign(out, compactSchema(v.find((x) => !isNullType(x))));
    } else if (k === 'anyOf' && Array.isArray(v) && v.length > 1 && v.every(isObjectSchema)) {
      Object.assign(out, mergeVariants(v.map(compactSchema)));
    } else if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const name of Object.keys(v)) out.properties[name] = compactSchema(v[name]);
    } else out[k] = compactSchema(v);
  }
  if (out.properties && Array.isArray(schema.required)) {
    const req = schema.required.filter((n) => !(schema.properties[n] && compactNullable(schema.properties[n])));
    if (req.length) out.required = req;
    else delete out.required;
  }
  return out;
}
// A union of objects (edit_document's operations, one object per op) becomes ONE loose object, as a provider without strict
// mode needs no variants: every property of any variant (the first definition, enums joined, an enum dropped when a
// variant has none, the differing descriptions joined with "; "), required only where every variant requires it.
const isObjectSchema = (x) => !!x && typeof x === 'object' && x.type === 'object' && !!x.properties;
function mergeVariants(variants) {
  const properties = {};
  for (const v of variants) {
    for (const [name, p] of Object.entries(v.properties)) {
      const m = properties[name];
      if (!m) { properties[name] = { ...p }; continue; }
      if (m.enum && p.enum) m.enum = [...new Set([...m.enum, ...p.enum])];
      else delete m.enum;
      if (p.description && !(m.description || '').split('; ').includes(p.description)) m.description = m.description ? `${m.description}; ${p.description}` : p.description;
    }
  }
  // A property absent from a variant is not required there.
  for (const v of variants) for (const name of Object.keys(properties)) if (!(name in v.properties)) properties[name]._optional = true;
  const required = Object.keys(properties).filter((n) => !properties[n]._optional && variants.every((v) => (v.required || []).includes(n)));
  for (const p of Object.values(properties)) delete p._optional;
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}
// A nullable property: T or null, or several scalar types or null (format_lines' indents: a number or "style"), which
// becomes its first type (the description names the other).
const isScalarSchema = (x) => !!x && typeof x === 'object' && ['number', 'integer', 'string', 'boolean'].includes(x.type);
const compactNullable = (prop) => !!prop && Array.isArray(prop.anyOf) && prop.anyOf.some(isNullType)
  && (prop.anyOf.length === 2 || prop.anyOf.every((x) => isNullType(x) || isScalarSchema(x)));
// A tool definition (Chat Completions format) with its schema compact.
const compactTool = (t) => ({ ...t, function: { ...t.function, parameters: compactSchema(t.function.parameters) } });

const WRITE_TOOLS = ['replace_text', 'replace_all', 'replace_section', 'format_text', 'format_lines', 'insert_after_line', 'delete_lines', 'edit_document', 'undo_last_edit'];
const READING_TOOLS = ['read_document', 'find_in_document', 'get_selection'];
// The reading tools of earlier versions (read_document replaced them): never offered or run again (a call is an
// unknown tool), but the calls in stored chats still render as quiet reading rows and their results are stubbed.
// check_providers (replaced by models, src/accounts.js) too.
const LEGACY_READING_TOOLS = ['get_outline', 'read_lines', 'read_formatting', 'read_comments', 'check_providers'];
// Tools that only read (no edit card; a quiet row in the action log).
const QUIET_TOOLS = [...READING_TOOLS, 'open_document', ...LEGACY_READING_TOOLS];

// ---- Reading tools (tools mode): executed locally on the turn's document snapshot --------------
const snippetAround = (line, at, len) => {
  const pad = Math.max(0, Math.floor((FIND_SNIPPET_CHARS - len) / 2));
  const from = Math.max(0, at - pad);
  const to = Math.min(line.length, at + len + pad);
  return (from > 0 ? '…' : '') + line.slice(from, to).trim() + (to < line.length ? '…' : '');
};

// read_document's scope: { kind: 'outline' | 'all' } or { kind: 'lines', start, end } (raw values, checked by the line
// view), or { error }. Lenient with what models send: a JSON text of the object, "12-40", or start / end at the top
// level instead of scope.
function readScope(raw, args = {}) {
  let s = raw;
  if (typeof s === 'string' && /^\s*\{/.test(s)) { try { s = JSON.parse(s); } catch (e) { /* the text is checked below */ } }
  if (typeof s === 'string') {
    const t = s.trim().toLowerCase();
    if (t === 'outline' || t === 'all') return { kind: t };
    const m = /^(?:lines?\s*)?(\d+)\s*(?:(?:-|–|—|\.\.|to)\s*(\d+))?$/.exec(t);
    if (m) return { kind: 'lines', start: Number(m[1]), end: Number(m[2] || m[1]) };
  } else if (s && typeof s === 'object' && !Array.isArray(s)) {
    return { kind: 'lines', start: s.start, end: s.end == null ? s.start : s.end };
  } else if (s == null && args.start != null) {
    return { kind: 'lines', start: args.start, end: args.end == null ? args.start : args.end };
  }
  return { error: `Error: scope must be {"start":N,"end":M}, "outline" or "all" (got ${oneLine(JSON.stringify(raw === undefined ? null : raw), 60)}).` };
}
// read_document's include: { set } (null or an empty list: READ_DEFAULT_INCLUDE) or { error }. A JSON text of the list
// or "formatting, comments" are accepted too.
function readIncludes(raw) {
  let v = raw;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t || t.toLowerCase() === 'null') v = null;
    else if (t.startsWith('[')) { try { v = JSON.parse(t); } catch (e) { v = t; } }
    if (typeof v === 'string') v = v.split(/[\s,]+/).filter(Boolean);
  }
  if (v == null || (Array.isArray(v) && !v.length)) return { set: new Set(READ_DEFAULT_INCLUDE) };
  if (!Array.isArray(v)) return { error: 'Error: include must be a list of text, headings, lists, formatting, comments, or null.' };
  const set = new Set();
  for (const x of v) {
    const k = String(x).trim().toLowerCase();
    if (!READ_INCLUDES.includes(k)) return { error: `Error: include may hold text, headings, lists, formatting and comments (got ${oneLine(JSON.stringify(x), 40)}).` };
    set.add(k);
  }
  return { set };
}

// The list markers of a Docs API model: line -> "• ", "1. ", "a. ", "1.2. " or "☐ ", after two spaces per nesting level.
// Numbers count per list from the top of the document (as Docs draws them: decimal, then a., then i. by level; a
// nested numbering joins the levels). Cached per model (a model is never changed after it is read).
const LIST_MARKS = new WeakMap();
const ROMAN = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
const roman = (n) => { let out = ''; for (const [v, r] of ROMAN) while (n >= v) { out += r; n -= v; } return out; };
const alpha = (n) => { let out = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(97 + ((n - 1) % 26)) + out; return out; };
function listMarks(model) {
  if (LIST_MARKS.has(model)) return LIST_MARKS.get(model);
  const out = new Map();
  const counters = new Map();
  for (const l of model.lines) {
    if (!l.list) continue;
    const k = l.list.level || 0;
    const c = counters.get(l.list.listId) || [];
    counters.set(l.list.listId, c);
    c.length = k + 1;
    for (let i = 0; i < k; i++) c[i] = c[i] || 0;
    c[k] = (c[k] || 0) + 1;
    const n = c[k];
    const mark = l.list.kind === 'checklist' ? '☐' : l.list.kind !== 'number' ? '•'
      : l.list.nested ? c.join('.') + '.' : `${k % 3 === 1 ? alpha(n) : k % 3 === 2 ? roman(n) : n}.`;
    out.set(l.line, '  '.repeat(k) + mark + ' ');
  }
  LIST_MARKS.set(model, out);
  return out;
}

// Lines start..wanted of snap, "N: text" each, within limits ({chars, lines}). opts: fmt (the formatting notation of
// read_formatting: a [tag] and inline markers), heads (heading lines labelled "5 [H1]: "), lists (list markers before
// the text), cont(a, b) (the sentence that says how to read on from line a). Lines with suggested changes are marked;
// table cells carry their registered label.
function linesView(snap, args, limits, opts = {}) {
  const lines = docLines(snap).map(showText); // soft line breaks shown as a mark
  const api = snap.docFormat === 'docs-api' && snap.model ? snap.model : null;
  const fmt = !!opts.fmt && !!api;
  const flag = (i) => (api && api.lines[i] && api.lines[i].suggested ? SUGGESTED_NOTE : '');
  // Registered line notation (registerLineDecorator: table cells), Docs API models only; none: '' (unchanged output).
  const deco = (i) => (api ? decorated(api, api.lines[i]) : { label: '', before: '' });
  const marks = api && opts.lists && !fmt ? listMarks(api) : null;
  // The document's title (a lone top-level heading before the others, docTitleHeading) is named so, as in the outline.
  const top = api && (opts.heads || fmt) ? docTitleHeading(api) : null;
  // A numbered heading with the numbering's own indents shows none (numberingShown): the tag stays "h2 number".
  const sheeted = fmt ? { ...api, sheet: styleSheetFor(snap) } : null;
  const titled = (l) => numberingShown(sheeted, top && top === l ? { ...l, docTitle: true } : l);
  const head = (i) => (api && opts.heads && !fmt && api.lines[i] && api.lines[i].heading && api.lines[i].style ? ` [${styleLabel(api.lines[i].style)}${top && top === api.lines[i] ? ' title' : ''}]` : '');
  const total = lines.length;
  const start = Math.max(1, Math.floor(Number(args.start)) || 1);
  let wanted = Math.floor(Number(args.end));
  if (!Number.isFinite(wanted) || wanted < start) wanted = start;
  if (start > total) return `Error: the document has only ${total} lines.`;
  const end = Math.min(wanted, total, start + limits.lines - 1);
  const out = [];
  let chars = 0;
  let last = start - 1;
  const def = fmt ? spanDefault(api) : null;
  for (let i = start; i <= end; i++) {
    const d = deco(i - 1);
    const text = fmt ? markedText(titled(api.lines[i - 1]), def) : ((marks && marks.get(i)) || '') + lines[i - 1];
    const l = `${d.before ? d.before + '\n' : ''}${i}${d.label}${head(i - 1)}: ${text}${flag(i - 1)}`;
    if (out.length && chars + l.length > limits.chars) break;
    out.push(l);
    chars += l.length + 1;
    last = i;
  }
  const to = Math.min(wanted, total);
  const cont = opts.cont || ((a, b) => `Call read_document with scope {"start":${a},"end":${b}} to continue.`);
  const note = last < to ? `\n[Stopped at line ${last} (limit per call). ${cont(last + 1, to)}]` : '';
  return `${fmt ? formatNote(api) + '\n' : ''}Lines ${start}-${last} of ${total}:\n${out.join('\n')}${note}`;
}

// The outline view (get_outline of earlier versions): every heading with its line; range ({from, to}) keeps those in it.
function outlineView(snap, range = null) {
  const total = docLines(snap).length;
  if (!hasOutline(snap)) return 'The outline is unavailable: the document could only be exported as plain text. Use find_in_document and read_document instead.';
  const items = docOutline(snap).filter((h) => !range || (h.line >= range.from && h.line <= range.to));
  const where = range ? ` in ${range.from === range.to ? `line ${range.from}` : `lines ${range.from}-${range.to}`}` : '';
  if (!items.length) return range ? `No headings${where}.` : `The document has no headings (${total} lines).`;
  return `${items.length} heading${items.length === 1 ? '' : 's'}${where} (${total} lines in total):\n` + formatOutline(items);
}

// Returns the tool's text result (always a string; errors are described in the text). limits: the per-call limits of
// the line views ({chars, lines}, see readLimits); by default those of the snapshot's provider (an opened document's
// view has none: the defaults then). read_document without its comments (readDocumentTool adds them); 'get_outline',
// 'read_lines' and 'read_formatting' are the internal views it is made of (section scores and document passes use
// read_lines; never offered to the model).
function runReadingTool(name, args, snap, limits = readLimits(snap.prov)) {
  if (snap.docText == null) return `Error: the document text is unavailable (${snap.docError || 'export failed'}).`;
  switch (name) {
    case 'read_document': {
      const scope = readScope(args.scope, args);
      if (scope.error) return scope.error;
      const inc = readIncludes(args.include);
      if (inc.error) return inc.error;
      if (scope.kind === 'outline') return outlineView(snap);
      const total = docLines(snap).length;
      const range = scope.kind === 'all' ? { start: 1, end: total } : { start: scope.start, end: scope.end };
      const fmt = inc.set.has('formatting');
      const api = snap.docFormat === 'docs-api' && !!snap.model;
      if (fmt || inc.set.has('text') || inc.set.has('lists')) {
        const view = linesView(snap, range, limits, { fmt, heads: inc.set.has('headings'), lists: inc.set.has('lists') });
        return fmt && !api && !view.startsWith('Error:') ? `[Formatting is shown only when the document is read through the Google Docs API; plain text below.]\n${view}` : view;
      }
      if (inc.set.has('headings')) {
        const a = Math.max(1, Math.floor(Number(range.start)) || 1);
        return outlineView(snap, { from: a, to: Math.max(a, Math.min(total, Math.floor(Number(range.end)) || a)) });
      }
      return ''; // comments only (readDocumentTool)
    }
    case 'get_outline': return outlineView(snap);
    case 'read_formatting':
      if (snap.docFormat !== 'docs-api' || !snap.model) return 'Error: formatting is only available when the document is read through the Google Docs API.';
      return linesView(snap, args, limits, { fmt: true });
    case 'read_lines': return linesView(snap, args, limits);
    case 'find_in_document': {
      const lines = docLines(snap).map(showText);
      const deco = (i) => (snap.docFormat === 'docs-api' && snap.model ? decorated(snap.model, snap.model.lines[i]) : { label: '', before: '' });
      const q = String(args.query || '').trim();
      if (!q) return 'Error: the query is empty.';
      const needle = q.toLowerCase();
      const hits = [];
      let total = 0;
      lines.forEach((l, i) => {
        const at = l.toLowerCase().indexOf(needle);
        if (at < 0) return;
        total++;
        if (hits.length < FIND_MAX_RESULTS) hits.push(`${i + 1}${deco(i).label}: ${snippetAround(l, at, q.length)}`);
      });
      if (!total) return `No line contains "${q}".`;
      return `${total} line${total === 1 ? ' contains' : 's contain'} "${q}"${total > hits.length ? ` (first ${hits.length} shown)` : ''}:\n${hits.join('\n')}`;
    }
    case 'get_selection': {
      if (!snap.selection) return 'Nothing is selected in the document.';
      const loc = locateSelection(snap);
      const span = loc ? null : selectionSpan(snap); // the same text in several places: their lines
      const where = loc ? `lines ${loc.start}-${loc.end}` : span && span.occurrences > 1 ? selectionPlacesText(span) : 'position in the document not found';
      return `Selection (${where}, ${fmtNum(snap.selection.length)} characters):\n${snap.selection}`;
    }
    default:
      return `Error: unknown tool "${name}".`;
  }
}

// read_document with its comments: the comment threads (docs-comments.js, every status, open first) anchored in the
// scope go after the lines, within what is left of the per-call character limit. Main document read through the Docs
// API only. target: the snapshot or an opened document's view (readingTarget).
const COMMENTS_MIN_ROOM = 400;
async function readDocumentTool(args, target, snap, limits = readLimits(snap.prov)) {
  const inc = readIncludes(args.include);
  if (inc.set && inc.set.has('formatting')) await knowUnmarkedFont(target);
  const base = runReadingTool('read_document', args, target, limits);
  if (base.startsWith('Error:') || inc.error || !inc.set.has('comments')) return base;
  const join = (t) => (base ? `${base}\n\n${t}` : t);
  if (target !== snap) return join('[Comments are read only for the main document.]');
  if (snap.docFormat !== 'docs-api' || !snap.model) return join('[Comments need the Google Docs API, which is not available for this message.]');
  const scope = readScope(args.scope, args);
  const room = Math.min(COMMENTS_MAX_CHARS, limits.chars - base.length);
  if (room < COMMENTS_MIN_ROOM) return join('[Comments not shown: this result reached the limit per call. Read them with include ["comments"] alone for these lines.]');
  const lines = scope.kind === 'lines' ? `${Math.max(1, Math.floor(Number(scope.start)) || 1)}-${Math.max(1, Math.floor(Number(scope.end)) || 1)}` : null;
  return join(await readComments({ status: 'all', lines }, snap, room));
}

// One-line summary of a reading call for the activity rows under an answer (the opened document's
// alias in parentheses when the call reads one). The legacy reading tools of stored chats keep their rows.
function readingSummary(name, args) {
  const on = isMainDocRef(args.doc) ? '' : ` (${String(args.doc).trim()})`;
  if (name === 'read_document') {
    const sc = readScope(args.scope, args);
    const where = sc.error ? '' : sc.kind === 'outline' ? 'outline' : sc.kind === 'all' ? 'whole document' : `lines ${sc.start}–${sc.end}`;
    const inc = readIncludes(args.include);
    const extra = inc.set ? [...inc.set].filter((k) => !READ_DEFAULT_INCLUDE.includes(k)) : [];
    return `${where}${extra.length ? ` + ${extra.join(', ')}` : ''}${on}`;
  }
  if (name === 'read_lines' || name === 'read_formatting') return `lines ${args.start}–${args.end}${on}`;
  if (name === 'read_comments') return `comments (${['open', 'resolved', 'all'].includes(args.status) ? args.status : 'open'})`;
  if (name === 'find_in_document') return `"${args.query}"${on}`;
  if (name === 'open_document') return typeof args.url === 'string' ? oneLine(args.url, 80) : '';
  return on.trim();
}

// ---- Additional documents (open_document, the "doc" parameter) -------------------------------------
// An opened document is read through the Docs API when a Google account is connected (export as a
// fallback), otherwise through the Markdown / plain-text export with the main document's Google account
// (authuser). Its content is read once per turn (on open, or on the first read in the turn) and kept in
// the turn snapshot (snap.docCache); the list of opened documents is kept on the chat meta.
const isMainDocRef = (ref) => ref == null || MAIN_DOC_REFS.includes(String(ref).trim().toLowerCase());
const authUserFromUrl = (url) => {
  const s = String(url || '');
  return (/\/document\/u\/(\d+)\//.exec(s) || /[?&#]authuser=(\d+)/.exec(s) || [])[1] || null;
};

// A Docs link ("https://docs.google.com/(a/<domain>/)document/(u/N/)d/<id>/...", the scheme may be left
// out) or a bare document ID. Returns { id, tab, authuser }, { published: true } for a "Publish to the
// web" link (/document/d/e/<pubid>/pub: its ID is not the document's), or null.
function parseDocRef(input) {
  const s = String(input == null ? '' : input).trim();
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return { id: s, tab: null, authuser: null };
  const m = /^(?:https?:\/\/)?docs\.google\.com\/(?:a\/[^/?#]+\/)?document\/(?:u\/\d+\/)?d\/(e\/)?([a-zA-Z0-9_-]+)/i.exec(s);
  if (!m) return null;
  if (m[1]) return { published: true };
  return { id: m[2], tab: docsTabFromUrl(s), authuser: authUserFromUrl(s) };
}

// The user asked for the document: its ID appears literally in one of the user's own messages of this
// chat (not in a summary) or in the document or main instructions. Such documents open without confirmation.
function userMentionedDoc(id, snap) {
  return userTexts(snap).some((t) => t.includes(id));
}
// The user's own texts of this chat (not summaries, not the panel's automatic continuation requests), the
// document instructions and the main instructions.
function userTexts(snap) {
  const msgs = (snap.chatCtx && snap.chatCtx.messages) || state.messages;
  return [...msgs.filter((m) => m.role === 'user' && !m._summary && !m._auto && typeof m.content === 'string').map((m) => m.content),
    String(snap.docInstructions || ''), String(snap.mainInstructions || '')];
}
// The Google account index to export an opened document with: the main document's, unless the user's
// own texts contain a link to this document with that index (a model-made "/u/N/" is not trusted).
function trustedAuthUser(ref, snap) {
  const main = authUserFromUrl(snap.mainUrl);
  if (ref.authuser == null || ref.authuser === main) return main;
  const named = userTexts(snap).some((t) => (t.match(/(?:https?:\/\/)?docs\.google\.com\/[^\s"'<>)\]]+/gi) || [])
    .some((u) => { const r = parseDocRef(u); return r && r.id === ref.id && r.authuser === ref.authuser; }));
  return named ? ref.authuser : main;
}

// Gate before opening a document the user did not mention (always asked). Returns null when allowed,
// otherwise the tool message fields of the refusal. "Allow all in this turn" (snap.openAll) allows
// the remaining opens of the turn.
async function reviewOpen(snap, ui, preview) {
  if (snap.openAll) { ui.decision = 'accepted-all'; return null; }
  const d = await confirmOpen(preview, snap.signal, ui);
  if (d === 'accept' || d === 'accept-all') {
    if (d === 'accept-all') snap.openAll = true;
    ui.decision = 'accepted';
    setStatus('Opening a document…');
    return null;
  }
  ui.decision = d === 'stop' ? 'stopped' : 'rejected';
  return { content: d === 'stop' ? OPEN_STOPPED_TEXT : OPEN_DENIED_TEXT, _ok: false, _message: preview.title };
}

const nextDocAlias = (docs) => 'doc' + (docs.reduce((n, d) => Math.max(n, Number(d.alias.slice(3)) || 0), 1) + 1);

// Reads an opened document (entry: {alias, id, tab?, authuser?, title?}) into the turn snapshot. Returns a
// document view for runReadingTool ({docText, docFormat, model, title, lines, selection, docError}) or
// { error } with a readable message. force: read again although it was read in this turn.
async function loadOpenDoc(entry, snap, force) {
  if (entry.kind === 'file') return loadAttachmentView(entry, snap); // an attached file (attachments.js): stored text
  if (!force && snap.docCache.has(entry.alias)) return snap.docCache.get(entry.alias);
  let view = null;
  let apiErr = null;
  if (snap.googleConnected) {
    try {
      const model = await fetchDocModel(entry.id, entry.tab || null, false);
      view = { docText: model.text, docFormat: 'docs-api', model, title: model.title || entry.title || '' };
    } catch (e) { apiErr = e; }
  }
  if (!view) {
    const au = entry.authuser != null ? entry.authuser : authUserFromUrl(snap.mainUrl);
    // The export runs in the Docs tab first (same-origin request with the user's session cookies), then
    // from the panel. A response for another document (an old content script ignores docId) is not used.
    let tabErr = '';
    try {
      const r = await sendToTab({ type: 'GET_DOC_TEXT', docId: entry.id, authuser: au });
      if (r && r.ok && r.docId === entry.id && typeof r.text === 'string') {
        const format = r.format === 'markdown' ? 'markdown' : 'text';
        view = { docText: cleanDocText(r.text, format), docFormat: format, model: null, title: r.title || entry.title || '' };
      } else {
        tabErr = (r && r.ok) ? 'the Docs tab answered for another document (reload it)' : (r && r.error) || 'no answer from the Docs tab';
      }
    } catch (e) { tabErr = e.message; }
    if (!view) {
      try {
        const r = await fetchDocTextFromPanel(entry.id, null, au);
        view = { docText: cleanDocText(r.text, r.format), docFormat: r.format, model: null, title: r.title || entry.title || '' };
      } catch (e) {
        // The raw reasons for the console; the model gets the Docs API's in plain words (else the export's).
        console.warn('Munin: could not open', entry.id, { api: apiErr && rawError(apiErr), tab: tabErr, export: rawError(e) });
        return { error: `could not open the document ${entry.id} (${errorClause(apiErr || e)}). ` +
          'The user may have no access to it with the Google account of this tab, or the link is wrong.' };
      }
    }
  }
  Object.assign(view, { lines: null, selection: '', docError: '' });
  snap.docCache.set(entry.alias, view);
  // Keep the stored title and line count current (the next prompt lists them).
  const lines = docLines(view).length;
  if (entry.lines !== lines || (view.title && entry.title !== view.title)) {
    entry.lines = lines;
    if (view.title) entry.title = view.title;
    if (snap.docs.includes(entry)) await rememberChatDocs(snap);
  }
  return view;
}

// Stores the list of opened documents on the meta of the turn's chat (best effort; the document's files are kept
// with the document, attachments.js).
async function rememberChatDocs(snap) {
  const ctx = snap.chatCtx;
  if (!ctx || ctx.docId !== state.docId) return;
  const meta = state.chats.find((c) => c.id === ctx.chatId);
  if (!meta) return;
  meta.docs = snap.docs.filter((d) => d.kind !== 'file').map((d) => ({ ...d }));
  await storageSet({ [chatsKey(ctx.docId)]: state.chats });
}

// open_document({url}): returns the tool message fields.
async function openDocumentTool(args, snap, ui = {}) {
  const ref = parseDocRef(args.url);
  if (ref && ref.published) {
    return { content: 'Error: this is a link to a published copy (/document/d/e/.../pub); its ID is not the document\'s ID, so it cannot be opened. Ask the user for the normal document link (https://docs.google.com/document/d/<id>/edit).', _ok: false, _message: 'Published link' };
  }
  if (!ref) {
    return { content: `Error: "${oneLine(args.url == null ? '' : args.url, 200)}" is not a Google Docs document link or ID. Pass a link like https://docs.google.com/document/d/<id>/edit or the document ID.`, _ok: false, _message: 'Not a Google Docs link' };
  }
  if (ref.id === snap.docId) {
    return { content: 'This is the main document (the one in <document>). Read it without the doc parameter (doc: null).', _ok: true, _message: 'The main document' };
  }
  const existing = snap.docs.find((d) => d.id === ref.id);
  const opened = snap.docs.filter((d) => d.kind !== 'file'); // the document's attached files do not count
  if (!existing && opened.length >= MAX_OPEN_DOCS) {
    return { content: `Error: at most ${MAX_OPEN_DOCS} documents can be opened in one chat (opened: ${opened.map((d) => d.alias).join(', ')}). Start a new chat for other documents.`, _ok: false, _message: 'Too many opened documents' };
  }
  // Documents the user did not mention need their permission (a shared document could ask the model to
  // open a private one); a document already opened in this chat was allowed before.
  const au = trustedAuthUser(ref, snap);
  const mainAu = authUserFromUrl(snap.mainUrl);
  if (!existing && !userMentionedDoc(ref.id, snap)) {
    const url = String(args.url).trim();
    const preview = { tool: 'open_document', title: `Open document ${ref.id}?`, kind: 'open', url };
    if (au !== mainAu) { preview.authuser = au; preview.mainAuthuser = mainAu; }
    const refused = await reviewOpen(snap, ui, preview);
    if (refused) return refused;
  }
  const entry = existing || { alias: nextDocAlias(snap.docs), id: ref.id };
  if (!existing) {
    if (ref.tab) entry.tab = ref.tab;
    if (au != null && au !== mainAu) entry.authuser = au; // otherwise the main document's account is used
  }
  const view = await loadOpenDoc(entry, snap, true);
  if (view.error) return { content: `Error: ${view.error}`, _ok: false, _message: 'Could not open the document' };
  entry.title = view.title || entry.title || '';
  entry.lines = docLines(view).length;
  if (!existing) snap.docs.push(entry);
  await rememberChatDocs(snap);
  const outline = hasOutline(view) ? docOutline(view) : null;
  const outlineText = outline == null ? 'Outline unavailable (the document could only be exported as plain text): use find_in_document and read_document.'
    : !outline.length ? 'The document has no headings.'
      : 'Outline (line: heading):\n' + formatOutline(outline.slice(0, OUTLINE_MAX_ITEMS)) +
        (outline.length > OUTLINE_MAX_ITEMS ? `\n[${outline.length - OUTLINE_MAX_ITEMS} more headings: call read_document(scope "outline", doc "${entry.alias}")]` : '');
  const how = `Read it with read_document and find_in_document with doc: "${entry.alias}". It is read-only.`;
  return {
    content: `${existing ? `Already open as ${entry.alias}; read again.` : `Opened as ${entry.alias}.`} Title: ${JSON.stringify(entry.title || 'Untitled document')}. ` +
      `${fmtNum(entry.lines)} lines, ${fmtNum(view.docText.length)} characters.\n${outlineText}\n${how}`,
    _ok: true, _message: `${entry.alias}: ${entry.title || 'Untitled document'}`,
  };
}

// The required fields of a tool's schema (built-in or registered), for the error of arguments that do not parse.
function toolRequiredFields(name) {
  const extra = typeof extraTool === 'function' ? extraTool(name) : null;
  const def = TOOL_DEFS[name] || (extra ? extra.defs.find((d) => d.function.name === name) : null);
  const req = def && def.function.parameters && def.function.parameters.required;
  return Array.isArray(req) ? req : [];
}

// ---- Repeated identical reads ------------------------------------------------------------------------------
// A weak model reads the same lines again and again in one turn. A main-document reading call (name, arguments) is keyed
// on the document state it read: the Docs API model (setSnapModel puts a new model object after every write; its
// revisionId as well), else the length of the exported text, and for get_selection the selection. The identical call
// on an unchanged document never gets the same text again: the first repeat READ_AGAIN_TEXT (or the pointer noteRead was
// given), every later one READ_AGAIN_STOP_TEXT, and the READ_LOOP_REPEATS-th ends the rounds with the wrap-up (toolLoop):
// a model that alternated full results and pointers read on until the round budget ran out. Only a result the request no
// longer carries in full (stubbed to fit the context window: forgetStubbedReads) is read again. snap.readCalls: key ->
// { id (the call whose result holds the text), again (noteRead's pointer: a read whose content the model got another
// way, request.js noteSelectionShown), repeats }.
const READ_AGAIN_TEXT = 'Already read in this message; the document has not changed since: see the earlier result.';
const READ_AGAIN_STOP_TEXT = 'You already have this result; the document has not changed. Do not read it again: go on with the task or answer the user.';
const READ_LOOP_REPEATS = 3;
const readModelIds = new WeakMap();
let readModelSeq = 0;
function readKey(name, args, snap) {
  const m = snap.model;
  let rev = `text ${String(snap.docText == null ? '' : snap.docText).length}`;
  if (snap.docFormat === 'docs-api' && m && typeof m === 'object') {
    if (!readModelIds.has(m)) readModelIds.set(m, ++readModelSeq);
    rev = `${m.revisionId || ''}#${readModelIds.get(m)}`;
  }
  const sel = name === 'get_selection' ? `\u0000${String(snap.selection || '')}` : '';
  return `${name}\u0000${JSON.stringify(args || {})}\u0000${rev}${sel}`;
}
// { text, repeats } when this call repeats a read, else null (the caller reads, then noteRead on success).
function readAgain(name, args, snap) {
  const v = snap.readCalls ? snap.readCalls.get(readKey(name, args, snap)) : null;
  if (!v) return null;
  v.repeats++;
  return { text: v.repeats > 1 ? READ_AGAIN_STOP_TEXT : v.again || READ_AGAIN_TEXT, repeats: v.repeats };
}
// again: the answer to the first repeat instead of READ_AGAIN_TEXT; id: the call whose result holds the text.
function noteRead(name, args, snap, again = '', id = '') {
  (snap.readCalls || (snap.readCalls = new Map())).set(readKey(name, args, snap), { id, again, repeats: 0 });
}
// The reads whose result a request carries only as a stub (fitMessages, the context-length retry; history: the
// request's copy): their identical call reads again.
function forgetStubbedReads(snap, history) {
  if (!snap.readCalls) return;
  const stubbed = new Set((history || []).filter((m) => m && m.role === 'tool' && m._omittedChars).map((m) => m.tool_call_id));
  for (const [key, v] of snap.readCalls) if (v.id && stubbed.has(v.id)) snap.readCalls.delete(key);
}

// The document a reading call works on: the turn snapshot (main document) or an opened document's
// view. Returns { target } or { error } (text for the model).
async function readingTarget(name, args, snap) {
  if (isMainDocRef(args.doc)) return { target: snap };
  const alias = String(args.doc).trim().toLowerCase();
  if (name === 'get_selection') return { error: `Error: ${name} works only on the main document (omit doc or pass null).` };
  const entry = (snap.docs || []).find((d) => d.alias === alias);
  if (!entry) {
    const open = (snap.docs || []).map((d) => d.alias).join(', ');
    return { error: `Error: no document "${String(args.doc).trim()}" is open in this chat${open ? ` (opened: ${open})` : ''}. Open it with open_document first, or pass doc: null for the main document.` };
  }
  const view = await loadOpenDoc(entry, snap, false);
  return view.error ? { error: `Error: ${view.error}` } : { target: view };
}
