'use strict';
// Module agent-map.js: the agents pill of the input bar ("N agents", right of the mode button) and the agent map it
// opens: an overlay in the mode menu's family with one row per agent of the open document (state.agents, the registry
// of agents.js), newest first, and the detail of one agent in the same overlay (its prompt, its tool calls, its report).
// A running agent of this panel can be stopped from its row and its detail. Escape or a press outside closes it.
/* global agentAccessText, agentRuntime, agentClock, el, escapeHtml, fmtNum, renderMarkdown, state, stopAgent */
/* exported renderAgentsUi, openAgentMap, closeAgentMap, bindAgentMap, fmtAgentDuration, fmtAgentTokens */

const agentMap = { open: false, detail: null, timer: 0 };
const AGENT_MAP_TICK_MS = 1000;
const AGENT_STATUS_TEXT = { running: 'running', ok: 'done', partial: 'partial', error: 'failed', stopped: 'stopped', refused: 'refused', lost: 'lost' };

// "45s", "8m 8s", "1h 2m".
function fmtAgentDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
// "850 tokens", "91.3k tokens", "1.2M tokens".
function fmtAgentTokens(n) {
  const v = Number(n) || 0;
  const k = (x, unit) => `${(x).toFixed(1).replace(/\.0$/, '')}${unit}`;
  return `${v < 1000 ? fmtNum(v) : v < 1e6 ? k(v / 1000, 'k') : k(v / 1e6, 'M')} tokens`;
}
const entryTokens = (e) => (e.usage ? (Number(e.usage.prompt_tokens) || 0) + (Number(e.usage.completion_tokens) || 0) : 0);
const agentsNewestFirst = () => (state.agents || []).slice().sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
const isRunning = (e) => e.status === 'running';
const elapsedOf = (e) => (isRunning(e) ? agentClock.now() - (e.startedAt || agentClock.now()) : (e.endedAt || e.startedAt || 0) - (e.startedAt || 0));
// Stop is offered only for this panel's own running agents (another tab's cannot be reached from here).
const stoppable = (e) => isRunning(e) && !!agentRuntime(e.id);

// Everything the registry shows: the pill always, the map when open. Called by agents.js on every change.
function renderAgentsUi() {
  renderAgentsPill();
  if (agentMap.open) renderAgentMap();
}

// The pill: a dot and "N agents" (all agents of the document in the registry); disabled with none (an empty map has
// nothing to show), the dot in the accent and pulsing while any runs.
function renderAgentsPill() {
  const b = el.agentsBtn;
  if (!b) return;
  const list = state.agents || [];
  const n = list.length;
  const running = list.filter(isRunning).length;
  const text = `${n} agent${n === 1 ? '' : 's'}`;
  const label = b.querySelector ? b.querySelector('.mode-label') : null;
  if (label) label.textContent = text; else b.textContent = text;
  b.classList.toggle('none', n === 0);
  b.disabled = n === 0;
  b.classList.toggle('running', running > 0);
  const what = n ? `${text}${running ? `, ${running} running` : ''}` : 'no agents yet';
  if (n) b.dataset.tip = `Agent map: ${what}`; else delete b.dataset.tip;
  b.setAttribute('aria-label', `Agents of this document: ${what}`);
}

function openAgentMap() {
  if (!el.agentMap || !(state.agents || []).length) return; // nothing to map (the pill is disabled then)
  agentMap.open = true;
  agentMap.detail = null;
  el.agentMap.classList.remove('hidden');
  el.agentsBtn.setAttribute('aria-expanded', 'true');
  renderAgentMap();
  focusFirst();
}
function closeAgentMap({ focus = false } = {}) {
  if (!agentMap.open) return;
  agentMap.open = false;
  agentMap.detail = null;
  clearInterval(agentMap.timer);
  agentMap.timer = 0;
  el.agentMap.classList.add('hidden');
  el.agentMap.textContent = '';
  el.agentsBtn.setAttribute('aria-expanded', 'false');
  if (focus && el.agentsBtn.focus) el.agentsBtn.focus();
}
function focusFirst() {
  const t = el.agentMap.querySelector && el.agentMap.querySelector('.agent-back, .agent-row-main');
  if (t && t.focus) t.focus();
}

// The list or, with agentMap.detail, one agent; the running times tick while any agent runs.
function renderAgentMap() {
  const box = el.agentMap;
  const keep = openSections(box);
  box.textContent = '';
  const entry = agentMap.detail && (state.agents || []).find((e) => e.id === agentMap.detail);
  if (agentMap.detail && !entry) agentMap.detail = null;
  if (entry) box.appendChild(agentDetail(entry, keep)); else box.appendChild(agentList());
  positionAgentMap();
  const ticking = (state.agents || []).some(isRunning);
  if (ticking && !agentMap.timer) agentMap.timer = setInterval(tickAgentMap, AGENT_MAP_TICK_MS);
  if (!ticking && agentMap.timer) { clearInterval(agentMap.timer); agentMap.timer = 0; }
}
// The folds the user opened in the detail stay open across a repaint.
function openSections(box) {
  const out = new Set();
  if (box.querySelectorAll) for (const d of box.querySelectorAll('details[data-sec]')) if (d.open) out.add(d.dataset.sec);
  return out;
}
function tickAgentMap() {
  if (!agentMap.open || !el.agentMap.querySelectorAll) return;
  for (const span of el.agentMap.querySelectorAll('[data-agent-time]')) {
    const e = (state.agents || []).find((x) => x.id === span.dataset.agentTime);
    if (e) span.textContent = fmtAgentDuration(elapsedOf(e));
  }
}

const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const statusDot = (e) => {
  const d = node('span', `agent-dot st-${e.status}`);
  d.dataset.tip = AGENT_STATUS_TEXT[e.status] || e.status;
  d.setAttribute('aria-hidden', 'true');
  return d;
};
// "edit · lines 40–80 · <model> · 8m 8s · 91.3k tokens" (the time in its own span, which ticks while the agent runs;
// an entry of an earlier build has no right).
function metaLine(e, cls) {
  const m = node('span', cls);
  const right = agentAccessText(e);
  m.append(document.createTextNode(`${right ? `${right} · ` : ''}${e.model || ''} · `));
  const t = node('span', 'agent-time', fmtAgentDuration(elapsedOf(e)));
  t.dataset.agentTime = e.id;
  m.append(t);
  const tokens = entryTokens(e);
  if (tokens) m.append(document.createTextNode(` · ${fmtAgentTokens(tokens)}`));
  return m;
}
function stopButton(e, cls) {
  const b = node('button', `btn small ${cls}`, 'Stop');
  b.type = 'button';
  b.dataset.id = e.id;
  b.dataset.tip = 'Stop the agent';
  b.setAttribute('aria-label', `Stop agent ${e.label}`);
  return b;
}

function agentList() {
  const wrap = node('div', 'agent-list');
  const list = agentsNewestFirst();
  // Empty only when the last agent left while the map was open: an empty list, no text.
  for (const e of list) {
    const row = node('div', `agent-row st-${e.status}`);
    row.dataset.id = e.id;
    const main = node('button', 'agent-row-main');
    main.type = 'button';
    main.dataset.id = e.id;
    main.setAttribute('aria-label', `${e.label}: ${AGENT_STATUS_TEXT[e.status] || e.status}, ${e.model || ''}. Open the details`);
    const text = node('span', 'agent-row-text');
    text.append(node('span', 'agent-row-title', e.label || e.id), metaLine(e, 'agent-row-meta'));
    main.append(statusDot(e), text);
    row.appendChild(main);
    if (stoppable(e)) row.appendChild(stopButton(e, 'agent-row-stop'));
    wrap.appendChild(row);
  }
  return wrap;
}

function agentDetail(e, keep) {
  const wrap = node('div', 'agent-detail');
  const head = node('div', 'agent-detail-head');
  const back = node('button', 'agent-back', '←');
  back.type = 'button';
  back.dataset.tip = 'Back to all agents';
  back.setAttribute('aria-label', 'Back to all agents');
  head.append(back, node('span', 'agent-detail-title', e.label || e.id));
  if (stoppable(e)) head.appendChild(stopButton(e, 'agent-detail-stop'));
  wrap.appendChild(head);
  const status = node('div', 'agent-detail-status');
  status.append(statusDot(e), node('span', 'agent-detail-state', `${AGENT_STATUS_TEXT[e.status] || e.status} · `), metaLine(e, 'agent-detail-meta'));
  wrap.appendChild(status);
  const prompt = `${e.task || ''}${e.context ? `\n\nContext: ${e.context}` : ''}`;
  wrap.appendChild(section('prompt', 'Prompt', node('div', 'agent-prompt', prompt), keep));
  const live = agentRuntime(e.id);
  const log = (live ? live.log : e.log) || [];
  const rows = node('div', 'agent-calls');
  if (!log.length) rows.appendChild(node('div', 'agent-none', 'No tool calls.'));
  for (const c of log) {
    const r = node('div', `activity-row ${c.status || ''}`);
    r.innerHTML = `<span class="activity-name">${escapeHtml(c.name || 'tool')}</span>${c.summary ? ': ' + escapeHtml(c.summary) : ''}`;
    rows.appendChild(r);
  }
  wrap.appendChild(section('calls', `Tool calls (${fmtNum(log.length)})`, rows, keep));
  wrap.appendChild(node('div', 'agent-sec-title', 'Report'));
  const report = node('div', 'agent-report md');
  if (e.full) report.innerHTML = renderMarkdown(e.full).html;
  else report.textContent = isRunning(e) ? 'The report arrives when the agent is done.' : e.status === 'lost' ? 'The panel was closed or reloaded while this agent ran, so its report was lost.' : 'The agent gave no answer.';
  wrap.appendChild(report);
  return wrap;
}
function section(key, title, body, keep) {
  const d = node('details', 'agent-sec');
  d.dataset.sec = key;
  if (keep && keep.has(key)) d.open = true;
  d.append(node('summary', '', title), body);
  return d;
}

// Fixed above the pill (the composer clips overflow), wider than the mode menu, kept inside the panel.
function positionAgentMap() {
  if (!agentMap.open || !el.agentsBtn.getBoundingClientRect) return;
  const r = el.agentsBtn.getBoundingClientRect();
  const width = Math.min(420, Math.max(220, window.innerWidth - 16));
  el.agentMap.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - width - 8))) + 'px';
  el.agentMap.style.width = width + 'px';
  el.agentMap.style.bottom = Math.round(window.innerHeight - r.top + 4) + 'px';
}

function showDetail(id) {
  agentMap.detail = id;
  renderAgentMap();
  focusFirst();
}
function showList(fromId) {
  agentMap.detail = null;
  renderAgentMap();
  const row = fromId && [...el.agentMap.querySelectorAll('.agent-row-main')].find((b) => b.dataset.id === fromId);
  if (row) row.focus(); else focusFirst();
}

function bindAgentMap() {
  if (!el.agentsBtn || !el.agentMap) return;
  renderAgentsPill();
  el.agentsBtn.addEventListener('click', () => { if (agentMap.open) closeAgentMap(); else openAgentMap(); });
  el.agentMap.addEventListener('click', (ev) => {
    const t = ev.target;
    const stop = t.closest('.agent-row-stop, .agent-detail-stop');
    if (stop) { stop.disabled = true; stopAgent(stop.dataset.id); return; }
    if (t.closest('.agent-back')) { showList(agentMap.detail); return; }
    const main = t.closest('.agent-row-main');
    if (main) showDetail(main.dataset.id);
  });
  el.agentMap.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const rows = [...el.agentMap.querySelectorAll('.agent-row-main')];
    const i = rows.indexOf(document.activeElement);
    if (i < 0 || !rows.length) return;
    ev.preventDefault();
    rows[(i + (ev.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus();
  });
  document.addEventListener('mousedown', (ev) => {
    if (!agentMap.open) return;
    if (el.agentMap.contains(ev.target) || el.agentsBtn.contains(ev.target)) return;
    closeAgentMap();
  });
  document.addEventListener('keydown', (ev) => {
    if (agentMap.open && ev.key === 'Escape') { ev.preventDefault(); closeAgentMap({ focus: true }); }
  });
  window.addEventListener('resize', positionAgentMap);
}
