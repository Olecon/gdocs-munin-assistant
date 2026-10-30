'use strict';
// Module turn.js: sending a message and the tool loop: setBusy, sendMessage, runPersonaTurn, runSideTurn (/side),
// executeTool / runToolCall (replace_selection: replaceSelectionCall), toolLoop (the model responses of a turn; the
// tool calls of a round: runRoundCalls; the live bubble: liveAnswer), assistantEntry,
// noteFinish, finishTurn (document facts, history slimming; settleAutoKinds), the wrap-up at the round limit and its Continue
// notice (addContinueNotice, continueFromButton), the nudge (announcesEdit), the one-slot queue of a message typed
// while a turn runs (queueInput, settleQueue).
/* global $, addAssistantBubble, ASK_USER_TOOL, askUser, AUTO_CONTINUE_NOTICE, AUTO_CONTINUE_TEXT, CONTINUE_TEXT, NUDGE_MAX_CHARS, NUDGE_TEXT,
   noteSeenLines, offersWriteTools, requireToolCall, withoutReplay, WRAP_UP_NOTICE, WRAP_UP_TEXT, backgroundCompact, addError, addNotice, addUserBubble, apiEditing, apiReplaceSelection,
   applyPendingSelection, applyToDocument, buildRequest, buildTurnContext, canEdit, closeChatMenu, commandUnavailable, MUNIN_ONLY_NOTICE, closeModeMenu, closePopup,
   citationsInRanges, countSearches, createRenderCoordinator, docFacts, docIdFromUrl, holdChatLock, docStatusText, el, extraTool, fetchDocText, fmtNum, FORMAT_READING_TOOL, gateEdit, getDocTab,
   forgetSideBubbles, syncSideThread, undoingNotice,
   isExtraReading, runTurnHooks, beforeTurnLines,
   isEditTool, isMainDocRef, isMuninPersona, isReadingTool, logEntry, MAX_TOOL_ITERATIONS, maybeCompact,
   noteSearchActivity, noteTrim, PASTE_AGAIN_CARD, PASTE_AGAIN_TEXT, PASTE_DONE_NOTE, openDocumentTool, parseSlashCommand, parseToolArgs,
   pendingCardText, PERSONA_DOC_CHAR_LIMIT, planApiSelection, READING_TOOLS, readingSummary, readingTarget,
   readChatForTurn, readLimits, refreshContext, refreshSelection, rememberTool, renderHistory, renderHistoryKeepingNotices, renderSources,
   REPLACE_TOOL, resetDocsApiTurn, runCheck, runReadingTool, runSelfTest, runStream, runWriteTool, saveHistory, scrollToBottom, setStatus, slimHistory,
   REMEMBER_PENDING, snapshotDocument, state, streamPersona, takeSnapshot, toolCard, toolCardFor, toolsFor, updateAssistantBubble,
   WRITE_TOOLS,
   offered, applyTurnMode, PLAN_DO_TEXT, renderContextGauge, setApplyMode */
/* exported setBusy, updateActionState, sendMessage, executeTool, toolLoop, queueInput, editQueued, discardQueued,
   syncQueueChat, continueFromButton, doPlanFromButton, announcesEdit */

// ---------------------------------------------------------------------------
// Sending a message and the tool loop
// ---------------------------------------------------------------------------
const QUEUE_PLACEHOLDER = 'Type your next message (Enter queues it until this answer is finished)';
let idlePlaceholder = null; // the input's own placeholder, put back when the panel is idle

function setBusy(b) {
  state.busy = b;
  // One inline button: "Send" when idle, "Stop generating" while a request runs.
  const label = b ? 'Stop generating' : 'Send (Enter)';
  el.action.classList.toggle('stopping', b);
  el.action.title = label;
  el.action.setAttribute('aria-label', label);
  if (idlePlaceholder === null) idlePlaceholder = el.input.placeholder;
  el.input.placeholder = b ? QUEUE_PLACEHOLDER : idlePlaceholder; // Enter queues while busy (queueInput)
  // The chat is a polite live region; busy makes screen readers wait for the answer instead of reading every repaint.
  el.chat.setAttribute('aria-busy', String(b));
  el.modeCycle.disabled = b;
  // Chats cannot be created, switched or deleted while a request is running.
  el.newChatBtn.disabled = b;
  el.chatSwitchBtn.disabled = b;
  if (b) { closeChatMenu(); closeModeMenu(); }
  updateActionState();
}

// Dimmed look for Send when the input is empty (clicking it still just does nothing, as before).
function updateActionState() {
  const empty = !state.busy && !el.input.value.trim();
  el.action.classList.toggle('is-empty', empty);
  el.action.setAttribute('aria-disabled', String(empty));
}

// ---- The queue: one message typed while a turn runs -----------------------------------------------
// state.queued = { text, docId, chatId } (the chat it was queued in) or null. Enter while busy moves the
// input into it (a second Enter appends after a blank line); sendMessage sends it when the turn finishes
// normally and puts it back into the input box after Stop or an error. Per panel, never stored.
const QUEUE_PREVIEW_CHARS = 80;

function renderQueue() {
  const q = state.queued;
  $('queueRow').classList.toggle('hidden', !q);
  const t = $('queueText');
  const flat = q ? q.text.replace(/\s+/g, ' ') : '';
  t.textContent = flat.length > QUEUE_PREVIEW_CHARS ? flat.slice(0, QUEUE_PREVIEW_CHARS) + '…' : flat;
  t.title = q ? q.text : '';
}

// Enter while busy. Returns false when there is nothing new to queue. While this panel's own message
// still waits in the input box for another tab's answer (state.sendingInput), that text is already on its
// way: only what was typed after it is queued, and the input box keeps it.
function queueInput() {
  let raw = el.input.value;
  let keep = '';
  const waiting = state.sendingInput;
  if (waiting != null && raw.startsWith(waiting)) { keep = waiting; raw = raw.slice(waiting.length); }
  const text = raw.trim();
  if (!text) return false;
  const q = state.queued;
  state.queued = q ? { ...q, text: q.text + '\n\n' + text } : { text, docId: state.docId, chatId: state.chatId };
  el.input.value = keep;
  closePopup();
  updateActionState();
  renderQueue();
  return true;
}

// Edit (or a chat / document change): the slot goes back into the input box, before any draft there.
function editQueued() {
  const q = state.queued;
  if (!q) return;
  state.queued = null;
  const draft = el.input.value;
  el.input.value = draft.trim() ? q.text + '\n\n' + draft : q.text;
  renderQueue();
  updateActionState();
}

function discardQueued() {
  state.queued = null;
  renderQueue();
}

// A queued message never moves to another chat: when the panel shows another chat or document, it goes
// back into the input box.
function syncQueueChat() {
  const q = state.queued;
  if (q && (q.docId !== state.docId || q.chatId !== state.chatId)) editQueued();
}

// The finish hook of sendMessage, once the turn is over (busy cleared, chat lock released). outcome
// 'done': returns the queued message to send next (the slot is emptied). Otherwise (Stop, an error, a
// self-test) it goes back into an empty input box; a draft typed there meanwhile is kept and the
// message stays queued.
function settleQueue(outcome) {
  const q = state.queued;
  if (!q || state.busy) return null;
  if (outcome === 'done' && q.docId === state.docId && q.chatId === state.chatId) {
    state.queued = null;
    renderQueue();
    return q;
  }
  if (q.docId !== state.docId || q.chatId !== state.chatId) { editQueued(); return null; }
  if (!el.input.value.trim()) editQueued();
  return null;
}

// A queued message that could not start (Stop while waiting for the lock, an error before the turn):
// back at the front of the slot, for settleQueue to return it.
function requeue(q) {
  const cur = state.queued;
  state.queued = { ...q, text: cur ? q.text + '\n\n' + cur.text : q.text };
  renderQueue();
}

// The live answer bubble of one streamed reply: hooks record the latest state in live, schedule() asks the render
// coordinator to paint it (the bubble is created by the first paint, or by ensureBubble()). start() asks for that paint
// at once, empty and streaming, so the orb shows while the first token is awaited; discard() removes it again while nothing
// was painted into it (a failure before the first chunk, Stop, an empty reply).
function liveAnswer() {
  const view = { bubble: null, live: { text: '', reasoning: '', activity: [] }, filled: false };
  view.painter = createRenderCoordinator((s) => {
    view.ensureBubble();
    updateAssistantBubble(view.bubble, { text: s.text, reasoning: s.reasoning, activity: s.activity, streaming: true });
    scrollToBottom(false);
  });
  view.schedule = () => { view.filled = true; view.painter.update(view.live); };
  view.ensureBubble = () => view.bubble || (view.bubble = addAssistantBubble());
  view.start = () => { view.painter.update(view.live); return view; }; // the next frame paints it; not filled
  view.discard = () => {
    if (!view.bubble || view.filled) return;
    view.bubble.remove();
    view.bubble = null;
  };
  return view;
}

// Munin persona turn (/research, /code, /chat): one persona request, chat-only answer with
// server-side tool activity.
async function runPersonaTurn(persona, snap, signal) {
  const view = liveAnswer().start();
  const { live, painter, schedule } = view;
  const hooks = {
    onReasoning(r) { live.reasoning = r; schedule(); },
    onContent(c) { live.text = c; schedule(); },
    onActivity(list) {
      live.activity = list.slice();
      setStatus(`${snap.prov.label} /${persona} is working… (${list.length} tool call${list.length === 1 ? '' : 's'})`);
      schedule();
    },
  };

  const req = buildRequest(persona, snap);
  noteTrim(req);
  let result;
  try {
    result = await streamPersona(req, signal, snap, hooks);
  } catch (e) {
    // A pending frame would otherwise add a stale "typing" bubble after renderHistory().
    painter.cancel();
    view.discard();
    const p = e.partial;
    if (p && (p.content.trim() || p.reasoning || p.activity.length)) state.messages.push(assistantEntry(p, false));
    throw e;
  }
  // The final state is painted now, not a frame later (renderHistory at the end of the turn replaces it, also when
  // the persona reply renders differently from the live bubble).
  if (view.filled) painter.flush();
  painter.cancel();
  view.discard(); // nothing streamed: the waiting bubble goes; renderHistory shows the stored reply
  state.messages.push(assistantEntry(result, false));
  if (result.finishReason === 'length') addNotice('The reply was cut off by the length limit.', { sticky: true });
}

// Executes one tool call. Returns the history entry for the "tool" message (content goes to the
// model; "_" fields are for the UI only: _ok, _message, _detail, _reading, _edit, and for gated
// open_document calls and gated edits _decision ('accepted' | 'accepted-all' | 'rejected' | 'stopped')).
// ui: { card } the tool call's pending card in the chat, which a permission card (open_document, the edit
// gate) takes over (ui.card is then that card, for the caller to remove or replace).
// snap.tainted (the turn snapshot, so it starts unset every turn): set once an opened document was read
// in this turn (snap.docCache holds what open_document and reads with "doc" loaded) or web search
// results arrived; the edit gate (gateEdit) then asks before every write of the turn.
async function executeTool(tc, mode, snap, ui = {}) {
  const r = await runToolCall(tc, mode, snap, ui);
  noteSeenLines(tc.function.name, ui.args, r, snap); // for the read-first check (gate.js)
  if (ui.decision) r._decision = ui.decision;
  appendCheckNotes(r, tc.function.name, ui);
  if (snap.docCache && snap.docCache.size) snap.tainted = true;
  return r;
}

// The notes of the beforeWrite checks (gateEdit: ui.notes) go after a successful write's result, so the model
// sees them in the next round. Not after a paste: it cannot be verified or redone in this turn (one paste).
function appendCheckNotes(r, name, ui) {
  const notes = ui.notes || [];
  if (!notes.length || !r._ok || typeof r.content !== 'string') return;
  if (name === REPLACE_TOOL.function.name && !r._edit) return;
  r.content += '\nNote: ' + notes.join('\nNote: ');
}

async function runToolCall(tc, mode, snap, ui) {
  const base = { role: 'tool', tool_call_id: tc.id };
  const name = tc.function.name;
  const { args, error } = parseToolArgs(tc);
  if (error !== null) {
    return { ...base, content: 'Error: the arguments are not valid JSON.', _ok: false, _message: 'Invalid tool arguments' };
  }
  ui.args = args; // for the beforeWrite checks of gateEdit
  if (name === 'open_document') {
    return { ...base, ...(await openDocumentTool(args, snap, ui)), _reading: true };
  }
  if (READING_TOOLS.includes(name) || name === FORMAT_READING_TOOL) {
    const { target, error: refused } = await readingTarget(name, args, snap);
    const content = refused || runReadingTool(name, args, target, readLimits(snap.prov));
    return { ...base, content, _ok: !content.startsWith('Error:'), _reading: true, _message: readingSummary(name, args) };
  }
  // Not a document edit: no journal, no responseWrite; the gate asks only in a tainted turn. It changes the
  // next turns' instructions only.
  if (name === 'remember') {
    // A side question (/side) leaves nothing behind, the document instructions included.
    if (snap.side) return { ...base, content: 'Error: remember is not available in a side question. Tell the user to ask for it in the main chat.', _ok: false, _message: 'Not available in a side question' };
    if (mode === 'plan') return { ...base, content: 'Error: remember is not available in Plan mode. Put it in the plan as a step instead.', _ok: false, _message: 'Not available in Plan mode' };
    return { ...base, ...(await rememberTool(args, snap, ui)) };
  }
  // ask_user (registered in tools.js): reads and writes nothing, so every turn with client tools may call it (Manual and
  // side questions included); runExtraTool would refuse it outside Auto as a writing tool.
  if (name === ASK_USER_TOOL.function.name) return { ...base, ...(await askUser(args, snap, ui)) };
  const extra = extraTool(name);
  if (extra) return { ...base, ...(await runExtraTool(extra, name, args, mode, snap, ui, tc.id)) };
  if (name !== REPLACE_TOOL.function.name && !WRITE_TOOLS.includes(name)) {
    const available = toolsFor(mode, snap).map((t) => t.function.name).join(', ') || 'none';
    return { ...base, content: `Error: unknown tool "${name}". Available tools: ${available}.`, _ok: false, _message: 'Unknown tool: ' + name };
  }
  const refusal = editRefusal(name, args, mode);
  if (refusal) return { ...base, ...refusal };
  if (WRITE_TOOLS.includes(name)) {
    if (!apiEditing(mode, snap)) {
      return { ...base, content: `Error: ${name} needs the Google Docs API, which is not available for this message. Use replace_selection or answer in the chat.`, _ok: false, _message: 'The Docs API is not available' };
    }
    try {
      return { ...base, ...(await runWriteTool(name, args, snap, tc.id, ui)) };
    } catch (e) {
      return { ...base, content: `Error: ${e.message}`, _ok: false, _message: 'Edit failed: ' + e.message };
    }
  }
  return { ...base, ...(await replaceSelectionCall(name, args, mode, snap, ui, tc.id)) };
}

// replace_selection: through the Docs API when the selection can be found exactly once, otherwise pasted. Returns
// the tool message fields.
async function replaceSelectionCall(name, args, mode, snap, ui, id) {
  if (typeof args.text !== 'string') {
    return { content: 'Error: invalid arguments. Expected an object {"text": string}.', _ok: false, _message: 'Invalid tool arguments' };
  }
  // Through the API when the selection can be found exactly once; otherwise pasted as before.
  let plan = null;
  if (apiEditing(mode, snap)) { try { plan = planApiSelection(args.text, snap); } catch (e) { plan = null; } }
  // One paste per turn: the snapshot predates the paste, so the model cannot see it and a second call would
  // paste the text again. Refused before the gate, without touching the document (the API path is verified).
  const pasteAgain = { content: PASTE_AGAIN_TEXT, _ok: false, _message: PASTE_AGAIN_CARD, _cardLabel: 'Text (not pasted)', _pasteRefused: true };
  if (!plan && snap.pasteDone) return pasteAgain;
  // The citation guard of runWriteTool, for this tool's API path too (docs-write.js sets plan.removed).
  // The paste path is not checked: it replaces the selection the user made themselves.
  if (plan && plan.removed) { try { plan.citations = await citationsInRanges(snap.model, plan.removed); } catch (e) { plan.citations = []; } }
  const refused = await gateEdit(name, plan || { journal: { restore: snap.selection || '' } }, snap, ui);
  if (refused) return refused;
  if (plan) {
    let viaApi = null;
    try { viaApi = await apiReplaceSelection(plan, snap, id); } catch (e) { viaApi = null; }
    if (viaApi) return viaApi;
  }
  if (snap.pasteDone) return pasteAgain; // the API edit failed and would fall back to a second paste
  // expected: the selection the model saw; the content script does not paste when it changed meanwhile.
  const res = await applyToDocument(args.text, snap.selection || '');
  if (res.ok) { // how it was pasted goes to the tool card (_detail); the model gets PASTE_DONE_NOTE
    // Confirmed or not (verified false: Docs does not confirm synthetic pastes), the model's reading tools
    // show the snapshot from before the paste: the note tells it not to re-read to verify or paste again.
    snap.pasteDone = true;
    const out = { content: JSON.stringify({ ok: true, note: PASTE_DONE_NOTE }), _ok: true, _message: res.message || 'Replaced in document' };
    if (res.detail) out._detail = res.detail;
    if (Number.isFinite(res.attempts)) out._attempts = res.attempts;
    return out;
  }
  return {
    content: res.selectionChanged
      ? `Error: the user changed the selection in the document while you were answering, so the text was not pasted. ${res.copied
        ? 'It was copied to the clipboard; the user can paste it where they want with Ctrl+V.'
        : 'Show the text in the chat so the user can paste it manually.'} Do not call the tool again.`
      : res.copied
      ? 'Error: automatic paste failed. The text was copied to the clipboard and the user will paste it manually with Ctrl+V. Do not call the tool again.'
      : 'Error: automatic paste failed (' + (res.detail || 'unknown reason') + '). Show the text in the chat so the user can paste it manually. Do not call the tool again.',
    _ok: false, _message: res.message, // the message already includes the detail
  };
}

// Why a writing call cannot run, as the tool message fields, or null: editing needs Auto mode, and opened documents
// are read-only (the schemas have no "doc"; a lenient server may still send it).
function editRefusal(name, args, mode) {
  if (!canEdit(mode)) {
    return { content: 'Error: the document cannot be modified in this mode. Put the complete resulting text in your answer instead.', _ok: false, _message: 'Editing is not available in this mode' };
  }
  if (!isMainDocRef(args.doc)) {
    return { content: `Error: ${name} edits only the main document; documents opened with open_document are read-only. Call it again without doc.`, _ok: false, _message: 'Opened documents are read-only' };
  }
  return null;
}

// A call of a tool added with registerTools (src/registry.js). Not offered in this turn: refused like an unknown
// tool. Reading calls: _reading, the action-log summary as _message. Writing calls: Auto mode and the main
// document only, like the built-in writing tools; a thrown error becomes an "Error:" result.
async function runExtraTool(extra, name, args, mode, snap, ui, id) {
  if (!offered(extra, mode, snap)) {
    return { content: `Error: ${name} is not available for this message.`, _ok: false, _message: `${name} is not available` };
  }
  const reading = isExtraReading(name, args);
  const refusal = reading ? null : editRefusal(name, args, mode);
  if (refusal) return refusal;
  let r;
  try { r = await extra.run(name, args, snap, ui, { id, mode }); } catch (e) {
    return { content: `Error: ${e.message}`, _ok: false, _message: `${name} failed: ${e.message}`, ...(reading ? { _reading: true } : {}) };
  }
  const fields = typeof r === 'string' ? { content: r, _ok: !r.startsWith('Error:') } : { ...r };
  if (!reading) return fields;
  return { _message: extra.summary ? extra.summary(name, args) : '', ...fields, _reading: true };
}

// Builds the stored assistant message for a round. includeTools: keep tool_calls (only when they
// are going to be executed, so every tool_call gets a tool reply).
function assistantEntry(result, includeTools) {
  const m = { role: 'assistant', content: result.content || null };
  if (includeTools && result.toolCalls.length) {
    m.tool_calls = result.toolCalls;
    // The provider's raw output (Anthropic content blocks / OpenAI output items) is kept only when
    // the tool loop continues: the next round of this turn replays it verbatim (toAnthropicMessages,
    // toResponsesInput). It is UI-neutral and never sent to another provider.
    if (result.raw && result.raw.items.length) m[result.raw.key] = result.raw.items;
  }
  if (result.reasoning) m._reasoning = result.reasoning;
  if (result.usage) m._usage = result.usage;
  if (result.activity && result.activity.length) m._toolActivity = result.activity; // server-side web search rows
  if (result.sources && result.sources.length) m._sources = result.sources;
  return m;
}

const sameModel = (a, b) => String(a).startsWith(String(b)) || String(b).startsWith(String(a));

// Notices about how the final reply of a turn ended (anything other than a normal stop).
function noteFinish(result, snap) {
  const r = result.finishReason;
  if (r === 'length') {
    addNotice(result.toolCalls.length
      ? 'The reply hit the length limit before the tool call was complete, so nothing was changed. Ask for a smaller part of the text.'
      : 'The reply was cut off by the length limit.', { sticky: true });
  } else if (r === 'refusal') {
    const cat = result.stopDetails && result.stopDetails.category;
    addError(`${snap.prov.label} declined this request (safety classifier${cat ? ': ' + cat : ''}). Nothing was changed.`);
  } else if (r && r !== 'stop' && r !== 'tool_calls') {
    addNotice(`The reply ended early (${r}).`);
  }
  if (snap.prov.id === 'anthropic' && result.servedBy && !sameModel(result.servedBy, snap.cfg.model)) {
    addNotice(`Answered by ${result.servedBy}: the requested model declined the request and the API fell back to another Claude model.`, { sticky: true });
  }
}

// The document facts stored at the end of the chat's previous turn (on its user message), or null.
function lastDocFacts(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user' && messages[i]._docFacts) return messages[i]._docFacts;
  return null;
}
// End of a turn (also after an error or Stop): the document facts at this point (after the edits of the
// turn) go on the turn's user message for the next turn's <document_changes> (only the newest is kept),
// and the history is slimmed (slimHistory). The caller saves the history.
function finishTurn(userMsg, snap, chatCtx) {
  settleAutoKinds(chatCtx.messages, userMsg);
  const facts = docFacts(snap);
  for (const m of chatCtx.messages) if (m !== userMsg && m.role === 'user' && m._docFacts) delete m._docFacts;
  if (facts) userMsg._docFacts = facts;
  slimHistory(chatCtx.messages);
  runTurnHooks('finish', userMsg, snap, chatCtx); // registerTurnHook (best effort)
}

// The wrap-up and nudge requests (_auto with _autoKind) matter only while their turn runs: the rounds after them replay
// them. Once the turn is over they leave the history, so the stored chat shows no row for them (only the length
// continuation keeps its row); the answer that followed a wrap-up request is marked _wrapUp, which the fold and the
// summary transcript note. slimHistory drops the replay payloads right after, so the requests of later turns, rebuilt
// from text and tool calls, stay valid (consecutive assistant messages are allowed by every provider).
function settleAutoKinds(messages, userMsg) {
  const start = messages.indexOf(userMsg);
  if (start < 0) return;
  for (let i = messages.length - 1; i > start; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !m._auto || !m._autoKind) continue;
    const next = messages[i + 1];
    if (m._autoKind === 'wrap-up' && next && next.role === 'assistant') next._wrapUp = true;
    messages.splice(i, 1);
  }
}

// The notice after a wrap-up answer, with its Continue button (data-act "continue-turn", main.js).
function addContinueNotice() {
  const row = addNotice(WRAP_UP_NOTICE, { sticky: true });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn small';
  btn.dataset.act = 'continue-turn';
  btn.textContent = 'Continue';
  btn.title = 'Send "' + CONTINUE_TEXT + '"';
  btn.style.marginLeft = '6px';
  row.appendChild(btn);
  return row;
}

// Continue: CONTINUE_TEXT as a normal message of this chat, once (the row goes), through the Send path (the chat lock,
// Auto or Manual as set); while a turn runs it is queued like a message typed then.
function continueFromButton(btn) {
  if (btn) {
    if (btn.disabled) return Promise.resolve();
    btn.disabled = true;
    if (btn.parentNode) btn.parentNode.remove();
  }
  const q = { text: CONTINUE_TEXT, docId: state.docId, chatId: state.chatId };
  if (state.busy) {
    const cur = state.queued;
    state.queued = cur ? { ...cur, text: cur.text + '\n\n' + q.text } : q;
    renderQueue();
    return Promise.resolve();
  }
  return sendMessage(q);
}

// A Plan turn's final answer (the last message: an assistant text without tool calls) is marked _plan: rendered as the
// latest message, it gets the Do it button (renderHistory).
function markPlanAnswer() {
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === 'assistant' && !last.tool_calls && String(last.content || '').trim()) last._plan = true;
}

// Do it under the latest Plan answer: the mode becomes Edit automatically (stored, as a pick in the mode menu) and
// PLAN_DO_TEXT goes as one normal message through the Send path; the plan is in the history, so the model carries it
// out with the writing tools (the gate and the writing checks apply). Ignored while an answer runs.
async function doPlanFromButton(btn) {
  if (state.busy || state.undoing || (btn && btn.disabled)) return;
  if (btn) btn.disabled = true;
  await setApplyMode('auto');
  renderContextGauge();
  await sendMessage({ text: PLAN_DO_TEXT, docId: state.docId, chatId: state.chatId });
}

const CHAT_WAIT_STATUS = 'Another tab is answering in this chat…';

// Send (Enter / the button) with no argument: the text of the input box. queued: a message from the queue
// (settleQueue), sent the same way without touching the input box. After the turn the queue is settled:
// a normal finish sends the next queued message through this same path, so it waits for the chat lock
// and follows every rule of a typed message. When no queued message follows a turn, the history may be compacted in
// the background (backgroundCompact: near the trigger only; not awaited, a new message stops it).
async function sendMessage(queued = null) {
  const fromQueue = queued && typeof queued.text === 'string' ? queued : null;
  const outcome = await startTurn(fromQueue);
  if (outcome === 'idle' && !fromQueue) return; // nothing ran (busy, empty input, no key…): the queue waits
  if (fromQueue && (outcome === 'idle' || outcome === 'bail')) requeue(fromQueue);
  const next = settleQueue(outcome);
  if (next) { await sendMessage(next); return; } // the queued message first: its own turn compacts at its start
  if (outcome === 'done' || outcome === 'stopped') backgroundCompact(); // not after a failure: the request would fail too
}

// Returns 'idle' (nothing started), 'bail' (stopped or failed before the turn began), 'selftest', or
// runTurn's 'done' / 'stopped' / 'failed'.
async function startTurn(fromQueue) {
  if (state.busy) return 'idle';
  if (state.undoing) { setStatus(undoingNotice(), true); return 'idle'; }
  // A leading /research, /code or /chat gives this turn a persona (with Munin: its own pipeline).
  const { persona, text, selftest, side, check } = parseSlashCommand(fromQueue ? fromQueue.text : el.input.value);
  // /test: the panel's self-test, /check: the pre-submission report, handled here (not turns: no chat history; see
  // runSelfTest, runCheck).
  if (selftest || check) {
    const draft = el.input.value;
    const run = check ? runCheck() : runSelfTest(); // empties the input box before its first await…
    if (fromQueue) el.input.value = draft; // …which holds the user's draft, not the queued /test
    await run;
    return 'selftest';
  }
  // /code needs Munin: with another provider the message stays in the input box (commandUnavailable).
  if (persona && commandUnavailable(persona)) { addNotice(MUNIN_ONLY_NOTICE(persona)); return 'idle'; }
  if (!text) {
    if (side) addNotice('Write your question after /side, for example: /side what does this term mean?');
    else if (persona) setStatus('Type a message after the command', true);
    return 'idle';
  }
  // Default turns follow the mode button (disabled while busy): 'edit', 'plan' or 'manual'; /side is always Manual.
  const mode = side ? 'manual' : persona || applyTurnMode();
  // Provider, its settings and the document mode are frozen for the whole turn (see takeSnapshot).
  const snap = takeSnapshot();
  const label = snap.prov.label;
  if (!snap.cfg.apiKey) {
    addError(`No ${label} API key set.`, true);
    return 'idle';
  }
  // busy is set before the first await, otherwise a double Enter/click starts two requests.
  setBusy(true);
  state.sendingInput = fromQueue ? null : el.input.value; // until runTurn empties the input box (see queueInput)
  state.pendingSelection = null;
  // Created before the first await so Stop works during the preparation phase too.
  const abort = new AbortController();
  state.abort = abort;
  snap.signal = abort.signal; // Stop rejects a pending open_document card
  const bail = (msg) => { if (msg) addError(msg); state.abort = null; state.sendingInput = null; setBusy(false); applyPendingSelection(); };
  let tab;
  try {
    if (state.loadingCtx) await state.loadingCtx; // chat store still loading (panel just opened)
    tab = await getDocTab();
    if (docIdFromUrl(tab.url) !== state.docId) await refreshContext();
    if (state.loadingCtx) await state.loadingCtx;
  } catch (e) { bail(e.message); return 'bail'; }
  if (!state.docId || docIdFromUrl(tab.url) !== state.docId || !state.chatId) {
    bail('Could not identify the document in this tab.'); return 'bail';
  }
  // A queued message goes only to the chat it was queued in (the tab may show another document by now).
  if (fromQueue && (state.docId !== fromQueue.docId || state.chatId !== fromQueue.chatId)) { bail(); return 'bail'; }
  if (abort.signal.aborted) { bail(); addNotice('Stopped.'); return 'bail'; }
  // A side question neither reads nor writes the stored chat: no chat lock. It returns a turn outcome,
  // so a queued message is settled after it like after a normal turn.
  if (side) return runSideTurn({ text, snap, label, abort, tab, fromInput: !fromQueue });
  // The turn owns the chat (holdChatLock) until it ends: an answer running in this chat in another tab is
  // finished first, and the turn starts from the history as that tab left it (readChatForTurn). Stop while
  // waiting gives up the wait; the message stays in the input box.
  const { docId, chatId } = state;
  let releaseChat;
  try {
    releaseChat = await holdChatLock(docId, chatId, { signal: abort.signal, onWait: () => setStatus(CHAT_WAIT_STATUS) });
  } catch (e) {
    bail(); setStatus(docStatusText(), state.docText == null);
    addNotice(abort.signal.aborted ? 'Stopped. Your message is still in the input box.' : 'Could not wait for another tab: ' + (e.message || e));
    return 'bail';
  }
  try {
    const exists = await readChatForTurn(docId, chatId);
    if (!exists || abort.signal.aborted) { // deleted in another tab meanwhile: the panel switches away
      bail(); setStatus(docStatusText(), state.docText == null);
      if (exists) addNotice('Stopped. Your message is still in the input box.');
      return 'bail';
    }
    return await runTurn({ persona, text, mode, snap, label, abort, tab, fromInput: !fromQueue });
  } finally {
    releaseChat();
  }
}

// The model responses of a turn and their tool calls: at most MAX_TOOL_ITERATIONS + 1 responses (plus the wrap-up),
// each built with buildRequest and streamed with runStream; the calls run through executeTool (the reading
// tools, open_document, the edit gate and the writing tools). runTurn shows everything in the chat; the
// self-test's model scenarios (src/selftest.js) run the same loop quietly on a scratch history.
// io: { messages: the history the responses and tool results are appended to (the turn's user message is
//   its last user message, apart from the panel's own requests, _auto), save(): called after every
//   edit and every round (runTurn: saveHistory), quiet: no bubbles, cards, notices or trimming note, request:
//   extra buildRequest options (the self-test's history), status(text) (default setStatus), waiting: the status
//   between rounds }.
// The panel's own user-role requests (_auto, appended like any other message so the cached prefix stays valid): one
// continuation after a length cut (AUTO_CONTINUE_TEXT); in visible main-chat turns (not quiet, not /side) the wrap-up
// at the round limit (WRAP_UP_TEXT, _autoKind 'wrap-up': one more request without tools, whose answer ends the turn)
// and, in Auto, one nudge after a reply that announced an edit without calling a tool (NUDGE_TEXT, _autoKind 'nudge';
// that request asks for a tool call where the provider supports it: requireToolCall). finishTurn removes the
// wrap-up and nudge requests once the turn is over (settleAutoKinds).
// Returns { replaced (an edit or paste succeeded), rounds (responses), tools (names of the executed calls,
//   in order), usage ({prompt_tokens, completion_tokens} summed, or null), final (the last response),
//   limit (the round limit was reached), wrapUp (the wrap-up answer ended the turn), nudged (the nudge round ran),
//   continued (automatic continuations after a length cut: 0 or 1) }.
//   Throws on a stream error or Stop (AbortError), with the partial answer already in io.messages.
async function toolLoop(mode, snap, signal, io) {
  const { messages, quiet } = io;
  const save = io.save || (async () => {});
  const status = io.status || setStatus;
  const out = { replaced: false, rounds: 0, tools: [], usage: null, final: null, limit: false, wrapUp: false, nudged: false, continued: 0 };
  if (quiet) snap.quiet = true; // nobody to answer an ask_user card (askUser refuses)
  const loud = !quiet && !snap.side; // the wrap-up and the nudge: visible main-chat turns only
  if (loud) snap.readFirst = true; // the read-first check of gate.js applies to the model's writes here
  const nextRound = async () => { await save(); if (io.waiting) status(io.waiting); };
  let kind = null; // the panel's request before this round: 'wrap-up' | 'nudge' | null
  for (let round = 0; round <= MAX_TOOL_ITERATIONS || kind === 'wrap-up'; round++) {
    const view = liveAnswer();
    if (!quiet) view.start(); // the orb while the first token is awaited
    const cards = new Map(); // tool-call index -> pending replacement card
    // "edit" (Edit automatically), "manual", "plan" or a persona (non-Munin providers). The wrap-up request has no tools, and the turn's
    // rounds go without their replay payloads (no reasoning item or thinking block without its call).
    const opts = kind === 'wrap-up' ? { ...(io.request || {}), noTools: true, history: withoutReplay(messages) } : io.request || {};
    const req = buildRequest(mode, snap, opts);
    if (kind === 'nudge') requireToolCall(req);
    if (!quiet) noteTrim(req);
    let result;
    try {
      result = await runStream(req, signal, snap, quiet ? {} : streamHooks(view, cards, snap));
    } catch (e) {
      // A pending frame would otherwise add a stale "typing" bubble after renderHistory().
      view.painter.cancel();
      view.discard(); // failed or stopped before the first chunk: no empty bubble stays
      // Keep partial text/reasoning for display; unfinished tool calls are dropped.
      const p = e.partial;
      if (p && (p.content.trim() || p.reasoning)) messages.push(assistantEntry(p, false));
      if (p) out.final = p;
      e.loop = out; // what ran before the failure (the self-test reports it)
      throw e;
    }
    // The streamed state is painted into the bubble now; a bubble nothing was streamed into gets the result
    // below, or goes when there is nothing to show.
    if (view.filled) view.painter.flush();
    view.painter.cancel();
    out.rounds++;
    out.final = result;
    addUsage(out, result.usage);
    const serverActivity = result.activity || [];
    snap.searchesDone = (snap.searchesDone || 0) + countSearches(serverActivity);
    if (serverActivity.length) snap.tainted = true; // web search results (see executeTool)
    // Tool calls are executed only when the request offered tools (a request without tools never
    // touches the document or the clipboard, even if the server returned a call anyway). Every turn
    // with tools can read; only Auto can edit (executeTool refuses otherwise).
    const wantsTools = req.tools.length > 0 && result.toolCalls.length > 0 && result.finishReason !== 'length';
    if (!quiet) {
      if (result.content || result.reasoning || serverActivity.length || view.filled || (view.bubble && wantsTools)) {
        updateAssistantBubble(view.ensureBubble(), { text: result.content, reasoning: result.reasoning, usage: result.usage, activity: serverActivity });
        renderSources(view.bubble, result.sources);
      } else view.discard();
    }
    if (kind === 'wrap-up') { // its answer ends the turn
      messages.push(assistantEntry(result, false));
      out.wrapUp = true;
      if (!quiet) noteFinish(result, snap);
      break;
    }
    kind = null;

    if (wantsTools && round === MAX_TOOL_ITERATIONS) {
      // The calls of this response are not executed, so they are not kept: no call without its result.
      messages.push(assistantEntry(result, false));
      out.limit = true;
      if (loud && !signal.aborted) {
        messages.push({ role: 'user', content: WRAP_UP_TEXT, _auto: true, _autoKind: 'wrap-up' });
        kind = 'wrap-up';
        await nextRound();
        continue;
      }
      if (!quiet) addNotice(`Stopped after ${MAX_TOOL_ITERATIONS} tool rounds in a row.`, { sticky: true });
      break;
    }
    if (wantsTools) {
      messages.push(assistantEntry(result, true));
      await runRoundCalls(result, { mode, snap, signal, io, out, view, cards, save, status });
      await save();
      if (signal.aborted) break;
      if (io.waiting) status(io.waiting);
      continue; // the model continues after the tool results
    }

    // Anthropic paused a long server-side search (pause_turn): the paused message goes back as it is
    // (its raw blocks are replayed) and the API resumes it; bounded by the tool-round limit.
    if (result.finishReason === 'pause_turn' && round < MAX_TOOL_ITERATIONS && !signal.aborted) {
      const paused = assistantEntry(result, false);
      if (result.raw && result.raw.items.length) paused[result.raw.key] = result.raw.items;
      messages.push(paused);
      await nextRound();
      continue;
    }
    // Unfinished tool calls (cut off by max_tokens) are not executed and not kept in history.
    messages.push(assistantEntry(result, false));
    // The first reply of the turn that is cut by the length limit gets one automatic continuation (AUTO_CONTINUE_TEXT, a
    // user-role message marked _auto, appended like any other message so the cached prefix stays valid). A second
    // cut, or one in the last round, ends the turn with the usual notice.
    if (result.finishReason === 'length' && !out.continued && round < MAX_TOOL_ITERATIONS && !signal.aborted) {
      out.continued++;
      messages.push({ role: 'user', content: AUTO_CONTINUE_TEXT, _auto: true });
      if (!quiet) addNotice(AUTO_CONTINUE_NOTICE);
      await nextRound();
      continue;
    }
    // An Auto reply that announced an edit and called no tool: one nudge per turn.
    if (loud && canEdit(mode) && !out.nudged && round < MAX_TOOL_ITERATIONS && !signal.aborted && result.finishReason === 'stop' &&
        offersEditing(req.tools) && announcesEdit(result.content)) {
      out.nudged = true;
      messages.push({ role: 'user', content: NUDGE_TEXT, _auto: true, _autoKind: 'nudge' });
      kind = 'nudge';
      await nextRound();
      continue;
    }
    if (!quiet) noteFinish(result, snap);
    break;
  }
  return out;
}

// The request offered a tool that edits the document (a writing tool of the Docs API, or replace_selection).
const offersEditing = (tools) => offersWriteTools(tools) || tools.some((t) => t.function.name === REPLACE_TOOL.function.name);

// ---- The nudge: a reply that announces an edit without calling a tool -----------------------------------------
// Narrow on purpose: a short reply (under NUDGE_MAX_CHARS), no question to the user, no offer ("if you want"), and a
// first-person announcement right before an edit verb ("I'll update", "Let me edit", "I will now replace"), or a Russian
// first-person future or "let us" form of an edit verb ("Сейчас заменю", "Давайте изменим", "Я обновлю"). A negation
// in the announcement ("I will not change") is no announcement.
const NUDGE_EN_RE = /\b(?:i'll|i will|i'm going to|i am going to|let me|let's|i shall)\s+((?:[a-z]+\s+){0,2}?)(?:update|edit|replace|rewrite|change|fix|correct|delete|remove|insert|add|format|apply|shorten|rephrase|revise|restructure|move|merge|split)\b/i;
const NUDGE_RU_RE = new RegExp('(?:^|[^\\p{L}])(?:' + ['заменю', 'заменим', 'изменю', 'изменим', 'исправлю', 'исправим', 'обновлю', 'обновим',
  'удалю', 'удалим', 'вставлю', 'вставим', 'добавлю', 'добавим', 'перепишу', 'перепишем', 'отредактирую', 'отредактируем',
  'отформатирую', 'отформатируем', 'сокращу', 'сократим', 'внесу', 'внесём', 'внесем', 'перефразирую', 'перефразируем',
  'объединю', 'объединим', 'перестрою', 'перестроим'].join('|') + ')(?![\\p{L}])', 'iu');
const NUDGE_NEGATION_RE = /\b(?:not|no|never|n't)\b|(?:^|[^\p{L}])не(?![\p{L}])/iu;
const NUDGE_OFFER_RE = /\bif you(?:'d| would)? (?:like|want|prefer)\b|\bshould i\b|\bwould you like\b|\bdo you want\b|если (?:хотите|нужно|надо)|хотите,? чтобы/i;
function announcesEdit(text) {
  const t = String(text || '').trim();
  if (!t || t.length >= NUDGE_MAX_CHARS || /\?\s*$/.test(t) || NUDGE_OFFER_RE.test(t)) return false;
  const en = NUDGE_EN_RE.exec(t);
  if (en) return !NUDGE_NEGATION_RE.test(en[1] || '');
  const ru = NUDGE_RU_RE.exec(t);
  if (!ru) return false;
  // The two words before the verb hold no negation ("не заменю").
  const before = t.slice(0, ru.index + 1).split(/\s+/).slice(-3).join(' ');
  return !NUDGE_NEGATION_RE.test(before);
}

// toolLoop's usage total: {prompt_tokens, completion_tokens} summed over the rounds.
function addUsage(out, u) {
  if (!u) return;
  const n = (x) => (Number.isFinite(x) ? x : 0);
  out.usage = out.usage || { prompt_tokens: 0, completion_tokens: 0 };
  out.usage.prompt_tokens += n(u.prompt_tokens);
  out.usage.completion_tokens += n(u.completion_tokens);
}

// The stream hooks of a visible round: the live bubble and a pending card per streamed edit.
function streamHooks(view, cards, snap) {
  const { live, painter, schedule } = view;
  return {
    onReasoning(r) { live.reasoning = r; schedule(); },
    onContent(c) { live.text = c; schedule(); },
    // Server-side web search calls (/research with OpenAI or Anthropic): plain activity rows.
    onActivity(list) { live.activity = list.slice(); noteSearchActivity(snap, list); schedule(); },
    // Only edits and remember get a card (reading calls are in the action log only). The answer bubble is created
    // first, so that its action log stays above the cards, as renderHistory shows them.
    onToolCall(i, call) {
      if (cards.has(i) || !(isEditTool(call.function.name) || call.function.name === 'remember')) return;
      if (!view.bubble) painter.update(live);
      painter.flush();
      cards.set(i, toolCard('pending', pendingCardText(call.function.name)));
    },
  };
}

// The status line while a tool call runs.
function toolStatus(tc) {
  const name = tc.function.name;
  if (name === 'open_document') return 'Opening a document…';
  if (isReadingTool(tc)) return 'Reading the document…';
  if (name === REPLACE_TOOL.function.name) return 'Replacing the selection…';
  if (name === 'remember') return REMEMBER_PENDING;
  if (name === ASK_USER_TOOL.function.name) return 'Waiting for your answer…';
  return 'Editing the document…';
}

// The tool calls of one round, in order (toolLoop): each result is appended to io.messages, logged in the round's
// action log and shown on its card; an edit is saved at once. After Stop the remaining calls are answered as cancelled.
async function runRoundCalls(result, { mode, snap, signal, io, out, view, cards, save, status }) {
  const { messages, quiet } = io;
  const serverActivity = result.activity || [];
  // Action log of this round: a row per call, added when the call starts and filled in when it ends.
  const log = [];
  const showLog = () => {
    if (quiet) return;
    updateAssistantBubble(view.ensureBubble(), { text: result.content, reasoning: result.reasoning, usage: result.usage, activity: [...serverActivity, ...log] });
  };
  snap.responseWrite = null; // line numbers are valid until the first edit of this response
  for (let i = 0; i < result.toolCalls.length; i++) {
    const tc = result.toolCalls[i];
    let r;
    if (signal.aborted) {
      r = { role: 'tool', tool_call_id: tc.id, content: 'Error: cancelled by the user.', _ok: false, _message: 'Cancelled by the user' };
    } else {
      const row = logEntry(tc, null);
      log.push(row);
      showLog();
      status(toolStatus(tc));
      const ui = { card: cards.get(i) || null }; // an open_document permission card takes the pending card's place
      // A write reports its phase (docs-write.js writePhase) on the pending row: the orb and the location line
      // follow it. The finished row is a new entry without it, so the card and the row text stay as they were.
      snap.onWritePhase = (phase) => { if (row.phase === phase) return; row.phase = phase; showLog(); };
      // A long reading call (find_relevant_sections) reports its progress as the pending row's summary; renderActivity
      // keys a log row by its status and result only, so the drawn row's key is cleared to repaint it.
      snap.onCallProgress = (text) => {
        if (row.summary === text) return;
        row.summary = text;
        const drawn = view.bubble && view.bubble._rows && view.bubble._rows[log.indexOf(row)];
        if (drawn) drawn._key = null;
        showLog();
      };
      try { r = await executeTool(tc, mode, snap, ui); } finally { snap.onWritePhase = null; snap.onCallProgress = null; }
      out.tools.push(tc.function.name);
      // open_document's Allow / Deny card (and, in a quiet loop, an edit gate's card) is removed
      if (ui.card && (quiet || isReadingTool(tc))) { ui.card.remove(); ui.card = null; }
      if (ui.card) cards.set(i, ui.card);
      log.pop();
    }
    if (r._ok && !r._reading && tc.function.name !== 'remember' && tc.function.name !== ASK_USER_TOOL.function.name) out.replaced = true;
    messages.push(r);
    if (r._ok && r._edit) await save(); // the edit journal survives a reload mid-turn
    log.push(logEntry(tc, r));
    showLog();
    if (isReadingTool(tc)) continue;
    const card = cards.get(i);
    if (card) { card.replaceWith(toolCardFor(tc, r)); cards.delete(i); }
  }
}

// The turn itself, with the chat lock held (see sendMessage). fromInput: the text came from the input box
// (emptied now; a queued message leaves the user's draft alone). Returns 'done', 'stopped' or 'failed'.
async function runTurn({ persona, text, mode, snap, label, abort, tab, fromInput = true }) {
  state.pinnedTabId = tab.id;
  // Every save of this request goes to the chat that was active when it started (switching,
  // creating and deleting chats are disabled while busy, but the save path does not rely on that).
  const chatCtx = { docId: state.docId, chatId: state.chatId, messages: state.messages };

  if (fromInput) { el.input.value = ''; closePopup(); }
  state.sendingInput = null;
  let replaced = false;
  let wrapped = false; // the tool budget ran out and the wrap-up answer ended the turn
  el.trimNote.classList.add('hidden');
  forgetSideBubbles(); // a side exchange shown now leaves with this turn's final re-render (its history stays)

  addUserBubble(text, persona);
  let userMsg = null; // stored once the turn context is built; an error before that leaves the history as it was
  try {
    await prepareSnapshot(snap, tab, chatCtx);
    snap.turnLines = await beforeTurnLines(mode, snap); // registerTurnHook('beforeTurn'): lines for buildTurnContext
    if (isMuninPersona(mode, snap) && snap.docText && snap.docText.length > PERSONA_DOC_CHAR_LIMIT) {
      addNotice(`The document is long (${fmtNum(snap.docText.length)} characters); only the first ${fmtNum(PERSONA_DOC_CHAR_LIMIT)} are sent to the model for /${persona} turns.`);
    }
    // _persona is display-only (badge); the request builders copy only role/content, plus the turn context
    // (_context: document summary, selection, changes since the previous turn), fixed here for the turn.
    const msg = persona ? { role: 'user', content: text, _persona: persona } : { role: 'user', content: text };
    const context = buildTurnContext(mode, snap, lastDocFacts(state.messages));
    if (context) msg._context = context;
    state.messages.push(msg);
    userMsg = msg;
    await saveHistory(chatCtx);
    const waiting = persona ? `Waiting for ${label} /${persona}…` : `Waiting for ${label}…`;
    setStatus(waiting);
    // Before the first request only (never between tool rounds): summarize the oldest turns if needed.
    if (await maybeCompact(mode, snap, abort.signal, chatCtx)) renderHistoryKeepingNotices();
    setStatus(waiting);
    if (isMuninPersona(mode, snap)) await runPersonaTurn(persona, snap, abort.signal);
    else {
      const loop = await toolLoop(mode, snap, abort.signal, { messages: state.messages, save: () => saveHistory(chatCtx), waiting });
      replaced = loop.replaced;
      wrapped = loop.wrapUp;
      if (mode === 'plan' && !abort.signal.aborted) markPlanAnswer();
    }
    finishTurn(userMsg, snap, chatCtx);
    await saveHistory(chatCtx);
    renderHistory();
    if (abort.signal.aborted) addNotice('Stopped.');
    else if (wrapped) addContinueNotice();
    if (replaced) setTimeout(() => refreshSelection(), 400);
    return abort.signal.aborted ? 'stopped' : 'done';
  } catch (e) {
    if (userMsg) {
      finishTurn(userMsg, snap, chatCtx);
      await saveHistory(chatCtx);
    }
    renderHistory();
    return reportTurnError(e, abort);
  } finally {
    endTurn(tab);
  }
}

// The start of a turn's work (runTurn, runSideTurn): the document and the selection are read again and frozen
// in the snapshot; a failed read is announced (the turn goes on without the document).
async function prepareSnapshot(snap, tab, chatCtx) {
  setStatus('Reading the document and selection…');
  resetDocsApiTurn(); // a Docs API failure of the previous turn does not block this one
  await Promise.all([refreshSelection(), fetchDocText()]);
  snapshotDocument(snap);
  snap.chatCtx = chatCtx; // open_document stores the opened documents on this chat (side questions: chatId null)
  snap.mainUrl = tab.url; // its Google account (authuser) is used to export opened documents
  if (snap.docText == null && snap.docError) addNotice(snap.docError + ' Answering without the document context.');
}

// The notice of a turn that ended with an error or Stop. Returns the turn outcome ('stopped' / 'failed').
function reportTurnError(e, abort) {
  const stopped = e.name === 'AbortError' || abort.signal.aborted;
  if (stopped) addNotice('Stopped.');
  else addError(e.message || String(e), !!e.showSettings);
  return stopped ? 'stopped' : 'failed';
}

// The panel after a turn (runTurn, runSideTurn): idle again, the selection and the status current.
function endTurn(tab) {
  state.abort = null;
  state.pinnedTabId = null;
  setBusy(false);
  applyPendingSelection();
  setStatus(docStatusText(), state.docText == null);
  // Tab switches were ignored while the request was running: catch up now.
  getDocTab().then((t) => { if (t.id !== tab.id || docIdFromUrl(t.url) !== state.docId) refreshContext(); })
    .catch(() => refreshContext());
}

// A side question (/side): a Manual-mode turn (reading tools, open_document; no editing, remember refused) with
// the same snapshot and turn context as a normal turn, on the side thread state.sideMessages instead of the
// chat. Without the chat lock: the stored chat is neither read nor written (no saveHistory, no compaction, no
// finishTurn and its hooks), the main history is not sent, and the side thread is never sent with main turns.
// Consecutive side questions continue the thread; it is dropped with the chat (syncSideThread).
// fromInput and the outcome ('done' / 'stopped' / 'failed') as in runTurn, so the queue settles after it.
async function runSideTurn({ text, snap, label, abort, tab, fromInput = true }) {
  state.pinnedTabId = tab.id;
  syncSideThread();
  const messages = state.sideMessages;
  if (fromInput) { el.input.value = ''; closePopup(); }
  state.sendingInput = null;
  el.trimNote.classList.add('hidden');
  state.sideTurn = true; // the bubbles of this turn get the Side styling
  try {
    addUserBubble(text);
    // chatId null: what open_document opens stays in this snapshot (rememberChatDocs finds no chat to store it on).
    await prepareSnapshot(snap, tab, { docId: state.docId, chatId: null, messages });
    snap.side = true;
    snap.turnLines = await beforeTurnLines('manual', snap);
    const userMsg = { role: 'user', content: text };
    const context = buildTurnContext('manual', snap, lastDocFacts(state.messages));
    if (context) userMsg._context = context;
    messages.push(userMsg);
    const waiting = `Waiting for ${label} (side question)…`;
    setStatus(waiting);
    await toolLoop('manual', snap, abort.signal, { messages, request: { history: messages }, waiting });
    if (abort.signal.aborted) { addNotice('Stopped.'); return 'stopped'; }
    return 'done';
  } catch (e) {
    return reportTurnError(e, abort);
  } finally {
    slimHistory(messages); // later side questions get stubs for the reading results, as the main chat does
    state.sideTurn = false;
    endTurn(tab);
  }
}
