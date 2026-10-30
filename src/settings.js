'use strict';
// Module settings.js: per-provider settings (defaultSettings, loadSettings, the settings form that applies every
// change at once, model list, checkModels with the key check, closeSettings on a click outside), the mode button and its menu (applyApplyMode, setApplyMode, cycleApplyMode, the mode menu: openModeMenu, closeModeMenu, bindModeMenu; isAutoMode, isPlanMode, applyTurnMode) and the theme
// (applyTheme, loadTheme, toggleTheme). state.settings.references caches the References grant (references.js), loaded here.
/* global addError, addNotice, ANTHROPIC_VERSION, apiError, APPLY_MODE_DESCS, APPLY_MODE_KEY, APPLY_MODE_ORDER, APPLY_MODES, closeInstructions,
   DEFAULT_PROVIDER, el, GOOGLE_ACCOUNT_KEY, GOOGLE_CONNECTED_KEY, KEY_CHECK_DEBOUNCE_MS, modelsKey,
   PROVIDER_IDS, PROVIDER_STORAGE_KEY, PROVIDERS, REFERENCES_KEY, REFERENCES_ORIGINS, renderEmpty, renderGoogleStatus, sanitizeGoogleAccount,
   MODE_BUTTON_TITLE, SETTING_FIELDS, STALE_SETTING_KEYS, state, storageKey, SYSTEM_THEME_QUERY, THEME_KEY */
/* exported defaultSettings, activeProvider, activeConfig, loadSettings, onApiKeyInput, onApiKeyBlur, onModelChange,
   checkModels, openSettings, closeSettings, switchSettingsProvider, saveSettings, loadApplyMode, setApplyMode, cycleApplyMode, bindModeMenu, closeModeMenu, isAutoMode, isPlanMode, applyTurnMode, systemTheme,
   applyTheme, loadTheme, toggleTheme */

// ---------------------------------------------------------------------------
// Settings (per provider; the active provider answers all messages). Every endpoint is fixed
// (PROVIDERS[*].baseUrl), so the settings hold the API key and the model only.
// ---------------------------------------------------------------------------
function defaultProviderSettings(id) {
  const p = PROVIDERS[id];
  return { apiKey: '', model: p.model };
}

function defaultSettings() {
  const providers = {};
  for (const id of PROVIDER_IDS) providers[id] = defaultProviderSettings(id);
  return { provider: DEFAULT_PROVIDER, providers, references: false };
}

const activeProvider = () => PROVIDERS[state.settings.provider] || PROVIDERS[DEFAULT_PROVIDER];
const activeConfig = () => state.settings.providers[activeProvider().id];

// Fills defaults for one provider's settings (from storage or from the form).
function sanitizeProviderSettings(id, s) {
  const p = PROVIDERS[id];
  return {
    apiKey: String(s.apiKey || '').trim(),
    model: String(s.model || '').trim() || p.model,
  };
}

const sanitizeModelList = (v) => (Array.isArray(v) ? v.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()) : []);

// Storage keys of removed settings (STALE_SETTING_KEYS: Confirm edits, the document mode, the Google client ID,
// the Base URLs, the Effort)
// are deleted silently: their values are ignored anyway.
async function removeStaleSettings() {
  try { await chrome.storage.local.remove(STALE_SETTING_KEYS); } catch (e) { /* ignore */ }
}

async function loadSettings() {
  const s = defaultSettings();
  const lists = {};
  await removeStaleSettings();
  try {
    const keys = [PROVIDER_STORAGE_KEY, GOOGLE_CONNECTED_KEY, GOOGLE_ACCOUNT_KEY, REFERENCES_KEY];
    for (const id of PROVIDER_IDS) {
      for (const f of SETTING_FIELDS) keys.push(storageKey(id, f));
      keys.push(modelsKey(id));
    }
    const got = await chrome.storage.local.get(keys);
    if (PROVIDER_IDS.includes(got[PROVIDER_STORAGE_KEY])) s.provider = got[PROVIDER_STORAGE_KEY];
    state.googleConnected = got[GOOGLE_CONNECTED_KEY] === true;
    state.googleAccount = sanitizeGoogleAccount(got[GOOGLE_ACCOUNT_KEY]);
    s.references = got[REFERENCES_KEY] === true && await referencesPermitted();
    for (const id of PROVIDER_IDS) {
      const raw = { ...s.providers[id] };
      for (const f of SETTING_FIELDS) {
        const v = got[storageKey(id, f)];
        if (v !== undefined && v !== null) raw[f] = v;
      }
      s.providers[id] = sanitizeProviderSettings(id, raw);
      lists[id] = sanitizeModelList(got[modelsKey(id)]);
    }
  } catch (e) { /* defaults */ }
  state.settings = s;
  state.modelLists = lists;
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

// One GET of a model list page. Returns the parsed JSON or throws a readable Error.
async function getModelsPage(url, headers, p, cfg) {
  let resp;
  try {
    resp = await fetch(url, { headers });
  } catch (e) {
    throw new Error(`Could not reach ${url} (${e.message}). Check your connection.`);
  }
  if (!resp.ok) throw await apiError(resp, { prov: p, cfg });
  try { return await resp.json(); } catch (e) { throw new Error('The server did not return a valid model list.'); }
}

// Model IDs offered by the provider: GET {baseUrl}/models (OpenAI-compatible list: {data: [{id}]};
// a bare array or {models: [...]} is accepted too; Anthropic: all pages). Returns the IDs without
// duplicates, in server order (OpenAI: filtered and sorted by openaiChatModels; the full list is kept
// if nothing passes the filter).
async function fetchModelList(id, cfg) {
  const p = PROVIDERS[id];
  const base = p.baseUrl;
  const headers = id === 'anthropic'
    ? { 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' }
    : { Authorization: `Bearer ${cfg.apiKey}` };
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
  }
  if (!ids.length) throw new Error('The server returned no models.');
  if (id === 'openai') { const chat = openaiChatModels(ids); if (chat.length) return chat; }
  return ids;
}
// checkModels: the fetched list becomes the cached one (state and storage).
async function fetchAndCacheModels(id, cfg) {
  const ids = await fetchModelList(id, cfg);
  state.modelLists[id] = ids;
  try { await chrome.storage.local.set({ [modelsKey(id)]: ids }); } catch (e) { /* ignore */ }
  return ids;
}

// The form shows the stored settings of one provider and applies every change at once: the provider on change,
// the API key after a typing pause (KEY_CHECK_DEBOUNCE_MS) or on leaving the field, the model on change.
// Fields per provider: API key; Model as a dropdown filled from GET /models (button "Check models").
const settingsForm = { provider: null, checking: false, pending: null, keyTimer: 0 };

function readSettingsForm() {
  return {
    apiKey: el.apiKey.value,
    model: el.modelSelect.value || state.settings.providers[settingsForm.provider].model,
  };
}

// Stores the form's fields as the settings of the provider it shows (sanitized): in state at once, then in
// storage. Resolves to them.
async function persistProviderForm() {
  const id = settingsForm.provider;
  if (!id) return null;
  const s = sanitizeProviderSettings(id, { ...state.settings.providers[id], ...readSettingsForm() });
  state.settings.providers[id] = s;
  const toStore = {};
  for (const f of SETTING_FIELDS) toStore[storageKey(id, f)] = s[f];
  try { await chrome.storage.local.set(toStore); } catch (e) { /* ignore */ }
  return s;
}

// The dropdown offers the models the API listed (plus the saved model, so it stays selectable even
// if the list changed). Until a list was loaded, which needs the API key, it is empty and disabled.
function renderModelOptions(id, selected) {
  const ids = (state.modelLists[id] || []).slice();
  el.modelSelect.textContent = '';
  if (!ids.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '—';
    o.disabled = true;
    o.selected = true;
    el.modelSelect.appendChild(o);
    el.modelSelect.value = '';
    el.modelSelect.disabled = true;
    return;
  }
  if (selected && !ids.includes(selected)) ids.unshift(selected);
  for (const m of ids) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m;
    el.modelSelect.appendChild(o);
  }
  el.modelSelect.disabled = false;
  el.modelSelect.value = selected && ids.includes(selected) ? selected : ids[0];
}

function setModelStatus(text, warn) {
  el.modelStatus.textContent = text || '';
  el.modelStatus.classList.toggle('warn', !!warn);
  el.modelStatus.classList.toggle('hidden', !text);
}

function fillSettingsForm(id) {
  const p = PROVIDERS[id];
  const s = state.settings.providers[id];
  settingsForm.provider = id;
  el.provider.value = id;
  el.apiKeyLabel.textContent = `${p.label} API key`;
  el.apiKey.placeholder = p.keyPrefix ? p.keyPrefix + '...' : 'API key';
  el.apiKey.value = s.apiKey || '';
  // The model list is requested only after a key was entered (or on "Check models"), never on opening.
  renderModelOptions(id, s.model || p.model);
  setModelStatus('');
  updateKeyWarning();
}

// Typing or pasting an API key stores it shortly after the last edit (or when the field is left) and then
// checks it: the model list is fetched, selecting the provider's default model if it is offered, otherwise
// the first of the list (a new key is a fresh start).
function onApiKeyInput() {
  updateKeyWarning();
  if (!settingsForm.provider) return;
  clearTimeout(settingsForm.keyTimer);
  settingsForm.keyTimer = setTimeout(commitApiKey, KEY_CHECK_DEBOUNCE_MS);
}
// Leaving the field stores a key that is still waiting for the typing pause.
function onApiKeyBlur() {
  if (settingsForm.keyTimer) return commitApiKey();
  return null;
}
async function commitApiKey() {
  clearTimeout(settingsForm.keyTimer);
  settingsForm.keyTimer = 0;
  const s = await persistProviderForm();
  if (!s) return;
  if (s.apiKey) await checkModels({ selectFirst: true, verify: true });
  else setModelStatus('');
}
// A model picked in the dropdown is stored at once.
function onModelChange() { return persistProviderForm(); }

// Asks the provider for its model list with the key currently in the form, caches it and refreshes the
// dropdown ("Check models" button, key edits). The current choice is kept when it is still offered;
// with selectFirst (key edits) the default model is chosen if offered, else the first of the list;
// a choice that is no longer offered falls back to the first model.
// The chosen model is stored. verify (key edits): the status says the key works, the stale "fix your settings"
// errors leave the chat; with the settings closed meanwhile, the result goes to the chat instead.
// A check requested while one is running is run afterwards (the key may have changed meanwhile).
async function checkModels(opts = {}) {
  if (!settingsForm.provider) return;
  if (settingsForm.checking) { settingsForm.pending = opts; return; }
  const id = settingsForm.provider;
  const p = PROVIDERS[id];
  const cfg = sanitizeProviderSettings(id, { ...state.settings.providers[id], ...readSettingsForm() });
  if (!cfg.apiKey) { setModelStatus('Enter the API key first.', true); return; }
  settingsForm.checking = true;
  el.checkModels.disabled = true;
  setModelStatus('Checking the available models…');
  try {
    const ids = await fetchAndCacheModels(id, cfg);
    if (opts.verify) clearSettingsErrors();
    if (settingsForm.provider === id) { // the user may have switched the provider meanwhile
      const current = el.modelSelect.value;
      const chosen = opts.selectFirst ? (ids.includes(p.model) ? p.model : ids[0]) : (ids.includes(current) ? current : ids[0]);
      renderModelOptions(id, chosen);
      await persistProviderForm();
      const dropped = !opts.selectFirst && !!current && chosen !== current;
      setModelStatus((opts.verify ? `Connected to ${p.label}: the key works. ` : '') +
        `${ids.length} model${ids.length === 1 ? '' : 's'} available; ${chosen} is selected.` +
        (dropped ? ` ("${current}" is not offered any more.)` : ''), dropped);
    }
    if (opts.verify && el.settings.classList.contains('hidden')) addNotice(`Connected to ${p.label}: the key works.`);
  } catch (e) {
    if (settingsForm.provider === id) setModelStatus('Could not get the model list: ' + e.message, true);
    if (opts.verify && el.settings.classList.contains('hidden')) {
      if (e.status === 401 || e.status === 403) addError(e.message, true);
      else addNotice(`Could not check the ${p.label} key: ${e.message}`, { sticky: true });
    }
  } finally {
    settingsForm.checking = false;
    el.checkModels.disabled = false;
    if (settingsForm.pending) { const next = settingsForm.pending; settingsForm.pending = null; checkModels(next); }
  }
}

function updateKeyWarning() {
  const p = PROVIDERS[settingsForm.provider || state.settings.provider] || PROVIDERS[DEFAULT_PROVIDER];
  const k = el.apiKey.value.trim();
  el.keyWarn.textContent = `This key does not start with "${p.keyPrefix}". It will still be saved, but it may be rejected by the server.`;
  el.keyWarn.classList.toggle('hidden', !k || k.startsWith(p.keyPrefix));
}

function openSettings() {
  closeInstructions();
  fillSettingsForm(state.settings.provider);
  renderGoogleStatus();
  el.settings.classList.remove('hidden');
  el.apiKey.focus();
}

// Closing (gear button, a click outside the section) first stores a key still waiting for the typing pause;
// its check then reports in the chat.
function closeSettings() {
  if (settingsForm.keyTimer) commitApiKey();
  el.settings.classList.add('hidden');
}

// Another provider in the dropdown becomes the active one at once; the form shows its key and model.
async function switchSettingsProvider(id) {
  if (!PROVIDERS[id] || id === settingsForm.provider) return;
  clearTimeout(settingsForm.keyTimer);
  settingsForm.keyTimer = 0;
  const kept = persistProviderForm(); // the key typed for the previous provider is kept
  state.settings.provider = id;
  fillSettingsForm(id);
  await kept;
  try { await chrome.storage.local.set({ [PROVIDER_STORAGE_KEY]: id }); } catch (e) { /* ignore */ }
}

// Stores what the open form shows right now (the panel is unloaded, a test); no key check.
async function saveSettings() {
  if (!settingsForm.provider || (el.settings.classList.contains('hidden') && !settingsForm.keyTimer)) return;
  clearTimeout(settingsForm.keyTimer);
  settingsForm.keyTimer = 0;
  await persistProviderForm();
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
  el.modeCycle.title = MODE_BUTTON_TITLE;
  if (modeMenu.open) renderModeMenu();
}
// Edit automatically: the writing tools. Plan: read-only like Manual, with its own instructions.
const isAutoMode = () => state.applyMode === 'auto';
const isPlanMode = () => state.applyMode === 'plan';
// The turn mode of a message without a slash command: 'edit' | 'plan' | 'manual'.
const applyTurnMode = () => (isAutoMode() ? 'edit' : isPlanMode() ? 'plan' : 'manual');

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

// onChange runs after a pick changed the mode (main.js: the context gauge, since Manual and Plan offer fewer tools).
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

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
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

