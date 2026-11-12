# Work activity from local git

`scripts/collect-work-activity.mjs` lists, as JSON, one calendar day's commits in the git repositories under a directory, and which of their worktrees have uncommitted changes. It is a standalone Node.js script that uses only Node's built-in modules: run it from a checkout of this repository, with Git 2.31 or later on `PATH`.

It only reads. It never fetches or pushes, its git calls take no optional locks, and the one file it writes is the `--output` file.

What it reports is local git evidence. Git cannot show that anything was built, tested, reviewed, released or deployed, so `deploymentVerified` is always `false`; see [What git cannot show](#what-git-cannot-show).

## Run it

```bash
node scripts/collect-work-activity.mjs --root ~/code --date 2026-11-12
node scripts/collect-work-activity.mjs --root ~/code --date 2026-11-12 --timezone UTC \
  --author alice@example.com --output activity.json
```

| Option | Meaning |
|---|---|
| `--root DIR` | Required. The directory to search. Its real path is used, with symlinks resolved. |
| `--date YYYY-MM-DD` | Required. A real calendar day from 1970 on: `2026-02-30` is rejected. |
| `--timezone ZONE` | `Asia/Shanghai`, the default, or `UTC`. |
| `--author VALUE` | Keep only commits whose author name or author email is exactly `VALUE`. |
| `--output FILE` | Write the JSON to `FILE` instead of stdout. Its directory must exist. |
| `-h`, `--help` | Print the usage and exit. |

The exit status is 0 when the JSON was printed or written. It is 1, with no JSON and one line on stderr that starts with `collect-work-activity:`, for a missing or unknown option, a bad date or zone, a root that is not a directory, `git` missing from `PATH`, or a failed write. A repository git cannot read does not fail the run; it becomes a warning.

The script is also a module. `collectWorkActivity({ root, date, timezone, author })` returns the result object, without the output size limit below, and throws on a bad date, zone or root; `main(argv)` is the CLI and returns its exit status. Importing the module runs neither.

## The day

The day is `[start, end)`: from 00:00:00 on `--date` in the zone, included, to 00:00:00 on the next day, excluded. Only two zones are accepted, with fixed offsets: `Asia/Shanghai` is UTC+08:00, as China has no daylight saving time, and `UTC` is UTC+00:00. Any other name, such as `Asia/Tokyo` or `utc`, is an error rather than a guess, and the machine's own time zone plays no part. Every time in the output carries the zone's offset, such as `2026-11-12T09:30:00+08:00`.

A commit belongs to the day by its committer time. The author time is reported but not used: a commit written days ago and rebased, amended or cherry-picked today is in today's list with its old `authoredAt`, and a commit written today but committed after the end, for example by a later rebase, is not.

The collector asks git for the day with `--since` and `--until`, then checks `[start, end)` itself, because git's `--until` includes the end second. Git walks history back from each branch tip and stops going down a line at the first commit older than the start. A commit inside the day that sits behind an older-dated commit, as a wrong clock can leave it, is therefore missed.

## Author

`--author` compares the value with the author name and with the author email, exactly and case-sensitively, and keeps a commit when either is equal. It is not git's `--author`, which takes a regular expression: `--author Alice` keeps `Alice <alice@example.com>` but not `Alice Smith <alice.smith@example.com>`, and part of an email address matches nothing. The committer is not compared, and an empty value means no filter.

Without `--author` the list has every commit of the day, including other people's commits that a fetch brought into remote-tracking branches.

## What it searches

1. **Discovery.** From the root, breadth-first and in name order, the collector reads directories down to 4 levels below the root, never above it. A directory with a `.git` directory or file is a candidate, and discovery goes on inside it, so nested repositories are found too. It never enters directories named `.git`, `node_modules`, `.cache`, `dist` or `build`, or symlinks. A bare repository has no `.git` entry and is not found.
2. **Grouping.** `git rev-parse --git-common-dir` gives each candidate's common git directory. Candidates that share one, a repository and its linked worktrees, form one entry in `repositories`. A candidate git rejects becomes a warning.
3. **Commits.** One `git log --all` per repository covers its local branches, tags, remote-tracking branches and the `HEAD` of each of its worktrees. Stashes and reflogs are not read.
4. **Dirty state.** `git status --porcelain` runs in each worktree found under the root, after all the logs.

## Output

| Field | Meaning |
|---|---|
| `root` | The real path searched. |
| `date`, `timezone` | The day and zone used. |
| `timeRange` | `start` and `end` in the zone, and `startEpoch` and `endEpoch` in Unix seconds. The range is `[start, end)`. |
| `authorFilter` | The `--author` value, or `null`. |
| `repositories` | One entry per common git directory, in discovery order. |
| `warnings` | What could not be read or was cut short, one sentence each. |
| `truncated` | `true` when a [fixed limit](#limits-and-coverage) cut something off. |
| `elapsedMs` | How long the collection took. |
| `deploymentVerified` | Always `false`. |
| `scope`, `limitations` | The caveats of this page in short, so that they travel with the data. |

Each entry of `repositories`:

| Field | Meaning |
|---|---|
| `commonDir` | The common git directory, such as `/home/alice/code/shop-api/.git`. |
| `worktrees` | `{ path, dirty }` for each worktree of the repository found under the root. |
| `commits` | The day's matching commits that no earlier entry listed, in `git log` order. |
| `duplicateCommits` | How many of the day's matching commits were left out because an earlier entry listed them. |

Each commit:

| Field | Meaning |
|---|---|
| `hash` | The full commit hash. |
| `parents` | Parent hashes: none for a root commit, two or more for a merge. |
| `subject` | The message's subject, its first paragraph on one line, at most 500 characters. |
| `authorName`, `authorEmail` | Who wrote it. |
| `authoredEpoch`, `authoredAt` | When it was written: Unix seconds, and the time in the zone. |
| `committedEpoch`, `committedAt` | When it was committed, the time that places it in the day. |

`authoredAt` and `committedAt` are `null` for a time that ISO 8601 cannot hold, past the year 9999.

This excerpt comes from a run with `--author alice@example.com` on a synthetic fixture, with `scope` and `limitations` left out:

```json
{
  "root": "/home/alice/code",
  "date": "2026-11-12",
  "timezone": "Asia/Shanghai",
  "timeRange": {
    "start": "2026-11-12T00:00:00+08:00",
    "end": "2026-11-13T00:00:00+08:00",
    "startEpoch": 1794412800,
    "endEpoch": 1794499200
  },
  "authorFilter": "alice@example.com",
  "repositories": [
    {
      "commonDir": "/home/alice/code/shop-api/.git",
      "worktrees": [
        { "path": "/home/alice/code/shop-api", "dirty": true },
        { "path": "/home/alice/code/shop-api-hotfix", "dirty": false }
      ],
      "commits": [
        {
          "hash": "c980b6138b035f64e2b6fdaa6fe48f44220e5701",
          "parents": ["df8d0ab75695822cee734bbf1b05ef04ae0acfe7"],
          "subject": "Fix rounding in invoice totals",
          "authorName": "Alice",
          "authorEmail": "alice@example.com",
          "authoredEpoch": 1794447000,
          "authoredAt": "2026-11-12T09:30:00+08:00",
          "committedEpoch": 1794447000,
          "committedAt": "2026-11-12T09:30:00+08:00"
        }
      ],
      "duplicateCommits": 0
    }
  ],
  "warnings": ["cannot read /home/alice/code/archive: EACCES"],
  "truncated": false,
  "elapsedMs": 98,
  "deploymentVerified": false
}
```

`shop-api` has one commit on the day, by Alice at 09:30. Its main worktree has uncommitted changes and its `hotfix` worktree has none. One directory could not be read, so the run may have missed repositories inside it.

## Duplicates

A run lists each commit once. Inside a repository one log covers all branches and worktrees, so a commit on several branches appears once. Across repositories, the first entry in output order that has a commit lists it, and later entries, such as another clone of the same project, only count it in `duplicateCommits`. Commits are compared by hash: a rebased or cherry-picked copy has a new hash and is listed as a commit of its own.

## Limits and coverage

The limits are fixed in the script; no option changes them.

| Limit | Value | When it is reached |
|---|---|---|
| Directory depth | 4 levels below the root | Deeper directories are not read. This is the scope, so there is no warning. |
| `.git` candidates | 100 | Discovery stops. Warning, and `truncated`. |
| Whole run | 20 seconds | The remaining steps are skipped. Warning, and `truncated`. |
| One git call | 2 seconds, and 4 MiB of output for `git log` or 64 KiB for other calls | The call is stopped; a stopped `git log` keeps the commits it had printed. Warning, and `truncated`. |
| Commits per repository | 200 | The rest are dropped, and the warning gives how many matched. `truncated`. |
| Subject | 500 characters | Cut, without a warning. |
| Warnings | 100 | One more line says the rest were dropped. `truncated`. |
| Output | 2 MiB of JSON | Commits are dropped from the end until it fits. Warning, and `truncated`. |

A run covered everything in its scope only when `warnings` is empty and `truncated` is `false`. A warning without `truncated` is a gap that no limit caused: a directory that could not be read, a `.git` that git rejects, a failed git call or log records that could not be parsed. Even a clean run says nothing about what lies outside the scope: deeper or skipped directories, symlinks, bare repositories, stashes, other machines, and everything not committed.

## Dirty worktrees

`dirty` describes a worktree at the time of the run, not on `--date`:

- `true`: `git status --porcelain` printed something, that is a modified, staged, deleted, conflicted or untracked file. Ignored files do not count, and a status call that printed something before it was stopped also counts.
- `false`: git succeeded and printed nothing.
- `null`: git failed or the run ran out of time; a warning says which.

A dirty worktree means that uncommitted work exists now. It does not say when that work was done, and it is never a commit: a repository with no commits on the day still appears, with its dirty worktrees. Only worktrees under the root are checked. A linked worktree elsewhere is not listed, though its `HEAD` is in the repository's log.

## What git cannot show

Commits, tags, branch names, remote-tracking branches and commit messages are statements in a repository, not proof of what happened to the code. Git cannot show that a commit was built, tested, reviewed, merged upstream, released, deployed or verified. A tag named `deployed-production`, a branch named `release/production` or a subject that says "Deploy to production, verified" changes nothing, and `deploymentVerified` stays `false`. Check those facts in CI, in the deploy system or on the running service, and name the source when you report them.

Remote-tracking branches show a remote as of this machine's last fetch, and the collector never fetches. No commits does not mean no work either: uncommitted work, work in other directories or on other machines, and work outside git do not show here.

## From facts to a summary

1. Collect the day with `--author` set to your commit email, in the zone you report in.
2. Read `warnings` and `truncated` first. If either shows a gap, say what may be missing instead of presenting the list as complete.
3. Write one line per change from its `subject`, grouped by repository, with a short hash. When `authoredAt` is days before `committedAt`, say that the change landed on the day, not that it was written then.
4. Mention dirty worktrees as uncommitted work in progress at the time of the run, not as finished work.
5. Use only the verbs git supports, such as "committed". Add "tested", "released" or "deployed" only from another source, and name that source.

For the excerpt above:

> 2026-11-12 (Asia/Shanghai), from local git under `/home/alice/code`: committed "Fix rounding in invoice totals" to shop-api (`c980b61`, 09:30). Uncommitted changes remain in shop-api. One directory could not be read, so this list may be incomplete. Tests and deployment were not checked.
