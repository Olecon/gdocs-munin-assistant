'use strict';
// Sign in with Google: a build without a client ID, chrome.identity.launchWebAuthFlow (the URL, the scopes,
// the token from the redirect fragment, chrome.storage.session), the account from the userinfo endpoint,
// the Docs API with the bearer token, silent renewal (expiry, HTTP 401, login_hint), the scope check,
// Google's errors, Switch account and Sign out.
const { test } = require('node:test');
const assert = require('node:assert');
const { deq, load, installIdentity, TEST_CLIENT_ID } = require('./lib/sandbox');

const CLIENT = TEST_CLIENT_ID;
const DOCS = 'https://www.googleapis.com/auth/documents';
const SCOPES = `${DOCS} openid email profile`;
const REDIRECT = 'https://testextid.chromiumapp.org/';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

// A panel with a launchWebAuthFlow stub: flows logs { url (parsed), params, interactive, details };
// reply(flow) returns the redirect URL (default: a token tok-<n> for one hour with the sign-in scopes).
// b.accounts maps a token to its userinfo answer (default: ann@example.com; null: HTTP 500).
async function bench({ googleClientId = CLIENT } = {}) {
  const env = await load({ googleClientId });
  const { T, state, chrome, ctx, storage, session } = env;
  const ident = installIdentity(env);
  const b = { env, T, state, chrome, ctx, storage, session, ident, flows: [], fetches: [], userinfo: [], revoked: [], accounts: {} };
  b.reply = () => `${REDIRECT}#access_token=tok-${b.flows.length}&token_type=Bearer&expires_in=3599&scope=${encodeURIComponent(SCOPES)}`;
  chrome.identity.launchWebAuthFlow = async (details) => {
    const u = new URL(details.url);
    const flow = { url: u, params: Object.fromEntries(u.searchParams), interactive: details.interactive, details };
    b.flows.push(flow);
    return b.reply(flow);
  };
  // the Docs API: status per token (default 200); the revoke endpoint and the userinfo calls logged
  b.status = {};
  ctx.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/revoke')) { b.revoked.push(init.body); return { ok: true, status: 200 }; }
    const auth = init.headers && init.headers.Authorization;
    if (url === USERINFO) {
      b.userinfo.push(auth);
      const acc = auth.slice(7) in b.accounts ? b.accounts[auth.slice(7)] : { sub: '1', email: 'ann@example.com', name: 'Ann Example', picture: 'x' };
      return acc ? { ok: true, status: 200, json: async () => acc } : { ok: false, status: 500, json: async () => ({}) };
    }
    b.fetches.push(auth);
    const st = b.status[auth] || 200;
    return { ok: st === 200, status: st, json: async () => ({ documentId: 'DOC123' }), text: async () => JSON.stringify({ error: { message: 'Invalid Credentials' } }) };
  };
  T.openSettings();
  return b;
}

const shown = (e) => !e.classList.contains('hidden');

test('a build without a client ID: Sign in says so and does nothing else; not signed in, the export path stays', async () => {
  const b = await bench({ googleClientId: '' });
  const { T, state } = b;
  assert.strictEqual(T.GOOGLE_CLIENT_ID, '');
  assert.strictEqual(T.el.googleStatus.title, 'Not signed in');
  assert.strictEqual(await T.connectGoogle(), false);
  deq(b.flows, []); deq(b.fetches, []); deq(b.userinfo, []);
  assert.strictEqual(T.el.googleHint.textContent, 'This build has no Google client ID. See the README, section Google account.');
  assert.ok(shown(T.el.googleHint) && T.el.googleHint.classList.contains('warn'));
  assert.strictEqual(state.googleConnected, false);
  assert.ok(shown(T.el.googleConnect) && !shown(T.el.googleSwitch) && !shown(T.el.googleDisconnect));
  // a Docs API call has no token: nothing sent, the reason named
  await assert.rejects(() => T.docsApi('DOC123'), (e) => e.preSend === true && /This build has no Google client ID/.test(e.message));
  deq(b.fetches, []);
});

test('Sign in with Google: the account chooser with the sign-in scopes, the token in session storage, the account from userinfo; the Docs API uses the token', async () => {
  const b = await bench();
  const { T, state, storage, session } = b;
  const t0 = Date.now();
  assert.strictEqual(await T.connectGoogle(), true);
  assert.strictEqual(b.flows.length, 1);
  const f = b.flows[0];
  assert.strictEqual(f.interactive, true);
  assert.strictEqual(f.url.origin + f.url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  deq(f.params, { client_id: CLIENT, response_type: 'token', redirect_uri: REDIRECT, scope: SCOPES, prompt: 'select_account' });
  const st = session.muninGoogleToken;
  assert.strictEqual(st.token, 'tok-1'); assert.strictEqual(st.clientId, CLIENT);
  assert.ok(st.expiresAt >= t0 + 3539 * 1000 && st.expiresAt <= Date.now() + 3539 * 1000);
  // the account: the userinfo endpoint with the new token; email and name kept, nothing else
  deq(b.userinfo, ['Bearer tok-1']);
  deq(storage.muninGoogleAccount, { email: 'ann@example.com', name: 'Ann Example' });
  deq(state.googleAccount, { email: 'ann@example.com', name: 'Ann Example' });
  assert.strictEqual(state.googleConnected, true); assert.strictEqual(storage.muninGoogleConnected, true);
  assert.strictEqual(T.el.googleStatus.title, 'Signed in as ann@example.com');
  assert.ok(!shown(T.el.googleConnect) && shown(T.el.googleSwitch) && shown(T.el.googleDisconnect));
  assert.ok(T.el.chat.children.some((c) => /Signed in with Google as ann@example\.com/.test(c.innerHTML)));
  // a Docs API call: the bearer token, no new flow
  await T.docsApi('DOC123');
  deq(b.fetches, ['Bearer tok-1']); assert.strictEqual(b.flows.length, 1);
  // loadSettings reads the account back; a stored value without an email is ignored
  state.googleAccount = null;
  await T.loadSettings(); deq(state.googleAccount, { email: 'ann@example.com', name: 'Ann Example' });
  storage.muninGoogleAccount = { name: 'x' }; await T.loadSettings(); assert.strictEqual(state.googleAccount, null);
});

test('Sign in: a failing userinfo request still signs in, without an email', async () => {
  const b = await bench();
  b.accounts['tok-1'] = null;
  assert.strictEqual(await b.T.connectGoogle(), true);
  assert.strictEqual(b.state.googleConnected, true); assert.strictEqual(b.state.googleAccount, null);
  assert.ok(!('muninGoogleAccount' in b.storage));
  assert.strictEqual(b.T.el.googleStatus.title, 'Signed in');
  assert.strictEqual(b.session.muninGoogleToken.token, 'tok-1');
});

test('silent renewal: an expired token is renewed before the call (prompt=none with login_hint, not interactive); HTTP 401 renews and retries once', async () => {
  const b = await bench();
  const { T, session } = b;
  await T.connectGoogle();
  b.env.run('webToken.expiresAt = Date.now() - 1');
  await T.docsApi('DOC123');
  assert.strictEqual(b.flows.length, 2);
  const f = b.flows[1];
  assert.strictEqual(f.interactive, false);
  deq(f.params, { client_id: CLIENT, response_type: 'token', redirect_uri: REDIRECT, scope: SCOPES, prompt: 'none', login_hint: 'ann@example.com' });
  assert.strictEqual(f.details.abortOnLoadForNonInteractive, false);
  assert.strictEqual(f.details.timeoutMsForNonInteractive, 10000);
  deq(b.fetches, ['Bearer tok-2']); assert.strictEqual(session.muninGoogleToken.token, 'tok-2');
  deq(b.userinfo, ['Bearer tok-1']); // the renewal does not ask for the account again
  // 401: dropped, renewed silently, one retry
  b.status['Bearer tok-2'] = 401;
  await T.docsApi('DOC123');
  deq(b.fetches.slice(1), ['Bearer tok-2', 'Bearer tok-3']);
  assert.strictEqual(b.flows.length, 3); assert.strictEqual(b.flows[2].interactive, false);
  // 401 and the renewal fails: the existing error, one call only
  b.status['Bearer tok-3'] = 401;
  b.reply = () => `${REDIRECT}#error=interaction_required`;
  b.fetches.length = 0;
  await assert.rejects(() => T.docsApi('DOC123'), (e) => e.status === 401 && /The Google authorization expired or was revoked \(HTTP 401\)\. Open Settings → Google account → Sign in with Google\./.test(e.message));
  deq(b.fetches, ['Bearer tok-3']);
  // no valid token and the silent renewal fails: not signed in (nothing sent)
  b.fetches.length = 0;
  await assert.rejects(() => T.docsApi('DOC123'), (e) => e.preSend === true && /not signed in or the authorization expired \(Google needs you to sign in again \(interaction_required\)\.\)/.test(e.message));
  deq(b.fetches, []);
  // without a known email the renewal has no login_hint
  b.state.googleAccount = null;
  b.reply = () => `${REDIRECT}#access_token=tok-9&expires_in=3599&scope=${encodeURIComponent(SCOPES)}`;
  await T.docsApi('DOC123');
  assert.ok(!('login_hint' in b.flows[b.flows.length - 1].params));
});

test('the token survives a panel reload through chrome.storage.session; a token of another client is not used', async () => {
  const b = await bench();
  b.session.muninGoogleToken = { token: 'tok-saved', expiresAt: Date.now() + 600000, clientId: CLIENT };
  b.state.googleConnected = true;
  await b.T.docsApi('DOC123');
  deq(b.fetches, ['Bearer tok-saved']); deq(b.flows, []);
  b.env.run('webToken = null');
  b.session.muninGoogleToken = { token: 'tok-other', expiresAt: Date.now() + 600000, clientId: 'other.apps.googleusercontent.com' };
  await b.T.docsApi('DOC123');
  assert.strictEqual(b.flows.length, 1); deq(b.fetches.slice(-1), ['Bearer tok-1']);
});

test('Sign in: the documents scope not granted, access_denied, a closed window', async () => {
  const b = await bench();
  const { T, state, session } = b;
  b.reply = () => `${REDIRECT}#access_token=tok-x&expires_in=3599&scope=${encodeURIComponent('openid email profile')}`;
  assert.strictEqual(await T.connectGoogle(), false);
  assert.strictEqual(T.el.googleHint.textContent, 'Could not sign in: Google Docs access was not granted. Sign in again and allow access to your documents.');
  assert.ok(T.el.googleHint.classList.contains('warn'));
  assert.strictEqual(state.googleConnected, false); assert.ok(!('muninGoogleToken' in session)); deq(b.userinfo, []);
  b.reply = () => `${REDIRECT}#error=access_denied`;
  assert.strictEqual(await T.connectGoogle(), false);
  assert.ok(/^Could not sign in: Google refused the sign-in \(access_denied\)\. If the app is in Testing, ask whoever deployed it to add this account under Test users/.test(T.el.googleHint.textContent));
  b.chrome.identity.launchWebAuthFlow = async () => { throw new Error('The user did not approve access.'); };
  assert.strictEqual(await T.connectGoogle(), false);
  assert.strictEqual(T.el.googleHint.textContent, 'Could not sign in: The user did not approve access.');
  assert.strictEqual(state.googleConnected, false);
  assert.strictEqual(T.el.googleConnect.disabled, false);
});

test('Switch account: a new sign-in replaces the token and the account; a closed window keeps both', async () => {
  const b = await bench();
  const { T, state, storage, session } = b;
  await T.connectGoogle();
  b.accounts['tok-2'] = { email: 'bob@example.com' };
  assert.strictEqual(await T.switchGoogleAccount(), true);
  assert.strictEqual(b.flows[1].interactive, true); assert.strictEqual(b.flows[1].params.prompt, 'select_account');
  assert.strictEqual(session.muninGoogleToken.token, 'tok-2');
  deq(storage.muninGoogleAccount, { email: 'bob@example.com' }); deq(state.googleAccount, { email: 'bob@example.com' });
  assert.strictEqual(T.el.googleStatus.title, 'Signed in as bob@example.com');
  deq(b.revoked, []); // the old token is not revoked: that could revoke the grant of the same account
  // the window closed: nothing changes, the reason shown under the status
  b.chrome.identity.launchWebAuthFlow = async () => { throw new Error('The user did not approve access.'); };
  assert.strictEqual(await T.switchGoogleAccount(), false);
  assert.strictEqual(session.muninGoogleToken.token, 'tok-2'); assert.strictEqual(b.env.run('webToken.token'), 'tok-2');
  deq(storage.muninGoogleAccount, { email: 'bob@example.com' });
  assert.strictEqual(state.googleConnected, true);
  assert.strictEqual(T.el.googleStatus.title, 'Signed in as bob@example.com');
  assert.strictEqual(T.el.googleHint.textContent, 'Could not switch the account: The user did not approve access.');
  await T.docsApi('DOC123');
  deq(b.fetches, ['Bearer tok-2']);
});

test('Sign out revokes and forgets the token and the account', async () => {
  const b = await bench();
  const { T, state, storage, session } = b;
  await T.connectGoogle();
  await T.disconnectGoogle();
  deq(b.revoked, ['token=tok-1']);
  assert.ok(!('muninGoogleToken' in session)); assert.strictEqual(b.env.run('webToken'), null);
  assert.ok(!('muninGoogleAccount' in storage)); assert.strictEqual(state.googleAccount, null);
  assert.strictEqual(state.googleConnected, false); assert.strictEqual(storage.muninGoogleConnected, false);
  assert.strictEqual(T.el.googleStatus.title, 'Not signed in');
  assert.ok(shown(T.el.googleConnect) && !shown(T.el.googleSwitch) && !shown(T.el.googleDisconnect));
  assert.ok(T.el.chat.children.some((c) => /Signed out of Google/.test(c.innerHTML)));
  // the next Sign in opens the account chooser again
  assert.strictEqual(await T.connectGoogle(), true);
  assert.strictEqual(b.flows.length, 2); assert.strictEqual(b.flows[1].interactive, true);
});

test('the client-ID setting of earlier versions is removed silently at startup', async () => {
  const b = await bench();
  b.storage.muninGoogleClientId = '42-x.apps.googleusercontent.com';
  await b.T.loadSettings();
  assert.ok(!('muninGoogleClientId' in b.storage));
});
