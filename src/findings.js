'use strict';
// Module findings.js: the anchored findings format shared by the critiques the model returns (/review; later checks).
// The model answers { "criteria": {id: "PASS" | "FAIL"}, "findings": [{ severity, criterion, quote, line, detail,
// action }] } (for something missing "absence": { where, expected, checked } instead of quote; a claim check adds
// "status" and "evidence": { quote, line }). parseJsonLoose / parseFindings read it tolerantly (a fenced block, text
// around it, a bare array, missing fields, trailing commas, an answer cut off mid-way); verifyFindings looks every
// quote up in the document text with the normalized matching of replace_text (findFlexible) and takes the real line
// from the hit; sortFindings orders by group (critical, major, minor, supported, unverified); findingsMarkdown is the
// Copy text and the stored answer, findingsCard the card with line links (scrollToLine of tab-bridge.js, on click only).
/* global escapeHtml, findFlexible, fmtNum, scrollToLine, state */
/* exported FINDINGS_PARSE_ERROR, FINDING_GROUPS, parseJsonLoose, parseFindings, verifyFindings, sortFindings, findingGroup,
   flaggedFindings, findingsMarkdown, findingsCard, findingsWhenIdle */

const FINDINGS_PARSE_ERROR = 'The review did not come back as findings.';
// Display order and labels of the groups (findingGroup).
const FINDING_GROUPS = [
  ['critical', 'Critical', '⛔'], ['major', 'Major', '⚠️'], ['minor', 'Minor', '•'], ['ok', 'Supported', '✅'],
  ['unverified', 'Unverified: quote not found', '❔'],
];
const SEVERITY_ALIASES = {
  critical: ['critical', 'blocker', 'severe', 'fatal', 'high'], major: ['major', 'medium', 'moderate', 'important', 'serious'],
  minor: ['minor', 'low', 'trivial', 'suggestion', 'note', 'info', 'nit'],
};
const FINDING_LIST_KEYS = ['findings', 'issues', 'items', 'results', 'problems', 'comments'];

// ---- Parsing ------------------------------------------------------------------------------------------------
// JSON.parse, then once more without trailing commas (a common slip of small models); undefined when neither works.
function fdTryJson(t) {
  try { return JSON.parse(t); } catch (e) { /* relaxed below */ }
  try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch (e) { return undefined; }
}
// Walks a JSON text from its first bracket: { end } of the value that closes the outermost one, or { end: -1,
// closers } for a text that stops inside it (closers: what would close the open brackets and string).
function fdScanJson(s) {
  const stack = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      stack.pop();
      if (!stack.length) return { end: i };
    }
  }
  return { end: -1, closers: (inStr ? '"' : '') + stack.reverse().join('') };
}
// The value that starts at s[0] ('{' or '['): parsed up to its closing bracket; for a text cut off mid-way (the
// length limit), the longest prefix ending in a complete element, closed. undefined when nothing parses.
function fdParseFromBracket(s) {
  const r = fdScanJson(s);
  if (r.end >= 0) return fdTryJson(s.slice(0, r.end + 1));
  let k = s.length;
  for (let tries = 0; tries < 80; tries++) {
    k = Math.max(s.lastIndexOf('}', k - 1), s.lastIndexOf(']', k - 1));
    if (k <= 0) break;
    const head = s.slice(0, k + 1);
    const v = fdTryJson(head + fdScanJson(head).closers);
    if (v !== undefined) return v;
  }
  return undefined;
}
// The JSON value in a model's answer, or null: the whole text, a ```json fenced block, or the first {…} / […] in it
// (text before and after is ignored).
function parseJsonLoose(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  const tries = [text];
  const fence = /```[a-zA-Z]*\s*\n?([\s\S]*?)(?:```|$)/.exec(text);
  if (fence && fence[1].trim()) tries.unshift(fence[1].trim());
  for (const t of tries) {
    const v = fdTryJson(t);
    if (v !== undefined && v !== null && typeof v === 'object') return v;
  }
  for (const t of tries) {
    const at = t.search(/[{[]/);
    if (at < 0) continue;
    const v = fdParseFromBracket(t.slice(at));
    if (v !== undefined && v !== null && typeof v === 'object') return v;
  }
  return null;
}

const fdStr = (v) => (v == null ? '' : typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
// "12", 12, "L12", "line 12", "12-14": 12; anything else null.
function fdLine(v) {
  const m = /\d+/.exec(String(v == null ? '' : v));
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function fdSeverity(v) {
  const s = fdStr(v).toLowerCase();
  for (const [k, names] of Object.entries(SEVERITY_ALIASES)) if (names.some((n) => s.startsWith(n))) return k;
  return 'minor';
}
// A claim check's verdict: 'supported' | 'stronger' | 'not found' | ''.
function fdStatus(v) {
  const s = fdStr(v).toLowerCase().replace(/[_-]/g, ' ');
  if (!s) return '';
  if (/^(not found|missing|absent|unsupported|no support|not supported)/.test(s)) return 'not found';
  if (/^(stronger|overstat|overclaim|too strong|exaggerat)/.test(s)) return 'stronger';
  if (/^(supported|ok|pass|consistent|matches)/.test(s)) return 'supported';
  return '';
}
// A quote as written by the model, without the wrapping quotes, a "12: " line prefix or an ellipsis at its ends.
function fdCleanQuote(q) {
  let s = fdStr(q).replace(/^\d+\s*:\s+/, '');
  s = s.replace(/^["'«“„‘]+|["'»”’]+$/g, '').trim();
  return s.replace(/^(?:\.\.\.|…)\s*|\s*(?:\.\.\.|…)$/g, '').trim();
}
function fdAbsence(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.trim() ? { where: '', expected: v.trim(), checked: '' } : null;
  if (typeof v !== 'object') return null;
  const a = { where: fdStr(v.where || v.section || v.location), expected: fdStr(v.expected || v.missing || v.what), checked: fdStr(v.checked || v.searched || v.looked) };
  return a.where || a.expected || a.checked ? a : null;
}
function fdEvidence(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.trim() ? { quote: fdCleanQuote(v), line: null } : null;
  if (typeof v !== 'object') return null;
  const e = { quote: fdCleanQuote(v.quote || v.text), line: fdLine(v.line) };
  return e.quote || e.line ? e : null;
}
// One finding in the panel's shape, or null when it says nothing (no quote, absence or detail).
function fdFinding(o) {
  if (typeof o === 'string') return o.trim() ? { severity: 'minor', criterion: '', quote: '', line: null, detail: o.trim(), action: '' } : null;
  if (!o || typeof o !== 'object') return null;
  const f = {
    severity: fdSeverity(o.severity || o.level || o.priority),
    criterion: fdStr(o.criterion || o.category || o.rubric || o.id || o.name).toLowerCase(),
    quote: fdCleanQuote(o.quote || o.excerpt || o.text),
    line: fdLine(o.line != null ? o.line : o.line_number != null ? o.line_number : o.lineNumber),
    detail: fdStr(o.detail || o.problem || o.issue || o.description || o.comment || o.explanation || o.reason),
    action: fdStr(o.action || o.fix || o.suggestion || o.recommendation),
  };
  const absence = fdAbsence(o.absence);
  if (absence) f.absence = absence;
  const status = fdStatus(o.status || o.verdict);
  if (status) f.status = status;
  const evidence = fdEvidence(o.evidence);
  if (evidence) f.evidence = evidence;
  if (absence) f.quote = '';
  return f.quote || f.absence || f.detail ? f : null;
}
// "PASS" | "FAIL" | '' from a verdict the model wrote.
function fdVerdict(v) {
  if (v === true) return 'PASS';
  if (v === false) return 'FAIL';
  const s = fdStr(v).toLowerCase();
  if (/^(pass|ok|yes|met|good)/.test(s)) return 'PASS';
  if (/^(fail|no|not met|issue|problem)/.test(s)) return 'FAIL';
  return '';
}
// { id: 'PASS' | 'FAIL' } from an object of verdicts or a list of { criterion, result }.
function fdCriteria(c) {
  const out = {};
  if (Array.isArray(c)) {
    for (const x of c) {
      if (!x || typeof x !== 'object') continue;
      const id = fdStr(x.criterion || x.id || x.name || x.key).toLowerCase();
      const v = fdVerdict(x.result != null ? x.result : x.verdict != null ? x.verdict : x.status != null ? x.status : x.pass);
      if (id && v) out[id] = v;
    }
  } else if (c && typeof c === 'object') {
    for (const [k, x] of Object.entries(c)) {
      const v = fdVerdict(x && typeof x === 'object' ? x.result || x.verdict || x.status : x);
      if (v) out[k.trim().toLowerCase()] = v;
    }
  }
  return out;
}
// The model's answer as { ok, findings, criteria } (ok false, with error and the raw text, when no findings list or
// verdicts could be read from it).
function parseFindings(raw) {
  const v = parseJsonLoose(raw);
  const fail = { ok: false, error: FINDINGS_PARSE_ERROR, raw: String(raw == null ? '' : raw), findings: [], criteria: {} };
  if (!v) return fail;
  let list = null;
  if (Array.isArray(v)) list = v;
  else {
    const key = FINDING_LIST_KEYS.find((k) => Array.isArray(v[k]));
    if (key) list = v[key];
    else if (v.quote || v.absence || v.detail) list = [v]; // one finding on its own
  }
  const criteria = Array.isArray(v) ? {} : fdCriteria(v.criteria || v.rubric || v.verdicts);
  if (!list && !Object.keys(criteria).length) return fail;
  return { ok: true, findings: (list || []).map(fdFinding).filter(Boolean), criteria };
}

// ---- Verification -------------------------------------------------------------------------------------------
const fdLineAt = (hay, at) => { let n = 1; for (let i = hay.indexOf('\n'); i >= 0 && i < at; i = hay.indexOf('\n', i + 1)) n++; return n; };
const fdWordCount = (s) => (String(s).match(/[\p{L}\p{N}]+/gu) || []).length;
// The hits of a quote in the text: the quote itself (exact, then normalized: spaces, quotes, dashes, look-alike
// letters), else its longest part of 4+ words when the model elided the middle with "…".
function fdQuoteHits(hay, quote) {
  if (!quote) return [];
  const whole = findFlexible(hay, quote);
  if (whole.length) return whole;
  const parts = quote.split(/\s*(?:\.\.\.|…)\s*/).map((p) => p.trim()).filter((p) => fdWordCount(p) >= 4).sort((a, b) => b.length - a.length);
  for (const p of parts) {
    const hits = findFlexible(hay, p);
    if (hits.length) return hits;
  }
  return [];
}
// { verified, line, claimedLine }: the hit nearest the line the model gave decides the line.
function fdLocateQuote(hay, quote, claimed) {
  const hits = fdQuoteHits(hay, quote);
  if (!hits.length) return { verified: false, line: claimed, claimedLine: claimed };
  const lines = hits.map((h) => fdLineAt(hay, h.at));
  const best = claimed == null ? lines[0] : lines.reduce((a, b) => (Math.abs(b - claimed) < Math.abs(a - claimed) ? b : a));
  return { verified: true, line: best, claimedLine: claimed };
}
// Copies of the findings with verified / line (and the same on their evidence) against the document text.
function verifyFindings(findings, text) {
  const hay = String(text == null ? '' : text);
  return findings.map((f) => {
    const out = { ...f };
    if (f.quote) Object.assign(out, fdLocateQuote(hay, f.quote, f.line));
    if (f.evidence && f.evidence.quote) out.evidence = { ...f.evidence, ...fdLocateQuote(hay, f.evidence.quote, f.evidence.line) };
    return out;
  });
}

// ---- Order, Markdown, card ------------------------------------------------------------------------------------
// 'critical' | 'major' | 'minor' | 'ok' (a supported claim) | 'unverified' (its quote is not in the document).
function findingGroup(f) {
  if (f.quote && f.verified === false) return 'unverified';
  if (f.status === 'supported') return 'ok';
  return f.severity;
}
const fdGroupRank = (f) => FINDING_GROUPS.findIndex((g) => g[0] === findingGroup(f));
// By group, then by line (findings without one last), then as the model listed them.
function sortFindings(list) {
  const line = (f) => (f.line == null ? Infinity : f.line);
  return list.map((f, i) => ({ f, i })).sort((a, b) => fdGroupRank(a.f) - fdGroupRank(b.f) || line(a.f) - line(b.f) || a.i - b.i).map((x) => x.f);
}
// The findings a fix can address: a verified quote, not a supported claim.
const flaggedFindings = (list) => list.filter((f) => f.quote && f.verified && ['critical', 'major', 'minor'].includes(findingGroup(f)));

const fdCriterionLabel = (id, labels) => (labels && labels[id]) || id || 'General';
const FINDING_STATUS_TEXT = { supported: 'Supported by the results', stronger: 'Stronger than the results', 'not found': 'Not found in the results' };
const fdLineText = (f) => (f.line == null ? '' : f.verified === false ? `line ${f.line}?` : `line ${f.line}`);
function fdAbsenceText(a) {
  const parts = [a.expected ? `Missing: ${a.expected}` : 'Missing'];
  if (a.where) parts.push(`looked in ${a.where}`);
  if (a.checked) parts.push(`checked ${a.checked}`);
  return parts.join('; ');
}
function fdEvidenceText(e) {
  if (!e) return '';
  const where = e.line != null ? `line ${e.line}${e.verified === false ? '?' : ''}` : '';
  return `Checked against ${where}${where && e.quote ? ': ' : ''}${e.quote ? `«${e.quote}»` : ''}`;
}
// "2 critical, 3 major, 1 minor, 4 supported, 1 unverified" (empty groups left out).
function fdGroupCounts(list) {
  const n = {};
  for (const f of list) n[findingGroup(f)] = (n[findingGroup(f)] || 0) + 1;
  return FINDING_GROUPS.filter(([k]) => n[k]).map(([k]) => `${fmtNum(n[k])} ${k === 'ok' ? 'supported' : k}`).join(', ');
}
const fdCriteriaLine = (criteria, labels) => Object.entries(criteria || {}).map(([id, v]) => `${fdCriterionLabel(id, labels)}: ${v}`).join('; ');

// The Markdown of a findings result (Copy, and the answer stored in the chat). opts: { title (heading), labels
// ({ id: label }) }.
function findingsMarkdown(result, { title = 'Findings', labels = null } = {}) {
  const list = result.findings || [];
  const out = [`**${title}**: ${list.length ? fdGroupCounts(list) : 'no findings'}`];
  const crit = fdCriteriaLine(result.criteria, labels);
  if (crit) out.push(`Criteria: ${crit}`);
  let n = 0;
  for (const [k, label] of FINDING_GROUPS) {
    const group = list.filter((f) => findingGroup(f) === k);
    if (!group.length) continue;
    out.push('', `**${label}**`);
    for (const f of group) {
      const where = [fdCriterionLabel(f.criterion, labels), fdLineText(f)].filter(Boolean).join(', ');
      const what = f.absence ? fdAbsenceText(f.absence) : `«${f.quote}»`;
      const rest = [f.status ? FINDING_STATUS_TEXT[f.status] + '.' : '', fdEvidenceText(f.evidence), f.detail, f.action ? `Fix: ${f.action}` : '']
        .filter(Boolean).join(' ');
      out.push(`${++n}. ${where}: ${what}${rest ? ' ' + rest : ''}`);
    }
  }
  return out.join('\n');
}

// The line link of a finding: a button that brings the line into view in the Docs tab (only on click, and only when
// the tab bridge can: scrollToLine), else plain text.
function fdLineLink(line, text, verified) {
  if (line == null) return null;
  if (!verified || typeof scrollToLine !== 'function') {
    const s = document.createElement('span');
    s.className = 'st-ms finding-line';
    s.textContent = verified ? `line ${line}` : `line ${line}?`;
    return s;
  }
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn small ghost finding-line';
  b.textContent = `line ${line}`;
  b.title = 'Show this line in the document';
  b.addEventListener('click', () => { try { scrollToLine(line, text); } catch (e) { /* the tab may be gone */ } });
  return b;
}
const fdDiv = (cls, text) => { const d = document.createElement('div'); d.className = cls; if (text != null) d.textContent = text; return d; };
function fdRow(f, labels) {
  const g = findingGroup(f);
  const row = fdDiv(`st-row finding finding-${g}${g === 'critical' || g === 'unverified' ? ' st-fail' : ''}`);
  const icon = document.createElement('span');
  icon.className = 'st-icon';
  icon.textContent = FINDING_GROUPS.find((x) => x[0] === g)[2];
  const name = document.createElement('span');
  name.className = 'st-name';
  name.textContent = fdCriterionLabel(f.criterion, labels);
  row.append(icon, ' ', name);
  const link = fdLineLink(f.line, f.quote, !!f.verified);
  if (link) row.append(' ', link);
  if (g === 'unverified') row.appendChild(fdDiv('st-detail finding-note', 'unverified: quote not found'));
  row.appendChild(fdDiv('st-detail finding-quote', f.absence ? fdAbsenceText(f.absence) : `«${f.quote}»`));
  if (f.status) row.appendChild(fdDiv('st-detail finding-status', FINDING_STATUS_TEXT[f.status]));
  if (f.evidence) {
    const ev = fdDiv('st-detail finding-evidence', 'Checked against ');
    const evLink = fdLineLink(f.evidence.line, f.evidence.quote, !!f.evidence.verified);
    if (evLink) ev.appendChild(evLink);
    if (f.evidence.quote) ev.append(` «${f.evidence.quote}»`);
    row.appendChild(ev);
  }
  if (f.detail) row.appendChild(fdDiv('st-detail finding-detail', f.detail));
  if (f.action) row.appendChild(fdDiv('st-detail finding-action', `Fix: ${f.action}`));
  return row;
}
// The card of a findings result (not appended): a head line, the criteria, the findings by group, and the actions
// row with Copy (data-act copy-msg of main.js: it copies _text of the enclosing .msg, set by the caller) and
// opts.actions (extra elements). opts: { title, labels }.
function findingsCard(result, { title = 'Findings', labels = null, actions = [] } = {}) {
  const list = result.findings || [];
  const card = fdDiv('selftest findings-card');
  card.appendChild(fdDiv('st-head', `📋 ${title}`));
  card.appendChild(fdDiv('st-sub', list.length ? fdGroupCounts(list) : 'No findings.'));
  const crit = Object.entries(result.criteria || {});
  if (crit.length) {
    const box = fdDiv('st-sub finding-criteria');
    box.innerHTML = crit.map(([id, v]) => `<span class="${v === 'FAIL' ? 'st-fail' : 'st-pass'}">${escapeHtml(fdCriterionLabel(id, labels))}: ${escapeHtml(v)}</span>`).join(' · ');
    card.appendChild(box);
  }
  const rows = fdDiv('st-rows');
  for (const f of list) rows.appendChild(fdRow(f, labels));
  card.appendChild(rows);
  const bar = fdDiv('tool-actions st-actions');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn small';
  copy.dataset.act = 'copy-msg';
  copy.title = 'Copy the findings as Markdown';
  copy.textContent = 'Copy';
  bar.appendChild(copy);
  for (const a of actions) bar.appendChild(a);
  card.appendChild(bar);
  return card;
}

// Runs fn once the panel is idle (a turn re-renders the chat at its end, which would drop what fn adds earlier).
function findingsWhenIdle(fn, tries = 1200) {
  if (!state.busy) { fn(); return; }
  if (tries > 0) setTimeout(() => findingsWhenIdle(fn, tries - 1), 50);
}
