import { createHash, randomBytes } from "crypto";
import { decryptAesEcb, encryptAesEcb } from "./crypto.js";
import { logger } from "../logger.js";
import { CDN_BASE_URL } from "./accounts.js";
import type { WeChatApi } from "./api.js";
import { UploadMediaType } from "./types.js";

/** Long enough for a 20 MB file on a slow uplink. */
const UPLOAD_TIMEOUT_MS = 120_000;

export function buildCdnDownloadUrl(encryptQueryParam: string): string {
  if (!/^[A-Za-z0-9%=&+._~-]+$/.test(encryptQueryParam)) {
    throw new Error('Invalid CDN query parameter');
  }
  return `${CDN_BASE_URL}?${encryptQueryParam}`;
}

export async function downloadAndDecrypt(
  encryptQueryParam: string,
  aesKeyBase64: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptQueryParam);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`CDN download failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`CDN download failed: ${response.status} ${response.statusText}`);
  }

  const encrypted = Buffer.from(await response.arrayBuffer());

  // Handle both formats:
  // 1. base64-of-raw-16-bytes (16 raw bytes encoded as base64)
  // 2. base64-of-hex-string (32 hex chars encoded as base64)
  let aesKey: Buffer;
  const raw = Buffer.from(aesKeyBase64, "base64");

  if (raw.length === 16) {
    // base64-of-raw-16-bytes
    aesKey = raw;
  } else {
    // base64-of-hex-string: decode the string as hex to get the 16-byte key
    const hexStr = raw.toString("utf-8");
    aesKey = Buffer.from(hexStr, "hex");
  }

  const decrypted = decryptAesEcb(aesKey, encrypted);
  logger.info("CDN download and decrypt succeeded", { size: decrypted.length });

  return decrypted;
}

/** A file on the CDN, as the image or file item that sends it names it. */
export interface UploadedMedia {
  /** The item's encrypt_query_param: what the CDN answered in x-encrypted-param. */
  encryptQueryParam: string;
  /** The item's aes_key: base64 of the key's 32 hex characters, not of its 16 bytes. */
  aesKeyBase64: string;
  /** Ciphertext size: PKCS7 pads to the next 16-byte block, a whole block when the file already ends on one. */
  paddedSize: number;
  rawSize: number;
}

export interface UploadDeps {
  api: Pick<WeChatApi, "getUploadUrl">;
  /** The user the file goes to: getuploadurl reserves the upload for them. */
  toUserId: string;
  /** Where upload_param goes when getuploadurl names no upload_full_url; CDN_BASE_URL by default. */
  cdnBaseUrl?: string;
}

/**
 * Encrypt a file with a fresh AES-128-ECB key and upload it: getuploadurl reserves the upload, the ciphertext is
 * POSTed to the URL it names, and the CDN answers with the file's locator in x-encrypted-param.
 */
export async function uploadAndEncrypt(
  file: Buffer,
  fileName: string,
  kind: "image" | "file",
  deps: UploadDeps,
): Promise<UploadedMedia> {
  const key = randomBytes(16);
  const aesKeyHex = key.toString("hex");
  const filekey = randomBytes(16).toString("hex");
  const encrypted = encryptAesEcb(key, file);
  const { upload_full_url, upload_param } = await deps.api.getUploadUrl({
    filekey,
    media_type: kind === "image" ? UploadMediaType.IMAGE : UploadMediaType.FILE,
    to_user_id: deps.toUserId,
    rawsize: file.length,
    rawfilemd5: createHash("md5").update(file).digest("hex"),
    filesize: encrypted.length,
    no_need_thumb: true,
    aeskey: aesKeyHex,
  });
  const base = deps.cdnBaseUrl ?? CDN_BASE_URL;
  const url =
    upload_full_url ||
    (upload_param && `${base}/upload?encrypted_query_param=${encodeURIComponent(upload_param)}&filekey=${filekey}`);
  if (!url) throw new Error("getuploadurl returned no upload URL");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: encrypted,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`CDN upload failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    throw new Error(`CDN upload failed: ${response.status} ${response.statusText}`);
  }
  const encryptQueryParam = response.headers.get("x-encrypted-param");
  if (!encryptQueryParam) throw new Error("CDN upload failed: no x-encrypted-param in the answer");

  logger.info("CDN upload succeeded", { fileName, kind, size: file.length });
  return {
    encryptQueryParam,
    aesKeyBase64: Buffer.from(aesKeyHex).toString("base64"),
    paddedSize: encrypted.length,
    rawSize: file.length,
  };
}
