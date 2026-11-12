# OpenCode agents

The prompts the bot's tasks run with. `src/orchestrator.ts` parses the sections both orchestrators end a task with (`<<<WECHAT_REPLY>>>`, `<<<WECHAT_MEMORY>>>`, `<<<WECHAT_SUMMARY>>>`, `<<<WECHAT_HANDOFF>>>` and the optional `<<<WECHAT_FILES>>>`), so each release ships its prompts together with the code that reads them.

| File | Mode | Job |
|------|------|-----|
| `wechat-orchestrator.md` | primary | Scopes each task, briefs the two subagents, checks their reports and answers with the sections above |
| `wechat-orchestrator-read.md` | primary | The read lane's orchestrator, for read-only bots such as @research: it can only start `wechat-explore`, never the writer `wechat-general`, so it cannot change anything beside a running write task. Same sections |
| `wechat-explore.md` | subagent | Read-only investigation: the answer, each fact with its source, and what it could not check |
| `wechat-general.md` | subagent | Implementation with full access: what changed, the commands it ran and their results |

The two subagents have no `model:` line on purpose: OpenCode then runs them on the parent session's model, so a task that fell back to another gateway keeps its whole session tree on that gateway. Both orchestrators pin the default primary model; a chat's `/model` or a bot's `model` in `bots.json` overrides it. Keep the pinned model equal to `OPENCODE_DEFAULT_MODEL` (default `oneapi/DeepSeek-V4.1-Flash`) in both: routing assumes this gateway when neither is set, and the two disagreeing would charge failures to the wrong gateway.

`wechat-ducc.md` is not part of the setup: no agent may delegate to Ducc.

## What the prompts ask for

- Scope first. The orchestrators settle the machine, project, session and time range before any work. When the target could be on another machine or in another project, they ask one short question instead of searching; when a broad request has a natural default, they use it and say so.
- The lightest path. A direct answer when no tool is needed, one well-briefed subagent for facts, parallel subagents only for independent sources. A disputed or inferred claim gets one targeted `wechat-explore` check; other answers get none.
- Evidence. The subagents lead with the answer and give each fact its source. A commit, branch, merge or tag is never reported as deployed or verified, and a summary from git says it covers git only.
- Progress text. An orchestrator may write one short sentence for the user in a response that calls `subagent`; the bridge forwards the text of a finished root step that called a tool, once. The final response carries only the sections above, with the whole answer inside `<<<WECHAT_REPLY>>>`.

[docs/QUALITY-EVAL.md](../../docs/QUALITY-EVAL.md) has the rubric and synthetic cases to check a prompt change against.

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
