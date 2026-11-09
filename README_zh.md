# wechat-opencode-bot

[English](README.md) | 中文

在手机微信里发一条消息，它会作为任务在本机的 OpenCode server 上执行，结果再发回聊天里。

## 架构

```mermaid
flowchart LR
  W[微信 App] <--> I[iLink bot API]
  I <-->|长轮询 / 发送| D[bot daemon<br/>Node.js]
  D --> R[路由<br/>白名单、命令、@bot、@项目]
  R --> Q[(state.db<br/>任务、routines、outbox)]
  Q --> L1[write lane]
  Q --> L2[read lane]
  L1 --> O[OpenCode server<br/>127.0.0.1:4096]
  L2 --> O
  O --> A1[wechat-orchestrator]
  O --> A2[wechat-orchestrator-read]
  A1 --> S1[wechat-general / wechat-explore]
  A2 --> S2[只能派 wechat-explore]
```

### 组件

| 组件 | 代码 | 职责 |
|---|---|---|
| 微信客户端 | `src/wechat/` | iLink 长轮询、发送、CDN 媒体、账号凭据 |
| Daemon | `src/main.ts`、`src/lifecycle.ts` | 装配各模块；持有 `daemon.lock`，保证单实例 |
| 命令 | `src/commands/` | `/status`、`/tasks`、`/routine` 等 |
| 路由 | `src/bots.ts`、`src/projects.ts`、`src/aliases.ts` | 决定消息交给哪个 bot、在哪个项目目录执行 |
| 任务队列 | `src/tasks/` | SQLite schema 与迁移、队列、lane |
| 编排 | `src/orchestrator.ts` | 组装 prompt、执行任务、解析输出、发送进度 |
| OpenCode 客户端 | `src/opencode/provider.ts` | OpenCode HTTP API、watchdog、错误分类 |
| 模型路由 | `src/model-routing.ts` | 跨网关 fallback 与按网关熔断 |
| 投递 | `src/notify.ts` | 按 2048 字分段，outbox 退避重试 |
| 运维 | `src/routines.ts`、`src/retention.ts`、`src/backup.ts`、`src/alerts.ts` | 定时任务、会话清理、每日备份、失败告警 |
| Agents | `config/agents/*.md` | 四个 OpenCode agent 的提示词与权限 |

bot 不 fork、也不修改 OpenCode，只调用它的 HTTP API。模型质量、工具、MCP、skills、上下文上限都由 OpenCode 及其配置决定。

### 任务生命周期

1. 收到 `WECHAT_ALLOWED_IDS` 中用户的消息。命令立即执行，其余消息变成任务。
2. 任务写入 `state.db`，在所属 lane 中排队，回复会告知位置：`⏳ 已排队：任务 #N（前面还有 X 个任务）`。
3. bot 在项目目录中**新建** OpenCode 会话，会话从不复用。
4. 上下文由 prompt 携带：最近 8 个任务（最近 2 个附回复摘录）、聊天记忆、bot persona。
5. bot 等待会话进入 idle；长任务最多发 4 条进度。
6. 解析输出（记忆条目、回复），按 2048 字分段放入 outbox。

排队超过 24 小时的任务会过期。daemon 重启会中止正在运行的任务并发 ⏹ 提示，排队中的任务照常执行。

### 路由

| 消息 | 去向 |
|---|---|
| `@research …` | 该别名对应的 bot |
| `@myproj …`，或消息中出现项目别名（≥ 2 字） | 该项目目录 |
| `@research @myproj …` | 两者组合，顺序不限 |
| `@all` / `@everyone` | 默认 bot，同时最多 3 个 subagent，合并成一条回复 |
| `继续…` / `接着…` / `再…`（≤ 32 字，2 小时内） | 沿用上一个任务的 bot 和项目 |
| `新话题：…` | 不跟随；`@base` 在基础工作区执行 |

会话在项目根目录打开，项目自己的 `AGENTS.md` 和 `opencode.json` 原生生效，优先级高于注入的记忆。bot 不会根据正文内容猜测。

### 并发 lane

- 每个微信账号有一条 **write lane** 和一条 **read lane**，每条同时只跑一个任务。
- 只读 bot（如 `research`）的任务走 read lane，运行在 `wechat-orchestrator-read` 上，它只能派 `wechat-explore`。
- 只读是 agent 权限规则，不是沙箱。

### 模型路由与容错

- 默认模型：`oneapi/DeepSeek-V4.1-Flash`；`/model` 对所有 bot 生效。
- 网关错误（5xx、429、超时、无首响应、停滞）会在另一条网关上**重试一次**（`OPENCODE_FALLBACK_MODEL` 或内置链路）。鉴权错误、4xx、权限拒绝不重试。
- 同一网关连续 3 次上游失败会熔断 10 分钟，之后翻倍，上限 1 小时；熔断期间新任务直接用备用模型。
- 未写 `model:` 的 subagent 继承父会话模型，所以 fallback 会让整棵任务树一起切换。
- 30 分钟内 3 个任务失败，会向微信发一条告警。

### 状态与清理

| 数据 | 位置 | 保留 |
|---|---|---|
| 任务、routines、聊天设置、outbox | `state.db`（SQLite，WAL） | 每日备份 |
| OpenCode 会话 | OpenCode server | 7 天后经 API 删除，始终保留最新 300 个 |
| 记忆 | `memory/<account>/MEMORY.md`、`memory/<account>/bots/<id>.md` | 每个文件上限 16 KB，每次注入 8 KB |
| 图片 | `attachments/` | 24 小时 |

schema 变更只加列、加表，旧版本可以读新版 `state.db`。

### 权限

OpenCode 的权限请求会发到微信：`🔐 任务 #N（bot）请求权限：…`。回复 `y` / `n`；120 秒无回复即拒绝。两条 lane 的请求按账号排队，先回答最早的；第 4 个等待中的请求直接拒绝。

| 模式 | 行为 |
|---|---|
| `default` | 在微信里询问 |
| `acceptEdits` | 文件编辑自动通过，其余询问 |
| `plan` | 全部拒绝 |
| `auto` | 全部通过（危险） |

`auto` 模式下，微信账号等同于远程 shell。白名单要收紧，空闲时切到 `plan`。

### 仓库结构

```
src/            daemon、路由、编排、队列、OpenCode 与微信客户端
src/tests/      node:test 测试（使用 fake OpenCode server）
config/agents/  OpenCode agent 提示词
config/launchd/ bot 与 OpenCode server 的 launchd 任务
scripts/        release、deploy、rollback、healthcheck、install-agents、install-launchd
docs/DEPLOY.md  发布、部署、回滚、迁移
```

## 使用

### 环境要求

- Node.js 22.13+（`node:sqlite`）；CI 使用 Node 26。
- [OpenCode](https://opencode.ai)，以 `opencode serve` 运行在 `127.0.0.1:4096`。
- 一个用于扫码绑定的个人微信号。
- 常驻部署（launchd）需要 macOS；bot 本身是普通 Node.js 程序。

### 安装

```bash
git clone <repo-url> wechat-opencode-bot
cd wechat-opencode-bot
npm ci
npm run build
scripts/install-agents.sh --apply   # 把四个 agent 链接进 OpenCode（源码 checkout，或部署后的 current/）
npm run setup                        # 扫码绑定，然后选择工作目录
```

配置写在 `~/.wechat-opencode-bot/env`（权限 600）。bot 启动时加载，launchd 包装脚本也会 source 它。发布部署之后重新执行一次 `install-agents.sh`，让链接指向 `current/`，这样每个 release 都会带上自己的 prompt。

### 运行

| 目的 | 命令 |
|---|---|
| 不经微信试跑一个任务 | `node dist/main.js --simulate "列出工作目录"` |
| 前台运行 | `node dist/main.js --daemon` |
| 查看状态 / 最近任务 | `node dist/main.js --status` / `--tasks 10` |
| 主动推送一条消息 | `node dist/main.js --notify "text"` |
| 常驻（launchd）、发布、回滚 | 见 [docs/DEPLOY.md](docs/DEPLOY.md) |

### 命令

| 命令 | 作用 |
|---|---|
| `/status` | 状态与健康：lane、队列、模型、权限模式、24 小时结果、熔断、outbox、token 时效 |
| `/tasks [n]` | 最近 n 个任务（默认 5，最多 20） |
| `/stop [all]` | 停止当前任务；`all` 同时取消队列 |
| `/routine [add\|rm\|on\|off\|run]` | 管理定时任务 |
| `/cwd [path]`、`/ls` | 查看或切换工作目录、列出内容 |
| `/projects`、`/bots` | 列出项目和 bot 别名 |
| `/model [name\|default]`、`/models` | 查看、切换或列出模型 |
| `/permission [mode]` | 查看或设置权限模式 |
| `/help`、`/version` | 帮助、版本 |

### 寻址示例

```
@eng 修一下登录页的报错
@research @myproj 看下发布流程
继续，把测试也补上
新话题：查一下今天的天气
```

bot 定义在 `~/.wechat-opencode-bot/bots.json`（默认：`chief`、`research`、`eng`、`ops`）。项目定义在 `projects.json`，由工作目录的子目录自动生成。

### Routines

```
/routine add 早报 daily09:00 汇总昨天的工作
/routine add 巡检 every30m 检查服务健康
```

`dailyHH:MM` 按 Asia/Shanghai 时间；`everyNm` / `everyNh` 范围是 5 分钟到 24 小时。同一个 routine 不会并行，bot 停机期间错过的执行不会补跑。

### 环境变量

| 变量 | 默认值 | 含义 |
|---|---|---|
| `OPENCODE_URL` | `http://127.0.0.1:4096` | OpenCode server 地址 |
| `OPENCODE_SERVER_PASSWORD` | 空 | 用户 `opencode` 的 Basic auth 密码 |
| `WECHAT_ALLOWED_IDS` | 绑定的账号 | 允许的微信用户 id，逗号分隔 |
| `OPENCODE_DEFAULT_MODEL` | `oneapi/DeepSeek-V4.1-Flash` | 路由时假定的主模型 |
| `OPENCODE_FALLBACK_MODEL` | 内置跨网关链路 | 重试那一次使用的模型 |
| `OPENCODE_FIRST_RESPONSE_TIMEOUT_MS` / `OPENCODE_STALL_TIMEOUT_MS` | `120000` / `180000` | watchdog 时限 |
| `OWB_BREAKER_THRESHOLD` / `OWB_BREAKER_COOLDOWN_MS` | `3` / `600000` | 网关熔断 |
| `OWB_FAILURE_ALERT_COUNT` / `_WINDOW_MS` / `_COOLDOWN_MS` | `3` / `1800000` / `1800000` | 失败告警 |
| `OWB_SESSION_TTL_DAYS` / `OWB_SESSION_KEEP` | `7` / `300` | 会话保留 |
| `OWB_LOG_LEVEL` | `info` | 日志级别：`debug`、`info`、`warn`、`error` |
| `OWB_DATA_DIR` | `~/.wechat-opencode-bot` | 数据目录（`accounts/`、`config.env`、`logs/` 始终在默认目录） |

### 排障

| 现象 | 检查 |
|---|---|
| 完全没有回复 | `node dist/main.js --status`；日志在 `~/.wechat-opencode-bot/logs/` |
| `already running (pid N)` | 另一个 daemon 持有 `daemon.lock`，先停掉它 |
| routine 或 `--notify` 的结果一直没到 | 微信需要较新的消息 token；随便发一条消息，outbox 就会补发 |
| 任务报鉴权错误 | 确认 `OPENCODE_SERVER_PASSWORD` 与 server 一致 |
| 所有任务都在用备用模型 | 有网关熔断；`/status` 会显示是哪条网关、何时重试 |
| 找不到新 agent | 重新执行 `scripts/install-agents.sh --apply`，再 reload server：`opencode reload --server http://127.0.0.1:4096` |

## License

MIT。基于 [zsxink/wechat-opencode-bot](https://github.com/zsxink/wechat-opencode-bot)。
