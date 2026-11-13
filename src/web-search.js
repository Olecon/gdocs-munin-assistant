'use strict';
// Module web-search.js: server-side web search with OpenAI or Anthropic (every turn with client tools: webSearchTurn): the tool
// definition, activity rows and the Sources fold of a round (renderSources, openaiSources, anthropicSources).
/* global ANTHROPIC_BASIC_SEARCH, ANTHROPIC_WEB_SEARCH_MAX_USES, anthropicAdaptive, escapeHtml, paintBubble, setStatus, SOURCES_MAX */
/* exported anthropicWebSearchTool, openaiSearchRow, anthropicActivity, openaiSources, anthropicSources,
   renderSources, stripCitationMarkers, countSearches, noteSearchActivity, addSources */

// ---------------------------------------------------------------------------
// Web search (OpenAI or Anthropic): tool definitions, activity rows, sources
// ---------------------------------------------------------------------------
// The search runs on the provider's side. The stream parsers report each search as a plain activity
// row ("web_search: query") through hooks.onActivity and return { activity, sources } with the
// result; the tool loop stores them on the assistant message (_toolActivity, _sources) so renderHistory
// shows the rows and the round's "Sources" fold again. The raw blocks / items stay in the round's replay data.
// basic: the search without dynamic filtering for every model (the API refused the filtering one: anthropicBasicSearch).
function anthropicWebSearchTool(model, basic = false) {
  return { type: anthropicAdaptive(model) && !basic ? 'web_search_20260209' : ANTHROPIC_BASIC_SEARCH, name: 'web_search', max_uses: ANTHROPIC_WEB_SEARCH_MAX_USES };
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
// list with the sources of more added (de-duplicated, http(s) only, at most SOURCES_MAX); returns list. The client
// search tool (src/munin-search.js) keeps its links on its tool message this way.
function addSources(list, more) {
  for (const x of more || []) if (x) addSource(list, x.url, x.title);
  return list;
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
// OpenAI's inline citation markers: the Responses API may write its web-search citations into the output text as
// private-use spans, U+E200 (start) "cite" U+E202 "turn0search1" (U+E202 "turn0news2" …) U+E201 (end), also "navlist",
// "filecite", "image" and other kinds. The links come from the url_citation annotations (openaiSources), so the spans are
// noise: the whole span goes, with the blank before it. A span cut by the end of the text (a stream still arriving) goes
// too, and so does a bare "citeturn0search1" / "turn0search1" whose private-use characters were already dropped.
const CITE_SPAN_RE = /[ \t]*[^]*(?:|$)/g;
const CITE_BARE_RE = /[ \t]*(?<![\p{L}\p{N}])(?:cite|navlist|filecite)?(?:turn\d+[a-z]+\d+)(?:[,]?turn\d+[a-z]+\d+)*(?![\p{L}\p{N}])/gu;
function stripCitationMarkers(text) {
  const s = String(text == null ? '' : text);
  if (!/[-]|turn\d/.test(s)) return s; // the common case: nothing to do
  return s.replace(CITE_SPAN_RE, '').replace(/[-]/g, '').replace(CITE_BARE_RE, '');
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

// The "Sources" of a round, where they were used (the owner's choice): sources join the bubble's last round (the round
// being drawn: its web search's citations, then the links of its Munin search calls; de-duplicated, at most SOURCES_MAX)
// and its fold is drawn again inside that round's item on the timeline rail, after its rows and before its own text, so
// the links stand under the searches that found them. Links open in a new tab. A fold, collapsed by default (the list is
// long and the answer comes first): "Sources · N" with the ▸ marker of the other folds; a click (Enter, Space: it is a
// summary) opens the links. The open lists are kept while the panel is open (openSources, keyed by their links, so a
// re-render keeps them), never stored.
const openSources = new Set();
function renderSources(b, sources) {
  const r = b && b._parts && b._rounds ? b._rounds[b._rounds.length - 1] : null;
  if (!r) return;
  const list = addSources(r.sources || (r.sources = []), Array.isArray(sources) ? sources : []);
  if (r.parts.sources) { r.parts.sources.remove(); r.parts.sources = null; }
  if (!list.length) return;
  const key = list.map((x) => x.url).join('\n');
  const d = document.createElement('details');
  d.className = 'sources';
  // The count is chrome (COPY_DROP): a copy of the bubble reads "Sources" and the links, as before the fold.
  d.innerHTML = `<summary class="sources-title">Sources<span class="sources-count"> · ${list.length}</span></summary><ol>` + list.map((x) => {
    let host = x.url;
    try { host = new URL(x.url).hostname; } catch (e) { /* keep the URL */ }
    return `<li><a href="${escapeHtml(x.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(x.url)}">${escapeHtml(x.title || host)}</a></li>`;
  }).join('') + '</ol>';
  d.open = openSources.has(key);
  d.addEventListener('toggle', () => { if (d.open) openSources.add(key); else openSources.delete(key); });
  r.el.insertBefore(d, r.parts.text);
  r.parts.sources = d;
  paintBubble(b); // the round's item shows (a round may hold its Sources alone: the citations of a final answer)
}

// Status line while a turn searches: "<provider> /research is searching the web… (N searches)",
// counted over all rounds of the turn (snap.searchesDone: finished rounds).
const countSearches = (rows) => (rows || []).filter((a) => a && a.name === 'web_search').length;
function noteSearchActivity(snap, rows) {
  const n = (snap.searchesDone || 0) + countSearches(rows);
  if (n) setStatus(`${snap.prov.label} /research is searching the web… (${n} search${n === 1 ? '' : 'es'})`);
}
