import { logger } from "../logger.js";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface QueryOptions {
  prompt: string;
  cwd: string;
  resume?: string;
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "auto";
  images?: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }>;
  title?: string;
  onPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
  onSession?: (sessionId: string) => void;
}

export interface PermissionRequest {
  id: string;
  action: string;
  resources: string[];
  message?: string;
}

export type PermissionDecision = "once" | "always" | "reject";

export interface QueryResult {
  text: string;
  sessionId: string;
  error?: string;
}

export interface ProviderModel {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
}

const OPENCODE_URL = (process.env.OPENCODE_URL || "http://127.0.0.1:4096").replace(/\/+$/, "");
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 4096);
const OPENCODE_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";
const OPENCODE_AGENT = process.env.OPENCODE_AGENT || "";

const TURN_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;

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
    try {
      await api("/api/info");
      return true;
    } catch {
      // not ready yet
    }
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

export async function initOpenCode(cwd?: string): Promise<void> {
  try {
    await api("/api/info");
    logger.info("OpenCode client connected", { url: OPENCODE_URL });
    return;
  } catch {
    logger.warn("Failed to connect to OpenCode, checking installation");
  }

  if (!checkOpenCodeInstalled()) {
    throw new Error(
      `OpenCode 未安装。请先安装：\n` +
        `npm install -g opencode-ai`,
    );
  }

  console.log("OpenCode 已安装，但服务未启动");
  startOpenCodeService(cwd);

  console.log("等待 OpenCode 服务启动...");
  const started = await waitForService();
  if (!started) {
    throw new Error(
      `OpenCode 服务启动失败或超时。\n` +
        `请手动启动: OPENCODE_SERVER_PASSWORD=... opencode serve --hostname 127.0.0.1 --port ${OPENCODE_PORT}`,
    );
  }

  console.log("✅ OpenCode 服务已启动");
  logger.info("OpenCode service started successfully");
}

function parseModelRef(model: string): { providerID: string; id: string; variant?: string } | undefined {
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
  }));
}

async function resolveModelRef(model?: string): Promise<{ providerID: string; id: string; variant?: string } | undefined> {
  if (!model) return undefined;
  const direct = parseModelRef(model);
  if (direct) return direct;

  const models = await listModels();
  const hit = models.find((m) => m.id === model || m.modelID === model);
  if (!hit) return undefined;
  return { providerID: hit.providerID, id: hit.id };
}

export async function setSessionModel(sessionId: string, model: string): Promise<void> {
  const ref = await resolveModelRef(model);
  if (!ref) throw new Error(`未知模型: ${model}`);
  await api(`/api/session/${sessionId}/model`, {
    method: "POST",
    body: JSON.stringify({ model: ref }),
  });
}

export async function createSession(title: string, cwd?: string, model?: string): Promise<string> {
  logger.info("Creating OpenCode session", { title, cwd, model });
  const body: Record<string, unknown> = { title };
  if (cwd) body.location = { directory: cwd };
  if (OPENCODE_AGENT) body.agent = OPENCODE_AGENT;
  const ref = await resolveModelRef(model);
  if (ref) body.model = ref;

  const out = await api<{ data: { id: string } }>("/api/session", {
    method: "POST",
    body: JSON.stringify(body),
  });
  logger.info("Session created", { id: out.data.id });
  return out.data.id;
}

export async function listSessions(cwd?: string): Promise<
  Array<{ id: string; title: string; directory: string; time: { created: number; updated: number } }>
> {
  const params = new URLSearchParams({ limit: "50", order: "desc" });
  if (cwd) params.set("directory", cwd);

  const out = await api<{ data: any[] }>(`/api/session?${params.toString()}`);
  return (out.data || []).map((s) => ({
    id: s.id,
    title: s.title || s.id,
    directory: s.location?.directory || cwd || "",
    time: {
      created: s.time?.created ?? 0,
      updated: s.time?.updated ?? s.time?.created ?? 0,
    },
  }));
}

function writeImages(images?: QueryOptions["images"]): { files: Array<{ uri: string; name: string }>; cleanup: () => void } {
  if (!images?.length) return { files: [], cleanup: () => {} };

  const dir = mkdtempSync(join(tmpdir(), "wechat-opencode-"));
  const files: Array<{ uri: string; name: string }> = [];
  for (const [index, image] of images.entries()) {
    const ext = image.source.media_type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
    const name = `image-${index + 1}.${ext}`;
    const filePath = join(dir, name);
    writeFileSync(filePath, Buffer.from(image.source.data, "base64"));
    files.push({ uri: `file://${filePath}`, name });
  }

  return {
    files,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

async function listPendingPermissions(sessionId: string): Promise<PermissionRequest[]> {
  try {
    const out = await api<{ data: any[] }>(`/api/session/${sessionId}/permission`);
    return (out.data || []).map((p) => ({
      id: p.id,
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

function decideWithoutHuman(
  request: PermissionRequest,
  mode: QueryOptions["permissionMode"],
): PermissionDecision {
  if (mode === "auto") return "once";
  if (mode === "acceptEdits" && request.action === "edit") return "once";
  if (mode === "plan") return "reject";
  return "reject";
}

function extractAssistantText(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string" && part.text.trim())
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

async function waitForTurn(
  sessionId: string,
  since: number,
  options: QueryOptions,
): Promise<string> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  const handledPermissions = new Set<string>();

  while (Date.now() < deadline) {
    const pending = await listPendingPermissions(sessionId);
    for (const request of pending) {
      if (handledPermissions.has(request.id)) continue;
      handledPermissions.add(request.id);

      let decision: PermissionDecision;
      if (options.onPermission) {
        try {
          decision = await options.onPermission(request);
        } catch (err) {
          logger.warn("Permission handler failed, rejecting", { error: String(err), request });
          decision = "reject";
        }
      } else {
        decision = decideWithoutHuman(request, options.permissionMode);
      }

      try {
        await replyPermission(sessionId, request.id, decision);
        logger.info("Permission replied", { requestId: request.id, decision });
      } catch (err) {
        logger.warn("Failed to reply permission", { requestId: request.id, error: String(err) });
      }
    }

    const out = await api<{ data: any[] }>(`/api/session/${sessionId}/message?limit=100&order=desc`);
    const messages = out.data || [];

    const idle = messages.find((m) => m?.type === "idle" && (m?.time?.created ?? 0) >= since);
    if (idle) {
      if (idle.outcome === "failed") {
        const detail = idle.error ? JSON.stringify(idle.error).slice(0, 500) : "unknown error";
        throw new Error(`OpenCode 执行失败: ${detail}`);
      }
      if (idle.outcome === "interrupted") {
        throw new Error("OpenCode 执行被中断");
      }

      const assistants = messages
        .filter((m) => m?.type === "assistant" && (m?.time?.created ?? 0) >= since)
        .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));

      for (let i = assistants.length - 1; i >= 0; i--) {
        const text = extractAssistantText(assistants[i]);
        if (text) return text;
      }
      return "";
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("OpenCode 执行超时（30 分钟）");
}

export async function openCodeQuery(options: QueryOptions): Promise<QueryResult> {
  const { prompt, cwd, resume, model, images, title } = options;

  logger.info("Starting OpenCode query", {
    cwd,
    model,
    resume: Boolean(resume),
    hasImages: Boolean(images?.length),
    title,
  });

  const { files, cleanup } = writeImages(images);

  try {
    let sessionId = resume || "";
    if (sessionId) {
      // Sessions are bound to a location. If /cwd changed the working directory,
      // resume would silently keep operating in the old one — start a fresh
      // session at the new location instead.
      try {
        const info = await api<{ data: { location?: { directory?: string } } }>(`/api/session/${sessionId}`);
        const sessionDir = info?.data?.location?.directory;
        if (sessionDir && normalizeDir(sessionDir) !== normalizeDir(cwd)) {
          logger.info("Working directory changed, starting a new session", { sessionId, sessionDir, cwd });
          sessionId = "";
        }
      } catch {
        sessionId = "";
      }
    }
    if (!sessionId) {
      sessionId = await createSession(title || "微信: 会话", cwd, model);
    } else if (model) {
      await setSessionModel(sessionId, model);
    }
    options.onSession?.(sessionId);

    const body: Record<string, unknown> = { text: prompt, delivery: "queue" };
    if (files.length) body.files = files;

    const admitted = await api<{ data: { time?: { created?: number } } }>(
      `/api/session/${sessionId}/prompt`,
      { method: "POST", body: JSON.stringify(body) },
    );
    const since = admitted?.data?.time?.created ?? Date.now();

    const text = await waitForTurn(sessionId, since, options);

    logger.info("OpenCode query completed", { sessionId, textLength: text.length });
    return { text, sessionId };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("OpenCode query failed", {
      error: errorMessage,
      prompt: prompt?.substring(0, 100),
      cwd,
      resume: Boolean(resume),
      model,
    });
    return { text: "", sessionId: "", error: errorMessage };
  } finally {
    cleanup();
  }
}

export function getOpenCodeClient(): null {
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/\/+$/, "");
}
