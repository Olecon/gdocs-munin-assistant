'use strict';
// Module chats.js: chats per document in chrome.storage.local (loadChatStore, saveHistory, createChat,
// switchChat, deleteChat), kept consistent across tabs (withChatLock, mergeChatLists, onChatStorageChanged),
// history normalization on load (normalizeHistory), the daily storage cleanup (runStorageCleanup) and the
// chat switcher dropdown (renderChatSwitcher, bindChatMenu).
/* global addNotice, CITATIONS_PREFIX, docStatusText, DOC_TEXT_PREFIX, DRAFT_PREFIX, draftKey, el, PAPER_CARD_PREFIX, NUM_LOCALE, parseSlashCommand, renderHistory, renderHistoryKeepingNotices,
   setStatus, slimHistory, state, undoingNotice */
/* exported RAW_REPLAY_KEYS, chatsKey, storageSet, chatDocs, loadChatStore, saveHistory, createChat, renderChatSwitcher,
   closeChatMenu, bindChatMenu, chatLockName, holdChatLock, tryChatLock, chatLockIfFree, readChatForTurn, withLock */

// ---------------------------------------------------------------------------
// Chats: several chats per document, stored in chrome.storage.local (survive browser restarts).
//   muninChats:<docId>                 -> [{id, title, createdAt, updatedAt}], newest first
//   muninChatHistory:<docId>:<chatId>  -> message array (same shape as state.messages)
//   muninCurrentChat:<docId>           -> active chat id
//   muninChatTombstones:<docId>        -> {chatId: deletedAt}: chats deleted (or evicted by MAX_CHATS), so that
//                                         a tab holding an older list never brings them back (kept CHAT_TOMBSTONE_DAYS)
//   muninDocInstructions:<docId>       -> the document's standing instructions (shared by its chats)
//   muninDocText:<docId>              -> the document's text at the end of its last turn (src/doc-history.js)
//   muninCitations:<docId>            -> the document's cited items and citation style (src/references.js)
//   muninStorageCleanupAt              -> time of the last storage cleanup (runStorageCleanup, at most daily)
// A chat meta may carry docs: [{alias, id, title, lines, tab?, authuser?}], the documents opened with
// open_document in that chat (kept across reloads; their content is re-read on first use in a turn).
// Several tabs (panels) may show the same document. Every read-modify-write of a document's chat list
// runs under the Web Lock "munin:<docId>" (withChatLock) and re-reads the list inside it; lists are merged
// by chat id (the newer meta by updatedAt wins; tombstoned chats are dropped) and a save writes only the
// history of its own chat. A turn or an undo owns its chat through the Web Lock "munin:chat:<docId>:<chatId>"
// (holdChatLock) and starts from the stored history (readChatForTurn). chrome.storage.onChanged keeps the
// switcher current and reloads the open chat at once when another tab changed it and this panel is idle.
// ---------------------------------------------------------------------------
const MAX_CHATS = 30;
const CHAT_TITLE_MAX = 40;
const CHAT_RETENTION_DAYS = 180; // a document whose chats were all unused this long is removed by the cleanup
const CHAT_TOMBSTONE_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;
const CHAT_SYNC_POLL_MS = 250; // a reload waiting for the panel to become idle checks again after this
const STORAGE_CLEANUP_KEY = 'muninStorageCleanupAt';
const CHATS_PREFIX = 'muninChats:';
const HISTORY_PREFIX = 'muninChatHistory:';
const CURRENT_PREFIX = 'muninCurrentChat:';
const TOMBSTONES_PREFIX = 'muninChatTombstones:';
const chatsKey = (docId) => CHATS_PREFIX + docId;
const chatHistoryKey = (docId, chatId) => HISTORY_PREFIX + docId + ':' + chatId;
const currentChatKey = (docId) => CURRENT_PREFIX + docId;
const chatTombstonesKey = (docId) => TOMBSTONES_PREFIX + docId;
// Provider output replayed verbatim for the current turn (see toAnthropicMessages / toResponsesInput); dropped by
// slimHistory after the turn, counted by estimateTokens.
const RAW_REPLAY_KEYS = ['_anthropicBlocks', '_openaiItems'];
let storageWarned = false;

function isValidMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.role === 'user') return typeof m.content === 'string';
  if (m.role === 'assistant') return m.content == null || typeof m.content === 'string';
  if (m.role === 'tool') return typeof m.tool_call_id === 'string' && typeof m.content === 'string';
  return false;
}
const isValidToolCall = (tc) => !!tc && typeof tc.id === 'string' && !!tc.id && !!tc.function &&
  typeof tc.function.name === 'string' && (tc.function.arguments == null || typeof tc.function.arguments === 'string');

// A stored history made safe to render and to send: invalid messages are dropped; an assistant's tool
// calls are kept only when their results follow it (before the next user or assistant message) and each
// tool result only when it answers such a call (the APIs reject a tool_use without its tool_result and the
// reverse). An assistant that lost calls also loses its raw replay items (they would carry the calls).
// Older fields (2.6: add_comment / undo_last_edit calls, _decision, _preview) are kept: they are
// display-only and the renderers and request builders ignore what they do not know.
function normalizeHistory(list) {
  const out = [];
  let open = null; // { msg, ids }: the last assistant with tool calls and its unanswered call ids
  const close = () => {
    if (open && open.ids.size) {
      const m = open.msg;
      const kept = m.tool_calls.filter((tc) => !open.ids.has(tc.id));
      if (kept.length) m.tool_calls = kept; else delete m.tool_calls;
      for (const k of RAW_REPLAY_KEYS) delete m[k];
    }
    open = null;
  };
  for (const raw of Array.isArray(list) ? list : []) {
    if (!isValidMessage(raw)) continue;
    if (raw.role === 'tool') {
      if (!open || !open.ids.has(raw.tool_call_id)) continue; // a result without its call
      open.ids.delete(raw.tool_call_id);
      out.push(raw);
      continue;
    }
    close();
    if (raw.role === 'assistant' && raw.tool_calls !== undefined) {
      const m = { ...raw };
      const given = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
      const seen = new Set();
      const calls = given.filter((tc) => isValidToolCall(tc) && !seen.has(tc.id) && !!seen.add(tc.id));
      if (calls.length !== given.length) for (const k of RAW_REPLAY_KEYS) delete m[k];
      if (calls.length) { m.tool_calls = calls; open = { msg: m, ids: new Set(calls.map((tc) => tc.id)) }; } else delete m.tool_calls;
      out.push(m);
      continue;
    }
    out.push(raw);
  }
  close();
  return out;
}

const isValidMeta = (c) => !!c && typeof c.id === 'string' && Number.isFinite(c.updatedAt);
const newChatId = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Title from the chat's first user message: one line, slash command stripped, ~40 chars.
function chatTitleFrom(messages) {
  const first = (messages || []).find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  if (!first) return '';
  const line = parseSlashCommand(first.content).text.replace(/\s+/g, ' ').trim();
  return line.length > CHAT_TITLE_MAX ? line.slice(0, CHAT_TITLE_MAX).trimEnd() + '…' : line;
}
const chatLabel = (meta) => (meta && meta.title) || 'New chat';

function makeChatMeta(messages) {
  const now = Date.now();
  return { id: newChatId(), title: chatTitleFrom(messages), createdAt: now, updatedAt: now };
}

// ---- Storage access ---------------------------------------------------------------------------
// The values this panel wrote recently (a short hash per key), so that onChanged can tell its own writes
// from another tab's.
const OWN_WRITES_KEPT = 8;
const ownWrites = new Map();
function hashValue(v) {
  const s = v === undefined ? '\u0000' : JSON.stringify(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + '.' + s.length;
}
function noteOwnWrite(key, value) {
  const list = ownWrites.get(key) || [];
  list.push(hashValue(value));
  if (list.length > OWN_WRITES_KEPT) list.shift();
  ownWrites.set(key, list);
}
// Change events arrive in write order: a match also retires the older entries.
function isOwnWrite(key, value) {
  const list = ownWrites.get(key);
  const i = list ? list.indexOf(hashValue(value)) : -1;
  if (i < 0) return false;
  list.splice(0, i + 1);
  return true;
}

function warnStorage(e) {
  if (storageWarned) return;
  storageWarned = true;
  addNotice('Could not save the chat history (' + ((e && e.message) || e) + ').', { sticky: true });
}

async function writeItems(items) {
  for (const [k, v] of Object.entries(items)) noteOwnWrite(k, v);
  try {
    await chrome.storage.local.set(items);
    return true;
  } catch (e) {
    warnStorage(e);
    return false;
  }
}

async function removeKeys(keys) {
  if (!keys.length) return;
  for (const k of keys) noteOwnWrite(k, undefined);
  try { await chrome.storage.local.remove(keys); } catch (e) { /* ignore */ }
}

// Runs fn under the Web Lock `name` (shared by every tab of the extension). Without navigator.locks
// (tests, very old browsers) it runs without a cross-tab lock, queued behind the panel's own holders.
const localLocks = new Map();
function withLock(name, fn) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (locks && typeof locks.request === 'function') return locks.request(name, () => fn());
  const prev = localLocks.get(name) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.catch(() => {});
  localLocks.set(name, tail);
  tail.then(() => { if (localLocks.get(name) === tail) localLocks.delete(name); });
  return run;
}
const withChatLock = (docId, fn) => withLock('munin:' + docId, fn);

// ---- Owning one chat ------------------------------------------------------------------------------
// Everything that changes a chat's history and the document (a turn, Undo, Undo all) holds the Web Lock
// "munin:chat:<docId>:<chatId>" for its whole run, so two tabs never write the same chat at once; the
// holder starts from the stored history (readChatForTurn). Chrome releases the lock when the tab closes.
const chatLockName = (docId, chatId) => 'munin:chat:' + docId + ':' + chatId;
const localHolders = new Map(); // without navigator.locks: lock name -> holders and waiters in this panel
const abortError = () => Object.assign(new Error('The wait was cancelled.'), { name: 'AbortError' });

// Takes the lock `name` and keeps it until the returned release() is called. With ifAvailable it resolves
// to null at once when the lock is held elsewhere; otherwise it waits, and rejects with an AbortError when
// signal fires first. Without navigator.locks the panel's own queue (withLock's) stands in.
function holdLock(name, { signal = null, ifAvailable = false } = {}) {
  return new Promise((resolve, reject) => {
    let release;
    const held = new Promise((r) => { release = () => r(); });
    let granted = false;
    const grant = (lock) => {
      if (!lock) { resolve(null); return undefined; } // ifAvailable and taken
      granted = true;
      resolve(release);
      return held;
    };
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (signal && signal.aborted) { reject(abortError()); return; }
    if (locks && typeof locks.request === 'function') {
      const opts = ifAvailable ? { ifAvailable: true } : signal ? { signal } : {};
      locks.request(name, opts, grant).catch((e) => { if (!granted) reject(e); });
      return;
    }
    if (ifAvailable && localHolders.get(name)) { resolve(null); return; }
    let aborted = false;
    const count = (d) => { const n = (localHolders.get(name) || 0) + d; if (n > 0) localHolders.set(name, n); else localHolders.delete(name); };
    count(1); // held or waiting
    const done = release;
    let released = false;
    release = () => { if (!released) { released = true; count(-1); done(); } };
    const prev = localLocks.get(name) || Promise.resolve();
    const tail = prev.then(() => (aborted ? undefined : grant(true)));
    localLocks.set(name, tail);
    tail.then(() => { if (localLocks.get(name) === tail) localLocks.delete(name); });
    if (signal) signal.addEventListener('abort', () => { if (!granted) { aborted = true; count(-1); reject(abortError()); } }, { once: true });
  });
}

// The panel's own background compaction (backgroundCompact in compaction.js, state.bgCompaction) gives way to anything
// else in this panel that wants the chat's lock (a turn, Undo, leaving or deleting the chat): it is aborted and its end
// awaited, so its lock is free and a fold it already made is saved.
async function yieldBackground(docId, chatId) {
  const bg = state.bgCompaction;
  if (!bg || bg.docId !== docId || bg.chatId !== chatId) return;
  bg.abort.abort();
  try { await bg.done; } catch (e) { /* it reports its own failures */ }
}

// The chat lock of docId/chatId: at once when free; otherwise onWait() is called and the panel waits
// (state.chatWait is set meanwhile, so the open chat keeps following the other tab). Resolves to release().
async function holdChatLock(docId, chatId, { signal = null, onWait = null } = {}) {
  await yieldBackground(docId, chatId);
  const name = chatLockName(docId, chatId);
  const now = await holdLock(name, { ifAvailable: true });
  if (now) return now;
  if (onWait) onWait();
  state.chatWait = true;
  try {
    return await holdLock(name, { signal });
  } finally {
    state.chatWait = false;
  }
}
// The chat lock when it is free, else null (Undo does not wait for another tab's answer).
const tryChatLock = async (docId, chatId) => { await yieldBackground(docId, chatId); return holdLock(chatLockName(docId, chatId), { ifAvailable: true }); };
// The same without yielding: the background compaction's own attempt.
const chatLockIfFree = (docId, chatId) => holdLock(chatLockName(docId, chatId), { ifAvailable: true });

// The stored chat list and tombstones of a document. Throws when storage cannot be read (a write based
// on an unread list would drop the other chats).
async function readStore(docId) {
  const got = await chrome.storage.local.get([chatsKey(docId), chatTombstonesKey(docId)]);
  const list = got[chatsKey(docId)];
  const t = got[chatTombstonesKey(docId)];
  return {
    chats: Array.isArray(list) ? list.filter(isValidMeta) : [],
    tombs: t && typeof t === 'object' && !Array.isArray(t) ? { ...t } : {},
  };
}

// Read-modify-write of a document's store under its lock: fn({chats, tombs}) runs with a fresh read.
// Returns fn's result, or null when storage failed.
async function updateStore(docId, fn) {
  try {
    return await withChatLock(docId, async () => fn(await readStore(docId)));
  } catch (e) {
    warnStorage(e);
    return null;
  }
}

const sortChats = (chats) => chats.sort((a, b) => b.updatedAt - a.updatedAt);

// One chat's meta from two copies: the fields of the one with the later updatedAt win (on a tie the
// panel's, whose docs may be newer: open_document does not bump updatedAt); fields only the other has
// are kept, and so is a title (it is only ever set once).
function mergeMeta(stored, local) {
  const [older, newer] = local.updatedAt >= stored.updatedAt ? [stored, local] : [local, stored];
  const m = { ...older, ...newer };
  if (!newer.title && older.title) m.title = older.title;
  return m;
}

// Union of the stored list and a panel's list by chat id (mergeMeta for a chat in both); tombstoned
// chats are left out.
function mergeChatLists(stored, local, tombs) {
  const byId = new Map();
  for (const c of stored) if (isValidMeta(c) && !tombs[c.id]) byId.set(c.id, { ...c });
  for (const c of local || []) {
    if (!isValidMeta(c) || tombs[c.id]) continue;
    const s = byId.get(c.id);
    byId.set(c.id, s ? mergeMeta(s, c) : { ...c });
  }
  return sortChats([...byId.values()]);
}

function pruneTombs(tombs, now = Date.now()) {
  const out = {};
  for (const [id, at] of Object.entries(tombs)) if (Number.isFinite(at) && now - at < CHAT_TOMBSTONE_DAYS * DAY_MS) out[id] = at;
  return out;
}

const copyChats = (chats) => chats.map((c) => ({ ...c }));

// Makes a list the panel's chat list (only for the document the panel shows).
function adoptChats(docId, chats) {
  if (docId !== state.docId) return;
  state.chats = chats;
  renderChatSwitcher();
  if (isChatMenuOpen()) renderChatMenu();
}

// Writes items to chrome.storage.local. A chat list among them (open_document stores the opened
// documents on a chat meta) is merged into the stored list under the document's lock, like every
// list write of this module, so it cannot drop a chat another tab created or bring back a deleted one.
async function storageSet(items) {
  const rest = { ...items };
  const lists = [];
  for (const k of Object.keys(items)) {
    if (!k.startsWith(CHATS_PREFIX)) continue;
    lists.push([k.slice(CHATS_PREFIX.length), Array.isArray(items[k]) ? copyChats(items[k]) : []]);
    delete rest[k];
  }
  let ok = true;
  for (const [docId, incoming] of lists) {
    const merged = await updateStore(docId, async ({ chats, tombs }) => {
      const list = mergeChatLists(chats, incoming, tombs);
      return (await writeItems({ [chatsKey(docId)]: list })) ? list : null;
    });
    if (merged) adoptChats(docId, merged); else ok = false;
  }
  if (Object.keys(rest).length) ok = (await writeItems(rest)) && ok;
  return ok;
}

// A stored history, normalized and slimmed; undefined when the key does not exist. Throws when storage
// cannot be read.
async function readStoredHistory(docId, chatId) {
  const raw = (await chrome.storage.local.get(chatHistoryKey(docId, chatId)))[chatHistoryKey(docId, chatId)];
  if (raw === undefined) return undefined;
  const valid = normalizeHistory(raw);
  slimHistory(valid); // chats saved before slimming existed (in memory; stored with the next save)
  return valid;
}

async function readChatHistory(docId, chatId) {
  try {
    return (await readStoredHistory(docId, chatId)) || [];
  } catch (e) {
    return [];
  }
}

// Called with the chat lock held, before a turn or an undo: makes the stored history of the open chat the
// panel's (state.messages; re-rendered, keeping notices, when it differs from what the panel showed).
// Returns false when the chat no longer exists (deleted in another tab: the panel switches away once it
// is idle); when storage cannot be read, or the chat has no stored history yet, the panel keeps its own.
async function readChatForTurn(docId, chatId) {
  let stored;
  try {
    const { chats, tombs } = await readStore(docId);
    if (tombs[chatId] || (chats.length && !chats.some((c) => c.id === chatId))) { refreshChatList(docId); return false; }
    stored = await readStoredHistory(docId, chatId);
  } catch (e) {
    return true;
  }
  if (stored === undefined || docId !== state.docId || chatId !== state.chatId) return true;
  if (hashValue(stored) !== hashValue(state.messages)) {
    state.messages = stored;
    renderHistoryKeepingNotices();
  }
  return true;
}

// The documents opened in a chat (copies of the valid entries of its meta).
const isValidOpenDoc = (d) => d && typeof d.alias === 'string' && /^doc\d+$/.test(d.alias) && typeof d.id === 'string' && !!d.id;
function chatDocs(chatId) {
  const meta = state.chats.find((c) => c.id === chatId);
  return meta && Array.isArray(meta.docs) ? meta.docs.filter(isValidOpenDoc).map((d) => ({ ...d })) : [];
}

// The stored chat list of a document, with a fresh empty chat created (and stored) when it has none.
// Returns { chats, fresh } (fresh: the created chat's id), or null when storage failed.
function ensureChats(docId) {
  return updateStore(docId, async ({ chats, tombs }) => {
    const list = mergeChatLists(chats, [], tombs);
    if (list.length) return { chats: list, fresh: null };
    const meta = makeChatMeta([]);
    const ok = await writeItems({ [chatsKey(docId)]: [meta], [chatHistoryKey(docId, meta.id)]: [], [currentChatKey(docId)]: meta.id });
    return ok ? { chats: [meta], fresh: meta.id } : null;
  });
}

// Loads (or initializes) the chat store of a document. Returns { chats, chatId, messages }.
// The first call also starts watching storage changes and the daily cleanup.
async function loadChatStore(docId) {
  watchChatStorage();
  scheduleStorageCleanup();
  const r = await ensureChats(docId);
  if (!r) { const meta = makeChatMeta([]); return { chats: [meta], chatId: meta.id, messages: [] }; } // in memory only
  if (r.fresh) return { chats: r.chats, chatId: r.fresh, messages: [] };
  let current = null;
  try { current = (await chrome.storage.local.get(currentChatKey(docId)))[currentChatKey(docId)]; } catch (e) { /* ignore */ }
  if (!r.chats.some((c) => c.id === current)) current = r.chats[0].id;
  return { chats: r.chats, chatId: current, messages: await readChatHistory(docId, current) };
}

// Saves a chat's history and bumps its updatedAt (and sets its title once it has a user message).
// ctx lets an in-flight request save to the chat it started in: { docId, chatId, messages }.
// A chat deleted meanwhile (here or in another tab) is not brought back.
async function saveHistory(ctx) {
  const c = ctx || { docId: state.docId, chatId: state.chatId, messages: state.messages };
  if (!c.docId || !c.chatId) return;
  const local = c.docId === state.docId ? copyChats(state.chats) : [];
  const merged = await updateStore(c.docId, async ({ chats, tombs }) => {
    const list = mergeChatLists(chats, local, tombs);
    const meta = list.find((x) => x.id === c.chatId);
    if (!meta) return null;
    meta.updatedAt = Date.now();
    if (!meta.title) meta.title = chatTitleFrom(c.messages);
    sortChats(list);
    return (await writeItems({ [chatHistoryKey(c.docId, c.chatId)]: c.messages, [chatsKey(c.docId)]: list })) ? list : null;
  });
  if (merged) adoptChats(c.docId, merged);
}

// Before the panel leaves the open chat (+, switching): its history is saved as before (which also bumps
// updatedAt), but only under the chat lock and only when the stored copy is the one the panel shows. While
// another tab answers in the chat, or after it saved something newer, that tab's version is left alone.
async function saveBeforeLeaving() {
  const { docId, chatId } = state;
  if (!docId || !chatId) return;
  const release = await tryChatLock(docId, chatId);
  if (!release) return;
  try {
    let stored;
    try { stored = await readStoredHistory(docId, chatId); } catch (e) { return; }
    if (stored !== undefined && stored.length && hashValue(stored) !== hashValue(state.messages)) return;
    if (docId === state.docId && chatId === state.chatId) await saveHistory();
  } finally {
    release();
  }
}

async function setCurrentChat(chatId, messages) {
  state.compactionFailedChat = null; // switching chats re-enables compaction
  state.chatId = chatId;
  state.messages = messages;
  await writeItems({ [currentChatKey(state.docId)]: chatId });
  el.trimNote.classList.add('hidden');
  renderHistory();
  renderChatSwitcher();
}

// An undo (and an Undo all card waiting for its click) writes the open chat's history when it ends, so the
// chat is not left, replaced or deleted meanwhile.
function refusedWhileUndoing() {
  if (!state.undoing) return false;
  closeChatMenu();
  addNotice(undoingNotice());
  return true;
}

// "+": starts a new empty chat (the previous one is kept). If the current chat is still empty,
// it is simply reused. Creating chat #31 deletes the least recently updated one.
async function createChat() {
  if (state.busy || !state.docId) return;
  if (refusedWhileUndoing()) return;
  closeChatMenu();
  const current = state.chats.find((c) => c.id === state.chatId);
  if (current && !state.messages.length) return;
  await saveBeforeLeaving();
  const docId = state.docId;
  const meta = makeChatMeta([]);
  const local = copyChats(state.chats);
  const merged = await updateStore(docId, async ({ chats, tombs }) => {
    const list = mergeChatLists(chats, local, tombs);
    list.unshift(meta);
    const removed = [];
    while (list.length > MAX_CHATS) {
      let oldest = 1; // never the new chat at index 0
      for (let i = 2; i < list.length; i++) if (list[i].updatedAt < list[oldest].updatedAt) oldest = i;
      removed.push(list.splice(oldest, 1)[0]);
    }
    const items = { [chatsKey(docId)]: list, [chatHistoryKey(docId, meta.id)]: [] };
    if (removed.length) {
      const now = Date.now();
      for (const r of removed) tombs[r.id] = now;
      items[chatTombstonesKey(docId)] = pruneTombs(tombs, now);
    }
    if (!(await writeItems(items))) return null;
    await removeKeys(removed.map((r) => chatHistoryKey(docId, r.id)));
    return list;
  });
  if (state.docId !== docId) return;
  adoptChats(docId, merged || [meta, ...local]);
  await setCurrentChat(meta.id, []);
}

async function switchChat(chatId) {
  if (state.busy || !state.docId || chatId === state.chatId) { closeChatMenu(); return; }
  if (refusedWhileUndoing()) return;
  if (!state.chats.some((c) => c.id === chatId)) return;
  closeChatMenu();
  await saveBeforeLeaving();
  await setCurrentChat(chatId, await readChatHistory(state.docId, chatId));
}

// The store write of deleteChat: the tombstone, the list without the chat (a fresh empty chat when none
// remain) and the removal of its history. Returns the new list, or null when storage failed.
function deleteFromStore(docId, chatId, local) {
  return updateStore(docId, async ({ chats, tombs }) => {
    const now = Date.now();
    tombs[chatId] = now;
    const list = mergeChatLists(chats, local, tombs);
    const items = { [chatsKey(docId)]: list, [chatTombstonesKey(docId)]: pruneTombs(tombs, now) };
    if (!list.length) {
      const meta = makeChatMeta([]);
      list.push(meta);
      items[chatHistoryKey(docId, meta.id)] = [];
    }
    if (!(await writeItems(items))) return null;
    await removeKeys([chatHistoryKey(docId, chatId), draftKey(docId, chatId)]); // the chat's draft plan goes with it
    return list;
  });
}

// Deletes a chat (with a tombstone, so another tab's older list does not bring it back). Deleting the
// active one switches to the most recent remaining chat, or to a fresh empty chat when none remain.
async function deleteChat(chatId) {
  if (state.busy || !state.docId) return;
  if (refusedWhileUndoing()) return;
  const docId = state.docId;
  if (!state.chats.some((c) => c.id === chatId)) return;
  // Not while another tab answers in (or undoes an edit of) that chat: its saves would be refused.
  const release = await tryChatLock(docId, chatId);
  if (!release) { addNotice('Another tab is answering in this chat. Delete it when that answer is finished.'); return; }
  let merged;
  const local = copyChats(state.chats.filter((c) => c.id !== chatId));
  try {
    merged = await deleteFromStore(docId, chatId, local);
  } finally {
    release();
  }
  if (state.docId !== docId) return;
  adoptChats(docId, merged || (local.length ? local : [makeChatMeta([])]));
  if (!state.chats.some((c) => c.id === state.chatId)) {
    const next = state.chats[0];
    await setCurrentChat(next.id, await readChatHistory(docId, next.id));
  }
  if (isChatMenuOpen()) renderChatMenu();
}

// ---- Changes made by other tabs -----------------------------------------------------------------
let storageWatched = false;
function watchChatStorage() {
  const ev = chrome.storage && chrome.storage.onChanged;
  if (storageWatched || !ev || typeof ev.addListener !== 'function') return;
  storageWatched = true;
  ev.addListener(onChatStorageChanged);
}

const isPanelBusy = () => state.busy || state.undoing || !!state.loadingCtx;
// The open chat may be reloaded from storage: the panel is idle, or its turn is still waiting for the chat
// lock (nothing of the turn is in state.messages yet).
const canFollow = () => !state.undoing && !state.loadingCtx && (!state.busy || state.chatWait);

// chrome.storage.onChanged: another tab changed this document's chat list (the switcher follows at once)
// or the open chat's history (reloaded at once when the panel can follow, see runChatSync). The panel's
// own writes are recognized and ignored.
function onChatStorageChanged(changes, area) {
  if ((area && area !== 'local') || !changes || !state.docId || state.loadingCtx) return;
  const docId = state.docId;
  const lk = chatsKey(docId);
  if (changes[lk] && !isOwnWrite(lk, changes[lk].newValue)) refreshChatList(docId);
  const hk = state.chatId ? chatHistoryKey(docId, state.chatId) : null;
  if (hk && changes[hk] && changes[hk].newValue !== undefined && !isOwnWrite(hk, changes[hk].newValue)) scheduleChatSync('changed');
}

// Re-reads the stored list (an event's newValue may already be older than what another write stored
// since) and makes it the switcher's list; a burst of changes leads to one more read at most.
const listRefresh = { running: false, again: false };
async function refreshChatList(docId) {
  if (listRefresh.running) { listRefresh.again = true; return; }
  listRefresh.running = true;
  try {
    do {
      listRefresh.again = false;
      let chats = null;
      try { chats = (await readStore(docId)).chats; } catch (e) { /* keep the current list */ }
      if (chats && state.docId === docId && !state.loadingCtx) {
        adoptChats(docId, sortChats(chats));
        if (!state.chats.some((c) => c.id === state.chatId)) scheduleChatSync('gone');
      }
    } while (listRefresh.again);
  } finally {
    listRefresh.running = false;
  }
}

// A pending reaction to another tab's change of the open chat: 'changed' (reload its history) or
// 'gone' (it was deleted: switch to another chat). A reload runs at once when the panel can follow
// (canFollow). While this panel runs a turn or an undo it holds the chat's lock, so no other tab writes
// the chat; a change seen then (a late write of a tab without the lock) is checked once it is idle.
// A switch away waits until the panel is idle (never during a turn, an undo or a document switch).
const chatSync = { timer: 0, docId: null, chatId: null, changed: false, gone: false };
function scheduleChatSync(kind) {
  if (chatSync.docId !== state.docId || chatSync.chatId !== state.chatId) {
    Object.assign(chatSync, { docId: state.docId, chatId: state.chatId, changed: false, gone: false });
  }
  chatSync[kind] = true;
  if (!chatSync.timer) chatSync.timer = setTimeout(runChatSync, kind === 'changed' && canFollow() ? 0 : CHAT_SYNC_POLL_MS);
}

const FOLLOW_STATUS = 'Chat updated from another tab';
const FOLLOW_STATUS_MS = 3000;
async function runChatSync() {
  chatSync.timer = 0;
  const { docId, chatId, changed, gone } = chatSync;
  if (docId !== state.docId || chatId !== state.chatId) { Object.assign(chatSync, { changed: false, gone: false }); return; } // the user moved on
  const deleted = gone || !state.chats.some((c) => c.id === chatId);
  if (deleted ? isPanelBusy() : !canFollow()) { chatSync.timer = setTimeout(runChatSync, CHAT_SYNC_POLL_MS); return; }
  Object.assign(chatSync, { changed: false, gone: false });
  if (!state.chats.some((c) => c.id === chatId)) { // deleted in another tab
    let next = state.chats[0];
    if (!next) {
      const r = await ensureChats(docId);
      if (state.docId !== docId || state.chatId !== chatId) return;
      adoptChats(docId, r ? r.chats : [makeChatMeta([])]);
      next = state.chats[0];
    }
    await setCurrentChat(next.id, await readChatHistory(docId, next.id));
    addNotice('This chat was deleted in another tab.');
    return;
  }
  if (!changed) return;
  const msgs = await readChatHistory(docId, chatId);
  if (docId !== state.docId || chatId !== state.chatId) return;
  if (!canFollow()) { scheduleChatSync('changed'); return; } // a turn or an undo took the chat while reading
  if (hashValue(msgs) === hashValue(state.messages)) return; // nothing new (e.g. this panel's own save won)
  state.messages = msgs;
  renderHistoryKeepingNotices();
  if (state.busy) return; // waiting for the chat lock: the status line says so
  setStatus(FOLLOW_STATUS);
  setTimeout(() => {
    if (!state.busy && !state.undoing && el.docStatus.textContent === FOLLOW_STATUS) setStatus(docStatusText(), state.docText == null);
  }, FOLLOW_STATUS_MS);
}

// ---- Storage cleanup ------------------------------------------------------------------------------
// At most once per day (STORAGE_CLEANUP_KEY, started by the first loadChatStore of a panel): removes the
// chat keys of documents whose chats were all unused for more than CHAT_RETENTION_DAYS (except the
// document this panel shows; the document instructions are kept) and orphans: histories without a chat
// entry, draft plans without a chat, and the current-chat, tombstone, text-baseline and citation keys of documents without a chat list. Each document is
// re-checked under its lock before anything is removed. Returns { removed: [keys] }, or null when skipped.
let cleanupScheduled = false;
function scheduleStorageCleanup() {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  runStorageCleanup().catch(() => {});
}

// "<prefix><docId>[:<chatId>]" -> { docId, chatId } (doc and chat ids contain no ":").
function parseChatKey(key) {
  for (const prefix of [HISTORY_PREFIX, DRAFT_PREFIX, CURRENT_PREFIX, TOMBSTONES_PREFIX, CHATS_PREFIX, DOC_TEXT_PREFIX, CITATIONS_PREFIX, PAPER_CARD_PREFIX]) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (prefix !== HISTORY_PREFIX && prefix !== DRAFT_PREFIX) return { prefix, docId: rest, chatId: null }; // per-document keys
    const i = rest.lastIndexOf(':');
    return i > 0 ? { prefix, docId: rest.slice(0, i), chatId: rest.slice(i + 1) } : null;
  }
  return null;
}

async function allStorageKeys() {
  const local = chrome.storage.local;
  if (typeof local.getKeys === 'function') return local.getKeys();
  return Object.keys(await local.get(null));
}

function runStorageCleanup(now = Date.now()) {
  return withLock('munin:cleanup', async () => {
    const last = (await chrome.storage.local.get(STORAGE_CLEANUP_KEY))[STORAGE_CLEANUP_KEY];
    if (Number.isFinite(last) && last <= now && now - last < DAY_MS) return null;
    await chrome.storage.local.set({ [STORAGE_CLEANUP_KEY]: now });
    const byDoc = new Map(); // docId -> keys of that document
    for (const key of await allStorageKeys()) {
      const p = parseChatKey(key);
      if (!p) continue;
      if (!byDoc.has(p.docId)) byDoc.set(p.docId, []);
      byDoc.get(p.docId).push(key);
    }
    const removed = [];
    for (const [docId, keys] of byDoc) {
      const gone = await withChatLock(docId, async () => {
        const list = (await chrome.storage.local.get(chatsKey(docId)))[chatsKey(docId)];
        const chats = Array.isArray(list) ? list.filter(isValidMeta) : [];
        const newest = chats.reduce((t, c) => Math.max(t, c.updatedAt), 0);
        const expired = Array.isArray(list) && docId !== state.docId && now - newest > CHAT_RETENTION_DAYS * DAY_MS;
        const ids = new Set(chats.map((c) => c.id));
        const drop = keys.filter((key) => {
          if (expired) return true;
          const p = parseChatKey(key);
          if (p.prefix === HISTORY_PREFIX || p.prefix === DRAFT_PREFIX) return !ids.has(p.chatId); // per-chat keys: orphans go
          return p.prefix !== CHATS_PREFIX && !Array.isArray(list);
        });
        if (expired) drop.push(...chats.map((c) => chatHistoryKey(docId, c.id)).filter((k) => !drop.includes(k)));
        await removeKeys(drop);
        return drop;
      });
      removed.push(...gone);
    }
    return { removed };
  });
}

// ---------------------------------------------------------------------------
// Chat switcher (header button + dropdown)
// ---------------------------------------------------------------------------
const chatMenu = { open: false, index: -1 };
const isChatMenuOpen = () => chatMenu.open;

function fmtAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString(NUM_LOCALE, { month: 'short', day: 'numeric' });
}

function renderChatSwitcher() {
  const meta = state.chats.find((c) => c.id === state.chatId);
  const label = chatLabel(meta);
  el.chatSwitchTitle.textContent = label;
  el.chatSwitchBtn.title = 'Switch chat: ' + label;
}

function renderChatMenu() {
  const box = el.chatMenu;
  box.textContent = '';
  state.chats.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'chat-row' + (c.id === state.chatId ? ' active' : '') + (i === chatMenu.index ? ' focused' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(c.id === state.chatId));
    row.dataset.id = c.id;
    const title = document.createElement('span');
    title.className = 'chat-row-title';
    title.textContent = chatLabel(c);
    const time = document.createElement('span');
    time.className = 'chat-row-time';
    time.textContent = fmtAgo(c.updatedAt);
    const del = document.createElement('button');
    del.className = 'chat-row-del';
    del.type = 'button';
    del.dataset.del = c.id;
    del.title = 'Delete chat';
    del.setAttribute('aria-label', 'Delete chat');
    del.textContent = '✕';
    row.append(title, time, del);
    box.appendChild(row);
  });
  positionChatMenu();
}

function positionChatMenu() {
  if (!chatMenu.open) return;
  const r = el.chatSwitchBtn.getBoundingClientRect();
  const width = Math.min(300, Math.max(220, window.innerWidth - 16));
  el.chatMenu.style.top = Math.round(r.bottom + 4) + 'px';
  el.chatMenu.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - width - 8))) + 'px';
  el.chatMenu.style.width = width + 'px';
}

function openChatMenu() {
  if (state.busy || !state.docId) return;
  chatMenu.open = true;
  chatMenu.index = state.chats.findIndex((c) => c.id === state.chatId);
  el.chatMenu.classList.remove('hidden');
  el.chatSwitchBtn.setAttribute('aria-expanded', 'true');
  renderChatMenu();
}

function closeChatMenu() {
  if (!chatMenu.open) return;
  chatMenu.open = false;
  el.chatMenu.classList.add('hidden');
  el.chatMenu.textContent = '';
  el.chatSwitchBtn.setAttribute('aria-expanded', 'false');
}

function bindChatMenu() {
  el.chatSwitchBtn.addEventListener('click', () => { if (chatMenu.open) closeChatMenu(); else openChatMenu(); });
  el.chatMenu.addEventListener('click', (e) => {
    const del = e.target.closest('button[data-del]');
    if (del) { e.stopPropagation(); deleteChat(del.dataset.del); return; }
    const row = e.target.closest('.chat-row');
    if (row) switchChat(row.dataset.id);
  });
  // Outside click closes the menu.
  document.addEventListener('mousedown', (e) => {
    if (!chatMenu.open) return;
    if (el.chatMenu.contains(e.target) || el.chatSwitchBtn.contains(e.target)) return;
    closeChatMenu();
  });
  // Escape closes; ArrowUp/ArrowDown + Enter pick a chat.
  document.addEventListener('keydown', (e) => {
    if (!chatMenu.open) return;
    // Keys typed in the message box keep their own meaning (Enter sends, arrows move the caret).
    if (e.target === el.input && e.key !== 'Escape') return;
    const n = state.chats.length;
    if (e.key === 'Escape') { e.preventDefault(); closeChatMenu(); el.chatSwitchBtn.focus(); }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
      e.preventDefault();
      chatMenu.index = ((chatMenu.index < 0 ? 0 : chatMenu.index) + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      renderChatMenu();
    } else if (e.key === 'Enter' && chatMenu.index >= 0 && chatMenu.index < n) {
      e.preventDefault();
      switchChat(state.chats[chatMenu.index].id);
    }
  });
  window.addEventListener('resize', positionChatMenu);
}
