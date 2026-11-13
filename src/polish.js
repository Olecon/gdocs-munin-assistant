'use strict';
// Module polish.js: /polish, prose fixes with Apply per finding. It runs over the selection, a section named after the
// command ("/polish Introduction") or, without either, the whole document when it has at most POLISH_MAX_WORDS words.
// Two groups, each in paragraph order:
// - Mechanical: the deterministic hits on the paragraphs in scope: the wordy phrases of src/concision.js and the variant
//   findings of src/doc-checks.js (measured on the whole document, so the majority form is the document's), the prose
//   tells of src/prose-lint.js, the claim and statistics findings of src/text-checks.js. Apply where the change is
//   mechanical (a literal swap); the others are shown without it.
// - Suggested by the model: one quiet request per paragraph (the chat's provider, no tools, the document writing rules,
//   the style, conventions and terms lines, MAIN.md/DOC.md; on Munin the summary sampling profile) answers with at most
//   POLISH_MAX_FIXES sentence fixes as JSON. A fix whose quote is not in the paragraph exactly once is left out; a fix
//   that changes the meaning (meaningDrift) or loses or brings numbers, citations or qualifiers (claimDrift, claimItems)
//   is dropped and counted in the report.
// Apply writes one edit_document call through checkCardWrite of src/check.js (the gate, the verified write, the undo
// journal, a short exchange in the chat), refused when the line changed since the report. Persona-less: the same on every
// provider. The card is a report box like /check's (not stored), with Copy report and Cancel while the model runs.
/* global addError, applyPendingSelection, canRequest, checkCardWrite, checkDate, checkFindingOf, checkFixOps, checkIgnores,
   checkItemHtml, checkRuleIgnored, ckDocument, claimDrift, claimItems, claimLint, closePopup, conventionsLine, countWords, dcVariants,
   dcWordy, docIdFromUrl, docInstructionsBlock, DOCUMENT_WRITING_RULES, docStatusText, el, escapeHtml, fetchDocText, getDocTab, glossaryLine,
   locateSelection, meaningDrift, OBJECT_CHAR, parseJsonLoose, proseTells, rawError, refreshContext, refreshSelection, resetDocsApiTurn,
   reviseAsk, scrollToLine, sectionExpectation, setBusy, setStatus, snapshotDocument, state, statsHabits, statsLint, styleLine,
   takeSnapshot, appendToChat, UNTRUSTED_DATA_NOTE */
/* exported runPolish, polishReport, polishScope, polishMechanical, polishModelFixes, polishMarkdown, POLISH_HEAD, POLISH_MAX_WORDS */

const POLISH_MAX_WORDS = 2000; // the whole document without a selection or a named section
const POLISH_MIN_WORDS = 8; // shorter body lines (captions, labels) are left alone
const POLISH_MAX_PARAS = 40; // model requests per run
const POLISH_MAX_FIXES = 5;
const POLISH_STATS_SKIP = ['p-form', 'plusminus']; // the variant findings report these with Apply
const POLISH_HEAD = 'You suggest sentence-level fixes for one paragraph of a document: clarity, flow, wordiness, grammar. Answer with a JSON array of at most 5 objects {"quote": one sentence exactly as it is in the paragraph, "replacement": that sentence fixed, "why": a few words}, or [] when the paragraph needs nothing. No fix that changes a number, a citation or how strong a claim is.';
const POLISH_GROUPS = [{ id: 'mechanical', title: 'Mechanical' }, { id: 'model', title: 'Suggested by the model' }];
const plPlural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const plClip = (s, n = 80) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const plKey = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
// The replacement written like the text it replaces: Capitalized or as given.
const plCase = (src, to) => (src && to && src[0] !== src[0].toLowerCase() ? to[0].toUpperCase() + to.slice(1) : to);
const plFinding = (group, rule, line, at, len, text, extra = {}) => ({ group, kind: rule, rule, severity: 'note', line, at, len, text, ...extra });

// ---- The scope ---------------------------------------------------------------------------------------------------------
// The lines /polish works on: { from, to, label } or { error } (what to do next). doc: ckDocument; snap: the snapshot of
// the document (the selection); name: the text after /polish.
function polishScope(doc, snap, name) {
  const sel = snap.selection ? locateSelection(snap) : null;
  if (sel) return { from: sel.start, to: sel.end, label: `the selection (${sel.start === sel.end ? `line ${sel.start}` : `lines ${sel.start}–${sel.end}`})` };
  const heads = doc.lines.filter((l) => l.heading && !l.cell && l.text.trim());
  if (name) {
    const want = plKey(name);
    const h = heads.find((l) => plKey(l.text) === want) || heads.find((l) => plKey(l.text).includes(want));
    if (!h) return { error: `No heading reads «${plClip(name, 60)}». Name a heading as the document shows it, or select the text, then run /polish again.` };
    let to = h.line;
    for (const l of doc.lines.slice(h.line)) { if (l.heading && !l.cell && l.text.trim() && l.heading <= h.heading) break; to = l.line; }
    return { from: h.line, to, label: `«${plClip(h.text, 60)}»` };
  }
  const words = doc.lines.filter((l) => !l.heading && !l.cell).reduce((n, l) => n + countWords(l.text), 0);
  if (words > POLISH_MAX_WORDS) return { error: `The document has ${words.toLocaleString('en-US')} words; /polish works on at most ${POLISH_MAX_WORDS.toLocaleString('en-US')} at once. Select a section, or name it (/polish Introduction), and run /polish again.` };
  return { from: 1, to: doc.lines.length, label: 'the whole document' };
}
// The paragraphs of a scope: body lines with at least POLISH_MIN_WORDS words (not headings, the title block, table cells
// or suggested changes).
const polishParagraphs = (doc, scope) => doc.lines.filter((l) => l.line >= scope.from && l.line <= scope.to && !l.heading && !l.title && !l.cell && !l.suggested &&
  countWords(l.text) >= POLISH_MIN_WORDS);

// ---- The mechanical findings ----------------------------------------------------------------------------------------------
// fix.edits carry from (the text replaced), so a fix can be found again after another Apply changed its line.
const withFrom = (fix, lineText) => ({ ...fix, edits: fix.edits.map((e) => ({ ...e, from: String(lineText.get(e.line) || '').substr(e.at, e.len) })) });
function polishMechanical(doc, paras, { terms = new Set(), rules = [], docText = '' } = {}) {
  const inScope = new Set(paras.map((l) => l.line));
  const lineText = new Map(doc.lines.map((l) => [l.line, l.text]));
  const out = [];
  // Measured on the whole document; only the occurrences in scope are kept (and written by Apply).
  for (const f of [...(dcWordy(doc, { terms }) || []), ...dcVariants(doc, { terms })]) {
    const edits = f.fix ? f.fix.edits.filter((e) => inScope.has(e.line)) : [];
    if (!inScope.has(f.line) && !edits.length) continue;
    const line = inScope.has(f.line) ? f.line : edits[0].line;
    out.push({ ...f, group: 'mechanical', line, ...(f.fix ? { fix: edits.length ? withFrom({ ...f.fix, edits }, lineText) : null } : {}) });
  }
  const habits = statsHabits(docText);
  // A tell inside a span the wordy or variant findings already report is not listed twice.
  const taken = (line, at, len) => out.some((f) => f.line === line && f.len && at < f.at + f.len && f.at < at + Math.max(1, len));
  for (const l of paras) {
    let from = 0;
    for (const h of proseTells(l.text, null)) {
      const clipped = h.match.endsWith('…');
      const at = l.text.indexOf(clipped ? h.match.slice(0, -1) : h.match, from);
      if (at < 0) continue;
      from = at + 1;
      const len = clipped ? 0 : h.match.length;
      if (taken(l.line, at, len)) continue;
      // A tell whose alternative is a literal ("shows the") is a mechanical swap; "drop it" and advice are not.
      const lit = /^"([^"]+)"$/.exec(h.hint || '');
      const fix = lit && len ? { label: `«${h.match}» to «${lit[1]}»`, edits: [{ line: l.line, at, len, to: plCase(h.match, lit[1]), from: h.match }] } : null;
      out.push(plFinding('mechanical', `tell-${h.kind}`, l.line, at, len, `«${h.match}»: ${h.hint}.`, fix ? { fix } : {}));
    }
    for (const c of claimLint(l.text)) out.push(plFinding('mechanical', `claim-${c.kind}`, l.line, Math.max(0, l.text.indexOf(c.match)), c.match.length, `Claim: ${c.label}.`));
    for (const s of statsLint(l.text, habits)) {
      if (POLISH_STATS_SKIP.includes(s.kind)) continue;
      out.push(plFinding('mechanical', `stats-${s.kind}`, l.line, Math.max(0, l.text.indexOf(s.match)), s.match.length, `Statistics: ${s.label}.`));
    }
  }
  return out.filter((f) => !checkRuleIgnored(rules, f.rule) && !terms.has(plKey(f.text.match(/«([^»]+)»/) ? f.text.match(/«([^»]+)»/)[1] : '')))
    .sort((a, b) => a.line - b.line || a.at - b.at);
}

// ---- The model's fixes -------------------------------------------------------------------------------------------------
// The fixes of one answer for paragraph l: { fixes: [finding], dropped (changed the meaning), invalid (not applicable) }.
function polishModelFixes(raw, l) {
  const v = parseJsonLoose(String(raw == null ? '' : raw).replace(/<think>[\s\S]*?<\/think>/g, ''));
  const list = Array.isArray(v) ? v : v && Array.isArray(v.fixes) ? v.fixes : [];
  const out = { fixes: [], dropped: 0, invalid: 0 };
  for (const x of list.slice(0, POLISH_MAX_FIXES)) {
    const quote = x && typeof x.quote === 'string' ? x.quote.trim() : '';
    const repl = x && typeof x.replacement === 'string' ? x.replacement.replace(/\s+/g, ' ').trim() : '';
    const at = quote ? l.text.indexOf(quote) : -1;
    if (!quote || !repl || repl === quote || at < 0 || l.text.indexOf(quote, at + 1) >= 0) { out.invalid++; continue; }
    if (polishDrifts(quote, repl)) { out.dropped++; continue; }
    const why = x && typeof x.why === 'string' && x.why.trim() ? ` (${plClip(x.why, 100)})` : '';
    out.fixes.push(plFinding('model', '', l.line, at, quote.length, `«${quote}» → «${repl}»${why}`,
      { rule: undefined, fix: { label: 'the suggested fix', edits: [{ line: l.line, at, len: quote.length, to: repl, from: quote }] } }));
  }
  return out;
}
// Whether a fix changes the meaning: a negation, modality, comparative or quantifier shift, a lost number, citation or
// qualifier, or a number the sentence did not have.
function polishDrifts(quote, repl) {
  if (meaningDrift(quote, repl).length) return true;
  const d = claimDrift(quote, repl);
  if (d.numbers.length || d.citations.length || d.qualifiers.length) return true;
  const had = new Set(claimItems(quote).numbers.map((n) => n.text));
  return claimItems(repl).numbers.some((n) => !had.has(n.text));
}
// The system text of the paragraph requests: the head, the writing rules, the measured lines of the document, MAIN.md,
// DOC.md and the untrusted-data note.
function polishSystem(snap) {
  const measured = [styleLine(snap), conventionsLine(snap), glossaryLine(snap)].filter(Boolean).join('\n');
  return [POLISH_HEAD, DOCUMENT_WRITING_RULES, measured, docInstructionsBlock(snap), UNTRUSTED_DATA_NOTE].filter(Boolean).join('\n\n');
}
// One request per paragraph, the card repainted after each; Stop or Cancel ends the loop with what is done.
async function polishModelPass(card, snap, paras) {
  const report = card._polish;
  const m = report.model;
  const list = paras.slice(0, POLISH_MAX_PARAS);
  Object.assign(m, { state: 'running', done: 0, total: list.length, skipped: Math.max(0, paras.length - list.length) });
  card._paint(card);
  const system = polishSystem(snap);
  for (let i = 0; i < list.length; i++) {
    if (snap.signal && snap.signal.aborted) { m.state = 'stopped'; break; }
    const l = list[i];
    setStatus(`Polish: paragraph ${i + 1} of ${list.length}…`);
    const where = snap.model ? sectionExpectation(snap.model, l.line, { skipLine: true }) : '';
    let answer;
    try { answer = await reviseAsk(snap, system, [where, `Paragraph:\n${l.text}`].filter(Boolean).join('\n'), { profile: 'summary' }); } catch (e) {
      if ((snap.signal && snap.signal.aborted) || (e && e.name === 'AbortError')) { m.state = 'stopped'; break; }
      console.warn('Munin: a /polish request failed:', rawError(e));
      m.failed++;
      m.done = i + 1;
      continue;
    }
    const r = polishModelFixes(answer.content, l);
    report.groups.model.push(...r.fixes);
    m.dropped += r.dropped;
    m.done = i + 1;
    card._paint(card);
  }
  if (m.state === 'running') m.state = 'done';
  card._paint(card);
}

// ---- The report and its card -----------------------------------------------------------------------------------------
function polishReport({ title = '', docId = '', format = 'docs-api', scope, doc, mechanical = [], at = Date.now() }) {
  return {
    kind: 'polish', at, title, docId, format, scope: scope.label, lineText: new Map(doc.lines.map((l) => [l.line, l.text])),
    groups: { mechanical, model: [] }, model: { state: 'off', done: 0, total: 0, dropped: 0, failed: 0, skipped: 0, note: '' },
  };
}
// The model group's own rows (progress and outcome), as text.
function polishModelNotes(report) {
  const m = report.model;
  const out = [];
  if (m.state === 'off') out.push(m.note || 'Not run.');
  if (m.state === 'stopped') out.push(`Stopped after ${plPlural(m.done, 'paragraph')} of ${m.total}.`);
  if (m.dropped) out.push(`${plPlural(m.dropped, 'fix', 'fixes')} dropped: ${m.dropped === 1 ? 'it changed' : 'they changed'} the meaning.`);
  if (m.failed) out.push(`${plPlural(m.failed, 'paragraph')}: the request failed; run /polish again for ${m.failed === 1 ? 'it' : 'them'}.`);
  if (m.skipped) out.push(`${plPlural(m.skipped, 'more paragraph')} not sent (at most ${POLISH_MAX_PARAS} per run); select a part and run /polish again.`);
  return out;
}
const polishSummary = (r) => `${plPlural(r.groups.mechanical.length, 'mechanical finding')}, ${plPlural(r.groups.model.length, 'suggested fix', 'suggested fixes')}`;
function polishMarkdown(report) {
  const out = ['## Munin polish', '', `- Date: ${checkDate(report.at)}`, `- Document: «${report.title}» (${report.docId})`, `- Scope: ${report.scope}`, '',
    `**Summary:** ${polishSummary(report)}`];
  for (const g of POLISH_GROUPS) {
    const list = report.groups[g.id];
    out.push('', `### ${g.title}`, '');
    if (g.id === 'model' && report.model.state === 'running') out.push(`- Paragraph ${report.model.done} of ${report.model.total}…`);
    for (const f of list) out.push(`- line ${f.line} · ${f.text}${f.rule ? ` (${f.rule})` : ''}`);
    if (g.id === 'model') for (const n of polishModelNotes(report)) out.push(`- ${n}`);
    if (!list.length && !(g.id === 'model' && (report.model.state !== 'done' || polishModelNotes(report).length))) out.push('- Nothing found.');
  }
  return out.join('\n') + '\n';
}
function polishInnerHtml(report) {
  const head = `<div class="ck-head">Polish · ${escapeHtml(checkDate(report.at))} · «${escapeHtml(report.title)}» · ${escapeHtml(report.scope)}</div>`;
  const groups = POLISH_GROUPS.map((g) => {
    const list = report.groups[g.id];
    list.forEach((f, i) => { f._ref = i + 1; });
    const running = g.id === 'model' && report.model.state === 'running';
    const progress = running ? `<div class="ck-progress">Paragraph ${report.model.done} of ${report.model.total}… <button type="button" class="btn small ck-cancel">Cancel</button></div>` : '';
    const notes = g.id === 'model' ? polishModelNotes(report).map((t) => `<div class="ck-item ck-none">${escapeHtml(t)}</div>`).join('') : '';
    const body = list.map((f) => checkItemHtml(f, report)).join('') + notes || (running ? '' : '<div class="ck-item ck-none">Nothing found.</div>');
    return `<div class="ck-group" data-group="${g.id}"><div class="ck-group-head">${escapeHtml(g.title)}${list.length ? ` <span class="ck-count">${list.length}</span>` : ''}</div>${progress}${body}</div>`;
  }).join('');
  const sub = report.format === 'docs-api' ? '' : '<div class="ck-sub">Read through the export: no Apply; connect a Google account to apply the fixes.</div>';
  return head + sub + groups + `<div class="ck-summary">${escapeHtml(polishSummary(report))}</div>` +
    '<div class="tool-actions ck-actions"><button class="btn small" type="button" data-act="copy-selftest" data-tip="Copy as Markdown">Copy report</button></div>';
}
function polishPaint(card) {
  card.innerHTML = polishInnerHtml(card._polish);
  card._report = polishMarkdown(card._polish);
}
function polishCard(report) {
  const d = document.createElement('div');
  d.className = 'msg report check-report polish-report';
  d._polish = report;
  d._check = report; // checkCardWrite reads the report (its docId) from _check
  d._paint = polishPaint;
  polishPaint(d);
  d.addEventListener('click', (ev) => {
    const at = (sel) => ev.target.closest && ev.target.closest(sel);
    const link = at('button.ck-line');
    if (link) { const n = Number(link.dataset.line); scrollToLine(n, report.lineText.get(n) || ''); return; }
    const cancel = at('button.ck-cancel');
    if (cancel && d._cancel) { cancel.disabled = true; d._cancel(); return; }
    const fold = at('button.ck-fold-toggle');
    if (fold) { const f = checkFindingOf(report, fold); if (f) { f._open = !f._open; polishPaint(d); } return; }
    const apply = at('button.ck-apply');
    if (apply && !apply.disabled) { const f = checkFindingOf(report, apply); if (f) polishApply(d, f, apply); }
  });
  return appendToChat(d);
}

// ---- Apply ---------------------------------------------------------------------------------------------------------------
// One finding's fix as one edit_document call through checkCardWrite (the shared write path of the /check card).
function polishApply(card, f, btn) {
  if (!f || !f.fix || f.applied) return Promise.resolve(false);
  const report = card._polish;
  return checkCardWrite(card, btn, {
    label: 'Apply', busy: 'Applying the fix…',
    plan: async (model) => {
      const r = checkFixOps(model, f.fix, report.lineText);
      if (r.error) throw new Error(r.error.replace('Run /check again', 'Run /polish again'));
      if (!r.ops.length) throw new Error('Nothing to change: the document already reads so. Run /polish again.');
      const where = `${r.lines.length === 1 ? 'line' : 'lines'} ${r.lines.join(', ')}`;
      return {
        name: 'edit_document', args: { operations: r.ops },
        user: `Apply the /polish fix on ${where}: ${plClip(f.text, 300)}`,
        answer: `Applied the /polish fix on ${where} (${plPlural(r.count, 'change')}).`,
      };
    },
    done: () => { f.applied = true; polishLinesChanged(report, f.fix.edits.map((e) => e.line)); },
  });
}
// After an Apply: the report's lines read as the document now does, and the other fixes on those lines find their text
// again (a fix whose text is gone loses its Apply).
function polishLinesChanged(report, lines) {
  const model = state.docModel;
  if (!model) return;
  const flat = (t) => String(t || '').replaceAll('\u000b', ' ').replace(new RegExp(OBJECT_CHAR, 'g'), ' ');
  for (const n of new Set(lines)) {
    const l = model.lines[n - 1];
    if (!l) continue;
    report.lineText.set(n, flat(l.text));
  }
  for (const f of [...report.groups.mechanical, ...report.groups.model]) {
    if (!f.fix || f.applied) continue;
    for (const e of f.fix.edits) {
      if (!lines.includes(e.line)) continue;
      const at = e.from ? report.lineText.get(e.line).indexOf(e.from) : -1;
      if (at < 0) { f.fix = null; break; }
      e.at = at;
    }
  }
}

// ---- /polish ---------------------------------------------------------------------------------------------------------------
// The report on the open document; busy while it runs (Stop or Cancel ends the model pass). name: the text after /polish.
async function runPolish(name = '') {
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
    setStatus('Polish: reading the document…');
    resetDocsApiTurn();
    await Promise.all([refreshSelection(), fetchDocText()]);
    if (abort.signal.aborted) return null;
    if (state.docText == null) throw new Error(`Could not read the document: ${state.docError || 'no text'}.`);
    const snap = takeSnapshot();
    snapshotDocument(snap);
    snap.signal = abort.signal;
    const doc = ckDocument(snap.model ? { model: snap.model } : { text: snap.docText, format: snap.docFormat });
    const scope = polishScope(doc, snap, String(name || '').trim());
    if (scope.error) { addError(`Polish: ${scope.error}`); return null; }
    const paras = polishParagraphs(doc, scope);
    if (!paras.length) { addError(`Polish: nothing to polish in ${scope.label}: no paragraph of ${POLISH_MIN_WORDS} words or more.`); return null; }
    const ignore = checkIgnores(snap.docInstructions || '');
    const mechanical = polishMechanical(doc, paras, { terms: ignore.terms, rules: ignore.rules, docText: snap.docText });
    const report = polishReport({ title: state.docTitle || '', docId: state.docId || '', format: doc.format, scope, doc, mechanical });
    card = polishCard(report);
    card._cancel = () => abort.abort();
    if (!snap.cfg.accountId || !canRequest(snap.cfg)) report.model.note = 'Not run: choose a model for this chat under the input box, then run /polish again.';
    else await polishModelPass(card, snap, paras);
    return report;
  } catch (e) {
    addError(`Polish: ${e.message || e}`);
    return null;
  } finally {
    if (card) { card._cancel = null; polishPaint(card); }
    state.abort = null;
    state.pinnedTabId = null;
    setBusy(false);
    applyPendingSelection();
    setStatus(docStatusText(), state.docText == null);
  }
}
