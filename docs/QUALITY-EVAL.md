# Prompt quality rubric

How to judge what the agents in [config/agents/](../config/agents/) produce, with synthetic cases to read a prompt change against. Checking the prompts' wording against these cases does not prove that a model behaves this way: that takes a separate evaluation that runs the same cases on each model.

## Why

Recent tasks failed on workflow and judgment, not on knowledge:

- A daily work summary took about 5 minutes and 19 shell calls. Most went to finding the same repository again through its worktrees and to fixing zsh word splitting and missing newlines, until the explorer ran out of steps. The reply then took commits, branches and a tag as proof of deployment.
- A question about an earlier session searched apps and machines for about 20 minutes before asking which machine the user meant.
- The explorer's whole prompt was "Explore and report. Never modify files."

None of this shows that one model is better than another.

## What the prompts and the bridge agree on

- A non-final orchestrator step, one that calls `subagent`, may carry one short sentence for the user. The bridge forwards the text of a finished root step that called a tool, once.
- The final step calls no tool and starts with `<<<WECHAT_REPLY>>>`, then `<<<WECHAT_MEMORY>>>`, `<<<WECHAT_SUMMARY>>>`, `<<<WECHAT_HANDOFF>>>` and, only when sending files, `<<<WECHAT_FILES>>>`. `parseOrchestratorOutput` in `src/orchestrator.ts` reads it.
- The parser uses the text before the first reply marker only when every reply section is empty, so whatever is written before an empty reply section becomes the answer.
- The bridge keeps at most 5 memory bullets per task, 300 characters each, cuts the summary at 100 and the handoff at 1200 characters, and sends at most 3 files. The prompts ask for a summary under 80 and a handoff under 800 characters.

## Rubric

Score each dimension 0 (fails), 1 (partly) or 2 (meets).

1. Scope: looks on the machine, project, session and time range the user means. Asks one short question only when the answer changes where to look; otherwise uses a default and says so. The latest correction beats memory, recent tasks and the handoff.
2. Path: direct when no tool is needed, one focused subagent for facts, parallel subagents only for independent sources. No repeated probes and no detours around a failure.
3. Evidence: every fact traces to a report or the context. Status words match the evidence: committed, merged, tagged, built, deployed, verified. Gaps are named, and a git-only summary says so.
4. Check: a disputed or inferred claim the answer depends on gets one targeted check; a simple or directly evidenced answer gets none.
5. Reply: Chinese by default, plain text, result first, length fitting the goal. No subagent or tool names, call counts or elapsed time; words the user asked about, such as session, are fine.
6. Progress text: at most a short, useful sentence beside a subagent call; none for a direct answer; no reasoning and no markers.
7. Protocol: the final response follows the agreement above. Memory holds durable facts or exactly `- 无`. The handoff has only files:, commands:, open: and next: lines, or exactly `-`. Files are regular files under the workspace, of an allowed type, at most 20 MB each.

Any of these fails the case:

- Deployed, verified, done or tests pass without evidence behind it.
- An answer from a machine or project other than the one the user meant.
- An empty reply, or the answer written before the reply marker.
- A marker string or tool-call markup inside the reply.
- A secret, token or one-off result in memory or the handoff.

## Cases

All inputs and outputs are synthetic. "Before" is the failure the case guards against; "after" is an answer that scores 2 on every dimension.

### 1. Greeting

Input: `早`, no project.

Before: writes "收到，我看看" and starts a subagent to look around the workspace, or writes the greeting above an empty reply section.

After, with no subagent and no progress text:

    <<<WECHAT_REPLY>>>
    早！今天先处理什么？
    <<<WECHAT_MEMORY>>>
    - 无
    <<<WECHAT_SUMMARY>>>
    问候
    <<<WECHAT_HANDOFF>>>
    -

### 2. Work summary: tagged, not deployed

Input: `总结一下我今天的工作`, time 2026-11-12 18:30. One repository has a main checkout and two worktrees. Today it got 3 commits on `feat/quality`, not merged, a merge of `fix/retry` into `main`, and the tag `v1.4.0`. Nobody checked a deploy record.

Before: runs `git log --all` in every worktree, so each commit shows up three times; spends its steps on a zsh loop over the worktree paths; replies "v1.4.0 已上线".

After: progress text `我先核对今天各仓库的提交和标签，再按工作主题整理。`, then one `wechat-explore` brief: each repository once, not once per worktree; 2026-11-12 00:00 to now, Asia/Shanghai, by author and by committer date; branch, merge and tag for each item, with hashes; what the scan did not cover.

    <<<WECHAT_REPLY>>>
    今天（11-12）git 里能看到的工作：
    1. 回复质量：feat/quality 上 3 个提交，还没合并到 main。
    2. 发布：fix/retry 已合并到 main（a1b2c3d），并打了 v1.4.0 标签。
    只看了本机仓库的 git 记录，没有查部署记录，所以 v1.4.0 是否已上线还不能确认；会议、评审这类不在 git 里的工作也没有算进来。需要的话我接着查部署记录。
    <<<WECHAT_MEMORY>>>
    - 无
    <<<WECHAT_SUMMARY>>>
    汇总 11-12 的 git 工作：3 个提交未合并，v1.4.0 已打标签、未确认部署
    <<<WECHAT_HANDOFF>>>
    open: v1.4.0 是否已部署未核对
    next: 查部署记录确认 v1.4.0

### 3. Which machine's session

Input: `昨天那个会话最后卡在哪了？`. <recent_tasks> has no session from yesterday, and <memory> says the user also works on M1 but not which machine the bot runs on.

Before: searches the session stores of several apps on this machine, then other machines, and asks which one about 20 minutes later.

After, with no subagent:

    <<<WECHAT_REPLY>>>
    你说的是 M1 上的会话，还是这台机器上的？
    <<<WECHAT_MEMORY>>>
    - 无
    <<<WECHAT_SUMMARY>>>
    询问要查哪台机器上的会话
    <<<WECHAT_HANDOFF>>>
    open: 问了用户 11-11 的会话在 M1 还是本机
    next: 按回答的机器查 11-11 最后一个会话停在哪一步

When the user answers `M1`, the next task picks up the handoff and briefs one `wechat-explore` call for M1 only, for 2026-11-11 in Asia/Shanghai.

### 4. The machine is offline

Input: `M1 上最新的会话在干嘛？`. The `wechat-explore` report: `ssh m1` timed out twice, and nothing else was checked.

Before: tries another hostname, a LAN address and a relay, then describes this machine's latest session as if it were M1's.

After:

    <<<WECHAT_REPLY>>>
    M1 现在连不上（ssh 两次都超时），没法查它上面的会话。确认 M1 开机并联网后，再问我一次就行。
    <<<WECHAT_MEMORY>>>
    - 无
    <<<WECHAT_SUMMARY>>>
    M1 ssh 超时，未能查最新会话
    <<<WECHAT_HANDOFF>>>
    open: M1 ssh 超时，会话没查
    next: M1 在线后重查最新会话

### 5. Reports disagree

Input: `v1.4.0 上线了吗？`. The first report: `current` points to the v1.4.0 release, but the deploy log's last entry is v1.3.2.

Before: picks one source and says "已上线" or "没上线", or pastes both without saying which holds.

After: progress text `部署记录和当前版本对不上，我再核对一下正在运行的版本。`, then one targeted `wechat-explore` check: which release the running process started from, and when. If that settles it:

    <<<WECHAT_REPLY>>>
    v1.4.0 已经上线：current 指向 v1.4.0，正在运行的进程是 11-12 18:02 从这个版本启动的。部署日志最后一条还是 v1.3.2，这次切换没有记进日志，原因还没查。
    <<<WECHAT_MEMORY>>>
    - 无
    <<<WECHAT_SUMMARY>>>
    确认 v1.4.0 已上线；部署日志缺这次记录
    <<<WECHAT_HANDOFF>>>
    open: 部署日志为何没记 v1.4.0

If the check cannot settle it, the reply says what each source shows and that deployment is not confirmed.

### 6. Markers and raw excerpts

Input: `把 orchestrator 提示词里输出格式那段原文发我`, in this repository.

Before: pastes the section into the reply as it is, and its marker lines count as real ones. The parser takes the sections after the last reply marker, so the user gets only `<the answer for the user>`, the template's memory line `<durable fact worth keeping for future tasks>` is saved as a fact, and the template's summary line becomes the task summary.

After: names the markers without angle brackets and sends the file instead of quoting it:

    <<<WECHAT_REPLY>>>
    那一段在 config/agents/wechat-orchestrator.md 的 Output format 一节，整个文件作为附件发你。原文里的分段标记贴进回复会被当成真的分段，所以这里只说要点：回复依次分 WECHAT_REPLY、WECHAT_MEMORY、WECHAT_SUMMARY、WECHAT_HANDOFF 四段，要发文件时最后加 WECHAT_FILES。
    <<<WECHAT_MEMORY>>>
    - 无
    <<<WECHAT_SUMMARY>>>
    发送 orchestrator 提示词，说明输出格式
    <<<WECHAT_HANDOFF>>>
    -
    <<<WECHAT_FILES>>>
    /Users/me/code/wechat-opencode-bot/config/agents/wechat-orchestrator.md

Logs work the same way: quote the few lines that matter, without marker strings, and attach the whole file when the user wants all of it.

## Using the rubric

- After changing a prompt, walk each case through the new text: name the line that produces the "after" behaviour, and any line that still allows the "before".
- Reading shows what the prompt asks for, not what a model does. Live quality needs the same inputs run on each model and scored with this rubric, in a separate evaluation.
