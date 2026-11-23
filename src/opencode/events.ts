import { TextDecoder } from 'node:util';
import { logger } from '../logger.js';

/**
 * OpenCode's event stream (GET /api/event, Server-Sent Events) shows a session working long before a message
 * snapshot does: a part only appears in GET /api/session/:id/message once it has finished streaming, so three
 * minutes of reasoning used to look like three minutes of silence (task #33, 2026-11-22). The stream is volatile:
 * a slow consumer is cut off and events during a disconnection are lost, so it only adds to what polling sees.
 */

/** Events that mean the model has produced something for the session: the first-response watchdog waits for one. */
export const OUTPUT_EVENTS = [
  'session.reasoning.started',
  'session.reasoning.delta',
  'session.reasoning.ended',
  'session.text.started',
  'session.text.delta',
  'session.text.ended',
  'session.tool.input.started',
  'session.tool.input.delta',
  'session.tool.input.ended',
  'session.step.streamed',
  'session.step.ended',
] as const;

/**
 * Events that mean the session is working: its model's output, a step or a tool starting or ending, a shell
 * command. Not session.retry.scheduled: a provider OpenCode keeps retrying is the stall the fallback is for.
 */
export const ACTIVITY_EVENTS = [
  ...OUTPUT_EVENTS,
  'session.execution.started',
  'session.step.started',
  'session.tool.called',
  'session.tool.progress',
  'session.tool.success',
  'session.tool.failed',
  'session.shell.started',
  'session.shell.ended',
] as const;

const OUTPUT = new Set<string>(OUTPUT_EVENTS);
const ACTIVITY = new Set<string>(ACTIVITY_EVENTS);

/** A session quiet for this long is forgotten, so the maps cannot grow forever. */
const FORGET_MS = 60 * 60 * 1000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/** When each session last showed activity, and when its model last produced output, by local clock. */
const lastActivity = new Map<string, number>();
const lastOutput = new Map<string, number>();
let lastPrune = 0;

/** Records one event; anything without a progress type or a session id is ignored. */
export function recordEvent(event: unknown, at: number = Date.now()): void {
  const type = (event as { type?: unknown } | null)?.type;
  const sessionId = (event as { data?: { sessionID?: unknown } } | null)?.data?.sessionID;
  if (typeof type !== 'string' || typeof sessionId !== 'string' || !ACTIVITY.has(type)) return;
  lastActivity.set(sessionId, at);
  if (OUTPUT.has(type)) lastOutput.set(sessionId, at);
  if (at - lastPrune > FORGET_MS / 4) prune(at);
}

function prune(now: number): void {
  lastPrune = now;
  for (const map of [lastActivity, lastOutput]) {
    for (const [id, at] of map) if (now - at > FORGET_MS) map.delete(id);
  }
}

const latest = (map: Map<string, number>, ids: string[]): number | undefined => {
  let max: number | undefined;
  for (const id of ids) {
    const at = map.get(id);
    if (at !== undefined && (max === undefined || at > max)) max = at;
  }
  return max;
};

/** The latest activity of any of the sessions, or undefined when the stream showed none. */
export const lastActivityAt = (sessionIds: string[]): number | undefined => latest(lastActivity, sessionIds);

/** The latest model output of any of the sessions, or undefined when the stream showed none. */
export const lastOutputAt = (sessionIds: string[]): number | undefined => latest(lastOutput, sessionIds);

/** Tests only: forget every session. */
export function resetEventActivity(): void {
  lastActivity.clear();
  lastOutput.clear();
  lastPrune = 0;
}

/**
 * An incremental Server-Sent Events parser: feed it text as it arrives, in chunks of any size, and it calls
 * onData with the parsed JSON of each frame's data. Comments (": heartbeat"), other fields and bad JSON are skipped.
 */
export function createFrameParser(onData: (data: unknown) => void): (chunk: string) => void {
  let buffer = '';
  let data: string[] = [];
  const dispatch = (): void => {
    const text = data.join('\n');
    data = [];
    try {
      onData(JSON.parse(text));
    } catch {
      // A frame that is not JSON says nothing about progress.
    }
  };
  return (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (line === '') {
        if (data.length) dispatch();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  };
}

/** Whether the stream is up, and since when it has been in that state. */
export interface EventStreamState {
  connected: boolean;
  since: number;
}

export interface EventStream {
  state(): EventStreamState;
  /** Closes the stream and stops reconnecting. */
  stop(): void;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Follows the event stream at url and records each event (recordEvent), reconnecting after a drop with a backoff
 * from 1 s doubling to 30 s. Only a change of state is logged, so a server that keeps dropping cannot flood the log.
 * The server sends only the activity events. Never throws.
 */
export function createEventStream(url: string, headers: Record<string, string>): EventStream {
  const controller = new AbortController();
  let current: EventStreamState = { connected: false, since: Date.now() };
  /** Whether this outage was logged, so a stream that keeps failing to connect is logged once. */
  let warned = false;
  const query = ACTIVITY_EVENTS.map((type) => `types=${encodeURIComponent(type)}`).join('&');
  const setState = (connected: boolean, error?: unknown): void => {
    if (connected) {
      if (!current.connected) {
        current = { connected: true, since: Date.now() };
        logger.info('OpenCode event stream connected');
      }
      warned = false;
      return;
    }
    if (current.connected) current = { connected: false, since: Date.now() };
    if (!warned) {
      warned = true;
      logger.warn('OpenCode event stream unavailable; progress is judged from polling until it is back', { error: String(error) });
    }
  };

  async function follow(): Promise<void> {
    const res = await fetch(`${url}?${query}`, {
      headers: { Accept: 'text/event-stream', ...headers },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`GET /api/event -> HTTP ${res.status}`);
    setState(true);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parse = createFrameParser((event) => recordEvent(event));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parse(decoder.decode(value, { stream: true }));
    }
    throw new Error('the event stream ended');
  }

  void (async () => {
    for (let delay = RECONNECT_MIN_MS; !controller.signal.aborted; delay = Math.min(delay * 2, RECONNECT_MAX_MS)) {
      const opened = Date.now();
      try {
        await follow();
      } catch (err) {
        if (controller.signal.aborted) break;
        setState(false, err);
      }
      // A stream that stayed up for a while starts the backoff over.
      if (Date.now() - opened > RECONNECT_MAX_MS) delay = RECONNECT_MIN_MS / 2;
      await sleep(delay, controller.signal);
    }
  })();

  return {
    state: () => current,
    stop: () => controller.abort(),
  };
}
