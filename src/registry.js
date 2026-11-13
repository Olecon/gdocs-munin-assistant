'use strict';
// Module registry.js: the extension points feature modules plug into, so a feature lives in its own file and
// the shared modules (tools.js, request.js, turn.js, prompts.js, action-log.js, render.js, gate.js, docs-undo.js,
// selftest.js, docs-model.js) do not change per feature. Loaded right after constants.js, so a module may
// register at load time wherever it sits in sidepanel.html; the consumers read the registries at run time.
// Registered names never shadow the built-in tools: those keep their own code paths.
/* global TOOL_DEFS */
/* exported EXTRA_TOOLS, registerTools, offered, extraRuns, extraTool, extraToolDefs, isExtraReading, readingDigest, extraUsesLines, registerPromptLine, extraPromptLines,
   registerUndoHandler, undoHandler, registerSelfTestRows, extraSelfTestRows, registerLineDecorator, lineDecorations,
   lineDecoratorNotes, registerTurnHook, runTurnHooks, beforeTurnLines, beforeTurnStart, beforeWriteChecks, afterWriteNotes */

// ---- Tools ------------------------------------------------------------------------------------------
// registerTools(defs, spec): defs are tool definitions in Chat Completions format ({ type: 'function',
// function: { name, description, parameters } }); spec says, for all of them:
//   offer(mode, snap) -> boolean: offered in this turn (only turns with client tools ask; Munin persona turns have none;
//     ask it through offered(entry, mode, snap): an offer() that throws leaves the tool out);
//   run(name, args, snap, ui, call) -> tool message fields ({ content, _ok, _message, _edit?, ... }) or a string
//     (the content; ok unless it starts with "Error:"); may be async. ui: the call's card holder for gateEdit;
//     call: { id (the tool call id: use it as the journal id), mode };
//   reading: true | false | (name, args) => boolean: a reading call (quiet action-log row, no card, its result
//     is stubbed after the turn like read_document); writing calls need an editing turn (Manual or Auto) and the main
//     document;
//   digest(name, args, content, why) -> string: a reading call's own short stub, built from its result text (an external
//     lookup: what it found, so the next turn need not look it up again; why: "after the turn" or "to fit the context
//     window"); '' or none: the plain stub;
//   summary(name, args) -> string: the action-log row's summary;
//   pending: the card text while the call streams (writing tools); no icons: cards and rows show none;
//   status: the status line while the call runs (default: the reading or editing text);
//   gate(name, plan) -> { what, range?, excerptLabel?, excerpt? | blocks?, why?, always?, asks?, undoable? } | null:
//     editGateInfo for gateEdit (gate.js says what each field does; the excerpt is shown whole, so pass it uncut);
//   prompt: [{ section: 'reading' | 'edit', line, when?(mode, snap) }] (registerPromptLine; when defaults to offer);
//   docNote(snap) -> string: a line added to the <document> block of the turn context when offered;
//   usesLines(name, args) -> boolean: a writing call that takes body line numbers; after a Docs API write in the same
//     model response (snap.responseWrite) runExtraTool refuses it as the built-in line-numbered tools are refused.
//   defsFor(mode, snap) -> definitions: the definitions sent in this turn when they depend on the mode (the same names;
//     Plan and the read-only chat turn get read-only variants: fewer actions and fields); defs otherwise;
//   runs(mode, snap) -> boolean: whether a call is accepted (default: offer). A tool offered on demand (Munin and custom
//     servers: only when the message names it) keeps its old condition here, so a call it makes unoffered still runs.
const EXTRA_TOOLS = [];
function registerTools(defs, spec) {
  const list = Array.isArray(defs) ? defs : [defs];
  const names = list.map((d) => d.function.name);
  for (const n of names) {
    if ((typeof TOOL_DEFS !== 'undefined' && TOOL_DEFS[n]) || extraTool(n)) throw new Error(`registerTools: the tool "${n}" exists already`);
  }
  if (typeof spec.offer !== 'function' || typeof spec.run !== 'function') throw new Error('registerTools: offer and run are required');
  const entry = { ...spec, defs: list, names };
  EXTRA_TOOLS.push(entry);
  for (const p of spec.prompt || []) registerPromptLine({ section: p.section, line: p.line, when: p.when || spec.offer, names });
  return entry;
}
// Asks a feature's callback at run time; a callback that throws leaves that feature out (logged) instead of
// failing the turn, as the turn hooks do. Returns the answer or fallback.
function featureCall(names, what, fn, fallback) {
  try { return fn(); } catch (e) {
    console.warn(`Munin: ${what} of ${[].concat(names).join(', ')} failed; left out`, e);
    return fallback;
  }
}
// Whether registered tool entry t is offered in this turn (false when its offer() throws).
const offered = (t, mode, snap) => !!featureCall(t.names, 'offer()', () => t.offer(mode, snap), false);
const extraTool = (name) => EXTRA_TOOLS.find((t) => t.names.includes(name)) || null;
// The registered definitions offered in this turn, in registration order.
const extraToolDefs = (mode, snap) => EXTRA_TOOLS.filter((t) => offered(t, mode, snap))
  .flatMap((t) => (t.defsFor ? featureCall(t.names, 'defsFor()', () => t.defsFor(mode, snap), t.defs) || t.defs : t.defs));
// Whether a call of a registered tool is accepted in this turn: runs(mode, snap) when the entry has one (a tool offered
// on demand still runs when the model calls it unoffered), else offered.
const extraRuns = (t, mode, snap) => (t.runs ? !!featureCall(t.names, 'runs()', () => t.runs(mode, snap), false) : offered(t, mode, snap));
// Whether a call of a registered tool only reads (args: the parsed arguments, or {} when unknown).
function isExtraReading(name, args = {}) {
  const t = extraTool(name);
  if (!t) return false;
  return typeof t.reading === 'function' ? !!t.reading(name, args || {}) : !!t.reading;
}

// A registered reading tool's digest of its result for the stub (spec.digest), or '' (the plain stub: none, it threw).
function readingDigest(name, args, content, why) {
  const t = extraTool(name);
  if (!t || typeof t.digest !== 'function') return '';
  const d = featureCall(t.names, 'digest()', () => t.digest(name, args || {}, String(content == null ? '' : content), why), '');
  return typeof d === 'string' ? d.trim() : '';
}

// Whether a writing call of a registered tool takes line numbers (spec.usesLines; false when it throws).
function extraUsesLines(name, args = {}) {
  const t = extraTool(name);
  return !!(t && typeof t.usesLines === 'function' && featureCall(t.names, 'usesLines()', () => t.usesLines(name, args || {}), false));
}

// ---- Prompt lines -------------------------------------------------------------------------------------
// One "- …" line in the static system prompt: section 'reading' joins the reading part of the instructions, 'edit'
// the list of apiEditRules (editing turns with the Docs API). A line holds behavior the tool's definition cannot say
// (when to use it over another tool, a procedure, a rule); what the tool takes and does belongs in its definition only.
// when(mode, snap) must give the same answer for every round of a turn (the prompt is cached).
const PROMPT_LINES = [];
function registerPromptLine({ section, line, when, names = 'a prompt line' }) {
  if (section !== 'reading' && section !== 'edit') throw new Error('registerPromptLine: section must be reading or edit');
  PROMPT_LINES.push({ section, line, when: when || (() => true), names });
}
const extraPromptLines = (section, mode, snap) => PROMPT_LINES.filter((p) => p.section === section && featureCall(p.names, 'when()', () => p.when(mode, snap), false))
  .map((p) => (typeof p.line === 'function' ? featureCall(p.names, 'line()', () => p.line(mode, snap), '') : p.line)).filter(Boolean);

// ---- Undo -------------------------------------------------------------------------------------------------
// registerUndoHandler(kind, fn): undoEdit(edit) hands journal entries of that kind to fn(edit) -> { model, restored?,
// lostObjects?, range?: [from, to], lines?: [n...], note?: string (appended to the result), what?: string (the
// "undid …" sentence) }, or throws a readable Error (the refusal). Built-in kinds cannot be replaced.
const UNDO_HANDLERS = {};
const BUILTIN_UNDO_KINDS = ['replace', 'insert', 'delete', 'replace-all', 'format', 'multi', 'requests'];
function registerUndoHandler(kind, fn) {
  if (BUILTIN_UNDO_KINDS.includes(kind) || UNDO_HANDLERS[kind]) throw new Error(`registerUndoHandler: the kind "${kind}" exists already`);
  UNDO_HANDLERS[kind] = fn;
}
const undoHandler = (kind) => UNDO_HANDLERS[kind] || null;

// ---- Self-test rows --------------------------------------------------------------------------------------
// registerSelfTestRows([{ name, run(ctx) -> stPass(...) | stWarn | stFail | stSkip, after?: row name (default
// 'Write: lists'), modes?: ['api'] | ['export'] | ['api', 'export'] (default ['api']) }]): inserted into
// selfTestChecks after the named row (at the end when that row is not in the list), in registration order.
const SELFTEST_ROWS = [];
function registerSelfTestRows(rows) {
  for (const r of rows) {
    if (!r.name || typeof r.run !== 'function') throw new Error('registerSelfTestRows: name and run are required');
    SELFTEST_ROWS.push({ after: 'Write: lists', modes: ['api'], ...r });
  }
}
const extraSelfTestRows = (mode) => SELFTEST_ROWS.filter((r) => r.modes.includes(mode));

// ---- Line notation ------------------------------------------------------------------------------------------
// registerLineDecorator({ label(line, model) -> string, before(line, model) -> string, note }): how the lines of
// a Docs API model are shown in read_document, find_in_document and the edit reports. label goes
// between the line number and the colon ("6 [r1c1]: text"); before is an unnumbered line put in front of the
// line ("[table T1: …]"; read_document and the reports only); note is added to the instructions' sentence about
// table cells (", marked [rNcM] …"). Without decorators the output is unchanged.
const LINE_DECORATORS = [];
function registerLineDecorator(d) { LINE_DECORATORS.push(d); }
// { label, before } of a line ('' when none).
function lineDecorations(line, model) {
  let label = '';
  let before = '';
  if (!line || !model) return { label, before };
  for (const d of LINE_DECORATORS) {
    const l = d.label ? d.label(line, model) : '';
    const b = d.before ? d.before(line, model) : '';
    if (l) label += ' ' + l;
    if (b) before += (before ? '\n' : '') + b;
  }
  return { label, before };
}
const lineDecoratorNotes = () => LINE_DECORATORS.map((d) => d.note || '').join('');

// ---- Turn hooks ----------------------------------------------------------------------------------------------
// registerTurnHook(event, fn):
//   'finish' fn(userMsg, snap, chatCtx) at the end of every tools turn (finishTurn, also after an error or Stop); not
//     awaited (runTurnHooks): a promise it returns runs detached, so background work started here (the chat title of
//     src/chat-title.js) never delays the end of the turn, the busy flag or a queued message;
//   'panelDoc' fn(docId) when the panel loads a document's chats (refreshContext), not awaited either;
//   'beforeStart' fn({mode, text, persona, snap, signal}) (may be async; awaited, one after the other): before a main
//     turn reads the document (startTurn, with the chat lock held, the message still in the input box); Stop meanwhile
//     gives up the turn and leaves the message in the input box. Keep it short: the turn waits for it. Long work is
//     started detached instead (src/doc-init.js decides here and starts its background pass from beforeTurn). Not for
//     /side, /test or /check;
//   'beforeTurn' fn(mode, snap) -> a line for the turn context, or '' / null (may return a promise of one): asked
//     once per turn after the snapshot is taken (runTurn, runSideTurn: beforeTurnLines), before buildTurnContext;
//     the lines go into the user message's turn context (after the document notes, before the selection line),
//     never into the static head;
//   'beforeWrite' fn(name, plan, args, snap) -> null | { notes?: [string], refuse?: string } (may be async): asked
//     by gateEdit before its card logic, for every write that goes through it (the built-in writing tools,
//     replace_selection, remember and the registered writing tools); args: the call's parsed arguments ({} when
//     unknown). A refuse makes gateEdit refuse the call ("Refused by a check: <refuse>"; every check runs, several
//     refusals come as one "- <refuse>" line each);
//     notes go on ui.notes, and executeTool appends them to a successful result ("Note: …"), so the model sees
//     them in the next round;
//   'afterWrite' fn(name, args, result, snap, mode) -> null | { notes?: [string] } (may be async; awaited in order): asked
//     by executeTool after a successful write of the main document (a result with _edit; not a paste without one), for
//     notes that need the written text in place (the section line, the connectivity check of src/prose-tools.js); its
//     notes join ui.notes and are appended like the beforeWrite notes. Writes from the /check and /polish cards
//     (runWriteTool) do not pass here.
// Best effort: a hook's error or rejected promise is skipped (finish, panelDoc: ignored; beforeStart, beforeTurn,
// beforeWrite, afterWrite: logged).
const TURN_HOOKS = { finish: [], panelDoc: [], beforeStart: [], beforeTurn: [], beforeWrite: [], afterWrite: [] };
function registerTurnHook(event, fn) {
  if (!TURN_HOOKS[event]) throw new Error(`registerTurnHook: unknown event "${event}"`);
  TURN_HOOKS[event].push(fn);
}
function runTurnHooks(event, ...args) {
  for (const fn of TURN_HOOKS[event] || []) {
    try {
      const p = fn(...args);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* best effort */ }
  }
}
// A hook's answer, awaited; undefined (and a log line) when it throws or rejects.
async function askHook(event, fn, args) {
  try { return await fn(...args); } catch (e) {
    console.warn(`Munin: a ${event} hook failed; skipped`, e);
    return undefined;
  }
}
// The beforeStart hooks of a main turn, awaited in registration order; a hook that throws is skipped.
async function beforeTurnStart(info) {
  for (const fn of TURN_HOOKS.beforeStart) {
    if (info.signal && info.signal.aborted) return;
    await askHook('beforeStart', fn, [info]);
  }
}
// The turn-context lines of the beforeTurn hooks, in registration order (one line each, empty answers dropped).
async function beforeTurnLines(mode, snap) {
  const out = [];
  for (const fn of TURN_HOOKS.beforeTurn) {
    const line = await askHook('beforeTurn', fn, [mode, snap]);
    if (typeof line === 'string' && line.trim()) out.push(line.trim().replace(/\s*\n\s*/g, ' '));
  }
  return out;
}
// The beforeWrite checks of one write: { notes: [string], refusals: [string], refuse: string | null }. Every check runs, so
// one round names every reason (a check that remembers its refusal lets the identical retry pass): refuse is the one
// refusal, or one "- …" line per refusal when there are several.
async function beforeWriteChecks(name, plan, args, snap) {
  const res = { notes: [], refusals: [], refuse: null };
  for (const fn of TURN_HOOKS.beforeWrite) {
    const r = await askHook('beforeWrite', fn, [name, plan, args || {}, snap]);
    if (!r || typeof r !== 'object') continue;
    if (Array.isArray(r.notes)) res.notes.push(...r.notes.filter((n) => typeof n === 'string' && n.trim()));
    if (typeof r.refuse === 'string' && r.refuse.trim()) res.refusals.push(r.refuse.trim());
  }
  if (res.refusals.length) res.refuse = res.refusals.length === 1 ? res.refusals[0] : res.refusals.map((t) => '- ' + t).join('\n');
  return res;
}
// The notes of the afterWrite hooks of one successful write, in registration order.
async function afterWriteNotes(name, args, result, snap, mode) {
  const out = [];
  for (const fn of TURN_HOOKS.afterWrite) {
    const r = await askHook('afterWrite', fn, [name, args || {}, result, snap, mode]);
    if (r && Array.isArray(r.notes)) out.push(...r.notes.filter((n) => typeof n === 'string' && n.trim()));
  }
  return out;
}
