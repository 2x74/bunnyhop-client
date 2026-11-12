// Regenerates src/voice_wire_vectors.json from the website's voice wire format (apps/web/src/net/voice-wire.ts):
//   bun apps/native/tools/voice-vectors.ts /path/to/bunnyhop
// The cases are the ones the website's tests use (apps/web/test/voice.test.ts) plus edge cases at the limits.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const web = Bun.argv[2];
if (!web) throw new Error("Pass the path of a bunnyhop web checkout that has apps/web/src/net/voice-wire.ts");
const wire = await import(resolve(web, "apps/web/src/net/voice-wire.ts"));

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const frame = (length: number, fill: number): Uint8Array => new Uint8Array(length).fill(fill);

const upCases = [
  { flags: wire.VF_START, seq: 0x1234, frames: [frame(61, 1), frame(58, 2)] },
  { flags: wire.VF_END, seq: 1, frames: [] },
  { flags: 0, seq: 9, frames: [frame(10, 7)] },
  { flags: wire.VF_START | wire.VF_END, seq: 0xffff, frames: [frame(1, 0), frame(255, 9), frame(3, 4)] },
  { flags: wire.VF_END, seq: 0, frames: [frame(60, 5)] },
];
const up = upCases.map((c) => {
  const bytes = wire.encodeVoiceUp(c);
  return {
    flags: c.flags,
    seq: c.seq,
    frames: c.frames.map(hex),
    up: hex(bytes),
    down: { slot: 7, bytes: hex(wire.voiceDownFrom(bytes, 7)) },
  };
});

const ok = wire.encodeVoiceUp({ flags: 0, seq: 9, frames: [frame(10, 7)] });
const mutate = (index: number, value: number): Uint8Array => {
  const copy = ok.slice();
  copy[index] = value;
  return copy;
};
const malformedUp = [
  mutate(1, 0x80),
  mutate(4, 4),
  mutate(5, 0),
  mutate(5, 11),
  new Uint8Array([...ok, 0]),
  new Uint8Array(wire.MAX_VOICE_UP_BYTES + 1).fill(wire.MSG_VOICE_UP),
  ok.subarray(0, 3),
  new Uint8Array([wire.MSG_VOICE_UP, 0, 1, 0, 0]),
  new Uint8Array([wire.MSG_VOICE_DOWN, 0, 0, 1, 0]),
];
for (const bytes of malformedUp)
  if (wire.decodeVoiceUp(bytes) !== null) throw new Error(`Expected malformed: ${hex(bytes)}`);
const malformedDown = [
  new Uint8Array([wire.MSG_VOICE_DOWN]),
  new Uint8Array([wire.MSG_VOICE_DOWN, 3, 0, 1, 0, 0]),
  new Uint8Array([...wire.voiceDownFrom(ok, 3), 0]),
  wire.voiceDownFrom(ok, 3).subarray(0, 6),
  ok,
];
for (const bytes of malformedDown)
  if (wire.decodeVoiceDown(bytes) !== null) throw new Error(`Expected malformed: ${hex(bytes)}`);

const seqPairs = [
  [1, 0],
  [0, 0xffff],
  [0xffff, 0],
  [5, 5],
  [0x8000, 0],
  [0x7fff, 0],
  [3, 0xfff0],
];
const vectors = {
  source: "apps/web/src/net/voice-wire.ts",
  constants: {
    voiceUp: wire.MSG_VOICE_UP,
    voiceDown: wire.MSG_VOICE_DOWN,
    start: wire.VF_START,
    end: wire.VF_END,
    frameSamples: wire.VOICE_FRAME_SAMPLES,
    bitrate: wire.VOICE_BITRATE,
    framesPerPacket: wire.VOICE_FRAMES_PER_PACKET,
    maxFrames: wire.MAX_VOICE_FRAMES,
    maxOpusFrame: wire.MAX_OPUS_FRAME,
    maxVoiceUpBytes: wire.MAX_VOICE_UP_BYTES,
    maxVoiceDownBytes: wire.MAX_VOICE_DOWN_BYTES,
  },
  up,
  malformedUp: malformedUp.map(hex),
  malformedDown: malformedDown.map(hex),
  seqAfter: seqPairs.map(([a, b]) => ({ a, b, after: wire.seqAfter(a, b) })),
};
const out = join(import.meta.dir, "../src/voice_wire_vectors.json");
writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n");
console.log(`Wrote ${out}`);
