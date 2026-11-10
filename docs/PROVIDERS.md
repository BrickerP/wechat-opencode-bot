# Providers and models

The bot does not talk to model providers. Each task runs as a session on your OpenCode server, so the bot can use any model that server can reach. The one exception is voice transcription, [below](#voice-messages).

The repository's defaults name `oneapi` providers, the maintainer's gateways, which you probably do not have. This page shows how a task picks its model, a few example setups, and what to change. The examples are examples, not endorsements: use the provider you already have.

## How a task gets its model

The OpenCode server knows its built-in providers, such as `anthropic` and `openai`, and the ones under `providers` in its config. Put yours in the global config, usually `~/.config/opencode/opencode.json`, because tasks run in many project directories. A task runs on the first of these that is set, written `provider/model[#variant]`:

| Order | Model | Set with |
|---|---|---|
| 1 | The chat's `/model` | `/model <model>` in WeChat; `/model default` clears it |
| 2 | The bot's `model` in `bots.json` | A `"model"` field on the bot's entry in the data directory's `bots.json` |
| 3 | The orchestrator's `model:` | The front matter of `config/agents/wechat-orchestrator.md` and `wechat-orchestrator-read.md` |

The subagents have no `model:` line and run on their parent's model.

With 1 and 2 unset, the bot creates the session without a model and assumes `OPENCODE_DEFAULT_MODEL` for routing, that is for the breakers and the fallback. Keep it equal to the orchestrators' `model:`, or failures are charged to the wrong provider.

An upstream failure, such as a 429, a 5xx or a timeout, gets one retry on `OPENCODE_FALLBACK_MODEL`. Without that variable, the retry takes the first model of the built-in chain whose provider differs from the primary's: `oneapi-chat-gpt/gpt-6-astra`, `oneapi/DeepSeek-V4.1-Flash`, then `oneapi-gemini/Gemini 4 Argon`. Each provider id is one gateway with its own breaker; [Model routing](DEPLOY.md#model-routing) has the details.

## Credentials

OpenCode holds the keys, not the bot. Give them to the server the bot talks to, in one of two ways:

- As environment variables of `opencode serve`, named in the provider's `env` list, such as `ANTHROPIC_API_KEY`. `run-server.sh`, which launchd runs, loads `~/.wechat-opencode-bot/env` first, and a server that the daemon starts inherits what the daemon loaded from that file. A server you start by hand sees only your shell's variables.
- In OpenCode's credential store: run `opencode auth login --server http://127.0.0.1:4096` and pick the provider. If the server has a password, have `OPENCODE_SERVER_PASSWORD` in your environment.

In `opencode.json`, refer to a key as `{env:VAR}` or `{file:path}` instead of writing it out.

## Examples

Each example is a fragment for `~/.config/opencode/opencode.json` (global, because tasks run in many directories). Run `/models` in WeChat after a reload; the model ids it lists are the authoritative ones.

Anthropic direct (built-in provider, no `provider` block required when `ANTHROPIC_API_KEY` reaches the server):

```json
{
  "provider": {
    "anthropic": { "options": { "apiKey": "{env:ANTHROPIC_API_KEY}" } }
  }
}
```

Then set the orchestrators to `anthropic/<model-id>`.

OpenAI direct:

```json
{
  "provider": {
    "openai": { "options": { "apiKey": "{env:OPENAI_API_KEY}" } }
  }
}
```

Then `openai/<model-id>`.

Ollama on the same machine:

```json
{
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": { "baseURL": "http://127.0.0.1:11434/v1" },
      "models": { "qwen3-coder:30b": { "name": "Qwen3 Coder 30B" } }
    }
  }
}
```

Then `ollama/qwen3-coder:30b`. Ollama ignores API keys.

Your own OpenAI-compatible gateway (the shape the maintainer's `oneapi` providers use):

```json
{
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My gateway",
      "options": { "baseURL": "https://gateway.example/v1" },
      "models": {
        "my-model": { "name": "My Model", "tool_call": true }
      }
    }
  }
}
```

Then `my-gateway/my-model`. Put the key in the provider's `options.apiKey` as `{env:MY_GATEWAY_KEY}` and add `MY_GATEWAY_KEY` to `~/.wechat-opencode-bot/env`, or use `opencode auth login`.

## Switch the bot's models

1. Edit the `model:` line of **both** `config/agents/wechat-orchestrator.md` and `wechat-orchestrator-read.md` to the primary you want, e.g. `anthropic/<model-id>`.
2. Set `OPENCODE_DEFAULT_MODEL` to the same value and `OPENCODE_FALLBACK_MODEL` to a model on a **different** provider.
3. Optional: set `model` per bot in `~/.wechat-opencode-bot/bots.json`, e.g. `"model": "oneapi/DeepSeek-V4.1-Flash"` for `research`.
4. Run `scripts/install-agents.sh --apply`, then the `opencode reload` command it prints (or restart the server).
5. Verify: in WeChat send `/doctor` (server and agents), `/models`, and `/model`; then run `node dist/main.js --simulate "只回复 ok"`.

A chat's `/model` overrides every bot; `/model default` returns to the bot's own model, then the orchestrator's `model:`.

## Voice messages

Voice works without extra configuration when WeChat includes its own transcription (`voice_item.text`). Otherwise the bot downloads the audio, decodes WeChat's SILK to WAV, and calls an OpenAI-compatible transcription endpoint:

| Variable | Default | Meaning |
|---|---|---|
| `OWB_ASR_URL` | empty | Full endpoint URL, e.g. `https://api.openai.com/v1/audio/transcriptions`. Empty disables transcription |
| `OWB_ASR_MODEL` | `whisper-1` | The model name sent in the multipart body |
| `OWB_ASR_API_KEY` | empty | Sent as `Authorization: Bearer …` when set |

The audio is capped at 30 seconds per request. Without `OWB_ASR_URL`, a voice message that carries no WeChat transcription gets a short "cannot transcribe" reply instead of a task. The endpoint must accept WAV or the original format; SILK is decoded first with [`silk-wasm`](https://www.npmjs.com/package/silk-wasm).

## Files and images sent back

The orchestrator can attach files to its reply by ending with a `<<<WECHAT_FILES>>>` section: one absolute path per line, at most 3, each under the task's workspace and at most 20 MB. The bridge uploads them to the iLink CDN and sends them after the text. Supported: common image formats, PDF, text/Markdown, patch/diff, CSV/JSON and ZIP. A failed upload is logged; attachments are not retried through the text outbox.

