# OpenCode agents

The prompts the bot's tasks run with. Both orchestrators end every turn with a `wechat_report` call and may send short notes with `wechat_reply`. The two tools come from the OpenCode plugin [`plugin/wechat-bridge.js`](../../plugin/wechat-bridge.js), which hides them from every other agent, and `src/opencode/provider.ts` reads their calls from the session. Each release ships the prompts, the plugin and the code that reads the calls together.

| File | Mode | Job |
|------|------|-----|
| `wechat-orchestrator.md` | primary | Scopes each task, briefs the two subagents, checks their reports and answers with `wechat_report` |
| `wechat-orchestrator-read.md` | primary | The orchestrator for read-only bots such as @research: it can only start `wechat-explore`, never the writer `wechat-general`, so it cannot change anything beside a running write task. Same tools |
| `wechat-explore.md` | subagent | Read-only investigation: the answer, each fact with its source, and what it could not check |
| `wechat-general.md` | subagent | Implementation with full access: what changed, the commands it ran and their results |

The two subagents have no `model:` line on purpose: OpenCode then runs them on the parent session's model, so a task that fell back to another gateway keeps its whole session tree on that gateway. Both orchestrators pin the default primary model; a chat's `/model` or a bot's `model` in `bots.json` overrides it. Keep the pinned model equal to `OPENCODE_DEFAULT_MODEL` (default `oneapi/DeepSeek-V4.1-Flash`) in both: routing assumes this gateway when neither is set, and the two disagreeing would charge failures to the wrong gateway.

`wechat-ducc.md` is not part of the setup: no agent may delegate to Ducc.

## What the prompts ask for

- Scope first. The orchestrators settle the machine, project, session and time range before any work. When the target could be on another machine or in another project, they ask one short question instead of searching; when a broad request has a natural default, they use it and say so.
- The lightest path. A direct answer when no tool is needed, one well-briefed subagent for facts, parallel subagents only for independent sources. A disputed or inferred claim gets one targeted `wechat-explore` check; other answers get none.
- Evidence. The subagents lead with the answer and give each fact its source. A commit, branch, merge or tag is never reported as deployed or verified, and a summary from git says it covers git only.
- One session per piece of work. A follow-up of the same work, a correction sent while it runs (`<user_correction>`) and a retry after a stopped attempt (`<retry>`) all continue the task's session, so every turn ends with its own `wechat_report`, and the last one stands on its own: only it reaches the user.
- Recall by id. `<recent_tasks>` gives each task's session id and `<context>` gives `session-reader`, this build's `node dist/main.js --session`. To learn what an earlier task did, the orchestrator has `wechat-explore` run it on that id, which prints the session's last answer and its subagents' reports, instead of searching logs or databases.
- Memory. `<memory>` holds up to 8 of the owner's agentmemory entries that match the message, each with its id and date; the owner's other agents share them. The orchestrators list facts in `wechat_report`'s `memory`, in Chinese, conclusion first, then the reason and the date, and the bridge saves them there. An item that starts with an entry's id in brackets replaces that entry, when the prompt showed it whole; one shown cut, ending in `…`, gets a new entry instead.
- Notes and the answer. An orchestrator may send one or two short notes with `wechat_reply` while slow work goes on; the bridge forwards each to the chat as commentary: best-effort, at most 3 per task, and not part of the answer. The bridge's own progress notes (elapsed time, running tools, subagent count) are diagnostics, off unless `OWB_PROGRESS_ENABLED=true`, and no prompt writes them. The answer is the turn's `wechat_report`: `needs_input` when the reply asks the user something, so `/tasks` and the router show the task as waiting for an answer. Text outside the two tools never reaches the chat.

[docs/QUALITY-EVAL.md](../../docs/QUALITY-EVAL.md) has the rubric and synthetic cases to check a prompt change against.

## How they are deployed

OpenCode reads agents from `~/.config/opencode/agents/` and server plugins from `~/.config/opencode/plugins/`. After the one-time setup in [docs/DEPLOY.md](../../docs/DEPLOY.md), each prompt there and the bridge plugin are symlinks into the deployed release:

```
~/.config/opencode/agents/wechat-orchestrator.md -> <repo>/current/config/agents/wechat-orchestrator.md
~/.config/opencode/plugins/wechat-bridge.js -> <repo>/current/plugin/wechat-bridge.js
```

`scripts/deploy.sh` and `scripts/rollback.sh` move `current`, so prompts, the plugin and code switch together. OpenCode caches agents and plugins until `opencode reload` or a server restart; `deploy.sh` reloads when a release changes the prompts or the plugin.

## Change a prompt

1. Edit the file here, commit it and get the commit onto `main`.
2. Once CI has passed for that commit, download its artifact and package it: `scripts/release.sh vX.Y.Z <artifact-dir>`, as [docs/DEPLOY.md](../../docs/DEPLOY.md#release) shows. Nothing is compiled or tested in this step.
3. `scripts/deploy.sh --apply vX.Y.Z`

Do not edit the files in `~/.config/opencode/agents/`: they point into a release, and the next deploy replaces it.

## Install or repair the links

```bash
scripts/install-agents.sh          # dry run: what would change
scripts/install-agents.sh --apply
```

It links every `*.md` of `current/config/agents/` and `current/plugin/wechat-bridge.js`, and removes links whose prompt or plugin left the release. Whatever it replaces goes to `~/.wechat-opencode-bot/backups/agents-<time>/`. Backups stay out of the agents directory on purpose: OpenCode loads `.md` files in its subdirectories, hidden ones included, as extra agents.

## Roll back

- A release: `scripts/rollback.sh --apply <tag>`. The prompts follow `current`.
- The links themselves: copy the files from the backup directory back to `~/.config/opencode/agents/`, then reload OpenCode (see [docs/DEPLOY.md](../../docs/DEPLOY.md#agents)).
