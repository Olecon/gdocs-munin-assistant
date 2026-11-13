'use strict';
// The real Google Docs API as a backend of the benches, in place of test/lib/fake-docs.js (opt-in: development/tools/
// real-docs.js and tool-eval.js's runOnce with opts.docsServer; npm test never reaches the network or a key here).
// - serviceAccountAuth(keyFile): an access token of a Google service account (a JWT signed RS256 with node:crypto,
//   exchanged at oauth2.googleapis.com). The key and the token stay in this module's closures: nothing prints them.
// - docsClient({ auth, writable }): get / batchUpdate with a write guard: a batchUpdate on a document whose id is not in
//   `writable` (the ids the runner allows) is refused before anything is sent. 429 and 503 are retried with a back-off;
//   writes are paced (the per-user write quota is 60 a minute).
// - realDocsServer(client, { docId, tabId }): the fake server's face for the sandbox (fetch(url, init) answering
//   docs.googleapis.com, null for other URLs), pinned to one Docs tab of one document: the panel's document id (DOC123,
//   installDocTab) maps to docId and back, any other id answers 404 without a request; reads show the panel that tab
//   alone, as the first and only tab (a shared test document keeps its own content in its other tabs), and every write is
//   checked to address that tab only (pinRequests). The panel's Authorization header is replaced by the account's token.
// - buildPlan / resetDocument: bring a Docs tab to a fake-docs spec (see buildPlan for what cannot be built).
// - mirrorServer(body, tabId): a fake server rendering a real documents.get body with its real named styles, so tool-eval's
//   docLines reads a real document the way it reads the fake one.
const fs = require('fs');
const crypto = require('crypto');
const { fakeDocsServer, specFromBody, DOCS_NAMED, namedOver, NAMED_TYPES, apiStyle, normPstyle, PRESET_GLYPHS } = require('./fake-docs');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DOCS_URL = 'https://docs.googleapis.com/v1/documents';
const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const dim = (n) => ({ magnitude: n, unit: 'PT' });

// ---- Access ----------------------------------------------------------------------------------------------------------
// An access token for the service account in keyFile (the JSON key Google issues), renewed a minute before it expires.
// Returns { email, project, token() }. fetchImpl: for tests.
function serviceAccountAuth(keyFile, { scopes = [DOCS_SCOPE], fetchImpl = fetch } = {}) {
  const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  if (!key.client_email || !key.private_key) throw new Error(`${keyFile}: not a service account key (no client_email or private_key)`);
  let cached = null;
  const token = async () => {
    if (cached && cached.until > Date.now()) return cached.value;
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: key.client_email, scope: scopes.join(' '), aud: key.token_uri || TOKEN_URL, iat: now, exp: now + 3600 }));
    const sig = b64url(crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key));
    const r = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }).toString() });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* not JSON */ }
    if (!r.ok || !j || !j.access_token) {
      // Google's error words only (error, error_description): never the assertion or a token.
      const why = j ? [j.error, j.error_description].filter(Boolean).join(': ') : text.slice(0, 200);
      throw new Error(`token request refused (HTTP ${r.status}): ${why}`);
    }
    cached = { value: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000 };
    return cached.value;
  };
  return { email: key.client_email, project: key.project_id || '', token };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A Docs API client with the write guard. writable: a Set of document ids that may be written (create adds the new id).
// log(entry): every request { method, path, status, ms, retries } (no headers, no bodies). minWriteGapMs: the pause
// between two writes (1.1 s keeps under 60 a minute).
function docsClient({ auth, writable = new Set(), fetchImpl = fetch, log = () => {}, minWriteGapMs = 1100, retries = 5 }) {
  let lastWrite = 0;
  const stats = { reads: 0, writes: 0, retried: 0 };
  // One request with the account's token; 429 / 503 retried with a growing pause. Returns { status, ok, text, json }.
  const send = async (method, url, body) => {
    const write = method !== 'GET';
    let tries = 0;
    for (;;) {
      if (write) { const wait = lastWrite + minWriteGapMs - Date.now(); if (wait > 0) await sleep(wait); lastWrite = Date.now(); }
      stats[write ? 'writes' : 'reads']++;
      const t0 = Date.now();
      const init = { method, headers: { Authorization: `Bearer ${await auth.token()}` } };
      if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = typeof body === 'string' ? body : JSON.stringify(body); }
      const r = await fetchImpl(url, init);
      const text = await r.text();
      log({ method, path: url.replace(DOCS_URL, '').slice(0, 120), status: r.status, ms: Date.now() - t0, retries: tries });
      if ((r.status === 429 || r.status === 503) && tries < retries) { tries++; stats.retried++; await sleep(Math.min(64000, 2000 * 2 ** tries)); continue; }
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
      return { status: r.status, ok: r.ok, text, json };
    }
  };
  const guard = (id) => {
    if (!writable.has(id)) throw new Error(`refused: document ${id} is not one this runner may write (created by the test account or listed in test-docs.txt)`);
  };
  const docUrl = (id) => `${DOCS_URL}/${encodeURIComponent(id)}`;
  return {
    writable, stats, send,
    get: (id, query = '') => send('GET', `${docUrl(id)}${query ? '?' + query : ''}`),
    // A write to a document outside `writable` throws before anything is sent.
    batchUpdate: (id, body) => { guard(id); return send('POST', `${docUrl(id)}:batchUpdate`, body); },
    create: async (title) => {
      const r = await send('POST', DOCS_URL, { title });
      if (r.ok && r.json && r.json.documentId) writable.add(r.json.documentId);
      return r;
    },
  };
}

// ---- Tabs ------------------------------------------------------------------------------------------------------------
const flatTabs = (tabs, out = []) => { for (const t of tabs || []) { out.push(t); flatTabs(t.childTabs, out); } return out; };
// The Docs tab of a documents.get body (includeTabsContent) with that id, or null.
const tabOfBody = (doc, tabId) => flatTabs(doc && doc.tabs).find((t) => t.tabProperties && t.tabProperties.tabId === tabId) || null;
// The id of the tab titled `title` (made with addDocumentTab when missing). A shared test document keeps the owner's
// content in its other tabs; named styles, lists, headers and the body are per tab, so the scratch tab is a document of
// its own except for the revision and the comments.
async function scratchTab(client, docId, title) {
  const g = await client.get(docId, 'includeTabsContent=true&fields=tabs(tabProperties(tabId,title),childTabs(tabProperties(tabId,title)))');
  if (!g.ok) throw new Error(`documents.get ${g.status}: ${(g.json && g.json.error && g.json.error.message) || g.text.slice(0, 200)}`);
  const hit = flatTabs(g.json.tabs).find((t) => t.tabProperties.title === title);
  if (hit) return hit.tabProperties.tabId;
  const r = await client.batchUpdate(docId, { requests: [{ addDocumentTab: { tabProperties: { title } } }] });
  if (!r.ok) throw new Error(`addDocumentTab ${r.status}: ${(r.json && r.json.error && r.json.error.message) || r.text.slice(0, 200)}`);
  return r.json.replies[0].addDocumentTab.tabProperties.tabId;
}

// The requests of a batch, pinned to one tab: a location or range without a tabId gets it (the API would take the first
// tab, which belongs to the owner), so does a request whose tabId sits at its top (named and document styles, header and
// footer deletion); a tabId of another tab, a request that changes tabs or works across tabs (replaceAllText without
// tabsCriteria), or a header / footer created without its section break, throws. notes: what was added, for the report.
const TOP_TAB_REQUESTS = ['updateNamedStyle', 'updateDocumentStyle', 'deleteHeader', 'deleteFooter', 'deletePositionedObject'];
const LOCATION_KEYS = ['location', 'range', 'endOfSegmentLocation', 'tableStartLocation', 'sectionBreakLocation'];
const CROSS_TAB_REQUESTS = ['addDocumentTab', 'deleteTab', 'updateDocumentTabProperties', 'replaceAllText', 'replaceNamedRangeContent', 'deleteNamedRange'];
function pinRequests(requests, tabId, notes = []) {
  return (requests || []).map((rq, i) => {
    const name = Object.keys(rq || {})[0];
    if (CROSS_TAB_REQUESTS.includes(name)) throw new Error(`requests[${i}].${name} may reach other tabs: not sent`);
    if ((name === 'createHeader' || name === 'createFooter') && !(rq[name] && rq[name].sectionBreakLocation)) throw new Error(`requests[${i}].${name} without sectionBreakLocation would go to the first tab: not sent`);
    const body = clone(rq[name]) || {};
    if (TOP_TAB_REQUESTS.includes(name) && !body.tabId) { body.tabId = tabId; notes.push(`${name}: tabId added`); }
    const walk = (o, key) => {
      if (!o || typeof o !== 'object') return;
      if (LOCATION_KEYS.includes(key) && !Array.isArray(o) && !o.tabId) { o.tabId = tabId; notes.push(`${name}.${key}: tabId added`); }
      for (const [k, v] of Object.entries(o)) walk(v, k);
    };
    for (const [k, v] of Object.entries(body)) walk(v, k);
    const other = [];
    const scan = (o) => { if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if (k === 'tabId' && v !== tabId) other.push(v); else scan(v); } };
    scan(body);
    if (other.length) throw new Error(`requests[${i}].${name} addresses tab ${other[0]}, not the test tab: not sent`);
    return { [name]: body };
  });
}

// A documents.get body cut to one tab (the panel then sees it as the first and only tab).
function oneTabBody(doc, tabId) {
  if (!doc || !Array.isArray(doc.tabs)) return doc;
  const t = tabOfBody(doc, tabId);
  const out = { ...doc, tabs: t ? [{ ...t, tabProperties: { ...t.tabProperties, index: 0 }, childTabs: undefined }] : [] };
  if (out.tabs[0] && out.tabs[0].childTabs === undefined) delete out.tabs[0].childTabs;
  return out;
}

// ---- The server the sandbox talks to ------------------------------------------------------------------------------------
const PANEL_DOC_RE = /^https:\/\/docs\.googleapis\.com\/v1\/documents\/([^?:/]+)(:batchUpdate)?(\?.*)?$/;
// Top-level fields a read without includeTabsContent may ask for (anything else would come from the first tab).
const FLAT_SAFE = ['revisionId', 'documentId', 'title'];
// opts: { docId, tabId, alias ('DOC123'), log (Array: the panel's requests { method, url, body, status, response? }),
// keepResponses (store response texts in the log) }. Returns { fetch, docId, tabId, tabs, log, notes, read, mirror }.
function realDocsServer(client, { docId, tabId, alias = 'DOC123', keepResponses = true } = {}) {
  const log = [];
  const notes = [];
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const local = (status, message) => json(status, { error: { code: status, message, status: status === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT' } });
  // The real id in a response becomes the panel's id again.
  const back = (text) => (alias && alias !== docId ? String(text).split(docId).join(alias) : String(text));
  const srv = {
    docId, tabId, alias, log, notes, tabs: [{ id: tabId }], real: true,
    async fetch(url, init = {}) {
      const m = PANEL_DOC_RE.exec(String(url));
      if (!m) return null;
      const id = decodeURIComponent(m[1]);
      const method = init.method || 'GET';
      const entry = { method, url: String(url).replace(docId, alias), body: init.body ? JSON.parse(init.body) : null };
      log.push(entry);
      if (id !== alias && id !== docId) { entry.status = 404; return local(404, 'Requested entity was not found. (real-docs backend: not the pinned test document; nothing was sent)'); }
      const query = m[3] || '';
      if (!m[2]) {
        const params = new URLSearchParams(query.slice(1));
        if (params.get('includeTabsContent') !== 'true') {
          const names = String(params.get('fields') || '').split(',').map((s) => s.trim()).filter(Boolean);
          if (!names.length || names.some((n) => !FLAT_SAFE.includes(n))) {
            entry.status = 400;
            notes.push(`a read without includeTabsContent (${params.get('fields') || 'no fields'}) was not sent: it would read the first tab`);
            return local(400, 'real-docs backend: a read without includeTabsContent would read the first tab; not sent');
          }
        }
        const r = await client.send('GET', `${DOCS_URL}/${encodeURIComponent(docId)}${query}`);
        entry.status = r.status;
        let text = r.text;
        if (r.ok && r.json) text = JSON.stringify(oneTabBody(r.json, tabId));
        if (keepResponses) entry.response = back(text);
        return new Response(back(text), { status: r.status, headers: { 'Content-Type': 'application/json' } });
      }
      let body;
      try { body = { ...entry.body, requests: pinRequests(entry.body.requests, tabId, notes) }; } catch (e) {
        entry.status = 400;
        notes.push(e.message);
        return local(400, `real-docs backend: ${e.message}`);
      }
      const r = await client.batchUpdate(docId, body);
      entry.status = r.status;
      if (keepResponses) entry.response = back(r.text);
      return new Response(back(r.text), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    },
    // The pinned tab's body as the API gives it without a fields mask (one tab, with namedStyles and lists).
    async read() {
      const r = await client.get(docId, 'includeTabsContent=true');
      if (!r.ok) throw new Error(`documents.get ${r.status}: ${r.text.slice(0, 200)}`);
      return oneTabBody(r.json, tabId);
    },
    // A fake server holding the real document (tool-eval's docLines reads it).
    async mirror() { return mirrorServer(await srv.read(), tabId); },
  };
  return srv;
}

// A fake-docs server that renders a real body (specFromBody), with the tab's real named styles in place of Docs' defaults.
function mirrorServer(body, tabId) {
  const fake = fakeDocsServer(specFromBody(body, { documentId: body.documentId }));
  for (const t of flatTabs(body.tabs)) {
    const ft = fake.tabs.find((x) => x.id === t.tabProperties.tabId);
    const styles = (t.documentTab.namedStyles && t.documentTab.namedStyles.styles) || [];
    if (ft && styles.length) for (const s of styles) ft.named[s.namedStyleType] = { textStyle: clone(s.textStyle || {}), paragraphStyle: clone(s.paragraphStyle || {}) };
  }
  if (tabId && !fake.tabs.some((t) => t.id === tabId)) throw new Error(`tab ${tabId} is not in the body`);
  return fake;
}

// ---- Building a spec through the API --------------------------------------------------------------------------------------
// The text fields a reset clears and the paragraph fields the build resets on the paragraph that survives the delete.
const TEXT_RESET_FIELDS = 'bold,italic,underline,strikethrough,smallCaps,backgroundColor,foregroundColor,fontSize,weightedFontFamily,baselineOffset,link';
const PARA_RESET_FIELDS = ['namedStyleType', 'alignment', 'lineSpacing', 'direction', 'spaceAbove', 'spaceBelow', 'indentStart', 'indentFirstLine', 'indentEnd',
  'keepLinesTogether', 'keepWithNext', 'avoidWidowAndOrphan', 'pageBreakBefore'];
// The named-style fields a reset writes: the spec's values (fake-docs' defaults with spec.namedStyles over them; indents in pt
// as tool-eval's namedIndents), every other one listed without a value (reset).
const NAMED_TEXT_FIELDS = ['bold', 'italic', 'underline', 'fontSize', 'weightedFontFamily', 'foregroundColor', 'backgroundColor', 'baselineOffset'];
const NAMED_PARA_FIELDS = ['alignment', 'lineSpacing', 'direction', 'spaceAbove', 'spaceBelow', 'indentStart', 'indentFirstLine', 'indentEnd',
  'keepWithNext', 'keepLinesTogether', 'avoidWidowAndOrphan', 'pageBreakBefore'];
function namedStyleRequests(spec, tabId) {
  const base = DOCS_NAMED();
  return NAMED_TYPES.map((type) => {
    const v = (spec.namedStyles || {})[type] || {};
    const st = namedOver(base[type], v);
    for (const k of ['indentStart', 'indentFirstLine']) if (typeof v[k] === 'number') st.paragraphStyle[k] = dim(v[k]);
    const fields = ['namedStyleType', ...NAMED_TEXT_FIELDS.map((f) => 'textStyle.' + f), ...NAMED_PARA_FIELDS.map((f) => 'paragraphStyle.' + f)];
    return { updateNamedStyle: { namedStyle: { namedStyleType: type, textStyle: st.textStyle, paragraphStyle: st.paragraphStyle }, fields: fields.join(','), tabId } };
  });
}
// The spec text of a paragraph as inserted: footnote marks and object characters are not built (they are dropped).
const builtText = (p) => String(p.p || '').replace(/\[\^[^\]]+\]/g, '').split(String.fromCharCode(0xFFFC)).join('');
// The text style of a spec fmt entry as an updateTextStyle (fake-docs' apiStyle; a false bold / italic / underline is sent).
function textStyleRequest(st, range) {
  const ts = apiStyle(st);
  const fields = Object.keys(ts);
  for (const k of ['bold', 'italic', 'underline']) if (st[k] === false && !fields.includes(k)) { ts[k] = false; fields.push(k); }
  return fields.length ? { updateTextStyle: { range, textStyle: ts, fields: fields.join(',') } } : null;
}
// The paragraphs of a body in reading order (the body's own, then each table cell's, row by row; a table of contents left
// out): [{ start, end (the newline's index + 1), text (objects as U+FFFC), paragraph }].
function bodyParagraphs(content, out = []) {
  for (const el of content || []) {
    if (el.paragraph) {
      const text = (el.paragraph.elements || []).map((e) => (e.textRun ? String(e.textRun.content || '') : String.fromCharCode(0xFFFC))).join('').replace(/\n$/, '');
      out.push({ start: el.startIndex, end: el.endIndex, text, paragraph: el.paragraph });
    } else if (el.table) for (const row of el.table.tableRows || []) for (const cell of row.tableCells || []) bodyParagraphs(cell.content, out);
  }
  return out;
}
// The spec's paragraphs of a tab in reading order, with what the build needs: [{ item, tabs (leading tabs inserted for
// the nesting level), text, cell }]; unsupported: the parts of the spec that are not built.
function specParagraphs(tab, unsupported) {
  const out = [];
  const add = (p, cell) => {
    const text = builtText(p);
    if (text !== String(p.p || '')) unsupported.push(`"${String(p.p).slice(0, 30)}": footnote marks and objects are not built (left out)`);
    if (p.suggest || p.nl) unsupported.push(`"${String(p.p).slice(0, 30)}": suggestions are not built (plain text)`);
    if (p.objects) unsupported.push(`"${String(p.p).slice(0, 30)}": chips and images are not built`);
    const tabs = p.bullet ? p.bullet.level || 0 : 0;
    out.push({ item: p, tabs, text, cell: !!cell });
  };
  for (const it of tab.items || []) {
    if (it.table) { for (const row of it.table) for (const cell of row) for (const p of cell) add(p, true); continue; }
    if (it.toc) { unsupported.push('a table of contents is not built'); continue; }
    if (it.section) { unsupported.push('a section break is not built'); continue; }
    add(it, false);
  }
  return out;
}
// Batch A of a reset: clear the tab (its body, headers and footers), set the named styles, insert the text and the tables.
// body: the tab's current documentTab. Returns { requests, unsupported }.
// Built: paragraphs with their text (list items with leading tabs, removed again by createParagraphBullets in batch B) and
// tables (insertTable after the previous paragraph, the cells filled from the last). Not built (listed in unsupported):
// footnotes, headers and footers (cleared), section breaks, a table of contents, chips, images, suggestions, custom list
// nesting levels, cell spans, widths and styles, pinned header rows, spec.documentStyle. Where Docs' layout differs from
// fake-docs' (an empty paragraph before a table at the start, between two tables and after a table at the end) the
// difference is listed too.
function clearAndInsert(spec, tab, body, tabId) {
  const unsupported = [];
  const requests = [];
  const content = (body.body && body.body.content) || [];
  const end = content.length ? content[content.length - 1].endIndex : 2;
  if (end - 1 > 1) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1, tabId } } });
  const last = content[content.length - 1];
  if (last && last.paragraph && last.paragraph.bullet) requests.push({ deleteParagraphBullets: { range: { startIndex: 1, endIndex: 2, tabId } } });
  requests.push({ updateParagraphStyle: { range: { startIndex: 1, endIndex: 2, tabId }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: PARA_RESET_FIELDS.join(',') } });
  for (const id of Object.keys(body.headers || {})) requests.push({ deleteHeader: { headerId: id, tabId } });
  for (const id of Object.keys(body.footers || {})) requests.push({ deleteFooter: { footerId: id, tabId } });
  requests.push(...namedStyleRequests(spec, tabId));
  // The page setup an experiment may have changed, back to pages, portrait, Docs' header and footer margins (a margin
  // cannot be unset: Google answers "A value for header margin must be specified").
  requests.push({ updateDocumentStyle: { documentStyle: { documentFormat: { documentMode: 'PAGES' }, flipPageOrientation: false, marginHeader: dim(36), marginFooter: dim(36) },
    fields: 'documentFormat,flipPageOrientation,marginHeader,marginFooter', tabId } });
  for (const k of ['headers', 'footers', 'footnotes']) if (Object.keys(tab[k] || {}).length) unsupported.push(`${k} are not built`);
  if (tab.documentStyle && Object.keys(tab.documentStyle).length) unsupported.push('documentStyle is not built');
  for (const [id, v] of Object.entries(tab.lists || {})) if (v && typeof v === 'object' && v.nestingLevels) unsupported.push(`list ${id}: custom nesting levels are not built (the preset's)`);
  // From the last block to the first, everything goes in at index 1, so no index depends on a table's length (Docs gives a
  // table one index at its end besides its cells). A run of paragraphs goes into the empty paragraph at 1 (its last line takes
  // that paragraph's newline); insertTable at 1 splits the paragraph there: an empty paragraph stays at 1, the table
  // follows at 2 (its cells filled from the last), and the text that was at 1 comes after the table.
  const blocks = [];
  for (const it of tab.items || []) {
    if (it.toc || it.section) { unsupported.push(it.toc ? 'a table of contents is not built' : 'a section break is not built'); continue; }
    const last = blocks[blocks.length - 1];
    if (it.table) blocks.push({ table: it });
    else if (last && last.run) last.run.push(it);
    else blocks.push({ run: [it] });
  }
  const lineText = (p) => '\t'.repeat(p.bullet ? p.bullet.level || 0 : 0) + builtText(p);
  blocks.forEach((b, i) => {
    if (!b.table) return;
    if (i === 0) unsupported.push('a table at the start: Docs puts an empty paragraph before it');
    else if (blocks[i - 1].table) unsupported.push('a table right after a table: Docs puts an empty paragraph between them');
    if (i === blocks.length - 1) unsupported.push('a table at the end: Docs keeps an empty paragraph after it');
  });
  for (const b of blocks.slice().reverse()) {
    if (b.run) {
      const text = b.run.map(lineText).join('\n');
      if (text) requests.push({ insertText: { location: { index: 1, tabId }, text } });
      continue;
    }
    const it = b.table;
    const rows = it.table.length;
    const cols = it.table.reduce((m, r) => Math.max(m, r.length), 0);
    if (it.spans || it.widths || it.cellStyles || it.pinned) unsupported.push('table spans, widths, cell styles and pinned rows are not built');
    requests.push({ insertTable: { rows, columns: cols, location: { index: 1, tabId } } });
    // The table at 2: its start, the row's start, the cell's start, then the cell's paragraph.
    const cellIndex = (r, c) => 2 + 3 + r * (1 + 2 * cols) + 2 * c;
    const fills = [];
    it.table.forEach((row, r) => row.forEach((cell, c) => { const text = cell.map(lineText).join('\n'); if (text) fills.push({ index: cellIndex(r, c), text }); }));
    for (const f of fills.reverse()) requests.push({ insertText: { location: { index: f.index, tabId }, text: f.text } });
  }
  return { requests, unsupported };
}
// Batch B of a reset: text styles, paragraph styles and lists on the inserted text. real: bodyParagraphs of the tab after
// batch A. Returns { requests, unsupported }.
function styleRequests(spec, tab, real, tabId) {
  const unsupported = [];
  const want = specParagraphs(tab, unsupported);
  // Pair the spec's paragraphs with the real ones in order; an empty real paragraph the spec does not have (around a
  // table) is skipped.
  const pairs = [];
  let k = 0;
  for (const w of want) {
    const t = '\t'.repeat(w.tabs) + w.text;
    while (k < real.length && real[k].text !== t && real[k].text === '') k++;
    if (k >= real.length || real[k].text !== t) throw new Error(`build: paragraph "${t.slice(0, 40)}" not found after the insert (got "${(real[k] || {}).text}")`);
    pairs.push({ w, r: real[k++] });
  }
  const requests = [];
  const range = (s, e) => ({ startIndex: s, endIndex: e, tabId });
  // Paragraph styles first: the named style and the explicit fields (a list item's indents wait until its bullet exists).
  // A namedStyleType change clears the run's own text styles in Docs, so the text styles come after it.
  for (const { w, r } of pairs) {
    const ps = normPstyle(w.item.pstyle || {});
    if (w.item.bullet) { delete ps.indentStart; delete ps.indentFirstLine; }
    const fields = ['namedStyleType', ...Object.keys(ps)];
    requests.push({ updateParagraphStyle: { range: range(r.start, r.end), paragraphStyle: { namedStyleType: w.item.style || 'NORMAL_TEXT', ...ps }, fields: fields.join(',') } });
  }
  for (const { r } of pairs) requests.push({ updateTextStyle: { range: range(r.start, r.end), textStyle: {}, fields: TEXT_RESET_FIELDS } });
  for (const { w, r } of pairs) {
    for (const [s, e, st] of w.item.fmt || []) {
      if (e <= s) continue;
      const rq = textStyleRequest(st, range(r.start + w.tabs + s, r.start + w.tabs + e));
      if (rq) requests.push(rq);
    }
  }
  // Lists, from the bottom up so that the tabs createParagraphBullets removes never move a range still to come.
  const groups = new Map();
  pairs.forEach((p, n) => { if (p.w.item.bullet) { const id = p.w.item.bullet.listId; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(n); } });
  const spans = [...groups.entries()].map(([id, ns]) => ({ id, ns, from: ns[0], to: ns[ns.length - 1] }));
  for (const a of spans) for (const b of spans) if (a !== b && a.from < b.from && b.from <= a.to) unsupported.push(`lists ${a.id} and ${b.id} interleave: not built faithfully`);
  const presets = Object.fromEntries(Object.entries(tab.lists || {}).map(([id, v]) => [id, typeof v === 'string' ? v : (v && v.preset) || null]));
  spans.sort((a, b) => b.from - a.from);
  for (const g of spans) {
    const first = pairs[g.from].w.item.bullet;
    const preset = first.preset || presets[g.id] || 'BULLET_DISC_CIRCLE_SQUARE';
    if (!PRESET_GLYPHS[preset] && !/^(BULLET|NUMBERED)_/.test(preset)) unsupported.push(`list ${g.id}: unknown preset ${preset}`);
    requests.push({ createParagraphBullets: { range: range(pairs[g.from].r.start, pairs[g.to].r.end), bulletPreset: preset } });
    // After the bullets: the indices inside the span lose the leading tabs of the items above them.
    let removed = 0;
    for (let n = g.from; n <= g.to; n++) {
      const { w, r } = pairs[n];
      const isItem = g.ns.includes(n);
      const s = r.start - removed;
      const e = r.end - removed - (isItem ? w.tabs : 0);
      const ps = normPstyle(w.item.pstyle || {});
      if (!isItem) requests.push({ deleteParagraphBullets: { range: range(s, e) } });
      // The spec's own indents, or none: the indent fields listed without a value (what the panel's indent "style" sends).
      const own = {};
      for (const f of ['indentStart', 'indentFirstLine']) if (ps[f]) own[f] = ps[f];
      requests.push({ updateParagraphStyle: { range: range(s, e), paragraphStyle: own, fields: 'indentStart,indentFirstLine' } });
      if (isItem) removed += w.tabs;
    }
  }
  return { requests, unsupported };
}

// Brings Docs tab tabId of docId to spec's tab (spec.tabs[tabIndex], default 0) and spec.namedStyles: two batchUpdates and
// two reads, then a read-back compared with fake-docs' rendering of the same spec. Returns { unsupported, diffs (what the
// real tab differs in: text, named style, list level and grouping, own indents, text styles), batches: [{ requests,
// status, error }] }.
async function resetDocument(client, { docId, tabId, spec, tabIndex = 0 }) {
  const tab = spec.tabs[tabIndex];
  const batches = [];
  const read = async () => {
    const r = await client.get(docId, 'includeTabsContent=true');
    if (!r.ok) throw new Error(`documents.get ${r.status}: ${r.text.slice(0, 200)}`);
    const t = tabOfBody(r.json, tabId);
    if (!t) throw new Error(`no tab ${tabId} in ${docId}`);
    return { doc: r.json, dt: t.documentTab };
  };
  const send = async (requests) => {
    const r = await client.batchUpdate(docId, { requests });
    batches.push({ requests, status: r.status, error: r.ok ? null : (r.json && r.json.error && r.json.error.message) || r.text.slice(0, 300) });
    if (!r.ok) throw new Error(`reset batch refused (HTTP ${r.status}): ${batches[batches.length - 1].error}`);
    return r.json;
  };
  const before = await read();
  const a = clearAndInsert(spec, tab, before.dt, tabId);
  await send(a.requests);
  const mid = await read();
  const b = styleRequests(spec, tab, bodyParagraphs(mid.dt.body.content), tabId);
  if (b.requests.length) await send(b.requests);
  const after = await read();
  const diffs = compareWithSpec(spec, tabIndex, oneTabBody(after.doc, tabId), tabId);
  return { unsupported: [...new Set([...a.unsupported, ...b.unsupported])], diffs, batches, body: oneTabBody(after.doc, tabId) };
}

// What the real tab (a one-tab body) differs in from fake-docs' rendering of spec's tab: per paragraph its text, named
// style, list level, own indents and text styles, and lists that are one in the spec but not in the document (or the
// reverse). Strings, empty when they agree.
function compareWithSpec(spec, tabIndex, body, tabId) {
  const fakeSpec = { ...spec, tabs: [spec.tabs[tabIndex]] };
  const want = fakeDocsServer(fakeSpec);
  const got = mirrorServer(body, tabId);
  const wt = spec.tabs[tabIndex].id;
  const diffs = [];
  const wText = want.text(wt).split('\n');
  const gText = got.text(tabId).split('\n');
  if (wText.length !== gText.length) diffs.push(`paragraphs: spec ${wText.length}, document ${gText.length}`);
  const n = Math.min(wText.length, gText.length);
  const ws = want.styles(wt);
  const gs = got.styles(tabId);
  const wb = want.bullets(wt);
  const gb = got.bullets(tabId);
  const pick = (o) => Object.fromEntries(['indentStart', 'indentFirstLine'].filter((k) => k in o).map((k) => [k, +(+o[k]).toFixed(2)]));
  const wp = want.pstyles(wt).map(pick);
  const gp = got.pstyles(tabId).map(pick);
  // Docs stores the font the text shows with a bold write (real-docs.js fact 7b): on both sides a bold stretch's font equal
  // to its paragraph's inherited font counts as none (adjacent equal stretches merged).
  const named = want.named(wt);
  const inhFont = (style) => (named[style || 'NORMAL_TEXT'] || {}).font || (named.NORMAL_TEXT || {}).font;
  const boldPlain = (fmt, style) => fmt.reduce((out, [s, e, st]) => {
    const { font, ...rest } = st;
    const v = st.bold && !st.weight && font === inhFont(style) ? rest : st;
    const last = out[out.length - 1];
    if (last && last[1] === s && JSON.stringify(last[2]) === JSON.stringify(v)) last[1] = e; else out.push([s, e, v]);
    return out;
  }, []);
  const wf = want.fmt(wt).map((f, i) => boldPlain(f, ws[i]));
  const gf = got.fmt(tabId).map((f, i) => boldPlain(f, gs[i]));
  const listPairs = new Map();
  for (let i = 0; i < n; i++) {
    const L = `paragraph ${i + 1}`;
    if (wText[i] !== gText[i]) diffs.push(`${L}: text ${JSON.stringify(gText[i])}, spec ${JSON.stringify(wText[i])}`);
    if (ws[i] !== gs[i]) diffs.push(`${L}: style ${gs[i]}, spec ${ws[i]}`);
    const wl = wb[i] ? wb[i].level : null;
    const gl = gb[i] ? gb[i].level : null;
    if (wl !== gl) diffs.push(`${L}: list level ${gl}, spec ${wl}`);
    if (wb[i] && gb[i]) {
      const prev = listPairs.get(wb[i].listId);
      if (prev && prev !== gb[i].listId) diffs.push(`${L}: in another list than the earlier items of spec list ${wb[i].listId}`);
      listPairs.set(wb[i].listId, gb[i].listId);
    }
    if (JSON.stringify(wp[i]) !== JSON.stringify(gp[i])) diffs.push(`${L}: own indents ${JSON.stringify(gp[i])}, spec ${JSON.stringify(wp[i])}`);
    if (JSON.stringify(wf[i]) !== JSON.stringify(gf[i])) diffs.push(`${L}: text styles ${JSON.stringify(gf[i])}, spec ${JSON.stringify(wf[i])}`);
  }
  const reals = [...listPairs.values()];
  if (new Set(reals).size !== reals.length) diffs.push('two lists of the spec are one list in the document');
  return diffs;
}

module.exports = { serviceAccountAuth, docsClient, scratchTab, pinRequests, oneTabBody, tabOfBody, realDocsServer, mirrorServer, bodyParagraphs,
  clearAndInsert, styleRequests, resetDocument, compareWithSpec, namedStyleRequests, DOCS_URL, DOCS_SCOPE };
