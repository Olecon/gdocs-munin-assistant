'use strict';
// The live document line (src/doc-live.js) on a fake clock: the Docs API revision poll (5 s tick, a new revision
// read at once, the 5 s floor), the pause during a turn, the 30 s back-off after a network error, the stop on HTTP
// 403, no polling while hidden or collapsed; the export poll (a read every 60 s without a signal, 120 s after HTTP
// 429); the content script's change signals (DOC_CHANGED of both sources and DOC_TYPED as one signal; with the Docs
// API a revision check 1 s after the last one, a read at once, reads 5 s apart while signals come, one more check
// when Docs had not saved yet, nothing during a turn; on the export path a read 3 s after the last signal, reads
// 20 s apart, HTTP 429 with Retry-After or 120 s of back-off);
// the "as of" part of the status line; the line's format and the typing estimate (DOC_TYPED deltas until the next
// exact read, the clamp at 0, the 60 s drop).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { load, installDocTab, installIdentity } = require('./lib/sandbox');
const { fakeDocsServer, docSpec } = require('./lib/fake-docs');

// Lets the requests of a clock step finish. They chain promises and fake fetches, and a few short real timers (the
// export's 429 retry waits Retry-After: 0): turns of the event loop (setImmediate) until 12 in a row found no short
// timer pending, a real 1 ms wait while one is. (12 waits of 1 ms per step made the idle hour below take 10 s.)
const shortTimers = new Set(); // the panel's pending real timers under 100 ms (trackShortTimers)
const settle = async () => {
  for (let i = 0, quiet = 0; quiet < 12 && i < 1000; i++) {
    if (shortTimers.size) { quiet = 0; await new Promise((r) => setTimeout(r, 1)); } else { quiet++; await new Promise((r) => setImmediate(r)); }
  }
};
function trackShortTimers(ctx) {
  const set = ctx.setTimeout;
  const clear = ctx.clearTimeout;
  shortTimers.clear();
  ctx.setTimeout = (fn, ms, ...a) => {
    if (ms >= 100) return set(fn, ms, ...a);
    const t = set(() => { shortTimers.delete(t); fn(...a); }, ms);
    shortTimers.add(t);
    return t;
  };
  ctx.clearTimeout = (t) => { shortTimers.delete(t); clear(t); };
}

// A manual clock behind docLiveClock: advance(ms) runs the due timers in order and lets each step's requests finish.
function fakeClock(T) {
  const c = { t: Date.UTC(2026, 9, 30, 12, 0, 0), q: [], seq: 0 };
  Object.assign(T.docLiveClock, {
    now: () => c.t,
    setTimeout: (fn, ms) => { const id = ++c.seq; c.q.push({ id, at: c.t + ms, fn }); return id; },
    clearTimeout: (id) => { c.q = c.q.filter((x) => x.id !== id); },
  });
  c.advance = async (ms) => {
    const end = c.t + ms;
    for (;;) {
      c.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const x = c.q[0];
      if (!x || x.at > end) break;
      c.q.shift();
      c.t = x.at;
      x.fn();
      await settle();
    }
    c.t = end;
  };
  return c;
}

let env, T, state, fake, clock, exportLog, exportReply, shown;
const reads = () => fake.log.filter((x) => x.method === 'GET' && x.url.includes('includeTabsContent=true')).length;
const revChecks = () => fake.log.filter((x) => x.method === 'GET' && /\?fields=revisionId$/.test(x.url)).length;
const status = () => T.el.docStatus.textContent;

beforeEach(async () => {
  env = await load({ hash: '#tabId=7' });
  trackShortTimers(env.ctx);
  T = env.T;
  state = env.state;
  const ident = installIdentity(env);
  installDocTab(env);
  await T.refreshContext({ force: true });
  fake = fakeDocsServer(docSpec());
  fake.token = ident.token = 'tok-1';
  ident.granted = true;
  exportLog = [];
  exportReply = () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'Exported text' });
  env.ctx.fetch = async (url, init) => {
    const r = await fake.fetch(url, init);
    if (r) return r;
    if (/\/export\?format=/.test(url)) { exportLog.push(url); return exportReply(url); }
    throw new Error('unexpected fetch ' + url);
  };
  // What reaches the chat (an error or a row of a turn): the live check shows nothing there.
  shown = [];
  env.run('addError; addTurnRow'); // defined
  env.ctx.__shown = shown;
  env.run('addError = (t) => { __shown.push(String(t)); }; addTurnRow = (t) => { __shown.push(String(t)); return true; }');
  env.document.visibilityState = 'visible';
  clock = fakeClock(T);
  Object.assign(T.docLive, { timer: null, dueAt: 0, freshAt: 0, readAt: -Infinity, readDocId: null, stopped: null, notBefore: 0, pending: false, reading: false, sigFirst: 0, sigLast: 0, sigRetry: false, recheckAt: 0, est: null, estTimer: null });
});

const startApi = async () => {
  state.googleConnected = true;
  T.docLiveTick();
  await settle();
};

test('fetchDocRevision asks for the revisionId only; the fake answers that field alone', async () => {
  state.googleConnected = true;
  const rev = await T.fetchDocRevision('DOC123');
  assert.strictEqual(rev, 'rev-1');
  assert.strictEqual(fake.log[0].url, 'https://docs.googleapis.com/v1/documents/DOC123?fields=revisionId');
  const raw = await (await fake.fetch('https://docs.googleapis.com/v1/documents/DOC123?fields=revisionId', { headers: { Authorization: 'Bearer tok-1' } })).json();
  assert.deepStrictEqual(Object.keys(raw), ['revisionId']);
  const bad = await fake.fetch('https://docs.googleapis.com/v1/documents/DOC123?fields=revision', { headers: { Authorization: 'Bearer tok-1' } });
  assert.strictEqual(bad.status, 400);
});

test('Docs API: one full read at start, a revision check every 5 s, a new revision read at once', async () => {
  await startApi();
  assert.strictEqual(reads(), 1);
  assert.strictEqual(status(), T.docStatusText());
  assert.match(status(), /^[\d,]+ characters · [\d,]+ words$/);
  const len0 = state.docText.length;
  await clock.advance(4999);
  assert.strictEqual(revChecks(), 0);
  await clock.advance(1);
  assert.strictEqual(revChecks(), 1);
  await clock.advance(5000);
  assert.strictEqual(revChecks(), 2);
  assert.strictEqual(reads(), 1); // unchanged: no full read
  fake.typeParagraph(1, 'Typed by a collaborator.');
  await clock.advance(5000); // t = 15 s: the new revision is seen and read in the same step
  assert.strictEqual(revChecks(), 3);
  assert.strictEqual(reads(), 2);
  assert.strictEqual(state.docText.length, len0 + 'Typed by a collaborator.'.length + 1);
  assert.strictEqual(state.docModel.revisionId, 'rev-2');
  assert.strictEqual(status(), T.docStatusText());
  await clock.advance(5000);
  assert.strictEqual(reads(), 2); // back to the revision checks
  assert.strictEqual(revChecks(), 4);
  await clock.advance(3600000 - 20000); // an idle hour: 720 checks, no more reads
  assert.strictEqual(revChecks(), 720);
  assert.strictEqual(reads(), 2);
});

test('Docs API: full reads stay 5 s apart (a turn\'s read counts)', async () => {
  await startApi(); // full read at t = 0
  await clock.advance(12000); // checks at 5 and 10 s
  T.useDocModel(await T.fetchDocModel('DOC123', 't.0', false)); // a turn's read at t = 12 s
  assert.strictEqual(reads(), 2);
  fake.typeParagraph(1, 'two');
  await clock.advance(3000); // t = 15 s: the new revision is seen; the floor holds the read until 17 s
  assert.strictEqual(revChecks(), 3);
  assert.strictEqual(reads(), 2);
  await clock.advance(1999);
  assert.strictEqual(reads(), 2);
  await clock.advance(1); // t = 17 s
  assert.strictEqual(reads(), 3);
  assert.ok(state.docText.includes('two'));
});

test('Docs API: no requests while a turn, an undo or the self-test runs; resumes after', async () => {
  await startApi();
  const n = fake.log.length;
  for (const k of ['busy', 'undoing']) {
    state[k] = true;
    fake.typeParagraph(1, 'during ' + k);
    await clock.advance(60000);
    assert.strictEqual(fake.log.length, n, k);
    state[k] = false;
  }
  state.exportPace = { beforeRead: async () => {}, onRequest() {} };
  await clock.advance(30000);
  assert.strictEqual(fake.log.length, n, 'self-test');
  state.exportPace = null;
  await clock.advance(5000);
  assert.strictEqual(revChecks(), 1);
  assert.strictEqual(reads(), 2); // the edits made meanwhile are read at once
});

test('Docs API: a read that ends after a turn started is dropped (the turn snapshot stays its own)', async () => {
  state.googleConnected = true;
  const before = state.docModel;
  const p = T.docLiveTick();
  state.busy = true; // the turn starts while the poll's read is on its way
  await p; await settle();
  assert.strictEqual(reads(), 1);
  assert.strictEqual(state.docModel, before);
  state.busy = false;
});

test('Docs API: a network error backs off to 30 s; HTTP 403 stops the poll, nothing in the chat', async () => {
  await startApi();
  fake.failReads = 1;
  await clock.advance(5000); // the check fails
  const n = fake.log.length;
  await clock.advance(29999);
  assert.strictEqual(fake.log.length, n);
  await clock.advance(1);
  assert.strictEqual(revChecks(), 2);
  assert.deepStrictEqual(shown, []);
  fake.failNext = { status: 403, message: 'The caller does not have permission' };
  await clock.advance(5000);
  assert.ok(T.docLive.stopped);
  const m = fake.log.length;
  await clock.advance(120000);
  assert.strictEqual(fake.log.length, m); // stopped
  // nothing in the chat; the once-only flag stays free for the next turn's read, whose row says why the API failed
  assert.deepStrictEqual(shown, []);
  assert.strictEqual(state.apiWarned, false);
  // a turn reads through the API again: the poll resumes
  T.useDocModel(await T.fetchDocModel('DOC123', 't.0', false));
  const k = revChecks();
  await clock.advance(5000);
  assert.strictEqual(revChecks(), k + 1);
});

test('no timer while hidden or collapsed; nothing is polled until visible again', async () => {
  await startApi();
  env.document.visibilityState = 'hidden';
  await clock.advance(5000); // the pending tick finds the panel hidden
  assert.strictEqual(T.docLive.timer, null);
  assert.strictEqual(clock.q.length, 0);
  env.document.visibilityState = 'visible';
  env.ctx.innerWidth = 0; // collapsed: the iframe has no size
  T.docLiveTick();
  await settle();
  assert.strictEqual(revChecks(), 0);
  assert.strictEqual(clock.q.length, 0);
  env.ctx.innerWidth = 400;
  T.docLiveTick();
  await settle();
  assert.strictEqual(revChecks(), 1);
});

const changed = (source = 'page') => T.onRuntimeMessage({ type: 'DOC_CHANGED', tabId: 7, docId: 'DOC123', source, ...(source === 'page' ? { remote: false } : {}) });

test('export path: a first read, DOC_CHANGED re-reads 3 s after the last signal, reads 20 s apart while signals come', async () => {
  state.googleConnected = false;
  T.docLiveTick();
  await settle();
  assert.strictEqual(exportLog.length, 1);
  assert.strictEqual(state.docText, 'Exported text');
  assert.strictEqual(status(), '13 characters · 2 words');
  await clock.advance(30000);
  assert.strictEqual(exportLog.length, 1); // no signal: no read before the 60 s poll
  T.onRuntimeMessage({ type: 'DOC_CHANGED', tabId: 7, docId: 'OTHER' }); // another document: ignored
  T.onRuntimeMessage({ type: 'DOC_CHANGED', tabId: 8, docId: 'DOC123' }); // another tab: ignored
  await clock.advance(5000);
  assert.strictEqual(exportLog.length, 1);
  exportReply = () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'Exported text, typed' });
  changed('page');
  changed('input'); // the second source of the same typing: one read
  await clock.advance(2999);
  assert.strictEqual(exportLog.length, 1);
  await clock.advance(1); // t = 38 s
  assert.strictEqual(exportLog.length, 2);
  assert.strictEqual(state.docText, 'Exported text, typed');
  for (let i = 0; i < 30; i++) { changed(); await clock.advance(1000); } // the user types for 30 s
  assert.strictEqual(exportLog.length, 3); // at 58 s (20 s after the read), not one per signal
  await clock.advance(9999);
  assert.strictEqual(exportLog.length, 3);
  await clock.advance(1); // t = 78 s: the next 20 s
  assert.strictEqual(exportLog.length, 4);
  await clock.advance(59999);
  assert.strictEqual(exportLog.length, 4); // quiet again: the poll comes 60 s after the last read
  await clock.advance(1);
  assert.strictEqual(exportLog.length, 5);
});

test('export path: HTTP 429 keeps the change pending and backs off for 120 s', async () => {
  state.googleConnected = false;
  T.docLiveTick();
  await settle();
  exportReply = () => ({ ok: false, status: 429, headers: { get: (k) => (k === 'retry-after' ? '0' : null) }, text: async () => '' });
  await clock.advance(30000);
  T.onRuntimeMessage({ type: 'DOC_CHANGED', tabId: 7, docId: 'DOC123' });
  await clock.advance(3000);
  assert.strictEqual(exportLog.length, 4); // the read and its two 429 retries (exportWithRetry)
  assert.strictEqual(state.docText, 'Exported text'); // the previous text stays
  assert.strictEqual(status(), '13 characters · 2 words'); // the retry countdown is gone
  exportReply = () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'After the limit' });
  T.onRuntimeMessage({ type: 'DOC_CHANGED', tabId: 7, docId: 'DOC123' });
  await clock.advance(119000);
  assert.strictEqual(exportLog.length, 4);
  await clock.advance(1000);
  assert.strictEqual(exportLog.length, 5);
  assert.strictEqual(state.docText, 'After the limit');
});

test('export path: a Retry-After longer than the read\'s own wait sets the back-off', async () => {
  state.googleConnected = false;
  T.docLiveTick();
  await settle();
  exportReply = () => ({ ok: false, status: 429, headers: { get: (k) => (k === 'retry-after' ? '45' : null) }, text: async () => '' });
  await clock.advance(30000);
  changed();
  await clock.advance(3000); // the read: 429 asking for 45 s (more than the 30 s exportWithRetry waits itself)
  assert.strictEqual(exportLog.length, 2);
  exportReply = () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'Later' });
  changed();
  await clock.advance(44999);
  assert.strictEqual(exportLog.length, 2);
  await clock.advance(1);
  assert.strictEqual(exportLog.length, 3);
  assert.strictEqual(state.docText, 'Later');
});

const failing = () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => '' });

test('export path: without a signal the export is read every 60 s (a collaborator\'s edits); 429 backs off; not during a turn or while hidden', async () => {
  state.googleConnected = false;
  T.docLiveTick();
  await settle();
  assert.strictEqual(exportLog.length, 1);
  await clock.advance(59999);
  assert.strictEqual(exportLog.length, 1);
  exportReply = () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'Edited by a collaborator' });
  await clock.advance(1); // t = 60 s
  assert.strictEqual(exportLog.length, 2);
  assert.strictEqual(state.docText, 'Edited by a collaborator');
  assert.strictEqual(status(), '24 characters · 4 words');
  // HTTP 429 on the poll (Retry-After 45 s, more than the read's own wait): the next read 45 s later
  exportReply = () => ({ ok: false, status: 429, headers: { get: (k) => (k === 'retry-after' ? '45' : null) }, text: async () => '' });
  await clock.advance(60000); // t = 120 s
  assert.strictEqual(exportLog.length, 3);
  exportReply = () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'Exported text' });
  await clock.advance(44999);
  assert.strictEqual(exportLog.length, 3);
  await clock.advance(1); // t = 165 s
  assert.strictEqual(exportLog.length, 4);
  // during a turn: nothing; the overdue read follows within 5 s of its end
  state.busy = true;
  await clock.advance(120000);
  assert.strictEqual(exportLog.length, 4);
  state.busy = false;
  await clock.advance(5000);
  assert.strictEqual(exportLog.length, 5);
  // hidden: no timer, no read; shown again: the overdue read at once
  env.document.visibilityState = 'hidden';
  await clock.advance(5000);
  assert.strictEqual(clock.q.length, 0);
  await clock.advance(120000);
  assert.strictEqual(exportLog.length, 5);
  env.document.visibilityState = 'visible';
  T.docLiveTick();
  await settle();
  assert.strictEqual(exportLog.length, 6);
});

test('"as of": on the export path once the read is 2 minutes old; never with the Docs API', async () => {
  await startApi();
  fake.failReads = 100; // the checks fail from now on (back-off)
  await clock.advance(300000);
  assert.strictEqual(T.docStatusText(), status());
  assert.ok(!status().includes('as of'), status());
  state.googleConnected = false;
  fake.failReads = 0;
  Object.assign(T.docLive, { readDocId: null, notBefore: 0, timer: null });
  clock.q = [];
  T.docLiveTick();
  await settle();
  assert.strictEqual(state.docText, 'Exported text');
  const at = clock.t;
  exportReply = failing; // the 60 s polls fail from now on
  await clock.advance(120000);
  assert.strictEqual(status(), '13 characters · 2 words');
  await clock.advance(5000); // the next tick repaints the line
  const time = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  assert.strictEqual(status(), `13 characters · 2 words · as of ${time}`);
});

test('the line: characters and words in the locale\'s numbers, singular forms, nothing else', async () => {
  state.googleConnected = false;
  T.docLiveTick();
  await settle();
  state.docText = 'word '.repeat(1234).trim();
  assert.strictEqual(T.docStatusText(), '6,169 characters · 1,234 words');
  state.docText = 'a';
  assert.strictEqual(T.docStatusText(), '1 character · 1 word');
  state.docText = '';
  assert.strictEqual(T.docStatusText(), '0 characters · 0 words');
  state.docText = null;
  assert.strictEqual(T.docStatusText(), 'Document text unavailable');
});

const typed = (dChars, dWords) => T.onRuntimeMessage({ type: 'DOC_TYPED', tabId: 7, docId: 'DOC123', dChars, dWords });

test('typing estimate: the deltas move both numbers at once; a deletion, a paste, the clamp at 0', async () => {
  state.googleConnected = false;
  T.docLiveTick();
  await settle();
  assert.strictEqual(status(), '13 characters · 2 words');
  typed(6, 1); // "hello " typed
  assert.strictEqual(status(), '19 characters · 3 words');
  assert.strictEqual(T.docLineCounts().estimate, true);
  typed(-1, 0); // Backspace
  assert.strictEqual(status(), '18 characters · 3 words');
  typed(24, 4); // a paste of four words
  assert.strictEqual(status(), '42 characters · 7 words');
  T.onRuntimeMessage({ type: 'DOC_TYPED', tabId: 8, docId: 'DOC123', dChars: 100, dWords: 9 }); // another tab: ignored
  T.onRuntimeMessage({ type: 'DOC_TYPED', tabId: 7, docId: 'OTHER', dChars: 100, dWords: 9 }); // another document
  assert.strictEqual(status(), '42 characters · 7 words');
  typed(-1000, -50); // a large deletion: never below 0
  assert.strictEqual(status(), '0 characters · 0 words');
  assert.strictEqual(exportLog.length, 1); // DOC_TYPED alone reads nothing on the export path
});

test('typing estimate: dropped 60 s after the last keystroke without a read; an exact read replaces it', async () => {
  state.googleConnected = false;
  T.docLiveTick();
  await settle();
  exportReply = failing; // the 60 s polls fail: no exact read
  typed(6, 1);
  await clock.advance(30000);
  typed(2, 0); // the 60 s count from here
  await clock.advance(59999);
  assert.strictEqual(status(), '21 characters · 3 words');
  await clock.advance(1);
  assert.strictEqual(status(), '13 characters · 2 words');
  assert.strictEqual(T.docLive.est, null);
  // typing, then the export re-read after DOC_CHANGED: the exact counts win
  typed(5, 1);
  assert.strictEqual(status(), '18 characters · 3 words');
  exportReply = () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'Exported text, typed more' });
  const n = exportLog.length;
  T.onRuntimeMessage({ type: 'DOC_CHANGED', tabId: 7, docId: 'DOC123' });
  await clock.advance(3000);
  assert.strictEqual(exportLog.length, n + 1);
  assert.strictEqual(status(), '25 characters · 4 words');
  assert.strictEqual(T.docLive.est, null);
  assert.strictEqual(T.docLineCounts().estimate, false);
});

test('typing estimate: during a turn the line is not repainted; the turn\'s read resets the deltas', async () => {
  await startApi();
  const line = status();
  state.busy = true;
  T.setStatus('Thinking…');
  typed(10, 2);
  assert.strictEqual(status(), line); // the progress text is only recorded, the estimate waits for the turn's end
  assert.strictEqual(state.statusText.text, 'Thinking…');
  const n = fake.log.length;
  await clock.advance(5000);
  assert.strictEqual(fake.log.length, n); // no early check during a turn
  T.useDocModel(await T.fetchDocModel('DOC123', 't.0', false)); // the turn's own read
  assert.strictEqual(T.docLive.est, null);
  state.busy = false;
  T.setStatus(T.docStatusText());
  assert.strictEqual(status(), line);
});

test('Docs API: a signal checks the revision 1 s after the last one and reads a new revision at once', async () => {
  await startApi(); // full read at t = 0
  T.docLive.started = true;
  await clock.advance(10000);
  const c0 = revChecks(); // the polls at 5 and 10 s
  const line0 = status();
  fake.typeParagraph(1, 'Typed now.');
  typed(4, 1);
  assert.notStrictEqual(status(), line0); // the estimate shows at once
  await clock.advance(500);
  changed('page'); // the three signals of one burst: one check
  changed('input');
  await clock.advance(999);
  assert.strictEqual(revChecks(), c0);
  await clock.advance(1); // 1 s after the last signal
  assert.strictEqual(revChecks(), c0 + 1);
  assert.strictEqual(reads(), 2);
  assert.ok(state.docText.includes('Typed now.'));
  assert.strictEqual(T.docLive.est, null);
  assert.strictEqual(status(), T.docStatusText());
  assert.strictEqual(T.docLineCounts().estimate, false);
  await clock.advance(4999);
  assert.strictEqual(revChecks(), c0 + 1);
  await clock.advance(1);
  assert.strictEqual(revChecks(), c0 + 2); // the poll's 5 s again
});

test('Docs API: full reads 5 s apart while signals keep coming (a collaborator typing)', async () => {
  await startApi(); // full read at t = 0
  T.docLive.started = true;
  await clock.advance(10000);
  const c0 = revChecks(); // the polls at 5 and 10 s
  fake.typeParagraph(1, 'a');
  changed();
  await clock.advance(1000); // t = 11 s: checked and read
  assert.strictEqual(reads(), 2);
  for (let i = 0; i < 12; i++) { fake.typeParagraph(1, 'w' + i); changed(); await clock.advance(1000); } // until t = 23 s
  assert.strictEqual(reads(), 4); // at 16 and 21 s
  assert.strictEqual(revChecks(), c0 + 3); // one per read: no check while the floor holds
  await clock.advance(2999);
  assert.strictEqual(reads(), 4);
  await clock.advance(1); // t = 26 s: the last signals' read
  assert.strictEqual(reads(), 5);
  assert.ok(state.docText.includes('w11'));
});

test('Docs API: a signal before Docs saved: one more check 2 s later, then the poll', async () => {
  await startApi();
  T.docLive.started = true;
  await clock.advance(10000);
  const c0 = revChecks();
  changed(); // the revision has not changed yet
  await clock.advance(1000);
  assert.strictEqual(revChecks(), c0 + 1);
  assert.strictEqual(reads(), 1);
  fake.typeParagraph(1, 'Saved late.');
  await clock.advance(2000);
  assert.strictEqual(revChecks(), c0 + 2);
  assert.strictEqual(reads(), 2);
  changed(); // nothing changes this time: two checks (18 s, 5 s after the read, and 20 s), then the poll (25 s)
  await clock.advance(7000);
  assert.strictEqual(revChecks(), c0 + 4);
  await clock.advance(4999);
  assert.strictEqual(revChecks(), c0 + 4);
  await clock.advance(1);
  assert.strictEqual(revChecks(), c0 + 5);
  assert.strictEqual(reads(), 2);
});

test('Docs API: a signal during a turn waits; the check follows within 1 s of its end', async () => {
  await startApi();
  T.docLive.started = true;
  await clock.advance(10000);
  const n = fake.log.length;
  const c0 = revChecks();
  state.busy = true;
  fake.typeParagraph(1, 'During the turn.');
  changed();
  await clock.advance(20000);
  assert.strictEqual(fake.log.length, n);
  state.busy = false;
  await clock.advance(1000);
  assert.strictEqual(revChecks(), c0 + 1);
  assert.strictEqual(reads(), 2);
});

test('refreshContext keeps the document line instead of "Ready" for the same document', async () => {
  await startApi();
  await T.refreshContext();
  assert.strictEqual(status(), T.docStatusText());
  state.docText = null;
  await T.refreshContext();
  assert.strictEqual(status(), ''); // no read yet: an empty line ("Ready" is only recorded)
  assert.strictEqual(state.statusText.text, 'Ready');
});
