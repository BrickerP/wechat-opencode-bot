// Voice messages: WeChat's own transcription is the text as it comes; without one the audio comes from the CDN and
// goes to the OpenAI-compatible endpoint in OWB_ASR_URL. Every failure gives null.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test, type TestContext } from 'node:test';
import { encryptAesEcb } from '../wechat/crypto.js';
import { MessageItemType, type MessageItem, type VoiceItem } from '../wechat/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-voice-'));
// Logs follow HOME, state OWB_DATA_DIR: keep both away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
// The machine's own ASR settings stay out; each test sets what it needs.
const ASR_ENV = ['OWB_ASR_URL', 'OWB_ASR_MODEL', 'OWB_ASR_API_KEY'];
const savedEnv = ASR_ENV.map((name) => [name, process.env[name]] as const);
const clearAsrEnv = () => ASR_ENV.forEach((name) => delete process.env[name]);
clearAsrEnv();

/** What the fake endpoint got in a request: the path, the Authorization header and the multipart fields. */
interface Received {
  path?: string;
  auth?: string;
  model: unknown;
  name: string;
  type: string;
  audio: string;
}
const received: Received[] = [];
// The fake endpoint answers by path: /ok with a transcription, /fail with a 500, /garbage with a body that is not
// JSON and /empty with JSON that has no text.
const ANSWERS: Record<string, [number, string]> = {
  '/ok': [200, JSON.stringify({ text: ' 你好。 ' })],
  '/fail': [500, '{"error":"boom"}'],
  '/garbage': [200, '<html>'],
  '/empty': [200, '{}'],
};
const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = await new Response(Buffer.concat(chunks), {
      headers: { 'content-type': req.headers['content-type'] ?? '' },
    }).formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new Error('no file part');
    received.push({
      path: req.url,
      auth: req.headers.authorization,
      model: form.get('model'),
      name: file.name,
      type: file.type,
      audio: Buffer.from(await file.arrayBuffer()).toString('hex'),
    });
    const [status, body] = ANSWERS[req.url ?? ''] ?? [404, '{}'];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  } catch (err) {
    res.writeHead(400);
    res.end(String(err));
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const realFetch = globalThis.fetch;

const { extractVoiceText, transcribeAudio } = await import('../wechat/media.js');

afterEach(() => {
  clearAsrEnv();
  received.length = 0;
});

after(() => {
  for (const [name, value] of savedEnv) if (value !== undefined) process.env[name] = value;
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

const voice = (voiceItem: VoiceItem): MessageItem => ({ type: MessageItemType.VOICE, voice_item: voiceItem });
/** A CDN locator: the voice would be downloaded if the code went to the CDN. */
const locator = { encrypt_query_param: 'q', aes_key: randomBytes(16).toString('base64') };
/** The test's fetch fails every request; the mock counts them. */
const offline = (t: TestContext) =>
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('this test must not reach the network');
  });

test("WeChat's transcription is the text, with no download and no ASR call", async (t) => {
  process.env.OWB_ASR_URL = `${base}/ok`;
  const net = offline(t);
  assert.equal(await extractVoiceText(voice({ media: locator, text: ' 帮我跑一下测试 ' })), '帮我跑一下测试');
  assert.equal(await extractVoiceText(voice({ cdn_media: locator, voice_text: '看一下日志' })), '看一下日志');
  assert.equal(
    await extractVoiceText(voice({ media: locator, text: '', voice_text: '同意。' })),
    '同意',
    'an empty text falls back to voice_text, and the 。 an ASR ends on goes',
  );
  assert.equal(await extractVoiceText(voice({ media: locator, text: '这个函数是干嘛的？' })), '这个函数是干嘛的？', 'a question mark stays');
  assert.equal(net.mock.callCount(), 0);
});

test('an item without voice_item has no voice text', async () => {
  assert.equal(await extractVoiceText({ type: MessageItemType.TEXT, text_item: { text: 'hi' } }), null);
  assert.equal(await extractVoiceText({ type: MessageItemType.VOICE }), null);
});

test('without inline text and without OWB_ASR_URL nothing is downloaded or posted', async (t) => {
  const net = offline(t);
  assert.equal(await extractVoiceText(voice({ media: locator })), null);
  assert.equal(await transcribeAudio(Buffer.from('audio')), null);
  assert.equal(net.mock.callCount(), 0);
});

test('transcribeAudio posts the audio and the model as multipart and returns the text', async () => {
  // Bytes that are not UTF-8 and not SILK: sent as-is.
  const audio = Buffer.from([0xff, 0x00, 0x01, 0x02, 0x03, 0x04]);
  process.env.OWB_ASR_URL = `${base}/ok`;
  process.env.OWB_ASR_API_KEY = 'sk-test';
  assert.equal(await transcribeAudio(audio), '你好。');
  process.env.OWB_ASR_MODEL = 'FunAudioLLM/SenseVoiceSmall';
  delete process.env.OWB_ASR_API_KEY;
  assert.equal(await transcribeAudio(audio), '你好。');

  const sent = { path: '/ok', name: 'voice.bin', type: 'application/octet-stream', audio: audio.toString('hex') };
  assert.deepEqual(received, [
    { ...sent, auth: 'Bearer sk-test', model: 'whisper-1' },
    { ...sent, auth: undefined, model: 'FunAudioLLM/SenseVoiceSmall' },
  ]);
});

test('a SILK voice is decoded to WAV before it reaches the ASR endpoint', async () => {
  const { encode } = await import('silk-wasm');
  // One second of mono s16le silence at 24 kHz, the rate WeChat records.
  const pcm = Buffer.alloc(24_000 * 2);
  const silk = Buffer.from((await encode(pcm, 24_000)).data);
  assert.ok(silk.length > 0);

  process.env.OWB_ASR_URL = `${base}/ok`;
  assert.equal(await transcribeAudio(silk), '你好。');
  const sent = received.at(-1)!;
  assert.equal(sent.name, 'voice.wav');
  assert.equal(sent.type, 'audio/wav');
  assert.equal(sent.audio.slice(0, 8), '52494646', 'RIFF');
  assert.equal(sent.audio.slice(16, 24), '57415645', 'WAVE');
});

test('transcribeAudio returns null when the endpoint fails', async () => {
  for (const path of ['/fail', '/garbage', '/empty']) {
    process.env.OWB_ASR_URL = `${base}${path}`;
    assert.equal(await transcribeAudio(Buffer.from('audio')), null, path);
  }
  assert.equal(received.length, 3, 'each one was posted');
});

test('without inline text the voice comes decrypted from the CDN and goes to OWB_ASR_URL', async (t) => {
  process.env.OWB_ASR_URL = `${base}/ok`;
  const key = randomBytes(16);
  const audio = Buffer.from('#!SILK_V3 a voice message');
  const encrypted = encryptAesEcb(key, audio);
  const cdn: string[] = [];
  // The CDN answers here; the fake endpoint is reached through the real fetch.
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(base)) return realFetch(input, init);
    cdn.push(new URL(url).search);
    return new Response(encrypted);
  });

  const aes_key = key.toString('base64');
  assert.equal(await extractVoiceText(voice({ media: { encrypt_query_param: 'from-media', aes_key } })), '你好');
  assert.equal(await extractVoiceText(voice({ cdn_media: { encrypt_query_param: 'from-cdn-media', aes_key } })), '你好');
  assert.deepEqual(cdn, ['?from-media', '?from-cdn-media'], 'media first, cdn_media for older API versions');
  assert.deepEqual(
    received.map((request) => request.audio),
    [audio.toString('hex'), audio.toString('hex')],
    'the decrypted audio is posted',
  );
});
