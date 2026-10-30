'use strict';
// Module dev-reload.js: developer mode. An unpacked install (no update_url) whose folder holds build.json
// (written by scripts/write-build.js, not shipped) polls the stamp and calls chrome.runtime.reload() once
// a new, complete file set has arrived (a cloud sync delivers files one by one). Store builds and folders
// without build.json never poll. Loaded after main.js; nothing else depends on it.
/* exported buildHash, startDevReload */

const DEV_RELOAD_INTERVAL_MS = 5000;

// SHA-256 hex of the file set, byte-identical to hashFiles() in scripts/write-build.js: per entry
// (already in the stamp's sorted order) the UTF-8 path, 0x00, the bytes, 0x00.
async function buildHash(entries) {
  const enc = new TextEncoder();
  const parts = [];
  for (const { path, bytes } of entries) parts.push(enc.encode(path), new Uint8Array(bytes));
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length + 1; } // the gap stays 0x00
  const digest = await crypto.subtle.digest('SHA-256', all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Extension files are read with no-store so a file replaced on disk is never served from a cache.
async function fetchOwn(path, as) {
  const r = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
  if (!r.ok) throw new Error(path + ': HTTP ' + r.status);
  return as === 'json' ? r.json() : r.arrayBuffer();
}

async function fetchStamp() {
  const s = await fetchOwn('build.json', 'json');
  if (!s || typeof s.hash !== 'string' || !Array.isArray(s.files)) throw new Error('build.json: bad stamp');
  return s;
}

// True when the files on disk are exactly the stamp's set (the sync has finished).
async function stampComplete(stamp) {
  const entries = await Promise.all(stamp.files.map(async (path) => ({ path, bytes: await fetchOwn(path) })));
  return (await buildHash(entries)) === stamp.hash;
}

function isUnpacked() {
  try { return !chrome.runtime.getManifest().update_url; } catch (e) { return false; }
}

// Starts polling; resolves to a stop function, or null when the feature is off. One check at a time:
// the next one is scheduled only after the previous one has finished.
async function startDevReload(intervalMs = DEV_RELOAD_INTERVAL_MS) {
  if (!isUnpacked()) return null;
  let known;
  try { known = (await fetchStamp()).hash; } catch (e) { return null; }
  let timer = null;
  let stopped = false;
  const check = async () => {
    try {
      const stamp = await fetchStamp();
      // The full hash runs only once the stamp has changed; a mismatch means the sync is still running.
      if (stamp.hash !== known && await stampComplete(stamp)) {
        console.info(`Munin: files changed (commit ${stamp.commit}), reloading`);
        stopped = true;
        chrome.runtime.reload();
        return;
      }
    } catch (e) { /* mid-sync or a missing file: try at the next tick */ }
    if (!stopped) timer = setTimeout(check, intervalMs);
  };
  timer = setTimeout(check, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}

startDevReload();
