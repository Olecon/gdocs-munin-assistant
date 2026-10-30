'use strict';
// Google API partial-response field masks ("a,b(c,d/e)"): parseMask builds a tree ({name: true | subtree}),
// maskPaths lists its leaf paths ("b.d.e"), covers(paths, p) tells whether a path is returned (whole: a
// leaf path is p or a prefix of it; in part: p is a prefix of a leaf path), and applyMask filters a JSON
// value like the server does (arrays element by element; a leaf keeps the whole value).
function parseMask(s) {
  let i = 0;
  const list = () => {
    const node = {};
    for (;;) {
      let name = '';
      while (i < s.length && !',()'.includes(s[i])) name += s[i++];
      if (!name) throw new Error(`empty field name at ${i} in the mask`);
      let sub = true;
      if (s[i] === '(') { i++; sub = list(); if (s[i] !== ')') throw new Error(`missing ")" at ${i}`); i++; }
      const parts = name.split('/');
      let n = node;
      for (const p of parts.slice(0, -1)) n = n[p] = (n[p] && n[p] !== true ? n[p] : {});
      n[parts[parts.length - 1]] = sub;
      if (s[i] === ',') { i++; continue; }
      return node;
    }
  };
  const tree = list();
  if (i !== s.length) throw new Error(`unexpected "${s[i]}" at ${i} in the mask`);
  return tree;
}

function maskPaths(tree, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(tree)) {
    const p = prefix ? prefix + '.' + k : k;
    if (v === true) out.push(p); else out.push(...maskPaths(v, p));
  }
  return out;
}

const covers = (paths, p) => paths.some((m) => m === p || p.startsWith(m + '.') || m.startsWith(p + '.'));

function applyMask(value, tree) {
  if (tree === true || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => applyMask(v, tree));
  const out = {};
  for (const [k, sub] of Object.entries(tree)) if (k in value) out[k] = applyMask(value[k], sub);
  return out;
}

module.exports = { parseMask, maskPaths, covers, applyMask };
