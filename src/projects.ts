import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { longestFirst, mentionPattern, prefixPattern } from './aliases.js';
import { ALL_BOTS, botAliases, defaultBot, detectBot, loadBots, type Bot } from './bots.js';
import { loadConfig } from './config.js';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';
import type { StateDb, TaskProject } from './tasks/db.js';

/**
 * A repo a task can run in. The registry only routes messages: the task's session opens at the
 * repo root, and OpenCode loads the repo's own AGENTS.md and opencode.json there.
 */
export interface Project {
  id: string;
  /** Relative to the base workspace (config workingDirectory). */
  dir: string;
  /** Names that pick the project: "@alias ..." at the start of a message, or a mention anywhere. */
  aliases: string[];
}

export const PROJECTS_PATH = join(DATA_DIR, 'projects.json');

/** Ids and aliases for the repos known to live under the base; other child directories go by their name. */
const KNOWN_PROJECTS: Record<string, { id: string; aliases: string[] }> = {
  miaoda: { id: 'miaoda', aliases: ['miaoda', '秒哒'] },
  'medo-discord-icafe-bot': { id: 'medo', aliases: ['medo', 'icafe', 'medo-discord'] },
  'rh-layers': { id: 'rh-layers', aliases: ['rh', 'rh-layers'] },
  dumate: { id: 'dumate', aliases: ['dumate'] },
  'miaoda-ops': { id: 'miaoda-ops', aliases: ['miaoda-ops'] },
};
/** The base itself is a project when it is a repo. */
const PROJECT_MARKERS = ['.git', 'AGENTS.md', 'opencode.json'];
/** Ids /projects add accepts, as bot ids: lowercase. "base" stays the base workspace's. */
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const BASE_ID = 'base';

/** A follow-up stays in the previous task's project, and with its bot, only if that task came this recently. */
const FOLLOW_UP_MS = 2 * 60 * 60 * 1000;
/** A follow-up opens with one of these cues; inside another word (其它, 再见) or later in a sentence they mean nothing. */
const FOLLOW_UP = /^(继续|接着|然后|再(?!见)|那|这个|上面|刚才|它|还有|第二个|改一下|看一下)/;
/** Longer messages are new requests: they name their project or run in the base. */
const FOLLOW_UP_MAX_CHARS = 32;
/** Opens a message that follows neither the last project nor the last bot; it comes off the text. */
const NEW_TOPIC = /^\s*(?:新话题|换个话题|new\s+topic(?![A-Za-z]))(?=$|[\s:：,，])[\s:：,，]*/i;
/** "@base" at the start runs the task in the base workspace, whether or not the registry has a "base" project. */
const BASE_PREFIX = prefixPattern('base');
/** Shorter aliases only work as an explicit "@alias". */
const MIN_MENTION_CHARS = 2;

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** isPathInside once symlinks are resolved, so a link inside parent cannot point out of it. False if either path is missing. */
export function isRealPathInside(parent: string, child: string): boolean {
  try {
    return isPathInside(realpathSync(parent), realpathSync(child));
  } catch {
    return false;
  }
}

/**
 * Absolute directory of a project. It must be an existing directory inside base once symlinks are
 * resolved, so no registry entry can send a task outside the configured workspace.
 */
export function resolveProjectDir(base: string, project: Project): string {
  const { id, dir } = project;
  if (!dir || isAbsolute(dir) || dir.split(/[\\/]/).includes('..')) {
    throw new Error(`project ${id}: dir must be a path inside the base, without ..`);
  }
  const target = resolve(base, dir);
  const real = realpathSync(target);
  if (!isPathInside(realpathSync(base), real)) throw new Error(`project ${id}: ${dir} resolves outside the base`);
  if (!statSync(real).isDirectory()) throw new Error(`project ${id}: ${dir} is not a directory`);
  return target;
}

/** First run: one project per child directory of base, plus base itself if it is a repo. Written once; after that the file is the user's. */
function createRegistry(base: string, file: string): Project[] {
  const projects: Project[] = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name }) => {
      const known = KNOWN_PROJECTS[name];
      // The directory name works too, so a pasted path finds its project.
      return { id: known?.id ?? name, dir: name, aliases: [...new Set([...(known?.aliases ?? []), name])] };
    });
  if (PROJECT_MARKERS.some((marker) => existsSync(join(base, marker)))) projects.push({ id: BASE_ID, dir: '.', aliases: [BASE_ID] });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ projects }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  logger.info('Project registry created', { file, projects: projects.length });
  return projects;
}

/** A registry entry as a Project; throws if it is malformed or its directory is not allowed. */
function toProject(entry: any, base: string): Project {
  const valid =
    typeof entry?.id === 'string' &&
    entry.id !== '' &&
    typeof entry.dir === 'string' &&
    Array.isArray(entry.aliases) &&
    entry.aliases.every((alias: unknown) => typeof alias === 'string');
  if (!valid) throw new Error('an entry needs id, dir and aliases');
  const project: Project = { id: entry.id, dir: entry.dir, aliases: entry.aliases.map((a: string) => a.trim()).filter(Boolean) };
  resolveProjectDir(base, project);
  return project;
}

/** "@ops" names the Ops bot, so an alias a bot uses is dropped from the project, with a warning. */
function withoutBotAliases(project: Project, botNames: Set<string>): Project {
  const taken = project.aliases.filter((alias) => botNames.has(alias.toLowerCase()));
  if (!taken.length) return project;
  logger.warn('Ignoring project aliases that name a bot', { id: project.id, aliases: taken });
  return { ...project, aliases: project.aliases.filter((alias) => !taken.includes(alias)) };
}

/** The registry's entries as written, invalid ones included; creates the registry on first use, throws if it is malformed. */
function readEntries(base: string, file: string): unknown[] {
  const registry = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : { projects: createRegistry(base, file) };
  if (!Array.isArray(registry?.projects)) throw new Error('no "projects" array');
  return registry.projects;
}

/**
 * The registry, read on every call so edits apply right away. Entries that fail validation are
 * skipped, and so are aliases that a bot uses.
 */
export function loadProjects(base: string, file: string = PROJECTS_PATH, bots: Bot[] = loadBots()): Project[] {
  let entries: unknown[];
  try {
    entries = readEntries(base, file);
  } catch (err) {
    logger.warn('Failed to load project registry', { file, error: String(err) });
    return [];
  }
  const botNames = new Set(botAliases(bots).map(({ alias }) => alias.toLowerCase()));
  return entries.flatMap((entry) => {
    try {
      return [withoutBotAliases(toProject(entry, base), botNames)];
    } catch (err) {
      logger.warn('Skipping project', { id: String((entry as any)?.id), error: String(err) });
      return [];
    }
  });
}

/** The registry for /projects add and rm, which must not write over a file they cannot read. */
function registryEntries(base: string, file: string): unknown[] {
  try {
    return readEntries(base, file);
  } catch (err) {
    throw new Error(`项目配置无法读取，先修好 ${file}：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The names an entry answers to, its id and aliases, lowercased as matching treats them. */
function entryNames(entry: any): string[] {
  const names: unknown[] = [entry?.id, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])];
  return names.flatMap((name) => (typeof name === 'string' && name.trim() ? [name.trim().toLowerCase()] : []));
}

/** Writes the registry whole: a temp file renamed over it, so no reader sees half a file. */
export function saveProjects(file: string, projects: unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ projects }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

/**
 * /projects add: a project for a directory inside base, with its id as its one alias. The id is lowercased and
 * must be free among the projects' ids and aliases and the bots' aliases; dir defaults to the id as typed. The
 * registry's other entries stay as written, invalid ones included. Throws what the user must fix.
 */
export function addProject(base: string, file: string, id: string, dir?: string, bots: Bot[] = loadBots()): Project {
  const key = id.trim().toLowerCase();
  if (!PROJECT_ID.test(key) || key === BASE_ID) {
    throw new Error(`项目 id 需以字母或数字开头，只含字母、数字、- 和 _，最多 32 个字符；${BASE_ID} 留给基础目录`);
  }
  if (botAliases(bots).some(({ alias }) => alias.toLowerCase() === key)) throw new Error(`${key} 是 bot 的别名，换一个 id`);
  const entries = registryEntries(base, file);
  const owner = entries.find((entry) => entryNames(entry).includes(key));
  if (owner) throw new Error(`${key} 已被项目 ${String((owner as any).id)} 使用，发送 /projects 查看`);
  const project: Project = { id: key, dir: dir?.trim() || id.trim(), aliases: [key] };
  try {
    resolveProjectDir(base, project);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`目录不存在: ${resolve(base, project.dir)}`);
    throw err;
  }
  saveProjects(file, [...entries, project]);
  logger.info('Project added', { id: project.id, dir: project.dir });
  return project;
}

/** /projects rm: the entry with that id or alias leaves the registry, valid or not; its directory stays. "base" stays. */
export function removeProject(base: string, file: string, key: string): Project {
  const name = key.trim().toLowerCase();
  const entries = registryEntries(base, file);
  const index = entries.findIndex((entry) => entryNames(entry).includes(name));
  if (index < 0) throw new Error(`没有名为 ${name} 的项目，发送 /projects 查看`);
  const entry = entries[index] as any;
  if (entry.id === BASE_ID) throw new Error(`${BASE_ID} 是基础目录本身，不能移除`);
  saveProjects(file, entries.filter((_, i) => i !== index));
  logger.info('Project removed', { id: String(entry.id) });
  return { id: String(entry.id), dir: String(entry.dir), aliases: Array.isArray(entry.aliases) ? entry.aliases.map(String) : [] };
}

/** An image without text, or a short message that opens with a follow-up cue. */
function isFollowUp(text: string): boolean {
  const message = text.trim();
  return !message || (message.length <= FOLLOW_UP_MAX_CHARS && FOLLOW_UP.test(message));
}

/**
 * The project a message is about, in order: an "@alias" prefix, an alias mentioned anywhere, then
 * a follow-up (a short message opening with "继续" and the like, or an image without text) staying
 * in the previous task's project. null runs the task in the base workspace. Only registry entries
 * count; a path in the message never does.
 */
export function detectProject(text: string, projects: Project[], lastProjectId?: string | null): Project | null {
  const aliases = longestFirst(projects.flatMap((project) => project.aliases.map((alias) => ({ project, alias }))));
  const named =
    aliases.find(({ alias }) => prefixPattern(alias).test(text)) ??
    aliases.find(({ alias }) => alias.length >= MIN_MENTION_CHARS && mentionPattern(alias).test(text));
  if (named) return named.project;
  if (lastProjectId && isFollowUp(text)) return projects.find((p) => p.id === lastProjectId) ?? null;
  return null;
}

/** The message without its "@alias" prefix; the whole message if nothing would be left. */
export function stripProjectPrefix(text: string, project: Project): string {
  const prefix = longestFirst(project.aliases.map((alias) => ({ alias }))).find(({ alias }) => prefixPattern(alias).test(text));
  return (prefix && text.replace(prefixPattern(prefix.alias), '').trim()) || text;
}

/**
 * Who answers an inbound message, where it runs, and the text to store for it. The "@bot" prefix
 * comes off first and the project is found in the rest, so "@research 在 miaoda 里…" is both. A
 * message that opens with "@project" or "@base" may name its bot right after it: "@miaoda @eng …".
 * A short follow-up such as "继续" that names no bot stays with the last task's bot, as it stays in
 * the last task's project; "新话题：…" follows neither. No project means the account's workspace.
 */
export function routeMessage(
  db: StateDb,
  accountId: string,
  text: string,
): { input: string; project?: TaskProject; botId: string } {
  const bots = loadBots();
  const topic = NEW_TOPIC.exec(text);
  const message = (topic && text.slice(topic[0].length).trim()) || text;
  const { botId, input: rest } = detectBot(message, bots);
  // Only a message that no "@bot" opened looks for one after the project; a message names one bot.
  const opened = botId !== defaultBot(bots).id || rest !== message;
  const withBot = (input: string) => (opened ? { botId, input } : detectBot(input, bots));
  if (BASE_PREFIX.test(rest)) return withBot(rest.replace(BASE_PREFIX, '').trim() || rest);

  const base = loadConfig().workingDirectory;
  const last = topic ? undefined : db.recentTasks(accountId, 1)[0];
  const recent = last && Date.now() - last.created_at <= FOLLOW_UP_MS ? last : undefined;
  const project = detectProject(rest, loadProjects(base, PROJECTS_PATH, bots), recent?.project_id);
  const routed = withBot(project ? stripProjectPrefix(rest, project) : rest);
  // A follow-up opens with its cue, so no "@project" and no "@bot" stands before it.
  const lastBot = recent?.bot_id;
  if (!opened && lastBot && isFollowUp(rest) && (lastBot === ALL_BOTS || bots.some((bot) => bot.id === lastBot))) {
    routed.botId = lastBot;
  }
  return project ? { ...routed, project: { id: project.id, dir: resolveProjectDir(base, project) } } : routed;
}
