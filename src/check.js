'use strict';
// Module check.js: /check, the pre-submission report (no model call): runCheck reads the open document (the Docs API
// line model, or the export), runs the deterministic checks of check-text.js (and the open comments through
// docs-comments.js), shows a report card grouped by check with a line link per finding (scrollToLine, tab-bridge.js),
// then, with the References grant, checks the reference list against Crossref and OpenAlex (check-refs.js) with a
// progress line and Cancel; without it the group has Allow lookups (Chrome's prompt, then the same check). The card is a notice like the self-test's report (not stored, gone on a re-render); Copy
// report copies its Markdown (checkMarkdown, the self-test's copy action). With the Docs API, an Error or Warning entry whose
// Crossref record is known has "Replace with the Crossref record" (checkReplaceEntry): one replace_text through runWriteTool
// (the gate, the verified write, the undo journal), recorded in the chat as a short exchange so its card has Undo.
/* global addError, addNotice, appendToChat, applyPendingSelection, CHAT_WAIT_STATUS, CK_GROUPS, CK_REF_MAX, checkDocument, ckCitationStyle,
   ckDocument, ckEntryPrefix, ckFormatCsl, ckOpenAlexAllowed, ckSortFindings, ckVerifyReferences, closePopup, commentPlace, crossrefMeta,
   docIdFromUrl, docStatusText, el, escapeHtml, grantReferences, fetchComments, fetchDocText, getDocTab, holdChatLock, OBJECT_CHAR, readChatForTurn,
   referencesOn, refreshContext, renderHistoryKeepingNotices, resetDocsApiTurn, runWriteTool, saveHistory, scrollToLine, setBusy,
   setStatus, snapshotDocument, state, takeSnapshot, useDocModel */
/* exported runCheck, checkMarkdown, checkCard, checkReport, CHECK_ICONS, checkReplaceEntry, checkCanReplace */

const CHECK_ICONS = { error: '❌', warning: '⚠️', note: 'ℹ️' };
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
// lineText (line -> text, for the line links), reflist }. Pure apart from the comments, which the caller passes.
function checkReport(src, { title = '', docId = '', instructions = '', comments, at = Date.now() } = {}) {
  const doc = ckDocument(src);
  const res = checkDocument(doc, { instructions, comments });
  const lineText = new Map(doc.lines.map((l) => [l.line, l.text]));
  return { at, title, docId, format: doc.format, ...res, lineText, reflist: { state: 'off', done: 0, total: 0, results: [] } };
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
const checkGroupFindings = (report, id) => (id === 'reflist' ? checkRefFindings(report.reflist) : report.groups[id] || []);
function checkCounts(report) {
  const n = { error: 0, warning: 0, note: 0 };
  for (const g of CK_GROUPS) for (const f of checkGroupFindings(report, g.id)) n[f.severity]++;
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
  for (const g of CK_GROUPS) {
    const list = checkGroupFindings(report, g.id);
    out.push('', `### ${g.title}`, '');
    if (g.id === 'reflist' && report.reflist.state === 'running') out.push(`- Checking ${report.reflist.done} of ${report.reflist.total}…`);
    if (!list.length) { if (!(g.id === 'reflist' && report.reflist.state === 'running')) out.push('- Nothing found.'); continue; }
    for (const f of list) out.push(`- ${CHECK_ICONS[f.severity]} ${f.severity}${f.line ? ` · line ${f.line}` : ''} · ${f.text}`);
  }
  return out.join('\n') + '\n';
}

function checkItemHtml(f, report) {
  const link = f.line ? `<button type="button" class="ck-line" data-line="${f.line}" title="Show line ${f.line} in the document">line ${f.line}</button> ` : '';
  const replace = f.replace != null && report && report.format === 'docs-api'
    ? ` <button type="button" class="btn small ck-replace" data-ref="${f.replace}"${f.replaced ? ' disabled' : ''} title="${f.severity === 'error' ? 'Rewrite this entry as the work its DOI resolves to' : 'Rewrite this entry from its Crossref record'} (one edit; Undo reverts it)">${f.replaced ? 'Replaced' : 'Replace with the Crossref record'}</button>` : '';
  const allow = f.kind === 'ref-off' ? ' <button type="button" class="btn small ck-allow" title="Chrome asks once; you can remove the access later in chrome://extensions">Allow lookups</button>' : '';
  return `<div class="ck-item ck-${f.severity}"><span class="ck-sev" title="${f.severity}">${CHECK_ICONS[f.severity]}</span> ${link}<span class="ck-text">${escapeHtml(f.text)}</span>${replace}${allow}</div>`;
}
function checkInnerHtml(report) {
  const head = `<div class="ck-head">☑️ Check · ${escapeHtml(checkDate(report.at))} · «${escapeHtml(report.title)}» · ${escapeHtml(CHECK_FORMAT_LABEL[report.format])}</div>`;
  const note = checkFormatNote(report);
  const groups = CK_GROUPS.map((g) => {
    const list = checkGroupFindings(report, g.id);
    const running = g.id === 'reflist' && report.reflist.state === 'running';
    const progress = running ? `<div class="ck-progress">Checking ${report.reflist.done} of ${report.reflist.total}… <button type="button" class="btn small ck-cancel">Cancel</button></div>` : '';
    const body = list.length ? list.map((f) => checkItemHtml(f, report)).join('') : running ? '' : '<div class="ck-item ck-none">✓ Nothing found.</div>';
    const n = list.filter((f) => f.severity !== 'note').length;
    return `<div class="ck-group" data-group="${g.id}"><div class="ck-group-head">${escapeHtml(g.title)}${n ? ` <span class="ck-count">${n}</span>` : ''}</div>${progress}${body}</div>`;
  }).join('');
  return head + (note ? `<div class="ck-sub">${escapeHtml(note)}</div>` : '') + groups +
    `<div class="ck-summary">${escapeHtml(checkSummary(report))}</div>` +
    '<div class="tool-actions ck-actions"><button class="btn small" type="button" data-act="copy-selftest" title="Copy the whole report as Markdown">Copy report</button></div>';
}
// (Re)paints the card from the report; the Markdown for Copy report follows.
function checkPaint(card) {
  card.innerHTML = checkInnerHtml(card._check);
  card._report = checkMarkdown(card._check);
}
// The report card in the chat: a notice (renderHistory drops it), never stored. A line link scrolls the Docs tab to
// its line (on click only); Cancel stops the reference lookups (card._cancel).
function checkCard(report) {
  const d = document.createElement('div');
  d.className = 'msg notice check-report';
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
    if (allow && !allow.disabled) checkAllowLookups(d, allow);
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
    const report = checkReport(src, { title: state.docTitle || '', docId: state.docId || '', instructions: state.docInstructions || '', comments });
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
  if (state.busy) { addNotice('Wait until the current answer is finished, then click Allow lookups again.'); return false; }
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
// The click: owns the chat like a turn (the chat lock, the stored history), reads the document, rewrites the entry's line
// as a plain-text entry in the document's dominant style (keeping its number) with replace_text, and records the edit as
// a user request, the call and its result, and a one-line answer, so the edit card has Undo and the model sees what
// happened. Returns true when the edit was made.
async function checkReplaceEntry(card, i, btn) {
  const report = card._check;
  const r = report.reflist.results[i];
  if (!r || r.replaced || !checkCanReplace(r)) return false;
  if (state.busy || state.undoing) { addNotice('Wait until the current answer is finished, then click Replace again.'); return false; }
  if (!state.googleConnected) { addNotice('Connect a Google account in Settings to edit the document.'); return false; }
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
    const line = checkEntryLine(snap.model, r.entry);
    if (!line) throw new Error('The reference entry changed since the check. Run /check again.');
    const csl = r.work.csl || await crossrefMeta(r.work.doi);
    const style = ckCitationStyle(report.entries);
    const args = { old_text: line.text, new_text: ckEntryPrefix(line.text) + ckFormatCsl(csl, style) };
    const id = 'check_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    setStatus('Replacing the reference entry…');
    // The number and provenance checks refuse a first write that drops or brings numbers, and let the identical call
    // through: the click is that decision (the new numbers come from the Crossref record the user chose).
    let res = null;
    for (let k = 0; k < 3 && (!res || /^Refused by a check/.test(String(res.content))); k++) res = await runWriteTool('replace_text', args, snap, id, { args });
    if (!res._ok) throw new Error(String(res.content || res._message).replace(/^Error: /, ''));
    const label = checkEntryLabel(r.entry);
    const tc = { id, type: 'function', function: { name: 'replace_text', arguments: JSON.stringify(args) } };
    state.messages.push(
      { role: 'user', content: `Replace the reference entry ${label} (line ${line.line}) with its Crossref record.` },
      { role: 'assistant', content: '', tool_calls: [tc] },
      { role: 'tool', tool_call_id: id, ...res },
      { role: 'assistant', content: `Replaced the reference entry ${label} with its Crossref record (${style === 'numeric' ? 'numeric' : 'author-year'} style, from the /check report).` },
    );
    await saveHistory(snap.chatCtx);
    useDocModel(snap.model);
    r.replaced = true;
    done = true;
    renderHistoryKeepingNotices();
    return true;
  } catch (e) {
    if (!(e && e.name === 'AbortError')) addError(`Replace: ${e.message || e}`);
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
