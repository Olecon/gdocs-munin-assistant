'use strict';
// Module web-search.js: server-side web search for /research with OpenAI or Anthropic: the tool
// definition, activity rows and the Sources list (renderSources, openaiSources, anthropicSources).
/* global ANTHROPIC_WEB_SEARCH_MAX_USES, anthropicAdaptive, escapeHtml, setStatus, SOURCES_MAX */
/* exported anthropicWebSearchTool, openaiSearchRow, anthropicActivity, openaiSources, anthropicSources,
   renderSources, countSearches, noteSearchActivity */

// ---------------------------------------------------------------------------
// Web search (/research with OpenAI or Anthropic): tool definitions, activity rows, sources
// ---------------------------------------------------------------------------
// The search runs on the provider's side. The stream parsers report each search as a plain activity
// row ("🔍 web_search: query") through hooks.onActivity and return { activity, sources } with the
// result; the tool loop stores them on the assistant message (_toolActivity, _sources) so renderHistory
// shows the rows and the "Sources" list again. The raw blocks / items stay in the round's replay data.
function anthropicWebSearchTool(model) {
  return { type: anthropicAdaptive(model) ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: ANTHROPIC_WEB_SEARCH_MAX_USES };
}

// Activity row of an OpenAI web_search_call output item (action: search / open_page / find_in_page).
function openaiSearchRow(item) {
  const a = (item && item.action) || {};
  const name = a.type === 'open_page' ? 'open_page' : a.type === 'find_in_page' || a.type === 'find' ? 'find_in_page' : 'web_search';
  let summary = a.query || (Array.isArray(a.queries) && a.queries[0]) || a.url || a.pattern || '';
  if (item && item.status === 'failed') summary = summary ? `${summary} (failed)` : 'failed';
  return { name, summary: String(summary) };
}

// Activity rows of the Anthropic server tool calls (web_search / web_fetch; the code execution blocks
// of dynamic filtering are not listed), with the error code of a failed search.
function anthropicActivity(blocks) {
  const results = new Map();
  for (const b of blocks) if (b && /_tool_result$/.test(b.type || '') && b.tool_use_id) results.set(b.tool_use_id, b);
  const rows = [];
  for (const b of blocks) {
    if (!b || b.type !== 'server_tool_use' || !/^web_(search|fetch)$/.test(b.name || '')) continue;
    const input = b.input || {};
    let summary = String(input.query || input.url || '');
    const r = results.get(b.id);
    if (r && r.content && !Array.isArray(r.content) && r.content.error_code) summary += ` (failed: ${r.content.error_code})`;
    rows.push({ name: b.name, summary: summary.trim() });
  }
  return rows;
}

// Sources: http(s) links, de-duplicated by URL, at most SOURCES_MAX.
function addSource(list, url, title) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u) || list.length >= SOURCES_MAX || list.some((x) => x.url === u)) return;
  list.push({ url: u, title: String(title || '').trim() });
}
// url_citation annotations of the output_text parts of OpenAI message items.
function openaiSources(items) {
  const out = [];
  for (const it of items || []) {
    if (!it || it.type !== 'message' || !Array.isArray(it.content)) continue;
    for (const c of it.content) for (const a of (c && c.annotations) || []) if (a && a.type === 'url_citation') addSource(out, a.url, a.title);
  }
  return out;
}
// Citations of the Anthropic text blocks (web_search_result_location and other located citations).
function anthropicSources(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (!b || b.type !== 'text' || !Array.isArray(b.citations)) continue;
    for (const c of b.citations) if (c && c.url) addSource(out, c.url, c.title);
  }
  return out;
}

// The "Sources" list under an answer (links open in a new tab); replaced when called again.
function renderSources(b, sources) {
  if (!b || !b._parts) return;
  const list = Array.isArray(sources) ? sources.filter((x) => x && /^https?:\/\//i.test(x.url || '')) : [];
  if (b._parts.sources) { b._parts.sources.remove(); b._parts.sources = null; }
  if (!list.length) return;
  const d = document.createElement('div');
  d.className = 'sources';
  d.innerHTML = '<div class="sources-title">Sources</div><ol>' + list.map((x) => {
    let host = x.url;
    try { host = new URL(x.url).hostname; } catch (e) { /* keep the URL */ }
    return `<li><a href="${escapeHtml(x.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(x.url)}">${escapeHtml(x.title || host)}</a></li>`;
  }).join('') + '</ol>';
  if (b._parts.meta && b._parts.meta.parentNode === b) b.insertBefore(d, b._parts.meta); else b.appendChild(d);
  b._parts.sources = d;
}

// Status line while a turn searches: "<provider> /research is searching the web… (N searches)",
// counted over all rounds of the turn (snap.searchesDone: finished rounds).
const countSearches = (rows) => (rows || []).filter((a) => a && a.name === 'web_search').length;
function noteSearchActivity(snap, rows) {
  const n = (snap.searchesDone || 0) + countSearches(rows);
  if (n) setStatus(`${snap.prov.label} /research is searching the web… (${n} search${n === 1 ? '' : 'es'})`);
}
