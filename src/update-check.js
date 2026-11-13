'use strict';
// Module update-check.js: tells the user of an unpacked install (README → Install; Chrome never updates it) that GitHub
// has a newer version. The latest version is the version field of the repository's manifest.json (UPDATE_MANIFEST_URL:
// one GET without credentials, cache or extra headers; nothing about the user, the document or the installed version is
// sent). A version newer than the installed one shows in two places only: a dot on the gear button (class update-dot,
// its aria-label says so) and "· 1.1.4 available · Update" in the Settings version line (settings.js renderVersion).
// Store installs (update_url: Chrome updates them) run nothing. Every failure is silent.
// The record UPDATE_CHECK_KEY in chrome.storage.local, shared by every panel of the browser: { at (the time of the last
// attempt, stored before its request), ok (it read a version), version (the last version read; a failed attempt keeps
// it) }. A check is due UPDATE_CHECK_OK_MS after a successful attempt, UPDATE_CHECK_RETRY_MS after a failed one. Like the
// storage cleanup (chats.js scheduleStorageCleanup) it runs once per panel, at its start, without a timer: the stored
// version marks the panel first, then a due check asks; a record another panel stores arrives through storage.onChanged.
// Loaded after main.js (its start does not wait for this one); selftest.js runs the "Update check" row with
// checkUpdateNow.
/* global renderVersion, UPDATE_CHECK_KEY, UPDATE_MANIFEST_URL, withLock */
/* exported checkUpdateNow, compareVersions, isNewerVersion, renderUpdateMarks, runUpdateCheck, startUpdateCheck,
   updateCheckDue, updateCheckOn */

const UPDATE_CHECK_OK_MS = 24 * 3600 * 1000;
const UPDATE_CHECK_RETRY_MS = 3600 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 5000;
// 1 to 4 dot-separated numbers (Chrome's version format); parts of up to 10 digits compare exactly as Numbers.
const VERSION_RE = /^\d{1,10}(?:\.\d{1,10}){0,3}$/;

// The numbers of a version string ('1.1.10' -> [1, 1, 10]), or null when it is not one.
const parseVersion = (v) => (typeof v === 'string' && VERSION_RE.test(v) ? v.split('.').map(Number) : null);

// -1, 0 or 1 as version a is older than, equal to or newer than b, part by part (a missing part counts 0: 1.2 equals
// 1.2.0); null when either is not a version.
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
// Only a strictly newer remote version counts (an install ahead of GitHub, the owner's own, shows nothing).
const isNewerVersion = (remote, installed) => compareVersions(remote, installed) === 1;

// The installed extension's manifest, or null (no extension runtime).
function ownManifest() {
  try { return chrome.runtime.getManifest() || null; } catch (e) { return null; }
}
// An unpacked install with a readable version: a store install (update_url) is kept current by Chrome.
function updateCheckOn() {
  const m = ownManifest();
  return !!(m && !m.update_url && parseVersion(m.version));
}

const knownVersion = (rec) => (rec && parseVersion(rec.version) ? rec.version : '');
// The stored record ({} when there is none or it has another shape).
async function readUpdateRecord() {
  const rec = (await chrome.storage.local.get(UPDATE_CHECK_KEY))[UPDATE_CHECK_KEY];
  return rec && typeof rec === 'object' ? rec : {};
}
// Whether a check is due at now: no record, a record from the future (the clock was set back), or the wait after its
// attempt (a day after a success, an hour after a failure) has passed.
function updateCheckDue(rec, now = Date.now()) {
  const at = rec && rec.at;
  if (!Number.isFinite(at) || at > now) return true;
  return now - at >= (rec.ok === true ? UPDATE_CHECK_OK_MS : UPDATE_CHECK_RETRY_MS);
}
// The record's version when it is newer than the installed one, else ''.
function newerVersionOf(rec) {
  const v = knownVersion(rec);
  const m = ownManifest();
  return v && m && isNewerVersion(v, m.version) ? v : '';
}

// Both marks from a newer version ('' clears them): the Settings version line and the gear's dot with its aria-label.
function renderUpdateMarks(newer) {
  renderVersion(newer);
  const btn = document.getElementById('settingsBtn');
  if (!btn) return;
  btn.classList.toggle('update-dot', !!newer);
  btn.setAttribute('aria-label', newer ? 'Settings (update available)' : 'Settings');
}

// One GET of the repository's manifest.json: { version } or { error } (a short reason, shown by the self-test row only).
// fetch is the page's own (the test benches stub it); the request carries nothing but the URL.
async function fetchLatestVersion() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPDATE_CHECK_TIMEOUT_MS);
  const timedOut = () => `no answer within ${UPDATE_CHECK_TIMEOUT_MS / 1000} s`;
  try {
    const r = await fetch(UPDATE_MANIFEST_URL, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: ctl.signal });
    if (!r || r.status !== 200) return { error: r ? `HTTP ${r.status}` : 'no response' };
    let body;
    try { body = await r.json(); } catch (e) { return { error: ctl.signal.aborted ? timedOut() : 'the answer is not JSON' }; }
    const v = body && body.version;
    return parseVersion(v) ? { version: v } : { error: 'the answer has no version number' };
  } catch (e) {
    return { error: ctl.signal.aborted ? timedOut() : (e && e.message) || 'the request failed' };
  } finally {
    clearTimeout(timer);
  }
}

// One check when it is due. Under a Web Lock the record is read and, when due, the attempt is stored before the request
// (ok false, the last version kept), so that panels opening together ask once (the time is read inside the lock: a
// panel that waited for it must not take the other's attempt for one from the future). A version read is stored with ok
// true and marks this panel at once (the others follow from the storage change). Resolves to the stored record, or
// null when no check was due or anything failed; never rejects.
async function runUpdateCheck() {
  try {
    const due = await withLock('munin:update-check', async () => {
      const now = Date.now();
      const rec = await readUpdateRecord();
      if (!updateCheckDue(rec, now)) return null;
      const attempt = { at: now, ok: false, version: knownVersion(rec) };
      await chrome.storage.local.set({ [UPDATE_CHECK_KEY]: attempt });
      return attempt;
    });
    if (!due) return null;
    const r = await fetchLatestVersion();
    if (!r.version) return due;
    const rec = { at: due.at, ok: true, version: r.version };
    await chrome.storage.local.set({ [UPDATE_CHECK_KEY]: rec });
    renderUpdateMarks(newerVersionOf(rec));
    return rec;
  } catch (e) {
    return null;
  }
}

// Other panels' results: the marks follow every change of the record (a removed record clears them).
function watchUpdateRecord() {
  const ev = chrome.storage && chrome.storage.onChanged;
  if (!ev || typeof ev.addListener !== 'function') return;
  ev.addListener((changes, area) => {
    if (area !== 'local' || !changes || !changes[UPDATE_CHECK_KEY]) return;
    try { renderUpdateMarks(newerVersionOf(changes[UPDATE_CHECK_KEY].newValue)); } catch (e) { /* silent */ }
  });
}

// The panel's start (called below, once): the stored version marks the panel before any request, then a due check runs.
// Off for a store install. Returns the promise of the whole start (tests wait for it); it never rejects.
let updateCheckStarted = false;
function startUpdateCheck() {
  if (updateCheckStarted || !updateCheckOn()) return Promise.resolve(null);
  updateCheckStarted = true;
  return (async () => {
    watchUpdateRecord();
    renderUpdateMarks(newerVersionOf(await readUpdateRecord()));
    return runUpdateCheck();
  })().catch(() => null);
}

// The self-test's "Update check" row: the request now, whatever the throttle says. A version read is stored as a due
// check stores it (the marks follow); a failure changes nothing. { version | error, installed }.
async function checkUpdateNow() {
  const installed = (ownManifest() || {}).version || '?';
  const at = Date.now();
  const r = await fetchLatestVersion();
  if (r.version) {
    const rec = { at, ok: true, version: r.version };
    try {
      await chrome.storage.local.set({ [UPDATE_CHECK_KEY]: rec });
      renderUpdateMarks(newerVersionOf(rec));
    } catch (e) { /* the row still reports what was read */ }
  }
  return { ...r, installed };
}

startUpdateCheck();
