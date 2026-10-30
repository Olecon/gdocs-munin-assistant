'use strict';
// Module state.js: the mutable panel state (state). Loaded after settings.js because its initializer
// calls defaultSettings().
/* global defaultSettings */
/* exported state */

const state = {
  settings: defaultSettings(), // see loadSettings
  applyMode: 'manual', // 'manual' | 'auto' (Edit automatically) | 'plan' (see APPLY_MODES); Manual until the user switches
  themeFollowsSystem: true, // no theme stored (see THEME_KEY)
  tabId: null,
  docId: null,
  docTitle: '',
  docText: null,
  docFormat: 'text', // 'docs-api' (read through the Docs API), 'markdown' (Markdown export: outline + structure), else 'text'
  docModel: null, // line model of the document when docFormat is 'docs-api' (see buildLineModel)
  googleConnected: false, // signed in with Google in the settings (the Docs API is used)
  googleAccount: null, // the signed-in Google account { email, name } (null: unknown or not signed in)
  apiWarned: false, // the "Docs API failed, using the export" notice was shown (reset after a success)
  docsApiFailed: false, // the Docs API failed in this turn (export fallback): not called again until the next turn
  undoing: false, // an Undo button click is being applied
  chatWait: false, // a turn waits for the chat lock another tab holds (see holdChatLock)
  docError: '',
  selection: '',
  pendingSelection: null, // SELECTION_UPDATE received while a request was running
  chats: [], // chat metas of the current document, newest first
  chatId: null, // active chat
  loadingCtx: null, // Promise while refreshContext is loading a document's chat store
  // Chat history of the active chat in OpenAI Chat Completions shape (without the system message).
  // Fields starting with "_" are UI-only (reasoning, usage, tool outcome) and are never sent to the API.
  messages: [],
  // The /side thread (runSideTurn): its own history in the same shape, never stored and never sent with the
  // main chat's requests; sideKey ("docId:chatId") is the chat it belongs to (syncSideThread drops it on a switch).
  sideMessages: [],
  sideKey: null,
  sideTurn: false, // a /side turn is running: its bubbles get the Side styling (addUserBubble, addAssistantBubble)
  busy: false,
  abort: null,
  queued: null, // { text, docId, chatId }: the message typed while a turn ran, sent after it (see queueInput)
  sendingInput: null, // the input text of a turn that has not taken it from the input box yet (waits for the chat lock)
  exportPace: null, // the self-test's export scheduler while it runs: { beforeRead(signal), onRequest(n) } (see readExport)
  pinnedTabId: null, // tab used by the running request (does not change when the user switches tabs)
  applying: null, // Promise of the replacement currently being applied to the document
  openaiNoSummary: false, // set when the OpenAI account cannot receive reasoning summaries
  modelLists: {}, // provider id -> model IDs from GET /models (cached in storage)
  docInstructions: '', // standing instructions of the current document (see DOC_INSTRUCTIONS_MAX)
  compactionFailedChat: null, // chat id whose summary request failed (no new attempt until a chat switch / reload)
  bgCompaction: null, // { docId, chatId, abort, done }: the compaction running in the background after a turn (backgroundCompact)
};
