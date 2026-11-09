import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { longestFirst, prefixPattern } from './aliases.js';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';

/**
 * A persona the one WeChat bot speaks as. Personas only shape the orchestrator's prompt, its memory
 * and the reply prefix: every task still runs in the same orchestrator agent, and the repo's
 * AGENTS.md and opencode.json still come first.
 */
export interface Bot {
  /** Also names the bot's memory file, so it stays a plain lowercase file name. */
  id: string;
  name: string;
  /** Names that pick the bot as an "@alias" at the start of a message. */
  aliases: string[];
  /** The bridge puts it before the bot's replies; empty for none. */
  prefix: string;
  /** Answers messages that name no bot and keeps the account's shared memory. Exactly one bot is the default. */
  default: boolean;
  role: string;
  /** The subagent the bot prefers for its work; unset means either. */
  subagent?: 'wechat-explore' | 'wechat-general';
}

export const BOTS_PATH = join(DATA_DIR, 'bots.json');

/** A task's bot_id for "@all": the default bot answers and may bring in every specialist. */
export const ALL_BOTS = 'all';
/** They address everyone, so no bot may use them as an id or alias. */
const ALL_ALIASES = [ALL_BOTS, 'everyone'];
const SUBAGENTS: readonly string[] = ['wechat-explore', 'wechat-general'];
const BOT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** One word: no whitespace, "@" or path separators. */
const BOT_ALIAS = /^[^\s@/\\]+$/;

/** Written to bots.json on first run; after that the file is the user's. */
const GENERATED = [
  {
    id: 'chief',
    name: 'Chief',
    aliases: ['chief', '总管'],
    prefix: '',
    default: true,
    role: 'chief of staff: plan the task, route to the right specialist, merge the result',
  },
  {
    id: 'research',
    name: '研究',
    aliases: ['research', '研究'],
    prefix: '研究：',
    role: 'read-only research: read files, search, summarize; never edit',
    subagent: 'wechat-explore',
  },
  {
    id: 'eng',
    name: '工程',
    aliases: ['eng', '工程', 'code'],
    prefix: '工程：',
    role: 'implementation: edit files, run tests, git, build',
    subagent: 'wechat-general',
  },
  {
    id: 'ops',
    name: 'Ops',
    aliases: ['ops', '运维'],
    prefix: 'Ops：',
    role: 'operations: logs, diagnostics, deploys, environment checks',
    subagent: 'wechat-general',
  },
];

/** A registry entry as a Bot; throws if it is malformed. toBots settles which bot is the default. */
function toBot(entry: any): Bot {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const id = text(entry?.id);
  if (!BOT_ID.test(id) || ALL_ALIASES.includes(id)) {
    throw new Error('id must be lowercase letters, digits, "_" or "-", and not all/everyone');
  }
  const name = text(entry.name);
  const role = text(entry.role);
  if (!name || !role) throw new Error('an entry needs a name and a role');
  if (!Array.isArray(entry.aliases) || !entry.aliases.every((alias: unknown) => typeof alias === 'string')) {
    throw new Error('aliases must be a list of names');
  }
  const aliases: string[] = entry.aliases.map((alias: string) => alias.trim()).filter(Boolean);
  const bad = aliases.find((alias) => !BOT_ALIAS.test(alias) || ALL_ALIASES.includes(alias.toLowerCase()));
  if (bad !== undefined) throw new Error(`alias "${bad}" must be one word without "@" or "/", and not all/everyone`);
  if (entry.prefix !== undefined && typeof entry.prefix !== 'string') throw new Error('prefix must be text');
  if (entry.default !== undefined && typeof entry.default !== 'boolean') throw new Error('default must be true or false');
  if (entry.subagent !== undefined && !SUBAGENTS.includes(entry.subagent)) {
    throw new Error(`subagent must be ${SUBAGENTS.join(' or ')}`);
  }
  const bot: Bot = { id, name, aliases, prefix: entry.prefix ?? '', default: entry.default === true, role };
  if (entry.subagent) bot.subagent = entry.subagent;
  return bot;
}

/** Valid entries in order, a repeated id skipped. The first "default": true, else the first bot, is the default. */
function toBots(entries: unknown[]): Bot[] {
  const bots: Bot[] = [];
  for (const entry of entries) {
    try {
      const bot = toBot(entry);
      if (bots.some((b) => b.id === bot.id)) throw new Error('duplicate id');
      bots.push(bot);
    } catch (err) {
      logger.warn('Skipping bot', { id: String((entry as any)?.id), error: String(err) });
    }
  }
  const chosen = bots.find((bot) => bot.default) ?? bots[0];
  return bots.map((bot) => ({ ...bot, default: bot === chosen }));
}

/** Answers everything when the registry has no valid bot, so a bad edit never stops the chat. */
const FALLBACK = toBots(GENERATED.slice(0, 1));

function createRegistry(file: string): unknown[] {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ bots: GENERATED }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  logger.info('Bot registry created', { file, bots: GENERATED.length });
  return GENERATED;
}

/** The registry, read on every call so edits apply right away. Invalid entries are skipped; never empty. */
export function loadBots(file: string = BOTS_PATH): Bot[] {
  try {
    const registry = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : { bots: createRegistry(file) };
    if (!Array.isArray(registry?.bots)) throw new Error('no "bots" array');
    const bots = toBots(registry.bots);
    if (!bots.length) throw new Error('no valid bot');
    return bots;
  } catch (err) {
    logger.warn('Failed to load bot registry, using the built-in default bot', { file, error: String(err) });
    return FALLBACK;
  }
}

export const defaultBot = (bots: Bot[]): Bot => bots.find((bot) => bot.default) ?? bots[0];

/** Every name that addresses a bot, "all" and "everyone" included. Projects cannot use them (see projects.ts). */
export function botAliases(bots: Bot[]): { id: string; alias: string }[] {
  return [
    ...bots.flatMap((bot) => bot.aliases.map((alias) => ({ id: bot.id, alias }))),
    ...ALL_ALIASES.map((alias) => ({ id: ALL_BOTS, alias })),
  ];
}

/**
 * Who a message is addressed to: the bot whose "@alias" opens it (any case, longest alias first), or
 * ALL_BOTS for "@all"/"@everyone", with that prefix stripped. Anything else goes to the default bot:
 * a bot is never guessed from the rest of the message.
 */
export function detectBot(text: string, bots: Bot[] = loadBots()): { botId: string; input: string } {
  const named = longestFirst(botAliases(bots)).find(({ alias }) => prefixPattern(alias).test(text));
  if (!named) return { botId: defaultBot(bots).id, input: text };
  // A message that is only "@alias" keeps its text, as with projects.
  return { botId: named.id, input: text.replace(prefixPattern(named.alias), '').trim() || text };
}

/** The bot a task speaks as. "@all" tasks, rows from before bots (null) and removed bots get the default bot. */
export function resolveBot(botId: string | null, bots: Bot[] = loadBots()): { bot: Bot; all: boolean } {
  return { bot: bots.find((bot) => bot.id === botId) ?? defaultBot(bots), all: botId === ALL_BOTS };
}

/**
 * A read-only bot's tasks run in the read lane, beside a write task: a specialist that prefers wechat-explore.
 * "@all", the default bot, removed bots and rows from before bots write.
 */
export function isReadOnlyBot(botId: string | null, bots: Bot[] = loadBots()): boolean {
  const { bot } = resolveBot(botId, bots);
  return !bot.default && bot.subagent === 'wechat-explore';
}
