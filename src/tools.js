'use strict';
// Module tools.js: client tool definitions (TOOL_DEFS, REPLACE_TOOL, tool name lists and icons), the
// reading tools (runReadingTool) and additional documents (open_document: openDocumentTool, loadOpenDoc,
// readingTarget). toolsFor (the tool set of a turn) stays in request.js. Feature modules add tools through
// registerTools (src/registry.js), not here.
/* global askUser, chatsKey, cleanDocText, confirmOpen, decorated, docLines, docOutline, docsTabFromUrl, fetchDocModel,
   fetchDocTextFromPanel, FIND_MAX_RESULTS, FIND_SNIPPET_CHARS, fmtNum, formatNote, formatOutline, hasOutline,
   locateSelection, MAIN_DOC_REFS, markedText, MAX_OPEN_DOCS, oneLine, OPEN_DENIED_TEXT, OPEN_STOPPED_TEXT,
   OUTLINE_MAX_ITEMS, readLimits, registerTools, sendToTab, setStatus, showText, state, storageSet,
   SUGGESTED_NOTE */
/* exported REPLACE_TOOL, TOOL_DEFS, ASK_USER_TOOL, WRITE_TOOLS, READING_TOOLS, FORMAT_READING_TOOL, READING_TOOL_ICONS,
   QUIET_TOOLS, EDIT_TOOL_ICONS, runReadingTool, readingSummary, isMainDocRef, openDocumentTool, readingTarget */

const REPLACE_TOOL = {
  type: 'function',
  function: {
    name: 'replace_selection',
    description:
      'Replace the text the user has selected in the open Google Docs document with the given text ' +
      '(if nothing is selected, the text is inserted at the cursor position). Pass the complete final ' +
      'replacement text only: plain text, no markdown, no quotes around it, no comments. ' +
      'It is pasted into the document exactly as given. The paste cannot be verified in the same message ' +
      '(the reading tools show the document as it was before it), so call it at most once per message. ' +
      'Main document only.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The full new plain text that replaces the whole selection.' },
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
const DOC_PARAM = { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Alias of a document opened with open_document ("doc2", "doc3", ...), or null for the main document.' };
const TOOL_DEFS = {
  replace_selection: REPLACE_TOOL,
  get_outline: { type: 'function', function: {
    name: 'get_outline',
    description: 'The headings of the document (Markdown headings, or the paragraph heading styles when the document is read through the Google Docs API) with the line number where each section starts. Use it to find where things are before reading.',
    parameters: { type: 'object', properties: { doc: DOC_PARAM }, required: ['doc'], additionalProperties: false },
  } },
  read_lines: { type: 'function', function: {
    name: 'read_lines',
    description: 'The text of the document from line "start" to line "end" (1-based, inclusive), each line prefixed with its number. Each call returns a limited number of lines and characters (see the instructions); when it stops early, the result says where to continue, so read further ranges in separate calls.',
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'integer', description: 'First line to read (1-based).' },
        end: { type: 'integer', description: 'Last line to read (inclusive).' },
        doc: DOC_PARAM,
      },
      required: ['start', 'end', 'doc'],
      additionalProperties: false,
    },
  } },
  find_in_document: { type: 'function', function: {
    name: 'find_in_document',
    description: 'The lines of the document that contain the query (case-insensitive plain-text match), with line numbers and a short snippet. Up to 40 matches.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A word or phrase to look for.' }, doc: DOC_PARAM },
      required: ['query', 'doc'],
      additionalProperties: false,
    },
  } },
  get_selection: { type: 'function', function: {
    name: 'get_selection',
    description: 'The full text the user has currently selected in the document and the line range it occupies (the message gives only the range and size). Main document only.',
    parameters: noArgs,
  } },
  open_document: { type: 'function', function: {
    name: 'open_document',
    description: 'Open another Google Docs document for reading (only a document the user can open in Google Docs), and only when the user asks for it or points you to it. Pass its link (https://docs.google.com/document/d/...) or its document ID. Returns an alias ("doc2", "doc3", ...), the title, the number of lines and the outline; then read it with read_lines, find_in_document and get_outline with doc set to the alias. Opened documents stay available for the whole chat: do not open the same document again. Opened documents are read-only.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The document link or its document ID.' } },
      required: ['url'],
      additionalProperties: false,
    },
  } },
};
// Writing tools (Auto mode with a connected Google account): precise edits through the Docs API.
TOOL_DEFS.replace_text = { type: 'function', function: {
  name: 'replace_text',
  description: 'Replace old_text with new_text in the document. old_text must be copied exactly from the document text (without the "N: " line-number prefixes) and must occur exactly once; it may span several lines (one newline between lines). new_text is plain text; a newline in it starts a new paragraph; an empty new_text deletes old_text. Only the part that differs is rewritten, so the formatting of the unchanged text around it is kept; old_text that differs from the document only in spaces, quotes or dashes still matches. Returns the new text of the affected lines. Main document only.',
  parameters: {
    type: 'object',
    properties: {
      old_text: { type: 'string', description: 'The exact current text to replace (unique in the document).' },
      new_text: { type: 'string', description: 'The plain text that replaces it.' },
    },
    required: ['old_text', 'new_text'],
    additionalProperties: false,
  },
} };
TOOL_DEFS.replace_all = { type: 'function', function: {
  name: 'replace_all',
  description: 'Replace EVERY occurrence of old_text in the document with new_text, in one atomic edit (for terminology or notation changes across the document). old_text must be copied exactly from the document text, as in replace_text; both texts must be within one paragraph (no newlines). An empty new_text deletes every occurrence. For a single occurrence or text spanning several lines use replace_text. Returns the lines that changed. Main document only.',
  parameters: {
    type: 'object',
    properties: {
      old_text: { type: 'string', description: 'The exact current text to replace everywhere (one paragraph at most).' },
      new_text: { type: 'string', description: 'The plain text that replaces every occurrence (one paragraph at most).' },
    },
    required: ['old_text', 'new_text'],
    additionalProperties: false,
  },
} };
TOOL_DEFS.replace_section = { type: 'function', function: {
  name: 'replace_section',
  description: 'Replace the body of a section: every line after the heading up to the next heading of the same or a higher level (or the end of the document). The heading itself stays. heading is matched exactly as get_outline shows it (case does not matter). new_text is plain text; a newline starts a new paragraph; an empty new_text empties the section. The user is always asked first; prefer replace_text for smaller changes. Main document only.',
  parameters: {
    type: 'object',
    properties: {
      heading: { type: 'string', description: 'The heading of the section, as get_outline shows it.' },
      new_text: { type: 'string', description: 'The plain text of the new section body.' },
    },
    required: ['heading', 'new_text'],
    additionalProperties: false,
  },
} };
// A property of format_text: a value of the given type, or null (leave as it is).
const FLAG_PARAM = (type, description) => ({ anyOf: [{ type }, { type: 'null' }], description });
TOOL_DEFS.format_text = { type: 'function', function: {
  name: 'format_text',
  description: 'Change the formatting of the passage old_text (copied exactly from the document, unique; no line numbers, no markers). Every property: null = leave as it is. Returns the lines as they look now. Main document only.',
  parameters: {
    type: 'object',
    properties: {
      old_text: { type: 'string', description: 'Exact current text to format.' },
      bold: FLAG_PARAM('boolean', 'true sets, false removes, null leaves.'),
      italic: FLAG_PARAM('boolean', 'Same as bold.'),
      underline: FLAG_PARAM('boolean', 'Same as bold.'),
      font: FLAG_PARAM('string', 'Font family, e.g. "Arial", "Times New Roman"; "default" resets.'),
      size: FLAG_PARAM('number', 'Font size in pt (1-400); 0 resets.'),
      color: FLAG_PARAM('string', 'Text color: "#RRGGBB" or a name (red, blue…); "none" resets.'),
      highlight: FLAG_PARAM('string', 'Background color like color; "none" removes.'),
      link: FLAG_PARAM('string', 'URL (https://…, mailto:) to link the text to; "" or "none" removes the link.'),
    },
    required: ['old_text', 'bold', 'italic', 'underline', 'font', 'size', 'color', 'highlight', 'link'],
    additionalProperties: false,
  },
} };
// Paragraph formatting of whole lines (format_lines, docs-write.js planFormatLines).
const nullable = (type, description, extra = {}) => ({ anyOf: [{ type, ...extra }, { type: 'null' }], description });
TOOL_DEFS.format_lines = { type: 'function', function: {
  name: 'format_lines',
  description: 'Paragraph formatting of whole lines start..end: heading style, alignment, list, indents, spacing. Every property: null = leave as it is. The text does not change. Returns the lines as they look now. Main document only.',
  parameters: {
    type: 'object',
    properties: {
      start: { type: 'integer', description: 'First line (1-based).' },
      end: { type: 'integer', description: 'Last line (inclusive).' },
      style: nullable('string', 'Paragraph style; normal = Normal text.', { enum: ['title', 'subtitle', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'normal'] }),
      align: nullable('string', 'Alignment.', { enum: ['left', 'center', 'right', 'justify'] }),
      list: nullable('string', 'Make the lines a list, or none to remove it.', { enum: ['bullet', 'number', 'checklist', 'none'] }),
      indent_start: nullable('number', 'Left indent in pt from the margin (0 removes).'),
      indent_first_line: nullable('number', 'First-line position in pt from the margin.'),
      space_above: nullable('number', 'Space before the paragraph in pt.'),
      space_below: nullable('number', 'Space after the paragraph in pt.'),
      line_spacing: nullable('number', 'Line spacing as a multiplier: 1, 1.15, 1.5, 2.'),
    },
    required: ['start', 'end', 'style', 'align', 'list', 'indent_start', 'indent_first_line', 'space_above', 'space_below', 'line_spacing'],
    additionalProperties: false,
  },
} };
TOOL_DEFS.insert_after_line = { type: 'function', function: {
  name: 'insert_after_line',
  description: 'Insert text as new paragraph(s) after line "line" (0 = at the very beginning of the document). Newlines in text separate paragraphs; trailing newlines are dropped. After the last paragraph of a table cell the text goes inside that cell. Returns the inserted lines with their new numbers. Main document only.',
  parameters: {
    type: 'object',
    properties: {
      line: { type: 'integer', description: 'The line after which to insert (0 = before line 1).' },
      text: { type: 'string', description: 'The plain text of the new paragraph(s).' },
    },
    required: ['line', 'text'],
    additionalProperties: false,
  },
} };
TOOL_DEFS.delete_lines = { type: 'function', function: {
  name: 'delete_lines',
  description: 'Delete whole lines (paragraphs) start..end (1-based, inclusive). Returns the text around the deletion with the new line numbers. Main document only.',
  parameters: {
    type: 'object',
    properties: {
      start: { type: 'integer', description: 'First line to delete.' },
      end: { type: 'integer', description: 'Last line to delete (inclusive).' },
    },
    required: ['start', 'end'],
    additionalProperties: false,
  },
} };
TOOL_DEFS.undo_last_edit = { type: 'function', function: {
  name: 'undo_last_edit',
  description: 'Revert the most recent edit in this chat that has not been undone yet (replace_text, replace_all, replace_section, format_text, format_lines, insert_after_line, delete_lines, or a replace_selection made through the Docs API). Main document only.',
  parameters: noArgs,
} };
// Inline formatting (main document read through the Docs API): offered with the reading tools then.
TOOL_DEFS.read_formatting = { type: 'function', function: {
  name: 'read_formatting',
  description: 'The text of lines "start" to "end" (1-based, inclusive) like read_lines, with formatting shown as notation: **bold**, *italic*, __underline__, [text](url) for links, {text}(font= size= color= bg=) for fonts and colors, and a [tag] after the line number for heading style, list, alignment, indent and spacing (e.g. "3: [h2] Methods", "4: [number] First item"). The notation is not document text: never copy it into old_text. Same limits as read_lines. Main document only.',
  parameters: {
    type: 'object',
    properties: {
      start: { type: 'integer', description: 'First line to read (1-based).' },
      end: { type: 'integer', description: 'Last line to read (inclusive).' },
    },
    required: ['start', 'end'],
    additionalProperties: false,
  },
} };
// remember: a standing rule added to (or removed from) the document instructions (doc-instructions.js
// rememberTool). Not a document edit: no journal, no gate. Offered with the reading tools.
TOOL_DEFS.remember = { type: 'function', function: {
  name: 'remember',
  description: "Add a standing rule to this document's instructions (sent with every message), or remove one. Only when the user asks to remember or forget something for the future.",
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'text'],
    properties: {
      action: { type: 'string', enum: ['add', 'remove'], description: 'add appends the rule as a new line; remove deletes the line that matches text exactly.' },
      text: { type: 'string', description: "The rule, one line, in the user's wording." },
    },
  },
} };
// ask_user: buttons for a choice that blocks the model (gate.js askUser). Reads and writes nothing, so it is
// offered in every turn with client tools (Manual and side questions included). Registered (registerTools,
// below) rather than in TOOL_DEFS, since toolsFor offers the built-in tools by mode: it comes after the
// built-in tools, so their prefix of the tool list stays as it was, and before the feature modules' tools.
// Not a reading tool: its answer survives slimHistory and the call gets a card. runToolCall (turn.js) calls
// askUser itself (runExtraTool would refuse a non-reading tool outside Auto). 2–4 options are checked when it
// runs (strict schemas cannot bound array sizes on every provider).
const ASK_USER_TOOL = { type: 'function', function: {
  name: 'ask_user',
  description: 'Ask the user one short question with 2 to 4 answer buttons, for a choice you cannot make yourself and that blocks your work. The user may also answer in the chat instead. At most once per message.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'One short sentence.' },
      options: { type: 'array', items: { type: 'string' }, description: '2 to 4 short answers, each a few words.' },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
} };
registerTools(ASK_USER_TOOL, {
  offer: () => true,
  reading: false,
  run: (name, args, snap, ui) => askUser(args, snap, ui), // required by registerTools; runToolCall calls askUser first
  summary: (name, args) => (typeof args.question === 'string' ? oneLine(args.question, 60) : ''),
  icon: '❓',
  pending: 'Preparing a question…',
  // No prompt line: the description says when to ask and how often.
});
const WRITE_TOOLS = ['replace_text', 'replace_all', 'replace_section', 'format_text', 'format_lines', 'insert_after_line', 'delete_lines', 'undo_last_edit'];
const READING_TOOLS = ['get_outline', 'read_lines', 'find_in_document', 'get_selection'];
const FORMAT_READING_TOOL = 'read_formatting';
const READING_TOOL_ICONS = { get_outline: '📑', read_lines: '📖', find_in_document: '🔍', get_selection: '✂️', read_formatting: '🎨', open_document: '📂' };
// Tools that only read (no edit card; a quiet row in the action log).
const QUIET_TOOLS = [...READING_TOOLS, FORMAT_READING_TOOL, 'open_document'];
const EDIT_TOOL_ICONS = { replace_text: '✏️', replace_all: '🔁', replace_section: '📝', format_text: '🖌️', format_lines: '📐', insert_after_line: '➕', delete_lines: '🗑️', undo_last_edit: '↩️', replace_selection: '✏️', remember: '📌' };

// ---- Reading tools (tools mode): executed locally on the turn's document snapshot --------------
const snippetAround = (line, at, len) => {
  const pad = Math.max(0, Math.floor((FIND_SNIPPET_CHARS - len) / 2));
  const from = Math.max(0, at - pad);
  const to = Math.min(line.length, at + len + pad);
  return (from > 0 ? '…' : '') + line.slice(from, to).trim() + (to < line.length ? '…' : '');
};

// Returns the tool's text result (always a string; errors are described in the text). limits: the
// per-call limits of read_lines / read_formatting ({chars, lines}, see readLimits); by default those of
// the snapshot's provider (an opened document's view has none: the defaults then).
function runReadingTool(name, args, snap, limits = readLimits(snap.prov)) {
  if (snap.docText == null) return `Error: the document text is unavailable (${snap.docError || 'export failed'}).`;
  const lines = docLines(snap).map(showText); // soft line breaks shown as a mark
  // Lines with suggested changes (Docs API) are marked in read_lines.
  const flag = (i) => (snap.docFormat === 'docs-api' && snap.model && snap.model.lines[i] && snap.model.lines[i].suggested ? SUGGESTED_NOTE : '');
  // Registered line notation (registerLineDecorator: table cells), Docs API models only; none: '' (unchanged output).
  const deco = (i) => (snap.docFormat === 'docs-api' && snap.model ? decorated(snap.model, snap.model.lines[i]) : { label: '', before: '' });
  switch (name) {
    case 'get_outline': {
      if (!hasOutline(snap)) return 'The outline is unavailable: the document could only be exported as plain text. Use find_in_document and read_lines instead.';
      const items = docOutline(snap);
      if (!items.length) return `The document has no headings (${lines.length} lines).`;
      return `${items.length} heading${items.length === 1 ? '' : 's'} (${lines.length} lines in total):\n` + formatOutline(items);
    }
    case 'read_formatting':
    case 'read_lines': {
      const fmt = name === 'read_formatting';
      if (fmt && (snap.docFormat !== 'docs-api' || !snap.model)) return 'Error: formatting is only available when the document is read through the Google Docs API.';
      const total = lines.length;
      const start = Math.max(1, Math.floor(Number(args.start)) || 1);
      let wanted = Math.floor(Number(args.end));
      if (!Number.isFinite(wanted) || wanted < start) wanted = start;
      if (start > total) return `Error: the document has only ${total} lines.`;
      const end = Math.min(wanted, total, start + limits.lines - 1);
      const out = [];
      let chars = 0;
      let last = start - 1;
      for (let i = start; i <= end; i++) {
        const d = deco(i - 1);
        const l = `${d.before ? d.before + '\n' : ''}${i}${d.label}: ${fmt ? markedText(snap.model.lines[i - 1], snap.model.textDefault) : lines[i - 1]}${flag(i - 1)}`;
        if (out.length && chars + l.length > limits.chars) break;
        out.push(l);
        chars += l.length + 1;
        last = i;
      }
      const note = last < Math.min(wanted, total) ? `\n[Stopped at line ${last} (limit per call). Call ${name}(${last + 1}, ${Math.min(wanted, total)}) to continue.]` : '';
      return `${fmt ? formatNote(snap.model) + '\n' : ''}Lines ${start}-${last} of ${total}:\n${out.join('\n')}${note}`;
    }
    case 'find_in_document': {
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
      const where = loc ? `lines ${loc.start}-${loc.end}` : 'position in the document not found';
      return `Selection (${where}, ${fmtNum(snap.selection.length)} characters):\n${snap.selection}`;
    }
    default:
      return `Error: unknown tool "${name}".`;
  }
}

// One-line summary of a reading call for the activity rows under an answer (the opened document's
// alias in parentheses when the call reads one).
function readingSummary(name, args) {
  const on = isMainDocRef(args.doc) ? '' : ` (${String(args.doc).trim()})`;
  if (name === 'read_lines' || name === FORMAT_READING_TOOL) return `lines ${args.start}–${args.end}${on}`;
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
// chat (not in a summary) or in the document instructions. Such documents open without confirmation.
function userMentionedDoc(id, snap) {
  return userTexts(snap).some((t) => t.includes(id));
}
// The user's own texts of this chat (not summaries, not the panel's automatic continuation requests) and the
// document instructions.
function userTexts(snap) {
  const msgs = (snap.chatCtx && snap.chatCtx.messages) || state.messages;
  return [...msgs.filter((m) => m.role === 'user' && !m._summary && !m._auto && typeof m.content === 'string').map((m) => m.content),
    String(snap.docInstructions || '')];
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
  if (!force && snap.docCache.has(entry.alias)) return snap.docCache.get(entry.alias);
  let view = null;
  let apiErr = '';
  if (snap.googleConnected) {
    try {
      const model = await fetchDocModel(entry.id, entry.tab || null, false);
      view = { docText: model.text, docFormat: 'docs-api', model, title: model.title || entry.title || '' };
    } catch (e) { apiErr = e.message; }
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
        return { error: `could not open the document ${entry.id} (${apiErr ? `Google Docs API: ${apiErr} ` : ''}export: ${tabErr ? `${tabErr}; ` : ''}${e.message}). ` +
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

// Stores the list of opened documents on the meta of the turn's chat (best effort).
async function rememberChatDocs(snap) {
  const ctx = snap.chatCtx;
  if (!ctx || ctx.docId !== state.docId) return;
  const meta = state.chats.find((c) => c.id === ctx.chatId);
  if (!meta) return;
  meta.docs = snap.docs.map((d) => ({ ...d }));
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
  if (!existing && snap.docs.length >= MAX_OPEN_DOCS) {
    return { content: `Error: at most ${MAX_OPEN_DOCS} documents can be opened in one chat (opened: ${snap.docs.map((d) => d.alias).join(', ')}). Start a new chat for other documents.`, _ok: false, _message: 'Too many opened documents' };
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
  const outlineText = outline == null ? 'Outline unavailable (the document could only be exported as plain text): use find_in_document and read_lines.'
    : !outline.length ? 'The document has no headings.'
      : 'Outline (line: heading):\n' + formatOutline(outline.slice(0, OUTLINE_MAX_ITEMS)) +
        (outline.length > OUTLINE_MAX_ITEMS ? `\n[${outline.length - OUTLINE_MAX_ITEMS} more headings: call get_outline(doc: "${entry.alias}")]` : '');
  const how = `Read it with read_lines, find_in_document and get_outline with doc: "${entry.alias}". It is read-only.`;
  return {
    content: `${existing ? `Already open as ${entry.alias}; read again.` : `Opened as ${entry.alias}.`} Title: ${JSON.stringify(entry.title || 'Untitled document')}. ` +
      `${fmtNum(entry.lines)} lines, ${fmtNum(view.docText.length)} characters.\n${outlineText}\n${how}`,
    _ok: true, _message: `${entry.alias}: ${entry.title || 'Untitled document'}`,
  };
}

// The document a reading call works on: the turn snapshot (main document) or an opened document's
// view. Returns { target } or { error } (text for the model).
async function readingTarget(name, args, snap) {
  if (isMainDocRef(args.doc)) return { target: snap };
  const alias = String(args.doc).trim().toLowerCase();
  if (name === 'get_selection' || name === FORMAT_READING_TOOL) return { error: `Error: ${name} works only on the main document (omit doc or pass null).` };
  const entry = (snap.docs || []).find((d) => d.alias === alias);
  if (!entry) {
    const open = (snap.docs || []).map((d) => d.alias).join(', ');
    return { error: `Error: no document "${String(args.doc).trim()}" is open in this chat${open ? ` (opened: ${open})` : ''}. Open it with open_document first, or pass doc: null for the main document.` };
  }
  const view = await loadOpenDoc(entry, snap, false);
  return view.error ? { error: `Error: ${view.error}` } : { target: view };
}
