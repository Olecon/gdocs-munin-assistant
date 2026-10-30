'use strict';
// Normalized matching (findFlexible's fallback), the "not found" error with the closest match, commonEdges.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { deq, load, installDocTab, installIdentity } = require('./lib/sandbox');
const { docSpec, docsBench } = require('./lib/fake-docs');

let fake; let as;
const ref = { get fake() { return fake; }, set fake(v) { fake = v; }, get as() { return as; }, set as(v) { as = v; } };
let env, T, state, ident, fresh, exec, pushTool, lastPost, w;

before(async () => {
  env = await load();
  T = env.T;
  state = env.state;
  ident = installIdentity(env);
  ({ fresh, exec, pushTool, lastPost } = docsBench(env, ident, ref));
  installDocTab(env);
  await T.refreshContext({ force: true });
  state.settings.provider = 'anthropic'; state.googleConnected = true;
});

// Characters by code (this file stays ASCII).
const U = (...codes) => String.fromCharCode(...codes);
const NBSP = U(0xA0);
const THIN = U(0x2009);
const NNBSP = U(0x202F);
const SHY = U(0xAD);
const ZWSP = U(0x200B);
const ZWJ = U(0x200D);
const BOM = U(0xFEFF);
const LQ = U(0x201C);
const RQ = U(0x201D);
const APOS = U(0x2019);
const LG = U(0xAB);
const RG = U(0xBB);
const NDASH = U(0x2013);
const MDASH = U(0x2014);
const NBHY = U(0x2011);
const ELL = U(0x2026);
const VT = U(0x0B);
const OC = U(0xFFFC);
const SMILE = U(0xD83D, 0xDE00);
const find = (hay, needle, opts) => JSON.parse(JSON.stringify(T.findFlexible(hay, needle, opts)));

test('normalizeForMatch: the offset map points into the original text', () => {
  const src = `a${NBSP}${THIN}b${SHY}c ${LQ}q${RQ}${ELL} x${MDASH}y  \nz\tw${VT}v`;
  const n = T.normalizeForMatch(src);
  assert.strictEqual(n.text, 'a bc "q"... x-y\nz w\nv');
  assert.strictEqual(n.start.length, n.text.length); assert.strictEqual(n.end.length, n.text.length);
  assert.strictEqual(src.slice(n.start[1], n.end[1]), NBSP + THIN); // the space run
  assert.strictEqual(src.slice(n.start[3], n.end[3]), 'c'); // after the dropped soft hyphen
  const dots = n.text.indexOf('...');
  deq([n.start[dots], n.start[dots + 2], n.head[dots], n.head[dots + 1], n.tail[dots + 1], n.tail[dots + 2]],
    [src.indexOf(ELL), src.indexOf(ELL), true, false, false, true]);
  assert.strictEqual(src[n.start[n.text.indexOf('\n')]], '\n'); // the trailing "  " before it is dropped
  assert.strictEqual(src[n.start[n.text.lastIndexOf('\n')]], VT); // a soft break is a newline
  assert.strictEqual(T.normalizeForMatch(`x${BOM}y${ZWSP}z${ZWJ}w`).text, 'xyzw');
});

test('findFlexible: exact first, normalized fallback with the real document text', () => {
  // exact hits win (no fallback even when a normalized one would match more)
  deq(find(`a b and a${NBSP}b`, 'a b'), [{ at: 0, text: 'a b' }]);
  // NBSP / narrow NBSP / tab in the document
  deq(find(`Total:${NBSP}42 units`, 'Total: 42 units'), [{ at: 0, text: `Total:${NBSP}42 units`, normalized: true }]);
  deq(find(`x 10${NNBSP}km\ty`, '10 km y'), [{ at: 2, text: `10${NNBSP}km\ty`, normalized: true }]);
  // soft hyphen and zero-width characters inside a word
  deq(find(`the co${SHY}operation of`, 'cooperation'), [{ at: 4, text: `co${SHY}operation`, normalized: true }]);
  deq(find(`ab${ZWSP}cd`, 'abcd'), [{ at: 0, text: `ab${ZWSP}cd`, normalized: true }]);
  // smart quotes and guillemets in the document, straight ones in the needle (and the other way round)
  deq(find(`He said ${LQ}don${APOS}t${RQ}.`, 'said "don\'t"'), [{ at: 3, text: `said ${LQ}don${APOS}t${RQ}`, normalized: true }]);
  deq(find(`the ${LG}word${RG} here`, 'the "word"'), [{ at: 0, text: `the ${LG}word${RG}`, normalized: true }]);
  deq(find('it\'s "fine"', `it${APOS}s ${LQ}fine${RQ}`), [{ at: 0, text: 'it\'s "fine"', normalized: true }]);
  // en / em dashes and the non-breaking hyphen
  deq(find(`pages 10${NDASH}12 ${MDASH} see`, 'pages 10-12 - see'), [{ at: 0, text: `pages 10${NDASH}12 ${MDASH} see`, normalized: true }]);
  deq(find(`e${NBHY}mail`, 'e-mail'), [{ at: 0, text: `e${NBHY}mail`, normalized: true }]);
  // the ellipsis, and no hit that starts or ends inside its three dots
  deq(find(`Wait${ELL} what`, 'Wait... what'), [{ at: 0, text: `Wait${ELL} what`, normalized: true }]);
  deq(find(`Wait${ELL} what`, 'Wait.'), []);
  // trailing spaces at line ends, in the document or in the needle; soft breaks
  deq(find('end of line  \nnext', 'end of line\nnext'), [{ at: 0, text: 'end of line  \nnext', normalized: true }]);
  deq(find('end of line\nnext', 'end of line \nnext'), [{ at: 0, text: 'end of line\nnext', normalized: true }]);
  deq(find(`a${NBSP}b${VT}c`, 'a b\nc'), [{ at: 0, text: `a${NBSP}b${VT}c`, normalized: true }]);
  // 0 / 1 / many: every normalized hit is reported
  deq(find(`x${NBSP}y and x${NBSP}y`, 'x y').map((h) => h.at), [0, 8]);
  // undo matches exactly only
  deq(find(`Total:${NBSP}42`, 'Total: 42', { normalize: false }), []);
  // whitespace alone is not searched loosely
  deq(find(`a${NBSP}b`, ' '), []);
});

test('findFlexible: surrogate pairs are never split', () => {
  const hay = `smile ${SMILE}${NBSP}ok`;
  deq(find(hay, `${SMILE} ok`), [{ at: 6, text: `${SMILE}${NBSP}ok`, normalized: true }]);
  // a needle with half of the pair cannot match inside it
  deq(find(hay, `${U(0xDE00)} ok`), []);
  deq(find(`${SMILE}${NBSP}`, `smile ${U(0xD83D)}`), []);
});

// Cyrillic look-alikes: es, o, a, ie, capital es; Greek omicron; Cyrillic words "soso" / "kot" (cat).
const CY_C = U(0x441);
const CY_O = U(0x43E);
const CY_A = U(0x430);
const CY_E = U(0x435);
const CY_CC = U(0x421);
const GR_O = U(0x3BF);
const CY_SOSO = CY_C + CY_O + CY_C + CY_O;
const CY_KOT = U(0x43A, 0x43E, 0x442);

test('findFlexible: look-alike letters are folded only as the last resort', () => {
  // a Cyrillic letter inside a Latin word finds the Latin document text, and the reverse
  deq(find('Clear the cache now.', `the ${CY_C}ache`), [{ at: 6, text: 'the cache', normalized: true, folded: true }]);
  deq(find(`${CY_KOT} ${CY_A}${CY_C}${CY_E}`, `${CY_KOT} ace`), [{ at: 0, text: `${CY_KOT} ${CY_A}${CY_C}${CY_E}`, normalized: true, folded: true }]);
  deq(find(`${CY_CC}${GR_O}de`, 'Code'), [{ at: 0, text: `${CY_CC}${GR_O}de`, normalized: true, folded: true }]);
  // combined with whitespace normalization
  deq(find(`old${NBSP}cache`, `old ${CY_C}ache`), [{ at: 0, text: `old${NBSP}cache`, normalized: true, folded: true }]);
  // pure Cyrillic still matches exactly
  deq(find(`${CY_KOT} ${CY_SOSO}.`, CY_SOSO), [{ at: 4, text: CY_SOSO }]);
  // a ru/en twin pair: the fold hits both, so the caller sees an ambiguity
  deq(find(`coco and ${CY_SOSO}`, `c${CY_O}c${CY_O}`).map((h) => [h.at, h.folded]), [[0, true], [9, true]]);
  // the fold never runs when the normalized pass found the text (the twin is not added)
  deq(find(`a${NBSP}coco and a ${CY_SOSO}`, 'a coco'), [{ at: 0, text: `a${NBSP}coco`, normalized: true }]);
  // nor when the exact pass did
  deq(find(`coco and ${CY_SOSO}`, 'coco'), [{ at: 0, text: 'coco' }]);
  // undo matches exactly: no fold
  deq(find('the cache', `${CY_C}ache`, { normalize: false }), []);
  // a letter outside the table is not folded (Cyrillic "i kratkoe" is not "n")
  deq(find('Ivan', `Iva${U(0x438)}`), []);
});

test('replace_text with a folded match: the real text, ambiguity refused, undo exact', async () => {
  await fresh(docSpec({ items: [
    { p: 'Title', style: 'TITLE' },
    { p: 'Clear the cache now.' },
    { p: `coco and ${CY_SOSO}` },
  ] }));
  w = pushTool(await exec('replace_text', { old_text: `Clear the ${CY_C}ache now.`, new_text: 'Clear the cache later.' }, 'f1'));
  assert.ok(w._ok, w.content);
  // a folded hit gets FOLDED_NOTE instead of NORMALIZED_NOTE
  assert.ok(w.content.endsWith(`\n${T.FOLDED_NOTE}`), w.content);
  assert.strictEqual(fake.text('t.0').split('\n')[1], 'Clear the cache later.');
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'f1u'))._ok);
  assert.strictEqual(fake.text('t.0').split('\n')[1], 'Clear the cache now.');
  // the twin pair is refused as ambiguous, nothing changes
  w = await exec('replace_text', { old_text: `c${CY_O}c${CY_O}`, new_text: 'x' });
  assert.ok(!w._ok && /occurs 2 times/.test(w.content), w.content);
  assert.strictEqual(fake.text('t.0').split('\n')[2], `coco and ${CY_SOSO}`);
  assert.strictEqual(T.FOLDED_NOTE, 'Note: old_text matched after normalizing look-alike Cyrillic/Latin letters (the document\'s characters differ there).');
});

test('replace_all with a folded match: one spelling is replaced everywhere; two different spellings are refused', async () => {
  const LAT = 'cache';
  const MIXED = `${CY_C}ache`; // a Cyrillic es, then Latin
  const ALL_CY = `${CY_C}${CY_A}${CY_C}he`; // what the model typed: Cyrillic es, a, es
  await fresh(docSpec({ items: [
    { p: 'Title', style: 'TITLE' },
    { p: `The ${LAT} is warm.` },
    { p: `A ${MIXED} miss.` },
  ] }));
  // the twin pair: a genuine Latin word and a mixed-script one; nothing is replaced
  w = await exec('replace_all', { old_text: ALL_CY, new_text: 'buffer' });
  assert.ok(!w._ok, w.content);
  assert.ok(w.content.includes('the document spells it 2 different ways (lines 2, 3): "cache", "' + MIXED + '". Nothing was replaced.'), w.content);
  deq(fake.text('t.0').split('\n').slice(1), [`The ${LAT} is warm.`, `A ${MIXED} miss.`]);
  // one spelling only (twice): all of it is replaced, with the folded note
  await fresh(docSpec({ items: [
    { p: 'Title', style: 'TITLE' },
    { p: `The ${MIXED} is warm.` },
    { p: `A ${MIXED} miss.` },
  ] }));
  w = pushTool(await exec('replace_all', { old_text: ALL_CY, new_text: 'buffer' }, 'ra1'));
  assert.ok(w._ok, w.content);
  assert.ok(w.content.includes(T.FOLDED_NOTE), w.content);
  deq(fake.text('t.0').split('\n').slice(1), ['The buffer is warm.', 'A buffer miss.']);
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'ra1u'))._ok);
  deq(fake.text('t.0').split('\n').slice(1), [`The ${MIXED} is warm.`, `A ${MIXED} miss.`]);
});

test('commonEdges: prefix and suffix at word boundaries, surrogate pairs kept whole', () => {
  const e = (a, b) => JSON.parse(JSON.stringify(T.commonEdges(a, b)));
  deq(e('Intro text.', 'Intro words.'), { p: 6, q: 1 });
  deq(e('Methods', 'Method'), { p: 0, q: 0 }); // no word is cut
  deq(e('the cat sat', 'the cat sat down'), { p: 11, q: 0 }); // pure insertion
  deq(e('one two three', 'one three'), { p: 4, q: 5 }); // pure deletion of "two "
  deq(e('abc', 'abc'), { p: 3, q: 0 });
  deq(e(`x ${SMILE} y`, `x ${U(0xD83D, 0xDE01)} y`), { p: 2, q: 2 }); // the pair is replaced whole
  deq(e(SMILE, U(0xD83D, 0xDE01)), { p: 0, q: 0 });
  deq(e('A\nB', 'A\nC'), { p: 2, q: 0 });
});

test('replace_text / format_text / replace_all with normalized matches', async () => {
  await fresh(docSpec({ items: [
    { p: 'Title', style: 'TITLE' },
    { p: `Price:${NBSP}10${NDASH}12 ${LQ}euro${RQ}.` },
    { p: `It${APOS}s done. It${APOS}s fine.` },
    { p: 'Last' },
  ] }));
  w = pushTool(await exec('replace_text', { old_text: 'Price: 10-12 "euro".', new_text: 'Price: 10-12 "EUR".' }, 'n1'));
  assert.ok(w._ok, w.content);
  assert.ok(w.content.endsWith('\nNote: old_text matched after normalizing whitespace/quotes/dashes (the document has slightly different characters there).'), w.content);
  // only the differing word is replaced: the NBSP, the en dash and the curly quotes around it stay
  assert.strictEqual(fake.text('t.0').split('\n')[1], `Price:${NBSP}10${NDASH}12 ${LQ}EUR${RQ}.`);
  // the journal holds the real document text, so undo restores it exactly
  assert.strictEqual(w._edit.restore, 'euro');
  assert.strictEqual(w._edit.text, 'EUR');
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'n1u'))._ok);
  assert.strictEqual(fake.text('t.0').split('\n')[1], `Price:${NBSP}10${NDASH}12 ${LQ}euro${RQ}.`);
  // format_text with a normalized match
  w = pushTool(await exec('format_text', { old_text: '"euro"', bold: true }, 'n2'));
  assert.ok(w._ok && /normalizing whitespace/.test(w.content), w.content);
  assert.strictEqual(w._edit.text, `${LQ}euro${RQ}`);
  // replace_all: two normalized occurrences; undo restores the curly apostrophes
  w = pushTool(await exec('replace_all', { old_text: "It's", new_text: 'It is' }, 'n3'));
  assert.ok(w._ok && /normalizing whitespace/.test(w.content), w.content);
  assert.strictEqual(fake.text('t.0').split('\n')[2], 'It is done. It is fine.');
  assert.ok(pushTool(await exec('undo_last_edit', {}, 'n3u'))._ok);
  assert.strictEqual(fake.text('t.0').split('\n')[2], `It${APOS}s done. It${APOS}s fine.`);
  // replace_text: two normalized hits are still "occurs 2 times"
  w = await exec('replace_text', { old_text: "It's", new_text: 'x' });
  assert.ok(!w._ok && /occurs 2 times \(lines 3\)/.test(w.content), w.content);
  // a replacement that only straightens the quotes still changes them (exact edges then)
  w = pushTool(await exec('replace_text', { old_text: `It${APOS}s done.`, new_text: "It's done." }, 'n4'));
  assert.ok(w._ok, w.content);
  assert.strictEqual(fake.text('t.0').split('\n')[2], `It's done. It${APOS}s fine.`);
});

test('not found: the closest match, where it differs and the current lines', async () => {
  await fresh();
  // the prefix matches up to "gamma": the difference follows it
  w = await exec('replace_text', { old_text: 'Alpha beta gamma ray', new_text: 'x' });
  assert.ok(!w._ok);
  assert.strictEqual(w.content, 'Error: old_text not found. Closest match at line 4: «Alpha beta gamma.»; differs at « ray» (old_text) vs «.» (document).\n' +
    'Current text of lines 4-4:\n4: Alpha beta gamma.\n' +
    'old_text must match the document text (without the "N: " line-number prefixes); read the exact text with read_lines or find_in_document and try again');
  // only the end matches ("a beta delta."): the difference comes before it
  w = await exec('replace_all', { old_text: 'Omega beta delta.', new_text: 'x' });
  assert.ok(!w._ok && w.content.startsWith('Error: old_text not found. Closest match at line 5: «Alpha beta delta.»; differs at «Omeg» (old_text) vs «Alph» (document).\nCurrent text of lines 5-5:\n5: Alpha beta delta.\n'), w.content);
  // a line break in the document where old_text goes on
  w = await exec('replace_text', { old_text: 'Alpha beta gamma. And more', new_text: 'x' });
  assert.ok(w.content.includes('differs at « And more» (old_text) vs «\\n» (document)'), w.content);
  // a long difference is cut with an ellipsis
  w = await exec('replace_text', { old_text: 'Alpha beta gamma, followed by a very long tail of other words', new_text: 'x' });
  assert.ok(w.content.includes('differs at «, followed by a very long tail…» (old_text) vs «.» (document)'), w.content);
  w = await exec('format_text', { old_text: 'Last lime', bold: true });
  assert.ok(!w._ok && /Closest match at line 10: «Last line»; differs at «me» \(old_text\) vs «ne» \(document\)/.test(w.content) && /read_formatting/.test(w.content), w.content);
  // nothing similar at all
  w = await exec('replace_text', { old_text: 'Zzyzx qwv', new_text: 'x' });
  assert.ok(!w._ok && /^Error: old_text was not found in the document, and no similar text either\. old_text must match/.test(w.content), w.content);
  assert.strictEqual(fake.revision, 1);
});

test('not found: markers and quotes in old_text are ignored when looking for similar text, and the advice names them', async () => {
  await fresh();
  const HINT = 'old_text contains formatting markers or quotes that are not in the document; pass the plain text.';
  // "**...**" alone would match nothing: the plain text's closest match is shown with the hint
  w = await exec('format_text', { old_text: '**Alpha beta gamma ray**', bold: true, italic: null, underline: null });
  assert.ok(!w._ok && w.content.startsWith('Error: old_text not found. Closest match at line 4: «Alpha beta gamma.»; differs at « ray» (old_text) vs «.» (document).\n'), w.content);
  assert.ok(w.content.includes(`\n${HINT} old_text must match the document text`), w.content);
  w = await exec('replace_text', { old_text: "'Omega beta delta.'", new_text: 'x' });
  assert.ok(!w._ok && /Closest match at line 5: «Alpha beta delta\.»; differs at «Omeg»/.test(w.content) && w.content.includes(HINT), w.content);
  // without markers or quotes: no hint
  w = await exec('replace_text', { old_text: 'Alpha beta gamma ray', new_text: 'x' });
  assert.ok(!w._ok && !w.content.includes(HINT), w.content);
  // markers around text with nothing similar: still "no similar text either", no hint
  w = await exec('replace_text', { old_text: '**Zzyzx qwv**', new_text: 'x' });
  assert.ok(!w._ok && /^Error: old_text was not found in the document, and no similar text either\. old_text must match/.test(w.content), w.content);
  assert.strictEqual(fake.revision, 1);
});

test('replace_text keeps embedded objects in the unchanged prefix or suffix', async () => {
  await fresh();
  w = pushTool(await exec('replace_text', { old_text: `Image ${OC} done`, new_text: `Image ${OC} finished` }, 'o1'));
  assert.ok(w._ok, w.content);
  deq(lastPost().requests, [
    { deleteContentRange: { range: { startIndex: w._edit.index, endIndex: w._edit.index + 4, tabId: 't.0' } } },
    { insertText: { location: { index: w._edit.index, tabId: 't.0' }, text: 'finished' } },
  ]);
  assert.ok(!fake.raw('t.0').includes(OC) && fake.text('t.0').includes(`Image ${OC} finished`));
  // an object inside the replaced part is still refused
  w = await exec('replace_text', { old_text: `Image ${OC}`, new_text: 'Picture' });
  assert.ok(!w._ok && /embedded object/.test(w.content));
});
