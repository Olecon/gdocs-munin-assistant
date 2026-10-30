'use strict';
// Module revise.js: revise_section(heading, goal), a revision of one section paragraph by paragraph that the panel
// drives, not the model. The section is resolved like replace_section; each paragraph (a body line with text) goes
// to one quiet request (no chat history: a short head with the writing rules and the prompt of the section type,
// then the document's title, keywords and research question, the goal and the paragraph) that answers with the
// revised paragraph; a paragraph that differs is written as one verified replace through the write path (the
// beforeWrite checks and the edit gate of replace_text apply, so a refused paragraph is skipped with a note). After
// the last paragraph one more request over the revised section asks for transition fixes only ({old, new} sentence
// pairs, applied the same way). The edits form one journal entry (kind 'multi'), so Undo on the card restores the
// whole section. Progress on the call's card and the status line; Stop ends the loop between paragraphs.
/* global anthropicHeaders, apiEditing, apiUrl, bearerHeaders, citationsInRanges, commitEdit, countWords, escapeHtml, gateEdit,
   MUNIN_REASONING_EFFORT, OBJECT_CHAR, oneLine, paperCards, parseJsonLoose, planReplaceText, rangeLabel, registerTools, replacePlan,
   runStream, samplingFields, setStatus, showText, WRITING_RULES */
/* exported REVISE_DEF, REVISE_SECTION_PROMPTS, reviseSectionKind, reviseSection, reviseParagraphText */

const REVISE_MIN_WORDS = 5; // shorter body lines (captions, labels) are left alone
const REVISE_MAX_PAIRS = 3; // transition fixes per section
const REVISE_MAX_NOTES = 8;
const REVISE_CONTEXT_CHARS = 400; // the previous paragraph, as context
const REVISE_GOAL_CHARS = 300;
const REVISE_DEFAULT_GOAL = 'make it clearer and tighter in the author\'s voice; keep every claim, number and citation';

// The prompt of each section type (about 60 tokens each), detected from the heading (English and Russian).
const REVISE_SECTION_PROMPTS = {
  abstract: 'Section: abstract. A paragraph a reader can use alone: the problem, what was done, the main result with its number, what it means. No citations, no undefined abbreviations, at most one sentence of background.',
  introduction: 'Section: introduction. Move from what is known to the gap to this work\'s aim. Every claim about earlier work keeps the source the text gives. Do not preview results unless the text already does.',
  methods: 'Section: methods. Past tense; enough detail to repeat the work: what, how much, which instrument or software, which conditions. Keep every number, unit and name. No results, no justification beyond one clause.',
  results: 'Section: results. Report what was observed with the numbers and figure or table pointers the text has; lead with the finding, not the figure ("X rose by 12% (Fig. 2)", not "Fig. 2 shows"). No interpretation beyond one clause.',
  discussion: 'Section: discussion. Interpret: what the results mean, how they compare with the work the text cites, the limits, what follows. Keep claim strength exactly as written; add no new results.',
  other: 'Section: general text. Keep its purpose and the order of its points; one clear point per sentence.',
};
const REVISE_KIND_RES = [
  ['abstract', /\b(abstract|summary)\b|аннотац|реферат|резюме/i],
  ['introduction', /\b(introduction|background)\b|введение|актуальност/i],
  ['methods', /\b(methods?|methodology|materials|experimental|procedures?)\b|метод|материал|экспериментальн/i],
  ['results', /\b(results?|findings)\b|результат/i],
  ['discussion', /\b(discussion|conclusions?)\b|обсуждени|заключени|вывод/i],
];
const reviseSectionKind = (heading) => (REVISE_KIND_RES.find(([, re]) => re.test(String(heading || ''))) || ['other'])[0];

const REVISE_HEAD = 'You revise one paragraph of a document. Answer with the revised paragraph only, as plain text in the paragraph\'s language: no quotes, labels, comments, Markdown or line breaks. If the paragraph needs no change for the goal, return it unchanged.';
const REVISE_TRANSITIONS_HEAD = 'You check only the transitions between the paragraphs of one section. Where a paragraph does not follow from the one before, change its first sentence (or the last sentence before it) so the link is clear; change nothing else. Answer with a JSON array of at most 3 objects {"old": the exact sentence as it is in the text, "new": its replacement}, or [] when the transitions are fine.';

// ---- The section and its paragraphs ---------------------------------------------------------------------
const reviseKey = (t) => String(t).replace(/\s+/g, ' ').trim().toLowerCase();
// The section of a heading on the model, as replace_section finds it (the heading outside tables, case-insensitive;
// the body up to the next heading of the same or a higher level): { name, from, to, paras: [line] } or { error }.
function reviseFindSection(model, heading) {
  const want = reviseKey(heading || '');
  if (!want) return { error: 'heading is empty. Pass the heading text as get_outline shows it' };
  const heads = model.lines.filter((l) => l.heading && !l.cell && l.text.trim());
  const found = heads.filter((l) => reviseKey(l.text) === want);
  if (!found.length) {
    const near = heads.filter((l) => reviseKey(l.text).includes(want) || want.includes(reviseKey(l.text))).slice(0, 5);
    const list = (near.length ? near : heads.slice(0, 5)).map((l) => `"${oneLine(l.text.trim(), 80)}" (line ${l.line})`).join(', ');
    return { error: `no heading reads "${oneLine(heading, 80)}". ${near.length ? 'Closest' : 'Some'} headings: ${list || 'none'}. Pass the heading exactly as get_outline shows it` };
  }
  if (found.length > 1) return { error: `${found.length} headings read "${oneLine(heading, 80)}" (lines ${found.map((l) => l.line).join(', ')}); revise one with replace_text instead` };
  const h = found[0];
  let last = h.line;
  for (let n = h.line + 1; n <= model.lines.length; n++) {
    const l = model.lines[n - 1];
    if (l.heading && !l.cell && l.text.trim() && l.heading <= h.heading) break;
    last = n;
  }
  const paras = model.lines.slice(h.line, last).filter(reviseable);
  return { name: oneLine(h.text.trim(), 80), from: h.line, to: last, paras: paras.map((l) => ({ line: l.line, text: l.text })) };
}
// A body paragraph the loop may rewrite: text without embedded objects or soft breaks (a revision cannot keep them),
// not a subheading, not a table cell, no suggested changes, at least REVISE_MIN_WORDS words.
const reviseable = (l) => !l.heading && !l.cell && !l.suggested && l.exact !== false && !!l.text.trim() &&
  !l.text.includes(OBJECT_CHAR) && !l.text.includes('\u000b') && countWords(l.text) >= REVISE_MIN_WORDS;

// ---- The requests ----------------------------------------------------------------------------------------
// A plain request without tools for the turn's provider (like the summary request of compaction.js).
function reviseRequest(snap, system, user) {
  const { prov, cfg } = snap;
  if (prov.id === 'openai') {
    return { kind: 'responses', url: apiUrl(snap, '/responses'), headers: bearerHeaders(cfg), tools: [],
      body: { model: cfg.model, instructions: system, input: [{ role: 'user', content: user }], max_output_tokens: prov.maxTokens, stream: true, store: false } };
  }
  if (prov.id === 'anthropic') {
    return { kind: 'anthropic', url: apiUrl(snap, '/messages'), headers: anthropicHeaders(cfg), tools: [],
      body: { model: cfg.model, max_tokens: prov.maxTokens, system, messages: [{ role: 'user', content: user }], stream: true } };
  }
  const body = {
    model: cfg.model, persona: 'raw', max_tokens: prov.maxTokens, stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    chat_template_kwargs: { reasoning_effort: MUNIN_REASONING_EFFORT }, // a paragraph needs no deep thinking
    ...samplingFields(prov),
  };
  return { kind: 'chat', url: apiUrl(snap, '/chat/completions'), headers: bearerHeaders(cfg), body, tools: [] };
}

// The document lines of the user message: the title, keywords (a "Keywords:" line) and the paper card's question.
function reviseDocLines(snap) {
  const lines = snap.model.lines;
  const title = (lines.find((l) => l.style === 'TITLE' && l.text.trim()) || {}).text || snap.docTitle || '';
  const kw = lines.find((l) => /^\s*(key ?words|ключевые слова)\s*[:.—–-]/i.test(l.text));
  const card = typeof paperCards !== 'undefined' && paperCards.docId === snap.model.docId && paperCards.entry ? paperCards.entry.card : null;
  return [
    title ? `Document: ${oneLine(title.trim(), 200)}` : '',
    kw ? `Keywords: ${oneLine(kw.text.replace(/^\s*(key ?words|ключевые слова)\s*[:.—–-]\s*/i, ''), 200)}` : '',
    card && card.question ? `Research question: ${oneLine(card.question, 200)}` : '',
  ].filter(Boolean);
}

// The revised paragraph of an answer: { text } or { error }.
function reviseParagraphText(raw, original) {
  let t = String(raw == null ? '' : raw).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  t = t.replace(/^(?:revised paragraph|revised|paragraph)\s*:\s*/i, '');
  if (/^["«“][\s\S]*["»”]$/.test(t) && !/^["«“]/.test(original.trim())) t = t.slice(1, -1).trim();
  if (!t) return { error: 'the answer was empty' };
  if (/\n\s*\n/.test(t)) return { error: 'the answer had several paragraphs' };
  t = t.replace(/\s*\n\s*/g, ' ');
  if (t.length < 0.3 * original.trim().length) return { error: 'the answer was much shorter than the paragraph' };
  return { text: t };
}

// One quiet request: { content, tokens }. Throws on failure (an AbortError after Stop).
async function reviseAsk(snap, system, user) {
  const r = await runStream(reviseRequest(snap, system, user), snap.signal || new AbortController().signal, snap, {});
  const u = r.usage || {};
  return { content: String(r.content || ''), tokens: (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0) };
}

// ---- Writing one replacement -----------------------------------------------------------------------------
// One verified replace through the write path: the checks and the gate of replace_text, then commitEdit.
// Returns { edit, notes } on success, { skip: note } when refused or failed, { stop: true } after Stop on a gate card.
async function reviseWrite(snap, plan, oldText, newText, id) {
  if (plan.removed && plan.removed.length) {
    try { plan.citations = await citationsInRanges(snap.model, plan.removed); } catch (e) { plan.citations = []; }
  }
  const ui = { args: { old_text: oldText, new_text: newText } };
  const refused = await gateEdit('replace_text', plan, snap, ui);
  if (ui.card && ui.card.isConnected) ui.card.remove(); // a gate card that was decided
  if (refused) {
    if (ui.decision === 'stopped') return { stop: true };
    return { skip: ui.decision === 'rejected' ? 'you did not allow the edit' : String(refused.content).replace(/^Error: /, '').replace(/^Refused by a check: /, 'refused by a check: ') };
  }
  const res = await commitEdit(snap, plan, id);
  if (!res._ok) return { skip: `not written (${res._message || 'the edit failed'})` };
  return { edit: res._edit, notes: ui.notes || [] };
}

// The plan of a paragraph's replacement on the current model, or { error }.
function paragraphPlan(model, n, oldText, newText) {
  const l = model.lines[n - 1];
  if (!l || l.text !== oldText) return { error: 'it changed in the document meanwhile' };
  const p = replacePlan(model, l.off, oldText, newText);
  if (p.error) return { error: p.error };
  return { ...p, title: `Revised ${rangeLabel(p.from, p.to)}`, cardText: showText(newText), cardLabel: 'New text' };
}

// ---- The tool ----------------------------------------------------------------------------------------------
async function reviseSection(args, snap, ui = {}, call = {}) {
  if (!snap.model) return 'Error: revise_section needs the Google Docs API, which is not available for this message.';
  const heading = typeof args.heading === 'string' ? args.heading : '';
  const sec = reviseFindSection(snap.model, heading);
  if (sec.error) return `Error: ${sec.error}.`;
  if (!sec.paras.length) return `Error: the section «${sec.name}» has no paragraphs to revise (subheadings, tables, images and lines under ${REVISE_MIN_WORDS} words are left alone).`;
  const kind = reviseSectionKind(sec.name);
  const goal = typeof args.goal === 'string' && args.goal.trim() ? oneLine(args.goal.trim(), REVISE_GOAL_CHARS) : REVISE_DEFAULT_GOAL;
  const system = `${REVISE_HEAD}\n\n${WRITING_RULES}\n\n${REVISE_SECTION_PROMPTS[kind]}`;
  const docLines = reviseDocLines(snap);
  const total = sec.paras.length;
  const id = call.id || 'revise';
  const parts = [];
  const notes = [];
  const written = [];
  const note = (t) => { if (notes.length < REVISE_MAX_NOTES) notes.push(t); };
  let changed = 0; let unchanged = 0; let skipped = 0; let tokens = 0; let requests = 0; let fixed = 0;
  let stopped = -1; // the paragraph index Stop came before
  const progress = (t) => {
    setStatus(t);
    if (ui.card && ui.card.isConnected) ui.card.innerHTML = `<div>${escapeHtml('⏳ ' + t)}</div>`;
  };
  const aborted = () => !!(snap.signal && snap.signal.aborted);
  let prev = '';
  for (let i = 0; i < total; i++) {
    if (aborted()) { stopped = i; break; }
    const p = sec.paras[i];
    progress(`Revising ${sec.name}: paragraph ${i + 1} of ${total}`);
    const user = [...docLines, `Section: ${sec.name}`, `Goal: ${goal}`,
      prev ? `Previous paragraph (context only, do not revise it):\n${oneLine(prev, REVISE_CONTEXT_CHARS)}` : '',
      `Paragraph to revise:\n${p.text}`].filter(Boolean).join('\n');
    let answer;
    try { answer = await reviseAsk(snap, system, user); } catch (e) {
      if (aborted() || e.name === 'AbortError') { stopped = i; break; }
      skipped++; note(`paragraph ${i + 1}: the request failed (${e.message})`);
      prev = p.text;
      continue;
    }
    requests++; tokens += answer.tokens;
    const out = reviseParagraphText(answer.content, p.text);
    if (out.error) { skipped++; note(`paragraph ${i + 1}: ${out.error}; left as it was`); prev = p.text; continue; }
    if (out.text.replace(/\s+/g, ' ').trim() === p.text.replace(/\s+/g, ' ').trim()) { unchanged++; prev = p.text; continue; }
    const plan = paragraphPlan(snap.model, p.line, p.text, out.text);
    if (plan.error) { skipped++; note(`paragraph ${i + 1}: ${plan.error}; left as it was`); prev = p.text; continue; }
    const w = await reviseWrite(snap, plan, p.text, out.text, `${id}.p${i + 1}`);
    if (w.stop) { stopped = i; break; }
    if (w.skip) { skipped++; note(`paragraph ${i + 1}: ${w.skip}`); prev = p.text; continue; }
    parts.push(w.edit); written.push(out.text); changed++;
    for (const n of w.notes) note(`paragraph ${i + 1}: ${n}`);
    prev = out.text;
  }
  // The transitions, over the section as it reads now (one request; only when the loop ran to the end).
  if (stopped < 0 && !aborted() && total >= 2) {
    progress(`Revising ${sec.name}: transitions`);
    const now = sec.paras.map((p) => (snap.model.lines[p.line - 1] || {}).text || p.text);
    let pairs = [];
    try {
      const a = await reviseAsk(snap, `${REVISE_TRANSITIONS_HEAD}\n\n${WRITING_RULES}`, [...docLines, `Section: ${sec.name}`, '', now.join('\n\n')].join('\n'));
      requests++; tokens += a.tokens;
      const v = parseJsonLoose(a.content);
      pairs = (Array.isArray(v) ? v : []).filter((x) => x && typeof x.old === 'string' && typeof x.new === 'string' && x.old.trim() && x.new.trim() && x.old !== x.new && !/\n/.test(x.new)).slice(0, REVISE_MAX_PAIRS);
    } catch (e) {
      if (!aborted()) note(`transitions: the request failed (${e.message})`);
    }
    for (let k = 0; k < pairs.length && !aborted(); k++) {
      const plan = planReplaceText(snap.model, { old_text: pairs[k].old, new_text: pairs[k].new });
      if (plan.error || plan.from < sec.from || plan.to > sec.to || plan.from !== plan.to) { note(`transition ${k + 1}: its sentence was not found once in the section; skipped`); continue; }
      const w = await reviseWrite(snap, plan, pairs[k].old, pairs[k].new, `${id}.t${k + 1}`);
      if (w.stop) break;
      if (w.skip) { note(`transition ${k + 1}: ${w.skip}`); continue; }
      parts.push(w.edit); written.push(pairs[k].new); fixed++;
    }
  }
  const range = rangeLabel(sec.from, sec.to);
  const head = `Revised the section «${sec.name}» (${range}) paragraph by paragraph: ${changed} of ${total} paragraph${total === 1 ? '' : 's'} changed, ${unchanged} unchanged, ${skipped} skipped` +
    (total >= 2 && stopped < 0 ? `; ${fixed} transition${fixed === 1 ? '' : 's'} fixed` : '') + '.';
  const stopText = stopped >= 0 ? ` Stopped by the user before paragraph ${stopped + 1}; the rest is as it was.` : '';
  const content = `${head}${stopText}${notes.length ? '\nNotes:\n- ' + notes.join('\n- ') : ''}\nThe line numbers did not change. Do not call revise_section on this section again in this message.`;
  const out = {
    content, _ok: true, _message: `Revised «${oneLine(sec.name, 40)}»: ${changed} of ${total} paragraph${total === 1 ? '' : 's'} changed${stopped >= 0 ? ' (stopped)' : ''}`,
    _detail: `${requests} request${requests === 1 ? '' : 's'}, ${tokens.toLocaleString('en-US')} tokens`,
    _cardText: written.length ? written.map(showText).join('\n\n') : '', _cardLabel: 'Revised text',
  };
  if (parts.length) {
    out._edit = { id, docId: snap.model.docId, tabId: snap.model.tabId, kind: 'multi', parts, title: `Revised the section «${sec.name}»`, undone: false, anchor: null };
  }
  return out;
}

const REVISE_DEF = { type: 'function', function: {
  name: 'revise_section',
  description: 'Revise a whole section paragraph by paragraph (the panel loops), then fix its transitions.',
  parameters: {
    type: 'object',
    properties: {
      heading: { type: 'string', description: 'As get_outline shows it.' },
      goal: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'What to achieve; null: a general polish.' },
    },
    required: ['heading', 'goal'],
    additionalProperties: false,
  },
} };

registerTools([REVISE_DEF], {
  offer: (mode, snap) => !!snap && !snap.side && apiEditing(mode, snap),
  reading: false,
  run: (name, args, snap, ui, call) => reviseSection(args, snap, ui, call),
  summary: (name, args) => (typeof args.heading === 'string' ? `«${oneLine(args.heading, 60)}»` : ''),
  pending: 'Revising the section…',
  prompt: [{ section: 'edit', line: '- revise_section(heading, goal): a whole section, paragraph by paragraph, then its transitions (one request per paragraph, 1–2k tokens each); for a few sentences use replace_text.' }],
});
