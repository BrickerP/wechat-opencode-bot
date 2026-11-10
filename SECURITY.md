# Security

## Threat model

The bot runs OpenCode agents on your machine with your user's permissions. `wechat-general` can edit files and run shell commands, as far as your OpenCode permission rules allow, and text the agents read, such as a file in a project, can try to steer them. The daemon acts on every message from the WeChat users in `WECHAT_ALLOWED_IDS`, by default the bound account, so anyone on that list, and anyone who controls one of those WeChat accounts, can act on the machine as you. Keep the list to yourself. The brakes are `/permission plan`, which denies every permission ask, and `/panic`, which also stops every task, cancels the queue and disables the routines.

## What is not a boundary

- The read lane. Read-only bots run on `wechat-orchestrator-read`, which can only start `wechat-explore`, and `wechat-explore` may not edit files. These are OpenCode permission rules, not an OS sandbox: `wechat-explore` can still run shell commands, and a shell command can write anywhere you can.
- The permission modes. They answer only the asks that OpenCode raises. An action your OpenCode rules allow without asking runs even in `plan`, and `auto` approves everything.
- WeChat. The bot takes direct messages from the iLink bot API and checks only that the sender id is in `WECHAT_ALLOWED_IDS`. There is no second factor: whoever holds an allowlisted account holds the bot.
- The local server. `opencode serve` listens on `127.0.0.1:4096`; without `OPENCODE_SERVER_PASSWORD`, any process on the machine can drive it. Never bind it to another interface.

## Secrets

These paths hold secrets or private data. They are the defaults: `OWB_DATA_DIR` moves everything under `~/.wechat-opencode-bot/` except `accounts/` and `logs/`.

| Path | Holds |
|---|---|
| `~/.wechat-opencode-bot/env` | Provider and gateway keys, `OPENCODE_SERVER_PASSWORD`, `OWB_ASR_API_KEY`, webhook URLs. Keep it at `chmod 600` |
| `~/.wechat-opencode-bot/accounts/` | The iLink bot token that setup stores |
| `~/.wechat-opencode-bot/state.db`, `backups/`, `logs/` | Every task's text and reply, chat settings and routines; the logs record accounts, tasks and errors |
| `~/.wechat-opencode-bot/memory/`, `attachments/` | What the bot remembers about you, and the images you sent |
| `~/.local/share/opencode/opencode.db`, `auth.json` | OpenCode's sessions with their tool output, and the credentials OpenCode stores |

Never commit these files or paste them into an issue. CI runs gitleaks over the whole history, which catches many keys but not all.

### If one leaks

1. A provider or gateway key: revoke it with the provider, create a new one, put it where the old one was (`env`, OpenCode's config, or `opencode auth login`), then restart the OpenCode server.
2. The iLink token: run `npm run setup` again to bind a new session, then restart the daemon. We have not confirmed that a new binding revokes the old token.
3. `OPENCODE_SERVER_PASSWORD`, `OWB_ASR_API_KEY` or a webhook URL: replace it in `env`, then restart the server and the daemon ([launchd](docs/DEPLOY.md#launchd) has the commands).
4. `state.db`, the memory files or OpenCode's database: these cannot be rotated. Treat their contents as disclosed, and rotate any secret a task ever printed.

A secret pushed to a public repository is public from that moment, whatever happens to the history later. Rotate it first.

## Reporting a vulnerability

Report it privately through a [GitHub security advisory](https://github.com/BrickerP/wechat-opencode-bot/security/advisories/new): on the repository's Security tab, choose "Report a vulnerability". Do not open a public issue or pull request with the details or an exploit. If the form is not available, open an issue that asks for a private contact and says nothing else about the problem.

Include the commit you tested, what an attacker needs (an allowlisted WeChat account, local access, a file in a project), the steps and the impact. Remove tokens, keys and WeChat ids first.

## Supported versions

Only the latest release gets fixes. There are no published releases yet, so in practice that is the latest commit on `main`, or a release built from it with `scripts/release.sh`. Fixes are not backported to older commits.
