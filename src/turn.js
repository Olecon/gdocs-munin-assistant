'use strict';
// Module turn.js: sending a message and the tool loop: setBusy, sendMessage, runPersonaTurn, runSideTurn (/side),
// executeTool / runToolCall (replace_selection: replaceSelectionCall), toolLoop (the model responses of a turn; the
// tool calls of a round: runRoundCalls; the live bubble: liveAnswer), assistantEntry,
// noteFinish, finishTurn (document facts, history slimming; settleAutoKinds), the wrap-up at the round limit and its Continue
// row (continueFromButton), the nudge (announcesEdit), the one-slot queue of a message typed
// while a turn runs (queueInput, settleQueue), and the agents' reports at the turn boundaries (settleAgentReports,
// sendAgentReports: the automatic report turn; runTurn stores the reports that waited before its message).
/* global $, noteChatAnswered, revertChatModel, refreshCallRow, usableModels, canRequest, accounts, openModelMenu, runAsDue, runAsTag, addAssistantBubble, dropAssistantRound, staleActivityRow, ASK_USER_TOOL, askUser, AUTO_CONTINUE_TEXT, AUTO_CONTINUE_TOOL_TEXT, REPEAT_FAIL_NOTE, REPEAT_FAIL_WRAP_UP_TEXT, CONTINUE_TEXT, NUDGE_MAX_CHARS, NUDGE_TEXT,
   noteSeenLines, remapSeenLines, offersWriteTools, requireToolCall, withoutReplay, WRAP_UP_NOTICE, WRAP_UP_TEXT, WRAP_UP_EDITS_TEXT, WRAP_UP_EDITS_MAX_CHARS, WRAP_UP_CALLS_TEXT, WRAP_UP_CALLS_MAX, WRAP_UP_RESULTS, WRAP_UP_RESULT_CHARS, foldCall, MAX_TOOL_ITERATIONS_API, backgroundCompact, addError, addTurnRow, addChatRow, beginTurnRows, anchorTurnRows, endTurnRows, takeRowsBubble, nextRound, dropTurnOrb, addAutoRow, addUserBubble, apiEditing, apiReplaceSelection,
   applyPendingSelection, applyToDocument, buildRequest, buildTurnContext, canEdit, closeChatMenu, commandUnavailable, MUNIN_ONLY_NOTICE, closeModeMenu, closePopup,
   citationsInRanges, countSearches, createRenderCoordinator, docFacts, docIdFromUrl, holdChatLock, docStatusText, el, extraTool, fetchDocText, fmtNum, gateEdit, getDocTab,
   forgetSideBubbles, syncSideThread, undoingNotice,
   isExtraReading, runTurnHooks, beforeTurnLines, beforeTurnStart, afterWriteNotes, attachOnlyText, hasAttachments, takeAttachments,
   isEditTool, isMainDocRef, ownBlock, isMuninPersona, isReadingTool, logEntry, MAX_TOOL_ITERATIONS, maybeCompact,
   noteSearchActivity, noteTrim, PASTE_AGAIN_CARD, PASTE_AGAIN_TEXT, PASTE_DONE_NOTE, openDocumentTool, parseSlashCommand, parseToolArgs,
   PERSONA_DOC_CHAR_LIMIT, planApiSelection, READING_TOOLS, readingSummary, readingTarget,
   readChatForTurn, readLimits, refreshContext, refreshSelection, rememberTool, renderHistory, renderHistoryKeepingUnstored, renderSources,
   REPLACE_TOOL, resetDocsApiTurn, runCheck, runPolish, readDocumentTool, runReadingTool, runSelfTest, runStream, runWriteTool, saveHistory, scrollToBottom, setStatus, slimHistory,
   REMEMBER_PENDING, snapshotDocument, state, streamPersona, takeSnapshot, toolCardFor, toolsFor, updateAssistantBubble,
   WRITE_TOOLS, namedStylesNote,
   extraRuns, applyTurnMode, sentApplyMode, PLAN_DO_TEXT, renderContextGauge, setApplyMode,
   agentReportsWaiting, takeAgentReports, flushAgentReports, withDocWrite, rereadForAgent, agentStaleError, placeRoundCard, settleRoundCard, placeAnsweredCard, placeAgentCard, placeAgentResultCard, endAssistantBubble */
/* global extraUsesLines, lineDriftError, readAgain, noteRead, forgetStubbedReads, READ_LOOP_REPEATS, READ_LOOP_WRAP_UP_TEXT, toolRequiredFields, writeOps, noteDroppedOps */
/* global errorWords, errorClause, rawError, FAILED_TURN_NOTE, CONTEXT_RETRY_SCALE, CONTEXT_RETRY_ROW */
/* global anthropicSearchRefused, BASIC_SEARCH_ROW, ONE_EDIT_TEXT, anthropicStrictRefused, STRICT_TOOLS_ROW */
/* global keepTurnRequest, keepTurnUsage */
/* exported setBusy, updateActionState, sendMessage, sendAgentReports, executeTool, toolLoop, queueInput, editQueued, discardQueued,
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
  el.action.dataset.tip = label;
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

// Dimmed look for Send when the input is empty and no file is attached (clicking it still just does nothing, as before).
function updateActionState() {
  const empty = !state.busy && !el.input.value.trim() && !hasAttachments();
  el.action.classList.toggle('is-empty', empty);
  el.action.setAttribute('aria-disabled', String(empty));
}

// ---- The queue: one message typed while a turn runs -----------------------------------------------
// state.queued = { text, docId, chatId (the chat it was queued in), mode (the mode it was queued in: startTurn) } or
// null. Enter while busy moves the
// input into it (a second Enter appends after a blank line); sendMessage sends it when the turn finishes
// normally and puts it back into the input box after Stop or an error. Per panel, never stored.
const QUEUE_PREVIEW_CHARS = 80;

function renderQueue() {
  const q = state.queued;
  $('queueRow').classList.toggle('hidden', !q);
  const t = $('queueText');
  const flat = q ? q.text.replace(/\s+/g, ' ') : '';
  t.textContent = flat.length > QUEUE_PREVIEW_CHARS ? flat.slice(0, QUEUE_PREVIEW_CHARS) + '…' : flat;
  t.dataset.tip = q ? q.text : '';
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
  state.queued = q ? { ...q, text: q.text + '\n\n' + text } : { text, docId: state.docId, chatId: state.chatId, mode: state.applyMode };
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
// was painted into it (a failure before the first chunk, Stop, an empty reply). The first chunk of answer text is painted
// at once, not after the throttle interval. The bubble is live (b._live) from its first paint to the end of the turn.
// turn: { bubble } shared by the rounds of one turn (toolLoop): the turn is ONE bubble, each round a new round of it
// (startAssistantRound); discard() then drops only this round. Without it (a persona turn) the view has its own bubble.
// The thinking clock: from the first reasoning chunk to the first answer chunk or tool call (noteOutput), or to the end
// of the stream (thoughtMs()): the Thinking label's "Thought for Ns", stored as _thoughtMs.
// live.calling: the name of the newest tool call the stream is writing (the status line's kind word, streamHooks);
// live.last: what the stream delivered last ('reasoning' | 'activity' | 'call' | 'text'), which the status line follows.
function liveAnswer(turn = null) {
  const view = { bubble: null, live: { text: '', reasoning: '', activity: [], thoughtMs: 0, calling: '', last: null }, filled: false, texted: false, thinkStart: null, thinkEnd: null };
  view.painter = createRenderCoordinator((s) => {
    view.ensureBubble();
    updateAssistantBubble(view.bubble, { text: s.text, reasoning: s.reasoning, activity: s.activity, streaming: true, last: s.last, thoughtMs: s.thoughtMs, calling: s.calling });
    scrollToBottom(false);
  });
  view.schedule = () => {
    view.filled = true;
    view.painter.update(view.live);
    if (view.live.text && !view.texted) { view.texted = true; view.painter.flush(); }
  };
  view.ensureBubble = () => {
    if (view.bubble) return view.bubble;
    if (turn && turn.bubble && turn.bubble.isConnected) {
      nextRound(turn.bubble);
      view.bubble = turn.bubble;
    } else {
      // A bubble that holds only this turn's rows so far (the document read through the export, a model revert): the
      // answer goes on in it.
      view.bubble = takeRowsBubble() || addAssistantBubble();
      view.bubble._live = true; // until the turn ends: renderHistory draws it again, or endAssistantBubble (/side)
      if (turn) turn.bubble = view.bubble;
    }
    return view.bubble;
  };
  view.start = () => { view.painter.update(view.live); return view; }; // the next frame paints it; not filled
  view.discard = () => {
    if (!view.bubble || view.filled) return;
    if (!dropAssistantRound(view.bubble)) {
      view.bubble.remove();
      if (turn && turn.bubble === view.bubble) turn.bubble = null;
    }
    view.bubble = null;
  };
  view.noteReasoning = () => { if (view.thinkStart == null) view.thinkStart = thinkNow(); };
  view.noteOutput = () => {
    if (view.thinkStart == null || view.thinkEnd != null) return;
    view.thinkEnd = thinkNow();
    view.live.thoughtMs = Math.max(1, view.thinkEnd - view.thinkStart);
  };
  view.thoughtMs = () => (view.thinkStart == null ? 0 : Math.max(1, (view.thinkEnd != null ? view.thinkEnd : thinkNow()) - view.thinkStart));
  return view;
}
// The thinking clock's time (a function, so tests can replace it).
function thinkNow() { return Date.now(); }

// Munin persona turn (/research, /code, /chat): one persona request, chat-only answer with
// server-side tool activity. io: { sent(req), sentUsage(usage) } as in toolLoop.
async function runPersonaTurn(persona, snap, signal, io = {}) {
  const view = liveAnswer().start();
  const { live, painter, schedule } = view;
  const hooks = {
    onReasoning(r) { view.noteReasoning(); live.reasoning = r; live.last = 'reasoning'; schedule(); },
    onContent(c) { view.noteOutput(); live.text = c; live.last = 'text'; schedule(); },
    onActivity(list) {
      live.activity = list.slice();
      live.last = 'activity';
      setStatus(`${snap.prov.label} /${persona} is working… (${list.length} tool call${list.length === 1 ? '' : 's'})`);
      schedule();
    },
  };

  const req = buildRequest(persona, snap);
  noteTrim(req);
  if (io.sent) io.sent(req);
  let result;
  try {
    result = await streamPersona(req, signal, snap, hooks);
    if (io.sentUsage) io.sentUsage(result.usage);
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
  result.thoughtMs = view.thoughtMs();
  state.messages.push(assistantEntry(result, false));
  if (result.finishReason === 'length') addTurnRow('The reply was cut off by the length limit.');
}

// Executes one tool call. Returns the history entry for the "tool" message (content goes to the
// model; "_" fields are for the UI only: _ok, _message, _detail, _reading, _edit, and for gated
// open_document calls and gated edits _decision ('accepted' | 'accepted-all' | 'rejected' | 'stopped'), and _answered:
// the decision cards the call showed, in their answered state (gate.js answerCard)).
// ui: { card } set to the call's permission card when it shows one (open_document, the edit gate), for the caller to
// remove or replace.
// snap.tainted (the turn snapshot, so it starts unset every turn): set once an opened document was read
// in this turn (snap.docCache holds what open_document and reads with "doc" loaded) or web search
// results arrived; the edit gate (gateEdit) then asks before remember and before the writes the panel cannot undo, and
// its cards say why.
async function executeTool(tc, mode, snap, ui = {}) {
  const textBefore = snap.docText; // a write replaces it: the read-first line numbers follow (remapSeenLines)
  // The operations of a write, for the note on operations a retry left out (docs-write.js noteDroppedOps); line numbers
  // address the document as this response found it (snap.responseModel: before its first write).
  if (!snap.responseWrite) snap.responseModel = snap.model;
  const ops = writeOps(tc.function.name, parseToolArgs(tc).args, snap.responseModel || snap.model);
  const r = await runToolCallSafe(tc, mode, snap, ui);
  await namedStylesNote(tc.function.name, r, snap, ui.args); // named-styles.js: a note when the document styles differ from the sheet
  remapSeenLines(snap, textBefore);
  noteSeenLines(tc.function.name, ui.args, r, snap); // for the read-first check (gate.js)
  if (ui.decision) r._decision = ui.decision;
  if (ui.answered && ui.answered.length) r._answered = ui.answered; // the decided cards, drawn again from the history
  if (ui.waitedMs > 0) snap.userWaitMs = (snap.userWaitMs || 0) + ui.waitedMs; // not the turn's working time
  // The afterWrite hooks (registry.js) look at the written text in place: their notes join the beforeWrite ones.
  if (r._ok && r._edit && !isReadingTool(tc)) {
    const after = await afterWriteNotes(tc.function.name, ui.args, r, snap, mode);
    if (after.length) ui.notes = (ui.notes || []).concat(after);
  }
  appendCheckNotes(r, tc.function.name, ui);
  noteDroppedOps(tc.function.name, ops, r, snap, ui.decision === 'rejected' || ui.decision === 'stopped');
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

// A throw inside a tool (a storage quota error, a failed fetch outside the tools' own catches) becomes the call's result:
// the round's assistant message keeps a result for every tool call, so the history stays valid (no repair in the agent
// and self-test loops) and the model can react.
async function runToolCallSafe(tc, mode, snap, ui) {
  try {
    return await runToolCall(tc, mode, snap, ui);
  } catch (e) {
    const cancelled = (snap.signal && snap.signal.aborted) || (e && e.name === 'AbortError');
    const msg = errorClause(e); // plain words; the raw text for the chat log
    return cancelled
      ? { role: 'tool', tool_call_id: tc.id, content: 'Error: cancelled by the user.', _ok: false, _message: 'Cancelled by the user' }
      : { role: 'tool', tool_call_id: tc.id, content: `Error: ${msg}. The call was not completed: try it once more, or tell the user what failed.`, _ok: false, _message: 'Tool failed: ' + msg, _rawError: rawError(e) };
  }
}

async function runToolCall(tc, mode, snap, ui) {
  const base = { role: 'tool', tool_call_id: tc.id };
  const name = tc.function.name;
  const { args, error, repaired } = parseToolArgs(tc);
  if (error !== null) {
    const fields = toolRequiredFields(name);
    return { ...base, content: `Error: the arguments of ${name} are not a valid JSON object. Send one JSON object${fields.length ? ` with the fields ${fields.join(', ')}` : ''}.`, _ok: false, _message: 'Invalid tool arguments' };
  }
  if (repaired) tc.function.arguments = JSON.stringify(args); // the history keeps JSON a server parses (request.js apiMessage)
  ui.args = args; // for the beforeWrite checks of gateEdit
  if (name === 'open_document') {
    return { ...base, ...(await openDocumentTool(args, snap, ui)), _reading: true };
  }
  if (READING_TOOLS.includes(name)) {
    const { target, error: refused } = await readingTarget(name, args, snap);
    // The model's identical read of an unchanged main document (tools.js readAgain; visible main-chat turns only): a
    // pointer, its repeat number in _again (runRoundCalls ends a loop; the wrap-up's calls list skips the pointer).
    const repeats = !refused && target === snap && !!snap.readFirst;
    const again = repeats ? readAgain(name, args, snap) : null;
    const content = refused || (again && again.text) || (name === 'read_document' ? await readDocumentTool(args, target, snap, readLimits(snap.prov)) : runReadingTool(name, args, target, readLimits(snap.prov)));
    if (repeats && !again && !content.startsWith('Error:')) noteRead(name, args, snap, '', tc.id);
    return { ...base, content, _ok: !content.startsWith('Error:'), _reading: true, _message: readingSummary(name, args), ...(again ? { _again: again.repeats } : {}) };
  }
  // Not a document edit: no responseWrite; journaled (kind 'remember') so an undo takes it back with the document
  // edits; the gate asks only in a tainted turn. It changes the next turns' instructions only.
  if (name === 'remember') {
    // A side question (/side) leaves nothing behind, the document instructions included.
    if (snap.side) return { ...base, content: 'Error: remember is not available in a side question. Tell the user to ask for it in the main chat.', _ok: false, _message: 'Not available in a side question' };
    if (mode === 'plan') return { ...base, content: 'Error: remember is not available in Plan mode. Put it in the plan as a step instead.', _ok: false, _message: 'Not available in Plan mode' };
    if (snap.agent && snap.agent.access === 'read') return { ...base, content: 'Error: remember is not available to a read-only agent. Put it in your report.', _ok: false, _message: 'Not available to a read-only agent' };
    const r = await rememberTool(args, snap, ui);
    if (r && r._edit) r._edit.id = tc.id; // its journal entry (undone like a document edit)
    return { ...base, ...r };
  }
  // ask_user (registered in tools.js): reads and writes nothing, so every turn with client tools may call it (Plan and
  // side questions included); runExtraTool would refuse it outside an editing turn as a writing tool.
  if (name === ASK_USER_TOOL.function.name) {
    // Not offered to an agent (agents.js); a call anyway gets the way out its preface names.
    if (snap.agent) return { ...base, content: 'Error: ask_user is not available to an agent. End your report with "Blocked: <question>"; the main assistant asks the user.', _ok: false, _message: 'Not available to an agent' };
    return { ...base, ...(await askUser(args, snap, ui)) };
  }
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
      return { ...base, content: `Error: ${errorWords(e)}`, _ok: false, _message: 'Edit failed: ' + errorClause(e), _rawError: rawError(e) };
    }
  }
  // An agent runs in the background: the tab it would paste into may show another document by now.
  if (snap.agent && !apiEditing(mode, snap)) return { ...base, content: 'Error: an agent cannot paste into the document. Put the text in your report; the main assistant applies it.', _ok: false, _message: 'Not available to an agent' };
  return { ...base, ...(await withDocWrite(docIdOf(snap), () => replaceSelectionCall(name, args, mode, snap, ui, tc.id))) };
}
const docIdOf = (snap) => (snap.model && snap.model.docId) || state.docId;

// replace_selection: through the Docs API when the selection can be found exactly once, otherwise pasted. Returns
// the tool message fields.
async function replaceSelectionCall(name, args, mode, snap, ui, id) {
  if (typeof args.text !== 'string') {
    return { content: 'Error: invalid arguments. Expected an object {"text": string}.', _ok: false, _message: 'Invalid tool arguments' };
  }
  // One paste per turn: the snapshot predates the paste, so the model cannot see it and a second call would
  // paste the text again, or find the selection in the old snapshot and edit the pasted text through the API. Refused
  // before the gate, without touching the document.
  const pasteAgain = { content: PASTE_AGAIN_TEXT, _ok: false, _message: PASTE_AGAIN_CARD, _cardLabel: 'Text (not pasted)', _pasteRefused: true };
  if (snap.pasteDone) return pasteAgain;
  // Through the API when the selection can be found exactly once; otherwise pasted as before.
  let plan = null;
  if (apiEditing(mode, snap)) { try { plan = planApiSelection(args.text, snap); } catch (e) { plan = null; } }
  // The citation guard of runWriteTool, for this tool's API path too (docs-write.js sets plan.removed).
  // The paste path is not checked: it replaces the selection the user made themselves.
  if (plan && plan.removed) { try { plan.citations = await citationsInRanges(snap.model, plan.removed); } catch (e) { plan.citations = []; } }
  // A pasted replacement has no API plan: the card shows the selection's new text whole (cardOld / cardNew).
  const selected = snap.selection || '';
  const refused = await gateEdit(name, plan || { journal: { restore: selected }, cardOld: selected, cardNew: args.text }, snap, ui);
  if (refused) return refused;
  if (plan) {
    let viaApi = null;
    try { viaApi = await apiReplaceSelection(plan, snap, id); } catch (e) { viaApi = null; }
    if (viaApi) return viaApi;
  }
  // expected: the selection the model saw; the content script does not paste when it changed meanwhile.
  const res = await applyToDocument(args.text, snap.selection || '');
  if (res.ok) { // how it was pasted goes to the tool card (_detail); the model gets PASTE_DONE_NOTE
    // Confirmed or not (verified false: Docs does not confirm synthetic pastes), the model's reading tools
    // show the snapshot from before the paste: the note tells it not to re-read to verify or paste again.
    snap.pasteDone = true;
    const out = { content: PASTE_DONE_NOTE, _ok: true, _message: res.message || 'Replaced in document' };
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

// Why a writing call cannot run, as the tool message fields, or null: editing needs an editing turn (Manual or Auto; not
// Plan, /side, a read agent or a persona turn), and opened documents are read-only (the schemas have no "doc"; a lenient
// server may still send it).
function editRefusal(name, args, mode) {
  if (!canEdit(mode)) {
    const how = mode === 'plan' ? 'Plan mode: add it as a step of the plan.' : 'Put the complete resulting text in your answer.';
    return { content: `Error: the document cannot be modified here. ${how}`, _ok: false, _message: 'Editing is not available here' };
  }
  if (!isMainDocRef(args.doc)) {
    return { content: `Error: ${name} edits only the main document; documents opened with open_document are read-only. Call it again without doc.`, _ok: false, _message: 'Opened documents are read-only' };
  }
  return null;
}

// A call of a tool added with registerTools (src/registry.js). Not offered in this turn: a writing call outside an
// editing turn gets the mode's refusal (its way forward), any other the plain way out. Reading calls: _reading, the
// action-log summary as _message. Writing calls: an editing turn (Manual or Auto) and the main document only, like the
// built-in writing tools; a thrown error becomes an "Error:" result.
async function runExtraTool(extra, name, args, mode, snap, ui, id) {
  const reading = isExtraReading(name, args);
  if (!extraRuns(extra, mode, snap)) {
    const why = reading || extra.anyMode ? null : editRefusal(name, args, mode);
    return why || { content: `Error: ${name} is not offered now; use the tools you were given.`, _ok: false, _message: `${name} is not available` };
  }
  // spec.anyMode: a tool that is not a reading tool (its result is kept after the turn) but runs in every mode
  // (delegate: the agent's own writes go through the usual refusals and the gate).
  const refusal = reading || extra.anyMode ? null : editRefusal(name, args, mode);
  if (refusal) return refusal;
  // Its line numbers predate an edit made earlier in this response (spec.usesLines).
  if (!reading && snap.responseWrite && snap.model && extraUsesLines(name, args)) return lineDriftError(name, snap);
  let r;
  // A registered writing tool takes the document write lock (docs-write.js withDocWrite); an agent's call plans on the
  // document as it is now and is refused once when another edit landed since its read (its arguments may be stale).
  const run = () => extra.run(name, args, snap, ui, { id, mode });
  const locked = () => withDocWrite(docIdOf(snap), async () => (snap.agent && (await rereadForAgent(snap)) ? agentStaleError(name, snap) : run()));
  try { r = await (reading || extra.anyMode ? run() : locked()); } catch (e) {
    return { content: `Error: ${e.message}`, _ok: false, _message: `${name} failed: ${e.message}`, ...(reading ? { _reading: true } : {}) };
  }
  const fields = typeof r === 'string' ? { content: r, _ok: !r.startsWith('Error:') } : { ...r };
  if (!reading) return fields;
  return { _message: extra.summary ? extra.summary(name, args) : '', ...fields, _reading: true };
}

// Some servers reuse one tool-call id in every response (or send none): everything keyed by the id (results, the
// undo journal, cards, the chat log, the provider's call/result pairing) would mix the calls up. Before the round's
// calls are stored, an id that is empty or already used in the history (any turn) or earlier in this response becomes
// "<id>_<n>" (the smallest free n); the provider's replay items (OpenAI call_id, Anthropic tool_use id) follow, so
// the replayed call still matches its result.
function uniqueCallIds(result, messages) {
  const used = new Set();
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'tool' && m.tool_call_id) used.add(m.tool_call_id);
    for (const tc of m.tool_calls || []) if (tc && tc.id) used.add(tc.id);
  }
  const seen = new Map(); // an old id -> how many calls of this response carried it so far (its n-th replay item)
  for (const tc of result.toolCalls) {
    const old = tc.id || '';
    const nth = seen.get(old) || 0;
    seen.set(old, nth + 1);
    if (old && !used.has(old)) { used.add(old); continue; }
    let n = 2;
    while (used.has(`${old || 'call'}_${n}`)) n++;
    tc.id = `${old || 'call'}_${n}`;
    used.add(tc.id);
    renameReplayCall(result.raw, old, nth, tc.id);
  }
}
// The nth replay item of a client tool call with the id old gets the id id (no item: nothing to rename).
function renameReplayCall(raw, old, nth, id) {
  if (!raw || !Array.isArray(raw.items)) return;
  const key = raw.key === '_anthropicBlocks' ? 'id' : 'call_id';
  const type = raw.key === '_anthropicBlocks' ? 'tool_use' : 'function_call';
  const hits = raw.items.filter((it) => it && it.type === type && (it[key] || '') === old);
  if (hits[nth]) hits[nth][key] = id;
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
  if (result.thoughtMs > 0) m._thoughtMs = Math.round(result.thoughtMs); // the Thinking label after a reload
  return m;
}

const sameModel = (a, b) => String(a).startsWith(String(b)) || String(b).startsWith(String(a));

// Rows of the turn about how its final reply ended (anything other than a normal stop); a refusal is an error.
function noteFinish(result, snap) {
  const r = result.finishReason;
  if (r === 'length') {
    addTurnRow(result.toolCalls.length
      ? 'The reply hit the length limit before the tool call was complete, so nothing was changed. Ask for a smaller part of the text.'
      : 'The reply was cut off by the length limit.');
  } else if (r === 'refusal') {
    const cat = result.stopDetails && result.stopDetails.category;
    addError(`${snap.prov.label} declined this request (safety classifier${cat ? ': ' + cat : ''}). Nothing was changed.`);
  } else if (r && r !== 'stop' && r !== 'tool_calls') {
    addTurnRow(`The reply ended early (${r}).`);
  }
  if (snap.prov.id === 'anthropic' && result.servedBy && !sameModel(result.servedBy, snap.cfg.model)) {
    addTurnRow(`Answered by ${result.servedBy}: the requested model declined the request and the API fell back to another Claude model.`);
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
    if (m.role !== 'user' || !m._auto || !m._autoKind || m._autoKind === 'agent-report') continue; // a report stays: it is data
    const next = messages[i + 1];
    if (m._autoKind === 'wrap-up' && next && next.role === 'assistant') next._wrapUp = true;
    messages.splice(i, 1);
  }
}

// Continue: CONTINUE_TEXT as a normal message of this chat, once (the row goes), through the Send path (the chat lock),
// in the mode the turn it continues was sent with (its user message: sentApplyMode; else the mode button's); while a turn
// runs it is queued like a message typed then.
function continueFromButton(btn) {
  if (btn) {
    if (btn.disabled) return Promise.resolve();
    btn.disabled = true;
    const row = btn.closest('.note-stage'); // the wrap-up row (its stored text comes back without the button)
    if (row) row.remove();
  }
  const last = [...state.messages].reverse().find((m) => m && m.role === 'user' && !m._auto);
  const q = { text: CONTINUE_TEXT, docId: state.docId, chatId: state.chatId, mode: sentApplyMode(last) || state.applyMode };
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

// Do it under the latest Plan answer: the mode becomes Auto (stored, as a pick in the mode menu) and
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
  await afterTurn(outcome);
}

// After a turn (sendMessage, sendAgentReports): the queued message first (its turn takes the agents' reports that
// waited, and compacts at its start); else the reports that arrived during the turn; else the background compaction
// (not after a failure: the request would fail too).
async function afterTurn(outcome) {
  const next = settleQueue(outcome);
  if (next) { await sendMessage(next); return; }
  if (await settleAgentReports(outcome)) return;
  if (outcome === 'done' || outcome === 'stopped') backgroundCompact();
}

// ---- Agents' reports (agents.js) ------------------------------------------------------------------------------
// A report that arrived while a turn ran in its chat waited (agentReportsWaiting); it goes into the next turn of the
// chat. After a normal finish that is an automatic continuation turn of its own; after Stop or a failure the reports are
// only stored in the chat (flushAgentReports), so the next message carries them without a request now.
async function settleAgentReports(outcome) {
  if (state.busy || !agentReportsWaiting(state.docId, state.chatId)) return false;
  if (outcome === 'done') { await sendAgentReports(); return true; }
  await flushAgentReports(state.docId, state.chatId);
  return false;
}
// The continuation turn of the open chat with the waiting reports as its message (_auto, _autoKind 'agent-report'):
// the main model reads them and answers. Through startTurn like a typed message (the chat lock, the mode button, the
// chat's model); when it cannot start (no key, an undo running, another document) the reports are stored instead.
async function sendAgentReports() {
  if (state.busy) return; // the running turn takes them, or settles them when it ends
  const { docId, chatId } = state;
  const outcome = await startTurn({ agentReports: true, text: '', docId, chatId });
  if (outcome === 'idle' || outcome === 'bail') {
    if (!state.busy) await flushAgentReports(docId, chatId);
    return;
  }
  await afterTurn(outcome);
}

// Returns 'idle' (nothing started), 'bail' (stopped or failed before the turn began), 'selftest', or
// runTurn's 'done' / 'stopped' / 'failed'.
async function startTurn(fromQueue) {
  if (state.busy) return 'idle';
  if (state.undoing) { setStatus(undoingNotice(), true); addError(undoingNotice()); return 'idle'; }
  // The agents' reports (sendAgentReports): no text of the user, the reports are the turn's message.
  const reports = !!(fromQueue && fromQueue.agentReports);
  if (reports && (fromQueue.docId !== state.docId || fromQueue.chatId !== state.chatId || !agentReportsWaiting(state.docId, state.chatId))) return 'idle';
  // A leading /research, /code or /chat gives this turn a persona (with Munin: its own pipeline).
  const { persona, text: typed, selftest, side, check, polish } = reports ? {} : parseSlashCommand(fromQueue ? fromQueue.text : el.input.value);
  // Files attached with an empty message are sent as "Attached <names>", so they enter the chat (attachments.js).
  const text = reports ? '' : typed || (!persona && !side && !selftest && !check && !polish ? attachOnlyText() : '');
  // /test: the panel's self-test, /check: the pre-submission report, /polish: the prose fixes, handled here (not turns:
  // no chat history; see runSelfTest, runCheck, runPolish).
  if (selftest || check || polish) {
    const draft = el.input.value;
    const run = check ? runCheck() : polish ? runPolish(typed) : runSelfTest(); // empties the input box before its first await…
    if (fromQueue) el.input.value = draft; // …which holds the user's draft, not the queued /test
    await run;
    return 'selftest';
  }
  // /code needs Munin: with another provider the message stays in the input box (commandUnavailable).
  if (persona && commandUnavailable(persona)) { addError(MUNIN_ONLY_NOTICE(persona)); return 'idle'; }
  if (!text && !reports) {
    if (side) addError('Write your question after /side, for example: /side what does this term mean?');
    else if (persona) { setStatus('Type a message after the command', true); addError(`Type a message after /${persona}.`); }
    return 'idle';
  }
  // Default turns follow the mode the message was sent with (a queued message and Continue carry theirs; else the mode
  // button, disabled while busy): Manual and Auto edit ('edit'; Manual asks before each write: snap.askEdits), Plan plans.
  // /side is the read-only chat turn 'manual'.
  const applyMode = fromQueue && fromQueue.mode ? fromQueue.mode : state.applyMode;
  const mode = side ? 'manual' : persona || applyTurnMode(applyMode);
  // Provider, its settings and the document mode are frozen for the whole turn (see takeSnapshot).
  const snap = takeSnapshot();
  snap.askEdits = mode === 'edit' && applyMode === 'manual';
  const label = snap.cfg.name || snap.prov.label;
  // No account: none configured yet, or the chat's account was removed (the model menu opens to pick another).
  if (!snap.cfg.accountId) {
    if (!accounts().length) addError('Add a provider and its API key in the settings first.', true);
    else { addError('Choose a model for this chat first.'); openModelMenu(); }
    return 'idle';
  }
  if (snap.prov.needsUrl && !snap.cfg.baseUrl) {
    addError(`No server URL set for ${snap.cfg.name || label}: add it in the settings.`, true);
    return 'idle';
  }
  if (!canRequest(snap.cfg)) {
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
  if (abort.signal.aborted) { bail(); addChatRow(STOPPED_KEPT); return 'bail'; } // the message is still in the input box
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
    if (abort.signal.aborted) addChatRow(STOPPED_KEPT);
    else addError(`Could not wait for another tab: ${e.message || e}. Send the message again.`);
    return 'bail';
  }
  try {
    const exists = await readChatForTurn(docId, chatId);
    // registerTurnHook('beforeStart'): before the turn reads the document; Stop there is handled just below.
    if (exists && !abort.signal.aborted && !reports) await beforeTurnStart({ mode, text, persona, snap, signal: abort.signal });
    if (!exists || abort.signal.aborted) { // deleted in another tab meanwhile: the panel switches away
      bail(); setStatus(docStatusText(), state.docText == null);
      if (exists) addChatRow(STOPPED_KEPT);
      return 'bail';
    }
    return await runTurn({ persona, text, mode, snap, label, abort, tab, fromInput: !fromQueue, reports });
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
//   edit and every round (runTurn: saveHistory), quiet: no bubbles, cards, rows or trimming note (snap.quiet: the self-test),
//   silent: no bubbles, rows or trimming note but the cards of the main turn (an agent: agents.js), request:
//   extra buildRequest options (the self-test's history), status(text) (default setStatus), waiting: the status
//   between rounds, maxRounds: the round limit (default MAX_TOOL_ITERATIONS), tokenBudget: prompt + completion
//   tokens over the rounds after which a round that wants tools gets the wrap-up instead (0: none), wrapUp: whether
//   timeUp(): true once the loop's time is up (agents.js: its wall-clock limit), which a round that wants tools treats
//   like the token budget, wrapUp: whether the limits end with the wrap-up (default: visible main-chat turns), wrapUpText
//   (default WRAP_UP_TEXT), turn: { bubble }, the turn's bubble as the loop makes it (runSideTurn ends it), sent(req) and
//   sentUsage(usage): the first round's request (each build of it: a resend too) and its usage (runTurn keeps them for the
//   fuller chat log, chat-log.js keepTurnRequest) }.
// The panel's own user-role requests (_auto, appended like any other message so the cached prefix stays valid): one
// continuation after a length cut (AUTO_CONTINUE_TEXT); in visible main-chat turns (not quiet, not /side) the wrap-up
// at the round limit (WRAP_UP_TEXT, _autoKind 'wrap-up': one more request without tools, whose answer ends the turn)
// and, in an editing turn, one nudge after a reply that announced an edit without calling a tool (NUDGE_TEXT,
// _autoKind 'nudge'; that request asks for a tool call where the provider supports it: requireToolCall). finishTurn
// removes the wrap-up and nudge requests once the turn is over (settleAutoKinds).
// Returns { replaced (an edit or paste succeeded), rounds (responses), tools (names of the executed calls,
//   in order), usage ({prompt_tokens, completion_tokens} summed, or null), final (the last response),
//   limit (the round limit or the token budget was reached), budget (it was the token budget or timeUp), wrapUp (the wrap-up answer ended the turn), nudged (the nudge round ran),
//   continued (automatic continuations after a length cut: 0 or 1), repeatFailed (a call failed the 3rd time with the
//   same arguments: the wrap-up followed), readLoop (an identical read of an unchanged document was repeated
//   READ_LOOP_REPEATS times: the wrap-up followed) }.
//   Throws on a stream error or Stop (AbortError), with the partial answer already in io.messages.
async function toolLoop(mode, snap, signal, io) {
  const { messages } = io;
  const turnStart = messages.length; // what the loop appends is this turn's (its edits for the wrap-up)
  const quiet = !!io.quiet || !!io.silent; // silent: no bubble, rows or trimming note, but cards as in the main turn
  const save = io.save || (async () => {});
  const status = io.status || setStatus;
  const out = { replaced: false, rounds: 0, tools: [], usage: null, final: null, limit: false, budget: false, wrapUp: false, nudged: false, continued: 0 };
  if (io.quiet) snap.quiet = true; // nobody to answer an ask_user card (askUser refuses), no access card
  const loud = !quiet && !snap.side; // the wrap-up and the nudge: visible main-chat turns only
  if (loud) snap.readFirst = true; // the read-first check of gate.js applies to the model's writes here
  const maxRounds = io.maxRounds || MAX_TOOL_ITERATIONS;
  const wrapUpOn = io.wrapUp != null ? !!io.wrapUp : loud;
  const overBudget = () => (io.tokenBudget > 0 && !!out.usage && out.usage.prompt_tokens + out.usage.completion_tokens >= io.tokenBudget) ||
    (typeof io.timeUp === 'function' && !!io.timeUp());
  const nextRound = async () => { await save(); if (io.waiting) status(io.waiting); };
  let kind = null; // the panel's request before this round: 'wrap-up' | 'nudge' | null
  // The turn's one bubble: each round is a round of it (liveAnswer). io.turn: the caller's, so it can end the bubble
  // whatever way the loop ends (runSideTurn).
  const turn = io.turn || { bubble: null };
  for (let round = 0; round <= maxRounds || kind === 'wrap-up'; round++) {
    let view = liveAnswer(turn);
    if (!quiet) view.start(); // the orb while the first token is awaited
    // "edit" (Manual or Auto), "manual", "plan" or a persona (non-Munin providers). The wrap-up request has no tools, and
    // the turn's rounds go without their replay payloads (no reasoning item or thinking block without its call).
    // After a switch of the chat's model in this loop (models, src/accounts.js: snap.replayCut), the rounds before it go
    // without their replay payloads (they belong to the other provider).
    const opts = kind === 'wrap-up' ? { ...(io.request || {}), noTools: true, history: wrapUpHistory(messages, turnStart) }
      : snap.replayCut ? { ...(io.request || {}), history: withoutReplay(messages, snap.replayCut) } : io.request || {};
    const request = (extra = null) => {
      const r = buildRequest(mode, snap, extra ? { ...opts, ...extra } : opts);
      // A reading result this request carries only as a stub may be read again in full (tools.js readAgain).
      if (r.stubbed) forgetStubbedReads(snap, r.history);
      if (kind === 'nudge') requireToolCall(r);
      if (!quiet) noteTrim(r);
      if (round === 0 && io.sent) io.sent(r); // the turn's first request (each build of it), for the fuller chat log
      return r;
    };
    let req = request();
    let result;
    let shrunk = false; // this round was already resent with less context
    for (;;) {
      try {
        result = await runStream(req, signal, snap, quiet ? {} : streamHooks(view, snap));
        break;
      } catch (e) {
        // A pending frame would otherwise add a stale "typing" bubble after renderHistory().
        view.painter.cancel();
        view.discard(); // failed or stopped before the first chunk: no empty bubble stays
        // The API refused the strict tool schemas (a limit across them, a schema feature, a model or setting without strict
        // mode): the request is built again with every tool compact and not strict, which this account's model keeps for
        // the session. First: such a message may also read like a request too long ("exceeds the maximum").
        if (!e.partial && !signal.aborted && anthropicStrictRefused(e, req, snap)) {
          if (!quiet) addTurnRow(STRICT_TOOLS_ROW);
          view = liveAnswer(turn);
          if (!quiet) view.start();
          req = request();
          continue;
        }
        // The server counted more tokens than chars/3 estimated: the same round once more with a smaller budget for the
        // rest of the turn and the turn's reading results stubbed (the model can re-read). A second refusal keeps the error.
        if (e.contextLength && !e.partial && !shrunk && !signal.aborted) {
          shrunk = true;
          snap.budgetScale = CONTEXT_RETRY_SCALE; // (the stubbed results may be read again: request() forgets their reads)
          if (!quiet) addTurnRow(CONTEXT_RETRY_ROW);
          view = liveAnswer(turn);
          if (!quiet) view.start();
          req = request({ stubAll: true });
          continue;
        }
        // The API refused programmatic tool calling next to the filtering web search (a field or tool it cannot take
        // with it): the request is built again with the basic search, which this account's model keeps for the session.
        if (!e.partial && !signal.aborted && anthropicSearchRefused(e, req, snap)) {
          if (!quiet) addTurnRow(BASIC_SEARCH_ROW);
          view = liveAnswer(turn);
          if (!quiet) view.start();
          req = request();
          continue;
        }
        // A changed model that does not answer: the chat goes back to the last one that did, and asks it (once a turn).
        const reverted = !signal.aborted && await revertChatModel(e, mode, snap, messages);
        if (reverted) {
          if (reverted.call && !quiet) refreshCallRow(turn.bubble, reverted.call, messages); // its switch row now reads failed
          view = liveAnswer(turn);
          if (!quiet) view.start();
          req = request();
          continue;
        }
        // Keep partial text/reasoning for display; unfinished tool calls are dropped.
        const p = e.partial;
        if (p) p.thoughtMs = view.thoughtMs();
        if (p && (p.content.trim() || p.reasoning)) messages.push(assistantEntry(p, false));
        if (p && (p.content || p.reasoning || (p.toolCalls || []).length)) await noteChatAnswered(snap); // it answered, then broke off
        if (p) out.final = p;
        e.loop = out; // what ran before the failure (the self-test reports it)
        throw e;
      }
    }
    await noteChatAnswered(snap);
    // The streamed state is painted into the bubble now; a bubble nothing was streamed into gets the result
    // below, or goes when there is nothing to show.
    if (view.filled) view.painter.flush();
    view.painter.cancel();
    result.thoughtMs = view.thoughtMs();
    out.rounds++;
    out.final = result;
    addUsage(out, result.usage);
    if (round === 0 && io.sentUsage) io.sentUsage(result.usage);
    const serverActivity = result.activity || [];
    snap.searchesDone = (snap.searchesDone || 0) + countSearches(serverActivity);
    if (serverActivity.length) snap.tainted = true; // web search results (see executeTool)
    // Tool calls are executed only when the request offered tools (a request without tools never
    // touches the document or the clipboard, even if the server returned a call anyway). Every turn
    // with tools can read; only an editing turn (Manual or Auto) can edit (executeTool refuses otherwise). Not after a
    // refusal: it can cut a call off.
    const wantsTools = req.tools.length > 0 && result.toolCalls.length > 0 && result.finishReason !== 'length' && result.finishReason !== 'refusal';
    if (!quiet) {
      // A round kept for the action log only: not for a round whose only call is delegate (its block stands alone).
      if (result.content || result.reasoning || serverActivity.length || view.filled || (view.bubble && wantsTools &&result.toolCalls.some((tc) => !ownBlock(tc.function.name)))) {
        updateAssistantBubble(view.ensureBubble(), { text: result.content, reasoning: result.reasoning, usage: result.usage, activity: serverActivity, thoughtMs: result.thoughtMs });
        // The round's own sources (its web search's citations), in its item on the rail.
        if (Array.isArray(result.sources) && result.sources.length) renderSources(view.bubble, result.sources);
      } else view.discard();
    }
    if (kind === 'wrap-up') { // its answer ends the turn
      messages.push(assistantEntry(result, false));
      out.wrapUp = true;
      if (!quiet) noteFinish(result, snap);
      break;
    }
    kind = null;

    const spent = wantsTools && round < maxRounds && overBudget();
    if (wantsTools && (round === maxRounds || spent)) {
      // The calls of this response are not executed, so they are not kept: no call without its result.
      messages.push(assistantEntry(result, false));
      out.limit = true;
      out.budget = spent;
      if (wrapUpOn && !signal.aborted) {
        messages.push({ role: 'user', content: wrapUpContent(io.wrapUpText || WRAP_UP_TEXT, messages.slice(turnStart)), _auto: true, _autoKind: 'wrap-up' });
        kind = 'wrap-up';
        await nextRound();
        continue;
      }
      if (!quiet) addTurnRow(spent ? 'Stopped: the token budget of this answer is used up.' : `Stopped after ${maxRounds} tool rounds in a row.`);
      break;
    }
    if (wantsTools) {
      uniqueCallIds(result, messages);
      messages.push(assistantEntry(result, true));
      const callsFrom = messages.length;
      await runRoundCalls(result, { mode, snap, signal, io, out, view, save, status, oneWrite: req.kind === 'anthropic' });
      // The third identical failure of a call, or a read loop: the wrap-up, instead of a fourth try.
      const repeatedFailure = (out.repeatFailed || out.readLoop) && wrapUpOn && !signal.aborted;
      // Links a client tool found (search: _sources on its result) join the Sources of this round, where it ran.
      if (!quiet) {
        for (const m of messages.slice(callsFrom)) if (m.role === 'tool' && Array.isArray(m._sources) && m._sources.length) renderSources(view.bubble, m._sources);
      }
      if (snap.switched) { snap.switched = false; snap.replayCut = messages.length; } // models switched the chat's model
      await save();
      if (signal.aborted) break;
      if (repeatedFailure) {
        messages.push({ role: 'user', content: wrapUpContent(out.repeatFailed ? REPEAT_FAIL_WRAP_UP_TEXT : READ_LOOP_WRAP_UP_TEXT, messages.slice(turnStart)), _auto: true, _autoKind: 'wrap-up' });
        kind = 'wrap-up';
        await nextRound();
        continue;
      }
      if (io.waiting) status(io.waiting);
      continue; // the model continues after the tool results
    }

    // Anthropic paused a long server-side search (pause_turn): the paused message goes back as it is
    // (its raw blocks are replayed) and the API resumes it; bounded by the tool-round limit.
    if (result.finishReason === 'pause_turn' && round < maxRounds && !signal.aborted) {
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
    // cut, or one in the last round, ends the turn with the cut row.
    if (result.finishReason === 'length' && !out.continued && round < maxRounds && !signal.aborted) {
      out.continued++;
      // A cut inside a tool call: the call was dropped, so "continue where it stopped" means nothing to the model.
      const cutCall = result.toolCalls.length > 0;
      const auto = { role: 'user', content: cutCall ? AUTO_CONTINUE_TOOL_TEXT : AUTO_CONTINUE_TEXT, _auto: true };
      messages.push(auto);
      if (!quiet) addAutoRow(auto); // a row of the turn's bubble; the stored message draws it again
      await nextRound();
      continue;
    }
    // A reply of an editing turn that announced an edit and called no tool: one nudge per turn.
    if (loud && canEdit(mode) && !out.nudged && round < maxRounds && !signal.aborted && result.finishReason === 'stop' &&
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

// The wrap-up message: text, then, when the turn's messages (msgs) hold successful edits, WRAP_UP_EDITS_TEXT with them,
// then the turn's calls (turnCallsText). A model at the round limit once answered "I made no changes" after ten edits;
// the journal says what is there. The request has no tools, so its history has no tool messages (apiMessage drops
// them): without the list the model would report blind. The texts state the situation: an instruction such as "without
// calling tools" came back in the answer ("I used no tools in this message").
function wrapUpContent(text, msgs) {
  const edits = turnEditsLine(msgs);
  const calls = turnCallsText(msgs);
  return [text, edits ? WRAP_UP_EDITS_TEXT.replace('{edits}', edits) : '', calls].filter(Boolean).join('\n');
}
// The wrap-up request's history: without replay payloads (withoutReplay), and an interim text of the turn (messages
// from turnStart) that repeats an earlier one of the turn sent once: without its calls a looping turn's rounds read as
// the same sentence again and again.
function wrapUpHistory(messages, turnStart) {
  const seen = new Set();
  return withoutReplay(messages).map((m, i) => {
    const text = i >= turnStart && m.role === 'assistant' ? String(m.content || '').trim() : '';
    if (!text) return m;
    if (!seen.has(text)) { seen.add(text); return m; }
    return { ...m, content: '' };
  });
}
// The calls of msgs as plain text, provider-neutral: one line each ("[read_document(scope=...): ok]", a failure with
// the start of its error; foldCall), the last WRAP_UP_CALLS_MAX; the last WRAP_UP_RESULTS results with their text clipped
// (a repeated read's pointer, _again, is not one: in a read loop the pointers would push the result itself out).
// '' for none.
function turnCallsText(msgs) {
  const results = new Map();
  for (const m of msgs) if (m && m.role === 'tool') results.set(m.tool_call_id, m);
  const calls = [];
  for (const m of msgs) if (m && m.role === 'assistant') for (const tc of m.tool_calls || []) calls.push([tc, results.get(tc.id)]);
  if (!calls.length) return '';
  const shown = calls.slice(-WRAP_UP_CALLS_MAX);
  const clipped = new Set(shown.map(([, r], i) => (r && !r._again ? i : -1)).filter((i) => i >= 0).slice(-WRAP_UP_RESULTS));
  const lines = shown.map(([tc, r], i) => {
    if (!clipped.has(i)) return foldCall(tc, r);
    const text = String(r.content || '').replace(/\s+/g, ' ').trim();
    const failed = r._ok === false || /^Error:/.test(text);
    const head = foldCall(tc, null).slice(0, -1); // "[name(args)" without its bracket
    const clip = text.length > WRAP_UP_RESULT_CHARS ? `${text.slice(0, WRAP_UP_RESULT_CHARS - 1)}…` : text;
    return `${head}: ${failed ? 'failed' : r._edit && r._edit.undone ? 'ok, undone later' : 'ok'}] ${clip}`;
  });
  const count = calls.length > shown.length ? `the last ${shown.length} of ${calls.length}` : String(calls.length);
  return `${WRAP_UP_CALLS_TEXT.replace('{count}', count)}\n${lines.join('\n')}`;
}
// "inserted after line 2 (now lines 3–28); formatted line 3 (h1); …": the successful edits of msgs that are not undone,
// from their results (the first line without "Done: " and the line count), clipped to WRAP_UP_EDITS_MAX_CHARS; '' for none.
// A paste and an agent's edits count too.
function turnEditsLine(msgs) {
  const out = [];
  for (const m of msgs) {
    if (!m || m.role !== 'tool' || !m._ok) continue;
    if (m._edit) {
      if (m._edit.undone) continue;
      if (m._edit.kind === 'remember') { out.push(m._edit.title); continue; } // its result is the file, not a "Done:" line
      const first = String(m.content || '').split('\n')[0].replace(/^Done:\s*/, '').replace(/;\s*the document (now )?has \d+ lines\.?$/, '').replace(/\.$/, '');
      out.push(first.replace(/; now (lines? [\d–-]+)/, ' (now $1)') || m._edit.title);
    } else if (m._agent && (m._agent.edits || []).length) {
      out.push(`an agent: ${m._agent.edits.map((e) => (e._edit && e._edit.title) || e._message).join(', ')}`);
    } else if (String(m.content || '').startsWith(PASTE_DONE_NOTE.slice(0, 40))) out.push('pasted the text into the document');
  }
  const line = out.join('; ');
  return line.length > WRAP_UP_EDITS_MAX_CHARS ? line.slice(0, WRAP_UP_EDITS_MAX_CHARS - 1) + '…' : line;
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

// The stream hooks of a visible round: the live bubble.
function streamHooks(view, snap) {
  const { live, painter, schedule } = view;
  return {
    onReasoning(r) { view.noteReasoning(); live.reasoning = r; live.last = 'reasoning'; schedule(); },
    onContent(c) { view.noteOutput(); live.text = c; live.last = 'text'; schedule(); },
    // Server-side web search calls (/research with OpenAI or Anthropic): plain activity rows.
    onActivity(list) { live.activity = list.slice(); live.last = 'activity'; noteSearchActivity(snap, list); schedule(); },
    // No call has a pending card: a write's (and remember's) progress is the bubble's status line and its row, its
    // success a row, its failure a card (runRoundCalls); a decision card (the edit gate, ask_user, open_document)
    // appears when the call asks.
    onToolCall(i, call) {
      view.noteOutput(); // the reasoning of this round ended with the call
      // The providers deliver the name before the arguments: the status line says what kind of call is coming. A
      // repaint only (not schedule): a round whose only call is delegate keeps no bubble of its own (toolLoop).
      const name = (call && call.function && call.function.name) || '';
      if (name && (live.calling !== name || live.last !== 'call')) { live.calling = name; live.last = 'call'; painter.update(live); }
    },
  };
}

// The status line while a tool call runs.
function toolStatus(tc) {
  const name = tc.function.name;
  if (name === 'open_document') return 'Opening a document…';
  const extra = extraTool(name);
  if (extra && extra.status) return extra.status; // a registered tool's own status line (search)
  if (isReadingTool(tc)) return 'Reading the document…';
  if (name === REPLACE_TOOL.function.name) return 'Replacing the selection…';
  if (name === 'remember') return REMEMBER_PENDING;
  if (name === ASK_USER_TOOL.function.name) return 'Waiting for your answer…';
  return 'Editing the document…';
}

// The tool calls of one round, in order (toolLoop): each result is appended to io.messages, logged in the round's
// action log and shown on its card; an edit is saved at once. After Stop the remaining calls are answered as cancelled.
// oneWrite (an Anthropic request: next to the filtering search it cannot ask for one call at a time): the reading calls
// of a response all run, of its writing calls only the first, since an edit can shift the lines the others name. Each
// later one is answered with ONE_EDIT_TEXT (_deferred: no row, no card), so every call of the response has its result
// in the next request. The other providers ask for one call at a time; when a server sends several anyway (Munin's
// formatting calls), they all run and a line-numbered call after a write is refused (lineDriftError). A writing call
// edits the document: not ask_user, nor a registered tool that runs in every mode (models, chat_title: anyMode).
function isWriteCall(tc) {
  const name = tc.function.name;
  const extra = extraTool(name);
  return isEditTool(name) && !isReadingTool(tc) && name !== ASK_USER_TOOL.function.name && !(extra && extra.anyMode);
}
async function runRoundCalls(result, { mode, snap, signal, io, out, view, save, status, oneWrite = false }) {
  const { messages } = io;
  const quiet = !!io.quiet || !!io.silent; // silent: no bubble, rows or trimming note, but cards as in the main turn
  // An agent's loop (silent, not the self-test's quiet agent): its cards go into its block (render.js placeAgentCard).
  const agentRef = io.silent && !io.quiet && !snap.quiet && snap.agent
    ? { id: snap.agent.id, docId: (snap.chatCtx || {}).docId, chatId: (snap.chatCtx || {}).chatId } : null;
  const serverActivity = result.activity || [];
  // Action log of this round: a row per call, added when the call starts and filled in when it ends.
  const log = [];
  const agents = []; // the _agent records of this round's delegate results: the meta line's agent tokens
  const showLog = () => {
    if (quiet) return;
    // A round whose only call is delegate has no bubble of its own: the agent's block is the whole of it.
    if (!view.bubble && !log.length && !serverActivity.length && !result.content && !result.reasoning) return;
    updateAssistantBubble(view.ensureBubble(), { text: result.content, reasoning: result.reasoning, usage: result.usage, activity: [...serverActivity, ...log], agents, thoughtMs: result.thoughtMs });
  };
  snap.responseWrite = null; // line numbers are valid until the first edit of this response
  let wrote = false; // a writing call of this response has run
  for (let i = 0; i < result.toolCalls.length; i++) {
    const tc = result.toolCalls[i];
    let r;
    let decided = null; // its last decision card, answered
    const writes = oneWrite && isWriteCall(tc);
    if (signal.aborted) {
      r = { role: 'tool', tool_call_id: tc.id, content: 'Error: cancelled by the user.', _ok: false, _message: 'Cancelled by the user' };
    } else if (writes && wrote) {
      r = { role: 'tool', tool_call_id: tc.id, content: ONE_EDIT_TEXT, _ok: false, _deferred: true, _message: 'Not run: one edit per response' };
    } else {
      const own = ownBlock(tc.function.name); // delegate: its block is drawn by agents.js, no row
      const row = logEntry(tc, null);
      if (!own) log.push(row);
      showLog();
      status(toolStatus(tc));
      const ui = {}; // ui.card: the call's decision card (the edit gate, ask_user, open_document), when it asks
      // A visible turn's decision card waits in the bubble's cards slot and, once decided, goes after the call's row
      // (settle); an agent's (silent loop, no bubble) goes into the agent's block.
      if (!quiet) {
        ui.place = (card) => placeRoundCard(view.bubble, card, tc.id);
        ui.settle = (card) => settleRoundCard(view.bubble, card);
      } else if (agentRef) ui.place = (card) => placeAgentCard(agentRef, tc.id, card);
      // A write reports its phase (docs-write.js writePhase) on the pending row: the orb and the status line
      // follow it. The finished row is a new entry without it, so the card and the row text stay as they were.
      snap.onWritePhase = (phase) => { if (row.phase === phase) return; row.phase = phase; showLog(); };
      // A long reading call (find_relevant_sections) reports its progress as the pending row's summary; renderActivity
      // keys a log row by its status and result only, so the drawn row's key is cleared to repaint it.
      snap.onCallProgress = (text) => {
        if (isEditTool(tc.function.name) && !isReadingTool(tc)) { // a write's progress: the status line (placeText)
          if (row.progress === text) return;
          row.progress = text;
          showLog();
          return;
        }
        if (row.summary === text) return;
        row.summary = text;
        staleActivityRow(view.bubble, row);
        showLog();
      };
      try { r = await executeTool(tc, mode, snap, ui); } finally { snap.onWritePhase = null; snap.onCallProgress = null; }
      out.tools.push(tc.function.name);
      // A decided card stays in its answered state (an agent's in its block); a quiet loop (the self-test) removes its
      // cards, and so does an agent whose card found no block (shown at the end of the chat while it waited).
      if (quiet) { for (const c of ui.cards || []) if (!c._agentPlaced) c.remove(); ui.card = null; }
      decided = ui.card || null;
      if (!own) log.pop();
    }
    if (writes) wrote = true;
    if (r._deferred) { messages.push(r); continue; } // its result only: the call comes again in the next response
    if (noteRepeatFailure(snap, tc, r) >= 3) out.repeatFailed = true;
    if (r._again >= READ_LOOP_REPEATS) out.readLoop = true;
    // An agent's result counts only when the agent edited the document.
    if (r._ok && !r._reading && tc.function.name !== 'remember' && tc.function.name !== ASK_USER_TOOL.function.name &&
        !r._agentStart && !(r._agent && !(r._agent.edits || []).length)) out.replaced = true;
    messages.push(r);
    if (r._ok && r._edit) await save(); // the edit journal survives a reload mid-turn
    if (r._agent) agents.push(r._agent);
    if (!ownBlock(tc.function.name)) log.push(logEntry(tc, r));
    showLog();
    if (!quiet) showResultCard(tc, r, decided, view.bubble);
    else if (agentRef) placeAgentResultCard(agentRef, tc, r); // an agent's result card (a paste's): in its block
  }
}

// A guard against a model that repeats a failing call: within one turn (snap.failedCalls), the 2nd failure ("Error: …")
// of a call with the same name and arguments gets REPEAT_FAIL_NOTE appended, the 3rd ends the rounds with the wrap-up
// (toolLoop). The first refusal of the beforeWrite checks ("Refused by a check: …", read-first, provenance, …) is not
// a failure: the identical call after it is the model's decision and passes; the same refusal again is one (a check
// that refuses every time, such as an agent's scope). Returns the failure count, 0 for none.
function noteRepeatFailure(snap, tc, r) {
  if (!r || r._ok || typeof r.content !== 'string' || r.content === 'Error: cancelled by the user.') return 0;
  const refusal = r.content.startsWith('Refused by a check:');
  if (!refusal && !r.content.startsWith('Error:')) return 0;
  const { args, error } = parseToolArgs(tc);
  const key = tc.function.name + '\u0000' + (error === null ? JSON.stringify(args) : error);
  if (refusal) {
    const refused = snap.refusedCalls || (snap.refusedCalls = new Set());
    if (!refused.has(key)) { refused.add(key); return 0; }
  }
  const failed = snap.failedCalls || (snap.failedCalls = new Map());
  const n = (failed.get(key) || 0) + 1;
  failed.set(key, n);
  if (n >= 2) r.content += '\n' + REPEAT_FAIL_NOTE;
  return n;
}

// The result of a call in the chat: after the call's row and its decision card in the bubble's stage (renderHistory
// draws it there too), else under its answered decision card when that one is in the chat itself, else at the end
// (toolCard appends). A successful write (remember too), a failed call, an ask_user answer and a denied edit add nothing
// (their row or decision card is the record); a reading call never has a card.
function showResultCard(tc, r, decided, bubble) {
  const shown = isReadingTool(tc) || ownBlock(tc.function.name) ? null : toolCardFor(tc, r); // delegate: its block, no card (as renderHistory)
  const real = shown && shown.nodeType !== 11 ? shown : null;
  if (!real || placeAnsweredCard(bubble, tc.id, real)) return;
  if (decided && decided.isConnected && decided !== real && decided.parentNode === el.chat) decided.after(real);
}

// ---- The working time of a turn ("Worked for Ns", "Stopped after Ns") ----------------------------------------
// From the turn's start to its end without the waits on the user (snap.userWaitMs: the decision cards, executeTool).
// Stored as _workedMs on the turn's last assistant message when the turn made a tool call (a client call, delegate
// included, or a server tool's activity); a turn without one keeps "Thought for Ns". stopped (the user's Stop, not an
// error): always stored, with _stopped (the label "Stopped after Ns"); on the user message when no reply was stored, so
// the stop still shows after a reload. Returns the stored time, or 0.
function noteWorkedTime(messages, userMsg, startedAt, snap, stopped = false) {
  const start = messages.indexOf(userMsg);
  if (start < 0) return 0;
  const own = messages.slice(start + 1).filter((m) => m && m.role === 'assistant');
  if (!stopped && !own.some((m) => (Array.isArray(m.tool_calls) && m.tool_calls.length) || (Array.isArray(m._toolActivity) && m._toolActivity.length))) return 0;
  const at = own.length ? own[own.length - 1] : userMsg;
  if (stopped) at._stopped = true;
  return (at._workedMs = Math.max(1, Math.round(workNow() - startedAt - (snap.userWaitMs || 0))));
}
// The turn's clock (a function, so tests can replace it).
function workNow() { return Date.now(); }

// The turn itself, with the chat lock held (see sendMessage). fromInput: the text came from the input box
// (emptied now; a queued message leaves the user's draft alone). Returns 'done', 'stopped' or 'failed'.
// reports: the agents' reports are the turn's message (sendAgentReports); a typed message takes the reports that waited
// too, stored before it.
async function runTurn({ persona, text, mode, snap, label, abort, tab, fromInput = true, reports = false }) {
  const startedAt = workNow(); // the "Worked for Ns" label (noteWorkedTime)
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
  beginTurnRows(); // the turn's own rows (render.js addTurnRow) wait for its user message

  const files = reports ? [] : await takeAttachments(chatCtx).catch(() => []); // the attached files go with this message (attachments.js)
  if (!reports) addUserBubble(text, persona, files);
  let userMsg = null; // stored once the turn context is built; an error before that leaves the history as it was
  try {
    await prepareSnapshot(snap, tab, chatCtx);
    snap.turnLines = await beforeTurnLines(mode, snap); // registerTurnHook('beforeTurn'): lines for buildTurnContext
    snap.mainTurn = true; // a turn of the chat (not an agent's, the self-test's or a card's): the afterWrite model checks run
    if (isMuninPersona(mode, snap) && snap.docText && snap.docText.length > PERSONA_DOC_CHAR_LIMIT) {
      addTurnRow(`The document is long (${fmtNum(snap.docText.length)} characters); only the first ${fmtNum(PERSONA_DOC_CHAR_LIMIT)} are sent to the model for /${persona} turns.`);
    }
    // _persona is display-only (badge); the request builders copy only role/content, plus the turn context
    // (_context: document summary, selection, changes since the previous turn), fixed here for the turn.
    // The agents' reports that waited for this chat go first (the newest of them is the message of a report turn).
    // The model is named after a change, and on every turn while there is another to switch to (the models tool's gate):
    // a weak model otherwise goes by an old switch result in its history.
    const runAs = runAsDue(state.messages, snap) || usableModels() >= 2;
    const context = buildTurnContext(mode, snap, lastDocFacts(state.messages), { runAs });
    const delivered = takeAgentReports(chatCtx.docId, chatCtx.chatId, snap);
    if (reports && !delivered.length) return 'done'; // taken by a turn that ran meanwhile
    const msg = reports ? delivered.pop() : persona ? { role: 'user', content: text, _persona: persona } : { role: 'user', content: text };
    // _model: the next turn names the model again only after a change (runAsDue); a turn without a context (a Munin
    // persona turn) named none, so it records none either. A report (_auto) records none: runAsDue skips it.
    if (context) Object.assign(msg, reports ? { _context: context } : { _context: context, _model: runAsTag(snap) });
    // _mode: the turn mode, _asks: an editing turn sent in Manual (every write asked), for the chat export, the chat log,
    // Continue (sentApplyMode); a command turn has _persona instead. Never sent.
    if (['manual', 'edit', 'plan'].includes(mode)) msg._mode = mode;
    if (snap.askEdits) msg._asks = true;
    if (files.length) msg._files = files; // display only: the bubble's "Attached:" lines
    state.messages.push(...delivered, msg);
    userMsg = msg;
    anchorTurnRows(msg, chatCtx.messages); // the rows so far go onto the message, the later ones onto the turn's last message
    await saveHistory(chatCtx);
    if (delivered.length || reports) renderHistoryKeepingUnstored(); // the reports' blocks in their place, before the answer
    const waiting = persona ? `Waiting for ${label} /${persona}…` : `Waiting for ${label}…`;
    setStatus(waiting);
    // Before the first request only (never between tool rounds): summarize the oldest turns if needed.
    if (await maybeCompact(mode, snap, abort.signal, chatCtx)) renderHistoryKeepingUnstored();
    setStatus(waiting);
    // What the turn's first request sent, kept in memory for the fuller chat log (Shift+click on a chat's copy button).
    let kept = null;
    const sentIo = { sent: (req) => { kept = keepTurnRequest(chatCtx, msg, req, snap, kept); }, sentUsage: (u) => keepTurnUsage(kept, u) };
    if (isMuninPersona(mode, snap)) await runPersonaTurn(persona, snap, abort.signal, sentIo);
    else {
      // On the Docs API every write is a round of its own: MAX_TOOL_ITERATIONS_API rounds there, MAX_TOOL_ITERATIONS on the export.
      const maxRounds = snap.docFormat === 'docs-api' ? MAX_TOOL_ITERATIONS_API : MAX_TOOL_ITERATIONS;
      const loop = await toolLoop(mode, snap, abort.signal, { messages: state.messages, save: () => saveHistory(chatCtx), waiting, maxRounds, ...sentIo });
      replaced = loop.replaced;
      wrapped = loop.wrapUp && !loop.repeatFailed && !loop.readLoop; // a call that kept failing or a read loop: no Continue (the budget was not the reason)
      if (mode === 'plan' && !abort.signal.aborted) markPlanAnswer();
    }
    noteWorkedTime(chatCtx.messages, userMsg, startedAt, snap, abort.signal.aborted);
    // The wrap-up answer ended the turn: its row offers Continue while it is the chat's last message.
    if (wrapped && !abort.signal.aborted) addTurnRow(WRAP_UP_NOTICE, { act: 'continue' });
    finishTurn(userMsg, snap, chatCtx);
    await saveHistory(chatCtx);
    renderHistory();
    if (abort.signal.aborted) dropTurnOrb(); // "Stopped after Ns" under the turn says it
    if (replaced) setTimeout(() => refreshSelection(), 400);
    return abort.signal.aborted ? 'stopped' : 'done';
  } catch (e) {
    if (userMsg) {
      noteWorkedTime(chatCtx.messages, userMsg, startedAt, snap, isStop(e, abort));
      if (!isStop(e, abort)) noteFailedTurn(chatCtx.messages, userMsg, e);
      finishTurn(userMsg, snap, chatCtx);
      await saveHistory(chatCtx);
    }
    renderHistory();
    return reportTurnError(e, abort, !!userMsg);
  } finally {
    endTurnRows();
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
  if (snap.docText == null && snap.docError) addTurnRow(snap.docError + ' Answering without the document context.');
}

// A turn that ended with an error or Stop: the error; after Stop nothing more when the turn's label says "Stopped after
// Ns" (labelled: its message was stored, or the /side bubble ended), else a row. Returns the outcome ('stopped' / 'failed').
const isStop = (e, abort) => e.name === 'AbortError' || abort.signal.aborted;
const STOPPED_KEPT = 'Stopped. Your message is still in the input box.';
function reportTurnError(e, abort, labelled) {
  const stopped = isStop(e, abort);
  if (stopped) { dropTurnOrb(); if (!labelled) addChatRow('Stopped.'); }
  else {
    console.warn('Munin: the request failed:', rawError(e)); // the raw text; the chat gets plain words
    addError(errorWords(e), !!e.showSettings);
  }
  return stopped ? 'stopped' : 'failed';
}
// A turn that failed before an answer (no assistant text after its message) leaves a note for the model after its
// message (_auto, _failed; drawn as a row of the turn: autoRowText): the next turn sees why the message went
// unanswered instead of two user messages in a row.
function noteFailedTurn(messages, userMsg, e) {
  const start = messages.indexOf(userMsg);
  if (start < 0 || messages.slice(start + 1).some((m) => m && m.role === 'assistant' && String(m.content || '').trim())) return;
  messages.push({ role: 'user', content: FAILED_TURN_NOTE.replace('{reason}', errorClause(e)), _auto: true, _failed: true });
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

// The end of a /side turn: its bubble is not drawn again from a history, so it ends here on every way out (a live one
// would keep its orb and "Working…"). labelOnly: a stopped turn without a bubble gets one with its label alone.
// workedMs(): the turn's time (noteWorkedTime), asked once the bubble is known.
function endSideBubble(turn, labelOnly, workedMs, stopped) {
  const b = turn.bubble && turn.bubble.isConnected ? turn.bubble : takeRowsBubble() || (labelOnly ? addAssistantBubble() : null);
  const ms = workedMs();
  if (b) endAssistantBubble(b, { workedMs: ms, stopped });
}

// A side question (/side): a read-only chat turn (turn mode 'manual': reading tools, open_document, an answer with an
// edit block; no editing, remember refused) with
// the same snapshot and turn context as a normal turn, on the side thread state.sideMessages instead of the
// chat. Without the chat lock: the stored chat is neither read nor written (no saveHistory, no compaction, no
// finishTurn and its hooks), the main history is not sent, and the side thread is never sent with main turns.
// Consecutive side questions continue the thread; it is dropped with the chat (syncSideThread).
// fromInput and the outcome ('done' / 'stopped' / 'failed') as in runTurn, so the queue settles after it.
async function runSideTurn({ text, snap, label, abort, tab, fromInput = true }) {
  const startedAt = workNow();
  state.pinnedTabId = tab.id;
  syncSideThread();
  const messages = state.sideMessages;
  if (fromInput) { el.input.value = ''; closePopup(); }
  state.sendingInput = null;
  el.trimNote.classList.add('hidden');
  state.sideTurn = true; // the bubbles of this turn get the Side styling
  let userMsg = null;
  const turn = { bubble: null }; // its bubble (toolLoop), ended here whatever happens
  try {
    addUserBubble(text);
    // chatId null: what open_document opens stays in this snapshot (rememberChatDocs finds no chat to store it on).
    await prepareSnapshot(snap, tab, { docId: state.docId, chatId: null, messages });
    snap.side = true;
    snap.turnLines = await beforeTurnLines('manual', snap);
    userMsg = { role: 'user', content: text, _model: runAsTag(snap), _mode: 'manual' };
    const context = buildTurnContext('manual', snap, lastDocFacts(state.messages), { runAs: runAsDue(messages, snap) });
    if (context) userMsg._context = context;
    messages.push(userMsg);
    const waiting = `Waiting for ${label} (side question)…`;
    setStatus(waiting);
    await toolLoop('manual', snap, abort.signal, { messages, request: { history: messages }, waiting, turn });
    const stopped = abort.signal.aborted;
    endSideBubble(turn, stopped && userMsg, () => noteWorkedTime(messages, userMsg, startedAt, snap, stopped), stopped);
    if (stopped) { dropTurnOrb(); return 'stopped'; } // its label says "Stopped after Ns"
    return 'done';
  } catch (e) {
    // Stopped: "Stopped after Ns" on its bubble (a label-only one when nothing arrived), no frozen orb; failed: the
    // bubble ends as it is ("Worked for Ns" when it made a call), before the error row.
    const stopped = isStop(e, abort);
    endSideBubble(turn, stopped && userMsg, () => (userMsg ? noteWorkedTime(messages, userMsg, startedAt, snap, stopped) : 0), stopped);
    return reportTurnError(e, abort, !!userMsg);
  } finally {
    slimHistory(messages); // later side questions get stubs for the reading results, as the main chat does
    state.sideTurn = false;
    endTurn(tab);
  }
}
