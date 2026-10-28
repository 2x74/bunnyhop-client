// Differential test of native Rust through the C++ ABI runner against the actual web WASM.
// This is simulation parity, not a claim of renderer/UI/ranked-client feature parity.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  Core,
  DEFAULT_SETTINGS,
  EVENT_TELEPORTED,
  applyRestartPoint,
  isPhysicsVersion,
  type PlayerState,
  type Settings,
} from "../../web/src/core";

const root = resolve(import.meta.dir, "../../..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    map: { type: "string", multiple: true },
    runner: { type: "string" },
    wasm: { type: "string" },
    ticks: { type: "string", default: "2000" },
    replay: { type: "string" },
    report: { type: "string" },
    help: { type: "boolean" },
    physics: { type: "string" },
    "contrast-physics": { type: "string" },
    scratch: { type: "string" },
  },
});
if (values.help) {
  console.log(
    "bun apps/native/tools/parity.ts --map PATH.bsp [--map PATH.bsp ...] [--ticks 2000] [--replay FILE.bhr] [--report FILE.json]\n" +
      "  [--physics N]            simulate with physics N instead of the replay's/default version (same inputs)\n" +
      "  [--contrast-physics N]   replay only: also step the WASM at physics N on the identical command/velocity stream\n" +
      "                           and report where it diverges, showing the compared window exercises version-specific code\n" +
      "  [--scratch DIR]          fixture output directory (default target/native-parity)",
  );
  process.exit(0);
}
const maps = values.map?.map((resolveMap) => resolve(resolveMap)) ?? [];
if (!maps.length) throw new Error("At least one --map PATH.bsp is required.");
if (values.replay && maps.length !== 1) throw new Error("--replay requires exactly one --map.");
const ticks = Number(values.ticks);
if (!Number.isInteger(ticks) || ticks < 1 || ticks > 1_000_000)
  throw new Error("--ticks must be an integer in 1..1000000");
const runner = resolve(values.runner ?? join(root, "apps/native/build/bunnyhop-native-runner"));
const wasmPath = resolve(values.wasm ?? join(root, "apps/web/src/wasm/bunnyhop_core.wasm"));
if (!existsSync(runner)) throw new Error(`Build the C++ runner first: ${runner}`);
const wasm = readFileSync(wasmPath);
const wasmSha256 = new Bun.CryptoHasher("sha256").update(wasm).digest("hex");
const scratch = resolve(values.scratch ?? join(root, "target/native-parity"));
const parsePhysics = (name: string, v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!isPhysicsVersion(n)) throw new Error(`--${name} must be a physics version this code knows`);
  return n;
};
const physicsOverride = parsePhysics("physics", values.physics);
const contrastPhysics = parsePhysics("contrast-physics", values["contrast-physics"]);
if (contrastPhysics !== undefined && !values.replay) throw new Error("--contrast-physics requires --replay.");
mkdirSync(scratch, { recursive: true });
const float = new Float32Array(1);
const word = new Uint32Array(float.buffer);
function bits(x: number): number {
  float[0] = x;
  return word[0];
}
function fromBits(x: number): number {
  word[0] = x;
  return float[0];
}
const decimal = (x: number) => Math.fround(x).toPrecision(9);
const names = [
  "position.x",
  "position.y",
  "position.z",
  "velocity.x",
  "velocity.y",
  "velocity.z",
  "viewOffsetZ",
  "teleport.pitch",
  "teleport.yaw",
  "teleport.roll",
  "angleChange.pitch",
  "angleChange.yaw",
  "angleChange.roll",
  "touch.x",
  "touch.y",
  "touch.z",
];
interface Row {
  tick: number;
  bits: number[];
  flags: number[];
}
function row(state: PlayerState, events: number): Row {
  return {
    tick: state.tick,
    bits: [
      ...state.position,
      ...state.velocity,
      state.viewOffsetZ,
      ...state.teleportAngles,
      ...state.angleChange,
      ...(state.touchPosition ?? [NaN, NaN, NaN]),
    ].map(bits),
    flags: [+state.grounded, +state.crouched, +state.onLadder, events, +(state.touchCrouched ?? false)],
  };
}
const settingsLine = (s: Settings) =>
  `settings ${[s.tickInterval, s.airAccelerate, s.accelerate, s.friction, s.stopSpeed, s.gravity, s.maxSpeed]
    .map(decimal)
    .join(" ")} ${+s.autohop} ${s.physics ?? 1} ${+(s.stamina ?? false)}`;

// Match the existing native tool loader, including its CONTENT_CACHE_DIR override.
function cachedPhysics(map: string): [string, Uint8Array][] {
  const cache = process.env.CONTENT_CACHE_DIR ?? resolve(dirname(map), "../content-cache");
  const manifest = join(cache, "physics", basename(map, ".bsp") + ".txt");
  if (!existsSync(manifest)) return [];
  return readFileSync(manifest, "utf8")
    .split("\n")
    .flatMap((line) => {
      const [path, sha] = line.split("\t");
      if (!path || !sha) return [];
      const file = join(cache, "content", sha.trim());
      return existsSync(file) ? [[path, new Uint8Array(readFileSync(file))] as [string, Uint8Array]] : [];
    });
}

const reports: unknown[] = [];
let failed = false;
for (const map of maps) {
  const core = await Core.create(wasm);
  const physics = cachedPhysics(map);
  for (const [path, data] of physics) core.contentAddFile(path, data);
  const bsp = readFileSync(map);
  core.loadMap(bsp); // Match the native graphical load path, not a different stripped fixture.
  const missingPhysics = core.physicsMissing();
  const expected: Row[] = [];
  const lines: string[] = ["# native-parity-v1"];
  let settings = { ...DEFAULT_SETTINGS };
  let replayMeta: unknown = undefined;
  let contrastMeta: unknown = undefined;
  const capture = (events = 0) => {
    lines.push("state");
    expected.push(row(core.state(), events));
  };
  function command(forward: number, side: number, yaw: number, pitch: number, buttons: number): number {
    const f = [forward, side, yaw, pitch].map(Math.fround);
    lines.push(`cmd ${f.map(decimal).join(" ")} ${buttons >>> 0}`);
    return core.step(f[0], f[1], f[2], f[3], buttons >>> 0);
  }
  if (values.replay) {
    // Reuse the existing JS rules to prepare the exact stream supplied to both cores.
    // This deliberately does NOT certify a native implementation of timer/style rules.
    const { decodeReplay, replayStyle, replayTimerRules, replayPhysics } = await import("../../web/src/replay");
    const { StyleFilter, styleDef } = await import("../../web/src/styles");
    const { makeTimer, beforeStep, afterStep, replayCommand, setVelocity } = await import("../../web/src/sim");
    const replay = await decodeReplay(readFileSync(values.replay));
    const mapSha = new Bun.CryptoHasher("sha256").update(bsp).digest("hex");
    if (replay.header.mapSha256 !== mapSha) throw new Error("Replay BSP hash does not match --map.");
    settings = { ...replay.header.settings, physics: physicsOverride ?? replayPhysics(replay.header) };
    core.setSettings(settings);
    core.reset();
    // WASM-only lockstep core: same restart, commands and velocity writes, another physics version.
    const contrast = contrastPhysics === undefined ? null : await Core.create(wasm);
    const contrastRows: Row[] = [];
    if (contrast) {
      for (const [path, data] of physics) contrast.contentAddFile(path, data);
      contrast.loadMap(bsp);
      contrast.setSettings({ ...settings, physics: contrastPhysics! });
      contrast.reset();
      if (replay.header.spawn) applyRestartPoint(contrast, replay.header.spawn);
      contrastRows.push(row(contrast.state(), EVENT_TELEPORTED));
    }
    lines.push(settingsLine(settings), "reset");
    if (replay.header.spawn) {
      const p = replay.header.spawn;
      applyRestartPoint(core, p);
      lines.push(`position ${[...p.position, p.yaw].map(decimal).join(" ")}`);
      if (p.targetname || p.classname) {
        const quote = (s: string) => '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
        if (/[\r\n\0]/.test((p.targetname ?? "") + (p.classname ?? "")))
          throw new Error("Unsupported restart name in text protocol");
        lines.push(`names ${quote(p.targetname ?? "")} ${quote(p.classname ?? "")}`);
      }
    }
    const style = styleDef(replayStyle(replay.header));
    const filter = new StyleFilter(style, settings.physics);
    const timer = makeTimer(
      replay.header.zones,
      settings,
      replay.header.prespeedCap,
      style,
      replayTimerRules(replay.header),
    );
    timer.reset();
    capture(EVENT_TELEPORTED);
    const count = Math.min(ticks, replay.header.totalTicks);
    for (let i = 0; i < count; ++i) {
      const pre = core.state();
      const cmd = filter.apply(replayCommand(replay, i), pre);
      beforeStep(core, timer, cmd);
      const afterBefore = core.state();
      if (pre.velocity.some((v, j) => !Object.is(v, afterBefore.velocity[j]))) {
        lines.push(`velocity ${afterBefore.velocity.map(decimal).join(" ")}`);
        if (contrast) setVelocity(contrast, afterBefore.velocity.map(Math.fround));
      }
      const events = command(cmd.forward, cmd.side, cmd.yaw, cmd.pitch, cmd.buttons);
      const contrastEvents = contrast?.step(
        ...([cmd.forward, cmd.side, cmd.yaw, cmd.pitch].map(Math.fround) as [number, number, number, number]),
        cmd.buttons >>> 0,
      );
      const result = afterStep(core, timer, cmd, events);
      if (result.update.clampVelocity) {
        lines.push(`velocity ${result.state.velocity.map(decimal).join(" ")}`);
        if (contrast) setVelocity(contrast, result.state.velocity.map(Math.fround));
      }
      capture(events);
      if (contrast) contrastRows.push(row(contrast.state(), contrastEvents!));
    }
    if (contrast) {
      const same = (a: Row, b: Row) =>
        a.tick === b.tick && a.bits.every((x, j) => x === b.bits[j]) && a.flags.every((x, j) => x === b.flags[j]);
      const first = expected.findIndex((e, i) => !same(e, contrastRows[i]));
      contrastMeta = {
        physics: contrastPhysics,
        statesCompared: contrastRows.length,
        firstDivergentState: first < 0 ? null : first,
        firstDivergentTick: first < 0 ? null : expected[first].tick,
        divergentStates: expected.filter((e, i) => !same(e, contrastRows[i])).length,
        scope:
          "WASM-only, identical command and velocity stream; no divergence means the window does not exercise the difference",
      };
    }
    replayMeta = {
      file: resolve(values.replay),
      ticksCompared: count,
      totalTicks: replay.header.totalTicks,
      scope: "shared JS timer/style transforms; differential native/WASM simulation only",
    };
  } else {
    if (physicsOverride !== undefined) settings.physics = physicsOverride;
    core.setSettings(settings);
    core.reset();
    lines.push(settingsLine(settings), "reset");
    capture(EVENT_TELEPORTED);
    let yaw = core.state().teleportAngles[1];
    for (let i = 0; i < ticks; ++i) {
      const phase = i % 600;
      const side = phase >= 100 && phase < 500 ? (Math.floor(i / 37) % 2 ? -450 : 450) : 0;
      const forward = phase >= 50 && phase < 130 ? 450 : 0;
      if (side) yaw = (yaw - Math.sign(side) * 1.173 + 360) % 360;
      const jump = phase >= 100 && phase < 500;
      const duck = phase >= 300 && phase < 330;
      const buttons = (forward ? 8 : 0) | (side > 0 ? 1024 : side < 0 ? 512 : 0) | (jump ? 2 : 0) | (duck ? 4 : 0);
      const events = command(forward, side, yaw, phase >= 400 ? 17.3 : 0, buttons);
      capture(events);
      if (events & 1) yaw = core.state().teleportAngles[1];
      if (events & 16) yaw += core.state().angleChange[1];
    }
  }
  const fixture = join(scratch, basename(map) + ".commands");
  writeFileSync(fixture, lines.join("\n") + "\n");
  writeFileSync(fixture + ".expected.jsonl", expected.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const process = Bun.spawn([runner, "--map", map, "--commands", fixture], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exit !== 0) throw new Error(`Native runner exited ${exit}: ${stderr}`);
  writeFileSync(fixture + ".native.jsonl", stdout);
  const actual: Row[] = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const mismatches: unknown[] = [];
  let mismatchRows = 0;
  for (let i = 0; i < Math.max(actual.length, expected.length); ++i) {
    const a = actual[i],
      e = expected[i];
    if (!a || !e) {
      mismatchRows++;
      if (mismatches.length < 8) mismatches.push({ row: i, reason: "missing state" });
      continue;
    }
    const diff: unknown[] = [];
    for (let j = 0; j < e.bits.length; ++j) {
      const av = fromBits(a.bits[j]),
        ev = fromBits(e.bits[j]);
      // NaN payloads are not observable simulation values; distinguish all finite bits including signed zero.
      if (a.bits[j] !== e.bits[j] && !(Number.isNaN(av) && Number.isNaN(ev)))
        diff.push({ field: names[j], nativeBits: a.bits[j], wasmBits: e.bits[j], native: av, wasm: ev });
    }
    if (a.tick !== e.tick || a.flags.length !== e.flags.length || a.flags.some((f, j) => f !== e.flags[j]))
      diff.push({ field: "tick/flags", native: [a.tick, ...a.flags], wasm: [e.tick, ...e.flags] });
    if (diff.length) {
      mismatchRows++;
      if (mismatches.length < 8) mismatches.push({ row: i, tick: e.tick, differences: diff });
    }
  }
  const report = {
    map,
    mapSha256: new Bun.CryptoHasher("sha256").update(bsp).digest("hex"),
    wasmSha256,
    platform: `${globalThis.process.platform}/${processArch()}`,
    settings,
    comparedStates: expected.length,
    mismatchRows,
    pass: mismatchRows === 0,
    cachedPhysicsFiles: physics.length,
    missingPhysics,
    replay: replayMeta,
    contrast: contrastMeta,
    mismatches,
    commandFixture: fixture,
  };
  reports.push(report);
  console.log(JSON.stringify(report, null, 2));
  failed ||= mismatchRows !== 0;
}
if (values.report) {
  mkdirSync(dirname(resolve(values.report)), { recursive: true });
  writeFileSync(values.report, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2) + "\n");
}
process.exitCode = failed ? 1 : 0;
function processArch(): string {
  return globalThis.process.arch;
}
