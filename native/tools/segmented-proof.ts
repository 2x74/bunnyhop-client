// Offline native → website encoder/verifier proof, including abandoned checkpoint branches.
//
//   bun tools/segmented-proof.ts --wasm VERIFIER.wasm --website ../bunnyhop --commit SHA --maps DIR --output DIR
//
// --commit is the website commit the WASM was built from (default: the v0.0.30 release). Its unpatched source decodes
// and verifies the replays; this checkout's vendored copy plays the website side of each session.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs, isDeepStrictEqual } from "node:util";
import {
  Core,
  applyRestartPoint,
  restartPoint,
  snapshotState,
  restoreState,
  freeState,
  type RestartPoint,
} from "../apps/web/src/core";
import { ReplayRecorder, encodeRaw, type LookSample } from "../apps/web/src/replay";
import { beforeStep, afterStep, makeTimer, quantize } from "../apps/web/src/sim";
import { styleSettings, styleDef, stylePrespeedCap } from "../apps/web/src/styles";
import { SegmentLog, type SegmentMark } from "../apps/web/src/practice-mode/segments";
import { saveTimer, loadTimer, type TimerSnapshot } from "../apps/web/src/practice-mode/checkpoints";
import type { Zone } from "../apps/web/src/zones";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    maps: { type: "string" },
    wasm: { type: "string" },
    output: { type: "string" },
    website: { type: "string" },
    commit: { type: "string", default: "56bc58e0ee77da327961253835fbaf864cf95e49" },
    only: { type: "string" },
  },
});
if (!values.maps || !values.wasm || !values.output || !values.website) {
  throw new Error("--wasm VERIFIER.wasm --website WEBSITE_REPO [--commit SHA] --maps DIR --output DIR [--only MAP]");
}
const root = resolve(import.meta.dir, "..");
const websiteCommit = values.commit!;
const output = resolve(values.output);
mkdirSync(output, { recursive: true });
const wasm = readFileSync(values.wasm);
const wasmSha = new Bun.CryptoHasher("sha256").update(wasm).digest("hex");
console.log(JSON.stringify({ wasm: resolve(values.wasm), wasmSha, websiteCommit }));
const driverBuild = Bun.spawnSync(
  ["cargo", "build", "--locked", "-p", "bunnyhop-native-bridge", "--bin", "segmented-proof"],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (driverBuild.exitCode) throw new Error("building the native segmented-proof driver failed");
// The website at the release commit, unpatched: it supplies the bot and decodes and verifies every replay below.
const website = join(output, "website");
mkdirSync(website, { recursive: true });
const archive = Bun.spawnSync(
  ["git", "-C", resolve(values.website), "archive", websiteCommit, "apps/web/src", "tools/verify/bot.ts"],
  { stdout: "pipe", stderr: "pipe" },
);
if (archive.exitCode) throw new Error(archive.stderr.toString());
const untar = Bun.spawnSync(["tar", "-x", "-C", website], { stdin: archive.stdout, stderr: "pipe" });
if (untar.exitCode) throw new Error(untar.stderr.toString());
const { botCommand } = (await import(join(website, "tools/verify/bot.ts"))) as {
  botCommand: (tick: number) => [number, number, number, number, number];
};
const pristine = {
  core: (await import(join(website, "apps/web/src/core.ts"))) as typeof import("../apps/web/src/core"),
  replay: (await import(join(website, "apps/web/src/replay.ts"))) as typeof import("../apps/web/src/replay"),
  verifier: (await import(join(website, "apps/web/src/verifier.ts"))) as typeof import("../apps/web/src/verifier"),
};
const settings = styleSettings("segmented");
type Command = [number, number, number, number, number];
type Action =
  | { command: Command; look: LookSample }
  | { save: true }
  | { load: number }
  | { cosmetic: number }
  | { inspect: number };
const bits = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0];
const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};
const keyed = (tick: number): Command => {
  const c = botCommand(tick);
  c[4] |= c[1] < 0 ? 1 << 9 : c[1] > 0 ? 1 << 10 : 0;
  const yaw = Math.round(c[2] * 64) / 64;
  c[2] = yaw < 0 ? yaw + 360 : yaw;
  return c;
};
const wander = (i: number): Command => [
  -450,
  i % 30 < 15 ? 450 : -450,
  (i * 7) % 360,
  0,
  (1 << 4) | (i % 50 < 10 ? 4 : 0) | (i % 30 < 15 ? 1 << 10 : 1 << 9),
];
// Maps without a fixed spawn start in their main start zone.
const cases: { map: string; spawn?: RestartPoint }[] = [
  { map: "bhop_eazy", spawn: { position: [560, -352, 70], yaw: 0 } },
  { map: "bhop_areaportal_v1", spawn: { position: [10962, -9454, -423.96], yaw: 0 } },
  { map: "bhop_treason", spawn: { position: [8416, 4096, 7820], yaw: 0 } },
  { map: "bhop_ceaseless" },
  { map: "bhop_profane" },
  { map: "bhop_rpg" },
];
// Just above the floor of the map's main start zone.
const startZonePoint = (map: string): RestartPoint => {
  const file = JSON.parse(readFileSync(join(resolve(values.maps!), map + ".zones.json"), "utf8")) as {
    zones: (Zone & { track?: number })[];
  };
  const zone = file.zones.find((z) => z.kind === "start" && !z.track);
  assert(zone, map + " has no main start zone");
  const middle = (axis: number) => (zone.mins[axis] + zone.maxs[axis]) / 2;
  return { position: [middle(0), middle(1), zone.mins[2] + 1], yaw: 0 };
};
const reports = [];
for (const { map, spawn } of cases.filter((c) => !values.only || c.map === values.only)) {
  const mapPath = join(resolve(values.maps), map + ".bsp");
  const bsp = readFileSync(mapPath);
  const sha = new Bun.CryptoHasher("sha256").update(bsp).digest("hex");
  const fixture = { map, spawn: spawn ?? startZonePoint(map) };
  const newCore = async () => {
    const core = await Core.create(wasm);
    core.loadMap(bsp);
    core.setSettings(settings);
    core.reset();
    applyRestartPoint(core, fixture.spawn);
    return core;
  };
  const websiteCore = async () => {
    const core = await pristine.core.Core.create(wasm);
    core.loadMap(bsp);
    core.setSettings(settings);
    core.reset();
    pristine.core.applyRestartPoint(core, fixture.spawn);
    return core;
  };
  const probe = await newCore();
  const points: number[][] = [];
  for (let i = 0; i < 500; i++) {
    const c = quantize(...keyed(i));
    probe.step(c.forward, c.side, c.yaw, c.pitch, c.buttons);
    points.push([...probe.state().position]);
  }
  const start = fixture.spawn.position;
  const end = fixture.map === "bhop_eazy" ? [705, -352, 70] : points[250];
  const zone = (kind: "start" | "end", point: readonly number[], radius: number): Zone => ({
    kind,
    mins: point.map((n, i) => Math.fround(n - (i === 2 ? 100 : radius))) as [number, number, number],
    maxs: point.map((n, i) => Math.fround(n + (i === 2 ? 100 : radius))) as [number, number, number],
  });
  const zones =
    fixture.map === "bhop_eazy"
      ? ([
          { kind: "start", mins: [540, -480, 0], maxs: [580, -224, 300] },
          { kind: "end", mins: [690, -480, 0], maxs: [720, -224, 300] },
        ] as Zone[])
      : [zone("start", start, 20), zone("end", end, 1)];
  const core = await newCore();
  const timer = makeTimer(zones, settings, stylePrespeedCap("segmented"), styleDef("segmented"), 2);
  timer.reset();
  const rec = new ReplayRecorder(10);
  rec.turnSpeed = { yawSpeed: 210, angleSpeedKey: 2 };
  const log = new SegmentLog();
  log.begin([], 0);
  const checkpoints: { handle: number; timer: TimerSnapshot; mark: SegmentMark }[] = [];
  const actions: Action[] = [];
  const traces: unknown[] = [];
  let teleport = false;
  let epoch = 0;
  const trace = () => {
    const s = core.state();
    traces.push({
      tick: s.tick,
      bits: [...s.position, ...s.velocity].map(bits),
      start: timer.startTick,
      end: timer.endTick,
      status: ["idle", "running", "finished"].indexOf(timer.status),
    });
  };
  const step = (command: Command) => {
    const c = quantize(...command);
    const look: LookSample = {
      base: c.yaw,
      k: 0.022,
      count: 0,
      epoch: epoch++,
      kind: teleport ? 2 : 0,
      frames: 1,
      events: 0,
      reports: 0,
    };
    teleport = false;
    beforeStep(core, timer, c);
    const events = core.step(c.forward, c.side, c.yaw, c.pitch, c.buttons);
    const { state } = afterStep(core, timer, c, events);
    rec.push(c.forward, c.side, c.yaw, c.pitch, c.buttons, look);
    rec.maybeCheckpoint(state.tick, state.position, state.velocity);
    log.push({ ...c, look, frame: [...state.position, 0, c.yaw, c.pitch], frameEvents: 0 });
    if (state.tick % 10 === 0) log.checkpoint(state.position, state.velocity);
    actions.push({ command: [c.forward, c.side, c.yaw, c.pitch, c.buttons], look });
    trace();
  };
  const play = (from: number, to: number, command = keyed) => {
    for (let i = from; i < to && timer.status !== "finished"; i++) step(command(i));
  };
  const save = () => {
    const mark = log.mark({ nullBinds: false, timedInput: false, turnSpeed: rec.turnSpeed });
    assert(mark, "web segment log must be saveable");
    checkpoints.push({ handle: snapshotState(core), timer: saveTimer(timer), mark });
    actions.push({ save: true });
    trace();
    return checkpoints.length - 1;
  };
  const load = (index: number) => {
    const cp = checkpoints[index];
    assert(restoreState(core, cp.handle), "web snapshot restore");
    loadTimer(timer, cp.timer);
    assert(
      log.load(cp.mark, core.state(), rec, () => {}),
      "web segment log restore",
    );
    teleport = true;
    actions.push({ load: index });
    trace();
  };
  const event = (kind: number, inspect = false) => {
    if (inspect) rec.inspectEvent(kind);
    else rec.event(kind);
    log.event(kind, inspect);
    actions.push(inspect ? { inspect: kind } : { cosmetic: kind });
    trace();
  };
  play(0, 50);
  const a = save();
  event(7);
  play(0, 80, wander);
  event(1, true);
  const b = save();
  load(a);
  play(0, 40, wander);
  event(2);
  load(a);
  play(50, 90);
  const c = save();
  event(3, true);
  play(0, 30, wander);
  load(b);
  play(0, 20, wander);
  load(c);
  play(90, 3000);
  if (timer.status !== "finished")
    console.error({
      map: fixture.map,
      start,
      end,
      point0: points[0],
      point50: points[50],
      point100: points[100],
      final: core.state(),
      timer: saveTimer(timer),
    });
  assert(timer.status === "finished", fixture.map + " synthetic course must finish");
  rec.addCheckpoint(core.state().tick, core.state().position, core.state().velocity);
  const web = rec.build({
    map: fixture.map,
    mapSha256: sha,
    settings,
    style: "segmented",
    prespeedCap: 290,
    timerRules: 2,
    startTick: timer.startTick,
    endTick: timer.endTick,
    track: 0,
    spawn: restartPoint(core),
    zones,
    clientBuild: "bunnyhop-native/local",
    player: "segmented-proof",
    recordedAt: 1,
  });
  const specPath = join(output, fixture.map + ".json");
  const bhrPath = join(output, fixture.map + ".bhr");
  writeFileSync(specPath, JSON.stringify({ zones, spawn: fixture.spawn, actions }));
  const driver = Bun.spawn([join(root, "target/debug/segmented-proof"), mapPath, specPath, bhrPath], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  });
  const nativeText = await new Response(driver.stdout).text();
  assert((await driver.exited) === 0, fixture.map + " native ABI driver");
  const nativeTrace = JSON.parse(nativeText) as { traces: unknown[] };
  const mismatch = traces.findIndex((trace, i) => !isDeepStrictEqual(trace, nativeTrace.traces[i]));
  if (mismatch !== -1) console.error({ mismatch, web: traces[mismatch], native: nativeTrace.traces[mismatch] });
  assert(isDeepStrictEqual(nativeTrace.traces, traces), fixture.map + " exact per-action state/timer mismatch");
  const native = await pristine.replay.decodeReplay(readFileSync(bhrPath));
  web.header.recordedAt = native.header.recordedAt;
  web.header.clientBuild = native.header.clientBuild;
  const nativeRaw = gunzipSync(readFileSync(bhrPath));
  const webRaw = encodeRaw(web);
  const byteMismatch = nativeRaw.findIndex((byte, i) => byte !== webRaw[i]);
  if (byteMismatch !== -1 || nativeRaw.length !== webRaw.length) {
    console.error({
      byteMismatch,
      nativeBytes: nativeRaw.length,
      webBytes: webRaw.length,
      nativeHeader: native.header,
      webHeader: web.header,
      nativeTail: [...nativeRaw.subarray(byteMismatch, byteMismatch + 32)],
      webTail: [...webRaw.subarray(byteMismatch, byteMismatch + 32)],
    });
  }
  assert(
    Buffer.compare(nativeRaw, Buffer.from(webRaw)) === 0,
    fixture.map + " native bytes differ from website-made replay",
  );
  const verify = async (replay = native) =>
    pristine.verifier.verifyReplay(await websiteCore(), replay, zones, { mapSha256: sha, ranked: true });
  const result = await verify();
  const webResult = await verify(pristine.replay.decodeRaw(webRaw));
  assert(result.valid, fixture.map + ": " + result.problems.join("; "));
  const { simMs: nativeDuration, ...nativeVerdict } = result;
  const { simMs: webDuration, ...webVerdict } = webResult;
  assert(isDeepStrictEqual(nativeVerdict, webVerdict), "website/native verdicts differ");
  const sliced = await pristine.verifier.verifyReplaySliced(await websiteCore(), native, zones, {
    mapSha256: sha,
    sliceTicks: 97,
    between: async () => {},
  });
  assert(sliced.valid && sliced.segmentLoads === result.segmentLoads, "sliced verifier mismatch");
  const rejected: string[] = [];
  for (const mutation of ["speed", "moved", "shifted", "late", "normal"] as const) {
    const forged = structuredClone(native);
    const loads = forged.segments!;
    if (mutation === "speed") loads[0].velocity[0] *= 1.5;
    if (mutation === "moved") loads[1].position[0] += 0.5;
    if (mutation === "shifted") loads[0].tick++;
    if (mutation === "late")
      loads.push({ tick: native.header.totalTicks + 5, position: [0, 0, 0], velocity: [0, 0, 0] });
    if (mutation === "normal") forged.header.style = "autohop";
    const verdict = await verify(forged);
    const kept = native.segments!;
    const tick = mutation === "moved" ? kept[1].tick : mutation === "shifted" ? kept[0].tick + 1 : kept[0].tick;
    const expected =
      mutation === "late"
        ? "1 segment load(s) after the replay's last tick"
        : mutation === "normal"
          ? `${kept.length} segment load(s) in a Normal run: only Segmented runs load checkpoints`
          : `segment load at tick ${tick} restores a state this run never saved (not the run's position and velocity at that tick)`;
    if (!verdict.problems.includes(expected)) console.error({ mutation, problems: verdict.problems });
    assert(
      !verdict.valid && verdict.problems.includes(expected),
      fixture.map + " wrong forged-load rejection: " + mutation,
    );
    rejected.push(mutation);
  }
  for (const cp of checkpoints) freeState(core, cp.handle);
  const report = {
    map: fixture.map,
    timeMs: result.timeMs,
    ticks: native.header.totalTicks,
    loads: result.segmentLoads,
    tracedActions: traces.length,
    exactBytes: true,
    fullSnapshotRoundTrip: true,
    rejected,
  };
  reports.push(report);
  console.log(JSON.stringify(report));
}
writeFileSync(join(output, "proof.json"), JSON.stringify({ wasmSha, websiteCommit, reports }, null, 2) + "\n");
