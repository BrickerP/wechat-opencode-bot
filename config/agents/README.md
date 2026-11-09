# OpenCode agents

The prompts the bot's tasks run with. `src/orchestrator.ts` parses the markers that `wechat-orchestrator.md` asks for (`<<<WECHAT_REPLY>>>`, `<<<WECHAT_MEMORY>>>`, `<<<WECHAT_SUMMARY>>>`), so each release ships its prompts together with the code that reads them.

| File | Mode | Job |
|------|------|-----|
| `wechat-orchestrator.md` | primary | Plans each task, delegates to the two subagents, answers with the markers above |
| `wechat-explore.md` | subagent | Read-only exploration |
| `wechat-general.md` | subagent | Implementation with full access |

`wechat-ducc.md` in the live agents directory is not kept here: no agent is allowed to delegate to it.

## How they are deployed

OpenCode reads agents from `~/.config/opencode/agents/`. After the one-time setup in [docs/DEPLOY.md](../../docs/DEPLOY.md), each file there is a symlink into the deployed release:

```
~/.config/opencode/agents/wechat-orchestrator.md -> <repo>/current/config/agents/wechat-orchestrator.md
```

`scripts/deploy.sh` and `scripts/rollback.sh` move `current`, so prompts and code switch together. OpenCode caches agents until `opencode reload` or a server restart; `deploy.sh` reloads when a release changes the prompts.

## Change a prompt

1. Edit the file here and commit it.
2. `scripts/release.sh vX.Y.Z`
3. `scripts/deploy.sh --apply vX.Y.Z`

Do not edit the files in `~/.config/opencode/agents/`: they point into a release, and the next deploy replaces it.

## Install or repair the links

```bash
scripts/install-agents.sh          # dry run: what would change
scripts/install-agents.sh --apply
```

It links every `*.md` of `current/config/agents/` and removes links whose prompt left the release. Whatever it replaces goes to `~/.wechat-opencode-bot/backups/agents-<time>/`. Backups stay out of the agents directory on purpose: OpenCode loads `.md` files in its subdirectories, hidden ones included, as extra agents.

## Roll back

- A release: `scripts/rollback.sh --apply <tag>`. The prompts follow `current`.
- The links themselves: copy the files from the backup directory back to `~/.config/opencode/agents/`, then reload OpenCode (see [docs/DEPLOY.md](../../docs/DEPLOY.md#agents)).
