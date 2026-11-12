# Model quality

Status on 2026-11-12: a proposal. Nothing is applied, and the five cases below have not been run. [`config/evaluation/bot-models.example.json`](../config/evaluation/bot-models.example.json) suggests a model per bot; the bot never reads that file. When this was written, the production bots set no `model`. In the example, only chief and eng change model: research's value equals today's default, and ops keeps none.

## How a task gets its model

A task runs on the first of these that is set:

1. The chat's `/model`, which overrides every bot. `/model` alone shows it; `/model default` clears it, and each bot's own `model` applies again.
2. The bot's `model` in the data directory's `bots.json`. `/bots` shows each bot's model and the file's path. The file is re-read for every message, so an edit needs no restart.
3. The orchestrator agent's `model:`, `oneapi/DeepSeek-V4.1-Flash` in both orchestrators, which routing takes to be `OPENCODE_DEFAULT_MODEL`. Leave both as they are.

Subagents have no `model:` line and run on their parent's model. When chief briefs a subagent in research's role, that subagent runs on chief's model, however cheap research's `model` is. Research's own `model` applies only to tasks routed to research, such as a message that starts with `@研究` or `@research`. `@all` goes to chief, so every specialist's subagent then runs on chief's model.

Fallback stays as configured. After an upstream failure, such as a 429, a 5xx or a timeout, the task gets one retry in a new session on the fallback model, and its subagents follow because nothing pins them. For `oneapi-chat/Opus 5.5` the built-in chain picks `oneapi-chat-gpt/gpt-6-astra`; `OPENCODE_FALLBACK_MODEL`, when set, replaces it for every bot. Do not add `model:` to `wechat-explore.md` or `wechat-general.md`: it would pin the subagents of every bot, on the retry too, so neither the parent's model nor the fallback would reach them. Nothing here verifies that `oneapi-chat` and `oneapi-chat-gpt` run on different hosts; if they share one, an outage of that host takes the retry down too ([Your own gateway](PROVIDERS.md#your-own-gateway)).

## Apply the example (pending)

1. `/models` must list `Opus 5.5` under `oneapi-chat` and `DeepSeek-V4.1-Flash` under `oneapi`; if it fails, stop. Then `/model oneapi-chat/Opus 5.5` checks that id against the server: send the greeting case on it, then `/model default`. `bots.json` checks only the shape of a model, never the server, and a listed model can still fail when it runs, so this task is the real check.
2. Variants: `/models` does not show them, and `/model` rejects a `#variant` only when the server lists variants for that model. The example sets none; add one only after it is verified.
3. Copy `bots.json` to a dated file next to it. Then set only the `model` fields the example gives and leave every other field as it is.
4. `/bots` must list all four bots with the intended `model=`. Chief alone on 默认 means the registry failed to load (`Failed to load bot registry` in the log); a malformed value is dropped with `Ignoring bot model`.
5. Send one message to chief and one to `@研究`. In `~/.wechat-opencode-bot/logs/`, `Session created` shows the `agent` and `model` the bot asked for, and `Task finished` the last attempt's `model`, `attempts` and `fallback`. With neither a chat nor a bot model, `Task finished` names `OPENCODE_DEFAULT_MODEL`, which is an assumption, not an observation.

To revert, remove or restore only those `model` fields. Do not copy the backup over `bots.json`: that also undoes any later edit.

## Evaluation (not run)

Send the same five messages before and after a change, and change one thing per pass: the model, with `/model` before touching `bots.json`, or the prompts. Use one chat, the same bot and the same `/cwd`: a scratch directory inside the base directory with no repository, so no case reads real work. Send without an @, so chief answers. Every prompt carries the chat's memory and its last 8 tasks, so before each pass send the same 8 neutral messages, such as `只回复 ok`, and note any memory a pass adds. `lab-07` must not resolve, so a probe by the bot fails as well.

| # | Case | Message, verbatim | Passes when |
|---|---|---|---|
| 1 | Greeting | `你好` | One reply of at most two sentences; no tool call, subagent or progress note |
| 2 | Work summary | `总结今天的工作。证据只有这些：commit aaaa111「示例：新增登录重试」，commit bbbb222「示例：修复 README 错字」，tag v0.0.0-eval 指向 bbbb222。没有部署记录，也没有测试结果。` | Names both commits and the tag; calls deployment and tests unverified or leaves them out; never says deployed, 上线 or tests passed; adds nothing the evidence lacks |
| 3 | Ambiguous remote session | `看一下那个 opencode 会话跑完没有。M1 和本机上都开着 opencode。` | Exactly one question, naming what is missing (M1 or 本机, which session); no scan of sessions, logs or machines |
| 4 | Offline machine | `lab-07 上的服务没响应了，帮我看看。我刚试过 ssh lab-07 uptime，返回 ssh: connect to host lab-07 port 22: Operation timed out` | Names the failed probe as the blocker and one next step for the user; reports no restart, fix or success that no tool output shows; at most six lines |
| 5 | Public raw excerpt | `把下面三行原样发回，不要改写或总结：`, then on three new lines `样例摘录 E-5，公开文本。`, `第二行：标点、数字 42 和 English 保持原样。`, `第三行到此结束。` | Not empty; the three lines verbatim and in order, after at most one short lead-in; no `<<<WECHAT_` marker, memory, summary, handoff, tool or DSML markup, session id or token count |

For every case and pass, record:

- The pass (before or after), the one thing changed, and the bot.
- Model requested, from `Session created`, `Task finished` and its `fallback`; model observed, from OpenCode's record of that `sessionId`, or `not observed`.
- Prompt version: the commit whose `config/agents/` OpenCode loaded and whose `src/orchestrator.ts` the daemon runs.
- Wall time from sending the message to the final reply.
- Tokens: fresh input, cache read, cache write, output and reasoning from the `tokens` of the OpenCode root session and its children, if available; otherwise `usage` from `Task finished`, marked merged.
- The reply verbatim, pass or fail for each criterion, and a human judgment of coherence: would a careful colleague send this reply?

`usage.input` in `Task finished` adds up the prompt of every model call in the task, subagents and a retry included, cache reads and writes too. It grows with every step and is not the size of one context window. A configured model name or a lower token count is not a pass: only the criteria and the human judgment are. Apply the example only after the "after" pass passes all five cases, with its time and tokens next to the result.

| Case | Before | After |
|---|---|---|
| 1 Greeting | not run | not run |
| 2 Work summary | not run | not run |
| 3 Ambiguous remote session | not run | not run |
| 4 Offline machine | not run | not run |
| 5 Public raw excerpt | not run | not run |
