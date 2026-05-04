# openclaw-channel-telegram-userbot

OpenClaw channel plugin that connects your **personal Telegram account** (not a bot) to OpenClaw via MTProto. Your AI assistant responds as **you** — from your real Telegram account.

## Features

- **MTProto via GramJS** — full Telegram user API, not the limited Bot API
- **Media support** — photos, videos, documents, voice, stickers, animations (inbound & outbound)
- **Reply context** — AI sees the quoted message when someone replies
- **Conversation memory** — multi-turn context with configurable history depth, persisted to disk
- **System prompts** — per-chat or global system prompt for AI personality
- **Markdown formatting** — bold, italic, code, strikethrough, spoilers in AI responses
- **DM and group chat support** — with configurable mention requirements
- **Machine-bound session encryption** — AES-256-GCM, sessions are useless on another device
- **Human-like reply delay** — configurable pause + typing indicator before responding
- **Chat allowlist / denylist** — control which chats the assistant can access
- **Per-group settings** — different behavior for different groups

## Requirements

- OpenClaw >= 2026.4.14
- Telegram API credentials from [my.telegram.org](https://my.telegram.org)
- Bun >= 1.0 or Node.js >= 22

## Installation

```bash
npm install
npm run build
openclaw plugins install --force .
```

This plugin is packaged as a standard external OpenClaw channel and installs from the local repo or from the generated `.tgz` tarball.

## Setup

### 1. Get Telegram API credentials

Go to [my.telegram.org](https://my.telegram.org), create an app, and note the `api_id` and `api_hash`.

### 2. Generate session string

```bash
cd openclaw-channel-telegram-userbot
npm run auth
```

Follow the prompts to log in. You'll receive a session string (optionally encrypted with your machine ID).

### 3. Configure OpenClaw

```bash
openclaw config set channels.telegram-userbot.apiId 12345678
openclaw config set channels.telegram-userbot.apiHash "your_api_hash"
openclaw config set channels.telegram-userbot.sessionString "your_session_string"
```

Or add to `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    "telegram-userbot": {
      apiId: 12345678,
      apiHash: "abc123...",
      sessionString: "1BQA...",
      allowFrom: ["*"],
      replyDelaySec: 2,
      conversations: {
        defaultSystemPrompt: "Reply as a concise, practical assistant."
      },
      groups: {
        "*": { requireMention: true },
        "-1001234567890": {
          systemPrompt: "This is a work group. Keep replies brief and professional."
        }
      }
    }
  }
}
```

### 4. Enable and restart

```bash
openclaw plugins enable telegram-userbot
```

This plugin does not currently participate in OpenClaw's interactive setup wizard. Configure `channels.telegram-userbot.*` directly, then enable it.

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `apiId` | number | required | Telegram API ID |
| `apiHash` | string | required | Telegram API Hash |
| `sessionString` | string | required | GramJS session (from auth helper) |
| `allowFrom` | string[] | `["*"]` | Allowed chat IDs (`*` = all) |
| `denyFrom` | string[] | `[]` | Denied chat IDs (overrides allowFrom) |
| `replyDelaySec` | number | `2` | Delay before reply (seconds) |
| `groups` | object | `{}` | Per-group settings |
| `groups.*.requireMention` | boolean | `false` | Only respond when mentioned |
| `groups.*.enabled` | boolean | `true` | Enable/disable group |
| `groups.*.systemPrompt` | string | `""` | Extra system prompt appended for that group |
| `conversations.maxMessages` | number | `20` | Max messages per chat history |
| `conversations.defaultSystemPrompt` | string | `""` | Default system prompt for all chats |
| `conversations.systemPrompts` | object | `{}` | Per-chat prompt overrides keyed by Telegram chat ID |
| `conversations.dataDir` | string | `~/.openclaw/telegram-userbot` | History storage path |

## Security

Session strings are **encrypted with your machine's hardware ID** by default (AES-256-GCM via `node-machine-id`). Encrypted sessions are useless if copied to another machine.

Override with a custom key:

```bash
export OPENCLAW_TELEGRAM_SESSION_KEY=my-secret-key
```

**Conversation data:** History is stored in `~/.openclaw/telegram-userbot/` as JSON files. These may contain sensitive chat content. Ensure appropriate file permissions on multi-user systems.

**Recommendations:**
- Use a secondary Telegram account
- Check Telegram → Settings → Devices periodically
- Use `allowFrom` / `denyFrom` to limit access
- Set `replyDelaySec` > 0 to avoid rate limits

## Development

```bash
npm install
npm run build        # compile dist/
npm run typecheck    # TypeScript check
npm test             # run tests
npm run lint         # check code with Biome
npm run lint:fix     # auto-fix
```

## License

MIT

## Related

- [mcp-telegram](https://github.com/overpod/mcp-telegram) — Telegram MCP server (59 tools)
- [mcp-whatsapp](https://github.com/gridmint/mcp-whatsapp) — WhatsApp MCP server
