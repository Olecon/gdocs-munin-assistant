'use strict';
// Module doc-instructions.js: the "Document instructions" section (standing instructions per document):
// readDocInstructions, openInstructions, saveInstructions (auto-save: onInstructionsInput), renderInstructionsBadge, and the remember tool
// (rememberTool, revertRememberFromButton). The section also holds the paper card (src/paper-card.js).
/* global addError, closeSettings, DOC_INSTRUCTIONS_MAX, docInstructionsKey, el, fmtNum, gateEdit, oneLine, renderHistory,
   renderPaperCardSection, saveHistory, setStatus, state, withOwnedChat */
/* exported readDocInstructions, renderInstructionsBadge, updateInstructionsCount, onInstructionsInput, openInstructions,
   closeInstructions, saveInstructions, rememberTool, revertRememberFromButton */

// ---------------------------------------------------------------------------
// Document instructions (header button → a section like Settings; stored per document)
// ---------------------------------------------------------------------------
// The text is read when a document is opened (refreshContext) and frozen per turn by snapshotDocument,
// so an edit while an answer runs takes effect from the next message. All chats of the document share it.
// The text saves itself after a typing pause (INSTRUCTIONS_SAVE_MS), when the field is left and when the section closes.
const INSTRUCTIONS_SAVE_MS = 1000;
const instructionsForm = { docId: null, timer: 0 };

async function readDocInstructions(docId) {
  if (!docId) return '';
  try {
    const v = (await chrome.storage.local.get(docInstructionsKey(docId)))[docInstructionsKey(docId)];
    return typeof v === 'string' ? v.slice(0, DOC_INSTRUCTIONS_MAX) : '';
  } catch (e) {
    return '';
  }
}

function renderInstructionsBadge() {
  const on = !!state.docInstructions.trim();
  el.instructionsDot.classList.toggle('hidden', !on);
  el.instructionsBtn.title = on ? 'Document instructions (set)' : 'Document instructions';
}

function updateInstructionsCount() {
  const n = el.instructionsText.value.length;
  el.instructionsCount.textContent = `${fmtNum(n)} / ${fmtNum(DOC_INSTRUCTIONS_MAX)} characters`;
  el.instructionsCount.classList.toggle('warn', n >= DOC_INSTRUCTIONS_MAX);
}

// Typing: the counter follows at once, the text is saved after the pause.
function onInstructionsInput() {
  updateInstructionsCount();
  clearTimeout(instructionsForm.timer);
  instructionsForm.timer = setTimeout(saveInstructions, INSTRUCTIONS_SAVE_MS);
}

function openInstructions() {
  if (!state.docId) { setStatus('Open a Google Docs document first', true); return; }
  closeSettings();
  instructionsForm.docId = state.docId;
  el.instructionsText.value = state.docInstructions;
  updateInstructionsCount();
  renderPaperCardSection(); // the paper card part of the section (src/paper-card.js)
  el.instructions.classList.remove('hidden');
  el.instructionsText.focus();
}

function closeInstructions() {
  saveInstructions(); // reads the text before it awaits anything
  el.instructions.classList.add('hidden');
  instructionsForm.docId = null;
}

// Stores a document's instructions (capped, trimmed; an empty text removes the key) and shows them at once:
// the badge, and the open section with its counter unless the text comes from the form or the form waits to
// save typed text. Returns the stored text; throws when storage fails.
async function writeDocInstructions(docId, value, fromForm = false) {
  const text = String(value).slice(0, DOC_INSTRUCTIONS_MAX).trim();
  if (text) await chrome.storage.local.set({ [docInstructionsKey(docId)]: text });
  else await chrome.storage.local.remove(docInstructionsKey(docId));
  if (docId !== state.docId) return text;
  state.docInstructions = text;
  if (instructionsForm.docId === docId && !fromForm && !instructionsForm.timer) { el.instructionsText.value = text; updateInstructionsCount(); }
  renderInstructionsBadge();
  return text;
}

// Saves the form's text (trimmed, capped) under the document's key; an empty text removes the key. Nothing is
// written when the text did not change.
async function saveInstructions() {
  clearTimeout(instructionsForm.timer);
  instructionsForm.timer = 0;
  const docId = instructionsForm.docId;
  if (!docId) return;
  const value = el.instructionsText.value;
  if (docId === state.docId && value.slice(0, DOC_INSTRUCTIONS_MAX).trim() === state.docInstructions) return;
  try {
    await writeDocInstructions(docId, value, true);
  } catch (e) {
    addError('Could not save the document instructions: ' + e.message);
  }
}

// ---- remember: the model adds or removes one line on the user's explicit request ------------------
// Stored like an edit in the section (other tabs see it the same way); the running turn keeps the
// instructions it started with (snapshotDocument). The tool message keeps _remember {action, text, index,
// reverted?} for the card's one-shot Revert.
const instructionLines = (text) => (text ? text.split('\n') : []);
const rememberResult = (text) => `Document instructions now:\n${text || '(empty)'}`;
const wordsOf = (t) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
// Up to 3 lines most like text (share of common words), for the "not found" error.
function closestLines(lines, text) {
  const want = wordsOf(text);
  const score = (l) => { const w = wordsOf(l); let n = 0; for (const x of w) if (want.has(x)) n++; return n / Math.max(w.size, want.size, 1); };
  return lines.map((l) => l.trim()).filter(Boolean).map((l, i) => ({ l, s: score(l), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 3).map((x) => x.l);
}

// remember({action, text}) on the main document: returns the tool message fields. In a tainted turn the
// change waits for the edit gate (gateEdit); after Allow the instructions are read again (they may have
// changed while the card waited). gated: the gate already allowed this call.
async function rememberTool(args, snap, ui = {}, gated = false) {
  const text = String(args.text == null ? '' : args.text).replace(/\s+/g, ' ').trim();
  const action = args.action;
  const quote = `«${oneLine(text, 80)}»`;
  const fail = (content, message) => ({ content: `Error: ${content}`, _ok: false, _message: message, _cardText: '' });
  if (action !== 'add' && action !== 'remove') return fail('action must be "add" or "remove".', 'Invalid tool arguments');
  if (!text) return fail('the rule is empty.', 'Empty rule');
  if (!snap.docId) return fail('no document is open.', 'No document');
  const current = await readDocInstructions(snap.docId);
  const lines = instructionLines(current);
  const index = lines.findIndex((l) => l.trim() === text);
  const gate = async () => {
    if (gated) return null;
    const refused = await gateEdit('remember', { action, text }, snap, ui);
    if (refused) return { ...refused, _cardText: '' };
    return ui.decision ? rememberTool(args, snap, ui, true) : null;
  };
  if (action === 'add') {
    if (index >= 0) {
      return { content: `Already in the document instructions (line ${index + 1}); nothing changed.\n${rememberResult(current)}`, _ok: true,
        _message: `Already in Document instructions: ${quote}`, _icon: '📌', _cardText: '' };
    }
    const next = current.trimEnd() ? `${current.trimEnd()}\n${text}` : text;
    if (next.length > DOC_INSTRUCTIONS_MAX) {
      return fail(`the document instructions would exceed the limit of ${fmtNum(DOC_INSTRUCTIONS_MAX)} characters (now ${fmtNum(current.length)}). Shorten the rule or remove one first.`,
        `Document instructions are full (${fmtNum(DOC_INSTRUCTIONS_MAX)} characters)`);
    }
    return (await gate()) || rememberDone(snap.docId, next, { action, text, index: instructionLines(next).length - 1 }, `Added to Document instructions: ${quote}`);
  }
  if (index < 0) {
    const near = closestLines(lines, text);
    return fail(near.length
      ? `no line of the document instructions is exactly "${text}". Closest lines:\n${near.join('\n')}\nCall remember again with the exact text of the line to remove.`
      : 'the document instructions are empty.', `Not in Document instructions: ${quote}`);
  }
  const after = await gate();
  if (after) return after;
  lines.splice(index, 1);
  return rememberDone(snap.docId, lines.join('\n'), { action, text, index }, `Removed from Document instructions: ${quote}`);
}
async function rememberDone(docId, next, change, message) {
  let saved;
  try { saved = await writeDocInstructions(docId, next); } catch (e) {
    return { content: `Error: the document instructions could not be saved (${e.message}).`, _ok: false, _message: 'Could not save the document instructions', _cardText: '' };
  }
  return { content: rememberResult(saved), _ok: true, _message: message, _icon: '📌', _cardText: '', _remember: change };
}

// The card's Revert button: undoes that one change once (the added line is removed again, the removed line
// goes back to its old place). Runs like an Undo click: owns the chat and starts from the stored history.
function revertRememberFromButton(callId, btn) {
  return withOwnedChat('Revert', () => revertRemember(callId, btn));
}
async function revertRemember(callId, btn) {
  const m = state.messages.find((x) => x.role === 'tool' && x.tool_call_id === callId && x._remember);
  if (!m || m._remember.reverted) return false;
  const { action, text, index } = m._remember;
  if (btn) btn.disabled = true;
  try {
    const lines = instructionLines(await readDocInstructions(state.docId));
    const own = lines[index] !== undefined && lines[index].trim() === text ? index : lines.findIndex((l) => l.trim() === text);
    if (action === 'add' && own >= 0) lines.splice(own, 1);
    if (action === 'remove' && own < 0) lines.splice(Math.min(index, lines.length), 0, text);
    const next = lines.join('\n');
    if (next.trim().length > DOC_INSTRUCTIONS_MAX) throw new Error(`the document instructions would exceed ${fmtNum(DOC_INSTRUCTIONS_MAX)} characters`);
    await writeDocInstructions(state.docId, next);
  } catch (e) {
    if (btn) btn.disabled = false;
    addError('Revert failed: ' + e.message);
    return false;
  }
  m._remember.reverted = true;
  m.content += '\n[Later the user reverted this change with the Revert button.]';
  await saveHistory();
  renderHistory();
  return true;
}
