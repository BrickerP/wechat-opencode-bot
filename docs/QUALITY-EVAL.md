# Prompt quality rubric

How to judge what the agents in [config/agents/](../config/agents/) produce, with synthetic cases to read a prompt change against. Checking the prompts' wording against these cases does not prove that a model behaves this way: that takes a separate evaluation that runs the same cases on each model, every case isolated as [MODEL-QUALITY.md](MODEL-QUALITY.md#evaluation-not-run) describes.

## Why

Recent tasks failed on workflow and judgment, not on knowledge:

- A daily work summary took about 5 minutes and 19 shell calls. Most went to finding the same repository again through its worktrees and to fixing zsh word splitting and missing newlines, until the explorer ran out of steps. The reply then took commits, branches and a tag as proof of deployment.
- A question about an earlier session searched apps and machines for about 20 minutes before asking which machine the user meant.
- The explorer's whole prompt was "Explore and report. Never modify files."

None of this shows that one model is better than another.

## What the prompts and the bridge agree on

- The orchestrators answer and talk to the user through two tools that `plugin/wechat-bridge.js` adds to OpenCode for them alone. `wechat_reply` sends one short note while the work goes on: optional commentary, best-effort, at most 3 per task and 800 characters each, outside the outbox. No case needs it, and the answer is never scored from it.
- The bridge's own progress notes (elapsed time, running tools, subagent count) are off unless `OWB_PROGRESS_ENABLED=true`. They come from the bridge, not the model, so they neither earn nor lose points.
- Every turn ends with exactly one `wechat_report` call: `status` (`done`, `needs_input`, `blocked`, `failed`), `reply`, `summary`, and optional `memory` and `files`. The bridge reads it from the session (`src/opencode/provider.ts`). It is the only answer, sent once through the outbox; text outside the two tools never reaches the user. A turn without the call gets one prompt to make it, then fails with `OpenCode 执行结束，但模型没有给出最终回复`.
- A session holds one piece of work. A follow-up of it comes as the session's next turn, with its own <context>, <memory> and <user_message>; a correction sent while it runs comes as <user_correction>, and a retry after a stopped attempt as <retry>. Every turn ends with its report, and only the task's last report reaches the user.
- The bridge saves at most 5 memory items per task to agentmemory, 600 characters each; an item that starts with an id from <memory> in brackets updates that entry when the prompt showed it whole. It cuts the summary at 100 characters and sends at most 3 files. The prompts ask for a summary under 80 characters.

## Rubric

Score each dimension 0 (fails), 1 (partly) or 2 (meets).

1. Scope: looks on the machine, project, session and time range the user means. Asks one short question only when the answer changes where to look; otherwise uses a default and says so. The latest correction beats memory, recent tasks and earlier turns.
2. Path: direct when no tool is needed, one focused subagent for facts, parallel subagents only for independent sources. No repeated probes and no detours around a failure.
3. Evidence: every fact traces to a report or the context. Status words match the evidence: committed, merged, tagged, built, deployed, verified. Gaps are named, and a git-only summary says so.
4. Check: a disputed or inferred claim the answer depends on gets one targeted check; a simple or directly evidenced answer gets none.
5. Reply: Chinese by default, plain text, result first, length fitting the goal. No subagent or tool names, call counts or elapsed time; words the user asked about, such as session, are fine.
6. Notes: at most a short, useful `wechat_reply` while slow work goes on; none for a direct answer; no reasoning.
7. Protocol: the turn ends as agreed above, and its status fits the reply: `needs_input` when the reply asks the user something. Memory holds durable facts, each in Chinese with its conclusion, reason and date, or is left out; an update starts with an id <memory> showed, and nothing repeats what <memory> already says. Files are regular files under the workspace, of an allowed type, at most 20 MB each.

Any of these fails the case:

- A positive claim without evidence behind it: deployed, 已部署, 部署成功, 已上线, verified, done, tests pass or 测试通过. A truthful negative, such as 尚未确认部署 or 未确认是否上线, is not such a claim: judge what the reply asserts, not the words it uses.
- An answer from a machine or project other than the one the user meant.
- No `wechat_report`, or an empty reply.
- Tool-call markup inside the reply.
- A secret, token or one-off result in memory.

## Cases

All inputs and outputs are synthetic. "Before" is the failure the case guards against; "after" is an answer that scores 2 on every dimension.

### 1. Greeting

Input: `早`, no project.

Before: writes "收到，我看看" and starts a subagent to look around the workspace, or writes the greeting as text and never reports.

After, with no subagent and no note:

    wechat_report
      status: done
      reply: 早！今天先处理什么？
      summary: 问候

### 2. Work summary: tagged, not deployed

Input: `总结一下我今天的工作`, time 2026-11-12 18:30. One repository has a main checkout and two worktrees. Today it got 3 commits on `feat/quality`, not merged, a merge of `fix/retry` into `main`, and the tag `v1.4.0`. Nobody checked a deploy record.

Before: runs `git log --all` in every worktree, so each commit shows up three times; spends its steps on a zsh loop over the worktree paths; replies "v1.4.0 已上线".

After: optionally the note `我先核对今天各仓库的提交和标签，再按工作主题整理。`, then one `wechat-explore` brief: each repository once, not once per worktree; 2026-11-12 00:00 to now, Asia/Shanghai, by author and by committer date; branch, merge and tag for each item, with hashes; what the scan did not cover.

    wechat_report
      status: done
      reply: |
        今天（11-12）git 里能看到的工作：
        1. 回复质量：feat/quality 上 3 个提交，还没合并到 main。
        2. 发布：fix/retry 已合并到 main（a1b2c3d），并打了 v1.4.0 标签。
        只看了本机仓库的 git 记录，没有查部署记录，所以 v1.4.0 是否已上线还不能确认；会议、评审这类不在 git 里的工作也没有算进来。需要的话我接着查部署记录。
      summary: 汇总 11-12 的 git 工作：3 个提交未合并，v1.4.0 已打标签、未确认部署

### 3. Which machine's session

Input: `昨天那个会话最后卡在哪了？`. <recent_tasks> has no session from yesterday, and <memory> says the user also works on M1 but not which machine the bot runs on.

Before: searches the session stores of several apps on this machine, then other machines, and asks which one about 20 minutes later.

After, with no subagent:

    wechat_report
      status: needs_input
      reply: 你说的是 M1 上的会话，还是这台机器上的？
      summary: 询问要查哪台机器上的会话

When the user answers `M1`, the answer comes as the next turn of this session, and the orchestrator briefs one `wechat-explore` call for M1 only, for 2026-11-11 in Asia/Shanghai.

### 4. The machine is offline

Input: `M1 上最新的会话在干嘛？`. The `wechat-explore` report: `ssh m1` timed out twice, and nothing else was checked.

Before: tries another hostname, a LAN address and a relay, then describes this machine's latest session as if it were M1's.

After:

    wechat_report
      status: blocked
      reply: M1 现在连不上（ssh 两次都超时），没法查它上面的会话。确认 M1 开机并联网后，再问我一次就行。
      summary: M1 ssh 超时，未能查最新会话

### 5. Reports disagree

Input: `v1.4.0 上线了吗？`. The first report: `current` points to the v1.4.0 release, but the deploy log's last entry is v1.3.2.

Before: picks one source and says "已上线" or "没上线", or pastes both without saying which holds.

After: optionally the note `部署记录和当前版本对不上，我再核对一下正在运行的版本。`, then one targeted `wechat-explore` check: which release the running process started from, and when. If that settles it:

    wechat_report
      status: done
      reply: v1.4.0 已经上线：current 指向 v1.4.0，正在运行的进程是 11-12 18:02 从这个版本启动的。部署日志最后一条还是 v1.3.2，这次切换没有记进日志，原因还没查。
      summary: 确认 v1.4.0 已上线；部署日志缺这次记录

If the check cannot settle it, the reply says what each source shows and that deployment is not confirmed.

### 6. A whole file the user asked for

Input: `把 orchestrator 提示词里输出格式那段原文发我`, in this repository.

Before: pastes the whole prompt into the reply, or rewrites the section in its own words.

After: quotes the few lines asked for byte for byte, and sends the file for the rest:

    wechat_report
      status: done
      reply: |
        那一段在 config/agents/wechat-orchestrator.md 的 The report 一节，整个文件作为附件发你。要点：每一轮以一次 wechat_report 结束，reply 是给你看的全部内容。
      summary: 发送 orchestrator 提示词，说明回报格式
      files: [/Users/me/code/wechat-opencode-bot/config/agents/wechat-orchestrator.md]

Logs work the same way: quote the few lines that matter, and attach the whole file when the user wants all of it.

### 7. A follow-up continues the session

Input: `继续，查下部署记录`, as the next turn of case 2's session. Its <context> has only the time and the task number, and <memory> has nothing new.

Before: scans every repository's git log again, or asks which release the user means.

After: one `wechat-explore` brief for the deploy record of v1.4.0 only, with the tag and the merge hash the first turn found. If the record shows the deploy:

    wechat_report
      status: done
      reply: v1.4.0 已经上线：部署记录显示 11-12 18:02 部署到生产，之后没有回滚。feat/quality 上的 3 个提交还没合并，不在这次发布里。
      summary: 查部署记录，确认 v1.4.0 已于 11-12 18:02 上线

## Using the rubric

- After changing a prompt, walk each case through the new text: name the line that produces the "after" behaviour, and any line that still allows the "before".
- Reading shows what the prompt asks for, not what a model does. Live quality needs the same inputs run on each model and scored with this rubric, in a separate evaluation: each case in a fresh synthetic fixture with its own temporary home and data directory, the same seed, no WeChat sends and no live memory, as [MODEL-QUALITY.md](MODEL-QUALITY.md#evaluation-not-run) describes.
