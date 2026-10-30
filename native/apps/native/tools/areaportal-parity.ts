// The red train's rider and model trajectories, compared with the pinned verifier without opening a window.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Core, DEFAULT_SETTINGS, setPosition, type PlayerState } from "../../web/src/core";
import { setVelocity } from "../../web/src/sim";
import { ensureCanonicalWasm } from "../ensure-wasm";
import { row, same, type Row } from "./parity-gate";

interface ModelRow {
  model: number;
  bits: number[];
  visible: number;
}
type StateRow = Row | ModelRow;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { map: { type: "string" }, output: { type: "string", default: "target/areaportal-parity" } },
});
if (!values.map) throw new Error("--map /path/to/bhop_areaportal_v1.bsp");
const map = resolve(values.map);
const output = resolve(values.output!);
const runner = resolve(import.meta.dir, "../build/bunnyhop-native-runner");
mkdirSync(output, { recursive: true });
const wasm = readFileSync(await ensureCanonicalWasm());
const core = await Core.create(wasm);
const cache = process.env.CONTENT_CACHE_DIR ?? resolve(dirname(map), "../content-cache");
const physics = join(cache, "physics", `${basename(map, ".bsp")}.txt`);
if (existsSync(physics)) {
  for (const line of readFileSync(physics, "utf8").split("\n")) {
    const [path, sha] = line.split("\t");
    if (path && sha) core.contentAddFile(path, readFileSync(join(cache, "content", sha.trim())));
  }
}
core.loadMapPhysics(readFileSync(map));
const train = core.entities().find((entity) => entity.targetname === "rede3da");
if (!train?.model) throw new Error("The reviewed red train is missing");
const model = Number(train.model.slice(1));
const results: object[] = [];

function compare(name: string, lines: string[], expected: StateRow[]): void {
  const path = join(output, `${name}.commands`);
  writeFileSync(path, lines.join("\n") + "\n");
  const native = Bun.spawnSync([runner, "--map", map, "--commands", path]);
  if (native.exitCode) throw new Error(native.stderr.toString());
  const actual = native.stdout
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as StateRow);
  const equal = (a: StateRow, b: StateRow) =>
    "model" in a ? JSON.stringify(a) === JSON.stringify(b) : !("model" in b) && same(a, b);
  const mismatch = expected.findIndex((state, index) => !actual[index] || !equal(state, actual[index]));
  if (actual.length !== expected.length || mismatch >= 0)
    throw new Error(`${name}: native/WASM differs at row ${mismatch}`);
}

interface RideState {
  state: PlayerState;
  transform: number[];
  events: number;
}
type Step = (buttons?: number, forward?: number, yaw?: number) => RideState;

function checkRider({ state, transform, events }: RideState, offset: number[]): void {
  if (
    events & 1 ||
    state.angleChange.some((v) => v !== 0) ||
    Math.abs(state.position[0] - transform[0] - offset[0]) >= 0.001 ||
    Math.abs(state.position[1] - transform[1] - offset[1]) >= 4 ||
    state.position[2] <= transform[2] + 9 ||
    state.position[2] >= transform[2] + 11
  )
    throw new Error(`v19 rider lost the red train at tick ${state.tick}`);
}

function rideTurns(step: Step, physics: number, offset: number[], jump: boolean, previousY: number) {
  let direction = 1,
    turns = 0,
    angle = 0;
  for (let tick = 0; tick < (jump ? 280 : 650); tick++) {
    const result = step();
    const delta = result.transform[1] - previousY;
    if (delta * direction < 0) {
      direction = -direction;
      turns++;
    }
    previousY = result.transform[1];
    angle += Math.abs(result.state.angleChange[1]);
    if (physics === 19) checkRider(result, offset);
  }
  if (!jump && (turns !== 2 || (physics === 19 ? angle !== 0 : angle < 180)))
    throw new Error(`v${physics}: turns ${turns}, rider angle ${angle}`);
  return { turns, angle };
}

function jumpOff(step: Step): void {
  const before = core.state().position[1];
  step(2, 450, 270);
  const airborne = step(2, 450, 270).state;
  if (
    airborne.grounded ||
    airborne.position[1] - before >= -9 ||
    airborne.velocity[1] >= -900 ||
    airborne.velocity[2] <= 250 ||
    airborne.angleChange.some((v) => v !== 0)
  )
    throw new Error("The rider did not jump with the train's speed");
}

function rider(physics: number, offset: number[], jump: boolean, sequence: number): void {
  const settings = { ...DEFAULT_SETTINGS, physics };
  core.setSettings(settings);
  core.reset();
  const fields = [
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
  const lines = [`settings ${fields.join(" ")}`, "reset"];
  const expected: StateRow[] = [];
  const step: Step = (buttons = 0, forward = 0, yaw = 37) => {
    const events = core.step(forward, 0, yaw, 0, buttons);
    const transform = core.brushOrigins().get(model)!;
    lines.push(`cmd ${forward} 0 ${yaw} 0 ${buttons}`, "state", `model ${model}`);
    expected.push(row(core.state(), events), {
      model,
      bits: [...new Uint32Array(new Float32Array(transform.slice(0, 6)).buffer)],
      visible: transform[6] ?? 1,
    });
    return { state: core.state(), transform, events };
  };
  for (let tick = 0; tick < 60; tick++) step(0, 0, 0);
  const origin = core.brushOrigins().get(model)!;
  const position = [origin[0] + offset[0], origin[1] + offset[1], Math.fround(origin[2] + 10.5)];
  setPosition(core, position[0], position[1], position[2], 270);
  setVelocity(core, [0, 1000, 0]);
  lines.push(`position ${position.join(" ")} 270`, "velocity 0 1000 0");
  const { turns, angle } = rideTurns(step, physics, offset, jump, origin[1]);
  if (jump) jumpOff(step);
  const name = `red-train-${sequence}-v${physics}-${offset.join("_")}-${jump ? "jump" : "ride"}`;
  compare(name, lines, expected);
  results.push({ name, physics, offset, jump, ticks: expected.length / 2, turns, angle, identical: true });
}

let sequence = 0;
for (const physics of [18, 19, 18, 19])
  for (const offset of [
    [0, 0],
    [40, 25],
    [-40, -25],
    [20, -25],
  ])
    rider(physics, offset, false, sequence++);
for (const offset of [
  [0, 0],
  [40, 25],
  [-40, -25],
  [20, -25],
])
  rider(19, offset, true, sequence++);
writeFileSync(join(output, "report.json"), JSON.stringify(results, null, 2) + "\n");
console.log(`${results.length} red-train rider/model trajectories match the pinned WASM`);
