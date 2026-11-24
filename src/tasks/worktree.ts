import { execFile } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createWorktree } from '../opencode/provider.js';
import { logger } from '../logger.js';
import type { StateDb, TaskRow } from './db.js';

const exec = promisify(execFile);

/** Count repository roots down to depth four; don't follow symlinks or descend into Git's metadata. */
async function hasNested(dir: string, depth = 0): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true });
  if (depth && entries.some(e => e.name === '.git')) return true;
  if (depth < 4) {
    for (const e of entries) if (e.name !== '.git' && e.isDirectory() && await hasNested(join(dir, e.name), depth + 1)) return true;
  }
  return false;
}

async function singleRepo(directory: string): Promise<boolean> {
  const entries = await readdir(directory);
  if (!entries.includes('.git')) return false;
  const { stdout } = await exec('git', ['-C', directory, 'rev-parse', '--show-toplevel']);
  return await realpath(stdout.trim()) === await realpath(directory) && !await hasNested(directory);
}

/** Return false when this claim has to wait for the checkout. Existing sessions cannot change directories. */
export async function prepareWorkspace(db: StateDb, task: TaskRow, create = createWorktree): Promise<boolean> {
  if (!task.workspace_peer || !task.project_dir || !task.project_id || task.project_id === 'base' || task.worktree_dir) return true;
  try {
    if (!await singleRepo(task.project_dir)) return true;
    if (!task.session_id) {
      const dir = await create(task.project_dir, `wechat-${task.seq}`);
      db.setWorktree(task.id, dir);
      logger.info('Task worktree created', { seq: task.seq, directory: dir, peer: task.workspace_peer });
      return true;
    }
    logger.info('Continuation waiting for its original checkout', { seq: task.seq, peer: task.workspace_peer });
  } catch (error) {
    logger.warn('Cannot isolate task; waiting for checkout', { seq: task.seq, project: task.project_dir, error: String(error) });
  }
  db.waitForCheckout(task.id);
  return false;
}
