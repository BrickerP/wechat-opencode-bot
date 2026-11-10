import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { WeChatApi } from './api.js';
import { uploadAndEncrypt } from './cdn.js';
import { MessageItemType, MessageType, MessageState, type MessageItem, type OutboundMessage } from './types.js';
import { logger } from '../logger.js';

export function createSender(api: WeChatApi, botAccountId: string) {
  let clientCounter = 0;

  function generateClientId(): string {
    return `wcc-${Date.now()}-${++clientCounter}`;
  }

  function outbound(toUserId: string, contextToken: string, clientId: string, item: MessageItem): OutboundMessage {
    return {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: [item],
    };
  }

  async function sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    const clientId = generateClientId();
    const item: MessageItem = { type: MessageItemType.TEXT, text_item: { text } };

    logger.info('Sending text message', { toUserId, clientId, textLength: text.length });
    await api.sendMessage({ msg: outbound(toUserId, contextToken, clientId, item) });
    logger.info('Text message sent', { toUserId, clientId });
  }

  /** Upload the file at path to the CDN, then send it as one image or file item. */
  async function sendMedia(toUserId: string, contextToken: string, path: string, kind: 'image' | 'file'): Promise<void> {
    const fileName = basename(path);
    const uploaded = await uploadAndEncrypt(await readFile(path), fileName, kind, { api, toUserId });
    // As iLink 1.0.3 clients send it: encrypt_type 1, and aes_key as base64 of the hex key.
    const media = { encrypt_query_param: uploaded.encryptQueryParam, aes_key: uploaded.aesKeyBase64, encrypt_type: 1 };
    const item: MessageItem =
      kind === 'image'
        ? { type: MessageItemType.IMAGE, image_item: { media, mid_size: uploaded.paddedSize } }
        : { type: MessageItemType.FILE, file_item: { media, file_name: fileName, len: String(uploaded.rawSize) } };
    const clientId = generateClientId();

    logger.info('Sending media message', { toUserId, clientId, kind, size: uploaded.rawSize });
    await api.sendMessage({ msg: outbound(toUserId, contextToken, clientId, item) });
    logger.info('Media message sent', { toUserId, clientId, kind });
  }

  const sendImage = (toUserId: string, contextToken: string, path: string) => sendMedia(toUserId, contextToken, path, 'image');
  const sendFile = (toUserId: string, contextToken: string, path: string) => sendMedia(toUserId, contextToken, path, 'file');

  return { sendText, sendImage, sendFile };
}
