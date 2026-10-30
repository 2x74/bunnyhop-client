// Physics v20 autohop probes on bhop_dom: the actual verifier against the built native ABI, tick for tick.
// Outputs stay local and nothing is submitted.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Core, DEFAULT_SETTINGS, EVENT_JUMPED, setPosition } from "../../web/src/core";
import { setVelocity } from "../../web/src/sim";
import { ensureCanonicalWasm } from "../ensure-wasm";
import { row, same, type Row } from "./parity-gate";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { map: { type: "string" }, output: { type: "string", default: "target/v20-probes" } },
});
if (!values.map) throw new Error("--map /path/to/SHA-verified/bhop_dom.bsp");
const mapPath = resolve(values.map);
const output = resolve(values.output!);
mkdirSync(output, { recursive: true });
const wasm = readFileSync(await ensureCanonicalWasm());
const bsp = readFileSync(mapPath);
const runner = resolve(import.meta.dir, "../build/bunnyhop-native-runner");

const jump_button = 1 << 1;
const duck_button = 1 << 2;
// The floor under PonyTrap's tick-1096 landing; a standing hull rests at this height.
const floor = { x: -9934.1328125, y: -1850.15771484375, z: -47.96875 };
// PonyTrap's horizontal velocity entering tick 1096: 962.43 u/s.
const pony_velocity = [835.0971069335938, 478.4269714355469];
// Jumping from the floor and holding duck, the crouched hull is 10 units up and falling on this command.
const unduck_command = 76;
const ground_friction_factor = 0.96;

interface Probe {
  lines: string[];
  expected: Row[];
  core: Core;
}

async function start(physics: number): Promise<Probe> {
  const core = await Core.create(wasm);
  core.loadMapPhysics(bsp);
  const settings = { ...DEFAULT_SETTINGS, physics };
  core.setSettings(settings);
  core.reset();
  const header = [
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
  ];
  return { core, lines: [`settings ${header.join(" ")}`, "reset"], expected: [] };
}

function step(probe: Probe, buttons: number): number {
  probe.lines.push(`cmd 0 0 0 0 ${buttons}`, "state");
  const events = probe.core.step(0, 0, 0, 0, buttons);
  probe.expected.push(row(probe.core.state(), events));
  return events;
}

function place(probe: Probe, z: number) {
  setPosition(probe.core, floor.x, floor.y, z, 0);
  probe.lines.push(`position ${floor.x} ${floor.y} ${z} 0`);
}

function push(probe: Probe, velocity: number[]) {
  setVelocity(probe.core, velocity);
  probe.lines.push(`velocity ${velocity.join(" ")}`);
}

const speed = (core: Core) => Math.hypot(core.state().velocity[0], core.state().velocity[1]);

// Crouch-cancel: release duck while the crouched hull falls toward the floor, jump held throughout.
async function unduck(physics: number) {
  const probe = await start(physics);
  step(probe, 0);
  place(probe, floor.z);
  step(probe, 0);
  for (let command = 1; command < unduck_command; command++) step(probe, jump_button | duck_button);
  const before = probe.core.state();
  if (!before.crouched || before.grounded) throw new Error(`unduck v${physics}: not crouched in the air`);
  push(probe, [...pony_velocity, before.velocity[2]]);
  const entry = speed(probe.core);
  const events = step(probe, jump_button);
  return { probe, entry, exit: speed(probe.core), jumped: (events & EVENT_JUMPED) !== 0 };
}

// Game code places the player on a floor after an airborne command with jump held.
async function teleport(physics: number) {
  const probe = await start(physics);
  step(probe, 0);
  place(probe, floor.z + 148);
  step(probe, jump_button);
  place(probe, floor.z);
  push(probe, [962.4, 0, 0]);
  const entry = speed(probe.core);
  const events = step(probe, jump_button);
  return { probe, entry, exit: speed(probe.core), jumped: (events & EVENT_JUMPED) !== 0 };
}

function compare(name: string, probe: Probe) {
  const prefix = join(output, name);
  writeFileSync(`${prefix}.commands`, probe.lines.join("\n") + "\n");
  const native = Bun.spawnSync([runner, "--map", mapPath, "--commands", `${prefix}.commands`]);
  if (native.exitCode) throw new Error(native.stderr.toString());
  const actual = native.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Row);
  writeFileSync(`${prefix}.native.jsonl`, native.stdout);
  const mismatch = probe.expected.findIndex((state, i) => !same(state, actual[i]));
  if (actual.length !== probe.expected.length || mismatch >= 0)
    throw new Error(`${name}: native differs from the verifier at state ${mismatch}`);
  return probe.expected.length;
}

function expectVersionBehavior(
  name: string,
  physics: number,
  result: { entry: number; exit: number; jumped: boolean },
) {
  const friction = Math.abs(result.exit - result.entry * ground_friction_factor) < 0.5;
  if (physics < 20 ? result.jumped || !friction : !result.jumped || result.exit < result.entry)
    throw new Error(`${name}: v${physics} ${result.entry} -> ${result.exit} u/s, jumped ${result.jumped}`);
}

const results: unknown[] = [];
for (const [kind, probe] of [
  ["unduck", unduck],
  ["teleport", teleport],
] as const) {
  for (const physics of [19, 20]) {
    const result = await probe(physics);
    const name = `bhop_dom-${kind}-v${physics}`;
    expectVersionBehavior(name, physics, result);
    const states = compare(name, result.probe);
    const summary = {
      map: "bhop_dom",
      kind,
      physics,
      states,
      entry: result.entry,
      exit: result.exit,
      jumped: result.jumped,
    };
    results.push(summary);
    console.log(summary);
  }
}
writeFileSync(join(output, "report.json"), JSON.stringify(results, null, 2) + "\n");
