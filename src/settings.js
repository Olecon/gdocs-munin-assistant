'use strict';
// Module settings.js: the accounts (defaultSettings, loadSettings with the one-time migration of the per-type settings,
// chatChoice / chatAccount / activeProvider / activeConfig: the open chat's account and model, setChatModel, the health
// marks: markAccountHealth), the model lists (fetchModelList, checkModels), the settings form with one row per account
// that applies every change at once (addAccount, removeAccount, closeSettings on a click outside), the mode button and
// its menu (applyApplyMode, setApplyMode, cycleApplyMode, the mode menu: openModeMenu, closeModeMenu, bindModeMenu;
// isAutoMode, isPlanMode, applyTurnMode) and the theme (applyTheme, loadTheme, toggleTheme). state.settings.references
// caches the References grant (references.js), loaded here.
/* global addError, allStorageKeys, DOC_INSTRUCTIONS_MAX, LEGACY_USER_INSTRUCTIONS_KEY, MAIN_INSTRUCTIONS_KEY, PAPER_CARD_PREFIX, ANTHROPIC_VERSION, apiError, APPLY_MODE_DESCS, APPLY_MODE_KEY, APPLY_MODE_ORDER, APPLY_MODES, closeFiles,
   ACCOUNT_NAME_MAX, ACCOUNTS_KEY, anthropicAdaptive, openaiReasoningModel, DEFAULT_PROVIDER, el, GOOGLE_ACCOUNT_KEY, GOOGLE_CONNECTED_KEY, KEY_CHECK_DEBOUNCE_MS, LAST_MODEL_KEY, LEGACY_SETTING_FIELDS, modelsKey,
   OMITTABLE_FIELDS, PROVIDER_IDS, PROVIDER_STORAGE_KEY, PROVIDERS, REFERENCES_KEY, REFERENCES_ORIGINS, refreshModelMenu, renderChatModel, renderEmpty, renderGoogleStatus, sanitizeGoogleAccount, chooseModel,
   MODE_BUTTON_TITLE, MODELS_FETCH_TIMEOUT_MS, chatProbeOn, probeChat, renderContextGauge, setChatModelMeta, STALE_SETTING_KEYS, state, storageKey, SYSTEM_THEME_QUERY, THEME_KEY */
/* exported defaultSettings, activeProvider, activeConfig, accountById, accountConfig, accountModel, accounts, chatAccount, chatChoice,
   loadSettings, onApiKeyInput, onApiKeyBlur, onNameChange, onUrlChange, addAccount, removeAccount, setChatModel, markAccountHealth,
   healthState, healthTime, healthTitle, healthError, isOutage, sanitizeAccounts, typeName, fetchModelList, canRequest, providerFor, toggleAccountRow,
   addDraftRow, discardDraftRow, changeAccountType, onHeadersChange, sanitizeHeaders, noteOmittedField,
   serverAccess, serverHost, sanitizeParams, accountParams, setAccountParams, defaultReplyTokens, temperatureRefused, cappedReply,
   TEMPERATURE_MAX, cleanTemperature, modelPrefixOf, fullModelId, shortModelId, syncRowModels,
   checkModels, openSettings, closeSettings, saveSettings, bindSettingsForm, loadApplyMode, setApplyMode, cycleApplyMode, bindModeMenu, closeModeMenu, isAutoMode, isPlanMode, applyTurnMode, sentApplyMode, systemTheme,
   applyTheme, loadTheme, toggleTheme */

// ---------------------------------------------------------------------------
// Settings: accounts (ACCOUNTS_KEY). An account is { id, type (a PROVIDERS key), name (unique, editable), apiKey,
// baseUrl? (Munin: its own server; custom: the server, required), model? (the model last chosen on it), health?
// ({ down, error, at }: the last request could not reach it; { ok, models, at }: the last check or request got through
// and N models are listed; none: unknown), modelPrefix? (custom: the prefix its model ids share, stored once; the
// model ids everywhere else are short: modelPrefixOf, fullModelId), limits? (custom: { <model>: { context?, reply? } } as its
// model list named them), params? ({ maxTokens?, temperature? }: the user's settings for every model of the account,
// Advanced in the row), headers? (custom: extra request headers { Name: value }), omit? (custom: the body fields
// its server refused, OMITTABLE_FIELDS) }. Several accounts of one type are allowed. A chat runs on the account and model of
// its meta's model field (chatChoice); the endpoint is the type's (PROVIDERS[*].baseUrl) unless the account has one.
// ---------------------------------------------------------------------------
function defaultSettings() {
  return { accounts: [], lastModel: null, references: false };
}

const accounts = () => state.settings.accounts || [];
const accountById = (id) => accounts().find((a) => a.id === id) || null;
const newAccountId = () => 'a' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
// The model an account runs when a chat names no model for it: the last one chosen on it, else the type's default.
const accountModel = (a) => (a && (a.model || PROVIDERS[a.type].model)) || '';
const typeName = (type) => (PROVIDERS[type] ? PROVIDERS[type].name : type);
// An account (or a request config) can be asked: it has a key, or it is of a type a local server may run without one
// (custom) and has its server URL; such a config carries keyless (accountConfig) and sends no Authorization header.
const canRequest = (x) => !!x && (!!x.apiKey || !!x.keyless || (!!PROVIDERS[x.type] && !!PROVIDERS[x.type].keyOptional && !!x.baseUrl));

// A custom server's model ids often share a long prefix (Yandex AI Studio: "gpt://<folder>/"): it is stored once on the
// account (modelPrefix) and the ids are kept, shown and chosen without it; only the request body gets the full id
// (transport.js sentBody). The rule: the longest prefix of all ids that ends at "/"; when there is none, the
// same for the ids of the most common "scheme://" (the others keep their full ids). A list of fewer than two ids, a
// prefix that would leave an id empty, and a short id that contains "://" mean no prefix. fullModelId: an id with
// "://" is already full, any other gets the prefix.
const MODEL_PREFIX_MAX = 200;
function commonModelPrefix(ids) {
  if (ids.length < 2) return '';
  let p = ids[0];
  for (const id of ids) while (p && !id.startsWith(p)) p = p.slice(0, -1);
  return p.slice(0, p.lastIndexOf('/') + 1); // only '/': Ollama's qwen3:8b and qwen3:14b must stay whole
}
function modelPrefixOf(ids) {
  const fits = (p, group) => !!p && p.length <= MODEL_PREFIX_MAX && group.every((id) => id.length > p.length && !id.slice(p.length).includes('://'));
  const all = commonModelPrefix(ids);
  if (all) return fits(all, ids) ? all : '';
  const scheme = (id) => (/^[a-z][a-z0-9+.-]*:\/\//i.exec(id) || [''])[0];
  const counts = new Map();
  for (const id of ids) if (scheme(id)) counts.set(scheme(id), (counts.get(scheme(id)) || 0) + 1);
  let best = '';
  for (const [k, n] of counts) if (!best || n > counts.get(best)) best = k;
  const group = ids.filter((id) => scheme(id) === best);
  if (!best || group.length === ids.length) return '';
  const p = commonModelPrefix(group);
  return fits(p, group) ? p : '';
}
const fullModelId = (a, m) => (!a || !a.modelPrefix || !m || m.includes('://') ? m : a.modelPrefix + m);
const shortModelId = (a, id) => {
  const p = a && a.modelPrefix;
  return p && typeof id === 'string' && id.startsWith(p) && id.length > p.length ? id.slice(p.length) : id;
};

// A name: one line, no "/" (agents name a model as "<account name>/<model>"), at most ACCOUNT_NAME_MAX characters.
const cleanAccountName = (v) => String(v == null ? '' : v).replace(/[/\s]+/g, ' ').trim().slice(0, ACCOUNT_NAME_MAX).trim();
// wanted (or the type's name) unless another account has it (case-insensitive); then "<name> 2", "<name> 3" ….
function uniqueAccountName(wanted, type, exceptId = null, list = accounts()) {
  const base = cleanAccountName(wanted) || typeName(type);
  const taken = new Set(list.filter((a) => a.id !== exceptId).map((a) => a.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}
// A server URL: http(s), no trailing slash; '' for the type's own URL or a value that is not a URL. A custom server's
// URL is taken with or without its /v1 (or a pasted /chat/completions or /models endpoint) and kept with the version
// part, since the requests add only /chat/completions and /models.
function cleanBaseUrl(v, type) {
  let url = String(v || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(url)) return '';
  if (PROVIDERS[type].needsUrl) {
    url = url.replace(/\/(chat\/completions|models)$/i, '');
    if (!/\/v\d+[a-z0-9]*$/i.test(url)) url += '/v1';
  }
  return url === PROVIDERS[type].baseUrl ? '' : url;
}
// A custom account's limits per model (positive whole numbers; at most MODEL_LIMITS_MAX models).
const MODEL_LIMITS_MAX = 200;
const positiveInt = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
function sanitizeLimits(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [m, l] of Object.entries(v).slice(0, MODEL_LIMITS_MAX)) {
    const context = positiveInt(l && l.context);
    const reply = positiveInt(l && l.reply);
    if (m && (context || reply)) out[m] = { ...(context ? { context } : {}), ...(reply ? { reply } : {}) };
  }
  return Object.keys(out).length ? out : null;
}
// The limits keyed by short ids (stored ones from before the prefix may have full keys).
function shortLimits(a, v) {
  if (!a.modelPrefix || !v || typeof v !== 'object' || Array.isArray(v)) return v;
  const out = {};
  for (const [m, l] of Object.entries(v)) out[shortModelId(a, m)] = l;
  return out;
}
// { down, chat?, error, at } (not reachable; chat false: the chat probe was refused) or { ok, models, chat?, at } (the
// last check or request got through and the model list is known; chat true: a chat request answered); anything else
// is unknown (no field).
function sanitizeHealth(h) {
  if (!h || typeof h !== 'object') return null;
  if (h.down === true) return { down: true, ...(h.chat === false ? { chat: false } : {}), error: String(h.error || '').slice(0, 200), at: Number(h.at) || 0 };
  if (h.ok === true) return { ok: true, models: positiveInt(h.models), ...(h.chat === true ? { chat: true } : {}), at: Number(h.at) || 0 };
  return null;
}

// Extra request headers of a custom account (Yandex AI Studio needs OpenAI-Project: <folder ID>): at most HEADERS_MAX,
// token names, values trimmed and capped, Latin-1 without line breaks (fetch throws on anything else); none that the
// extension sets itself (the key, Content-Type) or the browser controls. null when nothing is left.
const HEADERS_MAX = 8;
const HEADER_VALUE_MAX = 500;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/;
const BLOCKED_HEADERS = new Set(['authorization', 'content-type', 'content-length', 'host', 'cookie', 'cookie2', 'set-cookie',
  'origin', 'referer', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'via', 'expect', 'date',
  'dnt', 'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method', 'x-api-key',
  '__proto__']);
const headerBlocked = (low) => BLOCKED_HEADERS.has(low) || /^(proxy-|sec-)/.test(low);
const headerValue = (v) => String(v == null ? '' : v).trim().slice(0, HEADER_VALUE_MAX).trim();
// Why one header cannot be sent (the tooltip of its row in the form), '' when it can; name and value already trimmed.
function headerProblem(name, value, seen) {
  const low = name.toLowerCase();
  if (!name) return 'Add the header name';
  if (!HEADER_NAME_RE.test(name)) return 'Use letters, digits and dashes in the name';
  if (headerBlocked(low)) return 'This header cannot be set here';
  if (seen && seen.has(low)) return 'This header is already set above';
  if (!value) return 'Add a value';
  if (!HEADER_VALUE_RE.test(value)) return 'The value has characters a header cannot carry';
  return '';
}
function sanitizeHeaders(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  const seen = new Set();
  for (const [rawName, rawValue] of Object.entries(v)) {
    const name = String(rawName).trim();
    const value = headerValue(rawValue);
    if (headerProblem(name, value, seen)) continue;
    seen.add(name.toLowerCase());
    out[name] = value;
    if (seen.size >= HEADERS_MAX) break;
  }
  return seen.size ? out : null;
}
const sanitizeOmit = (v) => (Array.isArray(v) ? OMITTABLE_FIELDS.filter((f) => v.includes(f)) : []);
// The user's settings for every model of the account (Advanced in the row, the models tool's settings action):
// { maxTokens?, temperature? }; maxTokens a positive whole number, temperature 0 to 2 (two decimals). null when nothing
// is left, so the earlier per-model shape ({ <model>: {...} }) is dropped silently.
const TEMPERATURE_MAX = 2;
const cleanTemperature = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= TEMPERATURE_MAX ? Math.round(v * 100) / 100 : null);
function sanitizeParams(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const maxTokens = positiveInt(v.maxTokens);
  const temperature = cleanTemperature(v.temperature);
  if (!maxTokens && temperature == null) return null;
  return { ...(maxTokens ? { maxTokens } : {}), ...(temperature != null ? { temperature } : {}) };
}

// One stored account made safe (null when its type is unknown).
function sanitizeAccount(raw) {
  if (!raw || typeof raw !== 'object' || !PROVIDERS[raw.type]) return null;
  const a = {
    id: typeof raw.id === 'string' && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : newAccountId(),
    type: raw.type, name: cleanAccountName(raw.name) || typeName(raw.type), apiKey: String(raw.apiKey || '').trim(),
  };
  const url = PROVIDERS[raw.type].ownUrl ? cleanBaseUrl(raw.baseUrl, raw.type) : '';
  if (url) a.baseUrl = url;
  const prefix = PROVIDERS[raw.type].needsUrl && typeof raw.modelPrefix === 'string' ? raw.modelPrefix.trim() : '';
  if (prefix && prefix.length <= MODEL_PREFIX_MAX) a.modelPrefix = prefix;
  const limits = PROVIDERS[raw.type].needsUrl ? sanitizeLimits(shortLimits(a, raw.limits)) : null;
  if (limits) a.limits = limits;
  const headers = PROVIDERS[raw.type].needsUrl ? sanitizeHeaders(raw.headers) : null;
  if (headers) a.headers = headers;
  const omit = PROVIDERS[raw.type].needsUrl ? sanitizeOmit(raw.omit) : [];
  if (omit.length) a.omit = omit;
  const model = shortModelId(a, String(raw.model || '').trim());
  if (model) a.model = model;
  const params = sanitizeParams(raw.params);
  if (params) a.params = params;
  const health = sanitizeHealth(raw.health);
  if (health) a.health = health;
  return a;
}
// The stored list: valid accounts, ids and names unique.
function sanitizeAccounts(v) {
  const out = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const a = sanitizeAccount(raw);
    if (!a || out.some((x) => x.id === a.id)) continue;
    a.name = uniqueAccountName(a.name, a.type, a.id, out);
    out.push(a);
  }
  return out;
}
// A chat's (or the last) model choice { accountId, model }, or null.
function sanitizeChoice(v) {
  if (!v || typeof v !== 'object' || typeof v.accountId !== 'string' || !v.accountId) return null;
  return { accountId: v.accountId, model: typeof v.model === 'string' ? v.model.trim() : '' };
}

// The model choice of the open chat: its meta's model (kept when its account was removed: the chat then asks for a
// model), else the last choice made anywhere while its account exists, else the first account with a key (or the
// first account) on its model. null without accounts.
// A stored model may be a full id from before the account had a prefix: it is read short.
function chatChoice() {
  const meta = (state.chats || []).find((c) => c.id === state.chatId);
  const own = meta && sanitizeChoice(meta.model);
  if (own) return { ...own, model: shortModelId(accountById(own.accountId), own.model) };
  const last = sanitizeChoice(state.settings.lastModel);
  if (last && accountById(last.accountId)) return { ...last, model: shortModelId(accountById(last.accountId), last.model) };
  const a = accounts().find(canRequest) || accounts()[0];
  return a ? { accountId: a.id, model: accountModel(a) } : null;
}
// The open chat's account, or null (no accounts, or the chat's account was removed).
function chatAccount() {
  const c = chatChoice();
  return c ? accountById(c.accountId) : null;
}
// What a request of the account needs: { apiKey, model, accountId, name, baseUrl?, keyless?, headers?, omit?,
// modelPrefix? }. model is the short id (what the chat, the menu and the tools name); the body gets the full one.
function accountConfig(a, model) {
  const cfg = { apiKey: a.apiKey, model: shortModelId(a, model || accountModel(a)), accountId: a.id, name: a.name };
  if (a.modelPrefix) cfg.modelPrefix = a.modelPrefix;
  if (a.baseUrl) cfg.baseUrl = a.baseUrl;
  if (a.headers) cfg.headers = { ...a.headers };
  if (a.omit && a.omit.length) cfg.omit = a.omit.slice();
  if (!a.apiKey && canRequest(a)) cfg.keyless = true;
  return cfg;
}
// The type's entry for a request of the account on a model: a custom server's context window and reply cap come from
// its model list when the server named them (a.limits; the reply at most a quarter of the window), else the type's.
// The user's settings for the account (a.params, every model) come last: their reply length (at least MIN_REPLY_TOKENS,
// at most half the model's window) and their temperature in every sampling profile (samplingFields), unless the model
// refuses one.
const MIN_REPLY_TOKENS = 256;
function providerFor(a, model) {
  const p = PROVIDERS[a.type];
  const m = shortModelId(a, model || accountModel(a));
  const lim = a.limits && a.limits[m];
  const base = lim ? { ...p, contextTokens: lim.context || p.contextTokens } : p;
  if (lim) base.maxTokens = Math.max(MIN_REPLY_TOKENS, Math.min(lim.reply || p.maxTokens, Math.floor(base.contextTokens / 4)));
  const own = accountParams(a);
  if (!own.maxTokens && (own.temperature == null || temperatureRefused(a.type, m))) return base;
  const out = base === p ? { ...p } : base;
  if (own.maxTokens) out.maxTokens = cappedReply(own.maxTokens, out.contextTokens);
  if (own.temperature != null && !temperatureRefused(a.type, m)) {
    for (const k of ['sampling', 'toolSampling', 'summarySampling']) out[k] = { ...(p[k] || {}), temperature: own.temperature };
  }
  return out;
}
const cappedReply = (n, contextTokens) => Math.max(MIN_REPLY_TOKENS, Math.min(n, Math.floor(contextTokens / 2)));
// The user's settings for the account's models ({} when none).
const accountParams = (a) => (a && a.params) || {};
// The reply length a model gets without the user's setting (the type's, or a custom server's own cap).
const defaultReplyTokens = (a, model) => providerFor({ ...a, params: null }, model).maxTokens;
// Models that refuse a temperature: OpenAI's reasoning models, and Claude models with adaptive thinking (4.6 and later;
// Anthropic requires 1 with thinking and refuses the field on 4.7 and later). It is then not sent.
function temperatureRefused(type, model) {
  if (type === 'openai') return openaiReasoningModel(model);
  if (type === 'anthropic') return anthropicAdaptive(model);
  return false;
}
// Stores the user's settings for the account: patch { maxTokens?, temperature? }, a field null to clear it (undefined:
// unchanged). Sanitized like the stored ones; the row's Advanced fields follow. Returns the account's settings.
async function setAccountParams(accountId, patch) {
  const a = accountById(accountId);
  if (!a) return null;
  const next = { ...accountParams(a) };
  for (const k of ['maxTokens', 'temperature']) {
    if (patch[k] === null) delete next[k];
    else if (patch[k] !== undefined) next[k] = patch[k];
  }
  const params = sanitizeParams(next);
  if (params) a.params = params; else delete a.params;
  await persistAccounts();
  fillAdvanced(accountId);
  renderContextGauge();
  return accountParams(a);
}
// The open chat's provider type (PROVIDERS entry, with a custom server's own limits; the default type while the chat
// has no account) and its config (empty, accountId null, without an account).
const activeProvider = () => {
  const c = chatChoice();
  const a = c && accountById(c.accountId);
  return a ? providerFor(a, c.model) : PROVIDERS[DEFAULT_PROVIDER];
};
function activeConfig() {
  const c = chatChoice();
  const a = c && accountById(c.accountId);
  return a ? accountConfig(a, c.model) : { apiKey: '', model: '', accountId: null, name: '' };
}

// The open chat runs on accountId / model from the next message on; it becomes the last choice and the account's
// model. Stored on the chat's meta (chats.js setChatModelMeta; a new chat inherits it). Returns false for an unknown account.
// at: the chat ({docId, chatId}; default the open one): the models tool names the chat of its turn.
async function setChatModel(accountId, model, at = { docId: state.docId, chatId: state.chatId }) {
  const a = accountById(accountId);
  if (!a) return false;
  const choice = { accountId, model: shortModelId(a, String(model || '').trim()) || accountModel(a) };
  state.settings.lastModel = choice;
  a.model = choice.model;
  const tagged = { ...choice, at: Date.now() };
  const meta = at.docId === state.docId ? (state.chats || []).find((c) => c.id === at.chatId) : null;
  if (meta) meta.model = tagged;
  renderContextGauge();
  try { await chrome.storage.local.set({ [LAST_MODEL_KEY]: choice }); } catch (e) { /* ignore */ }
  await persistAccounts();
  if (at.docId && at.chatId) await setChatModelMeta(at.docId, at.chatId, tagged);
  return true;
}

// A custom server refused a body field (transport.js postJson): its later requests leave it out (stored).
async function noteOmittedField(accountId, field) {
  const a = accountById(accountId);
  if (!a || !PROVIDERS[a.type].needsUrl || !OMITTABLE_FIELDS.includes(field) || (a.omit || []).includes(field)) return;
  a.omit = sanitizeOmit([...(a.omit || []), field]);
  await persistAccounts();
}

// An account's own server (Munin's other server, a custom one) is outside the manifest's host permissions: without the
// optional permission for its origin the panel's requests are subject to CORS, and a server that sends no CORS headers
// fails with "Failed to fetch". serverOrigin: the permission pattern ("https://host/*"), '' when not a URL.
function serverOrigin(baseUrl) {
  try { return new URL(baseUrl).origin + '/*'; } catch (e) { return ''; }
}
const serverHost = (baseUrl) => { try { return new URL(baseUrl).host; } catch (e) { return String(baseUrl || ''); } };
// Whether Chrome grants the server's origin (true when it cannot tell: the failure is then reported as it is).
async function serverAccess(baseUrl) {
  const origin = serverOrigin(baseUrl);
  if (!origin || !chrome.permissions) return true;
  try { return !!(await chrome.permissions.contains({ origins: [origin] })); } catch (e) { return true; }
}

// The accounts as stored (plain copies; the in-memory list is the truth for this panel). The lists this panel wrote
// last (JSON), so that watchAccounts tells its own writes from another tab's even when two writes follow closely.
const storedAccounts = () => accounts().map((a) => JSON.parse(JSON.stringify(a)));
const ACCOUNT_WRITES_KEPT = 8;
let accountsWritten = [];
function noteAccountsWritten(json) {
  accountsWritten.push(json);
  if (accountsWritten.length > ACCOUNT_WRITES_KEPT) accountsWritten.shift();
}
// Change events arrive in write order: a match also retires the older entries.
function ownAccountsWrite(json) {
  const i = accountsWritten.indexOf(json);
  if (i < 0) return false;
  accountsWritten.splice(0, i + 1);
  return true;
}
async function persistAccounts() {
  const list = storedAccounts();
  noteAccountsWritten(JSON.stringify(list));
  try { await chrome.storage.local.set({ [ACCOUNTS_KEY]: list }); } catch (e) { /* ignore */ }
}

// Health, three states (a.health): down (red: the last request got no answer at all, a timeout or HTTP 5xx), ok (green:
// the last model-list check or request got through and the model list is known) and unknown (grey: no field; never
// checked, a rejected key, or a model list that did not come). outcome: the failure (an Error), the size of a model
// list that arrived (a number) or null (a request got through: ok while a list is cached; another answer below 500,
// such as a 400 or 429, counts the same). Kept in memory and in storage; only a change is stored.
// The chat: a server may list its models for an account it no longer serves, so an explicit check also sends a chat
// probe (probe.js; probe true here, outcome its Error or null). A probe or a real chat request that got through marks
// ok with chat: true; a refused probe marks down with chat: false ("chat refused: …"; a 401 removes the mark as
// for a rejected key, a 403 counts as refused since the list accepted the key). Only a probe or a chat request clears that mark: a model list that arrives does not.
function markAccountHealth(accountId, outcome, probe = false) {
  const a = accountById(accountId);
  if (!a) return;
  const before = JSON.stringify(a.health || null);
  const failed = outcome && typeof outcome === 'object';
  // A probe's 403 is a refusal of the chat, not of the key (the list just accepted it): only a 401 means the key.
  const rejected = failed && (outcome.status === 401 || (outcome.status === 403 && !probe));
  const refused = !!(a.health && a.health.chat === false);
  const listed = (state.modelLists && state.modelLists[accountId] || []).length || (a.health && a.health.models) || 0;
  if (probe && failed && !rejected) {
    a.health = { down: true, chat: false, error: 'chat refused: ' + healthError(outcome), at: Date.now() };
  } else if (failed && isOutage(outcome)) {
    a.health = { down: true, error: healthError(outcome), at: Date.now() };
  } else if (failed && (!outcome.status || rejected)) {
    delete a.health;
  } else if (typeof outcome === 'number' && outcome > 0) {
    if (refused) return;
    a.health = { ok: true, models: outcome, ...(a.health && a.health.chat ? { chat: true } : {}), at: Date.now() };
  } else if (outcome === null && (probe || refused || !(a.health && a.health.ok && a.health.chat))) {
    // The chat answered (the probe, or a request that got through): proven, the time of a known ok mark kept.
    if (!listed) delete a.health;
    else a.health = a.health && a.health.ok && !probe ? { ...a.health, chat: true } : { ok: true, models: listed, chat: true, at: Date.now() };
  } else if (!refused && !(a.health && a.health.ok)) {
    const cached = (state.modelLists && state.modelLists[accountId]) || [];
    if (cached.length) a.health = { ok: true, models: cached.length, at: Date.now() };
    else delete a.health;
  }
  if (JSON.stringify(a.health || null) === before) return;
  persistAccounts();
  renderAccountHealth(accountId);
}
// The short reason of a down mark: the HTTP status and the server's words, or the network failure.
function healthError(err) {
  if (err.status) return `HTTP ${err.status}${err.serverMessage ? ': ' + String(err.serverMessage).replace(/\s+/g, ' ').slice(0, 80) : ''}`;
  if (err.name === 'TimeoutError') return 'timed out';
  return String((err.cause && err.cause.message) || err.message || 'no connection').replace(/\s+/g, ' ').trim().slice(0, 120);
}
// Whether a failure counts against reachability: no answer at all, or HTTP 5xx.
const isOutage = (e) => !!e && e.name !== 'AbortError' && (e.network === true || e.name === 'TimeoutError' || Number(e.status) >= 500);
// "14:02" (today) or a short date, for the dot's tooltip and the models tool.
function healthTime(at) {
  const d = new Date(at || 0);
  if (!at || Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// 'down' | 'ok' | '' (unknown): the dot's class in the settings row, the model menu and the model button.
const healthState = (a) => (a && a.health ? (a.health.down ? 'down' : a.health.ok ? 'ok' : '') : '');
function healthTitle(a) {
  const st = healthState(a);
  if (st === 'down') return `Not reachable: ${a.health.error} (checked ${healthTime(a.health.at)})`;
  if (st === 'ok') return `Reachable: ${a.health.models} model${a.health.models === 1 ? '' : 's'}${a.health.chat ? ', chat works' : ''} (checked ${healthTime(a.health.at)})`;
  return 'Not checked yet';
}

const sanitizeModelList = (v) => (Array.isArray(v) ? v.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()) : []);

// Storage keys of removed settings (STALE_SETTING_KEYS: Confirm edits, the document mode, the Google client ID,
// the Base URLs, the Effort, the per-type keys and models) and the removed paper card's keys are deleted silently.
// keepLegacy: the migration to accounts failed this load, so its inputs (the old API keys, models, model lists and the
// chat provider) stay for the next try; the other stale keys go.
async function removeStaleSettings(keepLegacy = false) {
  const keep = keepLegacy ? new Set(legacySettingKeys()) : null;
  const stale = keep ? STALE_SETTING_KEYS.filter((k) => !keep.has(k)) : STALE_SETTING_KEYS;
  try { await chrome.storage.local.remove(stale); } catch (e) { /* ignore */ }
  // The notes for all documents of an earlier build are what the main instructions are now: moved there unless
  // main instructions exist already, then the old key goes.
  try {
    const got = await chrome.storage.local.get([LEGACY_USER_INSTRUCTIONS_KEY, MAIN_INSTRUCTIONS_KEY]);
    if (LEGACY_USER_INSTRUCTIONS_KEY in got) {
      const old = got[LEGACY_USER_INSTRUCTIONS_KEY];
      if (typeof old === 'string' && old.trim() && !(MAIN_INSTRUCTIONS_KEY in got)) {
        await chrome.storage.local.set({ [MAIN_INSTRUCTIONS_KEY]: old.slice(0, DOC_INSTRUCTIONS_MAX).trim() });
      }
      await chrome.storage.local.remove(LEGACY_USER_INSTRUCTIONS_KEY);
    }
  } catch (e) { /* ignore */ }
  // The paper card was removed: its per-document keys go too.
  try {
    const cards = (await allStorageKeys()).filter((k) => k.startsWith(PAPER_CARD_PREFIX));
    if (cards.length) await chrome.storage.local.remove(cards);
  } catch (e) { /* ignore */ }
}

// The settings of earlier versions (one API key and model per type, the chat provider) become accounts, once (no
// ACCOUNTS_KEY yet) and silently: an account per stored key, its id the type (two panels migrating at once agree), its
// model the stored one, its cached model list kept; the chat provider (or, without its key, the first type with one)
// on its model becomes the last choice, which the chats without a model of their own then run on. The old keys are
// removed afterwards with the stale ones.
const legacySettingKeys = () => [PROVIDER_STORAGE_KEY,
  ...PROVIDER_IDS.flatMap((t) => [...LEGACY_SETTING_FIELDS.map((f) => storageKey(t, f)), PROVIDERS[t].storagePrefix + 'Models'])];
async function migrateLegacySettings() {
  const got = await chrome.storage.local.get([ACCOUNTS_KEY, ...legacySettingKeys()]);
  if (ACCOUNTS_KEY in got) return;
  const list = [];
  const items = {};
  for (const type of PROVIDER_IDS) {
    const apiKey = String(got[storageKey(type, 'apiKey')] || '').trim();
    if (!apiKey) continue;
    const model = String(got[storageKey(type, 'model')] || '').trim();
    list.push({ id: type, type, name: typeName(type), apiKey, ...(model ? { model } : {}) });
    const cached = sanitizeModelList(got[PROVIDERS[type].storagePrefix + 'Models']);
    if (cached.length) items[modelsKey(type)] = cached;
  }
  if (!list.length) return; // nothing worth keeping (a fresh install stores nothing)
  const chat = list.find((a) => a.type === got[PROVIDER_STORAGE_KEY]) || list[0];
  items[ACCOUNTS_KEY] = list;
  items[LAST_MODEL_KEY] = { accountId: chat.id, model: accountModel(chat) };
  await chrome.storage.local.set(items);
}

async function loadSettings() {
  const s = defaultSettings();
  const lists = {};
  let migrated = true;
  try { await migrateLegacySettings(); } catch (e) { migrated = false; } // the old keys stay until the next load
  await removeStaleSettings(!migrated);
  try {
    const got = await chrome.storage.local.get([ACCOUNTS_KEY, LAST_MODEL_KEY, GOOGLE_CONNECTED_KEY, GOOGLE_ACCOUNT_KEY, REFERENCES_KEY]);
    s.accounts = sanitizeAccounts(got[ACCOUNTS_KEY]);
    s.lastModel = sanitizeChoice(got[LAST_MODEL_KEY]);
    state.googleConnected = got[GOOGLE_CONNECTED_KEY] === true;
    state.googleAccount = sanitizeGoogleAccount(got[GOOGLE_ACCOUNT_KEY]);
    s.references = got[REFERENCES_KEY] === true && await referencesPermitted();
    if (s.accounts.length) {
      const cached = await chrome.storage.local.get(s.accounts.map((a) => modelsKey(a.id)));
      for (const a of s.accounts) lists[a.id] = sanitizeModelList(cached[modelsKey(a.id)]).map((m) => shortModelId(a, m));
    }
  } catch (e) { /* defaults */ }
  state.settings = s;
  state.modelLists = lists;
  accountsWritten = [];
  watchAccounts();
}

// Another tab changed the accounts (a key, a name, a health mark) or the last choice: this panel takes them over, so
// its next write does not undo them. The open form keeps its rows (the fields write by account id).
let accountsWatched = false;
function watchAccounts() {
  const ev = chrome.storage && chrome.storage.onChanged;
  if (accountsWatched || !ev || typeof ev.addListener !== 'function') return;
  accountsWatched = true;
  ev.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[ACCOUNTS_KEY] && !ownAccountsWrite(JSON.stringify(changes[ACCOUNTS_KEY].newValue))) {
      state.settings.accounts = sanitizeAccounts(changes[ACCOUNTS_KEY].newValue);
      if (el.settings.classList.contains('hidden')) renderAccountList();
      else for (const a of accounts()) renderAccountHealth(a.id);
      renderContextGauge();
    }
    if (changes[LAST_MODEL_KEY]) { state.settings.lastModel = sanitizeChoice(changes[LAST_MODEL_KEY].newValue); renderContextGauge(); }
  });
}

// OpenAI lists every model it serves (speech, embeddings, image, realtime, moderation, dated snapshots...).
// Keep the chat-capable GPT / o-series models and sort them newest first (GPT models before o-series).
const OPENAI_EXCLUDE_RE = /audio|realtime|transcribe|tts|search|image|instruct|embedding|moderation|whisper|dall-e|computer-use|codex|\d{4}-\d{2}-\d{2}$|-\d{4}$/i;
function openaiChatModels(ids) {
  const version = (m) => { const v = /^(?:gpt-|o)(\d+(?:\.\d+)?)/i.exec(m); return v ? parseFloat(v[1]) : 0; };
  const group = (m) => (/^gpt-/i.test(m) ? 0 : 1);
  return ids.filter((m) => /^(gpt-\d|o\d)/i.test(m) && !OPENAI_EXCLUDE_RE.test(m))
    .sort((a, b) => group(a) - group(b) || version(b) - version(a) || a.localeCompare(b));
}

// Anthropic's GET /models is paginated (has_more, last_id; 20 per page by default): pages of
// ANTHROPIC_MODELS_PAGE are followed with after_id, at most ANTHROPIC_MODELS_MAX_PAGES of them.
const ANTHROPIC_MODELS_PAGE = 100;
const ANTHROPIC_MODELS_MAX_PAGES = 5;

// One GET of a model list page. Returns the parsed JSON or throws a readable Error. With cfg.accountId a failure
// updates the account's health mark (a list that arrived does, in fetchModelList).
async function getModelsPage(url, headers, p, cfg) {
  let resp;
  try {
    resp = await fetch(url, { headers, ...(cfg.timeoutMs ? { signal: AbortSignal.timeout(cfg.timeoutMs) } : {}) });
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? `no answer in ${Math.round(cfg.timeoutMs / 1000)} s` : e.message;
    const err = Object.assign(new Error(`Could not reach ${url} (${why}). Check your connection.`), { network: true, cause: e.name === 'TimeoutError' ? new Error(why) : e });
    if (cfg.accountId) markAccountHealth(cfg.accountId, err);
    throw err;
  }
  if (!resp.ok) {
    const err = await apiError(resp, { prov: p, cfg });
    if (cfg.accountId) markAccountHealth(cfg.accountId, err);
    throw err;
  }
  try { return await resp.json(); } catch (e) {
    const err = new Error('The server did not return a valid model list.');
    if (cfg.accountId) markAccountHealth(cfg.accountId, err);
    throw err;
  }
}

// Model IDs offered by an account of the type: GET {baseUrl}/models (OpenAI-compatible list: {data: [{id}]};
// a bare array or {models: [...]} is accepted too; Anthropic: all pages). cfg: { apiKey, baseUrl?, accountId? }.
// Returns the IDs without duplicates, in server order (OpenAI: filtered and sorted by openaiChatModels; the full
// list is kept if nothing passes the filter).
// limits (custom servers): an object that receives { <id>: { context?, reply? } } where the list names them (vLLM's
// max_model_len, context_length, context_window, max_context_length; max_completion_tokens).
async function fetchModelList(id, cfg, limits = null) {
  const p = PROVIDERS[id];
  const base = cfg.baseUrl || p.baseUrl;
  // A custom account's extra headers go first: the key wins over a header of the same name.
  const headers = id === 'anthropic'
    ? { 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' }
    : { ...(cfg.headers || {}), ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) };
  const list = [];
  if (id === 'anthropic') {
    let after = null;
    for (let page = 0; page < ANTHROPIC_MODELS_MAX_PAGES; page++) {
      const j = await getModelsPage(`${base}/models?limit=${ANTHROPIC_MODELS_PAGE}` + (after ? `&after_id=${encodeURIComponent(after)}` : ''), headers, p, cfg);
      const data = j && Array.isArray(j.data) ? j.data : [];
      list.push(...data);
      const tail = data.length ? data[data.length - 1] : null;
      const last = (typeof j.last_id === 'string' && j.last_id) || (tail && tail.id) || null;
      if (j.has_more !== true || !last || last === after) break;
      after = last;
    }
  } else {
    const j = await getModelsPage(base + '/models', headers, p, cfg);
    list.push(...(Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : j && Array.isArray(j.models) ? j.models : []));
  }
  const ids = [];
  for (const m of list) {
    const mid = typeof m === 'string' ? m : m && (m.id || m.name || m.model);
    if (typeof mid === 'string' && mid.trim() && !ids.includes(mid.trim())) ids.push(mid.trim());
    if (limits && typeof mid === 'string' && m && typeof m === 'object') {
      const context = positiveInt(m.max_model_len || m.context_length || m.context_window || m.max_context_length);
      const reply = positiveInt(m.max_completion_tokens || (m.top_provider && m.top_provider.max_completion_tokens));
      if (context || reply) limits[mid.trim()] = { ...(context ? { context } : {}), ...(reply ? { reply } : {}) };
    }
  }
  if (!ids.length) {
    const err = new Error('The server returned no models.');
    if (cfg.accountId) markAccountHealth(cfg.accountId, err);
    throw err;
  }
  const chat = id === 'openai' ? openaiChatModels(ids) : [];
  const out = chat.length ? chat : ids;
  if (cfg.accountId) markAccountHealth(cfg.accountId, out.length);
  return out;
}
// An account's list, fetched and cached (state and storage).
// A custom account keeps the limits its list names and, without a model of its own, runs the first listed one. Only
// custom accounts get a prefix (modelPrefixOf): the other types' lists share none, and their ids stay as the API names them.
// The list, the limits and the account's model are stored short; a new prefix re-reads the model under the old one.
// timeoutMs: a time limit for each request (the models tool's), none when 0.
async function fetchAndCacheModels(a, timeoutMs = 0) {
  const custom = !!PROVIDERS[a.type].needsUrl;
  const limits = custom ? {} : null;
  let ids = await fetchModelList(a.type, { ...accountConfig(a), ...(timeoutMs ? { timeoutMs } : {}) }, limits);
  if (custom) {
    const model = a.model ? fullModelId(a, a.model) : '';
    const prefix = modelPrefixOf(ids);
    if (prefix) a.modelPrefix = prefix; else delete a.modelPrefix;
    ids = ids.map((m) => shortModelId(a, m));
    const kept = sanitizeLimits(shortLimits(a, limits));
    if (kept) a.limits = kept; else delete a.limits;
    a.model = model ? shortModelId(a, model) : ids[0];
  }
  state.modelLists[a.id] = ids;
  if (custom) await persistAccounts();
  try { await chrome.storage.local.set({ [modelsKey(a.id)]: ids }); } catch (e) { /* ignore */ }
  return ids;
}

// ---- The settings form ----------------------------------------------------------------------------------
// One row per account (built here, refs in settingsForm.rows). The row's head is a button that folds the row (the
// health dot, the name, the type when the name is not the type's) and × (removes at once); the body holds the type
// (a dropdown while the account has neither a key nor a URL, then a label), the name field, the API key with its
// hints, the server URL (Munin, custom; first for custom, which needs it), a dropdown of the account's models (a pick
// there is the open chat's pick, as under the input box: onModelPick) and "Check provider". A new row opens unfolded, the
// others start folded; what is unfolded is remembered for this panel only (settingsForm.expanded). "Add provider"
// adds a draft row (settingsForm.draft) with only the type dropdown: nothing is stored until a type is chosen, and the
// draft goes when it is folded, removed or the settings close. Every change applies at once: a key after a typing
// pause (KEY_CHECK_DEBOUNCE_MS) or on leaving the field, then checked; a name or URL when its field is left. Per
// account: the key's typing pause (keyTimer), the running check (checking: its promise) and the check asked for
// meanwhile (pending). askAccess: the accounts whose server Chrome blocked, so that the next Check provider click asks
// Chrome for the server's origin (this panel only; rows are rebuilt, so it is kept here).
// advanced: the accounts whose Advanced part is unfolded (this panel only, like expanded).
const settingsForm = { keyTimer: {}, checking: {}, pending: {}, pendingOpts: {}, rows: new Map(), expanded: new Set(), advanced: new Set(), draft: null, askAccess: new Set() };
const formRow = (id) => settingsForm.rows.get(id) || null;
const isChatAccount = (id) => { const a = chatAccount(); return !!a && a.id === id; };

function makeNode(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function makeButton(cls, text, title) {
  const b = makeNode('button', cls, text);
  b.type = 'button';
  if (title) b.dataset.tip = title;
  return b;
}
function urlField(r, p) {
  const urlLabel = makeNode('label', '', 'Server URL');
  r.url = makeNode('input', 'account-url');
  r.url.type = 'text';
  r.url.spellcheck = false;
  r.url.placeholder = p.urlPlaceholder || p.baseUrl;
  urlLabel.appendChild(r.url);
  return urlLabel;
}

// A custom account's extra headers: one row per header (name, value, ×) and Add header below, at most HEADERS_MAX
// rows. Stored when a field is left or a row removed (onHeadersChange). A group, not a label: a label would pass
// its clicks to the first button inside.
function headersField(r, id) {
  const box = makeNode('div', 'account-headers');
  box.setAttribute('role', 'group');
  const caption = makeNode('div', 'field-caption', 'Extra headers');
  caption.id = 'account-headers-' + id;
  box.setAttribute('aria-labelledby', caption.id);
  r.headerList = makeNode('div', 'header-rows');
  r.addHeader = makeButton('btn small header-add', 'Add header', 'Add a request header');
  r.addHeader.addEventListener('click', () => {
    if (r.headerList.children.length >= HEADERS_MAX) return;
    addHeaderRow(r, id, '', '').name.focus();
    updateAddHeader(r);
  });
  box.append(caption, r.headerList, r.addHeader);
  return box;
}
function updateAddHeader(r) {
  r.addHeader.disabled = r.headerList.children.length >= HEADERS_MAX;
}
function addHeaderRow(r, id, name, value) {
  const h = { row: makeNode('div', 'header-row') };
  h.name = makeNode('input', 'header-name');
  h.value = makeNode('input', 'header-value');
  for (const [input, ph, max, label] of [[h.name, 'OpenAI-Project', 100, 'Header name'], [h.value, '<folder ID>', HEADER_VALUE_MAX, 'Header value']]) {
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = ph;
    input.maxLength = max;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => onHeadersChange(id, h.row));
  }
  h.name.value = name;
  h.value.value = value;
  const remove = makeButton('icon-btn header-remove', '×', 'Remove this header');
  remove.setAttribute('aria-label', 'Remove this header');
  remove.addEventListener('click', () => {
    h.row.remove();
    updateAddHeader(r);
    r.addHeader.focus();
    onHeadersChange(id);
  });
  // An unfinished row is marked only once the user leaves it (not while moving from its name to its value).
  h.row.addEventListener('focusout', (e) => { if (!h.row.contains(e.relatedTarget)) markHeaderRows(r); });
  h.row.append(h.name, h.value, remove);
  r.headerList.appendChild(h.row);
  return h;
}
function renderHeaderRows(r, id, headers) {
  r.headerList.textContent = '';
  for (const [n, v] of Object.entries(headers || {})) addHeaderRow(r, id, n, v);
  updateAddHeader(r);
}
// The rows read in order: the headers they make (sanitizeHeaders: null when none) and each row's problem ('' for a
// header or an empty row, which is skipped).
function readHeaderRows(r) {
  const raw = Object.create(null);
  const seen = new Set();
  const rows = [...r.headerList.children].map((row) => {
    const [nameInput, valueInput] = row.querySelectorAll('input');
    const name = nameInput.value.trim();
    const value = headerValue(valueInput.value);
    if (!name && !value) return { row, problem: '' };
    const problem = headerProblem(name, value, seen);
    if (!problem) { seen.add(name.toLowerCase()); raw[name] = value; }
    return { row, problem, incomplete: !name || !value };
  });
  return { headers: sanitizeHeaders(raw), rows };
}
// Refused rows get the warn mark and a tooltip saying why; an unfinished row (name or value missing) is not marked
// while the user is still in it (editing: the row whose field just changed, before the focus moves).
function markHeaderRows(r, editing) {
  for (const { row, problem, incomplete } of readHeaderRows(r).rows) {
    const show = !!problem && !(incomplete && (row === editing || row.contains(document.activeElement)));
    row.classList.toggle('warn', show);
    if (show) row.dataset.tip = problem; else delete row.dataset.tip;
  }
}

// Advanced, below the models: a fold button and, unfolded, the reply length and the temperature for every model of the
// account. Stored when a field is left (onParamChange); empty means the default.
function advancedField(r, id) {
  r.advToggle = makeButton('btn small account-advanced-toggle', 'Advanced', 'Reply length and temperature for all models of this provider');
  r.advToggle.setAttribute('aria-controls', 'account-advanced-' + id);
  r.advBox = makeNode('div', 'account-advanced');
  r.advBox.id = 'account-advanced-' + id;
  r.advBox.setAttribute('role', 'group');
  r.advBox.setAttribute('aria-label', 'Reply length and temperature for all models of this provider');
  const fields = makeNode('div', 'advanced-fields');
  const maxLabel = makeNode('label', '', 'Max output tokens');
  r.maxTokens = makeNode('input', 'account-max-tokens');
  r.maxTokens.type = 'number';
  r.maxTokens.min = '1';
  r.maxTokens.step = '1';
  maxLabel.appendChild(r.maxTokens);
  const tempLabel = makeNode('label', '', 'Temperature');
  r.temperature = makeNode('input', 'account-temperature');
  r.temperature.type = 'number';
  r.temperature.min = '0';
  r.temperature.max = String(TEMPERATURE_MAX);
  r.temperature.step = '0.01';
  tempLabel.appendChild(r.temperature);
  fields.append(maxLabel, tempLabel);
  r.advHint = makeNode('p', 'hint hidden');
  r.advBox.append(fields, r.advHint);
  r.advToggle.addEventListener('click', () => toggleAdvanced(id));
  r.maxTokens.addEventListener('change', () => onParamChange(id, 'maxTokens'));
  r.temperature.addEventListener('change', () => onParamChange(id, 'temperature'));
  return [r.advToggle, r.advBox];
}
function setAdvancedOpen(r, open) {
  r.advBox.classList.toggle('hidden', !open);
  r.advToggle.setAttribute('aria-expanded', String(open));
}
function toggleAdvanced(id, on) {
  const r = formRow(id);
  if (!r) return;
  const open = typeof on === 'boolean' ? on : !settingsForm.advanced.has(id);
  if (open) settingsForm.advanced.add(id); else settingsForm.advanced.delete(id);
  setAdvancedOpen(r, open);
}
function setAdvancedHint(r, text, warn) {
  r.advHint.textContent = text || '';
  r.advHint.classList.toggle('warn', !!warn);
  r.advHint.classList.toggle('hidden', !text);
}
// The fields show the account's stored settings; the placeholders show the defaults of the account's current model
// (the one its chats last picked). A temperature the model refuses is left out silently by providerFor.
function fillAdvanced(id) {
  const a = accountById(id);
  const r = formRow(id);
  if (!a || !r || !r.advBox) return;
  const m = accountModel(a);
  const own = accountParams(a);
  r.maxTokens.value = own.maxTokens ? String(own.maxTokens) : '';
  r.temperature.value = own.temperature != null ? String(own.temperature) : '';
  r.maxTokens.placeholder = String(defaultReplyTokens(a, m));
  r.temperature.placeholder = PROVIDERS[a.type].sampling ? 'default' : 'server default';
  r.maxTokens.classList.remove('warn');
  r.temperature.classList.remove('warn');
  setAdvancedHint(r, ''); // a stored value clears the validation message
}
// A field left: its value is stored for the account (empty: the default); a value out of range is marked, not stored.
async function onParamChange(id, field) {
  const a = accountById(id);
  const r = formRow(id);
  if (!a || !r) return;
  const input = field === 'maxTokens' ? r.maxTokens : r.temperature;
  const raw = input.value.trim();
  const n = Number(raw);
  let value = null;
  if (raw) {
    value = field === 'maxTokens' ? (Number.isInteger(n) && n > 0 ? n : 0) : cleanTemperature(n);
    if (!value && !(field === 'temperature' && value === 0)) {
      input.classList.add('warn');
      setAdvancedHint(r, field === 'maxTokens' ? 'Enter a whole number above 0, or leave it empty for the default.'
        : `Enter a number from 0 to ${TEMPERATURE_MAX}, or leave it empty for the default.`, true);
      return;
    }
  }
  await setAccountParams(id, { [field]: value });
}

// The head of a row: the fold button (dot, title, type) and ×.
function buildRowHead(r, key) {
  const head = makeNode('div', 'provider-head');
  r.toggle = makeButton('provider-toggle'); // named by its title and type; aria-expanded says it folds
  r.toggle.setAttribute('aria-controls', 'account-body-' + key);
  r.dot = makeNode('span', 'health-dot');
  r.title = makeNode('span', 'provider-title');
  r.typeLabel = makeNode('span', 'provider-type');
  r.toggle.append(r.dot, r.title, r.typeLabel); // no caret: the whole head folds the row
  r.remove = makeButton('icon-btn account-remove', '×', 'Remove this provider');
  r.remove.setAttribute('aria-label', 'Remove this provider');
  head.append(r.toggle, r.remove);
  r.body = makeNode('div', 'provider-body');
  r.body.id = 'account-body-' + key;
  return head;
}
// The type: a dropdown of the types (a draft's starts blank), and the same as plain text once
// the type is fixed (renderTypeField shows one of them).
function typeField(r, type) {
  const label = makeNode('label', 'account-type-field', 'Provider type');
  r.typeSelect = makeNode('select', 'account-type');
  r.typeSelect.dataset.tip = 'Fixed once a key is set';
  if (!type) {
    const o = makeNode('option', '', ''); // blank and hidden: the closed select shows nothing, the list only the types
    o.value = '';
    o.disabled = true;
    o.hidden = true;
    r.typeSelect.appendChild(o);
  }
  for (const t of PROVIDER_IDS) {
    const o = makeNode('option', '', addProviderName(t));
    o.value = t;
    r.typeSelect.appendChild(o);
  }
  r.typeSelect.value = type || '';
  r.typeFixed = makeNode('span', 'account-type-fixed hidden', type ? addProviderName(type) : '');
  label.append(r.typeSelect, r.typeFixed);
  return label;
}

// A row's elements for an account (listeners bound here).
function buildAccountRow(a) {
  const p = PROVIDERS[a.type];
  const id = a.id;
  const r = { block: makeNode('div', 'provider-block') };
  r.block.dataset.account = id;
  r.block.dataset.provider = a.type;
  const head = buildRowHead(r, id);
  r.typeLabel.textContent = p.name;
  r.body.appendChild(typeField(r, a.type));
  const nameLabel = makeNode('label', '', 'Name');
  r.name = makeNode('input', 'account-name');
  r.name.type = 'text';
  r.name.maxLength = ACCOUNT_NAME_MAX;
  r.name.dataset.tip = 'Shown in the model menu';
  nameLabel.appendChild(r.name);
  r.body.appendChild(nameLabel);
  if (p.needsUrl) r.body.appendChild(urlField(r, p));
  const keyLabel = makeNode('label', '', p.keyOptional ? 'API key (optional)' : 'API key');
  if (p.keyUrl) { // "API key (muninai.org)": the site in parentheses, as a link
    const site = document.createElement('a');
    site.href = p.keyUrl; site.target = '_blank'; site.rel = 'noopener';
    site.textContent = p.keyUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    keyLabel.append(' (', site, ')');
  }
  r.apiKey = makeNode('input', 'account-key');
  r.apiKey.type = 'password';
  r.apiKey.autocomplete = 'off';
  r.apiKey.spellcheck = false;
  // The eye shows the key in clear text while pressed (a password field hides it by default).
  const wrap = makeNode('div', 'key-wrap');
  r.keyEye = makeButton('key-eye', null, 'Show the key');
  r.keyEye.setAttribute('aria-label', 'Show the key');
  r.keyEye.setAttribute('aria-pressed', 'false');
  r.keyEye.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>';
  r.keyEye.addEventListener('click', () => {
    const show = r.apiKey.type === 'password';
    r.apiKey.type = show ? 'text' : 'password';
    r.keyEye.setAttribute('aria-pressed', String(show));
    r.keyEye.dataset.tip = show ? 'Hide the key' : 'Show the key';
    r.keyEye.setAttribute('aria-label', r.keyEye.dataset.tip);
  });
  wrap.append(r.apiKey, r.keyEye);
  keyLabel.appendChild(wrap);
  r.keyHint = makeNode('p', 'hint hidden');
  r.keyWarn = makeNode('p', 'hint warn hidden');
  r.body.append(keyLabel, r.keyHint, r.keyWarn);
  if (p.needsUrl) r.body.appendChild(headersField(r, id));
  if (p.ownUrl && !p.needsUrl) r.body.appendChild(urlField(r, p));
  const modelRow = makeNode('div', 'model-row');
  const modelsLabel = makeNode('label', '', 'Models');
  r.modelSelect = makeNode('select', 'account-models');
  r.modelSelect.dataset.tip = 'Models of this provider';
  modelsLabel.appendChild(r.modelSelect);
  r.check = makeButton('btn account-check', 'Check provider', 'Fetch the model list');
  modelRow.append(modelsLabel, r.check);
  r.modelStatus = makeNode('p', 'hint hidden');
  r.body.append(modelRow, r.modelStatus, ...advancedField(r, id));
  r.block.append(head, r.body);
  r.toggle.addEventListener('click', () => toggleAccountRow(id));
  r.typeSelect.addEventListener('change', () => changeAccountType(id, r.typeSelect.value));
  r.apiKey.addEventListener('input', () => onApiKeyInput(id));
  r.apiKey.addEventListener('blur', () => onApiKeyBlur(id));
  r.name.addEventListener('change', () => onNameChange(id));
  if (r.url) r.url.addEventListener('change', () => onUrlChange(id));
  r.check.addEventListener('click', () => onCheckClick(id));
  r.modelSelect.addEventListener('change', () => onModelPick(id));
  r.remove.addEventListener('click', () => removeAccount(id));
  setRowOpen(r, settingsForm.expanded.has(id));
  setAdvancedOpen(r, settingsForm.advanced.has(id));
  return r;
}

// The draft row of "Add provider": unfolded, only the type dropdown (its first option asks for the type). A chosen type
// becomes an account (stored); folding or × drops the draft (nothing was stored).
function buildDraftRow() {
  const r = { block: makeNode('div', 'provider-block account-draft') };
  const head = buildRowHead(r, 'draft');
  r.title.textContent = 'New provider';
  r.typeLabel.classList.add('hidden');
  r.dot.dataset.tip = 'Not checked yet';
  r.body.appendChild(typeField(r, ''));
  r.block.append(head, r.body);
  r.toggle.addEventListener('click', discardDraftRow);
  r.remove.addEventListener('click', discardDraftRow);
  r.typeSelect.addEventListener('change', () => {
    const type = r.typeSelect.value;
    if (!PROVIDERS[type]) return;
    discardDraftRow();
    addAccount(type);
  });
  setRowOpen(r, true);
  return r;
}
// "Add provider": the draft row at the end of the list (a second click focuses the one that is there).
function addDraftRow() {
  const box = el.accountList;
  if (!box) return null;
  if (!settingsForm.draft) {
    settingsForm.draft = buildDraftRow();
    dropEmptyHint();
    box.appendChild(settingsForm.draft.block);
  }
  settingsForm.draft.typeSelect.focus();
  return settingsForm.draft;
}
function discardDraftRow() {
  const d = settingsForm.draft;
  if (!d) return;
  settingsForm.draft = null;
  const refocus = d.block.contains(document.activeElement);
  d.block.remove();
  showEmptyHint();
  if (refocus && el.addProviderBtn) el.addProviderBtn.focus();
}
// The hint of an empty list (no account, no draft).
const emptyHint = () => (el.accountList && el.accountList.querySelectorAll('.account-empty')[0]) || null;
function showEmptyHint() {
  const box = el.accountList;
  if (!box || accounts().length || settingsForm.draft || emptyHint()) return;
  box.appendChild(makeNode('p', 'hint account-empty', 'No provider yet: add one below and paste its API key.'));
}
function dropEmptyHint() {
  const n = emptyHint();
  if (n) n.remove();
}

// The type may change while the account has neither a key (stored or typed) nor a server URL: the stored shape then
// holds nothing that belongs to the old type. Otherwise the dropdown becomes text.
const typeLocked = (a, r) => !!(a.apiKey || a.baseUrl || (r && r.apiKey && r.apiKey.value.trim()));
function renderTypeField(id) {
  const a = accountById(id);
  const r = formRow(id);
  if (!a || !r) return;
  const locked = typeLocked(a, r);
  r.typeSelect.value = a.type;
  r.typeSelect.classList.toggle('hidden', locked);
  r.typeFixed.textContent = addProviderName(a.type);
  r.typeFixed.classList.toggle('hidden', !locked);
}

function setRowOpen(r, open) {
  r.block.classList.toggle('open', open);
  r.body.classList.toggle('hidden', !open);
  r.toggle.setAttribute('aria-expanded', String(open));
}
// A click on a row's head folds or unfolds its body (remembered for this panel only). on: force a state.
function toggleAccountRow(id, on) {
  const r = formRow(id);
  if (!r) return;
  const open = typeof on === 'boolean' ? on : !settingsForm.expanded.has(id);
  if (open) settingsForm.expanded.add(id); else settingsForm.expanded.delete(id);
  setRowOpen(r, open);
}

// The head: the name, and the type beside it when the name is not the type's own.
function renderRowTitle(a) {
  const r = formRow(a.id);
  if (!r) return;
  r.title.textContent = a.name;
  r.typeLabel.classList.toggle('hidden', a.name === typeName(a.type));
}

function fillAccountRow(a) {
  const r = formRow(a.id);
  if (!r) return;
  const p = PROVIDERS[a.type];
  r.name.value = a.name;
  renderRowTitle(a);
  r.apiKey.placeholder = p.keyPrefix ? p.keyPrefix + '...' : 'API key';
  r.apiKey.value = a.apiKey || '';
  r.keyHint.textContent = p.keyHint || '';
  if (r.url) r.url.value = a.baseUrl || (p.needsUrl ? '' : p.baseUrl); // Munin shows its standard server; Custom starts empty
  if (r.headerList) renderHeaderRows(r, a.id, a.headers); // empty and refused rows go
  renderModelOptions(a.id);
  setModelStatus(a.id, '');
  updateKeyWarning(a.id);
  renderTypeField(a.id);
  renderAccountHealth(a.id);
}

// The rows of all accounts (rebuilt; a draft row stays last), or a hint while there is none.
function renderAccountList() {
  const box = el.accountList;
  if (!box) return;
  box.textContent = '';
  settingsForm.rows = new Map();
  for (const a of accounts()) appendAccountRow(a);
  if (settingsForm.draft) box.appendChild(settingsForm.draft.block);
  showEmptyHint();
}
// One account's row, built, filled and put at the end of the accounts (before a draft).
function appendAccountRow(a) {
  const r = buildAccountRow(a);
  settingsForm.rows.set(a.id, r);
  const d = settingsForm.draft;
  el.accountList.insertBefore(r.block, d && d.block.parentNode === el.accountList ? d.block : null);
  fillAccountRow(a);
  return r;
}

// The dot of a row (grey: unknown, green: verified, red with the reason: down), the open model menu and the model label.
function renderAccountHealth(id) {
  const a = accountById(id);
  const r = formRow(id);
  if (r && a) {
    const st = healthState(a);
    r.dot.classList.toggle('down', st === 'down');
    r.dot.classList.toggle('ok', st === 'ok');
    r.dot.dataset.tip = healthTitle(a);
  }
  refreshModelMenu();
  renderChatModel();
}

function renderModelOptions(id) {
  const r = formRow(id);
  if (!r) return;
  fillModelSelect(r, id);
  fillAdvanced(id);
}
// The model a row's dropdown shows: the open chat's when the chat runs on the account, else '' ("—"), as the model menu
// checks only the chat's model; '' too while no list is loaded.
function rowModel(id) {
  const c = chatChoice();
  if (!(state.modelLists[id] || []).length || !c || c.accountId !== id) return '';
  return c.model || accountModel(accountById(id));
}
// The dropdown lists what the API listed; empty and disabled until a list was loaded (that needs the key). Shown: the
// chat's model on the account (listed first when the list lacks it, as in the model menu), else "—", so that every
// listed model is a pick (onModelPick: a select fires no change for the entry it shows).
function fillModelSelect(r, id) {
  const sel = r.modelSelect;
  const ids = (state.modelLists[id] || []).slice();
  const shown = rowModel(id);
  sel.textContent = '';
  if (shown && !ids.includes(shown)) ids.unshift(shown);
  if (!shown) {
    const o = makeNode('option', '', '—');
    o.value = '';
    sel.appendChild(o);
  }
  for (const m of ids) {
    const o = makeNode('option', '', m);
    o.value = m;
    sel.appendChild(o);
  }
  sel.disabled = !ids.length;
  sel.value = shown;
}
// The rows follow every change of the open chat's model (render.js renderChatModel: a pick, a models switch, a revert,
// another tab's change): a row showing a stale model could not pick it again.
function syncRowModels() {
  for (const [id, r] of settingsForm.rows) if (r.modelSelect.value !== rowModel(id)) fillModelSelect(r, id);
}
// A model picked in a row is the open chat's pick, as in the model menu (accounts.js chooseModel): the chat runs on it
// from its next message, and it becomes the last choice and the account's model.
async function onModelPick(id) {
  const r = formRow(id);
  const m = r ? r.modelSelect.value : '';
  if (m) await chooseModel(id, m);
}
// A key or a server URL made the account usable while the open chat had no account to run on (none, a removed one, one
// without a key or URL): the chat takes it, on its own model when it named the account, else on the account's, as a
// pick would (stored, the last choice). keep (chatKeeps, read before the change): the chat had a usable account, or
// this one was usable already; nothing changes then, nor when another usable account was picked during the check.
async function takeForChat(id, keep) {
  const a = accountById(id);
  const now = chatAccount();
  if (keep || !canRequest(a) || (now && now.id !== id && canRequest(now))) return;
  const c = chatChoice();
  await chooseModel(id, c && c.accountId === id ? c.model : accountModel(a));
}
const chatKeeps = (a) => canRequest(chatAccount()) || canRequest(a);

function setModelStatus(id, text, warn) {
  const r = formRow(id);
  if (!r) return;
  r.modelStatus.textContent = text || '';
  r.modelStatus.classList.toggle('warn', !!warn);
  r.modelStatus.classList.toggle('hidden', !text);
}

function updateKeyWarning(id) {
  const a = accountById(id);
  const r = formRow(id);
  if (!a || !r) return;
  const p = PROVIDERS[a.type];
  const k = r.apiKey.value.trim();
  r.keyWarn.textContent = `This key does not start with "${p.keyPrefix}". It will still be saved, but it may be rejected by the server.`;
  r.keyWarn.classList.toggle('hidden', !k || !p.keyPrefix || k.startsWith(p.keyPrefix));
  r.keyHint.classList.toggle('hidden', !!k); // where to get a key, while there is none
}

// A new account of the type with the next free name, stored at once, its row unfolded (the draft row's choice of a
// type); its key field (a custom server's URL field) gets the focus.
async function addAccount(type) {
  if (!PROVIDERS[type]) return null;
  const a = { id: newAccountId(), type, name: uniqueAccountName('', type), apiKey: '' };
  state.settings.accounts = [...accounts(), a];
  state.modelLists[a.id] = [];
  settingsForm.expanded.add(a.id);
  await persistAccounts();
  if (el.accountList) {
    dropEmptyHint();
    const r = appendAccountRow(a);
    (PROVIDERS[type].needsUrl ? r.url : r.apiKey).focus();
  }
  renderContextGauge();
  return a;
}

// Another type for an account that has neither a key nor a URL yet: nothing of the old type is kept (its model, list,
// limits, mark), and a name that was the old type's own ("OpenAI 2") becomes the new type's. The row is rebuilt.
async function changeAccountType(id, type) {
  const a = accountById(id);
  if (!a) return false;
  if (!PROVIDERS[type] || type === a.type || typeLocked(a, formRow(id))) { renderTypeField(id); return false; }
  const base = typeName(a.type);
  const ownName = a.name.startsWith(base) && /^( \d+)?$/.test(a.name.slice(base.length));
  a.type = type;
  if (ownName) a.name = uniqueAccountName('', type, id);
  for (const k of ['model', 'modelPrefix', 'limits', 'health', 'baseUrl', 'headers', 'omit', 'params']) delete a[k];
  state.modelLists[id] = [];
  try { await chrome.storage.local.remove(modelsKey(id)); } catch (e) { /* ignore */ }
  await persistAccounts();
  const old = formRow(id);
  if (old) {
    const r = buildAccountRow(a);
    settingsForm.rows.set(id, r);
    old.block.replaceWith(r.block);
    fillAccountRow(a);
    r.typeSelect.focus();
  }
  renderContextGauge();
  return true;
}

// Removes an account at once: its key, its cached list and its row. Chats that ran on it show "Choose a model"; the
// last choice goes when it was this account.
async function removeAccount(id) {
  if (!accountById(id)) return;
  clearTimeout(settingsForm.keyTimer[id]);
  delete settingsForm.keyTimer[id];
  settingsForm.expanded.delete(id);
  settingsForm.advanced.delete(id);
  state.settings.accounts = accounts().filter((a) => a.id !== id);
  delete state.modelLists[id];
  const r = formRow(id);
  if (r) { r.block.remove(); settingsForm.rows.delete(id); }
  showEmptyHint();
  const last = state.settings.lastModel;
  if (last && last.accountId === id) {
    state.settings.lastModel = null;
    try { await chrome.storage.local.remove(LAST_MODEL_KEY); } catch (e) { /* ignore */ }
  }
  await persistAccounts();
  try { await chrome.storage.local.remove(modelsKey(id)); } catch (e) { /* ignore */ }
  renderContextGauge();
}

// Typing or pasting an API key stores it shortly after the last edit (or when the field is left) and then checks it
// (the model list is fetched).
function onApiKeyInput(id) {
  updateKeyWarning(id);
  renderTypeField(id); // a typed key fixes the type
  clearTimeout(settingsForm.keyTimer[id]);
  settingsForm.keyTimer[id] = setTimeout(() => commitApiKey(id), KEY_CHECK_DEBOUNCE_MS);
}
// Leaving the field stores a key that is still waiting for the typing pause.
function onApiKeyBlur(id) {
  if (settingsForm.keyTimer[id]) return commitApiKey(id);
  return null;
}
// The key field's value becomes the account's key (stored); a key is then checked.
async function commitApiKey(id) {
  clearTimeout(settingsForm.keyTimer[id]);
  settingsForm.keyTimer[id] = 0;
  const a = accountById(id);
  if (!a) return;
  const r = formRow(id);
  const keep = chatKeeps(a);
  if (r) a.apiKey = r.apiKey.value.trim();
  await persistAccounts();
  renderTypeField(id);
  renderContextGauge();
  if (a.apiKey) await checkModels(id, { verify: true, probe: true });
  else setModelStatus(id, '');
  await takeForChat(id, keep); // after the check: a Custom account gets its model from the list
}
// A name is stored when its field is left (made unique; empty: the type's name).
async function onNameChange(id) {
  const a = accountById(id);
  const r = formRow(id);
  if (!a || !r) return;
  a.name = uniqueAccountName(r.name.value, a.type, id);
  r.name.value = a.name;
  renderRowTitle(a);
  await persistAccounts();
  renderContextGauge();
}
// A server URL is stored when its field is left (Munin: '' or the default is Munin's own; custom: normalized, see
// cleanBaseUrl); the list, the limits and the health mark belong to the old server, so they go, and an account that
// can be asked is checked on the new one.
async function onUrlChange(id) {
  const a = accountById(id);
  const r = formRow(id);
  if (!a || !r || !r.url) return;
  const p = PROVIDERS[a.type];
  const typed = r.url.value.trim().replace(/\/+$/, '');
  let url = cleanBaseUrl(typed, a.type);
  if (typed && !url && typed !== p.baseUrl) {
    setModelStatus(id, `Enter a URL like ${p.urlPlaceholder || p.baseUrl}`, true);
    return;
  }
  if (!p.needsUrl && (!url || url === p.baseUrl)) url = ''; // the standard server is stored as "no custom URL"
  r.url.value = url || (p.needsUrl ? '' : p.baseUrl);
  if ((a.baseUrl || '') === url) return;
  const keep = chatKeeps(a);
  if (url) a.baseUrl = url; else delete a.baseUrl;
  delete a.omit; // what the old server refused
  settingsForm.askAccess.delete(id);
  await forgetServerAnswers(a);
  renderTypeField(id);
  if (canRequest(a)) await checkModels(id, { verify: true, probe: true });
  else setModelStatus(id, '');
  await takeForChat(id, keep);
}
// The list, the prefix, the limits and the health mark came from the server as the account reached it before (another URL, other
// headers): they go, stored.
// The account's model keeps its full id when the prefix goes.
async function forgetServerAnswers(a) {
  delete a.health;
  delete a.limits;
  if (a.model) a.model = fullModelId(a, a.model);
  delete a.modelPrefix;
  state.modelLists[a.id] = [];
  try { await chrome.storage.local.remove(modelsKey(a.id)); } catch (e) { /* ignore */ }
  await persistAccounts();
  renderModelOptions(a.id);
  renderAccountHealth(a.id);
  renderContextGauge();
}
// A custom account's extra headers are stored when a field of their rows is left or a row is removed (the rows that
// make a header; empty: none); a change is checked at once like a new URL. Refused rows are marked, not stored.
async function onHeadersChange(id, editing) {
  const a = accountById(id);
  const r = formRow(id);
  if (!a || !r || !r.headerList) return;
  const { headers } = readHeaderRows(r);
  markHeaderRows(r, editing);
  let res = null;
  if (JSON.stringify(a.headers || null) !== JSON.stringify(headers)) {
    if (headers) a.headers = headers; else delete a.headers;
    await forgetServerAnswers(a);
    if (canRequest(a)) res = await checkModels(id, { verify: true, probe: true });
  }
  if (!res) setModelStatus(id, '');
}

// Check provider: after Chrome blocked the account's server, the click first asks Chrome for the server's origin.
function onCheckClick(id) {
  if (settingsForm.askAccess.has(id)) return askServerAccess(id);
  return settingsForm.keyTimer[id] ? commitApiKey(id) : checkModels(id, { probe: true });
}
// chrome.permissions.request runs first, before any await: Chrome grants only within the click's user gesture (as
// references.js grantReferences). Granted: the check runs; refused: the status says how to try again.
function askServerAccess(id) {
  const a = accountById(id);
  const origin = a ? serverOrigin(a.baseUrl) : '';
  let req;
  try { req = origin ? chrome.permissions.request({ origins: [origin] }) : false; } catch (e) { req = false; }
  return Promise.resolve(req).then((ok) => !!ok, () => false).then((ok) => {
    if (!accountById(id)) return { ok: false, error: 'This provider was removed.' };
    if (!ok) {
      setModelStatus(id, `Chrome did not allow access to ${serverHost(a.baseUrl)}. Click Check provider and choose Allow.`, true);
      return { ok: false, error: 'access refused' };
    }
    settingsForm.askAccess.delete(id);
    return settingsForm.keyTimer[id] ? commitApiKey(id) : checkModels(id, { verify: true, probe: true });
  });
}

// Asks the account for its model list, caches it and refreshes the row ("Check provider", key and URL changes, the
// model menu, the models tool). verify (key edits): the status says the key works and, for the open chat's account,
// the stale "fix your settings" errors leave the chat; with the settings closed meanwhile, the result goes to the chat.
// A check asked for while one of the same account runs is run after it (the key may have changed). opts.timeoutMs: a
// time limit per request (the models tool). opts.probe (explicit checks only: a key, URL or headers change, Check
// provider, the models tool's check and switch): a listed account must also answer a chat probe (runChatProbe).
// Resolves to { ok, ids, chat? } or { ok: false, error, status?, noKey?, chatRefused? }.
function checkModels(id, opts = {}) {
  if (settingsForm.checking[id]) {
    const queued = settingsForm.pendingOpts[id];
    // A queued explicit check keeps its probe when a plain one (the model menu) is asked for after it.
    settingsForm.pendingOpts[id] = settingsForm.pending[id] && queued && queued.probe && !opts.probe ? { ...opts, probe: true } : opts;
    if (!settingsForm.pending[id]) {
      settingsForm.pending[id] = settingsForm.checking[id].then(() => {
        settingsForm.pending[id] = null;
        return checkModels(id, settingsForm.pendingOpts[id] || {});
      });
    }
    return settingsForm.pending[id];
  }
  const run = runModelCheck(id, opts).finally(() => { settingsForm.checking[id] = null; });
  settingsForm.checking[id] = run;
  return run;
}

async function runModelCheck(id, opts) {
  const a = accountById(id);
  if (!a) return { ok: false, error: 'This provider was removed.' };
  if (!canRequest(a)) {
    const noUrl = PROVIDERS[a.type].needsUrl && !a.baseUrl;
    setModelStatus(id, noUrl ? 'Enter the server URL first.' : 'Enter the API key first.', true);
    return { ok: false, error: noUrl ? 'no server URL' : 'no API key', noKey: true };
  }
  const r = formRow(id);
  if (r) r.check.disabled = true;
  setModelStatus(id, 'Checking the provider…');
  const hidden = () => el.settings.classList.contains('hidden');
  try {
    const ids = await fetchAndCacheModels(a, opts.timeoutMs || 0);
    settingsForm.askAccess.delete(id);
    renderModelOptions(id);
    const probed = !!opts.probe && chatProbeOn() && accountById(id) === a;
    if (probed) {
      const refused = await runChatProbe(a, opts);
      if (refused) return refused;
    }
    if (opts.verify && isChatAccount(id)) clearSettingsErrors();
    setModelStatus(id, ''); // no text: the green dot and the list say it worked
    return { ok: true, ids, ...(probed ? { chat: true } : {}) };
  } catch (e) {
    // No answer from the account's own server: Chrome's CORS check may have stopped it (no host permission yet).
    const blocked = !!(e.network && a.baseUrl) && !(await serverAccess(a.baseUrl));
    if (blocked) settingsForm.askAccess.add(id); else settingsForm.askAccess.delete(id);
    const msg = blocked ? `Chrome did not let the panel reach ${serverHost(a.baseUrl)}. Click Check provider to allow it.`
      : 'Could not get the model list: ' + e.message;
    setModelStatus(id, msg, true);
    if (opts.verify && hidden()) {
      if (e.status === 401 || e.status === 403) addError(e.message, true);
      else addError(`Could not check the ${a.name} key: ${blocked ? msg : e.message}`, true);
    }
    return { ok: false, error: e.message, status: e.status };
  } finally {
    const row = formRow(id);
    if (row) row.check.disabled = false;
    renderAccountHealth(id);
    renderContextGauge();
  }
}

// The chat probe of an explicit check (probe.js) on the chat's model when the account is the chat's, else the
// account's: null when the chat answered, else the check's failed answer (the row's status and the mark say why).
async function runChatProbe(a, opts) {
  const choice = chatChoice();
  const model = choice && choice.accountId === a.id ? choice.model : accountModel(a);
  const { error } = await probeChat(a, model, { timeoutMs: opts.timeoutMs || MODELS_FETCH_TIMEOUT_MS });
  markAccountHealth(a.id, error || null, true);
  if (!error) return null;
  const rejected = error.status === 401;
  const reason = healthError(error);
  const msg = rejected ? error.message : `Chat refused: ${reason.replace(/[.\s]+$/, '')}. The key works, but the server did not answer a chat request.`;
  setModelStatus(a.id, msg, true);
  if (opts.verify && el.settings.classList.contains('hidden')) {
    if (rejected) addError(error.message, true);
    else addError(`${a.name}: ${msg}`, true);
  }
  return { ok: false, error: msg, status: error.status, chatRefused: reason };
}

function openSettings() {
  closeFiles();
  renderAccountList();
  renderGoogleStatus();
  el.settings.classList.remove('hidden');
  // The chat's account: its key field when its row is unfolded, else its head.
  const a = chatAccount() || accounts()[0];
  const r = a && formRow(a.id);
  if (r) (settingsForm.expanded.has(a.id) ? r.apiKey : r.toggle).focus();
}

// Closing (gear button, a click outside the section) first stores the keys still waiting for the typing pause;
// their checks then report in the chat. A draft row without a type goes.
function closeSettings() {
  discardDraftRow();
  for (const id of Object.keys(settingsForm.keyTimer)) if (settingsForm.keyTimer[id]) commitApiKey(id);
  el.settings.classList.add('hidden');
}

// Stores the keys still waiting for their typing pause (the panel is unloaded, a test); no key check.
async function saveSettings() {
  const waiting = Object.keys(settingsForm.keyTimer).filter((id) => settingsForm.keyTimer[id]);
  if (!waiting.length) return;
  for (const id of waiting) {
    clearTimeout(settingsForm.keyTimer[id]);
    settingsForm.keyTimer[id] = 0;
    const a = accountById(id);
    const r = formRow(id);
    if (a && r) a.apiKey = r.apiKey.value.trim();
  }
  await persistAccounts();
}

// The type names of the type dropdown ("Custom (OpenAI-compatible)").
const addProviderName = (type) => PROVIDERS[type].menuName || PROVIDERS[type].name;

// The form's listeners (main.js bindUi): "Add provider" adds a draft row; the rows bind their own.
function bindSettingsForm() {
  if (!el.addProviderBtn) return;
  el.addProviderBtn.addEventListener('click', () => addDraftRow());
}

// Removes the stale "fix your settings" errors (missing or rejected key, unknown model) from the
// chat once a key works; an otherwise empty chat gets its hint back.
function clearSettingsErrors() {
  el.chat.querySelectorAll('.msg.error.settings-error').forEach((n) => n.remove());
  if (!el.chat.children.length) renderEmpty();
}

// The extension's version, at the bottom of the settings.
function renderVersion() {
  const node = document.getElementById('settingsVersion');
  if (!node) return;
  let v = '';
  try { v = chrome.runtime.getManifest().version || ''; } catch (e) { /* no manifest (tests) */ }
  node.textContent = v ? `Version ${v}` : '';
}
renderVersion();

// The References grant (references.js asks for it on a chat card) counts only while Chrome still grants all the
// optional hosts: they can be removed in chrome://extensions.
async function referencesPermitted() {
  try { return !!(await chrome.permissions.contains({ origins: REFERENCES_ORIGINS })); } catch (e) { return false; }
}

// The mode (persisted; nothing or an unknown value: Manual), chosen in the mode menu.
function applyApplyMode(mode) {
  state.applyMode = Object.prototype.hasOwnProperty.call(APPLY_MODES, mode) ? mode : 'manual';
  const label = APPLY_MODES[state.applyMode];
  el.modeCycle.dataset.mode = state.applyMode;
  el.modeLabel.textContent = label;
  el.modeCycle.setAttribute('aria-label', `Mode: ${label}, click to choose`);
  el.modeCycle.dataset.tip = MODE_BUTTON_TITLE;
  if (modeMenu.open) renderModeMenu();
}
// Manual and Auto: the writing tools (Manual asks before each edit: turn.js sets snap.askEdits). Plan: read-only, with
// its own instructions.
const isAutoMode = () => state.applyMode === 'auto';
const isPlanMode = () => state.applyMode === 'plan';
// The turn mode of a message without a slash command, sent with applyMode (default: the mode button's): 'edit' (Manual
// and Auto) | 'plan'. The read-only chat turn 'manual' is /side's, a read agent's and a persona turn's on another provider.
const applyTurnMode = (applyMode = state.applyMode) => (applyMode === 'plan' ? 'plan' : 'edit');
// The mode a stored user message was sent with ('manual' | 'auto' | 'plan'), or null (a command turn, an older message
// without one): an editing turn that asked before each edit (_asks) and an older read-only Manual turn are Manual.
function sentApplyMode(m) {
  if (!m || m.role !== 'user') return null;
  if (m._mode === 'edit') return m._asks ? 'manual' : 'auto';
  return m._mode === 'plan' || m._mode === 'manual' ? m._mode : null;
}

async function loadApplyMode() {
  let mode = 'manual';
  try { mode = (await chrome.storage.local.get(APPLY_MODE_KEY))[APPLY_MODE_KEY] || 'manual'; } catch (e) { /* ignore */ }
  applyApplyMode(mode);
}

async function setApplyMode(mode) {
  if (state.busy || mode === state.applyMode) return;
  applyApplyMode(mode);
  try { await chrome.storage.local.set({ [APPLY_MODE_KEY]: state.applyMode }); } catch (e) { /* ignore */ }
}
// The next mode of APPLY_MODE_ORDER (ignored while an answer runs); the button opens the menu instead.
function cycleApplyMode() {
  const i = APPLY_MODE_ORDER.indexOf(state.applyMode);
  return setApplyMode(APPLY_MODE_ORDER[(i + 1) % APPLY_MODE_ORDER.length]);
}

// ---- The mode menu: a popover above the mode button, by mouse; a check marks the current mode -------------------
const modeMenu = { open: false };

function renderModeMenu() {
  const box = el.modeMenu;
  box.textContent = '';
  for (const mode of APPLY_MODE_ORDER) {
    const on = mode === state.applyMode;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'mode-row' + (on ? ' active' : '');
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', String(on));
    row.dataset.mode = mode;
    const check = document.createElement('span');
    check.className = 'mode-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = on ? '✓' : '';
    const text = document.createElement('span');
    text.className = 'mode-row-text';
    const title = document.createElement('span');
    title.className = 'mode-row-title';
    title.textContent = APPLY_MODES[mode];
    const desc = document.createElement('span');
    desc.className = 'mode-row-desc';
    desc.textContent = APPLY_MODE_DESCS[mode];
    text.append(title, desc);
    row.append(check, text);
    box.appendChild(row);
  }
  positionModeMenu();
}

// Fixed above the button (the composer clips overflow), kept inside the panel.
function positionModeMenu() {
  if (!modeMenu.open) return;
  const r = el.modeCycle.getBoundingClientRect();
  const width = Math.min(300, Math.max(200, window.innerWidth - 16));
  el.modeMenu.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - width - 8))) + 'px';
  el.modeMenu.style.width = width + 'px';
  el.modeMenu.style.bottom = Math.round(window.innerHeight - r.top + 4) + 'px';
}

function openModeMenu() {
  if (state.busy || el.modeCycle.disabled) return;
  modeMenu.open = true;
  el.modeMenu.classList.remove('hidden');
  el.modeCycle.setAttribute('aria-expanded', 'true');
  renderModeMenu();
}

function closeModeMenu() {
  if (!modeMenu.open) return;
  modeMenu.open = false;
  el.modeMenu.classList.add('hidden');
  el.modeMenu.textContent = '';
  el.modeCycle.setAttribute('aria-expanded', 'false');
}

// onChange runs after a pick changed the mode (main.js: the context gauge, since Plan offers fewer tools).
function bindModeMenu(onChange) {
  el.modeCycle.addEventListener('click', () => {
    if (el.modeCycle.disabled) return;
    if (modeMenu.open) closeModeMenu(); else openModeMenu();
  });
  el.modeMenu.addEventListener('click', async (e) => {
    const row = e.target.closest('.mode-row');
    if (!row) return;
    const before = state.applyMode;
    closeModeMenu();
    await setApplyMode(row.dataset.mode);
    if (state.applyMode !== before && onChange) onChange();
  });
  document.addEventListener('mousedown', (e) => {
    if (!modeMenu.open) return;
    if (el.modeMenu.contains(e.target) || el.modeCycle.contains(e.target)) return;
    closeModeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (modeMenu.open && e.key === 'Escape') { e.preventDefault(); closeModeMenu(); el.modeCycle.focus(); }
  });
  window.addEventListener('resize', positionModeMenu);
}

function systemTheme() {
  return SYSTEM_THEME_QUERY && SYSTEM_THEME_QUERY.matches ? 'light' : 'dark';
}

// A theme change repaints everything in one frame: the hover transitions (.15s on buttons, the splitter, the mode
// button) would otherwise lag behind the rest, so they are switched off for a moment through html.theme-switching.
// Both brand icons are preloaded once, so the swap of the PNG does not trail the colours.
const THEME_SWITCH_MS = 250;
let themeSwitchTimer = null;
const brandIcons = {};
function preloadBrandIcons() {
  if (typeof Image !== 'function') return; // the test sandbox has no Image
  for (const t of ['light', 'dark']) {
    if (brandIcons[t]) continue;
    const img = new Image();
    img.src = `icons/icon48-${t}.png`;
    brandIcons[t] = img;
  }
}
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  const root = document.documentElement;
  if (root.dataset.theme && root.dataset.theme !== t) {
    root.classList.add('theme-switching');
    clearTimeout(themeSwitchTimer);
    themeSwitchTimer = setTimeout(() => root.classList.remove('theme-switching'), THEME_SWITCH_MS);
  }
  root.dataset.theme = t;
  preloadBrandIcons();
  el.brandLogo.src = `icons/icon48-${t}.png`;
}

async function loadTheme() {
  let theme;
  try { theme = (await chrome.storage.local.get(THEME_KEY))[THEME_KEY]; } catch (e) { /* ignore */ }
  state.themeFollowsSystem = theme !== 'light' && theme !== 'dark';
  applyTheme(state.themeFollowsSystem ? systemTheme() : theme);
}

async function toggleTheme() {
  const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  state.themeFollowsSystem = false;
  applyTheme(theme);
  try { await chrome.storage.local.set({ [THEME_KEY]: theme }); } catch (e) { /* ignore */ }
}

