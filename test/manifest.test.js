'use strict';
// The manifest: version (the same as package.json), the key (a stable extension ID), no oauth2 block, permissions,
// web-accessible resources, description length.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { deq } = require('./lib/sandbox');

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'));

test('manifest: version from package.json, the key, permissions', async () => {
  const manifest = readJson('manifest.json');
  const pkg = readJson('package.json');

  // --- the two version fields must agree
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(manifest.version, pkg.version);
  // --- the key pins the extension ID (the redirect URI of the OAuth client); the client is GOOGLE_CLIENT_ID
  // (launchWebAuthFlow), so there is no oauth2 block
  assert.match(manifest.key, /^MII[A-Za-z0-9+/]+=*$/);
  assert.ok(!('oauth2' in manifest));
  // --- host permissions: the Docs API and the userinfo endpoint (the signed-in account's email)
  assert.ok(manifest.host_permissions.includes('https://openidconnect.googleapis.com/*'));
  assert.ok(!manifest.host_permissions.includes('https://www.googleapis.com/*') && manifest.host_permissions.includes('https://docs.googleapis.com/*'));
  // --- Chrome Web Store limit for the description
  assert.ok(manifest.description.length <= 132, `description is ${manifest.description.length} characters (limit 132)`);
  // --- permissions: chats keep tool results (beyond the 10 MB storage.local quota); activeTab is not used
  // (the docs.google.com host permission already covers the toolbar click and the script injection)
  assert.ok(manifest.permissions.includes('unlimitedStorage'));
  assert.ok(!manifest.permissions.includes('activeTab'), 'activeTab is unused and must not be requested');
  // tabs: the docs.google.com host permission exposes the URL and title of Docs tabs, the only ones read
  assert.ok(!manifest.permissions.includes('tabs'), 'tabs is not needed');
  assert.ok(manifest.permissions.includes('identity'));
  // --- the Docs page embeds only the panel page (iframe) and the raven button image
  deq(manifest.web_accessible_resources.map((r) => r.resources), [['sidepanel.html', 'icons/*.png']]);
});

test('manifest: Zotero, Crossref and OpenAlex are optional hosts, asked for by the References switch', () => {
  const manifest = readJson('manifest.json');
  deq(manifest.optional_host_permissions, ['http://localhost:23119/*', 'https://api.crossref.org/*', 'https://api.openalex.org/*']);
  assert.ok(!manifest.host_permissions.some((h) => /23119|crossref|openalex/.test(h)));
});
