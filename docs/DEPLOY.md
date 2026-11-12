# Deploy

The bot runs from a release: a tarball of one commit and the `dist/` that CI built from it, unpacked in `releases/<tag>/`. The `current` symlink points at the release that runs, and launchd starts the bot through the repo's `run-bot.sh`. After the [one-time migration](#one-time-migration), `run-bot.sh` starts `current/dist/main.js`, so a deploy or a rollback is a symlink switch plus a restart.

`deploy.sh`, `rollback.sh` and the `install-*.sh` scripts are dry runs by default: they print what they would do. Add `--apply` to do it.

## Layout

| Path | What it is |
|---|---|
| `releases/wechat-bot-<tag>.tgz`, `.tgz.sha256` | A release, packaged by `scripts/release.sh` from a CI artifact |
| `releases/<tag>/` | An installed release: `dist/`, production `node_modules/`, `config/agents/`, `scripts/` with `healthcheck.sh` and `collect-work-activity.mjs`, and a `RELEASE` file naming its commit |
| `current` | Symlink to `releases/<tag>` |
| `run-bot.sh`, `run-server.sh` | The launchd wrappers. launchd runs the repo's copies, not the ones inside a release |
| `config/agents/` | OpenCode agent prompts, see [Agents](#agents) |
| `config/launchd/` | launchd job templates, see [launchd](#launchd) |
| `~/.wechat-opencode-bot/` | Data: `state.db`, `env`, `logs/`, `backups/` |

git ignores `releases/` and `current`.

## Release

A release packages the committed HEAD with the `dist/` that CI built from that same commit. Release a commit on `main` once the CI run of its push has passed:

```bash
git switch main && git pull --ff-only
commit=$(git rev-parse HEAD)
gh run list -w ci.yml -e push -b main -c "$commit" -s success --json databaseId,url
artifact=$(mktemp -d)
gh run download <databaseId> -n "wechat-opencode-bot-build-$commit" -D "$artifact"
scripts/release.sh v1.2.0 "$artifact"
```

- If `gh run list` shows nothing, CI for that commit has not finished, has failed, or was cancelled by a later push to `main`: wait for the run, or pull again and release the newer commit once its run passes.
- Take the push run's artifact. A pull-request run builds GitHub's temporary merge commit, so its artifact and `BUILD_COMMIT` name that commit instead, and `release.sh` refuses it.
- Download the artifact outside the repo: `release.sh` refuses to run while the working tree has changes, untracked files included.
- `release.sh` compiles and tests nothing. It checks that `BUILD_COMMIT` holds exactly HEAD's hash, that `dist/main.js` exists and that `dist/` holds only plain files and directories. Then it takes `dist/` from the artifact and `package.json`, `package-lock.json`, `run-bot.sh`, `run-server.sh`, `config/agents/`, `scripts/healthcheck.sh` and `scripts/collect-work-activity.mjs` from HEAD (`git archive`), and adds a `RELEASE` file with the tag, the commit and the time it was packaged.
- It writes `releases/wechat-bot-v1.2.0.tgz` and its `.sha256`, and refuses a tag that already has a tarball. It creates no git tag and pushes nothing. CI keeps each artifact for 14 days.

## Deploy

```bash
scripts/deploy.sh v1.2.0            # dry run: prints the plan
scripts/deploy.sh --apply v1.2.0
scripts/deploy.sh --apply /path/to/wechat-bot-v1.2.0.tgz   # packaged elsewhere; its .sha256 must sit next to it
```

The dry run shows the release and its commit, where `current` points, what `run-bot.sh` starts, whether the agents link through `current`, and the plan. `--apply` then works through the plan in this order:

1. Install the release, unless `releases/<tag>/` exists: verify the checksum, unpack into a staging dir, run `npm ci --omit=dev`, move it into place.
2. Back up `state.db` to `~/.wechat-opencode-bot/backups/state.db.pre-<tag>-<time>` with `sqlite3 .backup`, which is safe while the bot runs.
3. Point `current` at `releases/<tag>`. The switch is a rename, so `current` never goes missing.
4. Reload the OpenCode agents, if they link through `current` and the release changes a prompt.
5. Restart the bot with `launchctl kickstart -k`, then wait for the health gate.

Steps 4 and 5 need `run-bot.sh` to start `current/dist/main.js`. Until the [one-time migration](#one-time-migration), deploy stops after step 3 and prints a note, and the bot keeps running its old build. If the agents already link through `current`, deploy refuses instead: moving `current` would give the old build another release's prompts.

### Health gate

A deploy succeeds when:

- launchd runs the bot on a new pid within 30 s;
- the same pid still runs 15 s later, so it is not crash-looping;
- `scripts/healthcheck.sh` passes, see [Health](#health).

Otherwise deploy undoes what this run changed. `current` goes back to the previous release, `run-bot.sh` is restored if this run switched it, and the agents are reloaded if this run reloaded them. Then the bot restarts on its previous build and goes through the gate again. The installed release and the backups stay, and `state.db` is not restored: see [Roll back](#roll-back).

### Before you deploy

- The restart interrupts the running task, and its user gets a ⏹ notice. Queued tasks run after the restart. Check `/status` in WeChat first.
- Deploy never restarts the OpenCode server, but the health gate checks it, so every deploy rolls back while the server is down. Restart the server first, see [launchd](#launchd).
- Nothing checks health before the restart, so a fix can still reach a failing bot. The only check on the bot beforehand is that launchd has its job loaded.

## Roll back

```bash
scripts/rollback.sh v1.1.0          # dry run
scripts/rollback.sh --apply v1.1.0
```

`rollback.sh` takes a release that is still installed in `releases/`; for any other tag it lists the installed ones. It runs `deploy.sh` on that release, so it gets the same plan, `state.db` backup, health gate and undo.

It does not restore `state.db`. Migrations so far only add nullable columns, so an older build runs on a newer database. Restore a backup only when a release damaged the data. The restore loses what the bot recorded after the backup: tasks, undelivered notices, and `/cwd` and `/model` changes.

1. Stop the bot: `launchctl bootout gui/$(id -u)/com.yupeng.opencode-wechat-bot`
2. Keep a copy of the damaged database:
   `cd ~/.wechat-opencode-bot && sqlite3 state.db ".backup backups/state.db.damaged-$(date +%Y%m%d-%H%M%S)"`
3. Put the backup in place and drop the write-ahead log of the damaged one:
   `cp backups/state.db.pre-<tag>-<time> state.db && rm -f state.db-wal state.db-shm`
4. Start the bot: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yupeng.opencode-wechat-bot.plist`

## One-time migration

Today `run-bot.sh` starts `dist-roster/main.js`, a build snapshot in the repo checkout, and a deploy leaves the bot alone. This switch makes `run-bot.sh` start `current/dist/main.js`. It takes about 10 minutes; do it while no task runs.

1. Commit everything and push it to `main`. Once CI passes, package the first release from its artifact as in [Release](#release): `scripts/release.sh v1.0.0 <artifact-dir>`
2. Dry run: `scripts/deploy.sh v1.0.0`. It shows `run-bot.sh starts dist-roster/main.js` and the migration note.
3. Switch: `scripts/deploy.sh --apply --migrate-wrapper v1.0.0`. On top of a normal deploy, it backs up `run-bot.sh` to `~/.wechat-opencode-bot/backups/run-bot.sh.pre-v1.0.0-<time>` and rewrites its `exec node` line to `exec node current/dist/main.js --daemon`. If the health gate fails, it puts the old `run-bot.sh` back and restarts the old build.
4. Commit `run-bot.sh` and push it to `main`: `git diff run-bot.sh` shows the one changed line. `scripts/release.sh` refuses to run until you commit it, and the next release needs CI's artifact of that commit.
5. Link the agents through `current`: `scripts/install-agents.sh`, then `scripts/install-agents.sh --apply`. The v1.0.0 prompts are copies of the live ones, so it reports `same content` and needs no reload.
6. Check the launchd jobs: `scripts/install-launchd.sh` should report the server and bot plists as `unchanged`.

Keep step 5 after step 3. Until the switch, a deploy moves `current` without restarting the bot, so `deploy.sh` refuses to run while the agents link through `current`.

To undo the switch, restore the wrapper and restart the bot:

```bash
cp ~/.wechat-opencode-bot/backups/run-bot.sh.pre-v1.0.0-<time> run-bot.sh
launchctl kickstart -k gui/$(id -u)/com.yupeng.opencode-wechat-bot
```

Keep `dist-roster/` until the new setup has run for a while: the undo starts it.

`dist-roster/` predates `daemon.lock` and writes `daemon.pid` instead, so `scripts/healthcheck.sh` fails on the lock whenever that build runs: until the switch, after an undo, and after a failed switch, where deploy reports `unhealthy after the rollback too`. Check that build with `launchctl print gui/$(id -u)/com.yupeng.opencode-wechat-bot` and its logs. Nothing else reads `daemon.pid`; delete it once the switch holds.

## Agents

The bot runs write tasks on the `wechat-orchestrator` agent, which hands work to `wechat-general` and `wechat-explore`, and the read lane's tasks (read-only bots) on `wechat-orchestrator-read`, which can only hand work to `wechat-explore`. OpenCode loads all four from `~/.config/opencode/agents/`. After `scripts/install-agents.sh --apply`, those files are links into `current/config/agents/`, so a deploy brings its release's prompts and a rollback brings the old ones back.

- Both orchestrators ship together in every release. `deploy.sh` creates no links, so a release that adds a prompt, such as the first with `wechat-orchestrator-read.md`, needs `scripts/install-agents.sh --apply` and a reload right after its deploy; until then OpenCode does not know the agent a read-only bot's task asks for.
- OpenCode caches agents until it reloads them. `deploy.sh` reloads them when a release changes a prompt, and again when it rolls back. To reload by hand:

  ```bash
  (set -a; . ~/.wechat-opencode-bot/env; set +a; opencode reload --server "${OPENCODE_URL:-http://127.0.0.1:4096}")
  ```

- To change a prompt, edit `config/agents/<name>.md` and get the commit onto `main`, then package CI's artifact of it as in [Release](#release) and deploy. See [config/agents/README.md](../config/agents/README.md).
- `install-agents.sh` backs up what it replaces to `~/.wechat-opencode-bot/backups/agents-<time>/`. Never keep a backup inside `~/.config/opencode/agents/`: OpenCode also loads `.md` files in its subdirectories as agents, hidden ones included.
- `wechat-ducc.md` is not part of the setup: no agent delegates to Ducc, and `install-agents.sh` does not create it. The old file in a live agents directory can be deleted.

## launchd

| Job | Starts | Notes |
|---|---|---|
| `com.yupeng.opencode-wechat-server` | `run-server.sh`: `opencode serve` on 127.0.0.1:4096 | Load it first: a bot that finds no server starts one of its own |
| `com.yupeng.opencode-wechat-bot` | `run-bot.sh` | Every deploy restarts it |
| `com.yupeng.opencode-wechat-watchdog` | `scripts/watchdog.sh`, at login and every 5 minutes | Restarts a stuck bot, see [Watchdog](#watchdog) |

The server and the bot start at login, and launchd starts them again when they exit. The templates of all three jobs live in `config/launchd/`. `scripts/install-launchd.sh` renders them and diffs them against `~/Library/LaunchAgents/`; with `--apply` it backs up and writes the plists. It never loads anything: it prints the `launchctl bootout` and `bootstrap` commands to run while no task runs.

To restart a job without reloading its definition, for example the server (check `/status` first):

```bash
launchctl kickstart -k gui/$(id -u)/com.yupeng.opencode-wechat-server
```

Manage the jobs with `launchctl`. The bot has no start or stop command of its own:

| To | Run |
|---|---|
| Restart the bot | `launchctl kickstart -k gui/$(id -u)/com.yupeng.opencode-wechat-bot` |
| Stop it until the next login | `launchctl bootout gui/$(id -u)/com.yupeng.opencode-wechat-bot` |
| Start it again | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yupeng.opencode-wechat-bot.plist` |

The bot takes `~/.wechat-opencode-bot/daemon.lock` before it connects to anything, and removes it when it exits. While one bot holds the lock, another `--daemon`, such as one started by hand in a terminal, prints `wechat-opencode-bot already running (pid N)` and exits 0. A lock whose process is gone, or that was written before the last boot, is stale: the next bot replaces it.

Logs are in `~/.wechat-opencode-bot/logs/`. launchd writes `bot.out.log`, `bot.err.log`, `server.out.log`, `server.err.log`, `watchdog.out.log` and `watchdog.err.log`; the bot writes `wechat-opencode-bot-<date>.log` and keeps the 3 newest, and the watchdog writes `watchdog.log`.

## Watchdog

The `com.yupeng.opencode-wechat-watchdog` job runs `scripts/watchdog.sh` at login and every 5 minutes. A stuck bot cannot reach WeChat, so the watchdog reports through macOS notifications (they come from Script Editor; allow it in System Settings → Notifications).

- The bot is healthy when `scripts/healthcheck.sh` passes and the bot that holds `daemon.lock` rewrote `~/.wechat-opencode-bot/heartbeat` within 5 minutes. The daemon rewrites it every 30 s from a timer, which only fires while its event loop turns.
- A failed check is repeated 60 s later, so a wake from sleep or a deploy's restart does not count. If it fails again, the watchdog restarts the bot with `launchctl kickstart -k`, checks every 5 s for 30 s, and sends a notification either way.
- After a restart that did not help, the next restart waits 30 minutes, and the first check that passes sends a notification.
- It only restarts the bot. It leaves a down OpenCode server or a broken release alone; the notification names the check that failed.
- It does nothing while the bot job is not loaded, so a bot stopped with `launchctl bootout` stays stopped until the next login.

Once a day after a passing check, and on `scripts/watchdog.sh --smoke`, it runs a smoke test: `node current/dist/main.js --simulate "只回复 ok"`, or `dist/main.js` without `current`. The task goes through the real OpenCode server and model under the `simulate` account, so the chat's history and memory stay untouched. A test that has not finished after 180 s is stopped and fails. A failure sends a notification and logs the last 20 lines of the output; the next test still waits a day.

A healthy run writes nothing, apart from the daily smoke-test result and a failed ping. `~/.wechat-opencode-bot/logs/watchdog.log` gets failures, restarts and smoke-test results, with the healthcheck's `ok` and `FAIL` lines but never its `--status` report or the env file. In a terminal, `scripts/watchdog.sh` does the same, restart included, and prints what it found.

Notifications only reach someone at the Mac. Two optional variables add channels that do not. Set them in `~/.wechat-opencode-bot/env`; a variable already in the environment wins:

- `OWB_ALERT_WEBHOOK`: the text of every notification is also POSTed there as a `text/plain` body, for example to an ntfy topic or a proxy in front of Slack. A failed POST is logged with curl's exit code and changes nothing else.
- `OWB_ALERT_PING_URL`: every run that ends healthy GETs it, including one that restarted the bot or ran the smoke test. It is the ping of an external dead-man's switch such as healthchecks.io; give the check a period of 5 minutes and a grace time of at least 10. The pings stop, so the service alerts, while the bot stays unhealthy or its job is not loaded, while the Mac sleeps or is off, and when the watchdog itself stops. A failed ping is logged.

Neither URL is logged, and curl reads them from stdin, so they stay out of the process list too. `scripts/watchdog.sh --test-alert` sends `watchdog test alert` as a notification and to the webhook, without checking or restarting anything, and exits 1 if the POST failed. With neither variable set, the watchdog reports through notifications and its log alone.

Install the watchdog only after deploying a release that writes the heartbeat: `cat ~/.wechat-opencode-bot/heartbeat` must show the running bot's pid. With an older build every check fails, and the watchdog restarts the bot every 30 minutes.

1. Run `scripts/install-launchd.sh --apply`. It reports the watchdog plist as `new`.
2. Run the `launchctl bootstrap` line it prints. The first check and the first smoke test run right away.

Before a rollback to a release without the heartbeat, stop the watchdog: `launchctl bootout gui/$(id -u)/com.yupeng.opencode-wechat-watchdog`.

## Health

```bash
scripts/healthcheck.sh
```

It changes nothing and exits 1 if any check fails:

- the server job runs, and `/api/info` answers 200. The password from `~/.wechat-opencode-bot/env` reaches curl on stdin, so it never shows in the process list or the output;
- the bot job runs, and `daemon.lock` names its pid;
- `main.js --status` succeeds when run with the bot's own node and entry. Its report is printed.

In WeChat, `/doctor` runs the same class of checks from inside the daemon: OpenCode and the four agents, the message token's age, the outbox, `state.db` and `opencode.db` sizes, open breakers, routines and uptime. `/panic` is the kill switch: it stops and cancels every task, denies waiting asks, switches to `plan` and disables every routine.

It also prints the bot's command line, its working directory and where `current` points.

## Backups and cleanup

- `~/.wechat-opencode-bot/backups/` collects `state.db.pre-<tag>-<time>`, `run-bot.sh.pre-<tag>-<time>`, `agents-<time>/` and `launchd-<time>/`. Nothing prunes it.
- Installed releases stay in `releases/`, so a rollback needs no tarball. Delete old releases and their tarballs by hand, never the one `current` points at (`readlink current`).
- Session retention: at startup and every 24 hours the bot deletes, through the OpenCode API, the sessions of tasks that finished more than `OWB_SESSION_TTL_DAYS` (default 7) ago, always keeping the newest `OWB_SESSION_KEEP` (default 300) finished tasks' sessions. It only touches sessions recorded in `state.db` and never opens `opencode.db`; a session it deletes is forgotten in `state.db`, and a failed delete is retried on the next run. SQLite does not shrink on delete, so the file stops growing rather than getting smaller.

## Model routing

- `/model` sets a chat's primary model; without it the session uses the bot's `model` from `bots.json`, then the orchestrator agent's model. `OPENCODE_DEFAULT_MODEL` is only what routing assumes when neither is set, so keep it equal to the `model:` of both orchestrators in `config/agents/`.
- An upstream failure (5xx, 429, timeout, transport, `do request failed`) retries once on a model behind another gateway: `OPENCODE_FALLBACK_MODEL` when set, otherwise the first of `oneapi-chat-gpt/gpt-6-astra`, `oneapi/DeepSeek-V4.1-Flash`, `oneapi-gemini/Gemini 4 Argon` whose provider differs from the primary.
- Auth errors, HTTP 4xx and permission rejections are not retried, and neither is an unreachable local OpenCode server: another gateway would fail the same way.
- 3 upstream failures in a row open that gateway's breaker for 10 minutes (`OWB_BREAKER_THRESHOLD`, `OWB_BREAKER_COOLDOWN_MS`). Later tasks start on the fallback and the chat gets one notice. A failed probe doubles the cooldown, up to an hour; a success closes the breaker. The state is in memory, so a restart starts with every breaker closed.
- `/status` lists the open breakers with the minutes left, the outbox backlog and the message token's age; `--status` runs in a process of its own and cannot see the breakers. 3 failed tasks within 30 minutes queue one alert to the chat, and the next alert waits at least 30 minutes (`OWB_FAILURE_ALERT_COUNT`, `OWB_FAILURE_ALERT_WINDOW_MS`, `OWB_FAILURE_ALERT_COOLDOWN_MS`).
- `Task finished` lines carry `model`, `attempts`, `fallback` and `errorKind`.

Subagents have no `model:` in their agent files, so OpenCode runs them on the parent session's model and a task that fell back stays on one gateway from start to finish.

## Routines

The daemon checks for due routines every 30 seconds (`ROUTINE_TICK_MS` in `src/commands/handlers.ts`). A routine queues one task at a time; if its previous task is still queued or running, that slot is skipped, and runs missed while the bot was down are not made up. Schedules use Asia/Shanghai (UTC+8, no DST). Results are ordinary tasks: they reach the chat through the outbox, so without a recent `context_token` they wait for the next inbound message.

## CI

`.github/workflows/ci.yml` runs on every push and pull request to `main`:

- `test`: `npm ci`, typecheck, build and test on Node 26. When all four pass, it writes `BUILD_COMMIT` with `git rev-parse HEAD` and uploads `dist/` and `BUILD_COMMIT` as the artifact `wechat-opencode-bot-build-<commit>`, kept for 14 days.
- `gitleaks`: scans the whole git history for secrets with gitleaks 8.30.1, pinned by checksum.

A push run builds the pushed commit. A pull-request run builds GitHub's temporary merge of the branch into `main`, and its artifact names that merge commit; release from a push run's artifact instead. A newer run on the same ref cancels one still in progress.

CI deploys nothing: `scripts/release.sh` packages its artifact and `scripts/deploy.sh` installs the release on the machine that runs the bot.
