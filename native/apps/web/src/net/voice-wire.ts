// Voice chat wire format (push to talk, alltalk), carried as binary frames on the existing room WebSocket. DOM-free:
// the room (apps/api src/rooms/voice.ts) and the clients (web voice/, native) share it. Spec: docs/client/voice.md.
//
//   VOICE_UP   (client -> room)                     VOICE_DOWN (room -> listeners)
//   0  u8  0x10                                     0  u8  0x11
//   1  u8  flags (VF_START | VF_END)                1  u8  talker's roster slot
//   2  u16 seq, little endian, +1 per packet        2..    VOICE_UP bytes 1.. unchanged
//   4  u8  frame count n (0..MAX_VOICE_FRAMES; 0 only with VF_END)
//   5  n x (u8 len 1..MAX_OPUS_FRAME, len bytes: one 20 ms Opus packet, 48 kHz mono)
//
// The first byte never collides with the state / snapshot types (1, 2, 3), so an older client's decoder drops voice
// frames as unknown, and the room tells them apart before decoding state. Nothing here is ever stored.

export const MSG_VOICE_UP = 0x10;
export const MSG_VOICE_DOWN = 0x11;
/** First packet of a talk spurt (the key went down). */
export const VF_START = 1;
/** Last packet of a talk spurt (the key came up and the release tail was sent). */
export const VF_END = 2;
/** Opus frame length (ms) and the codec's fixed rate. */
export const VOICE_FRAME_MS = 20;
export const VOICE_SAMPLE_RATE = 48_000;
export const VOICE_FRAME_SAMPLES = (VOICE_SAMPLE_RATE * VOICE_FRAME_MS) / 1000;
/** Target encoder bitrate (bits/s), mono VBR. */
export const VOICE_BITRATE = 24_000;
/** Frames per packet the clients send: 2 x 20 ms = one message every 40 ms (25 per second while talking). */
export const VOICE_FRAMES_PER_PACKET = 2;
export const MAX_VOICE_FRAMES = 3;
/** One Opus packet's byte limit (24 kbps x 20 ms is ~60 bytes; a VBR peak stays far below this). */
export const MAX_OPUS_FRAME = 255;
export const VOICE_UP_HEADER = 5;
export const MAX_VOICE_UP_BYTES = VOICE_UP_HEADER + MAX_VOICE_FRAMES * (1 + MAX_OPUS_FRAME);
export const MAX_VOICE_DOWN_BYTES = MAX_VOICE_UP_BYTES + 1;

export interface VoicePacket {
  flags: number;
  seq: number;
  frames: Uint8Array[];
}

export interface VoiceDown extends VoicePacket {
  slot: number;
}

const u8 = (d: ArrayBuffer | Uint8Array) => (d instanceof Uint8Array ? d : new Uint8Array(d));

/** True if a binary frame is a voice packet from a client (the room checks this before decoding state). */
export const isVoiceUp = (d: ArrayBuffer | Uint8Array): boolean => d.byteLength > 0 && u8(d)[0] === MSG_VOICE_UP;
export const isVoiceDown = (d: ArrayBuffer | Uint8Array): boolean => d.byteLength > 0 && u8(d)[0] === MSG_VOICE_DOWN;

export function encodeVoiceUp(p: VoicePacket): Uint8Array<ArrayBuffer> {
  if (p.frames.length > MAX_VOICE_FRAMES || (!p.frames.length && !(p.flags & VF_END))) throw new RangeError("voice packet frame count");
  let len = VOICE_UP_HEADER;
  for (const f of p.frames) {
    if (f.length < 1 || f.length > MAX_OPUS_FRAME) throw new RangeError("voice frame size");
    len += 1 + f.length;
  }
  const out = new Uint8Array(len);
  out[0] = MSG_VOICE_UP;
  out[1] = p.flags & (VF_START | VF_END);
  out[2] = p.seq & 0xff;
  out[3] = (p.seq >>> 8) & 0xff;
  out[4] = p.frames.length;
  let o = VOICE_UP_HEADER;
  for (const f of p.frames) {
    out[o++] = f.length;
    out.set(f, o);
    o += f.length;
  }
  return out;
}

/** Parses a VOICE_UP or the body of a VOICE_DOWN (`at`: where the flags byte is). Strict: any stray byte is malformed. */
function parseBody(b: Uint8Array, at: number): VoicePacket | null {
  if (b.length < at + 4) return null;
  const flags = b[at];
  if (flags & ~(VF_START | VF_END)) return null;
  const seq = b[at + 1] | (b[at + 2] << 8);
  const n = b[at + 3];
  if (n > MAX_VOICE_FRAMES || (n === 0 && !(flags & VF_END))) return null;
  const frames: Uint8Array[] = [];
  let o = at + 4;
  for (let i = 0; i < n; i++) {
    if (o >= b.length) return null;
    const len = b[o++];
    if (len < 1 || o + len > b.length) return null;
    frames.push(b.subarray(o, o + len));
    o += len;
  }
  return o === b.length ? { flags, seq, frames } : null;
}

export function decodeVoiceUp(d: ArrayBuffer | Uint8Array): VoicePacket | null {
  const b = u8(d);
  if (b.length > MAX_VOICE_UP_BYTES || b[0] !== MSG_VOICE_UP) return null;
  return parseBody(b, 1);
}

/** The room's fan-out frame for a validated VOICE_UP: the same bytes behind the talker's slot (built once per packet). */
export function voiceDownFrom(up: ArrayBuffer | Uint8Array, slot: number): Uint8Array<ArrayBuffer> {
  const b = u8(up);
  const out = new Uint8Array(b.length + 1);
  out[0] = MSG_VOICE_DOWN;
  out[1] = slot & 0xff;
  out.set(b.subarray(1), 2);
  return out;
}

export function decodeVoiceDown(d: ArrayBuffer | Uint8Array): VoiceDown | null {
  const b = u8(d);
  if (b.length > MAX_VOICE_DOWN_BYTES || b.length < 2 || b[0] !== MSG_VOICE_DOWN) return null;
  const p = parseBody(b, 2);
  return p ? { ...p, slot: b[1] } : null;
}

/** seq a is after b (16-bit wrap). */
export const seqAfter = (a: number, b: number): boolean => ((a - b) & 0xffff) !== 0 && ((a - b) & 0xffff) < 0x8000;
