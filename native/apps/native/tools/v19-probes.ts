// Positive probes against the actual verifier and the built native ABI. All outputs stay local.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Core, DEFAULT_SETTINGS, setPosition } from "../../web/src/core";
import { setVelocity } from "../../web/src/sim";
import { bspModelBounds } from "../../web/src/zones";
import { ensureCanonicalWasm } from "../ensure-wasm";
import { row, same, type Row } from "./parity-gate";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { maps: { type: "string" }, output: { type: "string", default: "target/v19-probes" } },
});
if (!values.maps) throw new Error("--maps /path/to/SHA-verified/original/BSPs");
const output = resolve(values.output!);
mkdirSync(output, { recursive: true });
const wasm = readFileSync(await ensureCanonicalWasm());
const runner = resolve(import.meta.dir, "../build/bunnyhop-native-runner");
const results: unknown[] = [];

async function probe(map: string, physics: number, kind: "velocity" | "ledge" | "pitch" | "bonus") {
  const path = join(resolve(values.maps!), `${map}.bsp`);
  const bsp = readFileSync(path);
  const core = await Core.create(wasm);
  core.loadMapPhysics(bsp);
  const settings = { ...DEFAULT_SETTINGS, physics };
  core.setSettings(settings);
  core.reset();
  const lines = [
    `settings ${[
      settings.tickInterval,
      settings.airAccelerate,
      settings.accelerate,
      settings.friction,
      settings.stopSpeed,
      settings.gravity,
      settings.maxSpeed,
      +settings.autohop,
      physics,
      +(settings.stamina ?? false),
    ].join(" ")}`,
    "reset",
  ];
  const expected: Row[] = [];
  const position = (p: number[]) => {
    setPosition(core, p[0], p[1], p[2], 0);
    lines.push(`position ${p.join(" ")} 0`);
  };
  const step = (ticks: number, forward: number, buttons: number) => {
    for (let i = 0; i < ticks; i++) {
      lines.push(`cmd ${forward} 0 0 0 ${buttons}`, "state");
      const events = core.step(forward, 0, 0, 0, buttons);
      expected.push(row(core.state(), events));
    }
  };
  let positive: unknown;
  if (kind === "velocity") {
    const speed = map === "kz_bhop_global" ? 19000 : 6000;
    let best = 0;
    for (const [axis, sign] of [
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
    ]) {
      core.reset();
      lines.push("reset");
      step(5, 0, 0);
      const spawn = core.state().position;
      position([spawn[0], spawn[1], spawn[2] + 32]);
      const velocity = [0, 0, 0];
      velocity[axis] = sign * speed;
      setVelocity(core, velocity);
      lines.push(`velocity ${velocity.join(" ")}`);
      step(1, 0, 0);
      best = Math.max(best, Math.abs(core.state().velocity[axis]));
    }
    const wanted = physics < 19 ? 0 : speed;
    const aboveOldLimit = best > (map === "kz_bhop_global" ? 10000 : 3500) && best <= speed;
    if (physics < 19 ? best !== wanted : !aboveOldLimit)
      throw new Error(`${map} v${physics}: high-speed probe got ${best}`);
    positive = { requestedSpeed: speed, survivingSpeed: best };
  } else if (kind === "ledge") {
    position([-2841, -4512, 1]);
    step(1, 0, 4);
    let reached = false;
    for (let i = 0; i < 100; i++) {
      step(1, 450, 6);
      const state = core.state();
      reached ||= state.position[0] > -2840 && state.position[2] >= 66 && state.grounded;
    }
    if (reached !== physics >= 19) throw new Error(`Profane v${physics}: ledge ${reached}`);
    positive = { reached };
  } else if (kind === "bonus") {
    const zones = JSON.parse(readFileSync(path.replace(/\.bsp$/, ".zones.json"), "utf8")) as {
      zones: { kind: string; track?: number; mins: number[]; maxs: number[] }[];
    };
    const start = zones.zones.find((zone) => zone.kind === "start" && zone.track === 1)!;
    position([(start.mins[0] + start.maxs[0]) / 2, (start.mins[1] + start.maxs[1]) / 2, start.mins[2] + 1]);
    step(2000, 450, 2);
    positive = { track: 1 };
  } else {
    const trigger = core
      .entities()
      .find((e) => e.classname === "trigger_teleport" && e.target === "level1" && !e.filtername)!;
    const bounds = bspModelBounds(bsp)![Number(trigger.model.slice(1))];
    position(trigger.origin.split(/\s+/).map((v, i) => Number(v) + (bounds.mins[i] + bounds.maxs[i]) / 2));
    step(1, 0, 0);
    const pitch = core.state().teleportAngles[0];
    if (pitch !== (physics >= 19 ? -10 : 350)) throw new Error(`Playboy v${physics}: pitch ${pitch}`);
    positive = { pitch };
  }
  const prefix = join(output, `${map}-v${physics}`);
  writeFileSync(`${prefix}.commands`, lines.join("\n") + "\n");
  const native = Bun.spawnSync([runner, "--map", path, "--commands", `${prefix}.commands`]);
  if (native.exitCode) throw new Error(native.stderr.toString());
  const actual = native.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Row);
  if (actual.length !== expected.length || expected.some((state, i) => !same(state, actual[i])))
    throw new Error(`${map} v${physics}: native/WASM state mismatch`);
  const result = { map, physics, ticks: expected.length, identical: true, ...(positive as object) };
  results.push(result);
  console.log(result);
}

async function probeWheelUse() {
  const map = join(resolve(values.maps!), "bhop_rpg.bsp");
  const bsp = readFileSync(map);
  const cores = [];
  for (let i = 0; i < 2; i++) {
    const core = await Core.create(wasm);
    core.loadMapPhysics(bsp);
    core.setSettings(DEFAULT_SETTINGS);
    core.reset();
    setPosition(core, 10144, 128, -720, 0);
    cores.push(core);
  }
  const lines = ["reset", "position 10144 128 -720 0"];
  type WheelRow = { model: number; bits: number[]; visible: number };
  const expected: (Row | WheelRow)[] = [];
  let useDifferences = 0;
  for (let tick = 0; tick < 150; tick++) {
    const state = cores[0].state();
    const pitch = (Math.atan2(state.position[2] + state.viewOffsetZ + 656, 10208 - state.position[0]) * 180) / Math.PI;
    const buttons = tick < 60 || tick >= 90 ? 32 : 0;
    const events = cores[0].step(0, 0, 0, pitch, buttons);
    cores[1].step(0, 0, 0, pitch, 0);
    const transform = cores[0].brushOrigins().get(118)!;
    if (JSON.stringify(transform) !== JSON.stringify(cores[1].brushOrigins().get(118))) useDifferences++;
    lines.push(`cmd 0 0 0 ${pitch} ${buttons}`, "state", "model 118");
    expected.push(row(cores[0].state(), events), {
      model: 118,
      bits: [...new Uint32Array(new Float32Array(transform.slice(0, 6)).buffer)],
      visible: transform[6] ?? 1,
    });
  }
  if (!useDifferences) throw new Error("RPG ss2 probe never exercised continuous use");
  const prefix = join(output, "bhop_rpg-use");
  writeFileSync(`${prefix}.commands`, lines.join("\n") + "\n");
  const native = Bun.spawnSync([runner, "--map", map, "--commands", `${prefix}.commands`]);
  if (native.exitCode) throw new Error(native.stderr.toString());
  const actual = native.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Row | WheelRow);
  if (
    actual.length !== expected.length ||
    expected.some((state, i) =>
      "model" in state
        ? JSON.stringify(state) !== JSON.stringify(actual[i])
        : "model" in actual[i] || !same(state, actual[i] as Row),
    )
  )
    throw new Error("RPG continuous-use player/wheel trajectory differs from native");
  const result = {
    map: "bhop_rpg",
    kind: "ss2 continuous use, pause and reversal",
    physics: DEFAULT_SETTINGS.physics,
    ticks: 150,
    useDifferences,
    identical: true,
  };
  results.push(result);
  console.log(result);
}

for (const map of ["bhop_gigaheish_fix", "bhop_accelerate", "bhop_quack", "bhop_rainbowroad_fix", "kz_bhop_global"])
  for (const physics of [18, 19, 20]) await probe(map, physics, "velocity");
for (const physics of [18, 19, 20]) {
  await probe("bhop_profane", physics, "ledge");
  await probe("bhop_playboy_csgo", physics, "pitch");
}
for (const physics of [19, 20]) await probe("bhop_ceaseless", physics, "bonus");
await probeWheelUse();
writeFileSync(join(output, "report.json"), JSON.stringify(results, null, 2) + "\n");
