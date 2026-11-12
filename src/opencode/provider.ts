import { logger } from "../logger.js";
import type { ErrorKind } from "../model-routing.js";
import { execSync, spawn } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export interface QueryOptions {
  prompt: string;
  cwd: string;
  /** OpenCode agent that owns the new session. */
  agent?: string;
  /** "provider/model" or "provider/model#variant"; omitted means the agent's own model. */
  model?: string;
  title?: string;
  /** Local files (images) attached to the prompt. */
  files?: string[];
  /** Aborting interrupts the session; the result then has interrupted=true. */
  signal?: AbortSignal;
  onPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /** Called once the session exists, before the prompt is sent. */
  onSession?: (sessionId: string) => void;
  /**
   * Called while the turn runs, at most once per poll: how long it has run, how many subagent sessions exist and
   * which tools are running in the session and in them (each name once, at most PROGRESS_TOOLS).
   */
  onProgress?: (update: { elapsedMs: number; children: number; idleMs: number; tools: string[] }) => void;
  /**
   * Called once per message with the public text of a root step that calls a tool, as soon as the model has
   * finished that step's response: what the orchestrator says while it works. A step without a tool call is an
   * answer, left to the result. Never reasoning, subagent sessions, tool input or output, a failed step, or
   * anything once the signal aborts; a callback that throws or rejects is only logged.
   */
  onAssistantText?: (update: { messageId: string; text: string }) => void | Promise<void>;
}

export interface PermissionRequest {
  id: string;
  /** The session that asked: the orchestrator or one of its subagent sessions. */
  sessionId: string;
  action: string;
  resources: string[];
  message?: string;
}

export type PermissionDecision = "once" | "always" | "reject";

export interface QueryResult {
  text: string;
  sessionId: string;
  error?: string;
  interrupted?: boolean;
  /** The upstream model failed or went silent; another attempt may succeed. */
  upstream?: boolean;
  /** Set when OpenCode or a watchdog ended the turn, not for local failures such as an unreachable server. */
  errorKind?: ErrorKind;
  /** What the session and its subagent sessions used; undefined when OpenCode could not say. */
  usage?: Usage;
}

/** Tokens and cost as OpenCode counts them; its token counts do not overlap. */
export interface Usage {
  /** Prompt tokens neither read from nor written to the cache. */
  input: number;
  /** Completion tokens, reasoning excluded. */
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD; 0 for a model OpenCode has no price for. */
  cost: number;
}

export interface ProviderModel {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  variants: string[];
}

const OPENCODE_URL = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/+$/, "");
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 4096);
const OPENCODE_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";

const TURN_TIMEOUT_MS = 30 * 60 * 1000;
/** The model must show its first output (any content part) this soon after the prompt is admitted. */
const FIRST_RESPONSE_TIMEOUT_MS = Number(process.env.OPENCODE_FIRST_RESPONSE_TIMEOUT_MS) || 120_000;
/** Once it has answered, something in the session tree must change at least this often. */
const STALL_TIMEOUT_MS = Number(process.env.OPENCODE_STALL_TIMEOUT_MS) || 180_000;
const POLL_INTERVAL_MS = 1500;
/** Running tool names a progress update carries at most. */
const PROGRESS_TOOLS = 5;

/** The turn was stopped (abort signal, /stop, or an interrupted idle outcome). */
export class TurnInterrupted extends Error {
  constructor(message = "任务已停止") {
    super(message);
    this.name = "TurnInterrupted";
  }
}

/** OpenCode ended the turn with a failure, or a watchdog ended it. */
export class TurnFailed extends Error {
  readonly errorKind: ErrorKind;

  constructor(message: string, errorKind: ErrorKind = "unknown") {
    super(message);
    this.name = "TurnFailed";
    this.errorKind = errorKind;
  }
}

/** The upstream model failed or stopped making progress; another attempt may succeed. */
export class UpstreamError extends TurnFailed {
  constructor(message: string, errorKind: ErrorKind = "server") {
    super(message, errorKind);
    this.name = "UpstreamError";
  }
}

/** A watchdog gave up on a silent upstream model. */
export class TurnTimeout extends UpstreamError {
  constructor(message: string) {
    super(message, "timeout");
    this.name = "TurnTimeout";
  }
}

function authHeaders(): Record<string, string> {
  if (!OPENCODE_PASSWORD) return {};
  const token = Buffer.from(`opencode:${OPENCODE_PASSWORD}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeaders(),
    ...((init.headers as Record<string, string>) || {}),
  };
  if (init.body) headers["Content-Type"] = "application/json";

  const res = await fetch(`${OPENCODE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${init.method || "GET"} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return (await res.text()) as unknown as T;
  }
  return (await res.json()) as T;
}

function checkOpenCodeInstalled(): boolean {
  try {
    execSync(process.platform === "win32" ? "where opencode" : "which opencode", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function waitForService(maxAttempts: number = 120): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await pingOpenCode()) return true;
    await sleep(1000);
  }
  return false;
}

function startOpenCodeService(cwd?: string): void {
  logger.info("Starting OpenCode service", { port: OPENCODE_PORT, password: Boolean(OPENCODE_PASSWORD) });
  console.log(`正在启动 OpenCode 服务 (端口: ${OPENCODE_PORT})...`);

  try {
    const child = spawn(
      "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", String(OPENCODE_PORT)],
      {
        cwd: cwd || process.cwd(),
        detached: true,
        stdio: "ignore",
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: OPENCODE_PASSWORD || undefined },
      },
    );
    child.unref();
  } catch (e) {
    logger.warn("Start command failed", { error: String(e) });
  }
}

/** GET /api/info; throws if the server cannot be reached. version is undefined if it reports none. */
export async function openCodeInfo(signal?: AbortSignal): Promise<{ version?: string }> {
  const info = await api<{ version?: unknown }>("/api/info", { signal });
  return { version: typeof info?.version === "string" ? info.version : undefined };
}

export async function pingOpenCode(): Promise<boolean> {
  try {
    await openCodeInfo();
    return true;
  } catch {
    return false;
  }
}

/** The agents the server has loaded, hidden ones included. A session names its agent by id. */
export async function listAgents(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>> {
  const out = await api<{ data: any[] }>("/api/agent", { signal });
  return (out.data || []).map((a) => ({ id: String(a.id), name: a.name || a.id }));
}

export async function initOpenCode(cwd?: string): Promise<void> {
  if (await pingOpenCode()) {
    logger.info("OpenCode client connected", { url: OPENCODE_URL });
    return;
  }
  logger.warn("Failed to connect to OpenCode, checking installation");

  if (!checkOpenCodeInstalled()) {
    throw new Error(`OpenCode 未安装。请先安装：\nnpm install -g opencode-ai`);
  }

  console.log("OpenCode 已安装，但服务未启动");
  startOpenCodeService(cwd);

  console.log("等待 OpenCode 服务启动...");
  if (!(await waitForService())) {
    throw new Error(
      `OpenCode 服务启动失败或超时。\n` +
        `请手动启动: OPENCODE_SERVER_PASSWORD=... opencode serve --hostname 127.0.0.1 --port ${OPENCODE_PORT}`,
    );
  }

  console.log("✅ OpenCode 服务已启动");
  logger.info("OpenCode service started successfully");
}

export function parseModelRef(model: string): { providerID: string; id: string; variant?: string } | undefined {
  const value = model.trim();
  if (!value) return undefined;

  let body = value;
  let variant: string | undefined;
  const hash = body.indexOf("#");
  if (hash !== -1) {
    variant = body.slice(hash + 1) || undefined;
    body = body.slice(0, hash);
  }

  const slash = body.indexOf("/");
  if (slash === -1) return undefined;
  const providerID = body.slice(0, slash);
  const id = body.slice(slash + 1);
  if (!providerID || !id) return undefined;
  return { providerID, id, variant };
}

export async function listModels(): Promise<ProviderModel[]> {
  const out = await api<{ data: any[] }>("/api/model");
  return (out.data || []).map((m) => ({
    id: m.id,
    modelID: m.modelID || m.id,
    providerID: m.providerID,
    name: m.name || m.id,
    variants: Array.isArray(m.variants)
      ? m.variants.map((v: any) => String(v?.id ?? v))
      : m.variants && typeof m.variants === "object"
        ? Object.keys(m.variants)
        : [],
  }));
}

export type ModelRef = { providerID: string; id: string; variant?: string };

/** Validate a user-supplied model ("provider/model[#variant]" or a bare model id) against the server's model list. */
export async function resolveModelRef(model: string): Promise<ModelRef | undefined> {
  const models = await listModels();
  const ref = parseModelRef(model);
  const bare = model.trim();
  const hit = ref
    ? models.find((m) => m.providerID === ref.providerID && (m.id === ref.id || m.modelID === ref.id))
    : models.find((m) => m.id === bare || m.modelID === bare);
  if (!hit) return undefined;
  if (ref?.variant && hit.variants.length && !hit.variants.includes(ref.variant)) return undefined;
  return { providerID: hit.providerID, id: hit.id, variant: ref?.variant };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`;
}

async function createSession(title: string, cwd: string, agent?: string, model?: string): Promise<string> {
  const body: Record<string, unknown> = { title, location: { directory: cwd } };
  if (agent) body.agent = agent;
  if (model) {
    // A model comes from /model or a bot's bots.json entry; both store provider/model[#variant], so a
    // malformed one is a bug in the caller rather than something to guess around.
    const ref = parseModelRef(model);
    if (!ref) throw new Error(`无效的模型: ${model}`);
    body.model = ref;
  }

  const out = await api<{ data: { id: string } }>("/api/session", {
    method: "POST",
    body: JSON.stringify(body),
  });
  logger.info("Session created", { sessionId: out.data.id, agent, model });
  return out.data.id;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** A session's usage from its tokens and cost fields; a missing field counts as 0. */
function readUsage(session: any): Usage {
  const tokens = session?.tokens;
  return {
    input: count(tokens?.input),
    output: count(tokens?.output),
    reasoning: count(tokens?.reasoning),
    cacheRead: count(tokens?.cache?.read),
    cacheWrite: count(tokens?.cache?.write),
    cost: count(session?.cost),
  };
}

/** Sessions spawned by the subagent tool carry parentID. */
export async function listChildSessions(
  parentId: string,
): Promise<Array<{ id: string; title: string; agent?: string; usage: Usage }>> {
  const params = new URLSearchParams({ parentID: parentId, limit: "50" });
  const out = await api<{ data: any[] }>(`/api/session?${params.toString()}`);
  return (out.data || []).map((s) => ({ id: s.id, title: s.title || s.id, agent: s.agent, usage: readUsage(s) }));
}

/**
 * Sessions on this server whose title contains query, case-insensitively, as the list pages give them. The list
 * is read 100 sessions a page through its cursor, at most limit sessions in all; no messages are fetched.
 */
export async function listSessions(
  query: string,
  limit = 500,
  signal?: AbortSignal,
): Promise<Array<{ id: string; title: string; time?: number }>> {
  const needle = query.toLowerCase();
  const found: Array<{ id: string; title: string; time?: number }> = [];
  let cursor: string | undefined;
  for (let seen = 0; seen < limit; ) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const out = await api<{ data: any[]; cursor?: { next?: string } }>(`/api/session?${params.toString()}`, { signal });
    const page = (out.data || []).slice(0, limit - seen);
    seen += page.length;
    for (const s of page) {
      if (!String(s.title ?? "").toLowerCase().includes(needle)) continue;
      const time = s.time?.updated ?? s.time?.created;
      found.push({ id: s.id, title: s.title || s.id, time: typeof time === "number" ? time : undefined });
    }
    cursor = out.cursor?.next;
    if (!cursor || !page.length) break;
  }
  return found;
}

/** The text of the session's newest assistant message that has any, as a turn ends with; "" when none has. */
export async function lastAssistantText(sessionId: string, signal?: AbortSignal): Promise<string> {
  const out = await api<{ data: any[] }>(`/api/session/${encodeURIComponent(sessionId)}/message?limit=100&order=desc`, { signal });
  for (const message of (out.data || []).filter((m) => m?.type === "assistant")) {
    const text = extractAssistantText(message);
    if (text) return text;
  }
  return "";
}

/**
 * What a session and its subagent sessions used. OpenCode counts a session's own model calls only, and the
 * orchestrator's subagents start none of their own, so the root and its children are the whole turn.
 * Best effort: undefined when OpenCode cannot say.
 */
export async function sessionUsage(sessionId: string): Promise<Usage | undefined> {
  try {
    const [root, children] = await Promise.all([
      api<{ data: any }>(`/api/session/${encodeURIComponent(sessionId)}`),
      listChildSessions(sessionId),
    ]);
    return [readUsage(root?.data), ...children.map((child) => child.usage)].reduce((sum, u) => ({
      input: sum.input + u.input,
      output: sum.output + u.output,
      reasoning: sum.reasoning + u.reasoning,
      cacheRead: sum.cacheRead + u.cacheRead,
      cacheWrite: sum.cacheWrite + u.cacheWrite,
      cost: sum.cost + u.cost,
    }));
  } catch (err) {
    logger.warn("Failed to read session usage", { sessionId, error: String(err) });
    return undefined;
  }
}

/** Best effort: stop the session and the subagent sessions it spawned. Idle sessions are a no-op. */
export async function interruptSession(sessionId: string): Promise<void> {
  const ids = [sessionId];
  try {
    ids.push(...(await listChildSessions(sessionId)).map((child) => child.id));
  } catch (err) {
    logger.warn("Failed to list child sessions", { sessionId, error: String(err) });
  }
  await Promise.all(
    ids.map((id) =>
      api(`/api/session/${id}/interrupt`, { method: "POST" }).catch((err) =>
        logger.warn("Failed to interrupt session", { sessionId: id, error: String(err) }),
      ),
    ),
  );
}

/**
 * More input for a session's running turn. OpenCode admits it at once and takes it in at the turn's next safe
 * step, not after the whole turn, so the waitForTurn already polling that session still gets the answer.
 */
export async function steerSession(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
  await api(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text, delivery: "steer" }),
    signal,
  });
}

/** OpenCode's 404 for a session that does not exist, as opposed to a route it does not have. */
const SESSION_NOT_FOUND = /-> HTTP 404: .*"SessionNotFoundError"/;

/** Delete a session; OpenCode deletes its child sessions with it. One that is already gone counts as deleted. */
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await api(`/api/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  } catch (err) {
    if (!SESSION_NOT_FOUND.test(String(err))) throw err;
  }
}

async function listPendingPermissions(sessionId: string): Promise<PermissionRequest[]> {
  try {
    const out = await api<{ data: any[] }>(`/api/session/${sessionId}/permission`);
    return (out.data || []).map((p) => ({
      id: p.id,
      sessionId,
      action: p.action,
      resources: Array.isArray(p.resources) ? p.resources : [],
      message: p.message,
    }));
  } catch (err) {
    logger.warn("Failed to list pending permissions", { error: String(err) });
    return [];
  }
}

async function replyPermission(sessionId: string, requestId: string, decision: PermissionDecision): Promise<void> {
  await api(`/api/session/${sessionId}/permission/${requestId}/reply`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
}

function extractAssistantText(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim())
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

/** "provider.internal: control plan is unavailable" for structured errors, JSON otherwise. */
function describeError(error: any): string {
  if (!error) return "unknown error";
  if (error.type || error.message) return [error.type, error.message].filter(Boolean).join(": ");
  return JSON.stringify(error);
}

/** provider.* types by their last segment; any other provider failure counts as a server error. */
const PROVIDER_KINDS = new Map<string, ErrorKind>([
  ["auth", "auth"],
  ["quota", "quota"],
  ["timeout", "timeout"],
  ["transport", "transport"],
  ["connect", "transport"],
]);

/**
 * Errors OpenCode did not map to a provider.* type, by their text. The first match wins, so
 * "do request failed: HTTP 502" is a server error rather than a transport one.
 */
const UPSTREAM_TEXT: Array<[ErrorKind, RegExp]> = [
  ["quota", /HTTP 429|status(?:Code)?\D{0,3}429|rate.?limit|quota/i],
  ["server", /HTTP 5\d\d|status(?:Code)?\D{0,3}5\d\d|overloaded/i],
  ["timeout", /ETIMEDOUT|timed out|request timeout/i],
  ["transport", /do request failed|fetch failed|ECONNRESET|ECONNREFUSED|socket hang up/i],
];

/**
 * What a failed idle outcome means. Upstream failures (the gateway or its model) may pass on another
 * gateway; the rest (auth, a rejected permission, a bad request) would fail again.
 */
export function classifyIdleError(error: any): { message: string; kind: ErrorKind; upstream: boolean } {
  const message = `OpenCode 执行失败: ${describeError(error).slice(0, 500)}`;
  const type = String(error?.type ?? "");
  if (type.startsWith("provider.")) {
    // The first segment after "provider.": provider.auth.expired still counts as auth.
    const suffix = type.slice("provider.".length).split(".")[0];
    // "limit" covers rate-limit, free-limit, budget-limit and model-budget-limit; a context limit is not quota.
    const kind = PROVIDER_KINDS.get(suffix) ?? (suffix.includes("limit") && !suffix.includes("context") ? "quota" : "server");
    return { message, kind, upstream: kind !== "auth" };
  }
  // A rejection's message can be the user's own feedback, which says nothing about the model.
  if (type.startsWith("permission.")) return { message, kind: "unknown", upstream: false };

  const text = typeof error === "string" ? error : JSON.stringify(error ?? null);
  const match = UPSTREAM_TEXT.find(([, pattern]) => pattern.test(text));
  if (match) return { message, kind: match[0], upstream: true };
  const kind = /HTTP 4\d\d|invalid|unsupported|not found/i.test(text) ? "bad_request" : "unknown";
  return { message, kind, upstream: false };
}

/** Names of the tool calls that are still executing. */
function runningTools(messages: any[]): string[] {
  return messages.flatMap((m) =>
    (Array.isArray(m?.content) ? m.content : [])
      .filter((part: any) => part?.type === "tool" && part.state?.status === "running")
      .map((part: any) => String(part.name)),
  );
}

/**
 * What moves while a model works: new messages and parts, their timestamps and tool states.
 * Part text only shows up once the part has finished streaming.
 */
function progressSignature(messages: any[]): string {
  return JSON.stringify(
    messages.map((m) => [
      m?.id,
      m?.time,
      (Array.isArray(m?.content) ? m.content : []).map((part: any) => [part?.type, part?.state?.status, part?.time, part?.text?.length]),
    ]),
  );
}

/** A step that calls a tool says what it does on the way; only a step that calls none can be the answer. */
const callsTool = (message: any): boolean =>
  Array.isArray(message?.content) && message.content.some((part: any) => part?.type === "tool");

/**
 * Hands onAssistantText the text of each root step that calls a tool, oldest first, once the model's response for
 * that step has streamed in full. A step is looked at once, by message id; a failed one is left for OpenCode's
 * retry of the same message.
 */
function announceSteps(sessionId: string, assistants: any[], announced: Set<string>, options: QueryOptions): void {
  for (const message of assistants) {
    const id = message?.id;
    if (typeof id !== "string" || announced.has(id) || message.error) continue;
    if (!message.time?.streamed && !message.time?.completed) continue;
    announced.add(id);
    if (!callsTool(message)) continue;
    const text = extractAssistantText(message);
    if (!text) continue;
    // Checked when the callback is due, not when it is queued: an abort in between drops the step.
    Promise.resolve()
      .then(() => (options.signal?.aborted ? undefined : options.onAssistantText?.({ messageId: id, text })))
      .catch((err) => logger.debug("Assistant text callback failed", { sessionId, messageId: id, error: String(err) }));
  }
}

/**
 * Poll until the turn goes idle, answering permission requests on the way and announcing the root steps that
 * call a tool (announceSteps). Two watchdogs give up on a silent upstream model: no first output within
 * FIRST_RESPONSE_TIMEOUT_MS, or no visible change in the session or its subagent sessions for STALL_TIMEOUT_MS.
 * The answer is the text of the last step that says or does anything, and only if that step calls no tool: a turn
 * that ends on a tool step, or on nothing at all, fails rather than pass what was said on the way off as the answer.
 */
async function waitForTurn(sessionId: string, since: number, options: QueryOptions): Promise<string> {
  const startedAt = Date.now();
  const deadline = startedAt + TURN_TIMEOUT_MS;
  const handledPermissions = new Set<string>();
  const announced = new Set<string>();
  let progress = "";
  let progressAt = startedAt;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new TurnInterrupted();

    // Real work runs in subagent sessions, and each of them asks for its own permissions.
    const children = await listChildSessions(sessionId).catch(() => [] as Array<{ id: string }>);
    const pending = (await Promise.all([sessionId, ...children.map((c) => c.id)].map(listPendingPermissions))).flat();
    for (const request of pending) {
      if (handledPermissions.has(request.id)) continue;
      handledPermissions.add(request.id);

      let decision: PermissionDecision = "reject";
      if (options.onPermission) {
        try {
          decision = await options.onPermission(request);
        } catch (err) {
          logger.warn("Permission handler failed, rejecting", { error: String(err), requestId: request.id });
        }
      }

      try {
        await replyPermission(request.sessionId, request.id, decision);
        logger.info("Permission replied", {
          requestId: request.id,
          sessionId: request.sessionId,
          action: request.action,
          decision,
        });
      } catch (err) {
        logger.warn("Failed to reply permission", {
          requestId: request.id,
          sessionId: request.sessionId,
          error: String(err),
        });
      }
    }

    // A session waiting on the user is not a silent model, however long the answer takes.
    if (pending.length) progressAt = Date.now();

    const out = await api<{ data: any[] }>(`/api/session/${sessionId}/message?limit=100&order=desc`);
    const turn = (out.data || []).filter((m) => (m?.time?.created ?? 0) >= since);
    const assistants = turn
      .filter((m) => m?.type === "assistant")
      .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
    // Before the idle check, so a step that came in the same poll as the end of the turn is told ahead of the answer.
    if (options.onAssistantText) announceSteps(sessionId, assistants, announced, options);

    const idle = turn.find((m) => m?.type === "idle");
    if (idle) {
      if (idle.outcome === "failed") {
        const { message, kind, upstream } = classifyIdleError(idle.error);
        throw upstream ? new UpstreamError(message, kind) : new TurnFailed(message, kind);
      }
      if (idle.outcome === "interrupted") {
        throw new TurnInterrupted("OpenCode 执行被中断");
      }

      // Back from the newest step over those that call no tool; one that only reasoned, or wrote nothing, is passed over.
      for (let i = assistants.length - 1; i >= 0 && !callsTool(assistants[i]); i--) {
        const text = extractAssistantText(assistants[i]);
        if (text) return text;
      }
      throw new TurnFailed("OpenCode 执行结束，但模型没有给出最终回复");
    }

    const childMessages = (
      await Promise.all(
        children.map((c) =>
          api<{ data: any[] }>(`/api/session/${c.id}/message?limit=5&order=desc`).then((o) => o.data || [], () => []),
        ),
      )
    ).flat();
    // A running tool is local work (a build, a long command), not a silent model. The root's subagent calls
    // are judged by their child sessions; a child's own subagent call runs in a session not watched here.
    const tools = [...runningTools(turn).filter((name) => name !== "subagent"), ...runningTools(childMessages)];
    const working = tools.length > 0;
    const signature = progressSignature([...turn, ...childMessages]);
    const now = Date.now();
    if (working || signature !== progress) {
      progress = signature;
      progressAt = now;
    }
    const responded = turn.some((m) => m?.type === "assistant" && (m.content?.length || m.time?.streamed));
    if (!responded && now - startedAt > FIRST_RESPONSE_TIMEOUT_MS) {
      throw new TurnTimeout(`上游模型 ${FIRST_RESPONSE_TIMEOUT_MS / 1000} 秒无响应`);
    }
    if (responded && now - progressAt > STALL_TIMEOUT_MS) {
      throw new TurnTimeout(`上游模型 ${STALL_TIMEOUT_MS / 1000} 秒无进展`);
    }
    try {
      options.onProgress?.({
        elapsedMs: now - startedAt,
        children: children.length,
        idleMs: now - progressAt,
        tools: [...new Set(tools)].slice(0, PROGRESS_TOOLS),
      });
    } catch (err) {
      logger.debug("Progress callback failed", { sessionId, error: String(err) });
    }

    await sleep(POLL_INTERVAL_MS, options.signal);
  }

  throw new Error("OpenCode 执行超时（30 分钟）");
}

/** Run one turn in a brand-new session. Sessions are never resumed: context lives outside OpenCode. */
export async function openCodeQuery(options: QueryOptions): Promise<QueryResult> {
  const { prompt, cwd, agent, model, title, files, signal } = options;
  logger.info("Starting OpenCode query", { cwd, agent, model, promptLength: prompt.length, files: files?.length ?? 0 });

  let sessionId = "";
  try {
    sessionId = await createSession(title || "微信任务", cwd, agent, model);
    options.onSession?.(sessionId);
    if (signal?.aborted) throw new TurnInterrupted();

    const body: Record<string, unknown> = { text: prompt, delivery: "queue" };
    if (files?.length) body.files = files.map((p) => ({ uri: pathToFileURL(p).href, name: basename(p) }));

    const admitted = await api<{ data: { time?: { created?: number } } }>(
      `/api/session/${sessionId}/prompt`,
      { method: "POST", body: JSON.stringify(body) },
    );
    const since = admitted?.data?.time?.created ?? Date.now();

    const text = await waitForTurn(sessionId, since, options);
    logger.info("OpenCode query completed", { sessionId, textLength: text.length });
    return { text, sessionId, usage: await sessionUsage(sessionId) };
  } catch (err) {
    const interrupted = err instanceof TurnInterrupted;
    const upstream = err instanceof UpstreamError;
    // Errors from the local OpenCode server itself (unreachable, HTTP errors) have no kind and are never upstream.
    const errorKind = err instanceof TurnFailed ? err.errorKind : undefined;
    const error = err instanceof Error ? err.message : String(err);
    // Timeouts, aborts and transport errors can leave the session executing on the server.
    if (sessionId) await interruptSession(sessionId);
    // Read once the interrupt is in, so the stopped sessions are counted as they ended.
    const usage = sessionId ? await sessionUsage(sessionId) : undefined;
    if (interrupted) logger.info("OpenCode query interrupted", { sessionId });
    else logger.error("OpenCode query failed", { sessionId, error, upstream, errorKind });
    return { text: "", sessionId, error, interrupted, upstream, errorKind, usage };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
