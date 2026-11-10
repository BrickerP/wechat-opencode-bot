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

Each example gives the lines for `~/.wechat-opencode-bot/env` and, when the provider needs one, a block for `opencode.json`. Then follow [Switch the bot's models](#switch-the-bots-models). The model ids are examples too: after a reload, `/models` in WeChat lists the real ones.

### Anthropic

`anthropic` is built in, so it needs no `providers` block. OpenCode reads the key from `ANTHROPIC_API_KEY`.

```bash
ANTHROPIC_API_KEY=<your key>
OPENCODE_DEFAULT_MODEL=anthropic/claude-sonnet-5-5
OPENCODE_FALLBACK_MODEL=anthropic/claude-haiku-5-5
```

### OpenAI

`openai` is built in too. OpenCode reads the key from `OPENAI_API_KEY`.

```bash
OPENAI_API_KEY=<your key>
OPENCODE_DEFAULT_MODEL=openai/gpt-6.1-sol
OPENCODE_FALLBACK_MODEL=openai/gpt-6-luna
```

With keys for both, put the fallback on the other provider, for example `OPENCODE_FALLBACK_MODEL=openai/gpt-6.1-sol` next to an Anthropic default. Then the retry survives an outage of the first provider.

### Ollama

OpenCode probes a local Ollama at `http://127.0.0.1:11434` and adds the models it finds to `/models`, with no account and no config. For an Ollama on another host or port, point the built-in `ollama` provider at its `/v1` endpoint:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "ollama": {
      "settings": { "baseURL": "http://<host>:11434/v1" }
    }
  }
}
```

```bash
OPENCODE_DEFAULT_MODEL=ollama/<model>
OPENCODE_FALLBACK_MODEL=ollama/<another model>
```

The orchestrators hand work to subagents through tool calls, so pick a model that supports tool calling. A model that stays silent for 120 s before its first output fails the attempt; on slow hardware, raise `OPENCODE_FIRST_RESPONSE_TIMEOUT_MS`.

### Your own gateway

An OpenAI-compatible gateway gets a `providers` entry of its own. OpenCode reads its key from the variables listed in `env`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "my-gateway": {
      "name": "My gateway",
      "env": ["MY_GATEWAY_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://gateway.example.com/v1" },
      "models": { "my-model": { "name": "My model" } }
    }
  }
}
```

```bash
MY_GATEWAY_API_KEY=<your key>
OPENCODE_DEFAULT_MODEL=my-gateway/my-model
OPENCODE_FALLBACK_MODEL=<a model on another provider>
```

A gateway that serves several APIs, such as OpenAI's and Anthropic's, gets one provider id per API, each with the matching `package` from [OpenCode's provider docs](https://opencode.ai/docs/providers). The bot treats each id as a separate gateway with its own breaker, but ids on one host share that host's outages: a fallback to another id on the same host fails with it.

The `oneapi` defaults are the maintainer's gateways, set up this way: one provider id per API, on two hosts. Without `OPENCODE_FALLBACK_MODEL`, the orchestrators' `oneapi/DeepSeek-V4.1-Flash` falls back to `oneapi-chat-gpt/gpt-6-astra`, which runs on the other host.

Configs written for OpenCode 1, the maintainer's included, put providers under a `provider` key, with an `npm` package such as `@ai-sdk/openai-compatible` and an `options` block. OpenCode 2 still accepts that key but marks it deprecated. Do not mix the shapes: the schema rejects `npm` and `options` under `providers`, and `package` and `settings` under `provider`.

## Switch the bot's models

1. Set `model:` in both `config/agents/wechat-orchestrator.md` and `config/agents/wechat-orchestrator-read.md` to your default model.
2. In `~/.wechat-opencode-bot/env`, set `OPENCODE_DEFAULT_MODEL` to the same model, and `OPENCODE_FALLBACK_MODEL` to a model on a different provider. Without a fallback, the retry goes to `oneapi-chat-gpt/gpt-6-astra` and fails, and while your provider's breaker is open, every new task starts on that fallback and fails. With a single provider, pick another of its models: that helps when one model is overloaded, not when the provider is down.
3. Change or remove any `model` in `~/.wechat-opencode-bot/bots.json` that names a provider you lack. The built-in bots set none.
4. Load the prompts: `scripts/install-agents.sh --apply`, then the `opencode reload` command it prints. On a bot deployed from releases, release and deploy the commit with the change instead, as [config/agents/README.md](../config/agents/README.md) describes.
5. Restart the daemon so it reads `env` again, and the server if its keys changed. [launchd](DEPLOY.md#launchd) has the commands.

## Check it works

1. `/models` in WeChat lists the models the server can reach, by provider. Yours must be among them.
2. `/model <provider/model>` checks the name against the server and uses it for the chat's next tasks. `/model default` goes back to each bot's `model`, or the orchestrator's when the bot sets none.
3. `/doctor` checks the server, the four agents, the message token, the outbox, the databases, the breakers and the routines. It never calls a model, so a bad key still passes.
4. `node dist/main.js --simulate "只回复 ok"` runs one real task and prints the reply. It ignores the chat's `/model`, so it tests the default bot's model, or the orchestrator's.
5. Each `Task finished` line in `~/.wechat-opencode-bot/logs/` records `model`, `attempts`, `fallback` and `errorKind`. `fallback: true` means the task ran on the fallback, because the primary failed or its breaker was open.

## Voice messages

Voice transcription bypasses OpenCode. When WeChat sends no transcript of its own, the daemon downloads the audio, decodes WeChat's SILK format to WAV, and posts it to an OpenAI-compatible transcription endpoint. Audio in another format is sent as it is. Put these in `~/.wechat-opencode-bot/env`:

| Variable | Default | Meaning |
|---|---|---|
| `OWB_ASR_URL` | empty, transcription off | The endpoint, such as `https://api.openai.com/v1/audio/transcriptions` |
| `OWB_ASR_MODEL` | `whisper-1` | The `model` field of the request |
| `OWB_ASR_API_KEY` | empty | Sent as `Authorization: Bearer <key>` |

A request gets 30 s. When it fails, the bot asks you to send the message again or type it. Without `OWB_ASR_URL`, it says which variables to set.

## Files and images sent back

Either orchestrator can attach up to 3 files to its reply, as a `<<<WECHAT_FILES>>>` section at the end of its output with one absolute path per line. Each must be a regular file, not a symlink, whose real path is inside the task's workspace, of at most 20 MB and of one of these types: png, jpg, jpeg, gif, webp, bmp, pdf, txt, md, patch, diff, csv, json or zip. The daemon uploads each file to the iLink CDN and sends it after the text, images as images and the rest as files. A path that fails a check is dropped: the log says why, and the reply says how many did not come.

Files never enter the outbox. A file that fails to upload or send is logged and not retried, and while the text still waits in the outbox, the files are not sent at all.
