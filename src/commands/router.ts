import { logger } from '../logger.js';
import { handlers, type CommandContext } from './handlers.js';

const COMMAND = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i;

export const isCommand = (text: string): boolean => /^\/[a-z]+(\s|$)/i.test(text.trim());

/** Run a slash command and return the reply. Commands never become tasks. */
export async function routeCommand(text: string, ctx: CommandContext): Promise<string> {
  const match = COMMAND.exec(text.trim());
  const name = match?.[1].toLowerCase() ?? '';
  const args = match?.[2]?.trim() ?? '';
  // Arguments can carry paths or model names; the command name is enough to trace.
  logger.info('Slash command', { name });

  if (!Object.hasOwn(handlers, name)) return `未知命令 /${name}，发送 /help 查看可用命令`;
  try {
    return await handlers[name](args, ctx);
  } catch (err) {
    logger.error('Slash command failed', { name, error: String(err) });
    return `⚠️ /${name} 执行失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}
