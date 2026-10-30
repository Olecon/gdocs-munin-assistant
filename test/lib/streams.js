'use strict';
// Fake streaming responses: an SSE body split into odd-sized chunks (sseResponse), SSE events (ev) and
// builders for Anthropic Messages API rounds (msgStart, tu, stopTool, textRound).

// Synthetic SSE response: the text is split into odd-sized chunks to exercise the line buffering.
function sseResponse(text, status = 200) {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  let pos = 0;
  const sizes = [7, 13, 31, 64, 5, 128];
  let i = 0;
  return {
    ok: status >= 200 && status < 300, status,
    text: async () => text,
    body: { getReader: () => ({ read: async () => {
      if (pos >= bytes.length) return { done: true, value: undefined };
      const n = sizes[i++ % sizes.length];
      const chunk = bytes.slice(pos, pos + n); pos += n;
      return { done: false, value: chunk };
    } }) },
  };
}
const ev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

// Anthropic rounds: a tool_use block, the message start / tool-use stop, a final text round.
const tu = (index, id, name, input) => ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }) +
  ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }) +
  ev('content_block_stop', { type: 'content_block_stop', index });
const msgStart = ev('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 50 } } });
const stopTool = ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }) + ev('message_stop', { type: 'message_stop' });
const textRound = (t) => msgStart + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
  ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }) +
  ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) + ev('message_stop', { type: 'message_stop' });

module.exports = { sseResponse, ev, tu, msgStart, stopTool, textRound };
