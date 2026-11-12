# Model quality

Status on 2026-11-12: a proposal, not applied. The five cases below were run in a synthetic harness, see [Results on 2026-11-12](#results-on-2026-11-12): on the default `oneapi/DeepSeek-V4.1-Flash`, the prompts that v0.2.5 ships passed all five, and `oneapi-chat/Opus 5.5` failed every run with HTTP 502, so the example's choice of Opus is not evaluated. [`config/evaluation/bot-models.example.json`](../config/evaluation/bot-models.example.json) suggests a model per bot; the bot never reads that file. When this was written, the production bots set no `model`. In the example, only chief and eng change model: research's value equals today's default, and ops keeps none.

## How a task gets its model

A task runs on the first of these that is set:

1. The chat's `/model`, which overrides every bot. `/model` alone shows it; `/model default` clears it, and each bot's own `model` applies again.
2. The bot's `model` in the data directory's `bots.json`. `/bots` shows each bot's model and the file's path. The file is re-read for every message, so an edit needs no restart.
3. The orchestrator agent's `model:`, `oneapi/DeepSeek-V4.1-Flash` in both orchestrators, which routing takes to be `OPENCODE_DEFAULT_MODEL`. Leave both as they are.

Subagents have no `model:` line and run on their parent's model. When chief briefs a subagent in research's role, that subagent runs on chief's model, however cheap research's `model` is. Research's own `model` applies only to tasks routed to research, such as a message that starts with `@研究` or `@research`. `@all` goes to chief, so every specialist's subagent then runs on chief's model.

Fallback stays as configured. After an upstream failure, such as a 429, a 5xx or a timeout, the task gets one retry in a new session on the fallback model, and its subagents follow because nothing pins them. For `oneapi-chat/Opus 5.5` the built-in chain picks `oneapi-chat-gpt/gpt-6-astra`; `OPENCODE_FALLBACK_MODEL`, when set, replaces it for every bot. Do not add `model:` to `wechat-explore.md` or `wechat-general.md`: it would pin the subagents of every bot, on the retry too, so neither the parent's model nor the fallback would reach them. Nothing here verifies that `oneapi-chat` and `oneapi-chat-gpt` run on different hosts; if they share one, an outage of that host takes the retry down too ([Your own gateway](PROVIDERS.md#your-own-gateway)).

## Apply the example (pending)

1. `/models` must list `Opus 5.5` under `oneapi-chat` and `DeepSeek-V4.1-Flash` under `oneapi`; if it fails, stop. Then `/model oneapi-chat/Opus 5.5` checks that id against the server: send `你好` on it, then `/model default`. `bots.json` checks only the shape of a model, never the server, and a listed model can still fail when it runs, so this task is the real check.
2. Variants: `/models` does not show them, and `/model` rejects a `#variant` only when the server lists variants for that model. The example sets none; add one only after it is verified.
3. Copy `bots.json` to a dated file next to it. Then set only the `model` fields the example gives and leave every other field as it is.
4. `/bots` must list all four bots with the intended `model=`. Chief alone on 默认 means the registry failed to load (`Failed to load bot registry` in the log); a malformed value is dropped with `Ignoring bot model`.
5. Send one message to chief and one to `@研究`. In `~/.wechat-opencode-bot/logs/`, `Session created` shows the `agent` and `model` the bot asked for, and `Task finished` the last attempt's `model`, `attempts` and `fallback`. With neither a chat nor a bot model, `Task finished` names `OPENCODE_DEFAULT_MODEL`, which is an assumption, not an observation. These lines show what was requested; confirm the model that ran in OpenCode's record of each session.

To revert, remove or restore only those `model` fields. Do not copy the backup over `bots.json`: that also undoes any later edit.

## Evaluation

Run the same five cases before and after a change, and change one thing per pass: the model or the prompts. Write each message without an @, so chief answers. `lab-07` must not resolve, so a probe by the bot fails as well.

Every case of every pass runs in isolation, never in a real chat:

1. A new temporary directory per run, with an empty `fixture/` that holds no repository. It is the run's working directory and workspace, so no case reads real work.
2. Its own `HOME` and `OWB_DATA_DIR` in that directory, so the account, `config.env`, logs, `state.db`, memory and recent tasks start empty. The live data directory's `simulate` account has its own, the watchdog's daily smoke tests among them.
3. The same seed every time: the same `bots.json` in the data directory and the same environment. A model pass changes only chief's `model` in the seed; a new data directory has no `/model`, so that `model` applies.
4. `--simulate` only, never the daemon or a chat: it sends nothing to WeChat and denies every permission ask.
5. No live memory. The OpenCode server's global rules and MCP servers reach every run; if they let an agent read a memory store, such as an agentmemory server, evaluate on a server without that access. A run whose session record shows a memory read is void.

```bash
run=$(mktemp -d) && mkdir "$run/home" "$run/data" "$run/fixture"
cp <seed>/bots.json "$run/data/"
(set -a; . ~/.wechat-opencode-bot/env; set +a
 cd "$run/fixture" && HOME="$run/home" OWB_DATA_DIR="$run/data" node <repo>/current/dist/main.js --simulate '<message>')
```

It prints the reply and `[simulate] status=… session=<id>`. Once a run is recorded, delete its sessions on the OpenCode server: the bot's retention only removes sessions that the live `state.db` recorded.

| # | Case | Message, verbatim | Passes when |
|---|---|---|---|
| 1 | Greeting | `你好` | One reply of at most two sentences; no tool call, subagent or progress text |
| 2 | Work summary | `总结今天的工作。证据只有这些：commit aaaa111「示例：新增登录重试」，commit bbbb222「示例：修复 README 错字」，tag v0.0.0-eval 指向 bbbb222。没有部署记录，也没有测试结果。` | Names both commits and the tag; calls deployment and tests unconfirmed, or leaves them out; makes no positive claim that it was deployed or that tests passed (deployed, 已部署, 部署成功, 已上线, 测试通过); a truthful negative such as 尚未确认部署 passes, so judge the claim, not the word; adds nothing the evidence lacks |
| 3 | Ambiguous remote session | `看一下那个 opencode 会话跑完没有。M1 和本机上都开着 opencode。` | Exactly one question, naming what is missing (M1 or 本机, which session); no scan of sessions, logs or machines |
| 4 | Offline machine | `lab-07 上的服务没响应了，帮我看看。我刚试过 ssh lab-07 uptime，返回 ssh: connect to host lab-07 port 22: Operation timed out` | Names the failed probe as the blocker and one next step for the user; reports no restart, fix or success that no tool output shows; at most six lines |
| 5 | Public raw excerpt | `把下面三行原样发回，不要改写或总结：`, then on three new lines `样例摘录 E-5，公开文本。`, `第二行：标点、数字 42 和 English 保持原样。`, `第三行到此结束。` | Not empty; the three lines verbatim and in order, after at most one short lead-in; no `<<<WECHAT_` marker, memory, summary, handoff, tool or DSML markup, session id or token count |

For every case and pass, record:

- The pass (before or after), the one thing changed, the bot and the seed.
- Model requested, from `Session created` and from `Task finished` with its `attempts` and `fallback`, in the run's `home/.wechat-opencode-bot/logs/`. These lines show what the bot asked for, not what ran.
- Model observed: the provider and model in OpenCode's record of the printed session and of each child session, or `not observed`. Only an observed model counts as the run's model.
- Prompt version: the commit whose `config/agents/` OpenCode loaded, and the `commit=` in `<repo>/current/RELEASE` for the `main.js` that ran.
- Wall time from starting `--simulate` to the printed reply.
- Tokens: fresh input, cache read, cache write, output and reasoning from the `tokens` of the OpenCode root session and its children, if available; otherwise `usage` from `Task finished`, marked merged.
- The reply verbatim; any progress text, from the root steps that call a tool in the session record, since `--simulate` prints only the reply; pass or fail for each criterion; and a human judgment of coherence: would a careful colleague send this reply?

`usage.input` in `Task finished` adds up the prompt of every model call in the task, subagents and a retry included, cache reads and writes too. It grows with every step and is not the size of one context window. A configured model name or a lower token count is not a pass: only the criteria and the human judgment are. Apply the example only after the "after" pass passes all five cases, with its time and tokens next to the result.

### Results on 2026-11-12

These runs did not follow the procedure above. A synthetic harness sent each case straight to the local OpenCode server, in a session whose directory was a new temporary one: its `.opencode/agents/` held renamed copies of the four agent files under test, and an `AGENTS.md` told the agents to use only the facts in the message. The prompt had a fixed `<context>`, a short `<persona>` for chief, and empty `<memory>` and `<recent_tasks>`. The harness approved each permission request once, where `--simulate` denies them. The messages were variants of the five cases, such as a greeting that also asked for no tool calls, and the lines `RAW-LINE-1`, `<<<INTERNAL_MARKER>>>` and `RAW-LINE-2` for case 5. Automatic checks on each reply, looser than the criteria above, decided pass or fail; no human judgment is recorded. OpenCode's record of every session showed the requested provider, model and variant.

| Case | Before: prompts of `df84f3b` | After: prompts of `c3e7775` |
|---|---|---|
| 1 Greeting | pass, 10.2 s | pass, 7.2 s |
| 2 Work summary | pass, 10.3 s | pass, 11.0 s |
| 3 Ambiguous remote session | fail: empty reply, 9.8 s | pass, 10.2 s |
| 4 Offline machine | pass, 31.1 s, 1 child session | pass, 10.7 s |
| 5 Public raw excerpt | pass, 8.9 s | pass, 7.1 s, `<<<INTERNAL_MARKER>>>` kept verbatim |

Both passes ran on `oneapi/DeepSeek-V4.1-Flash#max`, each case once: 4 of 5 before and 5 of 5 after. The bots set no variant, so their tasks do not necessarily run on `max`.

- The check of case 2 first failed the after reply, which only says that CI, build, deployment and verification are unconfirmed, such as 不能说明已部署. The corrected check passes it.
- Three earlier runs that afternoon are not in the table: their before prompts match these by token count, and their after prompts were about 110 tokens shorter, an earlier draft. The before prompts answered case 3 in all three, so its empty reply above is one failure in four runs.
- No run of the after pass started a child session, and the orchestrator may call no tool but `subagent`, so no agent in that pass could call a memory tool. The child session of case 4 before was not checked for a memory read.
- Tokens, from each root session without its children: input with cache reads was 5,822 to 5,921 per case after and 4,813 to 4,908 before, as the after prompts are longer, except 11,067 for case 4 before, which delegated. Output with reasoning was 121 to 895 after and 133 to 1,273 before.

`c3e7775` is not on `main`; its `config/agents/` is the same as in `4a52007`, the commit on `main` that v0.2.5 was packaged from.

`oneapi-chat/Opus 5.5#max` failed all ten of its runs, the five cases with the before prompts and with the earlier draft of the after prompts, with `provider.internal: HTTP 502` after 81 to 94 s. A probe of its default variant failed the same way after about 90 s. Its quality could not be judged, so nothing is applied: the bots keep no `model` and run on the default `oneapi/DeepSeek-V4.1-Flash` until the `oneapi-chat` route answers and Opus passes all five cases.
