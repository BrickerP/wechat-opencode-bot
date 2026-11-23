# wechat-opencode-bot

English | [中文](README_zh.md)

A bridge between WeChat and [OpenCode](https://opencode.ai). Each message you send the bot becomes a task: a daemon on your machine runs it in a new session on a local OpenCode server and sends the result back to the chat. It handles text, images, voice messages, permission approvals, scheduled tasks, several bots and several projects, and can send images and files back.

## Demo

```text
You:  @eng 修一下登录页的 500
Bot:  工程：已定位到 src/auth/session.ts：过期 token 没有清 cookie。
      改了 session.ts 和对应测试，npm test 通过。
You:  继续，补一个 e2e
Bot:  工程：补了 tests/e2e/login.spec.ts，本地通过。 /tasks 可以看本次用了多少 token。
```

The transcript is illustrative; the bot's replies are plain text in Chinese unless you write in another language.

## Architecture

```mermaid
flowchart LR
  wechat["WeChat<br/>(iLink bot API)"] -- "long poll" --> daemon["bot daemon<br/>(Node.js)"]
  daemon <--> db[("state.db<br/>task queue, outbox, routines")]
  daemon -- "search, save" --> memory[("agentmemory<br/>your memories")]
  daemon -- "HTTP API" --> server["OpenCode server"]
  server --> orch["orchestrator session<br/>(one per task)"]
  orch --> general["wechat-general"]
  orch --> explore["wechat-explore"]
  daemon -- "replies via the outbox" --> wechat
```

### Components

| Component | Process / runtime | Role |
|---|---|---|
| WeChat, iLink bot API | Tencent's service at `ilinkai.weixin.qq.com` | Hands your messages to the daemon by long poll and delivers its replies |
| Bot daemon | `node dist/main.js --daemon`, Node.js | Routes messages, queues tasks, drives OpenCode over HTTP, sends the results |
| OpenCode server | `opencode serve` on `127.0.0.1:4096` | Runs the agent sessions and calls the models |
| Orchestrators | Primary agents `wechat-orchestrator` and `wechat-orchestrator-read` | Plan each task, delegate the work, write the reply |
| Subagents | `wechat-general` (can edit files) and `wechat-explore` (cannot) | Do the work: read code, run commands, edit files |
| `state.db` | SQLite through `node:sqlite`, in the data directory | Tasks, outbox, routines, per-chat settings |
| agentmemory | Your memory engine, REST on `127.0.0.1:3111`; optional | Holds every memory: searched before a task, written after it. The bot keeps none of its own |
| launchd | Two macOS user jobs, optional | Keep the server and the daemon running ([docs/DEPLOY.md](docs/DEPLOY.md)) |

### Task lifecycle

1. The daemon long-polls iLink and ignores anyone not in `WECHAT_ALLOWED_IDS`. Each message refreshes the chat's `context_token`, which every reply needs.
2. `y`/`n` answers a waiting permission ask and a `/` command gets a direct reply. Anything else is for a task: the daemon downloads the first image and routes the text to a bot and a project. While the chat has open tasks, a message without a prefix first goes to the task router (see Routing), which may merge it into a task, hand it to a running one or stop one; otherwise the daemon stores a new task in `state.db`. With tasks ahead it replies `⏳ 已排队：任务 #N（前面还有 X 个任务）` and an estimate.
3. The lane's worker takes the oldest queued task and opens a new OpenCode session at the project root, or in the chat's working directory. OpenCode loads that directory's `AGENTS.md` and `opencode.json`, whose rules take precedence over memory and recent tasks. A message the router attaches to a finished task instead continues that task's session (see Routing), and a retry continues the session it failed in.
4. A new session's prompt carries the context: time, attachments, the bot's role, the project, up to 8 agentmemory entries that match the message (each with its id and date) and the last 8 tasks, each with its session id and with reply excerpts for the latest 2. When a message needs what an earlier task did, the orchestrator has `wechat-explore` read that session with `--session <id>` (its path is in the prompt), instead of searching for it.
5. The orchestrator hands the work to `wechat-explore` or `wechat-general`, at most 3 at once and 6 per task. Permission asks go to WeChat. A short sentence the orchestrator writes before a subagent call can reach the chat as commentary; the daemon's own progress notes (elapsed time, running tools, subagent count) are off by default.
6. The orchestrator ends its output with `<<<WECHAT_REPLY>>>`, `<<<WECHAT_MEMORY>>>`, `<<<WECHAT_SUMMARY>>>`, and an optional `<<<WECHAT_FILES>>>` section. The daemon keeps the reply, saves up to 5 facts to agentmemory (a fact that starts with an entry's id updates that entry), stores the summary, the token usage of this task's turns and the file paths, and sends the files after the text.
7. A continued session's next turn gets only what is new: time, task number, attachments, matching memories and the message, since the session holds the work so far. The result goes to the outbox once, in 2048-character chunks; a failure reads `⚠️ 任务 #N 失败：…`, a restart `⏹ 任务 #N 已中断…`.

### Routing

`bots.json` and `projects.json` in the data directory hold the bots and the projects. Both are written on first use and re-read for every message; after that they are yours to edit. The default bots are `chief` (default, no prefix), `research` (read-only, `研究：`), `eng` (`工程：`) and `ops` (`Ops：`). The first `projects.json` has one entry per child directory of the base directory, with the directory name as an alias, plus `base` when the base itself has `.git`, `AGENTS.md` or `opencode.json`.

| Message | Bot | Project |
|---|---|---|
| `@research …` (a bot alias first) | that bot | found in the rest |
| `@myproj …` (a project alias first) | default, or an `@bot` right after | that project |
| `@base …` | default, or an `@bot` right after | none: the chat's working directory |
| `@all …`, `@everyone …` | the default bot, which splits the work among the specialists, up to 3 at once, and merges one reply | found in the rest |
| `新话题：…` (or `换个话题`, `new topic`) | found in the rest | found in the rest |
| anything else, while the chat has open tasks | that of the open task the router attaches it to (below), else as above | the same |

- Without an `@`, the default bot answers; a bot is never guessed from the text. The project then comes from an alias of 2 or more characters mentioned anywhere (ASCII aliases as whole words), else none. Only `projects.json` counts: a path in the text is never opened as a directory. A project alias that a bot also uses is dropped.
- A message that opens with a prefix from the table (`@bot`, `@project`, `@base`, `@all`, `新话题`) is always new work. Any other message, while the chat has open tasks, goes to the task router first (`src/task-router.ts`): one call to `OPENCODE_DEFAULT_MODEL` through OpenCode's `POST /api/experimental/generate/text`, with no session and no tools, about 2 s and at most 15 s. Open tasks are the running and queued ones and those finished within 24 hours whose session still exists: the newest 6, a continued conversation counted once. The router sees each one's status, age, bot, project, input, summary and whether its reply ended with a question, and answers one of these:
  - attach #N: the message continues, corrects, narrows or answers task #N. Still queued, the text is added to its input (`↪️ 已合并到排队中的任务 #N`). Running, the task steers it into its session at the next step, or gives it a turn of its own if the turn has already answered, and the task's one reply covers it (`↪️ 已追加到正在运行的任务 #N…`). Finished, it becomes a new task with #N's bot and project that continues #N's session, so it has the whole work so far; if the session is gone, the task starts a new one. An image always becomes a task of its own that follows #N.
  - stop #N: a queued task is cancelled (`🗑 已取消任务 #N`), a running one is stopped alone (`⏹ 已停止任务 #N`). `/stop` still stops every running task.
  - new: a new task, routed as the table says.
- A failed or slow call, or an answer that names no open task, makes a new task, and the log says why. The log has each decision and its latency, never the message. `--simulate` routes against its own tasks the same way, but only prints a stop.

### Concurrency

- Each account has a `write` lane and a `read` lane with one running task each. Each lane runs its tasks in arrival order, claimed atomically from `state.db`.
- A read-only bot is a non-default bot whose `subagent` is `wechat-explore`, like `research`. Its tasks take the read lane on `wechat-orchestrator-read`, which can only start `wechat-explore`, so they run beside a write task without editing files. Read-only is an OpenCode permission rule, not a sandbox: `wechat-explore` can still run shell commands.
- Every other task, `@all` included, takes the write lane. A task queued for over 24 hours expires. A restart interrupts the running tasks and their sessions; queued tasks still run.
- Replies to one chat go out one at a time, whichever lane sends them. A running task's commentary and progress notes (off by default) wait their turn too, and one still waiting when its task finishes is dropped, so none arrives after the task's result.

### Model routing and resilience

- A task runs on the chat's `/model`, else on its bot's `model` from `bots.json`, else on the orchestrator's own `model:`, which routing takes to be `OPENCODE_DEFAULT_MODEL`. Subagents have no `model:` line and run on their parent's model.
- `bots.json` accepts an optional `model` per bot (`provider/model[#variant]`); `/model` overrides every bot, and `/model default` returns to each bot's own model.
- An upstream failure gets one retry on `OPENCODE_FALLBACK_MODEL`, if it is set and the server lists it at that moment (`GET /api/model`); models get removed while the bot runs, so it is checked before each use, at startup and by `/doctor`. A fallback that is set but not listed is not tried, and the task's error says so; without one, upstream failures are not retried. Upstream means 429 or quota, 5xx or overloaded, timeouts, connection errors, `provider.*` errors other than auth, and a model silent for 120 s before its first output or 180 s between signs of progress. Signs of progress include reasoning, text and tool input while they stream, which the daemon reads from OpenCode's event stream (`GET /api/event`); a message snapshot only shows them once they are finished. When the stream is down, polling alone judges progress and `/doctor` says so. The retry continues the same session on the fallback, with a short prompt that names what stopped the first attempt and asks it to check what that attempt changed before going on; when the session is gone, a new one gets the whole prompt. You only see the final outcome.
- Not retried: auth, permission, 4xx and unknown errors, errors of the local server, and the 30-minute cap on one turn.
- Each gateway has a breaker, kept in memory. 3 upstream failures in a row open it: new tasks start on the fallback and the chat gets one notice, as long as the server lists a fallback; without one, tasks stay on the primary. After 10 minutes the next task tries the gateway again; a success closes the breaker, a failure doubles the wait, up to 1 hour. Separately, 3 failed tasks within 30 minutes send one `🚨` alert, then none for 30 minutes.
- Commentary: a sentence the orchestrator writes before a subagent call reaches the chat with the bot's reply prefix once that step's response is complete. At most 3 per task, retries included, each cut at 800 characters; text with a marker or tool-call markup, or that a retry repeats, is not sent. It is best-effort: it skips the outbox and is never retried. The final answer goes out once, through the outbox.
- Progress notes are diagnostics and off by default. With `OWB_PROGRESS_ENABLED=true`, a task sends `⏳ 任务 #N 运行中…` with the elapsed time, the running tools and how many subagents it has started after 20 s, then again when a new subagent starts or every 5 minutes, at least 90 s apart and at most 4 per task. `OWB_PROGRESS_MAX=0` turns them off even then.
- Every result is stored in the outbox (`pending_notices`) before it is sent, and notices go out oldest first. A failed send waits 30 s, 2 min, 10 min, then 1 h, and is retried after that on your next message or when a task finishes.

### State and retention

Paths are in the data directory (`OWB_DATA_DIR`, default `~/.wechat-opencode-bot`) unless shown in full.

| What | Where | Kept |
|---|---|---|
| Tasks, outbox, routines, per-chat settings | `state.db`: `tasks`, `task_sessions`, `pending_notices`, `routines`, `users` | Migrations run on open (`PRAGMA user_version`, additive only) |
| Backups of `state.db` | `backups/state-<time>.db` | Taken at start-up when the newest is over a day old; 7 kept |
| OpenCode sessions | the OpenCode server | Deleted through its API 7 days after the last task that ran in them finished, keeping the newest 300 tasks' sessions; checked at start-up and daily |
| Memory | Your agentmemory engine (`AGENTMEMORY_URL`), shared with your other agents | As the engine keeps it. A prompt shows the 8 best matches, cut at 600 characters; a task saves or updates up to 5 facts of 600 characters, tagged `wechat-opencode-bot`. `--simulate` reads but never saves. The bot no longer reads `memory/` in the data directory |
| Images | `attachments/<task>/` | 24 hours; a text task within 10 minutes of an image task reuses its images |
| Logs | `~/.wechat-opencode-bot/logs/` | One file a day, 3 kept |

### Permissions

When OpenCode asks for approval, the daemon applies the mode in `config.env`, read for each ask so `/permission` also changes a running task: `default` sends every ask to WeChat, `acceptEdits` approves edits and sends the rest, `plan` denies all, `auto` approves all (dangerous).

- An ask names its task: `🔐 任务 #N（bot）请求权限：…`. Reply `y` (`yes`, `ok`, `是`, `允许`, `同意`) or `n` (`no`, `否`, `拒绝`). No reply within 120 s denies it.
- Asks wait in one queue per account, and each answer goes to the oldest. A fourth waiting ask is denied at once. A `y`/`n` sent within 15 s of a timeout is not applied to the next ask.
- Which actions need approval is up to your OpenCode permission settings. Anyone in `WECHAT_ALLOWED_IDS` can run commands on this machine through `wechat-general`, so keep the list to yourself.

### Repository layout

| Path | Contents |
|---|---|
| `src/` | The daemon: `main.ts` (CLI, inbound messages), `task-router.ts` (the open task a message belongs to), `orchestrator.ts` (prompt, run, result), `opencode/` (HTTP client, watchdogs), `tasks/` (`state.db`, lanes), `wechat/` (iLink client), `commands/`, `tests/` |
| `config/agents/` | The four agent prompts, see [config/agents/README.md](config/agents/README.md) |
| `config/launchd/` | launchd job templates for the server, the daemon and the watchdog, run through `run-server.sh`, `run-bot.sh` and `scripts/watchdog.sh` |
| `scripts/` | `release.sh`, `deploy.sh`, `rollback.sh`, `healthcheck.sh`, `install-agents.sh`, `install-launchd.sh` |
| `docs/` | [DEPLOY.md](docs/DEPLOY.md) and design notes |

## Usage

### Requirements

- Node.js 26, the version CI uses (`node:sqlite` needs at least 22.13). macOS only for the launchd jobs.
- OpenCode 2 (`npm install -g @opencode/cli`, not the OpenCode 1 package `opencode-ai`) with providers for the models you want.
- A WeChat account to bind by QR code; setup stores the iLink bot token in `~/.wechat-opencode-bot/accounts/`.

### Setup

1. `git clone <repo> wechat-opencode-bot && cd wechat-opencode-bot && npm ci && npm run build`
2. `npm run setup`: scan the QR code with WeChat, then enter the base directory (`workingDirectory` in `config.env`); projects and `/cwd` must stay inside it.
3. Pick your models. The prompts and defaults use `oneapi*` providers you probably lack: change `model:` in `config/agents/wechat-orchestrator.md` and `wechat-orchestrator-read.md`, set `OPENCODE_DEFAULT_MODEL` to the same model and `OPENCODE_FALLBACK_MODEL` to one on another provider. [docs/PROVIDERS.md](docs/PROVIDERS.md) has examples for Anthropic, OpenAI, Ollama and your own gateway.
4. Put those and your other settings in `~/.wechat-opencode-bot/env`, then `chmod 600` it.
5. `scripts/install-agents.sh --apply` links the agent prompts into `~/.config/opencode/agents/`; without `--apply` it only lists the changes. Then reload OpenCode with the command it prints, or restart the server.

`accounts/`, `config.env` (`workingDirectory`, `permissionMode`) and `logs/` always stay in `~/.wechat-opencode-bot/`; everything else, `env`, `bots.json` and `projects.json` included, lives in the data directory.

### Run

| Command | What it does |
|---|---|
| `node dist/main.js --daemon` | Run the bot in the foreground. It holds `daemon.lock`, so a second one prints `already running (pid N)` and exits |
| `node dist/main.js --simulate "列出工作目录"` | Run one task as if it came from WeChat and print the reply. It needs a running server, uses the account `simulate`, denies every permission ask, and reads memories but saves none |
| `node dist/main.js --status` | The daemon's pid and the `/status` report, without breakers |
| `node dist/main.js --tasks [n]` | The last n tasks |
| `node dist/main.js --notify "<text>"` | Send a message to the chat. Exit code 2 (`no_context_token`) or 3 (`send_failed`) leaves it in the outbox |
| `node dist/main.js --session <id\|title>` | Read only: print a session's last assistant text and each of its subagent sessions' title and last text, cut at 20,000 characters. Exit code 1 when nothing was found. The orchestrators' subagents run it to recall an earlier task |

In a checkout, run `npm run build` after every change before you use these commands.

An always-on bot runs a release instead. CI builds every push to `main` and uploads `dist/` with a `BUILD_COMMIT` file holding the commit's hash, as the artifact `wechat-opencode-bot-build-<commit>`. `scripts/release.sh <tag> <artifact-dir>` packages the committed HEAD with the `dist/` of that artifact, only when its `BUILD_COMMIT` is HEAD's hash, and compiles and tests nothing. Use the artifact of a successful CI run for a push to `main` at that exact commit: a pull-request run builds GitHub's temporary merge commit instead, so `release.sh` refuses its artifact. `scripts/deploy.sh` installs the release as `releases/<tag>` and points the `current` symlink at it, and launchd runs `node current/dist/main.js --daemon` through `run-bot.sh`. `run-bot.sh` and `run-server.sh` `cd` into fixed directories, so edit them first, then follow [docs/DEPLOY.md](docs/DEPLOY.md#release). After a deploy, rerun `scripts/install-agents.sh --apply` so the agent links follow `current/`.

### Commands

| Command | What it does |
|---|---|
| `/help` | Show the help |
| `/status` | Working directory, project, bots, model, permission mode, running and queued tasks, where memories come from; then 24-hour outcomes, tokens used, open breakers, the outbox backlog and the token's age |
| `/tasks [n]` | The last n tasks (default 5, at most 20), with token usage when recorded; ⚠️ marks a task at or over `OWB_TASK_WARN_TOKENS` |
| `/session <id\|title>` | Read a session on this OpenCode server directly: its last assistant text, as is (cut at 20,000 characters); a title that matches several lists up to 5 ids |
| `/stop` | Stop the running tasks in both lanes and deny waiting asks; `/stop all` also cancels the queue |
| `/cancel <n>` | Cancel one queued task |
| `/steer [#n] <text>` | Hand a correction to a running task, which steers it into its session at the next step. A task that is already writing its reply takes none |
| `/cwd [path]` | Show or set the chat's working directory, inside the base directory |
| `/ls` | List the working directory (up to 100 entries) |
| `/projects [add\|rm] …` | List projects, or `add <id> [dir]` / `rm <id\|alias>` |
| `/bots` | List the bots: id, aliases, reply prefix, model, default |
| `/model [model]` | Show or set the model for the next tasks, overriding every bot: `provider/model[#variant]` or a bare id; `/model default` returns to each bot's own model |
| `/models` | List the server's models |
| `/doctor` | Self-check: OpenCode, agents, the event stream, message token, outbox, databases, agentmemory, fallback model, breakers, routines and uptime |
| `/panic` | Stop and cancel every task, deny waiting asks, switch to `plan` and disable every routine |
| `/permission [mode]` | Show or set `default`, `acceptEdits`, `plan` or `auto` |
| `/routine …` | List routines, or `add`, `rm`, `on`, `off` or `run` one |
| `/version`, `/v` | Show the version |

Any other `/word` gets `未知命令`; commands never become tasks.

### Addressing

| You send | It runs |
|---|---|
| `@research @myproj 看下发布流程` | as `research` in the read lane, in project `myproj` |
| `@eng 修一下 myproj 的构建脚本` | as `eng`, in `myproj`, because the message mentions it |
| `@base 列出所有仓库` | as the default bot, in the chat's working directory |
| `新话题：今天天气怎么样` | as the default bot with no project; the last task's bot and project are not carried over |

### Routines

`/routine add 早报 daily09:00 汇总昨天的工作` queues that prompt as a normal task every day at 09:00. Schedules are `dailyHH:MM` (Asia/Shanghai, a fixed UTC+8), `everyNm` and `everyNh`, from 5 minutes to 24 hours.

- The prompt is routed like a message when you add it, so `@bot` and `@project` work; both stay fixed after that. If the project is moved or removed later, its next task runs in the base workspace and a warning is logged.
- A routine never runs two tasks at once: a slot that comes while its last task is queued or running is skipped.
- After downtime, a routine that came due runs once, then keeps its schedule; the other missed runs are dropped.
- Results go through the outbox, so without a recent message token they wait for your next message.

### Environment variables

Every `node dist/main.js` command loads `env` from the data directory, and variables already in the environment win. `OWB_DATA_DIR` must come from the environment itself. In the numeric `OWB_*` and `*_TIMEOUT_MS` variables, `0` or a non-number means the default, except that `OWB_PROGRESS_MAX=0` sends no progress note.

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_URL` | `http://127.0.0.1:4096` | The OpenCode server |
| `OPENCODE_PORT` | `4096` | Port of the server the daemon starts when none answers |
| `OPENCODE_SERVER_PASSWORD` | empty | Server password, sent as Basic auth for the user `opencode` |
| `WECHAT_ALLOWED_IDS` | the bound account | WeChat user ids the bot listens to, comma-separated |
| `OPENCODE_DEFAULT_MODEL` | `oneapi/DeepSeek-V4.1-Flash` | The model routing assumes without `/model`, and the task router's model; keep it equal to the orchestrators' `model:` |
| `OPENCODE_FALLBACK_MODEL` | none | The model for the one retry after an upstream failure, even on the same provider. Used only while the server lists it; checked at startup, by `/doctor` and before each use. Unset: no retry |
| `OPENCODE_FIRST_RESPONSE_TIMEOUT_MS`, `OPENCODE_STALL_TIMEOUT_MS` | `120000`, `180000` | Silence allowed before the first output, and between signs of progress (streamed output on the event stream counts) |
| `OWB_BREAKER_THRESHOLD`, `OWB_BREAKER_COOLDOWN_MS` | `3`, `600000` | Upstream failures in a row that open a breaker, and its first cooldown |
| `OWB_FAILURE_ALERT_COUNT`, `OWB_FAILURE_ALERT_WINDOW_MS`, `OWB_FAILURE_ALERT_COOLDOWN_MS` | `3`, `1800000`, `1800000` | Failed tasks in the window that send an alert, the window, and the pause after an alert |
| `OWB_ALERT_WEBHOOK` | empty | URL the watchdog also POSTs each of its alerts to, as plain text: an ntfy topic, a Slack proxy… |
| `OWB_ALERT_PING_URL` | empty | URL the watchdog GETs after every healthy run, for an external dead-man's switch such as healthchecks.io |
| `OWB_SESSION_TTL_DAYS`, `OWB_SESSION_KEEP` | `7`, `300` | Session retention: age in days, and how many of the newest finished tasks keep all their sessions |
| `OWB_PROGRESS_ENABLED` | empty | `true` turns on the diagnostic progress notes; any other value leaves them off. Commentary does not depend on it |
| `OWB_PROGRESS_FIRST_MS`, `OWB_PROGRESS_MIN_GAP_MS`, `OWB_PROGRESS_EVERY_MS`, `OWB_PROGRESS_MAX` | `20000`, `90000`, `300000`, `4` | Progress notes, with `OWB_PROGRESS_ENABLED=true`: first after, minimum gap, regular interval, maximum per task; `OWB_PROGRESS_MAX=0` sends none |
| `OWB_TASK_WARN_TOKENS` | `500000` | Prompt tokens (cache included) from which a task is logged as costly and marked ⚠️ in `/tasks` |
| `OWB_ASR_URL`, `OWB_ASR_MODEL`, `OWB_ASR_API_KEY` | empty, `whisper-1`, empty | OpenAI-compatible transcription endpoint for voice without WeChat's own text; SILK is decoded to WAV first |
| `AGENTMEMORY_URL` | `http://127.0.0.1:3111` | The agentmemory engine. Set it to use an engine without a secret |
| `AGENTMEMORY_SECRET` | the contents of `~/.agentmemory/secret` | The engine's bearer token. Without it or `AGENTMEMORY_URL`, memory is off and `/doctor` says so |
| `OWB_DATA_DIR` | `~/.wechat-opencode-bot` | The data directory |
| `OWB_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `already running (pid N)` | Another daemon holds `daemon.lock`; `node dist/main.js --status` shows its pid, start time and entry. A lock whose process is gone, or from before the last boot, is taken over |
| `OpenCode 未安装…` or `OpenCode 服务启动失败或超时…` | No server answered at `OPENCODE_URL`, and the daemon could not start `opencode serve` within 120 s. Check `opencode` on `PATH`, `OPENCODE_PORT` and `OPENCODE_SERVER_PASSWORD` |
| Results stop arriving; `/status` shows `📮 待补发` | Sends need a recent `context_token`. Send the bot any message; the outbox retries once its backoff has passed |
| Tasks start on the fallback; `/status` lists a gateway under `🧯 熔断` | Its breaker stays open for the minutes shown. Each `Task finished` line in `~/.wechat-opencode-bot/logs/` has `model`, `attempts`, `fallback` and `errorKind`; `OWB_LOG_LEVEL=debug` logs more |
| The bot runs but stops answering | The launchd watchdog (`scripts/watchdog.sh`) restarts a daemon that stopped writing its heartbeat, within about 10 minutes, and logs the restart in `~/.wechat-opencode-bot/logs/watchdog.log`; see [Watchdog](docs/DEPLOY.md#watchdog). It cannot tell that the WeChat session expired: see the next row |
| `⚠️ 微信会话已过期，请重新运行 setup 扫码绑定` in the daemon's output | The iLink session expired. Run `npm run setup` again |

## License

MIT, see [LICENSE](LICENSE). Based on [zsxink/wechat-opencode-bot](https://github.com/zsxink/wechat-opencode-bot).

More: [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Providers and models](docs/PROVIDERS.md) · [Deploy and rollback](docs/DEPLOY.md)
