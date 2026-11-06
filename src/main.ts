// Must stay first: provider.ts reads OPENCODE_SERVER_PASSWORD when it loads.
import './env.js';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

import { formatStatus, formatTasks, parseTaskLimit, type CommandContext } from './commands/handlers.js';
import { isCommand, routeCommand } from './commands/router.js';
import { loadConfig, saveConfig } from './config.js';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';
import { createNotifier, runNotify } from './notify.js';
import { IMAGE_ONLY_INPUT, runTask, saveAttachment } from './orchestrator.js';
import { initOpenCode, interruptSession } from './opencode/provider.js';
import { createPermissionBroker } from './permission.js';
import { routeMessage } from './projects.js';
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

  console.log('\n运行 npm run daemon 启动服务');
}

async function runDaemon(): Promise<void> {
  const config = loadConfig();
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
  const api = new WeChatApi(account.botToken, account.baseUrl);
  const notifier = createNotifier(db, api, createSender(api, accountId));
  const broker = createPermissionBroker(() => void notifier.reply(accountId, '⏰ 权限请求超时，已自动拒绝。'));
  const queue = createTaskQueue(
    db,
    (task, signal) => runTask(db, task, notifier.taskIO(task.account_id, broker), signal),
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
  const stopQueue = queue.start(accountId);

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
      if (broker.resolvePermission(accountId, answer)) {
        await notifier.reply(accountId, answer ? '✅ 已允许' : '❌ 已拒绝');
        return;
      }
      if (broker.isTimedOut(accountId)) {
        broker.clearTimedOut(accountId);
        await notifier.reply(accountId, '⏰ 权限请求已超时并自动拒绝。');
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
    const { input: body, project } = routeMessage(db, accountId, text);
    const input = image ? (body ? `${IMAGE_ONLY_INPUT} ${body}` : IMAGE_ONLY_INPUT) : body;
    const messageId = msg.message_id ? String(msg.message_id) : null;
    const { task, created } = db.createTask(accountId, input, messageId, project);
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
      inputLength: input.length,
      image: Boolean(image),
      ahead,
    });
    queue.kick(accountId);
    // A task that starts right away is acknowledged by the typing indicator.
    if (ahead > 0) await notifier.reply(accountId, `⏳ 已排队：任务 #${task.seq}（前面还有 ${ahead} 个任务）`);
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

  function shutdown(): void {
    logger.info('Shutting down...');
    monitor.stop();
    stopQueue();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId });
  console.log(`已启动 (账号: ${accountId})`);

  await monitor.run();
}
const command = process.argv[2];

function showHelp(): void {
  console.log(`
wechat-opencode-bot - 微信接入 OpenCode

用法:
  npm run setup          扫码绑定微信
  npm run daemon:start   启动服务
  npm run daemon:stop    停止服务
  npm run daemon:status  查看状态

或直接:
  node dist/main.js --setup              扫码绑定微信
  node dist/main.js --start              启动服务
  node dist/main.js --stop               停止服务
  node dist/main.js --status             查看状态
  node dist/main.js --tasks [数量]       查看最近的任务
  node dist/main.js --simulate "<内容>"  在本进程模拟一条微信消息（回复打印到终端）
  node dist/main.js --notify "<内容>"    主动给微信发一条消息
`);
}

function getPidFile(): string {
  return join(DATA_DIR, 'daemon.pid');
}

function getDaemonStatus(): { running: boolean; pid?: number } {
  const pidFile = getPidFile();
  if (!existsSync(pidFile)) {
    return { running: false };
  }

  try {
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isNaN(pid)) {
      return { running: false };
    }
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

function findProcessOnPort(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8' });
      for (const line of output.split('\n')) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(pid)) return pid;
        }
      }
    } else {
      const output = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' });
      const pid = parseInt(output.trim(), 10);
      if (!isNaN(pid)) return pid;
    }
  } catch {}
  return null;
}

const OPENCODE_PORT = 4096;

function stopOpenCodeService(): void {
  const pid = findProcessOnPort(OPENCODE_PORT);

  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`已停止 OpenCode 服务 (端口: ${OPENCODE_PORT}, PID: ${pid})`);
    } catch (err) {
      console.error(`停止 OpenCode 服务失败: ${err}`);
    }
  } else {
    console.log(`未发现运行在端口 ${OPENCODE_PORT} 的 OpenCode 服务`);
  }
}

function runStop(): void {
  // 先停止 OpenCode 服务（无论 bot 是否运行）
  stopOpenCodeService();

  const status = getDaemonStatus();

  if (!status.running) {
    console.log('wechat-opencode-bot 未在后台运行');
    return;
  }

  try {
    process.kill(status.pid!, 'SIGTERM');
    console.log(`已停止 wechat-opencode-bot (PID: ${status.pid})`);
  } catch (err) {
    console.error(`停止 wechat-opencode-bot 失败: ${err}`);
  }

  const pidFile = getPidFile();
  if (existsSync(pidFile)) {
    try {
      unlinkSync(pidFile);
    } catch {}
  }
}

/** --status and --tasks report on the bot account; before setup, on the --simulate account. */
const cliAccountId = (): string => loadLatestAccount()?.accountId ?? SIMULATE_ACCOUNT;

function runStatus(): void {
  const status = getDaemonStatus();

  if (status.running) {
    console.log(`wechat-opencode-bot 运行中 (PID: ${status.pid})`);
  } else {
    console.log('wechat-opencode-bot 未运行');
  }

  const opencodePid = findProcessOnPort(OPENCODE_PORT);
  if (opencodePid) {
    console.log(`OpenCode 服务运行中 (端口: ${OPENCODE_PORT}, PID: ${opencodePid})`);
  } else {
    console.log(`OpenCode 服务未运行 (端口: ${OPENCODE_PORT})`);
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
} else if (command === '--start' || command === 'start' || !command) {
  const status = getDaemonStatus();
  if (status.running) {
    console.log(`wechat-opencode-bot 已在后台运行 (PID: ${status.pid})`);
    process.exit(0);
  }

  if (process.platform === 'win32') {
    try {
      const command = `Start-Process -FilePath "node" -ArgumentList "dist/main.js","--daemon" -WorkingDirectory "${process.cwd()}" -WindowStyle Hidden`;
      execSync(`powershell.exe -Command "${command}"`, {
        stdio: 'ignore',
        shell: 'powershell.exe'
      });
      console.log('wechat-opencode-bot 已在后台启动');
      process.exit(0);
    } catch (e) {
      console.error('启动失败:', e);
    }
  } else {
    const pidFile = getPidFile();
    const logFile = join(dirname(pidFile), 'logs', 'stdout.log');

    try {
      const nodeBin = process.execPath;
      const mainJs = join(process.cwd(), 'dist', 'main.js');

      execSync(`mkdir -p "${dirname(logFile)}"`);

      const startCmd = `nohup "${nodeBin}" "${mainJs}" --daemon >> "${logFile}" 2>&1 &`;
      execSync(startCmd, { stdio: 'ignore', shell: '/bin/sh' });

      const pid = execSync(`echo $!`, { shell: '/bin/sh' }).toString().trim();
      writeFileSync(pidFile, pid, 'utf-8');

      console.log('wechat-opencode-bot 已在后台启动');
      process.exit(0);
    } catch (e) {
      console.error('启动失败:', e);
      process.exit(1);
    }
  }
} else if (command === '--daemon') {
  const pidFile = getPidFile();

  const config = loadConfig();
  console.log(`工作目录: ${config.workingDirectory}`);
  console.log(`进程目录: ${process.cwd()}`);
  console.log(`PID: ${process.pid}`);

  try {
    writeFileSync(pidFile, String(process.pid), 'utf-8');
    console.log(`wechat-opencode-bot 已启动 (PID: ${process.pid})`);
  } catch (err) {
    console.error('保存 PID 失败:', err);
  }

  runDaemon().catch((err) => {
    logger.error('Daemon failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('运行失败:', err);
    if (existsSync(pidFile)) {
      unlinkSync(pidFile);
    }
    process.exit(1);
  });
} else if (command === '--stop' || command === 'stop') {
  runStop();
} else if (command === '--status' || command === 'status') {
  runStatus();
} else if (command === '--tasks' || command === 'tasks') {
  console.log(formatTasks(openStateDb(), cliAccountId(), parseTaskLimit(process.argv[3] ?? '')));
} else if (command === '--simulate') {
  runWithExitCode(runSimulate);
} else if (command === '--notify') {
  runWithExitCode(runNotify);
} else if (command === '--help' || command === '-h') {
  showHelp();
} else {
  console.error(`未知命令: ${command}`);
  showHelp();
  process.exit(1);
}
