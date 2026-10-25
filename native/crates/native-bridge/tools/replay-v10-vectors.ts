// Web encoder/decoder oracle consumed by the native replay regression test.
// Run: bun crates/native-bridge/tools/replay-v10-vectors.ts <fixture BSP sha256>
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  ReplayRecorder, countedYaw, decodeRaw, encodeRaw,
  YAW_SET_SPAWN, YAW_SET_TELEPORT, YAW_SET_PUSHER, YAW_SET_SENSITIVITY,
  YAW_SET_RAW, YAW_SET_TURN, YAW_WITH_TURN,
  type Replay,
} from "../../../apps/web/src/replay";
import { IN_LEFT, IN_RIGHT } from "../../../apps/web/src/turn-binds";

const sha = Bun.argv[2];
assert.match(sha, /^[0-9a-f]{64}$/);
const bits = (a: Float32Array) => Array.from(new Uint32Array(a.buffer, a.byteOffset, a.length));
const counts = [0.125, 1.625, -2.75, -2.75, 4.875, 0.375, -0.625, 9.125,
  9.125, 10.5, -12.25, 0.125, 0x3fffffff, -0x3fffffff, 1073741822.875, -1073741822.875];

function recording(stamina: boolean): Replay {
  const r = new ReplayRecorder(4);
  let base = 359.999;
  let k = 0.022;
  let epoch = 0;
  let kind = YAW_SET_SPAWN;
  for (let i = 0; i < counts.length; i++) {
    // Turns retain cumulative fractional mouse motion; other view sets and a
    // sensitivity change exercise the shared rebase layout and mixed provenance.
    if (i === 3 || i === 8) {
      base += i === 3 ? 210 / 128 : -210 / 128;
      kind = YAW_SET_TURN;
      epoch++;
    } else if (i === 5) {
      base = -720.25;
      kind = YAW_SET_TELEPORT | YAW_WITH_TURN;
      epoch++;
    } else if (i === 7) {
      base = 123.123456789;
      k = 0.0473;
      kind = YAW_SET_SENSITIVITY;
      epoch++;
    } else if (i === 10 || i === 11) {
      base = i === 10 ? 721.125 : 0.0;
      kind = i === 10 ? YAW_SET_PUSHER : YAW_SET_RAW;
      epoch++;
    }
    const look = { base, k, count: counts[i], epoch, kind,
      frames: i % 3, events: i === 4 ? 70000 : i * 127, reports: i === 6 ? 65535 : i * 500 };
    const buttons = (i === 3 ? IN_LEFT : i === 8 ? IN_RIGHT : 0) | (i % 2 ? 2 : 8) | (1 << 16);
    r.push(i % 2 ? 450 : -450, i % 3 ? 0 : 450,
      Math.fround(countedYaw(base, counts[i], k)), Math.fround(i / 7 - 1), buttons, look);
  }
  r.cosmetic = [{ tick: 3, kind: 1 }, { tick: 16, kind: 2 }];
  r.inspect = [{ tick: 1, kind: 3 }, { tick: 2, kind: 1 }, { tick: 15, kind: 4 }];
  return r.build({ map: "fixture", mapSha256: sha,
    settings: { tickInterval: 1 / 128, airAccelerate: 1000, accelerate: 5, friction: 4,
      stopSpeed: 75, gravity: 800, maxSpeed: 260, autohop: true, physics: 15, stamina },
    style: "autohop", timerRules: 2, prespeedCap: null, track: 0, zones: [],
    spawn: { position: [10, 20, 100], yaw: 45, targetname: "runner", classname: "player" },
    startTick: 0, endTick: 0, clientBuild: "web/v10-oracle", player: "fractional turns", recordedAt: 0 });
}

function vector(name: string, replay: Replay) {
  const raw = encodeRaw(replay);
  const decoded = decodeRaw(raw);
  assert.equal(decoded.header.version, 10);
  assert.ok(decoded.counted?.count instanceof Float64Array);
  assert.deepEqual(Array.from(decoded.counted.count), Array.from(replay.counted!.count));
  assert.deepEqual(decoded.counted.rebases, replay.counted!.rebases);
  assert.deepEqual(bits(decoded.yaw), bits(replay.yaw));
  for (const col of ["frames", "events", "reports"] as const)
    assert.deepEqual(decoded.counted[col], replay.counted![col]);
  assert.deepEqual(encodeRaw(decoded), raw);
  const core = encodeRaw({ ...replay, cosmetic: [], inspect: [], loadout: undefined });
  return { name, raw: Array.from(raw), gzip: Array.from(gzipSync(raw)), core: Array.from(core),
    commands: Array.from(replay.forward, (forward, i) => [forward, replay.side[i], replay.buttons[i], bits(replay.yaw)[i], bits(replay.pitch)[i]]),
    checkpoints: decoded.checkpoints, stamina: !!decoded.header.settings.stamina };
}

const replay = recording(false);
const withCheckpoints = { ...replay, checkpoints: [
  { tick: 0, position: [10, 20, 100], velocity: [0, 0, 0] },
  { tick: 16, position: [1.25, -2.5, 3.75], velocity: [4.125, 5.5, -6.25] },
] } satisfies Replay;
// Multiple bases on one tick are legal: the last one defines that tick's yaw.
const duplicate = structuredClone(replay);
duplicate.counted!.rebases.splice(1, 0, { tick: 0, kind: YAW_SET_RAW,
  base: replay.counted!.rebases[0].base, k: replay.counted!.rebases[0].k });
duplicate.counted!.rebases[0].base += 15; // Only the final base at tick 0 may affect yaw.
const empty = { ...replay, header: { ...replay.header, totalTicks: 0 },
  forward: new Int16Array(), side: new Int16Array(), buttons: new Uint32Array(),
  yaw: new Float32Array(), pitch: new Float32Array(), checkpoints: [], cosmetic: [], inspect: [],
  counted: { count: new Float64Array(), rebases: [], frames: new Uint16Array(), events: new Uint16Array(), reports: new Uint16Array() } };
const vectors = [vector("turns", replay), vector("stamina", recording(true)),
  vector("checkpoints", withCheckpoints), vector("duplicate-base", duplicate), vector("empty", empty)];

const malformed: { name: string; raw: number[]; error: string }[] = [];
function invalid(name: string, change: (r: Replay) => void, error: string, shared = true) {
  const copy = structuredClone(replay);
  change(copy);
  const raw = encodeRaw(copy);
  if (shared) assert.throws(() => decodeRaw(raw), name);
  malformed.push({ name, raw: Array.from(raw), error });
}
for (const count of [NaN, Infinity, -Infinity, 0x40000000, -0x40000000])
  invalid(`count-${count}`, r => r.counted!.count[2] = count, "bad fractional mouse count");
invalid("missing-base", r => r.counted!.rebases = [], "no initial base");
invalid("late-base", r => r.counted!.rebases[0].tick = 1, "no initial base");
invalid("outside-base", r => r.counted!.rebases.at(-1)!.tick = counts.length, "bad replay rebase");
invalid("nonfinite-base", r => r.counted!.rebases[0].base = Infinity, "bad replay rebase", false);
invalid("nonfinite-k", r => r.counted!.rebases[0].k = NaN, "bad replay rebase", false);
invalid("overflowed-yaw", r => { r.counted!.rebases[0].base = Number.MAX_VALUE; r.counted!.rebases[0].k = -Number.MAX_VALUE; }, "non-finite", false);
invalid("too-many-bases", r => r.counted!.rebases = Array.from({ length: counts.length * 2 + 2 }, () => ({ ...r.counted!.rebases[0] })), "rebase limit", false);
for (const [name, offset, value, error] of [
  ["missing-counted-flag", 6, 1, "require counted yaw"],
  ["unknown-version", 4, 11, "unsupported replay version"],
] as const) {
  const raw = encodeRaw(replay);
  raw[offset] = value;
  assert.throws(() => decodeRaw(raw));
  malformed.push({ name, raw: Array.from(raw), error });
}
const nOffset = 8 + 1 + Buffer.byteLength(replay.header.map) + 32 + 8 * 4 + 2 * 4;
for (const [name, n, error] of [
  ["command-limit", 2_000_001, "command limit"],
  ["impossible-command-body", 1_000_000, "truncated replay commands"],
] as const) {
  const raw = encodeRaw(replay);
  new DataView(raw.buffer, raw.byteOffset, raw.byteLength).setUint32(nOffset, n, true);
  malformed.push({ name, raw: Array.from(raw), error });
}
console.log(JSON.stringify({ vectors, malformed }));
