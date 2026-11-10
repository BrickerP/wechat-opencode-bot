// Files and images back to WeChat: the upload to the iLink CDN, the image and file items that send them, the
// <<<WECHAT_FILES>>> section of the orchestrator's answer, the checks a listed path must pass, the v10 column that
// stores the accepted paths, and the deliver that sends them after the task's text.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, test } from 'node:test';
import {
  MessageState,
  MessageType,
  UploadMediaType,
  type GetUploadUrlReq,
  type GetUploadUrlResp,
  type SendMessageReq,
} from '../wechat/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-media-out-'));
// Logs follow HOME, state OWB_DATA_DIR: keep both away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');

const { uploadAndEncrypt } = await import('../wechat/cdn.js');
const { decryptAesEcb } = await import('../wechat/crypto.js');
const { ILinkError, WeChatApi } = await import('../wechat/api.js');
const { createSender } = await import('../wechat/send.js');
const { checkTaskFiles, parseOrchestratorOutput } = await import('../orchestrator.js');
const { createNotifier } = await import('../notify.js');
const { openStateDb } = await import('../tasks/db.js');

/** What the fake CDN got in an upload: the path with its query, the content type and the body. */
interface Upload {
  url: string;
  type?: string;
  body: Buffer;
}
const uploads: Upload[] = [];
let locators = 0;
// The fake CDN answers by path: /fail with a 500, /no-param without x-encrypted-param, any other with the next locator.
const cdn = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  uploads.push({ url: req.url ?? '', type: req.headers['content-type'], body: Buffer.concat(chunks) });
  const path = new URL(req.url ?? '/', 'http://cdn').pathname;
  if (path === '/fail') return void res.writeHead(500).end();
  res.writeHead(200, path === '/no-param' ? {} : { 'x-encrypted-param': `enc-${++locators}` }).end();
});
await new Promise<void>((resolve) => cdn.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;
const db = openStateDb(join(tmp, 'state.db'));

beforeEach(() => {
  uploads.length = 0;
  locators = 0;
});

after(() => {
  cdn.closeAllConnections();
  cdn.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A fake iLink that reserves every upload with `answer` and records what it got. */
function fakeApi(answer: GetUploadUrlResp = { upload_full_url: `${base}/full` }) {
  const reserved: GetUploadUrlReq[] = [];
  const sent: SendMessageReq[] = [];
  return {
    reserved,
    sent,
    async getUploadUrl(req: GetUploadUrlReq): Promise<GetUploadUrlResp> {
      reserved.push(req);
      return answer;
    },
    async sendMessage(req: SendMessageReq): Promise<void> {
      sent.push(req);
    },
  };
}

/** The ciphertext size the protocol names: PKCS7 always pads, by a whole block when the size is a multiple of 16. */
const padded = (size: number): number => Math.ceil((size + 1) / 16) * 16;
/** The plaintext of an upload, decrypted with the hex key its reservation carried. */
const decrypted = (req: GetUploadUrlReq, upload: Upload): Buffer => decryptAesEcb(Buffer.from(req.aeskey, 'hex'), upload.body);
/** The item's aes_key for a reservation: base64 of the key's 32 hex characters, not of its 16 bytes. */
const itemKey = (req: GetUploadUrlReq): string => Buffer.from(req.aeskey).toString('base64');

test('an upload reserves the file with getuploadurl, then posts it encrypted to the CDN, which names it', async () => {
  const file = randomBytes(37);
  const api = fakeApi({ upload_param: 'AbC+/==' });
  const uploaded = await uploadAndEncrypt(file, 'shot.png', 'image', { api, toUserId: 'wx-user', cdnBaseUrl: `${base}/c2c` });

  const { filekey, aeskey, ...rest } = api.reserved[0];
  assert.match(filekey, /^[0-9a-f]{32}$/);
  assert.match(aeskey, /^[0-9a-f]{32}$/);
  const md5 = createHash('md5').update(file).digest('hex');
  assert.deepEqual(rest, { media_type: 1, to_user_id: 'wx-user', rawsize: 37, rawfilemd5: md5, filesize: padded(37), no_need_thumb: true });
  assert.equal(padded(37), 48);
  const url = new URL(uploads[0].url, base);
  assert.equal(url.pathname, '/c2c/upload');
  assert.equal(url.searchParams.get('encrypted_query_param'), 'AbC+/==', 'encoded, so the + survives');
  assert.equal(url.searchParams.get('filekey'), filekey);
  assert.equal(uploads[0].type, 'application/octet-stream');
  assert.equal(uploads[0].body.length, 48);
  assert.deepEqual(decrypted(api.reserved[0], uploads[0]), file);
  assert.deepEqual(uploaded, { encryptQueryParam: 'enc-1', aesKeyBase64: itemKey(api.reserved[0]), paddedSize: 48, rawSize: 37 });
});

test('a file on a block boundary gains a whole padding block, and upload_full_url wins over upload_param', async () => {
  const file = randomBytes(32);
  const api = fakeApi({ upload_full_url: `${base}/full?k=v`, upload_param: 'unused' });
  const uploaded = await uploadAndEncrypt(file, 'report.pdf', 'file', { api, toUserId: 'wx-user', cdnBaseUrl: `${base}/c2c` });
  const [req] = api.reserved;
  assert.deepEqual([req.media_type, req.rawsize, req.filesize], [3, 32, padded(32)]);
  assert.equal(padded(32), 48);
  assert.equal(uploads[0].url, '/full?k=v');
  assert.deepEqual(decrypted(req, uploads[0]), file);
  assert.deepEqual([uploaded.paddedSize, uploaded.rawSize], [48, 32]);
});

test('an upload fails on a CDN error, on an answer without x-encrypted-param and when iLink names no URL', async () => {
  const upload = (answer: GetUploadUrlResp) =>
    uploadAndEncrypt(Buffer.from('x'), 'a.txt', 'file', { api: fakeApi(answer), toUserId: 'u', cdnBaseUrl: base });
  await assert.rejects(upload({ upload_full_url: `${base}/fail` }), /CDN upload failed: 500/);
  await assert.rejects(upload({ upload_full_url: `${base}/no-param` }), /no x-encrypted-param/);
  await assert.rejects(upload({}), /no upload URL/);
  assert.equal(uploads.length, 2, 'nothing is posted without a URL');
});

test('getUploadUrl posts to ilink/bot/getuploadurl, and a rejection in the body is an ILinkError', async (t) => {
  const calls: Array<[string, unknown]> = [];
  let answer: object = { ret: 0, upload_param: 'p' };
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push([String(url), JSON.parse(String(init?.body))]);
    return new Response(JSON.stringify(answer));
  });
  const api = new WeChatApi('token');
  const req: GetUploadUrlReq = {
    filekey: 'f'.repeat(32),
    media_type: UploadMediaType.FILE,
    to_user_id: 'u',
    rawsize: 1,
    rawfilemd5: 'm',
    filesize: 16,
    no_need_thumb: true,
    aeskey: 'a'.repeat(32),
  };
  assert.deepEqual(await api.getUploadUrl(req), answer);
  assert.deepEqual(calls, [['https://ilinkai.weixin.qq.com/ilink/bot/getuploadurl', req]]);
  answer = { ret: -14, errmsg: 'session timeout' };
  await assert.rejects(api.getUploadUrl(req), (err) => {
    assert.ok(err instanceof ILinkError);
    assert.deepEqual([err.code, err.message], [-14, 'getuploadurl failed: ret=-14 session timeout']);
    return true;
  });
});

test('sendImage and sendFile upload the file, then send one image or one file item that points at it', async () => {
  const dir = join(tmp, 'outgoing');
  mkdirSync(dir);
  const png = randomBytes(100);
  const pdf = randomBytes(50);
  writeFileSync(join(dir, 'shot.png'), png);
  writeFileSync(join(dir, 'report.pdf'), pdf);
  const api = fakeApi();
  const sender = createSender(api as any, 'bot-1');
  await sender.sendImage('wx-user', 'ctx', join(dir, 'shot.png'));
  await sender.sendFile('wx-user', 'ctx', join(dir, 'report.pdf'));

  const [image, file] = api.reserved;
  assert.deepEqual([image.media_type, image.rawsize, image.filesize], [1, 100, 112]);
  assert.deepEqual([file.media_type, file.rawsize, file.filesize], [3, 50, 64]);
  assert.deepEqual(decrypted(image, uploads[0]), png);
  assert.deepEqual(decrypted(file, uploads[1]), pdf);
  const [first, second] = api.sent.map(({ msg }) => msg);
  const envelope = {
    from_user_id: 'bot-1',
    to_user_id: 'wx-user',
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: 'ctx',
  };
  assert.deepEqual(first, {
    ...envelope,
    client_id: first.client_id,
    item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'enc-1', aes_key: itemKey(image), encrypt_type: 1 }, mid_size: 112 } }],
  });
  assert.deepEqual(second, {
    ...envelope,
    client_id: second.client_id,
    item_list: [
      { type: 4, file_item: { media: { encrypt_query_param: 'enc-2', aes_key: itemKey(file), encrypt_type: 1 }, file_name: 'report.pdf', len: '50' } },
    ],
  });
  assert.notEqual(first.client_id, second.client_id);
});

/** An answer with the four required sections, then rest. */
const answer = (rest = '') =>
  `<<<WECHAT_REPLY>>>\n图表做好了\n<<<WECHAT_MEMORY>>>\n- 无\n<<<WECHAT_SUMMARY>>>\n画了图表\n<<<WECHAT_HANDOFF>>>\nnext: 等反馈${rest}`;

test('the files section follows the handoff and runs to the end: one path per line, without bullets or backticks', () => {
  const out = parseOrchestratorOutput(answer('\n<<<WECHAT_FILES>>>\n/ws/chart.png\n\n  - `/ws/report.pdf`  \n/ws/chart.png\n'));
  assert.deepEqual([out.reply, out.summary, out.handoff], ['图表做好了', '画了图表', 'next: 等反馈'], 'the handoff ends at the marker');
  assert.deepEqual(out.files, ['/ws/chart.png', '/ws/report.pdf'], 'a repeated path counts once');
});

test('no files without the marker, or when the section is empty, "-" or "无"', () => {
  const plain = parseOrchestratorOutput(answer());
  assert.deepEqual([plain.handoff, plain.files], ['next: 等反馈', []]);
  for (const none of ['-', '无', '', '  ']) {
    assert.deepEqual(parseOrchestratorOutput(answer(`\n<<<WECHAT_FILES>>>\n${none}\n`)).files, [], JSON.stringify(none));
  }
});

test('a files marker the reply quotes is text: it cuts nothing short and sends nothing', () => {
  const quoted = '附件写在 <<<WECHAT_FILES>>> 后面\n/etc/passwd';
  const out = parseOrchestratorOutput(answer().replace('图表做好了', quoted));
  assert.deepEqual([out.reply, out.summary, out.handoff, out.files], [quoted, '画了图表', 'next: 等反馈', []]);
});

test('without a handoff the files section still ends the answer', () => {
  const out = parseOrchestratorOutput('<<<WECHAT_REPLY>>>\n好了\n<<<WECHAT_SUMMARY>>>\n发了图\n<<<WECHAT_FILES>>>\n/ws/a.png');
  assert.deepEqual([out.reply, out.summary, out.handoff, out.files], ['好了', '发了图', '', ['/ws/a.png']]);
});

test('checkTaskFiles keeps regular files inside the workspace and says why it drops each other path', () => {
  const ws = join(tmp, 'ws');
  const outside = join(tmp, 'outside');
  mkdirSync(join(ws, 'docs'), { recursive: true });
  mkdirSync(join(ws, 'dir.png'));
  mkdirSync(outside);
  for (const name of ['chart.png', 'docs/report.PDF', 'run.sh']) writeFileSync(join(ws, name), 'x');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(join(outside, 'secret.txt'), join(ws, 'link.txt'));
  symlinkSync(outside, join(ws, 'linked'));
  const accepted = [join(ws, 'chart.png'), join(ws, 'docs', 'report.PDF')];
  const rejected = [
    ['chart.png', 'not an absolute path'],
    [join(outside, 'secret.txt'), 'outside the workspace'],
    [`${ws}/docs/../../outside/secret.txt`, 'outside the workspace'],
    [join(ws, 'link.txt'), 'not a regular file'],
    [join(ws, 'linked', 'secret.txt'), 'outside the workspace'],
    [join(ws, 'run.sh'), 'type not allowed'],
    [join(ws, 'dir.png'), 'not a regular file'],
    [join(ws, 'missing.png'), 'not found'],
  ];
  const { files, dropped } = checkTaskFiles([accepted[0], ...rejected.map(([path]) => path), accepted[1]], ws);
  assert.deepEqual(files, accepted);
  assert.deepEqual(dropped.map(({ path, reason }) => [path, reason]), rejected);
});

test('a file over 20 MB is dropped, one of exactly 20 MB kept, and only the first 3 valid files go', () => {
  const ws = join(tmp, 'sizes');
  mkdirSync(ws);
  const path = (name: string): string => join(ws, name);
  for (const name of ['a.png', 'b.txt', 'c.csv']) writeFileSync(path(name), 'x');
  // Sparse, so the test writes no 20 MB.
  for (const [name, size] of [['max.zip', 20 * 1024 * 1024], ['big.zip', 20 * 1024 * 1024 + 1]] as const) {
    writeFileSync(path(name), '');
    truncateSync(path(name), size);
  }
  const { files, dropped } = checkTaskFiles(['big.zip', 'max.zip', 'a.png', 'b.txt', 'c.csv'].map(path), ws);
  assert.deepEqual(files, ['max.zip', 'a.png', 'b.txt'].map(path));
  assert.deepEqual(dropped, [
    { path: path('big.zip'), reason: 'over 20 MB' },
    { path: path('c.csv'), reason: 'more than 3' },
  ]);
});

test('a v9 database gains the files column and keeps its rows', () => {
  const v9 = join(tmp, 'v9.db');
  const { task } = openStateDb(v9).createTask('acc', 'old task');
  const old = new DatabaseSync(v9);
  old.exec('ALTER TABLE tasks DROP COLUMN files; PRAGMA user_version = 9;');
  const migrated = openStateDb(v9);
  const columns = old.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((c) => c.name);
  assert.ok(columns.includes('files'));
  assert.equal((old.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10);
  old.close();
  const row = migrated.getTask(task.id)!;
  assert.deepEqual([row.input, row.files], ['old task', null]);
});

test('finishTask stores the accepted paths as a JSON array, and an empty list as null', () => {
  const sent = db.startTaskNow('fin', '画图')!;
  assert.ok(db.finishTask(sent.id, 'done', { result: 'ok', files: ['/ws/a.png', '/ws/b.pdf'] }));
  assert.equal(db.getTask(sent.id)!.files, '["/ws/a.png","/ws/b.pdf"]');
  const bare = db.startTaskNow('fin', '你好')!;
  assert.ok(db.finishTask(bare.id, 'done', { result: 'ok', files: [] }));
  assert.equal(db.getTask(bare.id)!.files, null);
});

/** A sender that records what it sends: the text fails when textFails, a file when its path is in failing. */
function fakeSender({ failing = [] as string[], textFails = false } = {}) {
  const sent: string[] = [];
  const send = (kind: string) => async (_to: string, _token: string, value: string) => {
    if (kind === 'text' ? textFails : failing.includes(value)) throw new Error(`${kind} failed`);
    sent.push(`${kind}:${value}`);
  };
  return { sent, sender: { sendText: send('text'), sendImage: send('image'), sendFile: send('file') } };
}

/** Finish a task of the account that lists files, then deliver it as the daemon does. */
async function deliver(account: string, files: string[], sender: ReturnType<typeof fakeSender>['sender']): Promise<void> {
  db.saveContextToken(account, 'wx-user', 'ctx');
  const task = db.startTaskNow(account, '发文件')!;
  db.finishTask(task.id, 'done', { result: '文件在这', files });
  await createNotifier(db, {} as any, sender as any).taskIO(task, {} as any).deliver(db.getTask(task.id)!);
}

test('deliver sends the text, then each file as an image or a file; a failed one is skipped and never queued', async () => {
  const { sent, sender } = fakeSender({ failing: ['/ws/b.pdf'] });
  await deliver('deliver', ['/ws/a.png', '/ws/b.pdf', '/ws/c.csv'], sender);
  assert.deepEqual(sent, ['text:文件在这', 'image:/ws/a.png', 'file:/ws/c.csv']);
  assert.deepEqual(db.pendingNotices('deliver'), [], 'nothing waits in the outbox');
});

test('no file goes out while the text waits in the outbox', async () => {
  const { sent, sender } = fakeSender({ textFails: true });
  await deliver('pending', ['/ws/a.png'], sender);
  assert.deepEqual(sent, []);
  assert.deepEqual(db.pendingNotices('pending').map(({ text }) => text), ['文件在这'], 'only the text, for the next inbound message');
});
