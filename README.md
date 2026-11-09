# wechat-opencode-bot

English | [中文](README_zh.md)

Run OpenCode tasks from WeChat. Each message you send from your phone becomes a task: the bot runs it on a local OpenCode server and sends the result back. It handles text, images and permission approvals, routes messages to bots and projects, and keeps a short memory per chat.

## How it works

```
WeChat (phone) ←→ ilink bot API ←→ bot daemon (Node.js) ←→ OpenCode server (127.0.0.1:4096)
```

- The daemon long-polls the WeChat ilink bot API. It only listens to the WeChat users in `WECHAT_ALLOWED_IDS`, by default the account that ran the setup.
- A message that is not a command becomes a task. One write task and one read task (from a read-only bot such as @research) run at a time; new messages queue behind their lane (`⏳ 已排队：任务 #N（前面还有 X 个任务）`) and run in order. A task that waits more than 24 hours expires.
- Each task runs in a new OpenCode session on the `wechat-orchestrator` agent; a read-only bot's task runs on `wechat-orchestrator-read`, which can only start the read-only subagent. Sessions are never resumed: the bot puts the context into the prompt, namely the last 8 tasks (with reply excerpts for the latest 2) and the chat's memory.
- A model whose gateway fails or goes silent gets one retry behind a different gateway (`OPENCODE_FALLBACK_MODEL`, or the cross-gateway chain). Three upstream failures in a row open that gateway's breaker: later tasks start on the fallback, one notice tells you, and the gateway is tried again after 10 minutes (doubling up to an hour). You only hear the final outcome.
- Replies go out in chunks of 2048 characters. WeChat takes a reply only on a recent message token, so a reply that cannot go out waits in an outbox and is sent after your next message.
- Images are kept for 24 hours. A text-only task that comes within 10 minutes after a task with images reuses those images.
- A bot restart interrupts the running task with a ⏹ notice; queued tasks still run.

## Bots and projects

### Bots

`~/.wechat-opencode-bot/bots.json` lists the bots that answer in the chat. The bot writes it on first use and re-reads it for every message; invalid entries are skipped. The default roster:

| id | Name | Aliases | Reply prefix | Hands work to |
|---|---|---|---|---|
| `chief` (default) | Chief | chief, 总管 | none | — |
| `research` | 研究 | research, 研究 | 研究： | `wechat-explore` |
| `eng` | 工程 | eng, 工程, code | 工程： | `wechat-general` |
| `ops` | Ops | ops, 运维 | Ops： | `wechat-general` |

- Start a message with `@alias` to pick a bot. Without one, the default bot answers; the bot is never guessed from the text.
- `@all` or `@everyone` goes to the default bot, which runs up to 3 subagents at once and sends one merged reply.

### Projects

`~/.wechat-opencode-bot/projects.json` maps aliases to project directories. The bot generates it from the child directories of the working directory, plus the working directory itself when it has `.git`, `AGENTS.md` or `opencode.json`. Directory names work as aliases too; `/projects` lists them.

- Start a message with `@alias`, or mention an alias of 2 or more characters anywhere, and the task runs in that project's directory.
- The session opens at the project root, so OpenCode loads the project's own `AGENTS.md` and `opencode.json`. Their rules take precedence over memory and recent tasks.
- Bot and project combine in either order: `@research @miaoda 看下发布流程`.
- A short follow-up keeps the last task's project and bot for 2 hours: 32 characters or fewer, starting with a word like 继续, 接着, 然后, 再, 还有, 改一下 or 看一下. An image without text counts as a follow-up too. Start with `新话题：` to follow neither; `@base` runs in the base workspace.
- Create recurring tasks with `/routine add <name> <schedule> <prompt>`, using `dailyHH:MM` (Asia/Shanghai) or `everyNm` / `everyNh`.
- A project alias that collides with a bot alias is dropped.

## Commands

| Command | What it does |
|---|---|
| `/status` | Show the state: working directory, recent project, default and recent bot, model, permission mode, running and queued tasks, memory. Then health: the last 24 hours' outcomes and latest failure, open gateway breakers, the outbox backlog and the message token's age |
| `/tasks [n]` | Show the last n tasks (default 5, at most 20) |
| `/stop` | Stop the running task(s); `/stop all` also cancels the queued ones |
| `/routine [add\|rm\|on\|off\|run] …` | List, create, remove, toggle or run a scheduled task. `add` takes `<name> <dailyHH:MM\|everyNm\|everyNh> <prompt>` |
| `/cwd [path]` | Show or switch the working directory. The path must exist and stay inside the `workingDirectory` set up in `config.env` |
| `/ls` | List the working directory (up to 100 entries) |
| `/projects` | List the projects and their aliases |
| `/bots` | List the bots: id, aliases, reply prefix, default bot |
| `/model [model]` | Show or switch the model, shared by all bots; `/model default` goes back to the default |
| `/models` | List the available models |
| `/permission [mode]` | Show or set the permission mode |
| `/help` | Show the help |
| `/version` (`/v`) | Show the version |

## Routines

`/routine add 早报 daily09:00 汇总昨天的工作` queues the prompt as a normal task at 09:00 Asia/Shanghai. `everyNm` and `everyNh` repeat from the last slot (5 minutes to 24 hours); timestamps use the same fixed UTC+8 clock. A routine never runs two tasks at once, and the runs it misses while the bot is down are not made up. Its results go through the normal outbox, so without a recent message token they wait for your next message.

## Permission approval

When OpenCode asks to do something that needs approval, the bot sends the request to WeChat, naming the task (`🔐 任务 #N（bot）请求权限：…`). Reply `y` to allow (also `yes`, `ok`, `是`, `允许`, `同意`) or `n` to deny (also `no`, `否`, `拒绝`). No reply within 120 seconds denies the request. When both lanes ask, the requests wait in order and each reply answers the oldest; a fourth waiting request is denied at once.

| Mode | Behavior |
|---|---|
| `default` | Each request goes to WeChat for a y/n reply |
| `acceptEdits` | File edits are approved automatically; other requests go to WeChat |
| `plan` | Every request is denied |
| `auto` | Every request is approved (dangerous) |

The bot reads the mode for each request, so `/permission` also changes the task that is running. The mode is saved in `config.env`.

## Memory

- `memory/<account>/MEMORY.md` in the data directory is the chat's shared memory. Every bot reads it; the default bot writes it.
- Each other bot also keeps its own file, `memory/<account>/bots/<id>.md`.
- A task can save up to 5 facts of up to 300 characters each, and the bot dates them.
- Each file adds up to 8 KB to the prompt, and is capped at 16 KB.

## Requirements

- macOS for the always-on setup with launchd ([docs/DEPLOY.md](docs/DEPLOY.md)). The bot itself is plain Node.js.
- Node.js 26. CI and the live bot use it; `node:sqlite` needs at least 22.13.
- [OpenCode](https://opencode.ai), served with `opencode serve` on 127.0.0.1:4096.
- A personal WeChat account, bound by QR code.

## Setup

```bash
git clone <repo> wechat-opencode-bot
cd wechat-opencode-bot
npm ci
npm run build
npm run setup     # scan the QR code with WeChat, then enter the working directory
```

Put the settings in `~/.wechat-opencode-bot/env` (mode 600). The bot loads it at startup, and the launchd wrappers source it.

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_URL` | `http://127.0.0.1:4096` | The OpenCode server |
| `OPENCODE_SERVER_PASSWORD` | empty | The server password, sent as Basic auth for the user `opencode` |
| `WECHAT_ALLOWED_IDS` | the bound account | WeChat user ids the bot listens to, comma-separated |
| `OPENCODE_FALLBACK_MODEL` | the cross-gateway chain (`oneapi-chat-gpt/gpt-6-astra`) | The model for the one retry; set it to override the chain |
| `OPENCODE_DEFAULT_MODEL` | `oneapi/DeepSeek-V4.1-Flash` | The primary model routing assumes when `/model` is unset; such sessions still use the orchestrator agent's model |
| `OWB_BREAKER_THRESHOLD`, `OWB_BREAKER_COOLDOWN_MS` | `3`, `600000` | Consecutive upstream failures that open a gateway's breaker, and its first cooldown; a failed probe doubles it, up to 1 hour |
| `OWB_FAILURE_ALERT_COUNT`, `OWB_FAILURE_ALERT_WINDOW_MS`, `OWB_FAILURE_ALERT_COOLDOWN_MS` | `3`, `1800000`, `1800000` | Failed tasks within the window that send one alert to WeChat, the window, and how long the next alert waits |
| `OWB_SESSION_TTL_DAYS`, `OWB_SESSION_KEEP` | `7`, `300` | Delete a finished task's OpenCode session after this many days through the API, always keeping the newest N sessions |
| `OPENCODE_FIRST_RESPONSE_TIMEOUT_MS`, `OPENCODE_STALL_TIMEOUT_MS` | `120000`, `180000` | How long the model may take to start answering, and then between signs of progress |

Try one task without WeChat with `node dist/main.js --simulate "列出工作目录"`, or run the bot in the foreground with `node dist/main.js --daemon`. For the always-on setup with launchd, releases and rollback, follow [docs/DEPLOY.md](docs/DEPLOY.md).

## CLI

| `node dist/main.js …` | What it does |
|---|---|
| `--setup` | Bind a WeChat account by QR code and set the working directory |
| `--daemon` | Run the bot in the foreground; launchd runs this. It takes `daemon.lock`, so a second one prints `already running (pid N)` and exits |
| `--status` | Print the bot's state, like `/status` |
| `--tasks [n]` | Print the last n tasks |
| `--simulate "<text>"` | Run one task in this process as if it came from WeChat, and print the reply. It needs the OpenCode server and keeps its own task history and memory under the account `simulate` |
| `--notify "<text>"` | Send a message to WeChat. If it cannot go out now, it waits in the outbox |
| `--help` | Show the help |

The bot has no start or stop command of its own: launchd keeps it running. Restart it with `launchctl kickstart -k gui/$(id -u)/com.yupeng.opencode-wechat-bot` and stop it with `launchctl bootout gui/$(id -u)/com.yupeng.opencode-wechat-bot`, see [docs/DEPLOY.md](docs/DEPLOY.md#launchd). Stop a bot that runs in the foreground with Ctrl-C.

## Data directory

`~/.wechat-opencode-bot/`, or `$OWB_DATA_DIR` if set:

```
accounts/         WeChat account credentials
attachments/      images, kept 24 hours
backups/          written by the deploy scripts
bots.json         the bot roster
config.env        workingDirectory and permissionMode
daemon.lock       held by the running bot: its pid, start time and entry
env               settings for the bot and the OpenCode server (mode 600)
get_updates_buf   WeChat polling cursor
logs/             the bot's daily logs (3 kept) and the launchd logs
memory/           memory per chat and bot
projects.json     project aliases
state.db          tasks, chat settings and the outbox (SQLite)
```

`accounts/`, `config.env` and `logs/` always live in `~/.wechat-opencode-bot/`, even when `OWB_DATA_DIR` points elsewhere.

## Development

```bash
npm run dev         # tsc --watch
npm run typecheck   # tsc --noEmit
npm run build
npm test            # runs the compiled tests in dist/tests, so build first
```

CI runs typecheck, build, test and a gitleaks scan on every push and pull request to `main`. Releases and deploys are covered in [docs/DEPLOY.md](docs/DEPLOY.md).

## License

MIT
