'use strict';
// The per-type settings shape of earlier versions, emulated over the accounts for the tests written against it:
// state.settings.provider = 'anthropic' makes the open chat run on the Anthropic account, and
// state.settings.providers.<type>.apiKey / .model read and write that type's account (created on first use, its id
// the type, like a migrated one) and the model it runs. Until a test assigns provider, the panel's own choice applies
// (chatChoice). Installed by both benches unless load({ legacySettings: false }); loadSettings() re-installs it (and
// forgets the assigned provider, so the stored choice applies). Tests of the accounts themselves use the real API.

/* global state, PROVIDERS, PROVIDER_IDS, DEFAULT_PROVIDER, chatAccount, activeConfig, chatChoice: writable, loadSettings: writable, setChatModel: writable */
// Runs inside the panel's context (its globals: state, PROVIDERS, PROVIDER_IDS, DEFAULT_PROVIDER, chatChoice, …).
function legacyShim() {
  const L = { type: null, models: {} };
  const find = (type) => state.settings.accounts.find((a) => a.type === type) || null;
  const account = (type) => {
    let a = find(type);
    if (!a) {
      a = { id: type, type, name: PROVIDERS[type].name, apiKey: '' };
      state.settings.accounts.push(a);
    }
    return a;
  };
  const realChoice = chatChoice;
  const currentType = () => { const a = chatAccount(); return a ? a.type : DEFAULT_PROVIDER; };
  const modelOf = (type) => {
    if (L.models[type]) return L.models[type];
    if (currentType() === type && chatAccount()) return activeConfig().model;
    const a = find(type);
    return (a && a.model) || PROVIDERS[type].model;
  };
  chatChoice = () => (L.type
    ? { accountId: account(L.type).id, model: L.models[L.type] || account(L.type).model || PROVIDERS[L.type].model }
    : realChoice());
  function install() {
    const s = state.settings;
    if (!Array.isArray(s.accounts)) s.accounts = [];
    Object.defineProperty(s, 'provider', {
      configurable: true, enumerable: false,
      get: currentType,
      set: (v) => { if (PROVIDERS[v]) { account(v); L.type = v; } },
    });
    const providers = {};
    for (const type of PROVIDER_IDS) {
      const p = {};
      Object.defineProperty(p, 'apiKey', { enumerable: true, get: () => (find(type) ? find(type).apiKey : ''), set: (v) => { account(type).apiKey = v; } });
      Object.defineProperty(p, 'model', { enumerable: true, get: () => modelOf(type), set: (v) => { L.models[type] = v; account(type).model = v; } });
      Object.defineProperty(p, 'baseUrl', { enumerable: false, get: () => undefined, set: () => {} });
      providers[type] = p;
    }
    Object.defineProperty(s, 'providers', { configurable: true, enumerable: false, value: providers });
  }
  // A model picked through the panel (the model menu) is the panel's own choice again.
  const realSet = setChatModel;
  setChatModel = async (...args) => { L.type = null; return realSet(...args); };
  const realLoad = loadSettings;
  loadSettings = async (...args) => { await realLoad(...args); L.type = null; L.models = {}; install(); };
  install();
}

// Installs the shim into a loaded panel (run: evaluates code in its context).
function installLegacySettings(run) {
  run(`(${legacyShim.toString()})()`);
}

module.exports = { installLegacySettings };
