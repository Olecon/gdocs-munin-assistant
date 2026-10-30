'use strict';
// Module dom.js: the element table (el, $), small DOM/status helpers (escapeHtml, setStatus, fmtNum,
// scrollToBottom, appendToChat), the Markdown-lite renderer (renderInline, renderMarkdown, actionButtons) and the chat's
// copy handler (onChatCopy: Ctrl+C without the panel's colours).
/* global docAsOfSuffix, docLineCounts, NUM_LOCALE, state */
/* exported $, el, escapeHtml, scrollToBottom, appendToChat, setStatus, fmtNum, docStatusText, actionButtons, renderMarkdown, onChatCopy */

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  chat: $('chat'), input: $('input'), action: $('actionBtn'),
  docTitle: $('docTitle'), docStatus: $('docStatus'), brandLogo: $('brandLogo'),
  settings: $('settings'), provider: $('provider'), apiKeyLabel: $('apiKeyLabel'), apiKey: $('apiKey'), keyWarn: $('keyWarn'),
  modelSelect: $('modelSelect'), checkModels: $('checkModels'), modelStatus: $('modelStatus'),
  googleStatus: $('googleStatus'), googleConnect: $('googleConnect'), googleSwitch: $('googleSwitch'),
  googleDisconnect: $('googleDisconnect'), googleHint: $('googleHint'),
  selBox: $('selBox'), selPreview: $('selPreview'), selFull: $('selFull'),
  trimNote: $('trimNote'), composer: $('composer'), splitter: $('splitter'), collapseBtn: $('collapseBtn'),
  cmdPopup: $('cmdPopup'), cmdBtn: $('cmdBtn'),
  modeCycle: $('modeCycle'), modeLabel: $('modeLabel'), modeMenu: $('modeMenu'),
  newChatBtn: $('newChatBtn'), chatSwitchBtn: $('chatSwitchBtn'), chatSwitchTitle: $('chatSwitchTitle'), chatMenu: $('chatMenu'),
  instructions: $('instructions'), instructionsBtn: $('instructionsBtn'), instructionsDot: $('instructionsDot'),
  instructionsText: $('instructionsText'), instructionsCount: $('instructionsCount'),
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function scrollToBottom(force) {
  const c = el.chat;
  const nearBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 80;
  if (force || nearBottom) c.scrollTop = c.scrollHeight;
}

// Appends a node to the chat (the empty-chat hint goes) and, with scroll, shows the end of the chat.
function appendToChat(node, scroll = true) {
  el.chat.querySelector('.empty')?.remove();
  el.chat.appendChild(node);
  if (scroll) scrollToBottom(true);
  return node;
}

function setStatus(text, warn) {
  el.docStatus.textContent = text || '';
  el.docStatus.title = text || '';
  el.docStatus.classList.toggle('warn', !!warn);
}

const fmtNum = (n) => Number(n).toLocaleString(NUM_LOCALE);

// The document line: "1,234 characters · 210 words", the typing estimate included (src/doc-live.js), and on the
// export path " · as of 14:32" once the last read is old.
function docStatusText() {
  if (state.docText == null) return 'Document text unavailable';
  const { chars, words } = docLineCounts();
  return `${fmtNum(chars)} character${chars === 1 ? '' : 's'} · ${fmtNum(words)} word${words === 1 ? '' : 's'}` + docAsOfSuffix();
}

// ---------------------------------------------------------------------------
// Markdown-lite renderer (escape first, then apply markup)
// ---------------------------------------------------------------------------
function renderEmphasis(s) {
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([^~\n]*?\S)~~/g, '<del>$1</del>');
  return s;
}

// [label](http(s)://url) on the escaped text; the URL may contain one level of balanced parentheses
// (".../Lipid_raft_(biology)"). Links are cut out before the emphasis rules and put back afterwards,
// so "_" or "*" inside a URL never become <em>/<strong> (the label still gets emphasis).
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g;
const LINK_SLOT = '\u0000'; // brackets a link's index while emphasis is applied (removed from the input first)
const LINK_SLOT_RE = /\u0000(\d+)\u0000/g; // eslint-disable-line no-control-regex

function renderInline(text) {
  const parts = String(text).split(LINK_SLOT).join('').split(/(`[^`\n]+`)/);
  return parts.map((p, i) => {
    if (i % 2 === 1) return '<code>' + escapeHtml(p.slice(1, -1)) + '</code>';
    const links = [];
    let s = escapeHtml(p).replace(LINK_RE, (m, label, url) => LINK_SLOT + (links.push({ label, url }) - 1) + LINK_SLOT);
    s = renderEmphasis(s);
    return s.replace(LINK_SLOT_RE, (m, n) => {
      const { label, url } = links[Number(n)];
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${renderEmphasis(label)}</a>`;
    });
  }).join('');
}

// Icon buttons under answers and in code-block bars: "Apply to selection" (arrow into a box) and
// "Copy" (two sheets; shows a check mark for a moment after copying). The text stays as the tooltip.
const ICON_APPLY = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M21 3.01H3c-1.1 0-2 .9-2 2V9h2V4.99h18v14.03H3V15H1v4.01c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98v-14c0-1.11-.9-2-2-2zM11 16l4-4-4-4v3H1v2h10v3z"/></svg>';
const ICON_COPY = '<svg class="icon-copy" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>' +
  '<svg class="icon-check" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
// applyAct null: Copy only (a Plan answer).
function actionButtons(applyAct, copyAct, idx) {
  const data = idx == null ? '' : ` data-idx="${idx}"`;
  return (applyAct ? `<button class="btn icon" data-act="${applyAct}"${data} title="Apply to selection" aria-label="Apply to selection">${ICON_APPLY}</button>` : '') +
    `<button class="btn icon" data-act="${copyAct}"${data} title="Copy" aria-label="Copy">${ICON_COPY}</button>`;
}

// Returns { html, codes } where codes holds the contents of code blocks (for the buttons). codes: an
// array to append to, so that several rendered parts of one answer share the button indices.
function renderMarkdown(src, codes = []) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let para = [];
  let list = null; // { tag, items: [] }

  const flushPara = () => {
    if (para.length) html += '<p>' + para.map(renderInline).join('<br>') + '</p>';
    para = [];
  };
  const flushList = () => {
    if (list) html += `<${list.tag}>` + list.items.map((t) => '<li>' + renderInline(t) + '</li>').join('') + `</${list.tag}>`;
    list = null;
  };
  const flushAll = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flushAll();
      const marker = fence[1];
      const lang = fence[2] || '';
      const body = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(marker) && lines[i].trim().replace(/[`~]/g, '') === '')) {
        body.push(lines[i]);
        i++;
      }
      const code = body.join('\n');
      const idx = codes.push(code) - 1;
      html += '<div class="code-wrap"><div class="code-bar">' +
        `<span class="code-lang">${escapeHtml(lang)}</span>` +
        actionButtons('apply-code', 'copy-code', idx) +
        `</div><pre><code>${escapeHtml(code)}</code></pre></div>`;
      continue;
    }
    if (/^\s*$/.test(line)) { flushAll(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushAll();
      const lvl = Math.min(m[1].length + 1, 4);
      html += `<h${lvl}>${renderInline(m[2])}</h${lvl}>`;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); html += '<hr>'; continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { flushAll(); html += `<blockquote>${renderInline(m[1])}</blockquote>`; continue; }
    if ((m = line.match(/^\s*[-*+•]\s+(.*)$/))) {
      flushPara();
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { // continuation of a list item
      list.items[list.items.length - 1] += ' ' + line.trim();
      continue;
    }
    flushList();
    para.push(line);
  }
  flushAll();
  return { html, codes };
}

// ---------------------------------------------------------------------------
// Copying a selection from the chat (Ctrl+C)
// ---------------------------------------------------------------------------
// Chrome copies a selection as text/html with the computed colours and fonts inline, and Google Docs keeps
// them (white text on black from the dark theme). The chat's copy handler writes plain text plus a cleaned
// HTML copy instead: structural tags only, no attributes but a link's http(s) href.
const COPY_KEEP_TAGS = new Set(['P', 'BR', 'HR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'UL', 'OL', 'LI', 'A', 'CODE', 'PRE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);
// Panel UI inside the chat, not answer content: buttons, the action log, token usage, code-block bars, card
// controls, badges, the Thinking and summary-divider headers (class names from src/render.js and dom.js).
const COPY_DROP = 'button, svg, input, textarea, select, script, style, .msg-meta, .msg-actions, .activity, .activity-row, ' +
  '.code-bar, .tool-actions, .side-badge, .persona-badge, .thinking > summary, .summary-divider > summary';
const COPY_BLOCK_TAGS = /^(P|PRE|H[1-6]|BLOCKQUOTE|LI|TR|HR|UL|OL|TABLE)$/;

// Cleans a node list in place (recursively). Returns true when panel UI with text was dropped.
function sanitizeCopy(parent) {
  let dropped = false;
  for (const n of [...parent.childNodes]) {
    if (n.nodeType === 3) continue;
    if (n.nodeType !== 1) { n.remove(); continue; }
    if (n.matches(COPY_DROP)) { dropped = dropped || !!n.textContent.trim(); n.remove(); continue; }
    if (sanitizeCopy(n)) dropped = true;
    const tag = n.tagName;
    const href = tag === 'A' && /^https?:\/\//i.test(n.getAttribute('href') || '') ? n.getAttribute('href') : null;
    // A div with its own text (a user bubble, a notice) becomes a paragraph; other unknown tags are unwrapped.
    const asPara = tag === 'DIV' && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (!asPara && (!COPY_KEEP_TAGS.has(tag) || (tag === 'A' && !href))) { n.replaceWith(...n.childNodes); continue; }
    const clean = document.createElement(asPara ? 'p' : tag.toLowerCase());
    if (href) clean.setAttribute('href', href);
    clean.append(...n.childNodes);
    n.replaceWith(clean);
  }
  return dropped;
}

// Plain text of a cleaned fragment with line breaks at blocks (used only when UI text was dropped).
function copyPlainText(node) {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) { out += n.textContent; continue; }
    if (n.tagName === 'BR') { out += '\n'; continue; }
    out += copyPlainText(n);
    if (COPY_BLOCK_TAGS.test(n.tagName)) out += /^(LI|TR)$/.test(n.tagName) ? '\n' : '\n\n';
  }
  return out;
}

// The `copy` listener of #chat. Leaves the copy to the browser when there is no clipboardData, the
// selection is empty or outside the chat (or in a form field).
function onChatCopy(ev) {
  const sel = window.getSelection();
  if (!ev.clipboardData || !sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const anchor = range.commonAncestorContainer;
  const node = anchor.nodeType === 1 ? anchor : anchor.parentElement;
  if (!node || !el.chat.contains(node) || node.closest('input, textarea, select, form')) return;
  const text = sel.toString();
  if (!text) return;
  const frag = range.cloneContents();
  const dropped = sanitizeCopy(frag);
  const box = document.createElement('div');
  box.append(frag);
  ev.preventDefault();
  ev.clipboardData.setData('text/plain', dropped ? copyPlainText(box).replace(/\n{3,}/g, '\n\n').trim() : text);
  if (box.querySelector('*')) ev.clipboardData.setData('text/html', '<meta charset="utf-8">' + box.innerHTML);
}
