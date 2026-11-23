import { isReadOnlyBot } from './bots.js';
import { resultText, runTask, type TaskIO } from './orchestrator.js';
import { pingOpenCode, startEventStream, stopEventStream } from './opencode/provider.js';
import { routeMessage } from './projects.js';
import { followUpOf, routeToTask, type NewTask } from './task-router.js';
import { openStateDb } from './tasks/db.js';

/** --simulate files its tasks here, apart from the WeChat chat. */
export const SIMULATE_ACCOUNT = 'simulate';

const RETRY_MS = 2000;

/**
 * --simulate: run one task in this process against the real OpenCode server, as if it came from
 * WeChat. It keeps its own task history under SIMULATE_ACCOUNT, so the chat's history stays
 * untouched, and it reads the owner's memories but saves none; replies print instead of being sent.
 * The message is routed as the daemon routes it, against that history: one that attaches to a task
 * runs as a task that follows it, and a stop is printed, not carried out.
 */
export async function runSimulate(text: string): Promise<number> {
  if (!(await pingOpenCode())) {
    console.error('OpenCode 服务未连接，请先启动 opencode serve');
    return 1;
  }
  const accountId = SIMULATE_ACCOUNT;
  const db = openStateDb();
  const { input, project, botId, prefixed } = routeMessage(text);
  const route = prefixed ? undefined : await routeToTask(db, accountId, input);
  if (route?.action === 'stop') {
    console.log(`[simulate] 路由：停止任务 #${route.task.seq}（simulate 不执行）`);
    return 0;
  }
  // As in the daemon: a read-only bot's task runs on the read agent.
  const placed: NewTask =
    route?.action === 'attach' ? followUpOf(route.task) : { project, botId, lane: isReadOnlyBot(botId) ? 'read' : 'write' };
  if (route?.action === 'attach') console.log(`[simulate] 路由：接着任务 #${route.task.seq}`);
  const start = () => db.startTaskNow(accountId, input, placed.project, placed.botId, placed.lane, placed.continues);

  let task = start();
  while (!task) {
    console.log('[simulate] 已有任务在运行，2 秒后重试...');
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    task = start();
  }
  console.log(`[simulate] task ${task.id} (#${task.seq}) bot=${task.bot_id ?? '-'} project=${task.project_id ?? '-'} lane=${task.lane}`);

  const io: TaskIO = {
    async deliver(task) {
      console.log(`[wechat] ${resultText(task)}`);
      db.markNotified(task.id);
    },
    async onPermission(request) {
      console.log(`[wechat] 🔧 权限请求 ${request.action}: ${request.resources.join(', ') || '(无)'} → 拒绝（simulate 不审批）`);
      return 'reject';
    },
    readOnlyMemory: true,
  };
  const controller = new AbortController();
  // Free the account before the session winds down: a running row left behind blocks every later
  // simulate. SIGKILL cannot be caught; the next daemon start interrupts such a row.
  const release = () => db.finishTask(task.id, 'interrupted', { error: 'simulate 进程退出' });
  const onSignal = () => {
    release();
    controller.abort();
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const name of signals) process.once(name, onSignal);
  process.once('exit', release);
  // As in the daemon, so a long reasoning step is not taken for silence; closed below, so the process can exit.
  startEventStream();
  try {
    await runTask(db, task, io, controller.signal);
  } catch (err) {
    db.finishTask(task.id, 'failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('[simulate] 任务异常:', err);
  } finally {
    stopEventStream();
    for (const name of signals) process.off(name, onSignal);
    process.off('exit', release);
    release();
  }

  const finished = db.getTask(task.id)!;
  console.log(`[simulate] status=${finished.status} session=${finished.session_id ?? '-'}`);
  return finished.status === 'done' ? 0 : 1;
}
