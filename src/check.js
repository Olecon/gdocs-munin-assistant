'use strict';
// Module check.js: /check, the pre-submission report (no model call but the journal limits of doc-checks.js): runCheck
// reads the open document (the Docs API line model, or the export), runs the deterministic checks of check-text.js (and the open comments through
// docs-comments.js), shows a report card grouped by check with a line link per finding (scrollToLine, tab-bridge.js),
// then, with the References grant, checks the reference list against Crossref and OpenAlex (check-refs.js) with a
// progress line and Cancel; without it the group has Allow lookups (Chrome's prompt, then the same check). The card is a report box like the self-test's (not stored, gone on a re-render); Copy
// report copies its Markdown (checkMarkdown, the self-test's copy action). With the Docs API, an Error or Warning entry whose
// Crossref record is known has "Replace with the Crossref record" (checkReplaceEntry): one replace_text through runWriteTool
// (the gate, the verified write, the undo journal), recorded in the chat as a short exchange so its card has Undo.
// The passes of doc-checks.js add their groups (leftovers, consistent forms with Apply, the abstract and limitations,
// wordy phrases, the journal limits of an attached guidelines file, the density block); a finding of theirs shows its
// rule id in a fold, and DOC.md's "Checks:" line (checkIgnores) silences rule ids and accepted terms in every group.
// Apply rewrites the finding's lines in one edit_document call through the same write path as Replace.
/* global addError, appendToChat, checkIgnores, checkRuleIgnored, DC_BATCH_LINES, DC_GROUPS, docChecks, journalLimitsFor, applyPendingSelection, CHAT_WAIT_STATUS, CK_GROUPS, CK_REF_MAX, checkDocument, ckCitationStyle,
   ckDocument, ckEntryPrefix, ckFormatCsl, ckOpenAlexAllowed, ckSortFindings, ckVerifyReferences, closePopup, commentPlace, crossrefMeta,
   docIdFromUrl, docStatusText, el, escapeHtml, grantReferences, fetchComments, fetchDocText, getDocTab, holdChatLock, OBJECT_CHAR, readChatForTurn,
   referencesOn, refreshContext, renderHistoryKeepingUnstored, resetDocsApiTurn, runWriteTool, saveHistory, scrollToLine, setBusy,
   setStatus, snapshotDocument, state, takeSnapshot, useDocModel */
/* exported runCheck, checkMarkdown, checkCard, checkReport, CHECK_MARKS, checkReplaceEntry, checkCanReplace, checkGroupList, checkApplyFix,
   checkFixOps, checkCardWrite, checkItemHtml, checkFindingOf, checkDate */

// The severity's mark: a coloured dot (CSS .mk); the severity is also written out. No emoji.
const CHECK_MARKS = { error: 'fail', warning: 'warn', note: 'note' };
const CHECK_REF_LABEL = { error: 'Error', warning: 'Warning', unverified: 'Unverified', suspect: 'Suspect' };
const CHECK_REF_SEVERITY = { error: 'error', warning: 'warning', unverified: 'note', suspect: 'warning' };
const checkDate = (ms) => { const d = new Date(ms); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const checkPlural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// The open comment threads as [{ line, text, where }] for ckBlind, or { error }.
async function checkComments(model) {
  try {
    const snap = { model, comments: null };
    const data = await fetchComments(snap);
    return (data.comments || []).filter((t) => String(t.status || 'OPEN').toUpperCase() === 'OPEN').map((t) => {
      const place = commentPlace(model, data, t);
      return { line: place.from || 0, text: ((t.headPost || {}).content || '').trim(), where: place.where };
    });
  } catch (e) {
    return { error: e.status === 400 ? 'Google refused the comments view (HTTP 400).' : e.message };
  }
}

// The report of a document source ({ model } or { text, format }): { at, title, docId, format, groups, entries, budget,
// density, lineText (line -> text, for the line links and Apply), reflist }. Pure apart from the comments and the journal
// limits (journalLimitsFor's record), which the caller passes. DOC.md's "Checks:" line silences rule ids in every group.
function checkReport(src, { title = '', docId = '', instructions = '', comments, limits = null, at = Date.now() } = {}) {
  const doc = ckDocument(src);
  const res = checkDocument(doc, { instructions, comments });
  const ignore = checkIgnores(instructions);
  const extra = docChecks(doc, { model: src.model || null, instructions, terms: ignore.terms, limits, entries: res.entries, budget: res.budget });
  const groups = { ...res.groups, ...extra.groups };
  for (const id of Object.keys(groups)) groups[id] = groups[id].filter((f) => !checkRuleIgnored(ignore.rules, f.rule || f.kind));
  const density = checkRuleIgnored(ignore.rules, 'density') ? null : extra.density;
  const lineText = new Map(doc.lines.map((l) => [l.line, l.text]));
  return { at, title, docId, format: doc.format, ...res, groups, density, lineText, reflist: { state: 'off', done: 0, total: 0, results: [] } };
}
// The report's groups in order: check-text.js's, each followed by the doc-checks.js groups placed after it (an optional
// group only when its pass ran: report.groups has it).
function checkGroupList(report) {
  const out = [];
  const place = (id) => {
    for (const g of DC_GROUPS.filter((x) => x.after === id)) {
      if (!g.optional || (report && report.groups[g.id])) out.push(g);
      place(g.id);
    }
  };
  for (const g of CK_GROUPS) { out.push(g); place(g.id); }
  return out;
}

// The reference-list group from the lookup state: the findings of the entries that do not match, a summary note.
function checkRefFindings(rl) {
  if (rl.state === 'off') return [{ group: 'reflist', kind: 'ref-off', severity: 'note', line: 0, text: rl.note || 'Not checked: reference lookups through Crossref and OpenAlex are not allowed yet.' }];
  if (rl.state === 'none') return [{ group: 'reflist', kind: 'ref-none', severity: 'note', line: 0, text: rl.note || 'No reference list to check.' }];
  const out = [];
  rl.results.forEach((r, i) => {
    if (r.verdict === 'ok') return;
    const e = r.entry;
    out.push({ group: 'reflist', kind: 'ref-' + r.verdict, severity: CHECK_REF_SEVERITY[r.verdict], line: e.l.line, at: 0, len: e.l.text.length,
      text: `${CHECK_REF_LABEL[r.verdict]}: ${checkEntryLabel(e)}. ${r.text}`, ...(checkCanReplace(r) ? { replace: i, replaced: !!r.replaced } : {}) });
  });
  const sorted = ckSortFindings(out);
  if (rl.state === 'done' || rl.state === 'stopped') {
    const ok = rl.results.filter((r) => r.verdict === 'ok').length;
    const n = rl.results.length;
    const parts = [];
    if (rl.state === 'stopped') parts.push(`Stopped after ${n} of ${checkPlural(rl.total, 'entry', 'entries')}`);
    if (n) parts.push(`${ok} of ${checkPlural(n, 'entry', 'entries')} match${n === 1 ? 'es' : ''} Crossref or OpenAlex`);
    if (rl.skipped) parts.push(`${rl.skipped} more not checked (at most ${CK_REF_MAX})`);
    if (rl.note) parts.push(rl.note);
    const text = parts.join('; ');
    sorted.push({ group: 'reflist', kind: 'ref-summary', severity: 'note', line: 0, text: text.charAt(0).toUpperCase() + text.slice(1) + '.' });
  }
  return sorted;
}
const checkEntryLabel = (e) => `${e.n != null ? `[${e.n}] ` : ''}${e.surname || e.text.slice(0, 30)}${e.year ? ` (${e.year})` : ''}`;
// An Error or Warning entry whose Crossref record is known (a Crossref record, or a found work with a DOI) can be replaced.
const checkCanReplace = (r) => (r.verdict === 'error' || r.verdict === 'warning') && !!r.work && (r.work.source === 'Crossref' ? !!r.work.csl : !!r.work.doi);
// The density block is no list of findings: it is drawn on its own and not counted.
const checkGroupFindings = (report, id) => (id === 'reflist' ? checkRefFindings(report.reflist) : id === 'density' ? [] : report.groups[id] || []);
const checkDensityLines = (report) => (report.density ? report.density.lines : []);
function checkCounts(report) {
  const n = { error: 0, warning: 0, note: 0 };
  for (const g of checkGroupList(report)) for (const f of checkGroupFindings(report, g.id)) n[f.severity]++;
  return n;
}
const checkSummary = (report) => { const n = checkCounts(report); return `${checkPlural(n.error, 'error')}, ${checkPlural(n.warning, 'warning')}, ${checkPlural(n.note, 'note')}`; };
const CHECK_FORMAT_LABEL = { 'docs-api': 'Docs API', markdown: 'export (Markdown)', text: 'export (plain text)' };
const checkFormatNote = (report) => (report.format === 'docs-api' ? '' : 'Read through the export: no suggestions, comments or table structure; connect a Google account for the full check.');

// The whole report as Markdown (Copy report).
function checkMarkdown(report) {
  const out = ['## Munin check', '', `- Date: ${checkDate(report.at)}`, `- Document: «${report.title}» (${report.docId}) · ${CHECK_FORMAT_LABEL[report.format]}`];
  const note = checkFormatNote(report);
  if (note) out.push(`- ${note}`);
  out.push('', `**Summary:** ${checkSummary(report)}`);
  for (const g of checkGroupList(report)) {
    const list = checkGroupFindings(report, g.id);
    out.push('', `### ${g.title}`, '');
    if (g.id === 'density') {
      const lines = checkDensityLines(report);
      if (!lines.length) out.push('- Nothing to measure (no section of 40 words or more).');
      for (const d of lines) out.push(`${d.quote ? '  ' : ''}- ${d.text}`);
      continue;
    }
    if (g.id === 'reflist' && report.reflist.state === 'running') out.push(`- Checking ${report.reflist.done} of ${report.reflist.total}…`);
    if (!list.length) { if (!(g.id === 'reflist' && report.reflist.state === 'running')) out.push('- Nothing found.'); continue; }
    for (const f of list) out.push(`- ${f.severity}${f.line ? ` · line ${f.line}` : ''} · ${f.text}${f.rule ? ` (${f.rule})` : ''}`);
  }
  return out.join('\n') + '\n';
}

function checkItemHtml(f, report) {
  const link = f.line ? `<button type="button" class="ck-line" data-line="${f.line}" data-tip="Show in the document">line ${f.line}</button> ` : '';
  const replace = f.replace != null && report && report.format === 'docs-api'
    ? ` <button type="button" class="btn small ck-replace" data-ref="${f.replace}"${f.replaced ? ' disabled' : ''} data-tip="${f.severity === 'error' ? 'Rewrite from the DOI' : 'Rewrite from Crossref'}">${f.replaced ? 'Replaced' : 'Replace with the Crossref record'}</button>` : '';
  const allow = f.kind === 'ref-off' ? ' <button type="button" class="btn small ck-allow" data-tip="Chrome asks once">Allow lookups</button>' : '';
  const where = f._ref ? ` data-group="${f.group}" data-i="${f._ref}"` : '';
  const apply = f.fix && f._ref && report && report.format === 'docs-api'
    ? ` <button type="button" class="btn small ck-apply"${where}${f.applied ? ' disabled' : ''}>${f.applied ? 'Applied' : 'Apply'}</button>` : '';
  // A finding of doc-checks.js: its text opens a fold with the details and the rule id (the name DOC.md's Checks line takes).
  const text = f.rule
    ? `<button type="button" class="ck-text ck-fold-toggle"${where} aria-expanded="${f._open ? 'true' : 'false'}">${escapeHtml(f.text)}</button>`
    : `<span class="ck-text">${escapeHtml(f.text)}</span>`;
  const fold = f.rule && f._open
    ? `<div class="ck-fold">${(f.detail || []).map((d) => `<div>${escapeHtml(d)}</div>`).join('')}<div class="ck-rule">Rule: ${escapeHtml(f.rule)}</div></div>` : '';
  return `<div class="ck-item ck-${f.severity}"><span class="ck-sev mk ${CHECK_MARKS[f.severity]}" role="img" aria-label="${f.severity}" data-tip="${f.severity}"></span> ${link}${text}${replace}${allow}${apply}${fold}</div>`;
}
function checkDensityHtml(report) {
  const lines = checkDensityLines(report);
  if (!lines.length) return '<div class="ck-item ck-none">Nothing to measure (no section of 40 words or more).</div>';
  return lines.map((d) => `<div class="ck-item ck-density${d.quote ? ' ck-quote' : ''}">${d.quote ? '' : `<button type="button" class="ck-line" data-line="${d.line}" data-tip="Show in the document">line ${d.line}</button> `}${escapeHtml(d.text)}</div>`).join('');
}
// The finding a button of the card names (data-group, data-i: its index + 1 in the group).
const checkFindingOf = (report, btn) => (report.groups[btn.dataset.group] || [])[Number(btn.dataset.i) - 1] || null;
function checkInnerHtml(report) {
  const head = `<div class="ck-head">Check · ${escapeHtml(checkDate(report.at))} · «${escapeHtml(report.title)}» · ${escapeHtml(CHECK_FORMAT_LABEL[report.format])}</div>`;
  const note = checkFormatNote(report);
  const groups = checkGroupList(report).map((g) => {
    const list = checkGroupFindings(report, g.id);
    list.forEach((f, i) => { if (f.rule && report.groups[g.id] === list) f._ref = i + 1; });
    const running = g.id === 'reflist' && report.reflist.state === 'running';
    const progress = running ? `<div class="ck-progress">Checking ${report.reflist.done} of ${report.reflist.total}… <button type="button" class="btn small ck-cancel">Cancel</button></div>` : '';
    const body = g.id === 'density' ? checkDensityHtml(report)
      : list.length ? list.map((f) => checkItemHtml(f, report)).join('') : running ? '' : '<div class="ck-item ck-none">Nothing found.</div>';
    const n = list.filter((f) => f.severity !== 'note').length;
    return `<div class="ck-group" data-group="${g.id}"><div class="ck-group-head">${escapeHtml(g.title)}${n ? ` <span class="ck-count">${n}</span>` : ''}</div>${progress}${body}</div>`;
  }).join('');
  return head + (note ? `<div class="ck-sub">${escapeHtml(note)}</div>` : '') + groups +
    `<div class="ck-summary">${escapeHtml(checkSummary(report))}</div>` +
    '<div class="tool-actions ck-actions"><button class="btn small" type="button" data-act="copy-selftest" data-tip="Copy as Markdown">Copy report</button></div>';
}
// (Re)paints the card from the report; the Markdown for Copy report follows. A card of another report (/polish) paints
// itself (card._paint), so checkCardWrite serves both.
function checkPaint(card) {
  if (card._paint) { card._paint(card); return; }
  card.innerHTML = checkInnerHtml(card._check);
  card._report = checkMarkdown(card._check);
}
// The report card in the chat: a report box (renderHistory drops it), never stored. A line link scrolls the Docs tab to
// its line (on click only); Cancel stops the reference lookups (card._cancel).
function checkCard(report) {
  const d = document.createElement('div');
  d.className = 'msg report check-report';
  d._check = report;
  checkPaint(d);
  d.addEventListener('click', (ev) => {
    const link = ev.target.closest && ev.target.closest('button.ck-line');
    if (link) { const n = Number(link.dataset.line); scrollToLine(n, report.lineText.get(n) || ''); return; }
    const cancel = ev.target.closest && ev.target.closest('button.ck-cancel');
    if (cancel && d._cancel) { cancel.disabled = true; d._cancel(); return; }
    const replace = ev.target.closest && ev.target.closest('button.ck-replace');
    if (replace && !replace.disabled) { checkReplaceEntry(d, Number(replace.dataset.ref), replace); return; }
    const allow = ev.target.closest && ev.target.closest('button.ck-allow');
    if (allow && !allow.disabled) { checkAllowLookups(d, allow); return; }
    const fold = ev.target.closest && ev.target.closest('button.ck-fold-toggle');
    if (fold) { const f = checkFindingOf(report, fold); if (f) { f._open = !f._open; checkPaint(d); } return; }
    const apply = ev.target.closest && ev.target.closest('button.ck-apply');
    if (apply && !apply.disabled) { const f = checkFindingOf(report, apply); if (f) checkApplyFix(d, f, apply); }
  });
  return appendToChat(d);
}

// The reference-list phase: one lookup at a time, the card repainted after each entry.
async function checkReferenceList(card, signal) {
  const report = card._check;
  const rl = report.reflist;
  if (!report.entries.length) { Object.assign(rl, { state: 'none', note: 'No reference list found.' }); checkPaint(card); return; }
  const openAlex = await ckOpenAlexAllowed();
  Object.assign(rl, { state: 'running', done: 0, total: Math.min(report.entries.length, CK_REF_MAX) });
  rl.note = openAlex ? '' : 'OpenAlex is not allowed, so only Crossref was searched';
  checkPaint(card);
  const results = await ckVerifyReferences(report.entries, {
    signal, openAlex,
    onProgress: (done, total) => {
      rl.done = done; rl.total = total;
      setStatus(`Check: reference ${Math.min(done + 1, total)} of ${total}…`);
      checkPaint(card);
    },
  });
  Object.assign(rl, { state: results.stopped ? 'stopped' : 'done', results, skipped: results.skipped });
  checkPaint(card);
}

// /check: the report on the open document. Busy while it runs; Stop (or Cancel in the card) ends the reference lookups.
async function runCheck() {
  if (state.busy) return null;
  setBusy(true);
  const abort = new AbortController();
  state.abort = abort;
  el.input.value = '';
  closePopup();
  let card = null;
  try {
    if (state.loadingCtx) await state.loadingCtx;
    const tab = await getDocTab();
    if (docIdFromUrl(tab.url) !== state.docId) await refreshContext();
    if (state.loadingCtx) await state.loadingCtx;
    state.pinnedTabId = tab.id;
    setStatus('Check: reading the document…');
    resetDocsApiTurn();
    await fetchDocText();
    if (abort.signal.aborted) return null;
    if (state.docText == null) throw new Error(`Could not read the document: ${state.docError || 'no text'}.`);
    const model = state.docFormat === 'docs-api' ? state.docModel : null;
    const comments = model ? await checkComments(model) : undefined;
    const src = model ? { model } : { text: state.docText, format: state.docFormat };
    // An attached author-guidelines file: its limits (one quiet request to the chat's provider when not stored yet).
    const limits = await journalLimitsFor({ docId: state.docId, files: state.docFiles, snap: takeSnapshot(), signal: abort.signal, onStatus: setStatus });
    if (abort.signal.aborted) return null;
    const report = checkReport(src, { title: state.docTitle || '', docId: state.docId || '', instructions: state.docInstructions || '', comments, limits });
    card = checkCard(report);
    card._cancel = () => abort.abort();
    if (referencesOn() || !report.entries.length) await checkReferenceList(card, abort.signal);
    else checkPaint(card);
    return report;
  } catch (e) {
    addError(`Check: ${e.message || e}`);
    return null;
  } finally {
    if (card) card._cancel = null;
    if (card) checkPaint(card);
    state.abort = null;
    state.pinnedTabId = null;
    setBusy(false);
    applyPendingSelection();
    setStatus(docStatusText(), state.docText == null);
  }
}

// Allow lookups (the reference-list group without the grant): Chrome's prompt first (it needs the click's user gesture),
// then the list is checked as /check does, busy, with Stop and Cancel. Returns whether the list was checked.
async function checkAllowLookups(card, btn) {
  if (state.busy) { addError('Wait until the current answer is finished, then click Allow lookups again.'); return false; }
  btn.disabled = true;
  const rl = card._check.reflist;
  if (!(await grantReferences())) {
    rl.note = 'Not checked: Chrome did not allow the lookups. Click Allow lookups to try again.';
    checkPaint(card);
    return false;
  }
  if (state.busy) return false;
  rl.note = '';
  setBusy(true);
  const abort = new AbortController();
  state.abort = abort;
  card._cancel = () => abort.abort();
  try {
    await checkReferenceList(card, abort.signal);
    return true;
  } catch (e) {
    addError(`Check: ${e.message || e}`);
    return false;
  } finally {
    card._cancel = null;
    checkPaint(card);
    state.abort = null;
    setBusy(false);
    setStatus(docStatusText(), state.docText == null);
  }
}

// ---- Replace with the Crossref record --------------------------------------------------------------------------------------
// The entry's line in the model read now: the line of the report if its text is unchanged, else the one line with that text.
function checkEntryLine(model, entry) {
  const flat = (l) => String(l.text || '').replaceAll('\u000b', ' ').replace(new RegExp(OBJECT_CHAR, 'g'), ' ');
  const want = entry.l.text;
  const at = model.lines[entry.l.line - 1];
  if (at && flat(at) === want) return at;
  const same = model.lines.filter((l) => flat(l) === want);
  return same.length === 1 ? same[0] : null;
}
// A write from the card: owns the chat like a turn (the chat lock, the stored history), reads the document, lets
// job.plan(model) build the call ({ name, args, user, answer }; it throws with what to do when the document changed),
// runs it through runWriteTool (the gate, the verified write, the undo journal) and records it as a user request, the
// call and its result, and a one-line answer, so the edit card has Undo and the model sees what happened. job: { plan,
// done, label (the error prefix, "Replace" / "Apply"), busy (the status line) }. Returns true when the edit was made.
async function checkCardWrite(card, btn, job) {
  const report = card._check;
  if (state.busy || state.undoing) { addError(`Wait until the current answer is finished, then click ${job.label} again.`); return false; }
  if (!state.googleConnected) { addError('Connect a Google account in Settings to edit the document.', true); return false; }
  const snap = takeSnapshot();
  setBusy(true);
  const abort = new AbortController();
  state.abort = abort;
  snap.signal = abort.signal;
  if (btn) btn.disabled = true;
  let release = null;
  let done = false;
  try {
    const tab = await getDocTab();
    if (docIdFromUrl(tab.url) !== report.docId || state.docId !== report.docId || !state.chatId) throw new Error('This report is about another document. Run /check again.');
    const { docId, chatId } = state;
    state.pinnedTabId = tab.id;
    release = await holdChatLock(docId, chatId, { signal: abort.signal, onWait: () => setStatus(CHAT_WAIT_STATUS) });
    if (!(await readChatForTurn(docId, chatId))) return false;
    setStatus('Reading the document…');
    resetDocsApiTurn();
    await fetchDocText();
    snapshotDocument(snap);
    snap.chatCtx = { docId, chatId, messages: state.messages };
    if (snap.docFormat !== 'docs-api' || !snap.model) throw new Error('The document could not be read through the Google Docs API. Check the Google account in Settings.');
    const call = await job.plan(snap.model);
    const id = 'check_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setStatus(job.busy);
    // The number and provenance checks refuse a first write that drops or brings numbers, and let the identical call
    // through: the click is that decision (Replace: the numbers of the Crossref record; Apply: "three" for "3").
    let res = null;
    for (let k = 0; k < 3 && (!res || /^Refused by a check/.test(String(res.content))); k++) res = await runWriteTool(call.name, call.args, snap, id, { args: call.args });
    if (!res._ok) throw new Error(String(res.content || res._message).replace(/^Error: /, ''));
    const tc = { id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } };
    state.messages.push(
      { role: 'user', content: call.user },
      { role: 'assistant', content: '', tool_calls: [tc] },
      { role: 'tool', tool_call_id: id, ...res },
      { role: 'assistant', content: call.answer },
    );
    await saveHistory(snap.chatCtx);
    useDocModel(snap.model);
    job.done();
    done = true;
    renderHistoryKeepingUnstored();
    return true;
  } catch (e) {
    if (!(e && e.name === 'AbortError')) addError(`${job.label}: ${e.message || e}`);
    return false;
  } finally {
    if (release) release();
    if (btn && !done) btn.disabled = false;
    checkPaint(card);
    state.abort = null;
    state.pinnedTabId = null;
    setBusy(false);
    applyPendingSelection();
    setStatus(docStatusText(), state.docText == null);
  }
}

// Replace with the Crossref record: rewrites the entry's line as a plain-text entry in the document's dominant style
// (keeping its number) with replace_text.
async function checkReplaceEntry(card, i, btn) {
  const report = card._check;
  const r = report.reflist.results[i];
  if (!r || r.replaced || !checkCanReplace(r)) return false;
  return checkCardWrite(card, btn, {
    label: 'Replace', busy: 'Replacing the reference entry…',
    plan: async (model) => {
      const line = checkEntryLine(model, r.entry);
      if (!line) throw new Error('The reference entry changed since the check. Run /check again.');
      const csl = r.work.csl || await crossrefMeta(r.work.doi);
      const style = ckCitationStyle(report.entries);
      const label = checkEntryLabel(r.entry);
      return {
        name: 'replace_text', args: { old_text: line.text, new_text: ckEntryPrefix(line.text) + ckFormatCsl(csl, style) },
        user: `Replace the reference entry ${label} (line ${line.line}) with its Crossref record.`,
        answer: `Replaced the reference entry ${label} with its Crossref record (${style === 'numeric' ? 'numeric' : 'author-year'} style, from the /check report).`,
      };
    },
    done: () => { r.replaced = true; },
  });
}

// ---- Apply: a mechanical fix of a doc-checks.js finding -------------------------------------------------------------------
// The edit_document operations of a fix on the model read now: one replace per line (the whole line as old_text, the
// line given, so equal lines elsewhere do not matter; precise replacement rewrites only the changed words), at most
// DC_BATCH_LINES lines. The line must read as in the report, else { error }. { ops, count, lines } otherwise.
function checkFixOps(model, fix, lineText) {
  const flat = (t) => String(t || '').replaceAll('\u000b', ' ').replace(new RegExp(OBJECT_CHAR, 'g'), ' ');
  const byLine = new Map();
  for (const e of fix.edits) { if (!byLine.has(e.line)) byLine.set(e.line, []); byLine.get(e.line).push(e); }
  const lines = [...byLine.keys()].sort((a, b) => a - b).slice(0, DC_BATCH_LINES);
  const ops = [];
  let count = 0;
  for (const n of lines) {
    const l = model.lines[n - 1];
    if (!l || flat(l.text) !== lineText.get(n)) return { error: `Line ${n} changed since the check. Run /check again.` };
    let text = l.text;
    for (const e of byLine.get(n).slice().sort((a, b) => b.at - a.at)) { text = text.slice(0, e.at) + e.to + text.slice(e.at + e.len); count++; }
    if (text !== l.text) ops.push({ op: 'replace', old_text: l.text, new_text: text, line: n });
  }
  return { ops, count, lines, more: byLine.size - lines.length };
}
// The Apply button: the fix as one edit_document call through checkCardWrite. Returns true when it was written.
function checkApplyFix(card, f, btn) {
  if (!f || !f.fix || f.applied) return Promise.resolve(false);
  const report = card._check;
  return checkCardWrite(card, btn, {
    label: 'Apply', busy: 'Applying the fix…',
    plan: async (model) => {
      const r = checkFixOps(model, f.fix, report.lineText);
      if (r.error) throw new Error(r.error);
      if (!r.ops.length) throw new Error('Nothing to change: the document already reads so. Run /check again.');
      const where = `${r.lines.length === 1 ? 'line' : 'lines'} ${r.lines.join(', ')}`;
      const more = r.more ? `; ${r.more} more ${r.more === 1 ? 'line' : 'lines'} left, run /check again for them` : '';
      return {
        name: 'edit_document', args: { operations: r.ops },
        user: `Unify ${f.fix.label} on ${where} (${f.rule}, from the /check report).`,
        answer: `Unified ${f.fix.label}: ${r.count} ${r.count === 1 ? 'change' : 'changes'} on ${where}${more}.`,
      };
    },
    done: () => { f.applied = true; },
  });
}
