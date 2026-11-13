'use strict';
// The self-test's Your-turn steps (/test asks the user to select, bold and remove text by hand): the card with
// Skip only (the panel watches the document and goes on by itself once it sees the change), the selection read
// back (pass, a wrong selection fails at the timeout, Skip skips the dependent replace), the bold check (Docs API
// read_formatting every second while the API lags, the Markdown export), the removal by the user (pass, the 429
// back-off, the timeout, Skip), Stop while a card waits and the 3-minute timeout (the sandbox timers). The simulated
// user is GOOD_USER of the bench; each test overrides one step.
const { test } = require('node:test');
const assert = require('node:assert');
const { bench, boldInFake, call, say, GOOD_USER, PASTE, statusOf, deq } = require('./lib/selftest-bench');

const GOES_ON = 'The panel continues as soon as it sees the change.';
const SELECT = `In the document, select the words «brown fox» in the test paragraph. ${GOES_ON}`;
const BOLD = `Select the word «quick» in the test paragraph and press Ctrl+B (make it bold). ${GOES_ON}`;
const REMOVE = `Remove the test paragraph: press Ctrl+Z until it is gone, or select it and press Delete. ${GOES_ON}`;
const TYPING = `Click at the end of the test paragraph, type a few letters (no Enter) and delete them. ${GOES_ON}`;

// The step's timeout passes (the card's sandbox timer of ms) after a few of the panel's checks: once the watcher has
// started four more of its waits (ST_WATCH: three checks done since), counted rather than timed, so a busy machine
// does not cut the checks short.
const expire = (x, ms = 180000) => {
  const t = x.env.timers.filter((e) => e.ms === ms).pop();
  const every = [x.T.ST_WATCH.everyMs, x.T.ST_WATCH.exportEveryMs];
  const from = x.env.timers.length;
  const poll = setInterval(() => {
    if (x.env.timers.slice(from).filter((e) => every.includes(e.ms)).length < 4) return;
    clearInterval(poll);
    t.fn();
  }, 1);
};

test('the Your-turn card: the instruction with Skip only, gone once the panel sees the change (no click); the cards of both modes', async () => {
  for (const connected of [true, false]) {
    let html = '';
    const b = await bench({ connected, user: { select: (x, p) => { html = p.card.innerHTML; return GOOD_USER.select(x); } } });
    await b.run('/test');
    assert.ok(html.includes('Your turn'), html);
    assert.ok(html.includes(SELECT), html);
    assert.ok(!html.includes('Continue<'), html);
    assert.match(html, /data-act="preview-skip"[^>]*>Skip</);
    deq(b.turns, connected ? [SELECT, BOLD, TYPING] : [SELECT, BOLD, TYPING, REMOVE]);
    assert.strictEqual(b.T.pendingPreviews.size, 0);
    assert.ok(!b.T.el.chat.children.some((c) => c && c.classList && c.classList.contains('your-turn')), 'no card left in the chat');
    deq(b.cards, [], 'no permission card');
  }
});

test('a different selection keeps the card waiting; at the timeout it fails with what was read, the replace row is skipped, the bold step still runs', async () => {
  for (const connected of [true, false]) {
    const b = await bench({ connected, user: { select: (x) => { x.selection = 'quick brown'; expire(x); return null; } } });
    await b.run('/test');
    const sel = b.row('Your turn: select text');
    deq([sel.status, sel.detail], ['fail', 'read «quick brown» (live), expected «brown fox» (no match within 3 minutes)']);
    deq([b.row('Model: replace the selection').status, b.row('Model: replace the selection').detail], ['skip', 'not run: the selection step did not pass']);
    assert.strictEqual(b.row('Your turn: make text bold').status, 'pass', b.row('Your turn: make text bold').detail);
    assert.ok(!b.keys.some((k) => k.startsWith('replaceSelection')), 'no replace scenario');
  }
  // a non-breaking space in the selection: equal after the panel's cleaning, and the API still finds it
  const n = await bench({ user: { select: (x) => { x.selection = 'brown\u00a0fox '; return null; } } });
  await n.run('/test');
  assert.strictEqual(n.row('Your turn: select text').status, 'pass');
  assert.match(n.row('Your turn: select text').detail, /^read «brown.fox» \(live\): «brown fox» after the panel's cleaning$/);
  assert.strictEqual(n.row('Model: replace the selection').status, 'pass', n.row('Model: replace the selection').detail);
  // nothing selected, read from the content script's cache
  const c = await bench({ connected: false, user: { select: (x) => { expire(x); return null; } } });
  const send = c.env.chrome.tabs.sendMessage;
  c.env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SELECTION' && c.turns.length ? { ok: true, text: '', cached: true } : send(id, msg));
  await c.run('/test');
  deq(c.row('Your turn: select text').detail, 'nothing selected (cached read), expected «brown fox» (no match within 3 minutes)');
});

test('Skip on the selection card: skipped by the user, and the replace row is skipped with it', async () => {
  const b = await bench({ connected: false, user: { select: 'skip' } });
  await b.run('/test');
  const s = statusOf(b.rows());
  deq([s['Your turn: select text'], b.row('Your turn: select text').detail], ['skip', 'skipped by the user']);
  deq([s['Model: replace the selection'], b.row('Model: replace the selection').detail], ['skip', 'not run: the selection step was skipped by the user']);
  deq(b.pastes.length, 1, 'only the insert was pasted');
  for (const n of ['Your turn: make text bold', 'Model: question', 'Your turn: remove the test text']) assert.strictEqual(s[n], 'pass', `${n}: ${b.row(n).detail}`);
});

test('the bold step: not bold by the timeout fails (read_formatting / the Markdown export), wider bold warns, Skip skips', async () => {
  const api = await bench({ user: { bold: (x) => { expire(x); return null; } } }); // nothing is made bold
  await api.run('/test');
  const a = api.row('Your turn: make text bold');
  assert.strictEqual(a.status, 'fail');
  assert.match(a.detail, /^read_document \(formatting\) of line 2 does not show «quick» as bold \(no bold within 3 minutes: \d+ reads in \d+\.\d s\)$/);
  assert.ok(Number(/(\d+) reads/.exec(a.detail)[1]) >= 2, a.detail); // read again and again while the card waits
  assert.match(a.more, /2: The quick red cat jumps over the lazy dog\./);
  assert.strictEqual(api.row('Write: replace_text').status, 'pass', 'the write cycle goes on');
  assert.strictEqual(api.fake.raw('t.0'), '');
  const exp = await bench({ connected: false, user: { bold: (x) => { expire(x); return null; } } });
  await exp.run('/test');
  assert.strictEqual(exp.row('Your turn: make text bold').status, 'fail');
  assert.match(exp.row('Your turn: make text bold').detail,
    /^the Markdown export of line 1 does not show «quick» as bold \(no bold within 3 minutes: \d+ reads? in \d+\.\d s, formatting read from the Markdown export\)$/);
  const wide = await bench({ connected: false, user: { bold: (x) => { x.doc = x.doc.replace('the quick red', '**the quick red**'); return null; } } });
  await wide.run('/test');
  assert.strictEqual(wide.row('Your turn: make text bold').status, 'warn');
  assert.match(wide.row('Your turn: make text bold').detail,
    /^the Markdown export of line 1: the bold text is «the quick red», wider than «quick» \(after \d+ reads? in \d+\.\d s, formatting read from the Markdown export\)$/);
  const skip = await bench({ user: { bold: 'skip' } });
  await skip.run('/test');
  deq([skip.row('Your turn: make text bold').status, skip.row('Your turn: make text bold').detail], ['skip', 'skipped by the user']);
  assert.strictEqual(skip.row('Write: replace_text').status, 'pass');
});

test('the bold step through the Docs API reads every second while the API lags the editor, and passes on the read that shows it', async () => {
  // The Docs API shows a manual Ctrl+B a few seconds late: the first three reads still show plain text.
  const late = await bench({ user: { bold: (x) => {
    const f = x.fake.fetch;
    let gets = 0;
    x.fake.fetch = async (url, init = {}) => {
      if ((init.method || 'GET') === 'GET' && /\/documents\/[^:?]+\?/.test(url) && ++gets === 4) boldInFake(x.fake, 'quick');
      return f(url, init);
    };
    return null;
  } } });
  await late.run('/test');
  const r = late.row('Your turn: make text bold');
  assert.strictEqual(r.status, 'pass', r.detail);
  assert.match(r.detail, /^read_document \(formatting\) of line 2 shows \*\*quick\*\* \(after 4 reads in \d+\.\d s\)$/);
  // bold at once: one read is enough
  const now = await bench();
  await now.run('/test');
  assert.match(now.row('Your turn: make text bold').detail, /^read_document \(formatting\) of line 2 shows \*\*quick\*\* \(after 1 read in \d+\.\d s\)$/);
  // the real intervals: a check every second, the export every 5 s, 120 s after HTTP 429 without Retry-After
  const fresh = await require('./lib/sandbox').load();
  deq(fresh.run('({ ...ST_WATCH })'), { everyMs: 1000, exportEveryMs: 5000, backoffMs: 120000 });
});

test('the removal by the user: seen through the export polls (HTTP 429 backs off), still there at the timeout is a warning; Skip gives the warning of the panel cleanup', async () => {
  const left = await bench({ connected: false, user: { remove: (x) => { expire(x); return null; } } });
  await left.run('/test');
  const r = left.row('Your turn: remove the test text');
  deq([r.status, r.detail], ['warn', 'the document is not empty after 3 minutes (line 1 «Self-test paragraph: the **quick** red cat jumps over the la…»): press Ctrl+Z in Google Docs or delete it by hand']);
  const skip = await bench({ connected: false, user: { remove: 'skip' } });
  await skip.run('/test');
  const k = skip.row('Your turn: remove the test text');
  assert.strictEqual(k.status, 'warn');
  assert.match(k.detail, /^the test paragraph stays in the document \(line 1 «Self-test paragraph: .*»\): press Ctrl\+Z in Google Docs to remove it \(without the Docs API the panel cannot delete it\)$/);
  // HTTP 429 on a poll (three in a row: the export gives up) waits ST_WATCH.backoffMs, then the removal is seen: the
  // panel's timers that ran out, in order with the export requests (not the wall clock, which a busy machine stretches)
  const seq = [];
  const busy = await bench({ connected: false, user: { remove: (x) => {
    const f = x.ctx.fetch;
    const setT = x.ctx.setTimeout;
    let n = 0;
    x.ctx.setTimeout = (fn, ms, ...a) => setT((...y) => { seq.push(`waited ${ms}`); fn(...y); }, ms, ...a);
    x.ctx.fetch = async (url, init) => {
      if (url.includes('/export?')) {
        seq.push('export');
        if (n < 3) { n++; return { ok: false, status: 429, text: async () => '', headers: { get: () => null } }; }
        x.doc = ''; // removed only now: a poll already on its way when the card showed cannot see it before the 429s
      }
      return f(url, init);
    };
    return null;
  } } });
  await busy.run('/test');
  deq([busy.row('Your turn: remove the test text').status, busy.row('Your turn: remove the test text').detail], ['pass', 'removed by the user; the document is empty again']);
  const exports = seq.flatMap((e, i) => (e === 'export' ? [i] : []));
  assert.ok(exports.length >= 4, seq.join(', '));
  const backoff = busy.T.ST_WATCH.backoffMs;
  assert.ok(seq.slice(exports[2], exports[3]).includes(`waited ${backoff}`), `the back-off of ${backoff} ms: ${seq.join(', ')}`);
  assert.ok(!seq.slice(exports[0], exports[2]).includes(`waited ${backoff}`), 'no back-off within the export\'s own retries');
});

test('Stop while a Your-turn card waits ends the run; the panel cleans up after it', async () => {
  // Docs API: the write cycle's test lines are deleted by the panel
  const api = await bench({ user: { select: (x) => { x.state.abort.abort(); return null; } } });
  await api.run('/test');
  let rows = api.rows();
  deq([rows[rows.length - 1].name, rows[rows.length - 1].detail], ['Your turn: select text', 'stopped']);
  assert.ok(api.card()._selfTest.stopped);
  assert.match(api.card()._report, /\*\*Write cycle:\*\* Stopped: cleaned up by the panel: deleted lines 1–2; the document is empty again\./);
  assert.strictEqual(api.fake.raw('t.0'), '');
  assert.strictEqual(api.T.pendingPreviews.size, 0);
  assert.strictEqual(api.state.busy, false);
  // export mode, Stop on the removal card: the paragraph stays and the report says so
  const exp = await bench({ connected: false, user: { remove: (x) => { x.state.abort.abort(); return null; } } });
  await exp.run('/test');
  rows = exp.rows();
  deq([rows[rows.length - 1].name, rows[rows.length - 1].detail], ['Your turn: remove the test text', 'stopped']);
  assert.match(exp.card()._report, /\*\*Model scenarios:\*\* Stopped: the test paragraph stays in the document/);
});

test('no change within 3 minutes fails the row with what the panel saw last (the sandbox timer of the card)', async () => {
  let ms = 0;
  const b = await bench({
    connected: false,
    user: {
      bold: (x) => {
        const t = x.env.timers.filter((e) => e.ms >= 60000).pop();
        ms = t.ms;
        setTimeout(t.fn, 0); // the 3 minutes pass
        return null;
      },
    },
  });
  await b.run('/test');
  assert.strictEqual(ms, 180000);
  const r = b.row('Your turn: make text bold');
  assert.strictEqual(r.status, 'fail');
  assert.match(r.detail, /^(the Markdown export of line 1 does not show «quick» as bold|the document was not read) \(no bold within 3 minutes: /);
  assert.strictEqual(b.row('Your turn: remove the test text').status, 'pass');
  assert.strictEqual(b.T.pendingPreviews.size, 0);
});

test('the selection replacement is checked against the document right before the step: a duplicated paragraph does not fail it', async () => {
  // the user selects «brown fox» while a second copy of the test paragraph is in the document (an earlier failure)
  const dup = (x) => { x.doc = `${PASTE}\n\n${PASTE}\n`; x.selection = 'brown fox'; return null; };
  const b = await bench({ connected: false, user: { select: dup } });
  await b.run('/test');
  const r = b.row('Model: replace the selection');
  assert.strictEqual(r.status, 'pass', r.detail);
  assert.match(r.detail, /^replace_selection replaced the selection «brown fox» through the paste over the selection; line 1 reads «Self-test paragraph: the quick red cat j…»/);
  deq(b.pastes.map((p) => [p.text, p.expected]), [[PASTE, undefined], ['red cat', 'brown fox']]); // replaced once
  // a replacement that adds «red cat» twice still fails, with the counts from before the step
  const c = await bench({ connected: false, user: { select: dup }, script: { replaceSelection: [() => call('replace_selection', { text: 'red cat red cat' }), () => say('Replaced.')] } });
  await c.run('/test');
  const f = c.row('Model: replace the selection');
  deq([f.status, f.detail.split(' · ')[0]], ['fail', 'the document has «red cat» 2 times and «brown fox» 1 time (before the step: «red cat» 0 times and «brown fox» 2 times)']);
});

test('a selection pushed while a Your-turn card waits shows at once (the Selected line, the card); during a turn it waits as before', async () => {
  const seen = {};
  const b = await bench({
    hash: '#tabId=7', connected: false,
    user: {
      select: (x, p) => {
        const before = [p.sees.textContent, x.T.el.selPreview.textContent];
        x.push('brown fox');
        seen.select = [...before, p.sees.textContent, x.T.el.selPreview.textContent, x.state.selection, x.state.pendingSelection];
        x.selection = 'brown fox';
        return null;
      },
      bold: (x, p) => {
        const before = p.sees.textContent; // the latest push, from the start of the wait
        x.push('quick');
        seen.bold = [before, p.sees.textContent, x.T.el.selPreview.textContent];
        return GOOD_USER.bold(x);
      },
      remove: (x, p) => {
        seen.removeSees = p.sees;
        x.push('Self-test paragraph');
        seen.remove = x.T.el.selPreview.textContent;
        x.doc = '';
        return null;
      },
    },
    onRequest: (x, key, round) => { // an ordinary turn of the run (no card): the push is deferred
      if (key !== 'questionExport' || round) return null;
      const line = x.T.el.selPreview.textContent;
      x.push('during a turn');
      seen.turn = [line === x.T.el.selPreview.textContent, x.state.selection !== 'during a turn', x.state.pendingSelection];
      return null;
    },
  });
  await b.run('/test');
  deq(seen.select, ['The panel sees nothing selected yet', '(nothing selected)',
    'The panel sees: «brown fox» (9 characters)', 'brown fox (9 chars)', 'brown fox', 'brown fox']);
  deq(seen.bold, ['The panel sees: «brown fox» (9 characters)', 'The panel sees: «quick» (5 characters)', 'quick (5 chars)']);
  deq(seen.turn, [true, true, 'during a turn']);
  assert.strictEqual(seen.removeSees, null, 'the remove card shows no selection line');
  assert.strictEqual(seen.remove, 'Self-test paragraph (19 chars)');
  for (const n of ['Your turn: select text', 'Model: replace the selection', 'Your turn: make text bold', 'Your turn: remove the test text']) {
    assert.strictEqual(b.row(n).status, 'pass', `${n}: ${b.row(n).detail}`);
  }
  // after the run: the latest push applied (applyPendingSelection), as before
  deq([b.state.selection, b.state.pendingSelection, b.T.el.selPreview.textContent], ['Self-test paragraph', null, 'Self-test paragraph (19 chars)']);
  // idle: shown at once; busy without a card: kept for later
  b.push('idle');
  deq([b.state.selection, b.T.el.selPreview.textContent], ['idle', 'idle (4 chars)']);
  b.state.busy = true;
  b.push('busy');
  deq([b.state.selection, b.state.pendingSelection, b.T.el.selPreview.textContent], ['idle', 'busy', 'idle (4 chars)']);
  b.state.busy = false;
  b.T.applyPendingSelection();
  deq([b.state.selection, b.state.pendingSelection, b.T.el.selPreview.textContent], ['busy', null, 'busy (4 chars)']);
});

// The typing signal row: what the content script delivered during the card (through onRuntimeMessage of the
// embedded panel), the estimate and the read that saw the change (the step goes on by itself then); nothing, one
// kind only, the 60 s timeout.
test('the typing signal: the messages counted by kind and source, the read that saw the change', async () => {
  for (const connected of [true, false]) {
    const b = await bench({ connected, hash: '#tabId=7' });
    await b.run('/test');
    const r = b.row('Your turn: typing signal');
    assert.strictEqual(r.status, 'pass', r.detail);
    assert.match(r.detail, /^DOC_TYPED ×3, DOC_CHANGED ×2 \(page 1, input 1\), estimate \+5 −5 chars, exact read after \d+\.\d s$/);
    assert.strictEqual(b.row('Your turn: remove the test text') ? b.row('Your turn: remove the test text').status : 'pass', 'pass');
  }
  // the messages of another tab do not count
  const other = await bench({ hash: '#tabId=7', user: { typing: (x) => { x.T.onRuntimeMessage({ type: 'DOC_TYPED', tabId: 8, docId: 'DOC123', dChars: 1, dWords: 0 }); expire(x, 60000); return null; } } });
  await other.run('/test');
  deq([other.row('Your turn: typing signal').status, other.row('Your turn: typing signal').detail],
    ['fail', 'nothing arrived from the content script within 60 s: the panel does not see typing in this tab; reload the Docs tab and run /test again']);
});

test('the typing signal: only DOC_TYPED warns; Skip with nothing skips; the 60 s timeout reports what came', async () => {
  const typedOnly = await bench({ user: { typing: (x) => { x.signal({ type: 'DOC_TYPED', dChars: 2, dWords: 0 }); x.fake.revision++; return null; } } });
  await typedOnly.run('/test'); // goes on once the watcher's read saw the change
  const a = typedOnly.row('Your turn: typing signal');
  assert.strictEqual(a.status, 'warn');
  assert.match(a.detail, /^DOC_TYPED ×1, DOC_CHANGED ×0, estimate \+2 chars, exact read after \d+\.\d s: no DOC_CHANGED \(DOC_TYPED alone starts the check\)$/);
  const skip = await bench({ user: { typing: 'skip' } });
  await skip.run('/test');
  deq([skip.row('Your turn: typing signal').status, skip.row('Your turn: typing signal').detail], ['skip', 'skipped by the user']);
  let ms = 0;
  const late = await bench({
    connected: false,
    user: {
      typing: (x) => {
        x.signal({ type: 'DOC_CHANGED', source: 'page', remote: true });
        const t = x.env.timers.filter((e) => e.ms === 60000).pop();
        ms = t.ms;
        setTimeout(t.fn, 0); // the 60 s pass
        return null;
      },
    },
  });
  await late.run('/test');
  assert.strictEqual(ms, 60000);
  const l = late.row('Your turn: typing signal');
  deq([l.status, l.detail], ['warn', 'DOC_TYPED ×0, DOC_CHANGED ×1 (page 1, 1 of them remote, input 0), estimate 0 chars, no export read saw the change (waited 60 s): no DOC_TYPED, so the numbers wait for the read']);
  assert.strictEqual(late.T.pendingPreviews.size, 0);
});

test('the Change signal row: what the content script found; an older content script without the message warns', async () => {
  const miss = await bench();
  const send = miss.env.chrome.tabs.sendMessage;
  miss.env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SIGNAL_STATE'
    ? { ok: true, editor: false, editorSelector: '.kix-appview-editor', observing: false, iframe: true, listening: true, stats: { keydownFrame: 0, keydownPage: 4 } } : send(id, msg));
  await miss.run('/test');
  deq([miss.row('Change signal').status, miss.row('Change signal').detail], ['warn',
    'editor .kix-appview-editor not found · hidden iframe listened to · so far: keys 0 in the iframe and 4 on the page, beforeinput 0, page changes 0: the page observer did not start (best effort; other people\'s edits still come from the poll)']);
  const old = await bench();
  const send2 = old.env.chrome.tabs.sendMessage;
  old.env.chrome.tabs.sendMessage = async (id, msg) => (msg.type === 'GET_SIGNAL_STATE' ? { ok: true } : send2(id, msg));
  await old.run('/test');
  deq([old.row('Change signal').status, old.row('Change signal').detail], ['warn', 'the content script does not report its change signal: reload the Docs tab']);
});
