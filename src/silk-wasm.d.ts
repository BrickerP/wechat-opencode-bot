declare module 'silk-wasm' {
  /** True when the buffer is a SILK stream (WeChat voice). */
  export function isSilk(data: ArrayBufferView | ArrayBuffer): boolean;
  /** Decode SILK to mono s16le PCM at the given sample rate. */
  export function decode(
    input: ArrayBufferView | ArrayBuffer,
    sampleRate: number,
  ): Promise<{ data: Uint8Array; duration: number }>;
  /** Encode WAV or mono s16le PCM at the given sample rate. Used by tests. */
  export function encode(
    input: ArrayBufferView | ArrayBuffer,
    sampleRate: number,
  ): Promise<{ data: Uint8Array; duration: number }>;
}
