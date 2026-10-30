'use strict';
// Module action-log.js: the action-log entries of tool calls (toolCallSummary, logEntry,
// actionLogFromToolCalls); the rows are drawn by render.js.
/* global activitySummary, extraTool, formatArgsText, formatLinesArgsText, parseToolArgs, QUIET_TOOLS, readingSummary, REPLACE_TOOL */
/* exported oneLine, logEntry, actionLogFromToolCalls */

// ---- Action log: one expandable row per tool call under the answer of its round ----------------
// Built from the tool calls and their tool messages (the result text the model received), live during
// a turn and again by renderHistory. Munin persona activity (no results) stays a plain row.
const oneLine = (t, max) => { const s = String(t).replace(/\s*\n\s*/g, ' ⏎ '); return s.length > max ? s.slice(0, max) + '…' : s; };
function toolCallSummary(name, args) {
  const extra = extraTool(name); // registerTools: its own summary
  if (extra) return extra.summary ? String(extra.summary(name, args) || '') : activitySummary(args);
  if (QUIET_TOOLS.includes(name)) return readingSummary(name, args);
  if (name === 'replace_text' && typeof args.old_text === 'string') return `"${oneLine(args.old_text, 60)}"`;
  if (name === 'replace_section' && typeof args.heading === 'string') return `«${oneLine(args.heading, 60)}»`;
  if (name === 'replace_all' && typeof args.old_text === 'string') return `"${oneLine(args.old_text, 30)}" → "${oneLine(String(args.new_text == null ? '' : args.new_text), 30)}"`;
  if (name === 'format_text' && typeof args.old_text === 'string') {
    const how = formatArgsText(args);
    return `"${oneLine(args.old_text, 50)}"${how ? ` (${how})` : ''}`;
  }
  if (name === REPLACE_TOOL.function.name && typeof args.text === 'string') return `"${oneLine(args.text, 60)}"`;
  if (name === 'insert_after_line') return Number(args.line) === 0 ? 'at the beginning' : `after line ${args.line}`;
  if (name === 'format_lines') {
    const how = formatLinesArgsText(args);
    const where = Number(args.start) === Number(args.end) ? `line ${args.start}` : `lines ${args.start}–${args.end}`;
    return `${where}${how ? ` (${how})` : ''}`;
  }
  if (name === 'delete_lines') return Number(args.start) === Number(args.end) ? `line ${args.start}` : `lines ${args.start}–${args.end}`;
  if (name === 'undo_last_edit') return '';
  if (name === 'remember' && typeof args.text === 'string') return `${args.action}: «${oneLine(args.text, 60)}»`;
  return activitySummary(args);
}
// Log entry of a tool call (r: its tool message, or null while it runs).
function logEntry(tc, r) {
  const name = (tc.function && tc.function.name) || 'tool';
  const { args, error } = parseToolArgs(tc);
  const status = !r ? 'pending' : r._decision === 'rejected' || r._decision === 'stopped' ? 'rejected' : r._ok === false ? 'fail' : 'ok';
  const entry = { log: true, name, summary: error !== null ? 'invalid arguments' : toolCallSummary(name, args), args: error !== null ? error : args, result: r ? String(r.content == null ? '' : r.content) : null, status };
  if (r && r._omittedChars) entry.omitted = r._omittedChars; // the result was replaced by a stub after its turn
  return entry;
}
function actionLogFromToolCalls(calls, results) {
  return (calls || []).map((tc) => logEntry(tc, (results && results.get(tc.id)) || null));
}
