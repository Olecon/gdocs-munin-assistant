'use strict';
// Module registry.js: the extension points feature modules plug into, so a feature lives in its own file and
// the shared modules (tools.js, request.js, turn.js, prompts.js, action-log.js, render.js, gate.js, docs-undo.js,
// selftest.js, docs-model.js) do not change per feature. Loaded right after constants.js, so a module may
// register at load time wherever it sits in sidepanel.html; the consumers read the registries at run time.
// Registered names never shadow the built-in tools: those keep their own code paths.
/* global TOOL_DEFS */
/* exported EXTRA_TOOLS, registerTools, offered, extraTool, extraToolDefs, isExtraReading, extraIcon, registerPromptLine, extraPromptLines,
   registerUndoHandler, undoHandler, registerSelfTestRows, extraSelfTestRows, registerLineDecorator, lineDecorations,
   lineDecoratorNotes, registerTurnHook, runTurnHooks, beforeTurnLines, beforeWriteChecks */

// ---- Tools ------------------------------------------------------------------------------------------
// registerTools(defs, spec): defs are tool definitions in Chat Completions format ({ type: 'function',
// function: { name, description, parameters } }); spec says, for all of them:
//   offer(mode, snap) -> boolean: offered in this turn (only turns with client tools ask; Munin persona turns have none;
//     ask it through offered(entry, mode, snap): an offer() that throws leaves the tool out);
//   run(name, args, snap, ui, call) -> tool message fields ({ content, _ok, _message, _edit?, ... }) or a string
//     (the content; ok unless it starts with "Error:"); may be async. ui: the call's card holder for gateEdit;
//     call: { id (the tool call id: use it as the journal id), mode };
//   reading: true | false | (name, args) => boolean: a reading call (quiet action-log row, no card, its result
//     is stubbed after the turn like read_lines); writing calls need Auto mode and the main document;
//   summary(name, args) -> string: the action-log row's summary;
//   icon: '▦' or { name: icon }; pending: the card text while the call streams (writing tools);
//   gate(name, plan) -> { large, what, range, excerptLabel, excerpt } | null: editGateInfo for gateEdit;
//   prompt: [{ section: 'reading' | 'edit', line, when?(mode, snap) }] (registerPromptLine; when defaults to offer);
//   docNote(snap) -> string: a line added to the <document> block of the turn context when offered.
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
const extraToolDefs = (mode, snap) => EXTRA_TOOLS.filter((t) => offered(t, mode, snap)).flatMap((t) => t.defs);
// Whether a call of a registered tool only reads (args: the parsed arguments, or {} when unknown).
function isExtraReading(name, args = {}) {
  const t = extraTool(name);
  if (!t) return false;
  return typeof t.reading === 'function' ? !!t.reading(name, args || {}) : !!t.reading;
}
function extraIcon(name) {
  const t = extraTool(name);
  if (!t || !t.icon) return '';
  return typeof t.icon === 'string' ? t.icon : t.icon[name] || '';
}

// ---- Prompt lines -------------------------------------------------------------------------------------
// One "- tool(args): what it does" line in the static system prompt: section 'reading' joins the reading
// tools of the instructions, 'edit' the list of apiEditRules (Auto turns with the Docs API). when(mode, snap)
// must give the same answer for every round of a turn (the prompt is cached).
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
// a Docs API model are shown in read_lines, read_formatting, find_in_document and the edit reports. label goes
// between the line number and the colon ("6 [r1c1]: text"); before is an unnumbered line put in front of the
// line ("[table T1: …]"; read_lines and the reports only); note is added to the instructions' sentence about
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
//   'finish' fn(userMsg, snap, chatCtx) at the end of every tools turn (finishTurn, also after an error or Stop);
//   'panelDoc' fn(docId) when the panel loads a document's chats (refreshContext);
//   'beforeTurn' fn(mode, snap) -> a line for the turn context, or '' / null (may return a promise of one): asked
//     once per turn after the snapshot is taken (runTurn, runSideTurn: beforeTurnLines), before buildTurnContext;
//     the lines go into the user message's turn context (after the document notes, before the selection line),
//     never into the static head;
//   'beforeWrite' fn(name, plan, args, snap) -> null | { notes?: [string], refuse?: string } (may be async): asked
//     by gateEdit before its card logic, for every write that goes through it (the built-in writing tools,
//     replace_selection, remember and the registered writing tools); args: the call's parsed arguments ({} when
//     unknown). A refuse makes gateEdit refuse the call ("Refused by a check: <refuse>"; the first refuse wins);
//     notes go on ui.notes, and executeTool appends them to a successful result ("Note: …"), so the model sees
//     them in the next round.
// Best effort: a hook's error or rejected promise is skipped (finish, panelDoc: ignored; beforeTurn, beforeWrite:
// logged).
const TURN_HOOKS = { finish: [], panelDoc: [], beforeTurn: [], beforeWrite: [] };
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
// The turn-context lines of the beforeTurn hooks, in registration order (one line each, empty answers dropped).
async function beforeTurnLines(mode, snap) {
  const out = [];
  for (const fn of TURN_HOOKS.beforeTurn) {
    const line = await askHook('beforeTurn', fn, [mode, snap]);
    if (typeof line === 'string' && line.trim()) out.push(line.trim().replace(/\s*\n\s*/g, ' '));
  }
  return out;
}
// The beforeWrite checks of one write: { notes: [string], refuse: string | null }. Stops at the first refuse.
async function beforeWriteChecks(name, plan, args, snap) {
  const res = { notes: [], refuse: null };
  for (const fn of TURN_HOOKS.beforeWrite) {
    const r = await askHook('beforeWrite', fn, [name, plan, args || {}, snap]);
    if (!r || typeof r !== 'object') continue;
    if (Array.isArray(r.notes)) res.notes.push(...r.notes.filter((n) => typeof n === 'string' && n.trim()));
    if (typeof r.refuse === 'string' && r.refuse.trim()) { res.refuse = r.refuse.trim(); break; }
  }
  return res;
}
