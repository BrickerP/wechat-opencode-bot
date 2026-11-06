import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { longestFirst, mentionPattern, prefixPattern } from './aliases.js';
import { botAliases, defaultBot, detectBot, loadBots, type Bot } from './bots.js';
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

/** A follow-up stays in the previous task's project only if that task came this recently. */
const FOLLOW_UP_MS = 2 * 60 * 60 * 1000;
/** A follow-up opens with one of these cues; inside another word (其它, 再见) or later in a sentence they mean nothing. */
const FOLLOW_UP = /^(继续|接着|然后|再(?!见)|那|这个|上面|刚才|它|还有|第二个|改一下|看一下)/;
/** Longer messages are new requests: they name their project or run in the base. */
const FOLLOW_UP_MAX_CHARS = 32;
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
  if (PROJECT_MARKERS.some((marker) => existsSync(join(base, marker)))) projects.push({ id: 'base', dir: '.', aliases: ['base'] });
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

/**
 * The registry, read on every call so edits apply right away. Entries that fail validation are
 * skipped, and so are aliases that a bot uses.
 */
export function loadProjects(base: string, file: string = PROJECTS_PATH, bots: Bot[] = loadBots()): Project[] {
  let entries: unknown[];
  try {
    const registry = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : { projects: createRegistry(base, file) };
    if (!Array.isArray(registry?.projects)) throw new Error('no "projects" array');
    entries = registry.projects;
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
 * message that opens with "@project" may name its bot right after it: "@miaoda @eng …".
 * No project means the account's workspace.
 */
export function routeMessage(
  db: StateDb,
  accountId: string,
  text: string,
): { input: string; project?: TaskProject; botId: string } {
  const bots = loadBots();
  const { botId, input: rest } = detectBot(text, bots);
  const base = loadConfig().workingDirectory;
  const [last] = db.recentTasks(accountId, 1);
  const lastProjectId = last && Date.now() - last.created_at <= FOLLOW_UP_MS ? last.project_id : null;
  const project = detectProject(rest, loadProjects(base, PROJECTS_PATH, bots), lastProjectId);
  if (!project) return { input: rest, botId };
  const input = stripProjectPrefix(rest, project);
  // Only a message that no "@bot" opened looks for one after the project; a message names one bot.
  const opened = botId !== defaultBot(bots).id || rest !== text;
  const routed = opened ? { botId, input } : detectBot(input, bots);
  return { input: routed.input, project: { id: project.id, dir: resolveProjectDir(base, project) }, botId: routed.botId };
}
