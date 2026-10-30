'use strict';
// A streaming response the test feeds chunk by chunk (liveStream), and one whose reader fails after a
// number of chunks (failingStream), for checks of what the panel shows while a stream runs.
const enc = new TextEncoder();

// s.response is a fetch Response; s.push(text) delivers one chunk, s.end() ends the body,
// s.fail(err) makes the pending/next read reject. s.reads counts read() calls.
function liveStream(status = 200) {
  const queue = [];
  let wake = null;
  const s = {
    reads: 0,
    push(text) { queue.push({ value: enc.encode(text) }); if (wake) wake(); },
    end() { queue.push({ done: true }); if (wake) wake(); },
    fail(err) { queue.push({ error: err }); if (wake) wake(); },
    response: {
      ok: status >= 200 && status < 300, status, text: async () => '',
      body: { getReader: () => ({ read: async () => {
        s.reads++;
        while (!queue.length) await new Promise((r) => { wake = r; });
        wake = null;
        const item = queue.shift();
        if (item.error) throw item.error;
        if (item.done) return { done: true, value: undefined };
        return { done: false, value: item.value };
      } }) },
    },
  };
  return s;
}

// A response that streams the given chunks, then throws err from read() (e.g. a TypeError: network error).
function failingStream(chunks, err) {
  let i = 0;
  return {
    ok: true, status: 200, text: async () => '',
    body: { getReader: () => ({ read: async () => {
      if (i < chunks.length) return { done: false, value: enc.encode(chunks[i++]) };
      throw err;
    } }) },
  };
}

module.exports = { liveStream, failingStream };
