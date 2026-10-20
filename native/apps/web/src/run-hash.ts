// Rolling hash of a run's recorded commands (anticheat v2 run sessions: apps/web/src/run-clock.ts sends it with each
// heartbeat, apps/api/src/run-clock.ts recomputes it from the submitted replay). FNV-1a 32 over each command's exact
// values, in order, from the timer's start tick: forward and sidemove (i16), buttons (u32: the same bytes as the u16
// it was before physics v7's weapon commands in bits 16..20), yaw and pitch (f32 bits).
// Shared, DOM-free and dependency-free so both sides fold the same bits. Not a secret and not a MAC: the server signs
// what the client claims at a wall-clock time; a later replay must contain exactly those commands.

export const RUN_HASH_SEED = 0x811c9dc5;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function word(h: number, w: number): number {
  for (let b = 0; b < 4; b++) {
    h ^= w & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
    w >>>= 8;
  }
  return h;
}

/** Folds one command into the hash. */
export function foldCommand(h: number, forward: number, side: number, buttons: number, yaw: number, pitch: number): number {
  h = word(h, (forward & 0xffff) | ((side & 0xffff) << 16));
  h = word(h, buttons >>> 0);
  f32[0] = yaw;
  h = word(h, u32[0]);
  f32[0] = pitch;
  return word(h, u32[0]) >>> 0;
}

/** Folds commands [from, to) of a replay's columns into `h`. */
export function foldRange(
  h: number,
  c: { forward: ArrayLike<number>; side: ArrayLike<number>; buttons: ArrayLike<number>; yaw: ArrayLike<number>; pitch: ArrayLike<number> },
  from: number,
  to: number,
): number {
  for (let i = from; i < to; i++) h = foldCommand(h, c.forward[i], c.side[i], c.buttons[i], c.yaw[i], c.pitch[i]);
  return h >>> 0;
}

/** The hash as sent: 8 hex digits. */
export const hashHex = (h: number) => (h >>> 0).toString(16).padStart(8, "0");
