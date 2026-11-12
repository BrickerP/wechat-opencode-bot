# Contributing

Bug reports, fixes and docs are welcome. For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Prerequisites

- Node.js 26, the version CI uses.
- OpenCode 2 (`npm install -g @opencode/cli`), only to run the bot: the tests use a fake OpenCode server.
- macOS, only for the launchd jobs in [docs/DEPLOY.md](docs/DEPLOY.md). CI runs the tests on Ubuntu.

## Build and test

```bash
npm ci
npm run typecheck
npm run build
npm test
```

`npm test` runs the compiled tests in `dist/tests/`, so build first. To run one file: `npm run build && node --test dist/tests/bots.test.js`. CI runs the same four steps on Node 26, plus a gitleaks scan of the whole history.

When the four steps pass, CI also uploads `dist/` with a `BUILD_COMMIT` file as the artifact `wechat-opencode-bot-build-<commit>`. A release packages the artifact of a push to `main` and compiles nothing; see [docs/DEPLOY.md](docs/DEPLOY.md#release).

## Where things are

- `src/`: the daemon. `main.ts` holds the CLI and the inbound messages, `orchestrator.ts` runs a task, `tests/` holds the tests.
- `config/agents/`: the four OpenCode agent prompts.
- `scripts/`: release, deploy, rollback, the health check, and the agent and launchd installers.
- `docs/DEPLOY.md`: releases, launchd, the watchdog and model routing.

The full table is under [Repository layout](README.md#repository-layout) in the README.

## Run the bot locally

1. Start a server: `opencode serve --hostname 127.0.0.1 --port 4096`.
2. Point the orchestrators at a model you have. The prompts pin `oneapi/...` models; [docs/PROVIDERS.md](docs/PROVIDERS.md) lists what to change.
3. `npm run build`, then `scripts/install-agents.sh --apply`, which links the prompts into OpenCode and backs up whatever it replaces. Run the `opencode reload` command it prints.
4. `node dist/main.js --simulate "列出工作目录"` runs one task as if it came from WeChat and prints the reply. It needs no WeChat account and denies every permission ask.
5. For the real bot: `npm run setup` binds a WeChat account by QR code, `node dist/main.js --daemon` runs the bot, and `node dist/main.js --status` shows its pid and tasks.

Leave the model change from step 2 out of your pull request unless the pull request is about models.

## Change an agent prompt

1. Edit the prompt in `config/agents/`, never the links in `~/.config/opencode/agents/`.
2. Try it. In a checkout without `current/`, `scripts/install-agents.sh --apply` links the repo's `config/agents/`, so after `opencode reload` a `--simulate` run uses your edit.
3. Keep the output markers. `src/orchestrator.ts` parses `<<<WECHAT_REPLY>>>` and the markers after it, so changing a marker takes a code change and a test in the same pull request.
4. On an always-on bot, ship it as a release once it is on `main` and CI has passed for that commit: download the commit's artifact and run `scripts/release.sh vX.Y.Z <artifact-dir>`, then `scripts/deploy.sh --apply vX.Y.Z`, as [docs/DEPLOY.md](docs/DEPLOY.md#release) shows. `release.sh` packages CI's `dist/` and compiles nothing. Prompts and code switch together, and the deploy reloads OpenCode when the prompts changed. After the first deploy, rerun `scripts/install-agents.sh --apply` so the links follow `current/`.

[config/agents/README.md](config/agents/README.md) explains how the prompts are deployed and rolled back.

## Tests

- `node:test` and `node:assert/strict`, one file per area in `src/tests/`.
- No real network, WeChat account or model. A test that needs OpenCode starts a fake server with `node:http` on `127.0.0.1:0`, as `control.test.ts` does.
- Tests that touch state point `HOME` and `OWB_DATA_DIR` at a `mkdtempSync` directory before they load the bot's modules. Tests that need OpenCode also set `OPENCODE_URL` first and load the modules with `await import(...)`, because `src/opencode/provider.ts` reads `OPENCODE_URL` when it loads.
- A test that sets an environment variable deletes it again, as `model-routing.test.ts` does.

## Secrets and state

The bot keeps its state outside the checkout, in `~/.wechat-opencode-bot/`: `env`, `accounts/` (the iLink token), `state.db`, `memory/`, `attachments/` and `logs/`. Keep all of it out of commits, issues and test fixtures, and do not point `OWB_DATA_DIR` inside the repo. The same goes for real WeChat ids, tokens, keys and gateway URLs. `.gitignore` covers build output and `*.log`, not these files.

CI scans the whole history with gitleaks, so a secret that a later commit deletes still fails the check. Drop it from your branch's history and rotate it as [SECURITY.md](SECURITY.md#secrets) describes.

## Commits and pull requests

- One change per pull request, small enough to review in one sitting.
- Behavior changes come with tests, and `npm run typecheck`, `npm run build` and `npm test` pass. CI runs the same checks.
- `README.md` and `README_zh.md` mirror each other line for line, so change both. Update `docs/DEPLOY.md` when a command, a variable or a deploy step changes.
- Commit subjects are imperative, like the history: `Add watchdog webhook and dead-man's-switch ping`.
- No build output in commits: `dist/`, `releases/`, `current` and `node_modules/` stay out.
