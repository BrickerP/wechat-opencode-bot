import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger.js';

/**
 * The owner's agentmemory engine holds every memory the bot uses; the bot keeps none of its own. Before a task the
 * daemon searches it with the message and shows the matches in <memory>; after the task it saves the facts the
 * orchestrator listed in its wechat_report memory, or updates a memory a fact names by id. Every call has a short deadline,
 * and a failed one is logged and never fails a task. The REST API is that of @agentmemory/agentmemory 0.9.
 */

const DEFAULT_URL = 'http://127.0.0.1:3111';
/** How many memories a prompt shows. */
export const MEMORY_MATCHES = 8;
/** A memory is shown, and a fact saved, up to this many characters. */
export const MAX_MEMORY_CHARS = 600;
/** The facts one task may save or update. */
export const MAX_FACTS_PER_TASK = 5;
/** The search runs before the task's first turn, so it may hold the task up this long at most. */
const SEARCH_TIMEOUT_MS = 3000;
/** All of one task's writes together. */
const SAVE_TIMEOUT_MS = 5000;
/** The engine ranks by the words of the query, so a long message is cut. */
const MAX_QUERY_CHARS = 300;
/** Every memory the bot saves carries this concept, which tells them apart from the owner's others. */
export const MEMORY_CONCEPT = 'wechat-opencode-bot';
/** A bullet that says there is nothing to keep. */
const NOTHING = new Set(['无', '无。', '(无)', '（无）', 'none', 'n/a', '-']);
/** "[mem_x] text", or "[mem_x 2026-11-18] text" as <memory> shows an entry: text replaces memory mem_x. */
const UPDATE = /^\[(mem_[\w-]+)(?:\s+\d{4}-\d{2}-\d{2})?\]\s*(.*)$/;

// Dates follow the user's clock, not the host timezone.
const DAY_FORMAT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

export interface MemoryConnection {
  url: string;
  /** Undefined for an engine without auth, which only an explicit AGENTMEMORY_URL reaches. */
  secret?: string;
}

/**
 * Where the engine is, from the variables its own CLI reads: AGENTMEMORY_URL, and AGENTMEMORY_SECRET or else the
 * file ~/.agentmemory/secret. Read on every call, so a new secret applies without a restart. Undefined, memory off,
 * when there is neither a secret nor an explicit URL.
 */
export function memoryConnection(): MemoryConnection | undefined {
  const explicit = process.env.AGENTMEMORY_URL?.trim();
  let secret = process.env.AGENTMEMORY_SECRET?.trim();
  if (!secret) {
    try {
      secret = readFileSync(join(homedir(), '.agentmemory', 'secret'), 'utf-8').trim();
    } catch {
      secret = undefined;
    }
  }
  if (!secret && !explicit) return undefined;
  return { url: (explicit || DEFAULT_URL).replace(/\/+$/, ''), secret: secret || undefined };
}

let offLogged = false;

/** memoryConnection, saying once per process that memory is off. */
function connect(): MemoryConnection | undefined {
  const connection = memoryConnection();
  if (!connection && !offLogged) {
    offLogged = true;
    logger.info('agentmemory is off: no AGENTMEMORY_SECRET, ~/.agentmemory/secret or AGENTMEMORY_URL; tasks run without memory');
  }
  return connection;
}

/** Why a request failed, in a few words: fetch puts the reason in err.cause. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err).slice(0, 80);
  if (err.name === 'TimeoutError') return '超时无响应';
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return (code ? `${err.message} (${code})` : err.message).slice(0, 80);
}

/** One request; a JSON body makes it a POST. Resolves to the status and the parsed body, if any. */
async function call(connection: MemoryConnection, path: string, signal: AbortSignal, body?: unknown): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = connection.secret ? { Authorization: `Bearer ${connection.secret}` } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${connection.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  return { status: res.status, data };
}

/** "HTTP 500: why", from a status and the engine's { error } body. */
const httpError = (status: number, data: any): Error =>
  new Error(`HTTP ${status}${typeof data?.error === 'string' ? `: ${data.error.slice(0, 80)}` : ''}`);

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A memory as a prompt shows it. */
export interface Memory {
  id: string;
  /** On one line, cut at MAX_MEMORY_CHARS with "…". */
  text: string;
  /** Whether text is the whole memory. Only such a memory may be updated, so a cut never replaces the rest. */
  full: boolean;
  /** The day of its latest version, YYYY-MM-DD in Asia/Shanghai; '' when the engine gave none. */
  date: string;
}

function toMemory(raw: any): Memory[] {
  if (typeof raw?.id !== 'string' || typeof raw?.content !== 'string') return [];
  const content = oneLine(raw.content);
  if (!content) return [];
  const at = Date.parse(raw.updatedAt ?? raw.createdAt ?? '');
  const full = content.length <= MAX_MEMORY_CHARS;
  return [{ id: raw.id, text: full ? content : `${content.slice(0, MAX_MEMORY_CHARS)}…`, full, date: Number.isNaN(at) ? '' : DAY_FORMAT.format(at) }];
}

/**
 * The latest memories that match the query, best first, by the engine's keyword and vector search over every agent's
 * memories. [] when memory is off, the query is empty, or the search fails or passes the deadline. Never throws.
 */
export async function searchMemories(query: string, signal: AbortSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS)): Promise<Memory[]> {
  const q = oneLine(query).slice(0, MAX_QUERY_CHARS);
  const connection = connect();
  if (!connection || !q) return [];
  try {
    const params = new URLSearchParams({ q, limit: String(MEMORY_MATCHES), agentId: '*', latest: 'true' });
    const { status, data } = await call(connection, `/agentmemory/memories?${params}`, signal);
    if (status !== 200) throw httpError(status, data);
    return (Array.isArray(data?.memories) ? data.memories : []).flatMap(toMemory).slice(0, MEMORY_MATCHES);
  } catch (err) {
    logger.warn('Memory search failed', { error: describe(err) });
    return [];
  }
}

/** A memory item of wechat_report: a fact to save, or with id the new text of that memory. */
interface Fact {
  id?: string;
  text: string;
}

function parseFact(bullet: string): Fact | undefined {
  // A model used to bullet lists may still open an item with "- ".
  const line = oneLine(bullet).replace(/^[-*]\s+/, '');
  const update = UPDATE.exec(line);
  const text = (update ? update[2] : line).slice(0, MAX_MEMORY_CHARS).trim();
  if (!text || NOTHING.has(text.toLowerCase())) return undefined;
  return update ? { id: update[1], text } : { text };
}

/** What saveMemories did with a task's facts. */
export interface MemoryWrites {
  saved: number;
  updated: number;
  failed: number;
}

/**
 * Saves the memory items of a task's wechat_report: the first MAX_FACTS_PER_TASK that hold a fact, each on one line and cut at
 * MAX_MEMORY_CHARS. "[mem_x] text" updates memory mem_x to text (the engine's evolve, which keeps the old version)
 * when the task's prompt showed mem_x whole, so it is in updatable. A fact for a memory shown cut or not at all, or
 * one the engine no longer has as its latest version, is saved as a new memory instead. Any other bullet is a new
 * memory tagged MEMORY_CONCEPT; the engine itself replaces a latest memory that the new text closely repeats.
 * Never throws.
 */
export async function saveMemories(
  bullets: string[],
  updatable: ReadonlySet<string>,
  signal: AbortSignal = AbortSignal.timeout(SAVE_TIMEOUT_MS),
): Promise<MemoryWrites> {
  const writes: MemoryWrites = { saved: 0, updated: 0, failed: 0 };
  const facts = bullets.flatMap((bullet) => parseFact(bullet) ?? []).slice(0, MAX_FACTS_PER_TASK);
  if (!facts.length) return writes;
  const connection = connect();
  if (!connection) return writes;
  for (const { id, text } of facts) {
    try {
      if (id && updatable.has(id)) {
        const update = await call(connection, '/agentmemory/evolve', signal, { memoryId: id, newContent: text });
        if (update.status === 200) {
          writes.updated++;
          continue;
        }
        if (update.data?.code === 'unchanged') continue;
        if (update.status !== 404 && update.status !== 409) throw httpError(update.status, update.data);
        logger.warn('Memory to update is gone or superseded; saving the fact as a new memory', { memoryId: id, status: update.status });
      } else if (id) {
        logger.warn('Memory to update was not shown whole; saving the fact as a new memory', { memoryId: id });
      }
      const { status, data } = await call(connection, '/agentmemory/remember', signal, { content: text, concepts: [MEMORY_CONCEPT] });
      // The engine answers 201 even when it refuses the memory, with success: false.
      if (status !== 201 || data?.success === false) throw httpError(status, data);
      writes.saved++;
    } catch (err) {
      writes.failed++;
      logger.warn('Memory write failed', { memoryId: id, error: describe(err) });
    }
  }
  return writes;
}

/** /doctor's view of the engine. */
export type MemoryCheck =
  | { state: 'off' }
  | { state: 'ok'; url: string; count: number }
  | { state: 'unreachable'; url: string; reason: string };

/** Whether the engine answers an authenticated request, and how many latest memories it holds. Never throws. */
export async function checkMemory(signal: AbortSignal = AbortSignal.timeout(SEARCH_TIMEOUT_MS)): Promise<MemoryCheck> {
  const connection = memoryConnection();
  if (!connection) return { state: 'off' };
  const { url } = connection;
  try {
    const { status, data } = await call(connection, '/agentmemory/memories?count=true&latest=true&agentId=*', signal);
    if (status === 401 || status === 403) return { state: 'unreachable', url, reason: `鉴权失败（HTTP ${status}），检查 AGENTMEMORY_SECRET` };
    if (status !== 200) return { state: 'unreachable', url, reason: httpError(status, data).message };
    return { state: 'ok', url, count: Number(data?.total) || 0 };
  } catch (err) {
    return { state: 'unreachable', url, reason: describe(err) };
  }
}
