'use strict';
// Module google-auth.js: Sign in with Google (the built-in OAuth client GOOGLE_CLIENT_ID; tokens: getDocsToken
// over chrome.identity.launchWebAuthFlow; connectGoogle, switchGoogleAccount, disconnectGoogle,
// renderGoogleStatus) and the Docs API fetch wrapper (docsApi, docsApiError, resetDocsApiTurn).
/* global addNotice, DOCS_API_URL, DOCS_SCOPE, el, GOOGLE_ACCOUNT_KEY, GOOGLE_AUTH_URL, GOOGLE_CLIENT_ID,
   GOOGLE_CONNECTED_KEY, GOOGLE_REVOKE_URL, GOOGLE_SIGNIN_SCOPES, GOOGLE_TOKEN_KEY, state, USERINFO_URL */
/* exported sanitizeGoogleAccount, renderGoogleStatus, connectGoogle, switchGoogleAccount, disconnectGoogle, docsApi,
   resetDocsApiTurn */

// ---------------------------------------------------------------------------
// Google account (chrome.identity) and the Google Docs API
// ---------------------------------------------------------------------------
// One OAuth client per deployment: GOOGLE_CLIENT_ID, a "Web application" client whose authorized redirect
// URI is https://<extension id>.chromiumapp.org/ (the manifest "key" keeps the ID stable). Sign in runs the
// implicit flow in chrome.identity.launchWebAuthFlow with Google's account chooser; the panel keeps the token
// with its expiry in memory and in chrome.storage.session (GOOGLE_TOKEN_KEY), renews it silently
// (prompt=none) when it expires, stores the account's email and name (GOOGLE_ACCOUNT_KEY) to show them, and
// the flag GOOGLE_CONNECTED_KEY so that it reads the document through the API on the next messages.
const NO_CLIENT_ID_TEXT = 'This build has no Google client ID. See the README, section Google account.';
const SCOPE_NOT_GRANTED = 'Google Docs access was not granted. Sign in again and allow access to your documents.';

// The redirect URI Chrome intercepts for launchWebAuthFlow.
function redirectUri() {
  try { if (chrome.identity && chrome.identity.getRedirectURL) return chrome.identity.getRedirectURL(); } catch (e) { /* below */ }
  let id = '';
  try { id = chrome.runtime.id || ''; } catch (e) { /* ignore */ }
  return `https://${id || '<extension-id>'}.chromiumapp.org/`;
}

// The authorization URL: interactive asks the user to pick the account (prompt=select_account), the silent
// renewal must not show anything (prompt=none) and names the signed-in account (login_hint), so that several
// Google sessions in the browser do not renew with another account.
function webAuthUrl(interactive, loginHint) {
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, response_type: 'token', redirect_uri: redirectUri(), scope: GOOGLE_SIGNIN_SCOPES.join(' '),
    prompt: interactive ? 'select_account' : 'none',
  });
  if (!interactive && loginHint) q.set('login_hint', loginHint);
  return `${GOOGLE_AUTH_URL}?${q}`;
}

// Google's error codes in the redirect, as readable advice.
function webAuthError(code, description) {
  const said = description ? ` Google: ${description}` : '';
  if (code === 'access_denied') {
    return new Error(`Google refused the sign-in (access_denied). If the app is in Testing, ask whoever deployed it to add this account under Test users; otherwise allow access in the Google window.${said}`);
  }
  if (/^(interaction_required|login_required|consent_required|account_selection_required)$/.test(code)) {
    return new Error(`Google needs you to sign in again (${code}).${said}`);
  }
  return new Error(`Google sign-in failed (${code}).${said}`);
}

// Parses the redirect URL of the implicit flow: #access_token=…&expires_in=…&scope=… (or #error=…).
// Returns { token, expiresAt, clientId }; throws on an error, a missing token or the documents scope not granted.
function parseWebAuthRedirect(url) {
  let u;
  try { u = new URL(url); } catch (e) { throw new Error('Google returned no valid redirect.'); }
  const f = new URLSearchParams((u.hash || '').replace(/^#/, ''));
  const q = u.searchParams; // errors may come in the query instead of the fragment
  const code = f.get('error') || q.get('error');
  if (code) throw webAuthError(code, f.get('error_description') || q.get('error_description') || '');
  const token = f.get('access_token');
  if (!token) throw new Error('Google returned no access token.');
  // the consent screen lets the user untick the documents scope
  const scope = f.get('scope');
  if (scope != null && !scope.split(/\s+/).includes(DOCS_SCOPE)) throw new Error(SCOPE_NOT_GRANTED);
  const secs = parseInt(f.get('expires_in'), 10);
  // renewed a minute early, so that a call never starts with a token about to expire
  const life = (Number.isFinite(secs) && secs > 0 ? secs : 3600) - 60;
  return { token, expiresAt: Date.now() + Math.max(life, 0) * 1000, clientId: GOOGLE_CLIENT_ID };
}

let webToken = null; // { token, expiresAt, clientId }, mirrored in chrome.storage.session

async function storedWebToken() {
  if (webToken) return webToken;
  try {
    const got = await chrome.storage.session.get(GOOGLE_TOKEN_KEY);
    const t = got && got[GOOGLE_TOKEN_KEY];
    if (t && typeof t.token === 'string' && typeof t.expiresAt === 'number') webToken = t;
  } catch (e) { /* no session storage */ }
  return webToken;
}

async function setWebToken(t) {
  webToken = t;
  try {
    if (t) await chrome.storage.session.set({ [GOOGLE_TOKEN_KEY]: t });
    else await chrome.storage.session.remove(GOOGLE_TOKEN_KEY);
  } catch (e) { /* memory only */ }
}

// One run of the implicit flow (interactive: the account chooser; else silent with the stored account as
// login_hint). Returns the parsed token without storing it, so that a failed or cancelled sign-in leaves
// the current one in place.
async function runWebAuthFlow(interactive) {
  if (!GOOGLE_CLIENT_ID) throw new Error(NO_CLIENT_ID_TEXT);
  if (!chrome.identity || !chrome.identity.launchWebAuthFlow) throw new Error('chrome.identity is unavailable (the "identity" permission is missing).');
  const hint = state.googleAccount && state.googleAccount.email;
  const details = { url: webAuthUrl(interactive, hint), interactive: !!interactive };
  // Google answers prompt=none with a redirect; give its page a moment instead of aborting on the first load.
  if (!interactive) Object.assign(details, { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10000 });
  const url = await chrome.identity.launchWebAuthFlow(details);
  if (!url) throw new Error('Google returned no redirect.');
  return parseWebAuthRedirect(url);
}

// The token for a Docs API call (never interactive): the stored one while it is valid, else a silent renewal.
// A token of another client (an earlier build, the removed client-ID setting) is not used.
async function getDocsToken() {
  const t = await storedWebToken();
  if (t && t.clientId === GOOGLE_CLIENT_ID && t.expiresAt > Date.now()) return t.token;
  const fresh = await runWebAuthFlow(false);
  await setWebToken(fresh);
  return fresh.token;
}

// The signed-in account as stored: { email, name? } or null.
function sanitizeGoogleAccount(v) {
  if (!v || typeof v !== 'object' || typeof v.email !== 'string' || !v.email.trim()) return null;
  const acc = { email: v.email.trim() };
  if (typeof v.name === 'string' && v.name.trim()) acc.name = v.name.trim();
  return acc;
}

// The account behind a token (OpenID Connect userinfo), or null when the request fails: the token works
// without it, the status then shows no email.
async function fetchGoogleAccount(token) {
  try {
    const resp = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp || !resp.ok) return null;
    return sanitizeGoogleAccount(await resp.json());
  } catch (e) { return null; }
}

async function storeGoogleAccount(acc) {
  state.googleAccount = acc;
  try {
    if (acc) await chrome.storage.local.set({ [GOOGLE_ACCOUNT_KEY]: acc });
    else await chrome.storage.local.remove(GOOGLE_ACCOUNT_KEY);
  } catch (e) { /* ignore */ }
}

// --- the settings form: the "Google account" label (its tooltip names the account), buttons, hint ---
function renderGoogleStatus(hint, warn) {
  const on = state.googleConnected;
  const acc = on ? state.googleAccount : null;
  el.googleStatus.title = on ? (acc ? `Signed in as ${acc.email}` : 'Signed in') : 'Not signed in';
  el.googleStatus.classList.toggle('on', on);
  el.googleConnect.classList.toggle('hidden', on);
  el.googleSwitch.classList.toggle('hidden', !on);
  el.googleDisconnect.classList.toggle('hidden', !on);
  const text = hint != null ? hint : '';
  el.googleHint.textContent = text;
  el.googleHint.classList.toggle('warn', !!warn);
  el.googleHint.classList.toggle('hidden', !text);
}

async function setGoogleConnected(on) {
  state.googleConnected = on;
  state.docsApiFailed = false; // a new connection (or none) is a fresh start
  if (!on) { state.docModel = null; state.apiWarned = false; }
  try { await chrome.storage.local.set({ [GOOGLE_CONNECTED_KEY]: on }); } catch (e) { /* ignore */ }
}

const setGoogleButtonsDisabled = (off) => { for (const b of [el.googleConnect, el.googleSwitch, el.googleDisconnect]) b.disabled = off; };

// Sign in with Google (and Switch account: the same account chooser). The token and the account are
// replaced only after a successful sign-in; a closed window or an error keeps the current ones.
async function signInGoogle(switching) {
  if (!GOOGLE_CLIENT_ID) {
    renderGoogleStatus(NO_CLIENT_ID_TEXT, true);
    return false;
  }
  setGoogleButtonsDisabled(true);
  renderGoogleStatus('Waiting for the Google sign-in window…');
  let t, acc;
  try {
    t = await runWebAuthFlow(true);
    acc = await fetchGoogleAccount(t.token);
  } catch (e) {
    renderGoogleStatus(`${switching ? 'Could not switch the account' : 'Could not sign in'}: ${e.message || e}`, true);
    return false;
  } finally {
    setGoogleButtonsDisabled(false);
  }
  await setWebToken(t);
  await storeGoogleAccount(acc);
  await setGoogleConnected(true);
  renderGoogleStatus();
  addNotice(`Signed in with Google${acc ? ` as ${acc.email}` : ''}: from the next message the document is read and edited through the Google Docs API.`);
  return true;
}

const connectGoogle = () => signInGoogle(false);
const switchGoogleAccount = () => signInGoogle(true);

async function revokeToken(token) {
  try {
    await fetch(GOOGLE_REVOKE_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'token=' + encodeURIComponent(token) });
  } catch (e) { /* the token expires anyway */ }
}

// Settings → Google account → Sign out: revokes the stored token (best effort) and forgets it and the account.
async function disconnectGoogle() {
  const t = await storedWebToken();
  if (t) { await revokeToken(t.token); await setWebToken(null); }
  await storeGoogleAccount(null);
  await setGoogleConnected(false);
  renderGoogleStatus();
  addNotice('Signed out of Google: the document is read through the export again.');
}

// HTTP 403 of the Docs API by cause, told apart by the server's message and error reasons: the token
// lacks the documents scope, the Docs API is not enabled in the Cloud project, or the account has no
// access to this document. Returns the advice text.
function docs403Advice(serverMsg, reasons) {
  const text = `${serverMsg} ${reasons.join(' ')}`;
  if (/insufficient.{0,30}scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(text)) {
    return 'the Google authorization lacks access to Google Docs (the documents scope). Open Settings → Google account, click Sign out, then Sign in with Google and allow access to your documents.';
  }
  if (/has not been used in project|is disabled|not been enabled|SERVICE_DISABLED|accessNotConfigured|API_DISABLED/i.test(text)) {
    return 'the Google Docs API is not enabled in the Google Cloud project of the OAuth client. Enable it in the Google Cloud console (APIs & Services → Library → Google Docs API), wait a few minutes and try again.';
  }
  if (/caller does not have permission|permission denied|PERMISSION_DENIED|forbidden/i.test(text)) {
    return 'the connected Google account has no access to this document, or may only view it when the request edits it. Open the document with the account connected in the settings, or ask the owner for edit access.';
  }
  return 'the Google Docs API may not be enabled in your Google Cloud project, the consent may lack the documents scope, or this account cannot edit the document.';
}

// Readable error for a failed Docs API response; err.status keeps the HTTP status. (A write refused by
// writeControl.requiredRevisionId is a 400 too; commitEdit tells it apart by re-reading the revision.)
async function docsApiError(resp) {
  let body = '';
  let j = null;
  try { body = await resp.text(); } catch (e) { /* ignore */ }
  try { j = JSON.parse(body); } catch (e) { /* not JSON */ }
  const serverMsg = (j && j.error && (j.error.message || j.error.status)) || body.slice(0, 200);
  const server = serverMsg ? ` Google: ${serverMsg}` : '';
  const e0 = (j && j.error && typeof j.error === 'object') ? j.error : {};
  const reasons = [e0.status, ...(Array.isArray(e0.details) ? e0.details : []).map((d) => d && d.reason),
    ...(Array.isArray(e0.errors) ? e0.errors : []).map((d) => d && d.reason)].filter((r) => typeof r === 'string');
  let msg;
  if (resp.status === 401) msg = 'The Google authorization expired or was revoked (HTTP 401). Open Settings → Google account → Sign in with Google.';
  else if (resp.status === 403) msg = `Google denied access (HTTP 403): ${docs403Advice(serverMsg || '', reasons)}${server}`;
  else if (resp.status === 404) msg = 'The Docs API cannot find this document (HTTP 404): the connected Google account probably has no access to it (is it the account you use in this tab?).';
  else if (resp.status === 429) msg = 'Too many requests to the Google Docs API (HTTP 429). Wait a minute and try again.';
  else msg = `Google Docs API error ${resp.status}${serverMsg ? ': ' + serverMsg : ''}`;
  const err = new Error(msg);
  err.status = resp.status;
  err.serverMessage = serverMsg || '';
  return err;
}

// A turn whose document read through the Docs API failed (fetchDocText fell back to the export) sets
// state.docsApiFailed: the API is then not called again until the next turn starts (resetDocsApiTurn),
// neither by the tools nor by an Undo click on that state.
function resetDocsApiTurn() {
  state.docsApiFailed = false;
}

// Calls the Docs API with the stored token (never interactive; an expired token is renewed silently).
// On 401 the token is dropped and the call is retried once with a fresh one. Returns the parsed JSON. Errors carry
// preSend (nothing was sent: no token, or the API failed earlier in this turn) or network (fetch failed:
// a write may or may not have arrived).
async function docsApi(path, { method = 'GET', body } = {}) {
  if (state.docsApiFailed) {
    const err = new Error('the Google Docs API failed for this message, so it is not called again now; it is tried again with the next message.');
    err.preSend = true;
    throw err;
  }
  let token;
  try { token = await getDocsToken(); } catch (e) {
    const err = new Error(`the Google account is not signed in or the authorization expired (${e.message || e}). Open Settings → Google account → Sign in with Google.`);
    err.preSend = true;
    throw err;
  }
  for (let attempt = 0; ; attempt++) {
    const init = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let resp;
    try { resp = await fetch(DOCS_API_URL + path, init); } catch (e) {
      const err = new Error(`could not reach the Google Docs API (${e.message}).`);
      err.network = true;
      throw err;
    }
    if (resp.status === 401 && attempt === 0) {
      await setWebToken(null); // refused: renew silently once
      try { token = await getDocsToken(); } catch (e) { throw await docsApiError(resp); }
      continue;
    }
    if (!resp.ok) throw await docsApiError(resp);
    return resp.json();
  }
}
