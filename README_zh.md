# wechat-opencode-bot

[English](README.md) | **中文**

在微信里给 OpenCode 派任务。手机上发出的每条消息都会变成一个任务：bot 在本机的 OpenCode 服务上执行，再把结果发回微信。支持文字、图片和权限审批，能把消息分派给不同的 bot 和项目，并为每个聊天保留一份简短的记忆。

## 工作原理

```
微信（手机） ←→ ilink bot API ←→ bot 守护进程（Node.js） ←→ OpenCode 服务（127.0.0.1:4096）
```

- 守护进程长轮询微信 ilink bot API，只处理 `WECHAT_ALLOWED_IDS` 里的微信用户，默认是执行 setup 的那个账号。
- 不是命令的消息都会创建任务。同一时间最多运行一个写任务和一个只读任务（来自 @research 这类只读 bot），新消息在各自的队列里排队（`⏳ 已排队：任务 #N（前面还有 X 个任务）`）并按顺序执行；排队超过 24 小时的任务会过期。
- 每个任务都在新的 OpenCode 会话里运行，使用 `wechat-orchestrator` agent；只读 bot 的任务使用 `wechat-orchestrator-read`，它只能派出只读的子 agent。会话从不复用：上下文由 bot 写进提示词，包括最近 8 个任务（其中最近 2 个带回复摘录）和这个聊天的记忆。
- 模型所在网关出错或长时间没有输出时，会换到另一条网关重试一次（`OPENCODE_FALLBACK_MODEL`，或默认的跨网关链）。同一网关连续 3 次上游失败会熔断：后续任务直接走备用模型，只发一条通知；10 分钟后自动重试该网关，再失败则等待时间翻倍，最长 1 小时。你只会收到最终结果。
- 回复按 2048 字符分段发送。微信只接受基于最近一条消息 token 的回复，发不出去的回复会进入待发队列，在你发下一条消息后补发。
- 图片保留 24 小时。紧跟在带图片的任务之后、10 分钟内发出的纯文字任务，会沿用那些图片。
- bot 重启会中断正在运行的任务并发出 ⏹ 通知，排队的任务照常执行。

## Bot 与项目

### Bot

`~/.wechat-opencode-bot/bots.json` 列出在聊天里回复的 bot。首次使用时自动生成，每条消息都会重新读取，无效条目会被跳过。默认名单：

| id | 名称 | 别名 | 回复前缀 | 委派给 |
|---|---|---|---|---|
| `chief`（默认） | Chief | chief、总管 | 无 | — |
| `research` | 研究 | research、研究 | 研究： | `wechat-explore` |
| `eng` | 工程 | eng、工程、code | 工程： | `wechat-general` |
| `ops` | Ops | ops、运维 | Ops： | `wechat-general` |

- 以 `@别名` 开头指定由哪个 bot 回复；不指定时由默认 bot 回复，不会根据内容猜测 bot。
- `@all` 或 `@everyone` 交给默认 bot 统筹，它最多同时调度 3 个子 agent，最后合并成一条回复。

### 项目

`~/.wechat-opencode-bot/projects.json` 把别名映射到项目目录。它由工作目录下的子目录自动生成；如果工作目录本身有 `.git`、`AGENTS.md` 或 `opencode.json`，也会加入。目录名也可以直接当别名用，发送 `/projects` 查看。

- 以 `@别名` 开头，或在消息任意位置提到 2 个字符以上的别名，任务就在该项目目录运行。
- 会话在项目根目录打开，所以 OpenCode 会原生加载该项目自己的 `AGENTS.md` 和 `opencode.json`，其中的规则优先于记忆和最近任务。
- bot 和项目可以同时指定，顺序不限：`@research @miaoda 看下发布流程`。
- 简短的追问会沿用上一个任务的项目（2 小时内）：不超过 32 个字符，并以“继续”“接着”“然后”“再”“还有”“改一下”“看一下”这类词开头。不带文字的图片也算追问。
- 与 bot 别名冲突的项目别名会被忽略。

## 命令

| 命令 | 作用 |
|---|---|
| `/status` | 查看状态：工作目录、最近项目、默认与最近 bot、模型、权限模式、运行中和排队的任务、记忆；以及健康情况：24 小时内的任务结果和最近一次失败、已熔断的网关、待补发通知、消息令牌多久前收到 |
| `/tasks [数量]` | 查看最近的任务（默认 5 个，最多 20 个） |
| `/stop` | 停止正在运行的任务；`/stop all` 同时取消所有排队的任务 |
| `/cwd [路径]` | 查看或切换工作目录。路径必须已存在，且在 `config.env` 设定的 `workingDirectory` 范围内 |
| `/ls` | 显示工作目录内容（最多 100 项） |
| `/projects` | 查看项目及其别名 |
| `/bots` | 查看 bot 列表：id、别名、回复前缀、默认 bot |
| `/model [模型]` | 查看或切换模型，所有 bot 共用；`/model default` 恢复默认 |
| `/models` | 查看可用模型 |
| `/permission [模式]` | 查看或设置权限模式 |
| `/help` | 显示帮助 |
| `/version`（`/v`） | 查看版本 |

## 权限审批

OpenCode 要执行需要审批的操作时，bot 会把请求发到微信，并注明是哪个任务（`🔐 任务 #N（bot）请求权限：…`）。回复 `y` 允许（也可以回 `yes`、`ok`、`是`、`允许`、`同意`），回复 `n` 拒绝（也可以回 `no`、`否`、`拒绝`）。120 秒内没有回复则自动拒绝。两条队列同时请求时按顺序等待，每次回复都先答复最早的那个；已有 3 个请求在等时，新的请求直接拒绝。

| 模式 | 行为 |
|---|---|
| `default` | 每个请求都发到微信，等你回复 y/n |
| `acceptEdits` | 自动批准文件编辑，其他请求发到微信 |
| `plan` | 拒绝所有需要审批的请求 |
| `auto` | 自动批准所有请求（危险模式） |

bot 对每个请求都重新读取权限模式，所以 `/permission` 对正在运行的任务也立即生效。模式保存在 `config.env` 里。

## 记忆

- 数据目录下的 `memory/<account>/MEMORY.md` 是聊天的共享记忆：所有 bot 都会读取，由默认 bot 写入。
- 其他 bot 还各自有一份记忆：`memory/<account>/bots/<id>.md`。
- 每个任务最多保存 5 条事实，每条不超过 300 个字符，日期由 bot 自动添加。
- 每个文件最多向提示词注入 8 KB，文件上限 16 KB。

## 环境要求

- 常驻运行（launchd）需要 macOS，见 [docs/DEPLOY.md](docs/DEPLOY.md)；bot 本身是普通的 Node.js 程序。
- Node.js 26：CI 和线上 bot 都用这个版本；`node:sqlite` 至少需要 22.13。
- [OpenCode](https://opencode.ai)，用 `opencode serve` 在 127.0.0.1:4096 提供服务。
- 一个个人微信账号，扫码绑定。

## 安装与设置

```bash
git clone <repo> wechat-opencode-bot
cd wechat-opencode-bot
npm ci
npm run build
npm run setup     # 用微信扫码，然后输入工作目录
```

把配置写进 `~/.wechat-opencode-bot/env`（权限 600）。bot 启动时会加载它，launchd 的启动脚本也会 source 它。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `OPENCODE_URL` | `http://127.0.0.1:4096` | OpenCode 服务地址 |
| `OPENCODE_SERVER_PASSWORD` | 空 | 服务密码，以用户名 `opencode` 走 Basic 认证 |
| `WECHAT_ALLOWED_IDS` | 绑定的账号 | 允许发任务的微信用户 id，逗号分隔 |
| `OPENCODE_FALLBACK_MODEL` | 跨网关链（`oneapi-chat-gpt/gpt-6-astra`） | 重试那一次使用的模型；设置后覆盖默认链 |
| `OPENCODE_DEFAULT_MODEL` | `oneapi/DeepSeek-V4.1-Flash` | 未设置 `/model` 时路由假定的主模型；这类会话实际仍使用 orchestrator agent 自己的模型 |
| `OWB_BREAKER_THRESHOLD`、`OWB_BREAKER_COOLDOWN_MS` | `3`、`600000` | 同一网关连续多少次上游失败后熔断，以及第一次冷却时间；探测再失败则翻倍，最长 1 小时 |
| `OWB_FAILURE_ALERT_COUNT`、`OWB_FAILURE_ALERT_WINDOW_MS`、`OWB_FAILURE_ALERT_COOLDOWN_MS` | `3`、`1800000`、`1800000` | 窗口内失败多少个任务就往微信发一条告警、窗口长度，以及发出告警后多久内不再发 |
| `OPENCODE_FIRST_RESPONSE_TIMEOUT_MS`、`OPENCODE_STALL_TIMEOUT_MS` | `120000`、`180000` | 模型开始输出的等待上限，以及之后两次进展之间的等待上限 |

不接微信也能先试一个任务：`node dist/main.js --simulate "列出工作目录"`；或者用 `node dist/main.js --daemon` 在前台运行 bot。常驻运行（launchd、发布、回滚）请按 [docs/DEPLOY.md](docs/DEPLOY.md) 操作。

## 命令行

| `node dist/main.js …` | 作用 |
|---|---|
| `--setup` | 扫码绑定微信账号并设置工作目录 |
| `--daemon` | 在前台运行 bot；launchd 运行的就是它。它持有 `daemon.lock`，所以第二个实例会打印 `already running (pid N)` 并退出 |
| `--status` | 打印 bot 状态，与 `/status` 相同 |
| `--tasks [数量]` | 打印最近的任务 |
| `--simulate "<内容>"` | 在本进程模拟一条微信消息并打印回复。需要 OpenCode 服务；任务历史和记忆单独记在 `simulate` 账号下 |
| `--notify "<内容>"` | 主动给微信发一条消息；暂时发不出去就进入待发队列 |
| `--help` | 显示帮助 |

bot 没有自己的启动和停止命令，由 launchd 保持运行。重启用 `launchctl kickstart -k gui/$(id -u)/com.yupeng.opencode-wechat-bot`，停止用 `launchctl bootout gui/$(id -u)/com.yupeng.opencode-wechat-bot`，见 [docs/DEPLOY.md](docs/DEPLOY.md#launchd)。在前台运行的 bot 用 Ctrl-C 停止。

## 数据目录

`~/.wechat-opencode-bot/`；设置了 `$OWB_DATA_DIR` 时用它：

```
accounts/         微信账号凭证
attachments/      图片，保留 24 小时
backups/          部署脚本写入的备份
bots.json         bot 名单
config.env        workingDirectory 和 permissionMode
daemon.lock       运行中 bot 持有的锁：PID、启动时间和入口
env               bot 和 OpenCode 服务的配置（权限 600）
get_updates_buf   微信消息轮询游标
logs/             bot 的每日日志（保留 3 个）和 launchd 日志
memory/           按聊天和 bot 存放的记忆
projects.json     项目别名
state.db          任务、聊天设置和待发队列（SQLite）
```

`accounts/`、`config.env` 和 `logs/` 始终在 `~/.wechat-opencode-bot/` 下，即使 `OWB_DATA_DIR` 指向别处。

## 开发

```bash
npm run dev         # tsc --watch
npm run typecheck   # tsc --noEmit
npm run build
npm test            # 运行 dist/tests 里编译好的测试，所以要先 build
```

每次推送到 `main`、以及向 `main` 发起 pull request 时，CI 都会运行 typecheck、build、test 和 gitleaks 扫描。发布与部署见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## License

MIT
