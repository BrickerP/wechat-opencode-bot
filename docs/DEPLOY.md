# Deploy

The bot runs from a release: a tarball built from one commit and unpacked in `releases/<tag>/`. The `current` symlink points at the release that runs, and launchd starts the bot through the repo's `run-bot.sh`. After the [one-time migration](#one-time-migration), `run-bot.sh` starts `current/dist/main.js`, so a deploy or a rollback is a symlink switch plus a restart.

`deploy.sh`, `rollback.sh` and the `install-*.sh` scripts are dry runs by default: they print what they would do. Add `--apply` to do it.

## Layout

| Path | What it is |
|---|---|
| `releases/wechat-bot-<tag>.tgz`, `.tgz.sha256` | A release, built by `scripts/release.sh` |
| `releases/<tag>/` | An installed release: `dist/`, production `node_modules/`, `config/agents/`, `scripts/healthcheck.sh`, and a `RELEASE` file naming its commit |
| `current` | Symlink to `releases/<tag>` |
| `run-bot.sh`, `run-server.sh` | The launchd wrappers. launchd runs the repo's copies, not the ones inside a release |
| `config/agents/` | OpenCode agent prompts, see [Agents](#agents) |
| `config/launchd/` | launchd job templates, see [launchd](#launchd) |
| `~/.wechat-opencode-bot/` | Data: `state.db`, `env`, `logs/`, `backups/` |

git ignores `releases/` and `current`.

## Release

```bash
scripts/release.sh v1.2.0
```

- It builds from the committed HEAD (`git archive`), so it refuses to run while the working tree has changes.
- It runs `npm ci`, typecheck, build and test in a temp dir. The repo's own `dist/` and `node_modules/` stay untouched.
- It writes `releases/wechat-bot-v1.2.0.tgz` and its `.sha256`, and refuses a tag that already has a tarball.
- It creates no git tag and pushes nothing.

## Deploy

```bash
scripts/deploy.sh v1.2.0            # dry run: prints the plan
scripts/deploy.sh --apply v1.2.0
scripts/deploy.sh --apply /path/to/wechat-bot-v1.2.0.tgz   # built elsewhere; its .sha256 must sit next to it
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

1. Commit everything, then build the first release: `scripts/release.sh v1.0.0`
2. Dry run: `scripts/deploy.sh v1.0.0`. It shows `run-bot.sh starts dist-roster/main.js` and the migration note.
3. Switch: `scripts/deploy.sh --apply --migrate-wrapper v1.0.0`. On top of a normal deploy, it backs up `run-bot.sh` to `~/.wechat-opencode-bot/backups/run-bot.sh.pre-v1.0.0-<time>` and rewrites its `exec node` line to `exec node current/dist/main.js --daemon`. If the health gate fails, it puts the old `run-bot.sh` back and restarts the old build.
4. Commit `run-bot.sh`: `git diff run-bot.sh` shows the one changed line. `scripts/release.sh` refuses to run until you do.
5. Link the agents through `current`: `scripts/install-agents.sh`, then `scripts/install-agents.sh --apply`. The v1.0.0 prompts are copies of the live ones, so it reports `same content` and needs no reload.
6. Check the launchd jobs: `scripts/install-launchd.sh` should report both plists as `unchanged`.

Keep step 5 after step 3. Until the switch, a deploy moves `current` without restarting the bot, so `deploy.sh` refuses to run while the agents link through `current`.

To undo the switch, restore the wrapper and restart the bot:

```bash
cp ~/.wechat-opencode-bot/backups/run-bot.sh.pre-v1.0.0-<time> run-bot.sh
launchctl kickstart -k gui/$(id -u)/com.yupeng.opencode-wechat-bot
```

Keep `dist-roster/` until the new setup has run for a while: the undo starts it.

`dist-roster/` predates `daemon.lock` and writes `daemon.pid` instead, so `scripts/healthcheck.sh` fails on the lock whenever that build runs: until the switch, after an undo, and after a failed switch, where deploy reports `unhealthy after the rollback too`. Check that build with `launchctl print gui/$(id -u)/com.yupeng.opencode-wechat-bot` and its logs. Nothing else reads `daemon.pid`; delete it once the switch holds.

## Agents

The bot runs tasks on the `wechat-orchestrator` agent, which hands work to `wechat-general` and `wechat-explore`. OpenCode loads all three from `~/.config/opencode/agents/`. After `scripts/install-agents.sh --apply`, those files are links into `current/config/agents/`, so a deploy brings its release's prompts and a rollback brings the old ones back.

- OpenCode caches agents until it reloads them. `deploy.sh` reloads them when a release changes a prompt, and again when it rolls back. To reload by hand:

  ```bash
  (set -a; . ~/.wechat-opencode-bot/env; set +a; opencode reload --server "${OPENCODE_URL:-http://127.0.0.1:4096}")
  ```

- To change a prompt, edit `config/agents/<name>.md`, commit, then release and deploy. See [config/agents/README.md](../config/agents/README.md).
- `install-agents.sh` backs up what it replaces to `~/.wechat-opencode-bot/backups/agents-<time>/`. Never keep a backup inside `~/.config/opencode/agents/`: OpenCode also loads `.md` files in its subdirectories as agents, hidden ones included.
- `wechat-ducc.md` is not in the repo, because no agent delegates to it. `install-agents.sh` leaves it alone.

## launchd

| Job | Starts | Notes |
|---|---|---|
| `com.yupeng.opencode-wechat-server` | `run-server.sh`: `opencode serve` on 127.0.0.1:4096 | Load it first: a bot that finds no server starts one of its own |
| `com.yupeng.opencode-wechat-bot` | `run-bot.sh` | Every deploy restarts it |

Both start at login, and launchd starts them again when they exit. Their templates live in `config/launchd/`. `scripts/install-launchd.sh` renders them and diffs them against `~/Library/LaunchAgents/`; with `--apply` it backs up and writes the plists. It never loads anything: it prints the `launchctl bootout` and `bootstrap` commands to run while no task runs.

To restart a job without reloading its definition, for example the server (check `/status` first):

```bash
launchctl kickstart -k gui/$(id -u)/com.yupeng.opencode-wechat-server
```

Manage both jobs with `launchctl`. The bot has no start or stop command of its own:

| To | Run |
|---|---|
| Restart the bot | `launchctl kickstart -k gui/$(id -u)/com.yupeng.opencode-wechat-bot` |
| Stop it until the next login | `launchctl bootout gui/$(id -u)/com.yupeng.opencode-wechat-bot` |
| Start it again | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yupeng.opencode-wechat-bot.plist` |

The bot takes `~/.wechat-opencode-bot/daemon.lock` before it connects to anything, and removes it when it exits. While one bot holds the lock, another `--daemon`, such as one started by hand in a terminal, prints `wechat-opencode-bot already running (pid N)` and exits 0. A lock whose process is gone, or that was written before the last boot, is stale: the next bot replaces it.

Logs are in `~/.wechat-opencode-bot/logs/`. launchd writes `bot.out.log`, `bot.err.log`, `server.out.log` and `server.err.log`; the bot writes `wechat-opencode-bot-<date>.log` and keeps the 3 newest.

## Health

```bash
scripts/healthcheck.sh
```

It changes nothing and exits 1 if any check fails:

- the server job runs, and `/api/info` answers 200. The password from `~/.wechat-opencode-bot/env` reaches curl on stdin, so it never shows in the process list or the output;
- the bot job runs, and `daemon.lock` names its pid;
- `main.js --status` succeeds when run with the bot's own node and entry. Its report is printed.

It also prints the bot's command line, its working directory and where `current` points.

## Backups and cleanup

- `~/.wechat-opencode-bot/backups/` collects `state.db.pre-<tag>-<time>`, `run-bot.sh.pre-<tag>-<time>`, `agents-<time>/` and `launchd-<time>/`. Nothing prunes it.
- Installed releases stay in `releases/`, so a rollback needs no tarball. Delete old releases and their tarballs by hand, never the one `current` points at (`readlink current`).

## CI

`.github/workflows/ci.yml` runs on every push and pull request to `main`:

- `test`: `npm ci`, typecheck, build and test on Node 26.
- `gitleaks`: scans the whole git history for secrets with gitleaks 8.30.1, pinned by checksum.

CI deploys nothing: releases are built and deployed on the machine that runs the bot.
