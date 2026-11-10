import type {
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  SendMessageReq,
} from './types.js';
import { logger } from '../logger.js';

/** Generate a random uint32 and return its base64 representation. */
function generateUin(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const view = new DataView(buf.buffer);
  const uint32 = view.getUint32(0, false); // big-endian
  return Buffer.from(buf).toString('base64');
}

/** iLink answered with a non-zero ret/errcode. */
export class ILinkError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'ILinkError';
  }
}

/** The status fields every iLink answer carries. */
type ILinkResp = { ret?: number; errcode?: number; retmsg?: string; errmsg?: string };

/** iLink reports rejections (e.g. an expired context_token) in the body, as a non-zero ret or errcode. */
function assertOk(name: string, resp: ILinkResp | undefined): void {
  const code = resp?.ret ?? resp?.errcode;
  if (code !== undefined && code !== 0) {
    throw new ILinkError(code, `${name} failed: ret=${code} ${resp?.retmsg ?? resp?.errmsg ?? ''}`.trim());
  }
}

export class WeChatApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly uin: string;

  constructor(token: string, baseUrl: string = 'https://ilinkai.weixin.qq.com') {
    if (baseUrl) {
      try {
        const url = new URL(baseUrl);
        const allowedHosts = ['weixin.qq.com', 'wechat.com'];
        const isAllowed = allowedHosts.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
        if (url.protocol !== 'https:' || !isAllowed) {
          logger.warn('Untrusted baseUrl, using default', { baseUrl });
          baseUrl = 'https://ilinkai.weixin.qq.com';
        }
      } catch {
        logger.warn('Invalid baseUrl, using default', { baseUrl });
        baseUrl = 'https://ilinkai.weixin.qq.com';
      }
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.uin = generateUin();
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.token}`,
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': this.uin,
    };
  }

  private async request<T>(
    path: string,
    body: unknown,
    timeoutMs: number = 15_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${this.baseUrl}/${path}`;

    logger.debug('API request', { url, body });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      const json = (await res.json()) as T;
      logger.debug('API response', json);
      return json;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Long-poll for new messages. Timeout 35s for long-polling. */
  async getUpdates(buf?: string): Promise<GetUpdatesResp> {
    return this.request<GetUpdatesResp>(
      'ilink/bot/getupdates',
      buf ? { get_updates_buf: buf } : {},
      35_000,
    );
  }

  /** Send a message to a user. */
  async sendMessage(req: SendMessageReq): Promise<void> {
    assertOk('sendmessage', await this.request<ILinkResp>('ilink/bot/sendmessage', req));
  }

  /** Reserve a CDN upload for a file going to req.to_user_id. */
  async getUploadUrl(req: GetUploadUrlReq): Promise<GetUploadUrlResp> {
    const resp = await this.request<GetUploadUrlResp>('ilink/bot/getuploadurl', req);
    assertOk('getuploadurl', resp);
    return resp;
  }
}
