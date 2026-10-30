'use strict';
// Module constants.js: provider table, limits, storage keys and other constants (no prompt texts,
// no tool definitions). Loaded first: the later modules read these at load time. The panel overview follows.
/* exported PROVIDERS, PROVIDER_IDS, DEFAULT_PROVIDER, PROVIDER_STORAGE_KEY, SETTING_FIELDS, storageKey, modelsKey,
   STALE_SETTING_KEYS, NOTICE_TTL_MS, KEY_CHECK_DEBOUNCE_MS, STREAM_RETRY_STATUS, STREAM_RETRY_DELAYS_MS,
   STREAM_RENDER_MIN_MS, STREAM_RENDER_MAX_MS,
   EXPORT_RETRY_DELAYS_MS, EXPORT_RETRY_AFTER_MAX_MS, EXPORT_RATE_LIMITED, DOC_URL_RE,
   PERSONA_DOC_CHAR_LIMIT, MAX_TOOL_ITERATIONS, READ_MAX_LINES, READ_MAX_CHARS, FIND_MAX_RESULTS,
   FIND_SNIPPET_CHARS, OUTLINE_MAX_ITEMS, PROMPT_SELECTION_MAX, SELECTION_INLINE_MAX, SELECTION_EXCERPT_CHARS,
   DOC_INSTRUCTIONS_MAX, docInstructionsKey, DOC_INSTRUCTIONS_NOTE, DOC_TEXT_PREFIX, MAX_OPEN_DOCS, MAIN_DOC_REFS, SUMMARY_PREFIX,
   SUMMARY_RESERVE_TOKENS, COMPACT_MSG_CHARS, COMPACT_TOOL_CHARS, COMPACTED_TOOL_KEEP_CHARS, COMPACTED_TOOL_MARKER,
   COMPACT_AT_TOKENS, GAUGE_WARN_RATIO, FOLD_NOTE, FOLD_ARGS_CHARS, FOLD_ARG_VALUE_CHARS, FOLD_ERROR_CHARS, FOLD_HEADROOM_TOKENS,
   STUB_MIN_CHARS, TURN_RESULTS_KEPT, DOC_CHANGES_MAX_HEADINGS, CONTEXT_SHORT_SELECTION_CHARS,
   GOOGLE_CONNECTED_KEY, GOOGLE_ACCOUNT_KEY, GOOGLE_TOKEN_KEY, GOOGLE_CLIENT_ID, GOOGLE_SIGNIN_SCOPES, GOOGLE_AUTH_URL,
   USERINFO_URL, DOCS_API_URL, DOCS_GET_FIELDS, GOOGLE_REVOKE_URL, OBJECT_CHAR, SOFT_BREAK_MARK,
   DOCS_SCOPE, ANCHOR_CHARS, SUGGESTED_NOTE, EDIT_REPORT_MAX_LINES, EDIT_REPORT_MAX_CHARS,
   LOG_MAX_CHARS, OPEN_DENIED_TEXT, OPEN_STOPPED_TEXT, ANTHROPIC_VERSION, ANTHROPIC_FALLBACK_MODELS,
   ANTHROPIC_FALLBACK_BETA, PERSONAS, COMMAND_RE, SELFTEST_COMMANDS, SELFTEST_RE, SIDE_COMMANDS, SIDE_RE, WEB_SEARCH_PROVIDERS, ANTHROPIC_WEB_SEARCH_MAX_USES, SOURCES_MAX,
   EDIT_SAFETY_TOKENS, PERSONA_OVERHEAD_TOKENS, PERSONA_SAFETY_TOKENS, MIN_BUDGET_TOKENS, CHARS_PER_TOKEN,
   NUM_LOCALE, INPUT_HEIGHT_KEY, INPUT_HEIGHT_DEFAULT, INPUT_HEIGHT_MIN, INPUT_ROW_MIN, CHAT_MIN_HEIGHT,
   APPLY_MODE_KEY, APPLY_MODES, APPLY_MODE_ORDER, APPLY_MODE_DESCS, MODE_BUTTON_TITLE, PLAN_DO_TEXT, THEME_KEY, SYSTEM_THEME_QUERY, PANEL_WIDTH_KEY, HOST_TAB_ID, GATE_DELETE_LINES, GATE_REPLACE_CHARS,
   GATE_REPLACE_ALL_COUNT, GATE_FORMAT_LINES, EDIT_DENIED_TEXT, EDIT_STOPPED_TEXT, ASK_CHAT_TEXT, ASK_STOPPED_TEXT, ASK_AGAIN_TEXT,
   ASK_MAX_OPTIONS, AUTO_CONTINUE_TEXT, AUTO_CONTINUE_NOTICE, WRAP_UP_TEXT, WRAP_UP_NOTICE, CONTINUE_TEXT, NUDGE_TEXT, NUDGE_MAX_CHARS,
   BACKGROUND_COMPACT_RATIO, READ_FIRST_EDGE_LINES, READ_FIRST_LINE_CHARS, UNDO_ALL_PENDING_TEXT, UNDO_RUNNING_TEXT, SELECTION_CHANGED_NOTICE, PASTE_UNCONFIRMED,
   PASTE_DONE_NOTE, PASTE_AGAIN_TEXT, PASTE_AGAIN_CARD, REFERENCES_KEY, REFERENCES_ORIGINS, CITATIONS_PREFIX, citationsKey, ZOTERO_URL,
   CROSSREF_URL, MUNIN_SAMPLING, MUNIN_REASONING_EFFORT, STYLE_MIN_WORDS, STYLE_SAMPLE_CHARS,
   DOC_PASS_MODES, DOC_PASS_INLINE_SHARE, PAPER_CARD_PREFIX, paperCardKey, OPENALEX_URL */

// Assistant panel (runs as an extension page inside an iframe that content.js injects into the
// Google Docs page; the host tab ID comes from location.hash "#tabId=N"): chat UI, settings,
// messaging with the content script, and streaming API clients for three providers:
//   - Munin: OpenAI-compatible Chat Completions in raw mode, plus Munin's persona stream for
//     /research, /code, /chat turns (server-side web + paper search);
//   - OpenAI (ChatGPT models): the Responses API;
//   - Anthropic (Claude models): the Messages API.
// Every provider runs the same tool loop (reading tools, replace_selection and, with a connected Google
// account, the Docs API editing tools). The chat history is kept in one provider-neutral shape (OpenAI
// Chat Completions messages), so a chat can continue on another provider.

// ---------------------------------------------------------------------------
// Constants and state
// ---------------------------------------------------------------------------
// Providers. Each one has its own settings (API key, model; the endpoint baseUrl is fixed), stored in
// chrome.storage.local under "<storagePrefix><Field>" (Munin keeps the key names of earlier versions,
// so an existing Munin key is picked up). "muninProvider" holds the active one. Reply length
// (maxTokens) and sampling are fixed per provider: only a provider with a sampling object (Munin) sends
// sampling fields; the others use the server defaults.
// readMaxChars / readMaxLines: the per-call limits of read_lines and read_formatting.
// Munin raw-mode sampling. Munin's own personas use temperature 1.0, top_p 0.95, top_k 20, presence_penalty 1.5
// (chat) and temperature 0.6, presence_penalty 0 (code); without these fields raw mode gets vLLM's defaults.
// A middle ground: varied enough for prose, steady enough for exact old_text and tool arguments.
const MUNIN_SAMPLING = { temperature: 0.7, top_p: 0.95, top_k: 20, presence_penalty: 1.0 };
// Munin raw-mode tools turns: chat_template_kwargs.reasoning_effort ("xhigh" | "medium" | "low"; Munin injects
// "medium" when none is sent). Reasoning tokens count against max_tokens and the shared 64k window.
const MUNIN_REASONING_EFFORT = 'low';
const PROVIDERS = {
  munin: {
    id: 'munin', label: 'Munin', storagePrefix: 'munin',
    baseUrl: 'https://api.muninai.org/v1', model: 'qwen3.8-27b', maxTokens: 8192, // reasoning counts against it
    sampling: MUNIN_SAMPLING,
    keyPrefix: '', // Munin keys have no fixed prefix: no prefix warning
    contextTokens: 65536, // 64k-token context shared with the chat and the answer
    readMaxChars: 8000, readMaxLines: 100,
    personas: true,
    keyHint: 'Get a key in Munin Chat: click your name → Settings → API Keys.',
  },
  openai: {
    id: 'openai', label: 'OpenAI (ChatGPT)', storagePrefix: 'openai',
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', maxTokens: 32000,
    keyPrefix: 'sk-',
    contextTokens: 200000,
    readMaxChars: 24000, readMaxLines: 300,
    personas: false,
    keyHint: 'Create a key at platform.openai.com → API keys.',
  },
  anthropic: {
    id: 'anthropic', label: 'Anthropic (Claude)', storagePrefix: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5', maxTokens: 32000,
    keyPrefix: 'sk-ant-',
    contextTokens: 200000,
    readMaxChars: 24000, readMaxLines: 300,
    personas: false,
    keyHint: 'Create a key in the Anthropic Console (console.anthropic.com) → API Keys.',
  },
};
const PROVIDER_IDS = Object.keys(PROVIDERS);
const DEFAULT_PROVIDER = 'munin';
const PROVIDER_STORAGE_KEY = 'muninProvider';
const SETTING_FIELDS = ['apiKey', 'model'];
// Storage keys of removed settings, deleted at startup: "Confirm edits" and the document mode (2.6), the
// pasted Google OAuth client ID (the client is built in: GOOGLE_CLIENT_ID), the per-provider Base URL (every
// endpoint is fixed; "<prefix>BaseUrl") and the per-provider Effort (requests use the model's default effort;
// "<prefix>Effort"), the Animations setting (the panel always animates).
const STALE_SETTING_KEYS = ['muninConfirmEdits', 'muninDocMode', 'muninGoogleClientId', 'muninMotion',
  ...PROVIDER_IDS.flatMap((id) => [PROVIDERS[id].storagePrefix + 'BaseUrl', PROVIDERS[id].storagePrefix + 'Effort'])];
const storageKey = (providerId, field) => PROVIDERS[providerId].storagePrefix + field[0].toUpperCase() + field.slice(1);
const modelsKey = (providerId) => PROVIDERS[providerId].storagePrefix + 'Models'; // cached model list
const NOTICE_TTL_MS = 10000; // chat notices fade out after this; errors stay
const KEY_CHECK_DEBOUNCE_MS = 700; // model list refresh after the API key was edited
// Transient provider failures (rate limit, overload, gateway, pre-stream network error) are retried
// when nothing was streamed yet: one delay per retry.
// Quota errors are not transient (Munin's HTTP 429 is the monthly quota, OpenAI's 429 with insufficient_quota
// an empty balance): apiError marks them err.quota and they are never retried.
const STREAM_RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const STREAM_RETRY_DELAYS_MS = [2000, 5000];
// The live answer bubble is repainted at most once per clamp(2 × the last repaint's duration) within these
// bounds (createRenderCoordinator): every frame while repaints are fast, a few times a second when slow.
const STREAM_RENDER_MIN_MS = 16;
const STREAM_RENDER_MAX_MS = 250;
// The Docs export answers HTTP 429 when it is asked several times within a few seconds: one wait per retry
// (a Retry-After header is honored up to EXPORT_RETRY_AFTER_MAX_MS; a longer one is not waited for).
const EXPORT_RETRY_DELAYS_MS = [2000, 5000];
const EXPORT_RETRY_AFTER_MAX_MS = 30000;
const EXPORT_RATE_LIMITED = 'the Google export is rate-limited (HTTP 429); wait a minute and try again';
const DOC_URL_RE = /^https:\/\/docs\.google\.com\/document\//;
const PERSONA_DOC_CHAR_LIMIT = 30000; // Munin persona turns: Munin adds its own prompt and tool results
const MAX_TOOL_ITERATIONS = 12; // reading rounds are cheap; the instructions still allow one replacement per request
// Document access: the outline goes into the prompt and the text is read on demand with the reading
// tools (Munin persona turns are the exception: their pipeline has no client tools, so they get a
// document excerpt in the prompt instead).
// Reading tools: limits per call and for the prompt (READ_MAX_*: used when the provider is not known;
// the providers set their own readMaxChars / readMaxLines).
const READ_MAX_LINES = 300;
const READ_MAX_CHARS = 24000;
const FIND_MAX_RESULTS = 40;
const FIND_SNIPPET_CHARS = 160;
const OUTLINE_MAX_ITEMS = 150; // headings listed in the prompt; get_outline() returns them all
const PROMPT_SELECTION_MAX = 4000; // Munin persona prompt: a selection that cannot be located there is shortened
const SELECTION_INLINE_MAX = 600; // Munin persona prompt: longer located selections are given by position plus an excerpt
const SELECTION_EXCERPT_CHARS = 150; // the beginning and the end of a long selection shown in the prompt
// Document instructions (an analog of CLAUDE.md per document): free text the user writes once, stored per
// document id and shared by all chats of the document; placed in the system prompt head of every turn.
const DOC_INSTRUCTIONS_MAX = 8000;
const docInstructionsKey = (docId) => 'muninDocInstructions:' + docId;
// The text baseline of document_changes (src/doc-history.js), one key per document: muninDocText:<docId>. The
// storage cleanup (src/chats.js) removes it together with the document's chats.
const DOC_TEXT_PREFIX = 'muninDocText:';
const DOC_INSTRUCTIONS_NOTE = 'The user has written standing instructions for this document (inside <document_instructions>). Follow them in every answer and every edit.';
// Additional documents (open_document): other Google Docs opened for reading, kept per chat on the chat meta
// (docs: [{alias, id, title, lines, tab?, authuser?}]). The main document has no alias (doc: null).
const MAX_OPEN_DOCS = 10;
// "null": parsers that deliver tool arguments as strings (Qwen-style XML calls) send doc: null that way.
const MAIN_DOC_REFS = ['', 'null', 'main', 'doc1'];
// History compaction: when the first request of a turn is over budget, the oldest turns are replaced by a
// summary written by the active provider (the dropped messages stay in the chat for display).
const SUMMARY_PREFIX = '[Summary of the earlier conversation]';
const SUMMARY_RESERVE_TOKENS = 1500; // room kept for the summary message itself
const COMPACT_MSG_CHARS = 4000; // per user / assistant message in the summarization request
const COMPACT_TOOL_CHARS = 600; // per tool call's arguments and result
// A compacted tool result is never sent again (only shown dimmed): its content is cut to this many characters.
const COMPACTED_TOOL_KEEP_CHARS = 1000;
const COMPACTED_TOOL_MARKER = '… [shortened after compaction]';
// OpenAI and Anthropic: a turn whose first request is estimated above this compacts the history (well below
// their context window, so long chats stay cheap); Munin compacts at its context budget.
const COMPACT_AT_TOKENS = 80000;
// The context gauge (composer bar) turns to its warning tint at this share of the compaction trigger.
const GAUGE_WARN_RATIO = 0.8;
// Folding, the first compaction stage (no request): the old turns become one message with the user's texts,
// the final answers and one line per tool call; only failed calls keep (part of) their result, because a
// successful read can be done again and a failure explains why something was not done.
const FOLD_NOTE = '(Earlier turns condensed: one line per tool call; results are kept only for failed calls. Re-read the document when you need its text.)';
const FOLD_ARGS_CHARS = 100; // a folded call's arguments, in all
const FOLD_ARG_VALUE_CHARS = 40; // each argument value, so that one long text does not hide the others
const FOLD_ERROR_CHARS = 500; // a failed call's result
// The fold is used only when the request then stays this far below the compaction trigger (about the room
// a summary leaves), so the next message does not compact again at once.
const FOLD_HEADROOM_TOKENS = 1000;
// History slimming: reading-tool results longer than this are replaced by a short stub after their turn,
// and when a request inside a turn is over budget (all but the last TURN_RESULTS_KEPT results of the turn).
const STUB_MIN_CHARS = 200;
const TURN_RESULTS_KEPT = 2;
// The <document_changes> note of the turn context: headings listed per kind (moved / new / removed).
const DOC_CHANGES_MAX_HEADINGS = 5;
// The measured style line of the turn context (styleLine in request.js): computed from the first
// STYLE_SAMPLE_CHARS characters of the document, only when they hold at least STYLE_MIN_WORDS words.
const STYLE_SAMPLE_CHARS = 20000;
const STYLE_MIN_WORDS = 400;
// Munin (no prompt cache): the context of older turns is sent shortened; a selection up to this length stays.
const CONTEXT_SHORT_SELECTION_CHARS = 300;
// Google account and the Docs API (global). Sign in with Google runs the implicit flow of
// chrome.identity.launchWebAuthFlow with the built-in client; the token is kept in chrome.storage.session
// (GOOGLE_TOKEN_KEY), the signed-in account ({ email, name }) in chrome.storage.local (GOOGLE_ACCOUNT_KEY),
// and the panel remembers "connected" (GOOGLE_CONNECTED_KEY).
const GOOGLE_CONNECTED_KEY = 'muninGoogleConnected';
const GOOGLE_ACCOUNT_KEY = 'muninGoogleAccount';
const GOOGLE_TOKEN_KEY = 'muninGoogleToken';
// The "Web application" OAuth client of this deployment (its redirect URI is
// https://<extension id>.chromiumapp.org/, the ID pinned by the manifest "key"). Empty: sign-in is
// unavailable and the panel says so; the export + paste fallback still works. Forks register their own
// client: README, section Google account.
const GOOGLE_CLIENT_ID = '396733404321-fe9vufvsdats99bp1fcukctogpa2l1d2.apps.googleusercontent.com';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const DOCS_API_URL = 'https://docs.googleapis.com/v1/documents/';
// documents.get field mask (fetchDocModel): exactly what buildLineModel reads. Tabs nest up to three levels
// and a table may sit in a table cell (one level is spelled out: deeper tables come back as bare elements,
// their paragraphs are then missing from the line model). Paragraph elements other than textRun are listed
// whole (small; their textStyle and suggestion ids are read); an element type missing from the list still
// returns its startIndex/endIndex, so the index arithmetic stays exact. With includeTabsContent=true the
// legacy doc.body is not filled, so it is not requested. Formatting: the text styles and paragraph fields
// read_formatting shows (and the format tools restore on undo), the bullet of a paragraph and the tab's
// lists (to tell numbered, bulleted and checklists apart). Tables and page parts (model.tables, model.segments,
// model.toc): an outer table's column count, column widths and cell spans, the table of contents whole, and the
// tab's headers, footers and footnotes whole with documentStyle (whole: listing its eight header/footer fields
// would push the mask from about 5.1 to 5.6 KB). Comments are not read here (a separate GET when needed).
const DOCS_GET_FIELDS = (() => {
  const textStyle = 'textStyle(bold,italic,underline,link,fontSize,weightedFontFamily,foregroundColor,backgroundColor)';
  const elements = `elements(startIndex,endIndex,textRun(content,${textStyle},` +
    'suggestedInsertionIds,suggestedDeletionIds),autoText,pageBreak,columnBreak,footnoteReference,horizontalRule,' +
    'equation,inlineObjectElement,person,richLink)';
  const paragraphStyle = 'paragraphStyle(namedStyleType,alignment,lineSpacing,spaceAbove,spaceBelow,indentStart,indentFirstLine,direction)';
  const paragraph = `paragraph(${elements},${paragraphStyle},bullet(listId,nestingLevel))`;
  // top: the body's own structural elements (outer tables, the table of contents); nested tables read less.
  const table = (tableDepth, top) => (top
    ? `table(columns,tableStyle(tableColumnProperties(widthType,width)),tableRows(tableCells(tableCellStyle(rowSpan,columnSpan),${content(tableDepth - 1)})))`
    : `table(tableRows(tableCells(${content(tableDepth - 1)})))`);
  const content = (tableDepth, top = false) => `content(startIndex,endIndex,${paragraph}` +
    (tableDepth > 0 ? `,${table(tableDepth, top)}` : '') + (top ? ',tableOfContents' : '') + ')';
  const body = `documentTab(body(${content(2, true)}),lists,headers,footers,footnotes,documentStyle)`;
  const tab = (depth) => `tabProperties(tabId,title),${body}` + (depth > 1 ? `,childTabs(${tab(depth - 1)})` : '');
  return `documentId,title,revisionId,tabs(${tab(3)})`;
})();
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
// Non-text paragraph elements (images, smart chips, page breaks, footnote marks...) occupy index space
// in the document; each index unit appears as this character, so text offsets and API indices stay 1:1.
const OBJECT_CHAR = '\uFFFC';
// Soft line breaks (Shift+Enter) are U+000B inside a paragraph; tool output shows them as this mark,
// and old_text / the selection may use the mark or a newline for them.
const SOFT_BREAK_MARK = '⏎';
const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
// Sign in with Google: the documents scope plus the account's email and name (shown in the settings).
const GOOGLE_SIGNIN_SCOPES = [DOCS_SCOPE, 'openid', 'email', 'profile'];
const ANCHOR_CHARS = 20; // context kept around an edit to verify an undo
const SUGGESTED_NOTE = '  [contains suggested changes]';
const EDIT_REPORT_MAX_LINES = 40; // lines shown in a write tool's result
const EDIT_REPORT_MAX_CHARS = 6000;

// The action log under answers.
const LOG_MAX_CHARS = 4000; // arguments / result text shown in an expanded action-log row
const OPEN_DENIED_TEXT = 'The user did not allow opening this document. Do not retry.';
const OPEN_STOPPED_TEXT = 'Error: the user stopped the answer before deciding whether to open this document, so it was not opened.';
// Destructive-edit gate (Auto mode, see gateEdit): a write waits for the user's Allow / Deny when it is
// at least this large, or when the turn has read untrusted text (an opened document, web search results).
// insert_after_line is never gated by size.
const GATE_DELETE_LINES = 20; // lines in a delete_lines range
const GATE_REPLACE_CHARS = 2000; // characters removed by replace_text / replace_selection
const GATE_REPLACE_ALL_COUNT = 20; // occurrences replaced by replace_all
const GATE_FORMAT_LINES = 20; // lines of a format_lines that sets or removes a list (its undo is approximate)
const EDIT_DENIED_TEXT = 'The user did not allow this edit. Do not retry it; ask what they want instead or propose an alternative in the chat.';
const EDIT_STOPPED_TEXT = 'Error: the user stopped the answer before deciding whether to allow this edit, so it was not applied.';
// ask_user (gate.js askUser): the results the model gets. One question per turn keeps a small model from looping.
const ASK_CHAT_TEXT = 'The user will answer in the chat; finish what you can and end your turn.';
const ASK_STOPPED_TEXT = 'Error: the user stopped the answer before answering this question.';
const ASK_AGAIN_TEXT = 'Error: ask_user was already used in this message; put the remaining questions in your answer text instead.';
const ASK_MAX_OPTIONS = 4;
// A reply cut by the length limit gets one automatic continuation per turn (toolLoop): this user-role message
// (stored with _auto: true, shown as a notice row) asks the model to go on.
const AUTO_CONTINUE_TEXT = '[Your reply was cut off at the length limit. Continue exactly where it stopped, in smaller steps: shorter edits, fewer items per reply.]';
// The live notice and the stored row (render.js addAutoRow) say the same.
const AUTO_CONTINUE_NOTICE = 'Reply cut by the length limit: asked the model to continue';
// The tool budget of a message (toolLoop, visible main-chat turns): after MAX_TOOL_ITERATIONS rounds of tool calls, one
// more request without tools asks for a wrap-up with this user-role message (_auto, _autoKind 'wrap-up'); the answer is
// the turn's final text and a notice offers Continue, which sends CONTINUE_TEXT as a normal message.
const WRAP_UP_TEXT = 'You have used the tool budget of this message. Without calling tools, say in a few sentences what you did, what you verified and what is left to do.';
const WRAP_UP_NOTICE = 'Tool budget reached. Continue lets the assistant go on with the remaining steps.';
const CONTINUE_TEXT = 'Continue with the remaining steps.';
// Auto mode, once per turn: a short final reply (under NUDGE_MAX_CHARS) that announces an edit but called no tool gets
// one more round with this user-role message (_auto, _autoKind 'nudge'; see announcesEdit in turn.js).
const NUDGE_TEXT = 'You announced an action but called no tool. Call the tool now, or say that no change is needed.';
const NUDGE_MAX_CHARS = 400;
// After a turn, the history is compacted in the background when the next request's estimate reaches this share of the
// compaction trigger (backgroundCompact in compaction.js), so the next message does not wait for it.
const BACKGROUND_COMPACT_RATIO = 0.9;
// The read-first check (gate.js): a replace_section or delete_lines over lines not read in this message is refused once
// with the current text of those lines: all of them up to 2 x READ_FIRST_EDGE_LINES, else the first and last
// READ_FIRST_EDGE_LINES, each cut to READ_FIRST_LINE_CHARS characters.
const READ_FIRST_EDGE_LINES = 5;
const READ_FIRST_LINE_CHARS = 120;
// An Undo all card waits for the user's click: the chat cannot be left or answered in until it is decided
// (applyUndoAll writes the history of the open chat). A plain undo is short: UNDO_RUNNING_TEXT.
const UNDO_ALL_PENDING_TEXT = 'Confirm or cancel Undo all first.';
const UNDO_RUNNING_TEXT = 'Wait until the undo is finished.';
// Paste fallback: the selection in the document is not the one the model saw (see applyToDocumentNow).
const SELECTION_CHANGED_NOTICE = 'The selection changed while the answer was being generated; the text was copied to the clipboard instead.';
// The paste went out once but Docs did not confirm it (synthetic pastes are not confirmed in Chrome): the tool
// card's title. No clipboard fallback then, it could make the user paste a second copy.
const PASTE_UNCONFIRMED = 'Pasted'; // the card's label; Docs never confirms a synthetic paste, the next turn's read shows the result
// The model's result of a paste (confirmed or not): the turn snapshot predates the paste, so a re-read cannot
// show it; the model must neither verify nor paste again (runToolCall). One paste per turn (snap.pasteDone):
// a second replace_selection that would paste is refused without touching the document.
const PASTE_DONE_NOTE = 'The text was pasted into the document. The document snapshot your reading tools see was taken before this paste and will not show it until the user\'s next message, so do not re-read to verify and do not call replace_selection again for this text.';
const PASTE_AGAIN_TEXT = 'Error: replace_selection was already used in this message and the text was pasted; the document snapshot predates the paste, so reading tools cannot show it. Do not paste again; if more changes are needed, say so in the chat and the user will send a new message.';
const PASTE_AGAIN_CARD = 'Not pasted again (already pasted once in this message)';
// Anthropic: API version header. Server-side fallback on a safety refusal (beta) is sent only for
// the models that take the "default" form, and only to api.anthropic.com.
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Slash commands: typed at the start of a message, they give THAT turn a persona: with Munin its own
// pipeline (custom SSE stream, server-side tools, chat-only answer, a document excerpt in the newest user message), with
// OpenAI / Anthropic a chat-only turn with the reading tools. Without a command the turn follows the mode button (Manual, Edit automatically, Plan).
const PERSONAS = {
  research: {
    emoji: '🔬',
    desc: 'Force research mode for this turn: papers, citations, related work',
    focus: 'Help them with research for this document: find relevant papers, suggest citations, summarize related work, and check facts. ' +
      'When you cite a source, give the title, authors, year, and a link or DOI when available.',
    // The report skeleton of tools-mode /research turns (OpenAI, Anthropic: personaInstructions); Munin's own research
    // pipeline does not get it. src/followups.js checks the key findings for a source link.
    report: 'For an answer longer than about 200 words use these sections: TL;DR (2-3 sentences); Key findings (bullets, each with its source link); Details; Sources; ' +
      'Caveats (open sub-questions, "abstract only" for a source of which you read only the abstract, contradictions between sources named). Answer a short question plainly, without sections.',
  },
  code: {
    emoji: '💻',
    desc: 'Force code mode for this turn',
    muninOnly: true, // Munin's own code persona; with another provider the popup row is dimmed and a typed /code is refused
    focus: 'Act as a coding assistant: help with scripts, data analysis, formulas, and debugging. ' +
      'The request may relate to the document (for example code or data it describes) or be independent of it. Put code in fenced code blocks.',
  },
  chat: {
    emoji: '💬',
    desc: 'Force chat mode for this turn',
    focus: 'Act as a general-purpose assistant for writing and everyday questions, using the document as context when it is relevant.',
  },
  // A document pass (DOC_PASS_MODES), not a Munin persona: one fresh request without the chat history, with every
  // provider through the panel's own request path (Munin in raw mode); see src/review.js. defaultText: the message
  // of a bare "/review".
  review: {
    emoji: '📋',
    desc: 'Independent review of the whole document: findings with line links',
    defaultText: 'Review this document.',
  },
};
const COMMAND_RE = /^\/(research|code|chat|review)(?=\s|$)/i;
// Document passes: one request on the document alone, without the chat history (src/request.js: toolsFor,
// buildSystemParts, fitMessages): "review" (/review, a PERSONAS entry) and "card" (the paper card build, a quiet
// request of src/paper-card.js). The whole numbered text goes into the request when it takes at most this share of the
// context budget; otherwise the outline and the reading tools (the model reads in parts).
const DOC_PASS_MODES = ['review', 'card'];
const DOC_PASS_INLINE_SHARE = 0.8;
// The built-in diagnostic command (not a persona): /test runs the panel's self-test on a new, empty document
// (src/selftest.js): the harmless checks, then (only when the document is empty and nothing is selected, no
// confirmation card) a write cycle through the Docs API and the model-driven scenarios (the active provider
// does the work with the tools). Handled locally: only the probe completion and the model scenarios send
// requests to the model, and never into the chat history. The keys are the popup entries; anything typed
// after "/test" is ignored.
const SELFTEST_COMMANDS = {
  test: { emoji: '🩺', desc: 'Self-test on a new, empty document: checks, a write cycle and model edits; the document ends empty' },
};
const SELFTEST_RE = /^\/test(?=\s|$)/i;
// The built-in side question (not a persona): /side <question> runs a Manual-like turn (reading tools, no
// editing) on a separate side history (state.sideMessages) that is never stored and never sent with the
// main chat's requests (sendMessage → runSideTurn in src/turn.js).
const SIDE_COMMANDS = {
  side: { emoji: '🗨️', desc: 'Side question: not saved, not sent with later messages' },
};
const SIDE_RE = /^\/side(?=\s|$)/i;
// /research with OpenAI or Anthropic: the provider's server-side web search tool is added to the turn
// (Munin's /research runs its own search pipeline). Anthropic: web_search_20260209 (dynamic filtering)
// for Claude 4.6+ models, web_search_20250305 for older ones; OpenAI Responses API: {type: "web_search"}.
const WEB_SEARCH_PROVIDERS = ['openai', 'anthropic'];
const ANTHROPIC_WEB_SEARCH_MAX_USES = 5;
const SOURCES_MAX = 30; // links kept under an answer
// Context budget (history auto-trimming): the provider's context window minus the margins below.
// Tokens are estimated as ceil(chars / 3).
const EDIT_SAFETY_TOKENS = 2000;
const PERSONA_OVERHEAD_TOKENS = 12000; // Munin's own system prompt + tool results in persona turns
const PERSONA_SAFETY_TOKENS = 4000;
const MIN_BUDGET_TOKENS = 8000;
const CHARS_PER_TOKEN = 3;
const NUM_LOCALE = 'en-US';
// Resizable bottom pane (selected row + input).
const INPUT_HEIGHT_KEY = 'muninInputHeight';
const INPUT_HEIGHT_DEFAULT = 200;
const INPUT_HEIGHT_MIN = 150; // fallback; the real minimum is measured from the content
const INPUT_ROW_MIN = 36; // smallest textarea height
const CHAT_MIN_HEIGHT = 80; // space kept for the chat area
// The mode button (#modeCycle, a click opens the mode menu #modeMenu, one row per APPLY_MODE_ORDER entry with its
// APPLY_MODE_DESCS line): Manual (chat-only replies with an edit block), Edit automatically (stored 'auto', the value of the former Auto: the writing tools) and Plan (read-only: a
// numbered plan of edits, carried out by its Do it button with PLAN_DO_TEXT in Edit automatically).
const APPLY_MODE_KEY = 'muninApplyMode';
const APPLY_MODES = { manual: 'Manual', auto: 'Edit automatically', plan: 'Plan' };
const APPLY_MODE_ORDER = ['manual', 'auto', 'plan'];
const APPLY_MODE_DESCS = {
  manual: 'The assistant answers in the chat; you apply its text with one click.',
  auto: 'The assistant edits the document; large or risky edits ask first.',
  plan: 'The assistant reads and proposes a numbered plan of edits; Do it carries it out.',
};
const MODE_BUTTON_TITLE = 'Choose how the assistant works';
const PLAN_DO_TEXT = 'Carry out the plan above, step by step, one edit per step.';
// References (Zotero / DOI): the stored grant (true once the user allowed the lookups on the chat's permission card,
// src/references.js; not a setting), the optional host permissions that card asks Chrome for (Zotero's local API, the
// Crossref REST API, and OpenAlex for the reference-list check, src/check-refs.js), and the per-document store of cited
// items (src/references.js). The grant counts only while Chrome still grants all REFERENCES_ORIGINS.
const REFERENCES_KEY = 'muninReferences';
const ZOTERO_URL = 'http://localhost:23119';
const CROSSREF_URL = 'https://api.crossref.org';
const OPENALEX_URL = 'https://api.openalex.org';
const REFERENCES_ORIGINS = [ZOTERO_URL + '/*', CROSSREF_URL + '/*', OPENALEX_URL + '/*'];
// The store is removed with the document's chats (parseChatKey in src/chats.js).
const CITATIONS_PREFIX = 'muninCitations:';
const citationsKey = (docId) => CITATIONS_PREFIX + docId;
// The paper card of a document (src/paper-card.js): the extraction the user confirmed, with what it was built from.
const PAPER_CARD_PREFIX = 'muninPaperCard:';
const paperCardKey = (docId) => PAPER_CARD_PREFIX + docId;
// 'light' | 'dark'; nothing stored: follow the system.
const THEME_KEY = 'muninTheme';
const SYSTEM_THEME_QUERY = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
// Width in px of the in-page panel, set with the grip on its left edge; nothing stored: the default
// (400 px). Read and written by content.js, which cannot load src/ and keeps its own copy of the key.
const PANEL_WIDTH_KEY = 'muninPanelWidth';
// Host tab (the Docs tab that embeds this panel). null when opened outside the overlay.
const HOST_TAB_ID = (() => {
  const m = /(?:^#|&)tabId=(\d+)/.exec(location.hash || '');
  return m ? Number(m[1]) : null;
})();
