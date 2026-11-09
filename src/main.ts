// Must stay first: provider.ts reads OPENCODE_SERVER_PASSWORD when it loads.
import './env.js';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { formatStatus, formatTasks, parseTaskLimit, ROUTINE_TICK_MS, tickRoutines, type CommandContext } from './commands/handlers.js';
import { isCommand, routeCommand } from './commands/router.js';
import { loadConfig, saveConfig } from './config.js';
import { DATA_DIR } from './constants.js';
import { backupStateDb } from './backup.js';
import { isReadOnlyBot } from './bots.js';
import { acquireDaemonLock, lockHolder, releaseDaemonLock } from './lifecycle.js';
import { logger } from './logger.js';
import { createNotifier, runNotify } from './notify.js';
import { formatQueueAck, IMAGE_ONLY_INPUT, runTask, saveAttachment } from './orchestrator.js';
import { initOpenCode, interruptSession } from './opencode/provider.js';
import { createPermissionBroker } from './permission.js';
import { routeMessage } from './projects.js';
import { PRUNE_INTERVAL_MS, pruneSessions } from './retention.js';
import { runSimulate, SIMULATE_ACCOUNT } from './simulate.js';
import { openStateDb } from './tasks/db.js';
import { createTaskQueue } from './tasks/queue.js';
import { loadLatestAccount } from './wechat/accounts.js';
import { WeChatApi } from './wechat/api.js';
import { displayQrInTerminal, startQrLogin, waitForQrScan } from './wechat/login.js';
import { downloadImage, extractFirstImageUrl, extractText } from './wechat/media.js';
import { createMonitor } from './wechat/monitor.js';
import { createSender } from './wechat/send.js';
import { MessageType, type WeixinMessage } from './wechat/types.js';

/** Replies that answer a pending permission request. */
const ANSWERS = new Map<string, boolean>([
  ['y', true], ['yes', true], ['ok', true], ['是', true], ['允许', true], ['同意', true],
  ['n', false], ['no', false], ['否', false], ['拒绝', false],
]);

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function runSetup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });

  console.log('正在设置...\n');

  while (true) {
    const { qrcodeUrl, qrcodeId } = await startQrLogin();

    console.log('请用微信扫描下方二维码：\n');
    await displayQrInTerminal(qrcodeUrl);

    console.log('等待扫码绑定...');

    try {
      await waitForQrScan(qrcodeId);
      console.log('✅ 绑定成功!');
      break;
    } catch (err: any) {
      if (err.message?.includes('expired')) {
        console.log('⚠️ 二维码已过期，正在刷新...\n');
        continue;
      }
      throw err;
    }
  }

  const workingDir = await promptUser('请输入工作目录', process.cwd());
  const config = loadConfig();
  config.workingDirectory = workingDir;
  saveConfig(config);

  console.log('\n前台运行: node dist/main.js --daemon；常驻运行见 docs/DEPLOY.md');
}

async function runDaemon(): Promise<void> {
  // Before OpenCode, the database and the queue: a second bot must not touch any of them.
  const holder = acquireDaemonLock(fileURLToPath(import.meta.url));
  if (holder) {
    console.log(`wechat-opencode-bot already running (pid ${holder.pid})`);
    return;
  }
  // Every way out releases the lock. A signal's default action skips 'exit' handlers, so signals exit here.
  process.on('exit', releaseDaemonLock);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info('Shutting down', { signal });
      process.exit(0);
    });
  }

  const config = loadConfig();
  console.log(`工作目录: ${config.workingDirectory}`);
  console.log(`进程目录: ${process.cwd()}`);
  console.log(`wechat-opencode-bot 已启动 (PID: ${process.pid})`);
  const account = loadLatestAccount();

  if (!account) {
    console.error('未找到账号，请先运行 node dist/main.js setup');
    process.exit(1);
  }

  console.log('正在连接 OpenCode 服务...');
  try {
    await initOpenCode(config.workingDirectory);
    console.log('✅ OpenCode 服务已连接');
  } catch (err) {
    console.error('\n' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  const { accountId } = account;
  const allowedIds = (process.env.WECHAT_ALLOWED_IDS || account.userId || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const db = openStateDb();
  try {
    const backup = backupStateDb();
    if (backup) logger.info('State backup created', { file: backup });
  } catch (err) {
    logger.warn('State backup failed', { error: String(err) });
  }
  // Sessions of long-finished tasks go through the OpenCode API. A run never throws and does not hold up startup.
  void pruneSessions(db);
  setInterval(() => void pruneSessions(db), PRUNE_INTERVAL_MS).unref();
  const api = new WeChatApi(account.botToken, account.baseUrl);
  const notifier = createNotifier(db, api, createSender(api, accountId));
  const broker = createPermissionBroker(
    (ask) => void notifier.reply(accountId, `⏰ ${ask.label ? `${ask.label}的` : ''}权限请求超时，已自动拒绝。`),
  );
  const queue = createTaskQueue(
    db,
    (task, signal) => runTask(db, task, notifier.taskIO(task, broker), signal),
    (id) => void notifier.flush(id),
  );
  const ctx: CommandContext = { accountId, db, queue, broker };

  // No task survives a restart: stop its session. Queued tasks still run unless they waited too long.
  for (const task of db.interruptRunningTasks('bot 重启')) {
    if (task.session_id) await interruptSession(task.session_id);
  }
  for (const task of db.expireStaleQueued(accountId)) logger.warn('Queued task expired', { taskId: task.id, seq: task.seq });
  // The outbox reports what the user has not seen: the tasks above, results finished right before
  // a crash, and notices whose send failed.
  void notifier.flush(accountId);
  queue.start(accountId);
  // Only the daemon runs routines: --simulate, --status and --notify never queue their tasks. A tick never throws.
  const tickRoutine = () => tickRoutines(db, accountId, () => queue.kick(accountId));
  tickRoutine();
  setInterval(tickRoutine, ROUTINE_TICK_MS).unref();

  async function handleMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type !== MessageType.USER || !msg.from_user_id || !msg.item_list) return;
    if (!allowedIds.includes(msg.from_user_id)) {
      logger.warn('Ignoring message from unauthorized WeChat user');
      return;
    }
    // Results and notices can only go out on the latest token, so every inbound message refreshes it.
    if (msg.context_token) db.saveContextToken(accountId, msg.from_user_id, msg.context_token);
    else db.ensureUser(accountId, msg.from_user_id);
    await notifier.flush(accountId);

    const text = msg.item_list.map(extractText).filter(Boolean).join('\n').trim();
    const imageItem = extractFirstImageUrl(msg.item_list);

    const answer = imageItem ? undefined : ANSWERS.get(text.toLowerCase());
    if (answer !== undefined) {
      // A timeout is answered before the next ask: a late y/n must not approve the other lane's request.
      if (broker.isTimedOut(accountId)) {
        broker.clearTimedOut(accountId);
        const waiting = broker.getPending(accountId);
        await notifier.reply(
          accountId,
          waiting
            ? `⏰ 上一个权限请求已超时；现在待回复的是${waiting.label ? ` ${waiting.label}` : '另一个请求'}，请再回复一次 y/n。`
            : '⏰ 权限请求已超时并自动拒绝。',
        );
        return;
      }
      // y/n answers the oldest ask; with both lanes asking that may not be the latest shown, so the reply names its task.
      const ask = broker.getPending(accountId);
      if (broker.resolvePermission(accountId, answer)) {
        await notifier.reply(accountId, `${answer ? '✅ 已允许' : '❌ 已拒绝'}${ask?.label ? `：${ask.label}` : ''}`);
        return;
      }
    }

    if (isCommand(text)) {
      await notifier.reply(accountId, await routeCommand(text, ctx));
      return;
    }
    if (!text && !imageItem) {
      await notifier.reply(accountId, '暂不支持此类型消息，请发送文字或图片');
      return;
    }
    // Download before the task exists: the runner must never pick up a task whose image is still missing.
    const image = imageItem
      ? await downloadImage(imageItem).catch((err) => {
          logger.warn('Image download failed', { error: String(err) });
          return null;
        })
      : null;
    if (imageItem && !image) {
      await notifier.reply(accountId, '⚠️ 图片下载失败，请重新发送');
      return;
    }
    const { input: body, project, botId } = routeMessage(db, accountId, text);
    const input = image ? (body ? `${IMAGE_ONLY_INPUT} ${body}` : IMAGE_ONLY_INPUT) : body;
    const messageId = msg.message_id ? String(msg.message_id) : null;
    // A read-only bot's task runs in its own lane and does not wait for a running write task.
    const lane = isReadOnlyBot(botId) ? 'read' : 'write';
    const { task, created } = db.createTask(accountId, input, messageId, project, botId, lane);
    if (!created) {
      logger.debug('Duplicate message ignored', { messageId, taskId: task.id, seq: task.seq });
      return;
    }
    if (image) saveAttachment(task.id, image);
    const ahead = db.countAhead(accountId, task.id);
    logger.info('Task queued', {
      taskId: task.id,
      seq: task.seq,
      project: task.project_id,
      bot: task.bot_id,
      lane: task.lane,
      inputLength: input.length,
      image: Boolean(image),
      ahead,
    });
    queue.kick(accountId);
    // A task that starts right away is acknowledged by the typing indicator.
    if (ahead > 0) {
      // The ETA is a nicety: without it the ack still goes out. Only the task's own lane holds it up.
      let durations: number[] = [];
      try {
        durations = db.recentDurations(accountId, task.lane);
      } catch (err) {
        logger.warn('Queue ETA unavailable', { error: String(err) });
      }
      await notifier.reply(accountId, formatQueueAck(task.seq, ahead, durations));
    }
  }

  // The monitor does not await onMessage; chaining keeps inbound messages in arrival order.
  // Tasks run in the queue, so a y/n answer is handled while a task waits for it.
  let inbound: Promise<void> = Promise.resolve();
  const monitor = createMonitor(api, {
    onMessage: (msg) => {
      inbound = inbound
        .then(() => handleMessage(msg))
        .catch((err) => logger.error('Error processing message', { error: err instanceof Error ? err.message : String(err) }));
      return inbound;
    },
    onSessionExpired: () => {
      logger.warn('Session expired, will keep retrying...');
      console.error('⚠️ 微信会话已过期，请重新运行 setup 扫码绑定');
    },
  });

  logger.info('Daemon started', { accountId });
  console.log(`已启动 (账号: ${accountId})`);

  await monitor.run();
}
const command = process.argv[2];

function showHelp(): void {
  console.log(`
wechat-opencode-bot - 微信接入 OpenCode

用法: node dist/main.js <命令>
  --setup              扫码绑定微信，设置工作目录（也可以 npm run setup）
  --daemon             在前台运行 bot，launchd 运行的就是它；已有 bot 在运行时直接退出
  --status             查看状态
  --tasks [数量]       查看最近的任务
  --simulate "<内容>"  在本进程模拟一条微信消息（回复打印到终端）
  --notify "<内容>"    主动给微信发一条消息

常驻运行由 launchd 管理（docs/DEPLOY.md）:
  重启  launchctl kickstart -k gui/$(id -u)/com.yupeng.opencode-wechat-bot
  停止  launchctl bootout gui/$(id -u)/com.yupeng.opencode-wechat-bot
`);
}

/** --status and --tasks report on the bot account; before setup, on the --simulate account. */
const cliAccountId = (): string => loadLatestAccount()?.accountId ?? SIMULATE_ACCOUNT;

function runStatus(): void {
  const holder = lockHolder();
  if (holder) {
    console.log(`wechat-opencode-bot 运行中 (PID: ${holder.pid}, 启动于 ${holder.startedAt})`);
    console.log(`入口: ${holder.entry}`);
  } else {
    console.log('wechat-opencode-bot 未运行');
  }

  console.log(`\n${formatStatus(openStateDb(), cliAccountId())}`);
}

/** --simulate and --notify report their outcome through the exit code. */
function runWithExitCode(run: (text: string) => Promise<number>): void {
  const text = process.argv.slice(3).join(' ').trim();
  if (!text) {
    console.error(`用法: node dist/main.js ${command} "<内容>"`);
    process.exit(1);
  }
  run(text).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      logger.error('Command failed', { command, error: err instanceof Error ? err.message : String(err) });
      console.error('运行失败:', err);
      process.exitCode = 1;
    },
  );
}

if (command === '--setup' || command === 'setup') {
  runSetup().catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('设置失败:', err);
    process.exit(1);
  });
} else if (command === '--daemon') {
  runDaemon().catch((err) => {
    logger.error('Daemon failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('运行失败:', err);
    process.exit(1);
  });
} else if (command === '--status' || command === 'status') {
  runStatus();
} else if (command === '--tasks' || command === 'tasks') {
  console.log(formatTasks(openStateDb(), cliAccountId(), parseTaskLimit(process.argv[3] ?? '')));
} else if (command === '--simulate') {
  runWithExitCode(runSimulate);
} else if (command === '--notify') {
  runWithExitCode(runNotify);
} else if (!command || command === '--help' || command === '-h') {
  showHelp();
} else {
  console.error(`未知命令: ${command}`);
  showHelp();
  process.exit(1);
}
