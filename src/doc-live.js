'use strict';
// Module doc-live.js: the live document line ("1,234 characters · 210 words"). While the panel is visible and idle
// (no turn, undo or self-test), the document is re-read when it changes, so the line and the idle state the next
// turn's snapshot is taken from stay current. The content script signals changes (DOC_CHANGED from its page observer,
// which sees a collaborator's edits too, and from the key and input events; DOC_TYPED): with the Docs API a
// documents.get with fields=revisionId follows DOC_LIVE_SIGNAL_MS after the last signal (at the latest
// DOC_LIVE_SIGNAL_GAP_MS after the first), a new revision is read at once, full reads DOC_LIVE_SIGNAL_GAP_MS apart;
// without it (export + paste) the export is read DOC_LIVE_EXPORT_SIGNAL_MS after the last signal, reads
// DOC_LIVE_EXPORT_GAP_MS apart. With the Docs API a revision check every DOC_LIVE_POLL_MS is the fallback (a new
// revision is read once it has been quiet for DOC_LIVE_QUIET_MS, reads DOC_LIVE_MIN_GAP_MS apart). On the export path
// the line says "as of HH:MM" (docAsOfSuffix) once the read is old. Between reads the content script's typing deltas (DOC_TYPED,
// onDocTyped) move the numbers at once (docLineCounts); the next exact read replaces them. Loaded after main.js
// (started by init).
/* global addNotice, docIdFromUrl, docsTabFromUrl, docStatusText, el, fetchDocModel, fetchDocRevision,
   getDocTab, readExport, setDocTitle, setStatus, state, textWords, useDocModel, useExportRead */
/* exported docLiveClock, docLive, markDocRead, docAsOfSuffix, docLineReady, docLineCounts, onDocChanged, onDocTyped,
   startDocLive, docLiveTick, DOC_LIVE_POLL_MS, DOC_LIVE_QUIET_MS, DOC_LIVE_MIN_GAP_MS, DOC_LIVE_BACKOFF_MS,
   DOC_LIVE_STALE_MS, DOC_LIVE_SIGNAL_MS, DOC_LIVE_SIGNAL_GAP_MS, DOC_LIVE_RECHECK_MS, DOC_LIVE_EXPORT_SIGNAL_MS,
   DOC_LIVE_EXPORT_GAP_MS, DOC_LIVE_ESTIMATE_MS */

const DOC_LIVE_POLL_MS = 15000; // revision check (Docs API), and the idle re-check of the other conditions
const DOC_LIVE_QUIET_MS = 5000; // a new revision must stay unchanged this long before the full read
const DOC_LIVE_MIN_GAP_MS = 30000; // between two full reads the poll found (any read counts, a turn's too)
const DOC_LIVE_BACKOFF_MS = 60000; // after a network error, an HTTP 429 or a server error
const DOC_LIVE_STALE_MS = 120000; // export path: "as of" appears once the last read is this old
const DOC_LIVE_SIGNAL_MS = 1000; // Docs API: a revision check this long after the content script's last signal
const DOC_LIVE_SIGNAL_GAP_MS = 5000; // Docs API: between two full reads while signals come (and the longest wait for a check)
const DOC_LIVE_RECHECK_MS = 2000; // Docs API: one more check when the revision had not changed yet (Docs still saving)
const DOC_LIVE_EXPORT_SIGNAL_MS = 3000; // export: a read this long after the last signal (the export lags the editor)
const DOC_LIVE_EXPORT_GAP_MS = 20000; // export: between two reads (and the longest wait while signals keep coming)
const DOC_LIVE_ESTIMATE_MS = 60000; // the typing estimate is dropped when no exact read follows within this time
const DOC_LIVE_WATCH_MS = 500; // a live export read is stopped this soon after a turn starts

// The clock and timers of the poll (tests swap in fake ones).
const docLiveClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
};

const docLive = {
  started: false,
  timer: null,
  dueAt: 0,
  freshAt: 0, // the document was read, or its revision confirmed unchanged, at this time ("as of")
  readAt: -Infinity, // the last full read (or attempt): the DOC_LIVE_MIN_GAP_MS floor
  readDocId: null, // the document of the last read
  seenRev: null, // a revision that differs from the panel's model: waiting for DOC_LIVE_QUIET_MS of quiet
  stopped: null, // { model } after HTTP 401 / 403 / 404 of the poll: no requests until another read succeeds
  notBefore: 0, // back-off: no request before this time
  pending: false, // export path: local typing reported, not read yet
  reading: false,
  sigFirst: 0, // the first change signal (DOC_CHANGED, DOC_TYPED with the Docs API) since the last read or check; 0: none
  sigLast: 0, // the last one
  sigRetry: false, // the check after these signals found the revision unchanged once already: one more at recheckAt
  recheckAt: 0,
  est: null, // the typing estimate: { text (the exact read it adds to), dChars, dWords, at }
  estTimer: null, // drops the estimate DOC_LIVE_ESTIMATE_MS after the last keystroke
  exact: { text: null, chars: 0, words: 0 }, // the counts of state.docText (textWords once per read)
};

// Every read of the document (a turn's, an undo's verify, the poll's) ends here (useDocModel, useExportRead).
function markDocRead() {
  const now = docLiveClock.now();
  docLive.freshAt = now;
  docLive.readAt = now;
  docLive.readDocId = state.docId;
  docLive.seenRev = null;
  docLive.pending = false;
  clearSignal();
  dropEstimate(false);
}

function clearSignal() {
  docLive.sigFirst = 0;
  docLive.sigLast = 0;
  docLive.sigRetry = false;
}

// When the signals allow the next step: delay after the last signal, but no later than gap after the first, and
// never sooner than gap after the last read or before the back-off ends.
function docLiveSignalDue(delay, gap) {
  const soon = Math.min(docLive.sigLast + delay, docLive.sigFirst + gap);
  return Math.max(soon, docLive.readAt + gap, docLive.notBefore);
}

function dropEstimate(repaint = true) {
  docLive.est = null;
  if (docLive.estTimer) docLiveClock.clearTimeout(docLive.estTimer);
  docLive.estTimer = null;
  if (repaint) repaintDocLine();
}

// The numbers of the document line: the last exact read's characters and words plus the typing estimate since then
// (never below 0). { chars, words, estimate }.
function docLineCounts() {
  const text = state.docText || '';
  const ex = docLive.exact;
  if (ex.text !== text) Object.assign(ex, { text, chars: text.length, words: textWords(text).length });
  const est = docLive.est;
  if (!est || est.text !== text || docLiveClock.now() - est.at > DOC_LIVE_ESTIMATE_MS) return { chars: ex.chars, words: ex.words, estimate: false };
  return { chars: Math.max(0, ex.chars + est.dChars), words: Math.max(0, ex.words + est.dWords), estimate: true };
}

// The panel's document line is for the open document (refreshContext keeps it instead of "Ready").
const docLineReady = () => state.docText != null && !!state.docId && docLive.readDocId === state.docId;

// " · as of 14:32" for docStatusText: only on the export path (remote edits are not seen there), once the last read
// is older than DOC_LIVE_STALE_MS. The time in the user's locale.
function docAsOfSuffix() {
  if (!docLive.freshAt || state.docText == null || state.docFormat === 'docs-api') return '';
  if (docLiveClock.now() - docLive.freshAt <= DOC_LIVE_STALE_MS) return '';
  const time = new Date(docLive.freshAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return ` · as of ${time}`;
}

// Visible: the panel's page is shown and not collapsed (a collapsed panel's iframe has no size).
const docLiveVisible = () => typeof document !== 'undefined' && document.visibilityState === 'visible' &&
  typeof window !== 'undefined' && window.innerWidth > 0 && window.innerHeight > 0;
// Idle: nothing that owns the document state is running (the turn snapshot stays frozen).
const docLiveIdle = () => !state.busy && !state.undoing && !state.exportPace && !state.chatWait && !state.loadingCtx;

// The next tick in ms; sooner: only moves an earlier timer, never a later one forward.
function docLiveSchedule(ms, sooner = false) {
  const due = docLiveClock.now() + Math.max(0, ms);
  if (docLive.timer && sooner && docLive.dueAt <= due) return;
  if (docLive.timer) docLiveClock.clearTimeout(docLive.timer);
  docLive.dueAt = due;
  docLive.timer = docLiveClock.setTimeout(() => { docLive.timer = null; docLiveTick(); }, Math.max(0, ms));
}

// The document line again, when it is what the status shows (the "as of" part may have changed).
const DOC_LINE_RE = /^\S+ characters? · \S+ words?(?: · as of .+)?$/;
function refreshDocLine() {
  if (docLiveIdle() && docLineReady() && DOC_LINE_RE.test(el.docStatus.textContent)) setStatus(docStatusText());
}
const repaintDocLine = refreshDocLine;

// One step of the poll. Hidden or collapsed: no timer (visibilitychange / resize start it again).
async function docLiveTick() {
  if (!docLiveVisible()) return;
  let next = DOC_LIVE_POLL_MS;
  try {
    const now = docLiveClock.now();
    if (!docLiveIdle() || docLive.reading || !state.docId) {
      if (docLive.sigFirst) next = DOC_LIVE_SIGNAL_MS; // a signal waits for the end of the turn
      return;
    }
    if (now < docLive.notBefore) { next = docLive.notBefore - now; return; }
    refreshDocLine();
    next = state.googleConnected ? await docLiveApiStep(now) : await docLiveExportStep(now);
  } finally {
    if (!docLive.timer && docLiveVisible()) docLiveSchedule(next);
  }
}

// Docs API: compare the revision with the panel's model; read after DOC_LIVE_QUIET_MS without another change.
async function docLiveApiStep(now) {
  const m = state.docFormat === 'docs-api' && state.docModel && state.docModel.docId === state.docId ? state.docModel : null;
  if (docLive.stopped) {
    if (!m || m === docLive.stopped.model) return DOC_LIVE_POLL_MS;
    docLive.stopped = null; // a turn or an undo has read through the API since: poll again
  }
  if (!m) return docLiveRead(now); // the document was never read through the API here
  if (docLive.sigFirst) return docLiveSignalStep(now);
  const docId = state.docId;
  let rev;
  try { rev = await fetchDocRevision(docId); } catch (e) { return docLiveApiFailed(e); }
  if (!docLiveIdle() || state.docId !== docId) return DOC_LIVE_POLL_MS; // a turn started meanwhile: its own read
  const cur = state.docModel && state.docModel.revisionId;
  if (rev === cur) {
    docLive.seenRev = null;
    docLive.freshAt = docLiveClock.now();
    refreshDocLine();
    return DOC_LIVE_POLL_MS;
  }
  // Still changing? (A signal that came meanwhile reads at its own time.)
  if (docLive.sigFirst) return DOC_LIVE_SIGNAL_MS;
  if (rev !== docLive.seenRev) { docLive.seenRev = rev; return DOC_LIVE_QUIET_MS; }
  return docLiveRead(docLiveClock.now());
}

// Docs API after the content script's signals: the revision check when they allow it (docLiveSignalDue), a full
// read at once when the revision changed; unchanged: one more check DOC_LIVE_RECHECK_MS later (Docs may still be
// saving), then the signals are done.
async function docLiveSignalStep(now) {
  const due = docLive.sigRetry ? Math.max(docLive.recheckAt, docLive.notBefore) : docLiveSignalDue(DOC_LIVE_SIGNAL_MS, DOC_LIVE_SIGNAL_GAP_MS);
  if (now < due) return due - now;
  const docId = state.docId;
  const seen = docLive.sigLast;
  let rev;
  try { rev = await fetchDocRevision(docId); } catch (e) { return docLiveApiFailed(e); }
  if (!docLiveIdle() || state.docId !== docId) return DOC_LIVE_SIGNAL_MS; // a turn started meanwhile: after it
  if (rev !== (state.docModel && state.docModel.revisionId)) return docLiveRead(docLiveClock.now(), DOC_LIVE_SIGNAL_GAP_MS);
  docLive.seenRev = null;
  docLive.freshAt = docLiveClock.now();
  refreshDocLine();
  if (docLive.sigLast !== seen) { docLive.sigFirst = docLive.sigLast; docLive.sigRetry = false; return DOC_LIVE_SIGNAL_MS; } // more came
  if (!docLive.sigRetry) { docLive.sigRetry = true; docLive.recheckAt = docLiveClock.now() + DOC_LIVE_RECHECK_MS; return DOC_LIVE_RECHECK_MS; }
  clearSignal();
  return DOC_LIVE_POLL_MS;
}

// HTTP 401 / 403 / 404 or no Google sign-in: stop and say so once. A Docs API failure of the last turn
// (docsApi refuses until the next turn): skip. Anything else (network, 429, 5xx): back off.
function docLiveApiFailed(e) {
  if (e && e.preSend && state.docsApiFailed) return DOC_LIVE_POLL_MS;
  if (e && (e.status === 401 || e.status === 403 || e.status === 404 || e.preSend)) {
    docLive.stopped = { model: state.docModel };
    if (!state.apiWarned) {
      state.apiWarned = true; // the same once-only flag as fetchDocText's notice
      addNotice(`Could not check the document for changes: ${e.message}`);
    }
    return DOC_LIVE_POLL_MS;
  }
  docLive.notBefore = docLiveClock.now() + DOC_LIVE_BACKOFF_MS;
  return DOC_LIVE_BACKOFF_MS;
}

// Export path: read when a change was signalled (DOC_LIVE_EXPORT_SIGNAL_MS after the last signal, reads
// DOC_LIVE_EXPORT_GAP_MS apart), or this document was never read.
async function docLiveExportStep(now) {
  if (docLive.readDocId !== state.docId) docLive.pending = true;
  if (!docLive.pending) return DOC_LIVE_POLL_MS;
  if (docLive.sigFirst) {
    const due = docLiveSignalDue(DOC_LIVE_EXPORT_SIGNAL_MS, DOC_LIVE_EXPORT_GAP_MS);
    if (now < due) return due - now;
  }
  return docLiveRead(now, DOC_LIVE_EXPORT_GAP_MS);
}

// One full read, no sooner than gap after the last one. A read that ends after a turn started is
// dropped (the turn reads the document itself). Returns the delay of the next tick.
async function docLiveRead(now, gap = DOC_LIVE_MIN_GAP_MS) {
  const wait = docLive.readAt + gap - now;
  if (wait > 0) return wait;
  docLive.reading = true;
  docLive.readAt = now;
  docLive.readDocId = state.docId;
  const api = !!state.googleConnected;
  const ac = new AbortController();
  let watch = null;
  const watchIdle = () => { if (!docLiveIdle()) ac.abort(); else watch = docLiveClock.setTimeout(watchIdle, DOC_LIVE_WATCH_MS); };
  try {
    const tab = await getDocTab();
    const id = docIdFromUrl(tab.url);
    if (!id || id !== state.docId) return DOC_LIVE_POLL_MS;
    if (api) {
      let model;
      try { model = await fetchDocModel(id, docsTabFromUrl(tab.url), false); } catch (e) { return docLiveApiFailed(e); }
      if (!docLiveIdle() || state.docId !== id) return DOC_LIVE_POLL_MS;
      useDocModel(model);
      if (model.title) setDocTitle(model.title);
    } else {
      watchIdle();
      let r;
      try { r = await readExport(tab, setDocTitle, { signal: ac.signal }); } catch (e) {
        // Rate-limited: the change stays pending, the next read after Retry-After (when Google sent one), else 60 s.
        if (!ac.signal.aborted && e.rateLimited) docLive.notBefore = docLiveClock.now() + (e.retryAfterMs > 0 ? e.retryAfterMs : DOC_LIVE_BACKOFF_MS);
        else if (!ac.signal.aborted) { docLive.pending = false; clearSignal(); } // no access or no network: wait for the next signal
        if (docLiveIdle()) setStatus(docStatusText(), state.docText == null); // the retry countdown goes
        return docLive.notBefore > docLiveClock.now() ? docLive.notBefore - docLiveClock.now() : DOC_LIVE_POLL_MS;
      }
      if (!docLiveIdle() || state.docId !== id) return DOC_LIVE_POLL_MS;
      useExportRead(r);
    }
    setStatus(docStatusText());
    return DOC_LIVE_POLL_MS;
  } catch (e) {
    return DOC_LIVE_POLL_MS; // no document tab right now
  } finally {
    if (watch) docLiveClock.clearTimeout(watch);
    docLive.reading = false;
  }
}

// A change signal from the content script. Both DOC_CHANGED sources (the page observer, the key and input events)
// and DOC_TYPED end up here, so a burst that sends all of them costs one check (or read): the signals only move the
// due time (docLiveSignalDue), and the tick decides. During a turn, an undo or the self-test they wait for its end;
// hidden, for the panel to be shown.
function docLiveSignal() {
  const now = docLiveClock.now();
  if (!docLive.sigFirst) docLive.sigFirst = now;
  docLive.sigLast = now;
  docLive.sigRetry = false;
  if (!docLive.started || !docLiveVisible()) return;
  const api = !!state.googleConnected;
  const due = docLiveSignalDue(api ? DOC_LIVE_SIGNAL_MS : DOC_LIVE_EXPORT_SIGNAL_MS, api ? DOC_LIVE_SIGNAL_GAP_MS : DOC_LIVE_EXPORT_GAP_MS);
  docLiveSchedule(due - now, true);
}

// DOC_CHANGED { source: 'page' | 'input', remote? } from the content script (at most one per second per source).
function onDocChanged() {
  docLive.pending = true;
  docLiveSignal();
}

// DOC_TYPED from the content script: the typing deltas since its last message (at most one per 250 ms). They are
// added to the last exact counts and the line is repainted at once; during a turn they only accumulate (the turn
// reads the document anyway). With the Docs API it is a change signal as well (the export path reads after
// DOC_CHANGED only).
function onDocTyped(msg) {
  const dChars = Number(msg && msg.dChars) || 0;
  const dWords = Number(msg && msg.dWords) || 0;
  if (!docLineReady()) return; // nothing exact to add to: the next read decides
  const now = docLiveClock.now();
  const est = docLive.est && docLive.est.text === state.docText && now - docLive.est.at <= DOC_LIVE_ESTIMATE_MS
    ? docLive.est : { text: state.docText, dChars: 0, dWords: 0, at: now };
  est.dChars += dChars;
  est.dWords += dWords;
  est.at = now;
  docLive.est = est;
  if (docLive.estTimer) docLiveClock.clearTimeout(docLive.estTimer);
  docLive.estTimer = docLiveClock.setTimeout(() => { docLive.estTimer = null; dropEstimate(); }, DOC_LIVE_ESTIMATE_MS);
  repaintDocLine();
  if (state.googleConnected) docLiveSignal();
}

// Starts the poll (init, after the first refreshContext): a first read right away when the panel is visible.
function startDocLive() {
  if (docLive.started) return;
  docLive.started = true;
  const wake = () => { if (docLiveVisible() && !docLive.timer) docLiveSchedule(0); };
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', wake);
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', wake);
  wake();
}
