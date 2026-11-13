'use strict';
// Module chat-title.js: chat titles given by the model. The automatic title: after a turn of a chat that has only its
// first-message title, one quiet request on the turn's provider asks for a title of a few words (autoTitle, on the
// finish hook); the chat_title tool lets the model read the title or rename the chat. Both store the title on the
// chat's meta with titleBy 'model' (setChatTitle in chats.js), and the chat switcher follows at once. The title is not
// put into the turn context: the model reads it with the tool when it needs it.
// Cost: one request of a few hundred tokens per new chat (the first message, the beginning of its answer, a short
// instruction); no retry after a failure.
/* global canRequest, chatBody, anthropicHeaders, apiUrl, bearerHeaders, CHAT_TITLE_ANSWER_CHARS, CHAT_TITLE_MAX_WORDS, CHAT_TITLE_MESSAGE_CHARS,
   CHAT_TITLE_NAMED_MAX, CHAT_TITLE_REPLY_TOKENS, cachesPrompt, chatAsked, chatLabel, DOC_PASS_MODES, isMuninPersona, MUNIN_REASONING_EFFORT,
   needsAutoTitle, openaiReasoningModel, parseSlashCommand, readChatMeta, registerTools, registerTurnHook, samplingFields,
   setChatTitle, streamAnthropic, streamChat, streamResponses */
/* exported CHAT_TITLE_PROMPT, CHAT_TITLE_TOOL, cleanChatTitle, parseChatTitle, chatTitleMaterial, chatTitleRequest,
   autoTitleOn, autoTitle, cancelAutoTitles, chatTitleTool */

const CHAT_TITLE_PROMPT = "Write a title for the chat below: 3 to 6 words naming its topic, in the language of the user's message. " +
  'Reply with the title only: no quotes, no period, no Markdown.';

// A given title: one line, whitespace collapsed, at most CHAT_TITLE_NAMED_MAX characters.
function cleanChatTitle(raw) {
  const t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  return t.length > CHAT_TITLE_NAMED_MAX ? t.slice(0, CHAT_TITLE_NAMED_MAX - 1).trimEnd() + '…' : t;
}

// The title in a model's reply, or '' (nothing usable: the chat keeps its first-message title). Reasoning a server left
// in the text is dropped; the first non-empty line counts, without a "Title:" label, Markdown, quotes or a final
// period; a reply of more than CHAT_TITLE_MAX_WORDS words is a sentence, not a title.
const TITLE_QUOTES = '"\'`«»“”„‘’';
function parseChatTitle(raw) {
  let t = String(raw == null ? '' : raw).replace(/<think>[\s\S]*?<\/think>/gi, '');
  const closed = t.toLowerCase().lastIndexOf('</think>');
  if (closed >= 0) t = t.slice(closed + 8);
  const open = t.toLowerCase().indexOf('<think>');
  if (open >= 0) t = t.slice(0, open);
  const line = t.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const edge = new RegExp(`^[\\s${TITLE_QUOTES}]+|[\\s${TITLE_QUOTES}.]+$`, 'g');
  const s = line.replace(/^#{1,6}\s+/, '').replace(/[*_`]+/g, '')
    .replace(/^(?:chat title|title|название чата|название|заголовок)\s*[:：]\s*/i, '').replace(edge, '');
  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > CHAT_TITLE_MAX_WORDS) return '';
  return cleanChatTitle(s);
}

// The material of the title request: the chat's first user message (not a request of the panel, a summary or a document
// pass) and the beginning of its answer; the answer of the turn just finished when that one has no text. '' when there
// is no message to name.
function chatTitleMaterial(messages, userMsg) {
  const list = Array.isArray(messages) ? messages : [];
  const isAsk = (m) => m && m.role === 'user' && !m._auto && !m._summary;
  const first = list.find((m) => isAsk(m) && !DOC_PASS_MODES.includes(m._persona) && typeof m.content === 'string' && m.content.trim());
  if (!first) return '';
  const answerOf = (ask) => {
    const out = [];
    for (let i = list.indexOf(ask) + 1; i < list.length && !isAsk(list[i]); i++) {
      if (list[i].role === 'assistant' && typeof list[i].content === 'string' && list[i].content.trim()) out.push(list[i].content.trim());
    }
    return out.join('\n\n');
  };
  const answer = answerOf(first) || (userMsg && userMsg !== first && list.includes(userMsg) ? answerOf(userMsg) : '');
  const message = parseSlashCommand(first.content).text.slice(0, CHAT_TITLE_MESSAGE_CHARS);
  if (!message.trim()) return '';
  return `<user_message>\n${message}\n</user_message>` + (answer ? `\n\n<answer_start>\n${answer.slice(0, CHAT_TITLE_ANSWER_CHARS)}\n</answer_start>` : '');
}

// One title request on the turn's provider: no tools, no chat history, no document; low reasoning where the provider
// thinks (the reply cap leaves room for it).
function chatTitleRequest(snap, user) {
  const { prov, cfg } = snap;
  if (prov.id === 'openai') {
    const body = { model: cfg.model, instructions: CHAT_TITLE_PROMPT, input: [{ role: 'user', content: user }], max_output_tokens: CHAT_TITLE_REPLY_TOKENS.openai, stream: true, store: false };
    if (openaiReasoningModel(cfg.model)) body.reasoning = { effort: 'low' };
    return { kind: 'responses', url: apiUrl(snap, '/responses'), headers: bearerHeaders(cfg), body, tools: [] };
  }
  if (prov.id === 'anthropic') {
    const body = { model: cfg.model, max_tokens: CHAT_TITLE_REPLY_TOKENS.anthropic, system: CHAT_TITLE_PROMPT, messages: [{ role: 'user', content: user }], stream: true };
    return { kind: 'anthropic', url: apiUrl(snap, '/messages'), headers: anthropicHeaders(cfg), body, tools: [] };
  }
  const body = {
    model: cfg.model, persona: 'raw', max_tokens: CHAT_TITLE_REPLY_TOKENS.munin, stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'system', content: CHAT_TITLE_PROMPT }, { role: 'user', content: user }],
    chat_template_kwargs: { reasoning_effort: MUNIN_REASONING_EFFORT }, ...samplingFields(prov, 'summary'),
  };
  return { kind: 'chat', url: apiUrl(snap, '/chat/completions'), headers: bearerHeaders(cfg), body: chatBody(prov, body), tools: [] };
}

// The stream clients directly, not runStream: one attempt, and no "retrying" text on the status line.
function streamOnce(req, signal, snap) {
  if (req.kind === 'responses') return streamResponses(req, signal, snap, {});
  if (req.kind === 'anthropic') return streamAnthropic(req, signal, snap, {});
  return streamChat(req, signal, snap, {});
}

// ---- The automatic title ------------------------------------------------------------------------------------------
// Whether the automatic title runs at all (the tests switch it off unless they ask for it).
function autoTitleOn() { return true; }
const titleRuns = new Map(); // "<docId>:<chatId>" -> the AbortController of its title request
// Cancels the title requests in flight (a new turn starts): quietly, and not counted as an attempt.
function cancelAutoTitles() {
  for (const a of titleRuns.values()) a.abort();
  titleRuns.clear();
}

// The finish hook: after a main-chat turn that was not stopped, for a chat without a given title and without a failed
// attempt (needsAutoTitle), one request in the background; the panel does not wait for it. A usable title is stored with
// titleBy 'model'; an error or an unusable reply marks the attempt (titleTried) and the first-message title stays.
// Not for side questions, the self-test, agents or document passes. Returns the promise (the tests await it).
async function autoTitle(userMsg, snap, chatCtx) {
  if (!autoTitleOn() || !userMsg || !snap || !chatCtx || !chatCtx.docId || !chatCtx.chatId) return;
  if (snap.quiet || snap.side || snap.agent || (snap.signal && snap.signal.aborted)) return;
  if (DOC_PASS_MODES.includes(userMsg._persona) || !snap.prov || !snap.cfg || !canRequest(snap.cfg)) return;
  const { docId, chatId } = chatCtx;
  const key = docId + ':' + chatId;
  if (titleRuns.has(key)) return;
  const abort = new AbortController();
  titleRuns.set(key, abort);
  try {
    if (!needsAutoTitle(await readChatMeta(docId, chatId))) return;
    const material = chatTitleMaterial(chatCtx.messages, userMsg);
    if (!material || abort.signal.aborted) return;
    let title = '';
    try {
      title = parseChatTitle((await streamOnce(chatTitleRequest(snap, material), abort.signal, snap)).content);
    } catch (e) {
      if (abort.signal.aborted || e.name === 'AbortError') return; // cancelled: a later turn may ask again
    }
    if (abort.signal.aborted) return;
    await setChatTitle(docId, chatId, title ? { title, by: 'model', onlyAuto: true } : { tried: true });
  } finally {
    if (titleRuns.get(key) === abort) titleRuns.delete(key);
  }
}
registerTurnHook('finish', autoTitle);
// A new main turn takes over the provider: a title request still running goes.
registerTurnHook('beforeStart', () => cancelAutoTitles());

// ---- The chat_title tool ------------------------------------------------------------------------------------------
const CHAT_TITLE_TOOL = { type: 'function', function: {
  name: 'chat_title',
  description: "Read or change this chat's title (3–6 words). Call with title null to read it; set it when the user asks to rename the chat or when the topic clearly changed.",
  parameters: {
    type: 'object',
    properties: { title: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The new title, or null to read it.' } },
    required: ['title'],
    additionalProperties: false,
  },
} };

async function chatTitleTool(args, snap) {
  const c = snap && snap.chatCtx;
  if (!c || !c.docId || !c.chatId) return 'Error: this message belongs to no chat.';
  const given = args ? args.title : null;
  if (given == null) {
    const meta = await readChatMeta(c.docId, c.chatId);
    if (!meta) return 'Error: this chat no longer exists.';
    return { content: `Chat title: ${chatLabel(meta)}`, _ok: true, _message: `Chat title: ${chatLabel(meta)}` };
  }
  if (typeof given !== 'string') return 'Error: title must be a string, or null to read the title.';
  const title = cleanChatTitle(given);
  if (!title) return 'Error: the title is empty. Give 3–6 words, or null to read the title.';
  const meta = await setChatTitle(c.docId, c.chatId, { title, by: 'model' });
  if (!meta) return 'Error: the title could not be saved (the chat was deleted, or the browser storage failed).';
  return { content: `Chat title now: ${title}`, _ok: true, _message: `Chat renamed: ${title}` };
}

// A message about the chat's name (English and Russian stems): "rename this chat", "what is the title", "переименуй",
// "название чата", "заголовок".
const TITLE_ASK_RE = /\b(?:title[ds]?|re-?nam\w*|name (?:this|the) chat)\b|переимен|назван\p{L}* чат|заголов/iu;
const titleAsked = (text) => TITLE_ASK_RE.test(text);
registerTools(CHAT_TITLE_TOOL, {
  // Turns of the chat itself: not an agent's, a side question's (it leaves nothing behind) or the self-test's (its
  // quiet loops run on a scratch history of the open chat), and not Munin persona turns (no client tools there).
  // A provider with a prompt cache always gets it (a stable tool list); Munin and custom servers (no cache, a small
  // window) only when the message is about the title.
  offer: (mode, snap) => !!snap && !!snap.prov && !snap.agent && !snap.side && !snap.quiet && !isMuninPersona(mode, snap) &&
    !!(snap.chatCtx && snap.chatCtx.chatId) && (cachesPrompt(snap.prov) || chatAsked(snap, titleAsked)),
  // A read (title null) is a quiet reading call (its result is far too short to be stubbed); a rename is a write without
  // the edit gate (anyMode: it runs outside an editing turn too).
  reading: (name, args) => !args || args.title == null,
  anyMode: true,
  pending: 'Chat title…',
  run: (name, args, snap) => chatTitleTool(args, snap),
  summary: (name, args) => (args && typeof args.title === 'string' ? `«${cleanChatTitle(args.title)}»` : 'read'),
});
