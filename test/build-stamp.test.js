'use strict';
// scripts/write-build.js (the build.json stamp for the developer-mode reload): the shipped file list
// (sorted, without build.json, tests or docs), a deterministic hash, and the same hash from the panel's
// buildHash() (src/dev-reload.js, Web Crypto) for the same bytes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ROOT } = require('./lib/sandbox');
const { listFiles, hashFiles, writeBuild } = require('../scripts/write-build');

// A temporary extension folder: shipped files, plus files that must be left out.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'munin-build-'));
  const put = (rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
  put('manifest.json', '{"manifest_version":3}\n');
  put('background.js', '// worker\n');
  put('content.js', '// content é\n');
  put('sidepanel.html', '<!doctype html>\n');
  put('sidepanel.css', 'body{}\n');
  put('src/main.js', 'init();\n');
  put('src/constants.js', 'const A = 1;\n');
  put('src/providers/openai.js', '// provider\n');
  put('src/notes.txt', 'not shipped');
  put('vendor/lib.min.js', '/*! lib */\n');
  put('vendor/lib.LICENSE', 'MIT\n');
  put('vendor/NOTICES.txt', 'notices\n');
  put('vendor/readme.md', 'no');
  put('icons/icon16.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
  put('icons/readme.md', 'no');
  put('test/a.test.js', 'no');
  put('docs/x.md', 'no');
  put('README.md', 'no');
  put('build.json', '{}');
  return dir;
}

const EXPECTED = ['background.js', 'content.js', 'icons/icon16.png', 'manifest.json', 'sidepanel.css', 'sidepanel.html',
  'src/constants.js', 'src/main.js', 'src/providers/openai.js', 'vendor/NOTICES.txt', 'vendor/lib.LICENSE', 'vendor/lib.min.js'];

// The documented algorithm, written out independently of the script.
function referenceHash(dir, files) {
  const chunks = [];
  for (const f of files) chunks.push(Buffer.from(f, 'utf8'), Buffer.from([0]), fs.readFileSync(path.join(dir, f)), Buffer.from([0]));
  return crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}

test('the file list: shipped files only, sorted, never build.json', () => {
  const dir = fixture();
  try {
    assert.deepStrictEqual(listFiles(dir), EXPECTED);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the hash is deterministic, follows the documented algorithm and changes with any byte', () => {
  const dir = fixture();
  try {
    const files = listFiles(dir);
    const h = hashFiles(dir, files);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.strictEqual(hashFiles(dir, files), h);
    assert.strictEqual(h, referenceHash(dir, files));
    fs.writeFileSync(path.join(dir, 'build.json'), '{"other":1}'); // the stamp itself never counts
    assert.strictEqual(hashFiles(dir, listFiles(dir)), h);
    fs.appendFileSync(path.join(dir, 'src/main.js'), ' ');
    assert.notStrictEqual(hashFiles(dir, files), h);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI writes build.json and prints the hash and the file count', () => {
  const dir = fixture();
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/write-build.js'), dir], { encoding: 'utf8' });
    const stamp = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(stamp), ['commit', 'time', 'files', 'hash']);
    assert.deepStrictEqual(stamp.files, EXPECTED);
    assert.strictEqual(stamp.hash, referenceHash(dir, EXPECTED));
    assert.ok(!Number.isNaN(Date.parse(stamp.time)));
    assert.strictEqual(typeof stamp.commit, 'string');
    assert.ok(out.includes(stamp.hash) && out.includes(EXPECTED.length + ' files'), out);
    // a rewrite with the same files keeps the hash
    assert.strictEqual(writeBuild(dir).hash, stamp.hash);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the repository stamp lists the shipped files of the zip script', () => {
  const files = listFiles(ROOT);
  for (const f of ['manifest.json', 'background.js', 'content.js', 'sidepanel.html', 'sidepanel.css', 'src/main.js',
    'src/dev-reload.js', 'src/providers/munin.js', 'icons/icon16.png', 'vendor/typograf.min.js', 'vendor/typograf.LICENSE',
    'vendor/NOTICES.txt']) assert.ok(files.includes(f), f);
  assert.ok(!files.some((f) => f === 'build.json' || f.startsWith('test/') || f.startsWith('docs/') || f.startsWith('scripts/')));
});

test('the panel computes the same hash (buildHash in src/dev-reload.js, Web Crypto)', async () => {
  const dir = fixture();
  try {
    const ctx = vm.createContext({ crypto: crypto.webcrypto, TextEncoder, console, setTimeout, clearTimeout, chrome: { runtime: {} } });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/dev-reload.js'), 'utf8'), ctx, { filename: 'src/dev-reload.js' });
    const files = listFiles(dir);
    const entries = files.map((p) => { const b = fs.readFileSync(path.join(dir, p)); return { path: p, bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; });
    assert.strictEqual(await ctx.buildHash(entries), hashFiles(dir, files));
    assert.strictEqual(await ctx.buildHash([]), crypto.createHash('sha256').digest('hex'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
