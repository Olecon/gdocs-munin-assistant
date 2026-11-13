'use strict';
// Module action-log.js: the action-log entries of tool calls (toolCallSummary, logEntry,
// actionLogFromToolCalls); the rows are drawn by render.js.
/* global activitySummary, ownBlock, extraTool, formatArgsText, formatLinesArgsText, parseToolArgs, QUIET_TOOLS, readingSummary, rememberLine, REPLACE_TOOL, writeRowInfo */
/* exported oneLine, logEntry, actionLogFromToolCalls */

// ---- Action log: one expandable row per tool call under the answer of its round ----------------
// Built from the tool calls and their tool messages (the result text the model received), live during
// a turn and again by renderHistory. Munin persona activity (no results) stays a plain row.
const oneLine = (t, max) => { const s = String(t).replace(/\s*\n\s*/g, ' ⏎ '); return s.length > max ? s.slice(0, max) + '…' : s; };
function toolCallSummary(name, args) {
  const extra = extraTool(name); // registerTools: its own summary
  if (extra) return extra.summary ? String(extra.summary(name, args) || '') : activitySummary(args);
  if (QUIET_TOOLS.includes(name)) return readingSummary(name, args);
  if (name === 'edit_document') return editDocumentSummary(args);
  // The batch fields of earlier versions (stored chats): how many, and which texts or lines.
  const batch = name === 'replace_text' ? args.edits : name === 'format_text' ? args.items : name === 'delete_lines' ? args.ranges : null;
  if (Array.isArray(batch) && batch.length) {
    const ok = batch.filter((e) => e && typeof e === 'object');
    if (name === 'delete_lines') return `${batch.length} ranges (lines ${oneLine(ok.map((r) => (r.end == null || Number(r.end) === Number(r.start) ? `${r.start}` : `${r.start}–${r.end}`)).join(', '), 60)})`;
    return `${batch.length} ${name === 'replace_text' ? 'edits' : 'passages'} (${oneLine(ok.map((e) => `"${oneLine(String(e.old_text == null ? '' : e.old_text), 20)}"`).join(', '), 70)})`;
  }
  if (name === 'replace_text' && typeof args.old_text === 'string') return `"${oneLine(args.old_text, 60)}"`;
  if (name === 'replace_section' && typeof args.heading === 'string') return `«${oneLine(args.heading, 60)}»`;
  if (name === 'replace_all' && typeof args.old_text === 'string') return `"${oneLine(args.old_text, 30)}" → "${oneLine(String(args.new_text == null ? '' : args.new_text), 30)}"`;
  if (name === 'format_text' && typeof args.old_text === 'string') {
    const how = formatArgsText(args);
    return `"${oneLine(args.old_text, 50)}"${how ? ` (${how})` : ''}`;
  }
  if (name === REPLACE_TOOL.function.name && typeof args.text === 'string') return `"${oneLine(args.text, 60)}"`;
  if (name === 'insert_after_line' && Array.isArray(args.inserts) && args.inserts.length) {
    return `at ${args.inserts.length} places (after lines ${oneLine(args.inserts.map((e) => (e && typeof e === 'object' ? e.line : '?')).join(', '), 60)})`;
  }
  if (name === 'insert_after_line') return fillsLine(args) ? `into line ${args.line}` : Number(args.line) === 0 ? 'at the beginning' : `after line ${args.line}`;
  if (name === 'format_lines') {
    if (Array.isArray(args.ranges) && args.ranges.length) {
      const where = args.ranges.map((r) => (r && typeof r === 'object' ? (r.end == null || Number(r.end) === Number(r.start) ? `${r.start}` : `${r.start}–${r.end}`) : '?'));
      return `${args.ranges.length} ranges (lines ${oneLine(where.join(', '), 60)})`;
    }
    const how = formatLinesArgsText(args);
    const where = Number(args.start) === Number(args.end) ? `line ${args.start}` : `lines ${args.start}–${args.end}`;
    return `${where}${how ? ` (${how})` : ''}`;
  }
  if (name === 'delete_lines') return Number(args.start) === Number(args.end) ? `line ${args.start}` : `lines ${args.start}–${args.end}`;
  if (name === 'undo_last_edit') return '';
  if (name === 'remember' && typeof args.text === 'string') return rememberLine(args);
  return activitySummary(args);
}
// An insert with fill: true (also sent as a string) writes into its line (docs-write.js insertPartPlan).
const fillsLine = (a) => a.fill === true || String(a.fill).trim().toLowerCase() === 'true';
// "3 edits (replace "Alpha", insert after 4, format_lines 6–7)".
function editDocumentSummary(args) {
  const ops = Array.isArray(args.operations) ? args.operations.filter((e) => e && typeof e === 'object') : [];
  if (!ops.length) return '';
  const lines = (e) => (e.end == null || Number(e.end) === Number(e.start) ? `${e.start}` : `${e.start}–${e.end}`);
  const one = (e) => {
    const op = String(e.op || '?');
    if (op === 'replace' || op === 'format_text') return `${op} "${oneLine(String(e.old_text == null ? '' : e.old_text), 20)}"`;
    if (op === 'insert') return `insert ${fillsLine(e) ? 'into' : 'after'} ${e.line}`;
    return `${op} ${lines(e)}`;
  };
  return `${ops.length} edit${ops.length === 1 ? '' : 's'} (${oneLine(ops.map(one).join(', '), 80)})`;
}
// Log entry of a tool call (r: its tool message, or null while it runs).
function logEntry(tc, r) {
  const name = (tc.function && tc.function.name) || 'tool';
  const { args, error } = parseToolArgs(tc);
  const status = !r ? 'pending' : r._decision === 'rejected' || r._decision === 'stopped' ? 'rejected' : r._ok === false ? 'fail' : 'ok';
  const entry = { log: true, id: tc.id, name, summary: error !== null ? 'invalid arguments' : toolCallSummary(name, args), args: error !== null ? error : args, result: r ? String(r.content == null ? '' : r.content) : null, status };
  if (r && r._omittedChars) entry.omitted = r._omittedChars; // the result was replaced by a stub after its turn
  // A failure's detail the model's text does not carry (failures have no card: the row's fold shows it).
  if (r && status !== 'ok' && r._detail && !entry.result.includes(String(r._detail))) entry.detail = String(r._detail);
  const write = status === 'ok' ? writeRowInfo(tc, r) : null; // a successful write: its row stands in for the card
  if (write) entry.write = write;
  return entry;
}
// A delegate call has its own block (render.js agentBlockFor), not a row; a writing call that waited for the next
// response (_deferred, turn.js runRoundCalls) has none either: its next call has the row.
const deferredCall = (tc, results) => !!(results && results.get(tc.id) && results.get(tc.id)._deferred);
function actionLogFromToolCalls(calls, results) {
  return (calls || []).filter((tc) => !ownBlock(tc.function && tc.function.name) && !deferredCall(tc, results))
    .map((tc) => logEntry(tc, (results && results.get(tc.id)) || null));
}
