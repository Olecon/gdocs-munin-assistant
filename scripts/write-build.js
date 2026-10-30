'use strict';
// Writes build.json, the stamp src/dev-reload.js uses to reload an unpacked install once a cloud sync
// has delivered the whole new file set. Usage: node scripts/write-build.js [root] (default: the repo).
// The hash must stay byte-identical to buildHash() in src/dev-reload.js: SHA-256 over, per file in
// sorted path order, the UTF-8 path, 0x00, the file bytes, 0x00.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const TOP_FILES = ['manifest.json', 'background.js', 'content.js', 'sidepanel.html', 'sidepanel.css'];

// Relative paths (with '/') of the files below dir whose name passes keep.
function walk(root, dir, keep, recursive) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = dir + '/' + ent.name;
    if (ent.isDirectory()) { if (recursive) out.push(...walk(root, rel, keep, true)); }
    else if (ent.isFile() && keep(ent.name)) out.push(rel);
  }
  return out;
}

// Exactly the shipped files (the zip script's set minus the docs); never build.json, tests or docs.
function listFiles(root) {
  const files = [
    ...TOP_FILES.filter((f) => fs.existsSync(path.join(root, f))),
    ...walk(root, 'src', (n) => n.endsWith('.js'), true),
    ...walk(root, 'vendor', (n) => /\.(?:js|txt|LICENSE)$/.test(n), false), // vendored code and its notices
    ...walk(root, 'icons', (n) => n.endsWith('.png'), false),
  ];
  // Code-unit order, independent of the locale.
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function hashFiles(root, files) {
  const h = crypto.createHash('sha256');
  const zero = Buffer.from([0]);
  for (const f of files) {
    h.update(Buffer.from(f, 'utf8'));
    h.update(zero);
    h.update(fs.readFileSync(path.join(root, f)));
    h.update(zero);
  }
  return h.digest('hex');
}

function gitCommit(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || 'unknown';
  } catch (e) { return 'unknown'; }
}

function writeBuild(root) {
  const files = listFiles(root);
  const stamp = { commit: gitCommit(root), time: new Date().toISOString(), files, hash: hashFiles(root, files) };
  fs.writeFileSync(path.join(root, 'build.json'), JSON.stringify(stamp, null, 2) + '\n');
  return stamp;
}

if (require.main === module) {
  const stamp = writeBuild(path.resolve(process.argv[2] || path.join(__dirname, '..')));
  console.log(`build.json: ${stamp.hash} (${stamp.files.length} files, commit ${stamp.commit})`);
}

module.exports = { listFiles, hashFiles, writeBuild };
