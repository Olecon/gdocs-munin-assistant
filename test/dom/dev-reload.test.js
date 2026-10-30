'use strict';
// src/dev-reload.js in the panel page (jsdom): off for store builds (update_url) and without build.json;
// polls only the stamp while it is unchanged; a changed stamp reloads only once the files on disk hash to it.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { load, tick } = require('../lib/dom-sandbox');
const { waitFor } = require('../lib/sandbox');

const BASE = 'chrome-extension://testextid/';

// The documented stamp hash of a { path: text } set (the same algorithm as scripts/write-build.js).
function hashOf(files) {
  const h = crypto.createHash('sha256');
  for (const p of Object.keys(files).sort()) h.update(Buffer.concat([Buffer.from(p), Buffer.from([0]), Buffer.from(files[p]), Buffer.from([0])]));
  return h.digest('hex');
}

const stampOf = (files, commit = 'abc1234') => ({ commit, time: '2026-10-23T00:00:00.000Z', files: Object.keys(files).sort(), hash: hashOf(files) });

// A panel with an extension folder behind fetch: disk (what the files are now) and stamp (build.json,
// null: 404). Returns { p, disk, ext, fetches, reloads, start(manifest) }.
async function bench() {
  const p = await load();
  Object.defineProperty(p.window, 'crypto', { configurable: true, value: crypto.webcrypto });
  const ext = { stamp: null, disk: {} };
  const fetches = [];
  const reloads = [];
  p.ctx.fetch = async (url, opts) => {
    const rel = String(url).slice(BASE.length);
    fetches.push({ rel, cache: opts && opts.cache });
    const body = rel === 'build.json' ? (ext.stamp && JSON.stringify(ext.stamp)) : ext.disk[rel];
    if (body == null) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => JSON.parse(body), arrayBuffer: async () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } };
  };
  p.chrome.runtime.reload = () => reloads.push(1);
  const stops = [];
  const start = async (manifest = { version: '1.0' }) => {
    p.chrome.runtime.getManifest = () => manifest;
    const stop = await p.T.startDevReload(10);
    if (stop) stops.push(stop);
    return stop;
  };
  const close = () => { stops.forEach((s) => s()); p.close(); };
  return { p, ext, fetches, reloads, start, close };
}

async function withBench(fn) {
  const b = await bench();
  try { await fn(b); } finally { b.close(); }
}

test('off for a store build (update_url): build.json is never fetched', () => withBench(async (b) => {
  b.ext.stamp = stampOf({ 'a.js': '1' });
  assert.strictEqual(await b.start({ version: '1.0', update_url: 'https://clients2.google.com/service/update2/crx' }), null);
  await tick(40);
  assert.deepStrictEqual(b.fetches, []);
}));

test('off when build.json is missing (404) or the fetch fails', () => withBench(async (b) => {
  assert.strictEqual(await b.start(), null);
  b.p.ctx.fetch = async () => { throw new Error('net::ERR_FILE_NOT_FOUND'); };
  assert.strictEqual(await b.start(), null);
  await tick(40);
  assert.deepStrictEqual(b.fetches.map((f) => f.rel), ['build.json']);
  assert.deepStrictEqual(b.reloads, []);
}));

test('an unchanged stamp: only build.json is polled (no-store), no reload', () => withBench(async (b) => {
  b.ext.disk = { 'a.js': '1', 'src/b.js': '2' };
  b.ext.stamp = stampOf(b.ext.disk);
  assert.strictEqual(typeof await b.start(), 'function');
  await waitFor(() => b.fetches.length >= 4, 'a few polls');
  assert.ok(b.fetches.every((f) => f.rel === 'build.json' && f.cache === 'no-store'));
  assert.deepStrictEqual(b.reloads, []);
}));

test('a changed stamp with files still syncing: no reload, retried until the files match, then one reload', () => withBench(async (b) => {
  b.ext.disk = { 'a.js': '1', 'src/b.js': '2' };
  b.ext.stamp = stampOf(b.ext.disk);
  await b.start();
  const info = [];
  b.p.window.console.info = (...a) => info.push(a.join(' '));
  // the new stamp has arrived, a.js has not (and src/c.js is missing: a 404 waits too)
  b.ext.stamp = stampOf({ 'a.js': 'NEW', 'src/b.js': '2', 'src/c.js': '3' }, 'def5678');
  await waitFor(() => b.fetches.filter((f) => f.rel === 'src/b.js').length >= 2, 'two full checks');
  assert.deepStrictEqual(b.reloads, []);
  b.ext.disk['src/c.js'] = '3';
  await waitFor(() => b.fetches.filter((f) => f.rel === 'src/c.js').length >= 2, 'a check with all files present');
  assert.deepStrictEqual(b.reloads, []);
  assert.ok(b.fetches.every((f) => f.cache === 'no-store'));
  // the last file arrives: the hash matches and the extension reloads once
  b.ext.disk['a.js'] = 'NEW';
  await waitFor(() => b.reloads.length === 1, 'the reload');
  const n = b.fetches.length;
  await tick(50);
  assert.strictEqual(b.reloads.length, 1);
  assert.strictEqual(b.fetches.length, n, 'polling stops after the reload call');
  assert.deepStrictEqual(info, ['Munin: files changed (commit def5678), reloading']);
}));

test('one check at a time: a slow fetch is not overlapped by the next tick', () => withBench(async (b) => {
  b.ext.disk = { 'a.js': '1' };
  b.ext.stamp = stampOf(b.ext.disk);
  await b.start();
  const fetch = b.p.ctx.fetch;
  let inFlight = 0;
  let maxInFlight = 0;
  b.p.ctx.fetch = async (url, opts) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await tick(35); // longer than the 10 ms interval
    try { return await fetch(url, opts); } finally { inFlight--; }
  };
  await tick(150);
  assert.strictEqual(maxInFlight, 1);
}));
