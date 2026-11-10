// WeChat Work (企业微信) protocol type definitions
// Extracted from the ClawBot WeChat plugin API

// ── Enums ──────────────────────────────────────────────────────────────────

export enum MessageType {
  USER = 1,
  BOT = 2,
}

export enum MessageItemType {
  TEXT = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE = 4,
  VIDEO = 5,
}

export enum MessageState {
  NEW = 0,
  GENERATING = 1,
  FINISH = 2,
}

// ── Media ──────────────────────────────────────────────────────────────────

export interface CDNMedia {
  aes_key: string;
  encrypt_query_param: string;
  cdn_url?: string;
  encrypt_type?: number;
}

/** Where newer API versions put the CDN locator of a media item. */
export interface MediaLocator {
  encrypt_query_param: string;
  aes_key?: string;
  encrypt_type?: number;
}

/** media_type of getuploadurl, which is not the MessageItemType of the item that sends the file. */
export enum UploadMediaType {
  IMAGE = 1,
  FILE = 3,
}

// ── Message Items ───────────────────────────────────────────────────────────

export interface TextItem {
  text: string;
}

export interface ImageItem {
  cdn_media?: CDNMedia;
  /** Alternative field name used by some API versions */
  aeskey?: string;
  media?: MediaLocator;
  url?: string;
  /** A sent image gives its ciphertext size here. */
  mid_size?: number;
  hd_size?: number;
}

export interface VoiceItem {
  cdn_media?: CDNMedia;
  media?: MediaLocator;
  /** WeChat's own transcription; some API versions name it voice_text */
  text?: string;
  voice_text?: string;
}

export interface FileItem {
  cdn_media?: CDNMedia;
  media?: MediaLocator;
  file_name?: string;
  /** Size of the file before encryption, as a decimal string. */
  len?: string;
}

export interface VideoItem {
  cdn_media: CDNMedia;
}

export interface MessageItem {
  type: MessageItemType;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

// ── Weixin Message ──────────────────────────────────────────────────────────

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  message_type?: MessageType;
  message_state?: MessageState;
  item_list?: MessageItem[];
  context_token?: string;
}

// ── GetUpdates API ──────────────────────────────────────────────────────────

export interface GetUpdatesReq {
  get_updates_buf?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  retmsg?: string;
  sync_buf: string;
  get_updates_buf: string;
  msgs?: WeixinMessage[];
}

// ── SendMessage API ─────────────────────────────────────────────────────────

export interface OutboundMessage {
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  message_type: MessageType;
  message_state: MessageState;
  context_token: string;
  item_list: MessageItem[];
}

export interface SendMessageReq {
  msg: OutboundMessage;
}

// ── GetUploadUrl API ────────────────────────────────────────────────────────

export interface GetUploadUrlReq {
  /** 32 hex characters naming the upload. */
  filekey: string;
  media_type: UploadMediaType;
  to_user_id: string;
  rawsize: number;
  /** MD5 of the file before encryption, in hex. */
  rawfilemd5: string;
  /** Size of the AES-128-ECB ciphertext. */
  filesize: number;
  no_need_thumb: boolean;
  /** The AES key as 32 hex characters. */
  aeskey: string;
}

export interface GetUploadUrlResp {
  ret?: number;
  errcode?: number;
  retmsg?: string;
  errmsg?: string;
  /** The whole upload URL; when it is missing, upload_param goes to the CDN's /upload. */
  upload_full_url?: string;
  upload_param?: string;
}
