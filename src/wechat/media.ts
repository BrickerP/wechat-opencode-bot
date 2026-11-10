import type { MessageItem, ImageItem, VoiceItem } from './types.js';
import { MessageItemType } from './types.js';
import { downloadAndDecrypt } from './cdn.js';
import { logger } from '../logger.js';

/** Long enough for a minute of speech; the messages after a voice message wait for it. */
const ASR_TIMEOUT_MS = 30_000;
/** Marks a transcription ends on. They would keep a spoken "同意" from answering a permission request; question marks stay. */
const TRAILING_MARKS = /[。．.！!，,\s]+$/u;

function detectMimeType(data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xFF && data[1] === 0xD8) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49) return 'image/webp';
  if (data[0] === 0x42 && data[1] === 0x4D) return 'image/bmp';
  return 'image/jpeg'; // fallback
}

/**
 * Extract AES key and encrypt_query_param from an ImageItem,
 * supporting both the old cdn_media format and the newer flat format.
 */
function getImageCdnData(imageItem: ImageItem): { aesKey: string; encryptQueryParam: string } | null {
  // Old format: cdn_media.aes_key + cdn_media.encrypt_query_param
  if (imageItem.cdn_media?.aes_key && imageItem.cdn_media?.encrypt_query_param) {
    return {
      aesKey: imageItem.cdn_media.aes_key,
      encryptQueryParam: imageItem.cdn_media.encrypt_query_param,
    };
  }

  // New format: aeskey + media.encrypt_query_param
  if (imageItem.aeskey && imageItem.media?.encrypt_query_param) {
    return {
      aesKey: imageItem.aeskey,
      encryptQueryParam: imageItem.media.encrypt_query_param,
    };
  }

  logger.warn('Image item has no usable CDN data', {
    hasCdnMedia: !!imageItem.cdn_media,
    hasAeskey: !!imageItem.aeskey,
    hasMedia: !!imageItem.media,
  });
  return null;
}

/**
 * Download a CDN image, decrypt it, and return a base64 data URI.
 * Returns null on failure.
 */
export async function downloadImage(item: MessageItem): Promise<string | null> {
  const imageItem = item.image_item;
  if (!imageItem) {
    return null;
  }

  const cdnData = getImageCdnData(imageItem);
  if (!cdnData) {
    return null;
  }

  try {
    const decrypted = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey);
    const mimeType = detectMimeType(decrypted);
    const base64 = decrypted.toString('base64');
    const dataUri = `data:${mimeType};base64,${base64}`;
    logger.info('Image downloaded and decrypted', { size: decrypted.length });
    return dataUri;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download image', { error: msg });
    return null;
  }
}

/**
 * The CDN locator of a voice item: newer API versions put it in media, older ones in cdn_media.
 */
function getVoiceCdnData(voiceItem: VoiceItem): { aesKey: string; encryptQueryParam: string } | null {
  for (const media of [voiceItem.media, voiceItem.cdn_media]) {
    if (media?.aes_key && media.encrypt_query_param) {
      return { aesKey: media.aes_key, encryptQueryParam: media.encrypt_query_param };
    }
  }

  logger.warn('Voice item has no usable CDN data', {
    hasCdnMedia: !!voiceItem.cdn_media,
    hasMedia: !!voiceItem.media,
  });
  return null;
}

/**
 * Download a CDN voice message and decrypt it. The audio stays as WeChat recorded it, usually SILK.
 * Returns null on failure.
 */
export async function downloadVoice(item: MessageItem): Promise<Buffer | null> {
  const voiceItem = item.voice_item;
  if (!voiceItem) {
    return null;
  }

  const cdnData = getVoiceCdnData(voiceItem);
  if (!cdnData) {
    return null;
  }

  try {
    const audio = await downloadAndDecrypt(cdnData.encryptQueryParam, cdnData.aesKey);
    logger.info('Voice downloaded and decrypted', { size: audio.length });
    return audio;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download voice', { error: msg });
    return null;
  }
}

/** The OpenAI-compatible transcription endpoint, such as https://api.openai.com/v1/audio/transcriptions. Empty turns transcription off. */
export function asrUrl(): string {
  return process.env.OWB_ASR_URL?.trim() ?? '';
}

/** Wrap mono s16le PCM in a WAV header: most ASR endpoints take WAV, not raw PCM. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** WeChat records SILK; decode it to WAV for ASR. Other formats pass through. */
async function asrAudio(audio: Buffer): Promise<{ data: Buffer; name: string; type: string }> {
  try {
    const { isSilk, decode } = await import('silk-wasm');
    if (isSilk(audio)) {
      const { data } = await decode(audio, 24_000);
      return { data: pcmToWav(Buffer.from(data), 24_000), name: 'voice.wav', type: 'audio/wav' };
    }
  } catch (err) {
    logger.warn('SILK decode failed', { error: String(err) });
  }
  return { data: audio, name: 'voice.bin', type: 'application/octet-stream' };
}

/**
 * Transcribe audio through OWB_ASR_URL: a multipart POST of the file and OWB_ASR_MODEL, answered with
 * { text }. The settings are read at call time. Returns null without OWB_ASR_URL and on any failure.
 */
export async function transcribeAudio(audio: Buffer): Promise<string | null> {
  const url = asrUrl();
  if (!url) {
    return null;
  }

  const { data, name, type } = await asrAudio(audio);
  const form = new FormData();
  form.append('file', new Blob([data], { type }), name);
  form.append('model', process.env.OWB_ASR_MODEL?.trim() || 'whisper-1');
  const apiKey = process.env.OWB_ASR_API_KEY?.trim();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      body: form,
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      logger.warn('Voice transcription failed', { status: response.status, body });
      return null;
    }
    const { text } = (await response.json()) as { text?: unknown };
    if (typeof text !== 'string' || !text.trim()) {
      logger.warn('Voice transcription returned no text');
      return null;
    }
    logger.info('Voice transcribed', { size: audio.length, length: text.trim().length });
    return text.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Voice transcription failed', { error: msg });
    return null;
  }
}

/** A transcription without the marks it ends on; null if nothing else is left. */
function spoken(text: string): string | null {
  return text.replace(TRAILING_MARKS, '') || null;
}

/**
 * The text of a voice item: WeChat's own transcription when the item carries one, otherwise the
 * audio downloaded and sent to transcribeAudio. Without OWB_ASR_URL nothing is downloaded.
 * Returns null when there is no voice item or no text.
 */
export async function extractVoiceText(item: MessageItem): Promise<string | null> {
  const voiceItem = item.voice_item;
  if (!voiceItem) {
    return null;
  }

  const inline = voiceItem.text?.trim() || voiceItem.voice_text?.trim();
  if (inline) {
    return spoken(inline);
  }
  if (!asrUrl()) {
    return null;
  }

  const audio = await downloadVoice(item);
  const text = audio ? await transcribeAudio(audio) : null;
  return text ? spoken(text) : null;
}

/**
 * Extract text content from a message item.
 * Returns text_item.text or empty string.
 */
export function extractText(item: MessageItem): string {
  return item.text_item?.text ?? '';
}

/**
 * Find the first IMAGE type item in a list.
 */
export function extractFirstImageUrl(items?: MessageItem[]): MessageItem | undefined {
  return items?.find((item) => item.type === MessageItemType.IMAGE);
}
