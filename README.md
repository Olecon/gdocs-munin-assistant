# Munin Assistant for Google Docs

Chrome extension (Manifest V3) that adds an AI assistant panel to Google Docs. The assistant reads the document with tools and edits it: by replacing the selection, or through the Google Docs API with verified, undoable edits. Providers: Munin, OpenAI, Anthropic, with your own API key. No server of its own, no telemetry.

## Install

1. Download the repository (Code → Download ZIP) and unpack it, or clone it.
2. `chrome://extensions` → Developer mode → Load unpacked → the folder with `manifest.json`. Chrome 116 or newer.
3. Open a Google Docs document (reload a tab that was already open) and click the extension icon.

## Setup

- Gear icon → Provider → paste the API key → pick a model. Every change applies at once; a click outside closes the settings. Keys: Munin Chat → Settings → API Keys; [platform.openai.com](https://platform.openai.com/); [console.anthropic.com](https://console.anthropic.com/).
- Optional: Settings → Google account → Sign in with Google. Enables precise edits anywhere in the document through the Docs API, with verification and Undo, plus formatting, tables, headers, footers, footnotes and comments. If the consent window says the app is not verified: Advanced → Go to … → Allow.
- References: citations from a local Zotero 7 library or by DOI. The assistant asks in the chat before it looks up references through Zotero, Crossref or OpenAlex; Allow once, and remove the access in chrome://extensions if you change your mind.

| Provider | API | Default model |
|---|---|---|
| Munin | OpenAI-compatible Chat Completions, `api.muninai.org` | `qwen3.8-27b` |
| OpenAI | Responses API | `gpt-6.1-sol` |
| Anthropic | Messages API | `claude-opus-5-5` |

## Use

- Select text, type a request, press Enter. A click on the mode button under the input opens a menu with **Manual** (the default: answers in the chat with a block you apply with one click), **Edit automatically** (the assistant edits the document) and **Plan** (a numbered plan of edits first; **Do it** carries it out). The **/** button next to it lists the commands. Shift+Enter adds a line; Enter during an answer queues the next message.
- Edits through the Docs API are verified by re-reading the document and get an **Undo** button; **Undo all** reverts an answer's edits together. Large edits, section replacements and edits that remove a citation ask first. A long text is written section by section from an agreed outline with a checklist in the chat; a whole section can be revised paragraph by paragraph.
- Slash commands: `/research` (web search with sources and "Ask about" follow-ups), `/code` (Munin only), `/chat`, `/review` (an independent review: findings that quote the document, with line links and Fix flagged), `/side` (a side question that is not saved), `/check` (a pre-submission report; ask for a CONSORT, PRISMA, STROBE, ARRIVE, CARE or TRIPOD+AI check to get a coverage table), `/test` (self-test on an empty document).
- Document instructions: standing per-document rules sent with every message. "From now on…" / "remember…" adds a rule; "learn my style" saves a style profile. A paper card (question, design, main claims, headline numbers), built once and checked by you, goes with every message too.
- Up to 30 chats per document, shared between the tabs of one document; long chats are condensed automatically. Light and dark themes.

## Privacy

Document text, selection and messages go only to the selected provider with your key. API keys, chats and settings are stored locally in the browser. Policy: https://iyushin.ru/munin/privacy.html

## Update

Pull or download the new version, click the reload icon on the extension card in `chrome://extensions`, reload the Docs tabs.

## License

[MIT](LICENSE)
