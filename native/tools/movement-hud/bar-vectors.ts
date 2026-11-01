// The Bar look's vectors: scripted ticks and real core ticks through the website's StrafeTrainer and
// StrafeTrainerView (apps/native/src/strafe_trainer_bar_tests.cpp feeds the same ticks through native::StrafeTrainer).
// Real ticks come from the website's WASM core on small maps made here, so every delta and best is exact.
import { SURF_NODRAW, writeBsp, type Box, type BrushEntity } from "../tutorial/bsp";

const DT = 0.01;
const MAX_SPEED = 250;
const AIR_ACCELERATE = 1000;
const SIDE_SPEED = 450;
const SCRIPTED_SPEED = 400;
const ideal = (speed: number) => (Math.atan2(30, speed) * 180) / Math.PI;

interface Reading {
  cue: string;
  pace: number | null;
  side: number;
  bar?: number;
  barSide?: number;
  gain?: number | null;
}
interface Trainer {
  smoothing: number;
  zone: number;
  lastJump: number | null;
  reading: Reading;
  feed(command: object, sample: object): void;
}
interface ViewElement {
  children: (ViewElement | string)[];
  textContent: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  classes: Set<string>;
}
interface View {
  el: ViewElement;
  configure(prefs: object): void;
  render(reading: Reading, lastJump?: number | null): void;
}
export interface BarWeb {
  StrafeTrainer: new () => Trainer;
  StrafeTrainerView: new () => View;
  barGain(delta: number | undefined, best: number | undefined): number | null;
  barBand(gain: number | null | undefined): string;
}
interface CoreState {
  velocity: number[];
  grounded: boolean;
  onLadder: boolean;
  tick: number;
  airSpeedGain?: number;
  airBestGain?: number;
}
interface Core {
  loadMapPhysics(bsp: Uint8Array): void;
  setSettings(settings: object): void;
  reset(): void;
  step(forward: number, side: number, yaw: number, pitch: number, buttons: number): number;
  state(): CoreState;
  x: { set_velocity(x: number, y: number, z: number): void };
}
export interface BarCore {
  create(): Promise<Core>;
  setPosition(core: Core, x: number, y: number, z: number, yaw: number): void;
  defaults: object;
  jumped: number;
  interrupted: number;
}

/** What one tick feeds the trainer. Gain is null where the core's NaN would be: JSON has no NaN. */
interface Tick {
  tick: number;
  forward: number;
  side: number;
  yaw: number;
  speed: number;
  grounded: boolean;
  onLadder: boolean;
  jumped: boolean;
  interrupted: boolean;
  delta: number | null;
  best: number | null;
}
interface Scenario {
  name: string;
  smoothing?: number;
  dimBelow?: number;
  style?: string;
  ticks: Tick[];
}

function tickFrom(tick: number, yaw: number, side: number, overrides: Partial<Tick> = {}): Tick {
  return {
    tick,
    forward: 0,
    side: side * SIDE_SPEED,
    yaw,
    speed: SCRIPTED_SPEED,
    grounded: false,
    onLadder: false,
    jumped: false,
    interrupted: false,
    delta: 1,
    best: 1,
    ...overrides,
  };
}

/** A tick: [pace share of ideal, side, overrides]. Side 1 is D, which turns right, so yaw falls. */
type Step = [pace: number, side: number, overrides?: Partial<Tick> & { againstKey?: boolean; gap?: number }];
const repeat = (count: number, step: Step): Step[] => Array.from({ length: count }, () => step);

function scripted(name: string, steps: Step[], options: Partial<Scenario> = {}): Scenario {
  let tick = 0;
  let yaw = 0;
  const ticks: Tick[] = [tickFrom(tick, yaw, 1)];
  for (const [pace, side, overrides = {}] of steps) {
    const { againstKey, gap, ...rest } = overrides;
    tick += 1 + (gap ?? 0);
    // A float, as a command's yaw is in both games.
    yaw = Math.fround(yaw - (againstKey ? -1 : 1) * side * ideal(SCRIPTED_SPEED) * pace);
    ticks.push(tickFrom(tick, yaw, side, rest));
  }
  return { name, ...options, ticks };
}

/** One D tick at 100% pace with this observation, so the colour rule is all that changes. */
const observed = (delta: number | null, best: number | null): Step[] => repeat(2, [1, 1, { delta, best }]);

function pureColourScenarios(): Scenario[] {
  const ratios = [-1, 0, 0.1, 0.9, 0.900001, 0.99, 0.990001, 1, 1.03];
  const noise = [0.0001, -0.0001, 0.000101, -0.000101, 0.000099, -0.000099];
  return [
    ...ratios.map((ratio) => scripted(`ratio ${ratio}`, observed(ratio, 1))),
    ...noise.map((delta) => scripted(`delta ${delta} at best .45`, observed(delta, 0.45))),
    scripted("no observation", observed(null, null)),
    scripted("no best", observed(1, null)),
    scripted("best 0", observed(1, 0)),
    scripted("negative best", observed(1, -1)),
    scripted("loss then gain", [...observed(-5, 1), ...observed(1, 1), ...observed(0, 1), ...observed(-1, 1)]),
  ];
}

function geometryScenarios(): Scenario[] {
  const onLoss = { delta: -2, best: 1 };
  return [
    ...[1, 0.8, 0.55, 0.25].map((pace) => scripted(`D at ${pace * 100}%`, repeat(8, [pace, 1]))),
    ...[1, 1.2, 1.5, 1.8].map((pace) => scripted(`A at ${pace * 100}%`, repeat(8, [pace, -1]))),
    scripted("past the far end", repeat(8, [3, 1])),
    scripted("under 100 u/s", repeat(8, [1, 1, { speed: 99 }])),
    scripted("no key", repeat(8, [1, 0, { delta: null, best: null }])),
    scripted("against the key is judged and fades", repeat(8, [1, 1, { againstKey: true }])),
    scripted("strafe switch", [...repeat(8, [1, 1]), ...repeat(8, [1, -1])]),
    scripted("one ground tick, then a second", [
      ...repeat(8, [1, -1]),
      [0, -1, { grounded: true, ...onLoss }],
      [0, -1, { grounded: true, ...onLoss }],
    ]),
    scripted("ladder", [...repeat(8, [1, -1]), ...repeat(3, [1, -1, { onLadder: true, ...onLoss }])]),
    scripted("keys let go", [...repeat(8, [1, -1]), ...repeat(4, [1, 0])]),
    scripted("teleport clears a red", [...repeat(8, [1, -1, onLoss]), [1, -1, { interrupted: true, ...onLoss }]]),
    scripted("tick gap clears a red", [...repeat(8, [1, -1, onLoss]), [1, -1, { gap: 5, ...onLoss }]]),
    scripted("unsupported style", repeat(4, [1, 1]), { style: "wonly" }),
    scripted("last jump", [
      ...repeat(6, [0.9, 1]),
      [0, 1, { grounded: true }],
      ...repeat(3, [1, 1]),
      [0, 1, { jumped: true }],
    ]),
    scripted("hints and dimming", [...repeat(4, [0.4, 1]), ...repeat(4, [1, 1]), ...repeat(4, [1.5, 1])], {
      dimBelow: 90,
    }),
    ...[1, 8, 20, 50].map((smoothing) =>
      scripted(`smoothing ${smoothing}`, [...repeat(30, [1, 1]), ...repeat(30, [1.4, -1])], { smoothing }),
    ),
  ];
}

function wOnlyScenarios(): Scenario[] {
  const held = (forward: number, pace: number, overrides: Partial<Tick> = {}): Step => [
    pace,
    1,
    { forward, side: 0, ...overrides },
  ];
  return [
    scripted("W turning right fills from the left", repeat(4, held(SIDE_SPEED, 1))),
    scripted("S turning left fills from the right", repeat(4, [1, -1, { forward: -SIDE_SPEED, side: 0 }])),
    scripted("W with the mouse still keeps its edge", [
      ...repeat(4, [1, -1, { forward: SIDE_SPEED, side: 0 }]),
      ...repeat(4, [0, -1, { forward: SIDE_SPEED, side: 0 }]),
    ]),
    scripted("W alone from a standstill mouse", repeat(4, held(SIDE_SPEED, 0))),
  ];
}

// The same stream on every run, so regenerating with an unchanged rule changes nothing.
function randomSteps(seed: number, count: number): Step[] {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const steps: Step[] = [];
  for (let i = 0; i < count; i++) {
    const roll = next();
    const overrides: NonNullable<Step[2]> = {};
    if (roll < 0.05) overrides.grounded = true;
    else if (roll < 0.06) overrides.onLadder = true;
    else if (roll < 0.07) overrides.interrupted = true;
    else if (roll < 0.08) overrides.speed = 50;
    else if (roll < 0.1) overrides.jumped = true;
    else if (roll < 0.12) overrides.againstKey = true;
    const side = next() < 0.1 ? 0 : next() < 0.5 ? 1 : -1;
    if (next() < 0.1) overrides.forward = SIDE_SPEED;
    const delta = next() < 0.1 ? null : (next() - 0.3) * 1.5;
    overrides.delta = delta;
    overrides.best = delta === null ? null : 1;
    steps.push([next() * 2.2, side, overrides]);
  }
  return steps;
}

const box = (min: number[], max: number[], contents = 1): Box =>
  ({ min, max, contents, tex: "tools/toolsnodraw" }) as Box;
const HIGH = 8000;

/** A closed room with the spawn high in the air, and the one feature each gate needs. */
function gateMap(extraBoxes: Box[], brushEntities: BrushEntity[]): Uint8Array {
  const walls = [
    box([-4096, -4096, -64], [4096, 4096, 0]),
    box([4096, -4096, 0], [4160, 4096, 10000]),
    box([-4160, -4160, -64], [-4096, 4160, 10064]),
    box([-4096, -4160, -64], [4096, -4096, 10064]),
    box([-4096, 4096, -64], [4096, 4160, 10064]),
    box([-4096, -4096, 10000], [4096, 4096, 10064]),
  ];
  const source = {
    worldspawn: { classname: "worldspawn" },
    boxes: [...extraBoxes, ...walls],
    brushEntities,
    points: [
      { classname: "info_player_terrorist", origin: `0 0 ${HIGH}` },
      { classname: "info_teleport_destination", targetname: "dest", origin: `500 0 ${HIGH}` },
    ],
    materials: { "tools/toolsnodraw": { width: 64, height: 64, reflectivity: [0.5, 0.5, 0.5], flags: SURF_NODRAW } },
    seeds: [[0, 0, HIGH]],
    lighting: { sunDir: [0, 0, -1], sun: [0, 0, 0], sky: [0, 0, 0], bounce: [0, 0, 0], luxel: 16384, skyRays: 1 },
  };
  return writeBsp(source as unknown as Parameters<typeof writeBsp>[0]).bsp;
}

const triggerBox = () => [box([-64, -64, HIGH - 100], [64, 64, HIGH + 200])];

interface Gate {
  name: string;
  boxes?: Box[];
  entities?: BrushEntity[];
  position?: [number, number];
  speed: number;
  forward?: number;
  side?: number;
  ticks?: number;
  /** A tick in the air the observation must be unavailable on, proving the map really exercised the gate. */
  check: (samples: CoreSample[]) => boolean;
}
interface CoreSample {
  speed: number;
  grounded: boolean;
  onLadder: boolean;
  events: number;
  delta: number | null;
}

const GATES: Gate[] = [
  {
    name: "ground",
    position: [0, 0],
    speed: 400,
    check: (samples) => samples.some((sample) => sample.grounded && sample.delta === null),
  },
  {
    name: "ladder",
    boxes: [box([0, -64, 0], [16, 64, 10000], 0x20000001)],
    position: [-17, HIGH],
    speed: 200,
    forward: SIDE_SPEED,
    side: 0,
    check: (samples) => samples.some((sample) => sample.onLadder && sample.delta === null),
  },
  {
    name: "under 100 u/s",
    speed: 99,
    ticks: 2,
    check: (samples) => samples[0].delta === null,
  },
  {
    name: "no key",
    speed: 400,
    side: 0,
    check: (samples) => samples.every((sample) => sample.delta === null),
  },
  {
    name: "wall",
    position: [4055, HIGH],
    speed: 2000,
    check: (samples) => samples.some((sample) => sample.delta === null),
  },
  {
    name: "booster",
    entities: [
      {
        keys: { classname: "trigger_push", speed: "2000", pushdir: "0 180 0", spawnflags: "1" },
        boxes: triggerBox(),
      } as BrushEntity,
    ],
    speed: 400,
    check: (samples) => samples.some((sample) => sample.delta === null),
  },
  {
    name: "speed trigger",
    entities: [
      {
        keys: {
          classname: "trigger_multiple",
          spawnflags: "1",
          OnStartTouch: "!activator,AddOutput,basevelocity -350 0 0,0,-1",
        },
        boxes: triggerBox(),
      } as BrushEntity,
    ],
    speed: 400,
    check: (samples) => samples.some((sample) => sample.delta === null),
  },
  {
    name: "teleport",
    entities: [
      { keys: { classname: "trigger_teleport", target: "dest", spawnflags: "1" }, boxes: triggerBox() } as BrushEntity,
    ],
    speed: 400,
    check: (samples) => samples.some((sample) => sample.events & 1),
  },
];

const settings = (defaults: object) => ({
  ...defaults,
  tickInterval: DT,
  maxSpeed: MAX_SPEED,
  airAccelerate: AIR_ACCELERATE,
});

function coreTick(core: Core, bar: BarCore, command: Pick<Tick, "forward" | "side" | "yaw">): Tick {
  const yaw = Math.fround(command.yaw);
  const events = core.step(command.forward, command.side, yaw, 0, 0);
  const state = core.state();
  const speed = Math.sqrt(state.velocity[0] ** 2 + state.velocity[1] ** 2);
  const delta = state.airSpeedGain;
  const best = state.airBestGain;
  return {
    tick: state.tick,
    forward: command.forward,
    side: command.side,
    yaw,
    speed,
    grounded: state.grounded,
    onLadder: state.onLadder,
    jumped: (events & bar.jumped) !== 0,
    interrupted: (events & bar.interrupted) !== 0,
    delta: Number.isFinite(delta) ? delta! : null,
    best: Number.isFinite(best) ? best! : null,
  };
}

async function gateScenarios(bar: BarCore): Promise<Scenario[]> {
  const core = await bar.create();
  const result: Scenario[] = [];
  for (const gate of GATES) {
    core.loadMapPhysics(gateMap(gate.boxes ?? [], gate.entities ?? []));
    core.setSettings(settings(bar.defaults));
    core.reset();
    const [x, z] = gate.position ?? [0, HIGH];
    bar.setPosition(core, x, 0, z, 0);
    core.x.set_velocity(gate.speed, 0, 0);
    const ticks: Tick[] = [];
    const samples: CoreSample[] = [];
    for (let i = 0; i < (gate.ticks ?? 8); i++) {
      // The mouse keeps turning so a tick the core won't judge still has a fill, which has to be white.
      const yaw = -i * ideal(gate.speed);
      const command = { forward: gate.forward ?? 0, side: gate.side ?? SIDE_SPEED, yaw };
      const tick = coreTick(core, bar, command);
      ticks.push(tick);
      samples.push({
        speed: tick.speed,
        grounded: tick.grounded,
        onLadder: tick.onLadder,
        events: tick.interrupted ? 1 : 0,
        delta: tick.delta,
      });
    }
    if (!gate.check(samples)) throw new Error(`The ${gate.name} gate did not fire: ${JSON.stringify(samples)}`);
    result.push({ name: `core gate: ${gate.name}`, ticks });
  }
  return result;
}

/** Holding yaw along the velocity's normal is the best turn; `pace` is how far the command turned to get there. */
async function gainScenarios(bar: BarCore): Promise<Scenario[]> {
  const core = await bar.create();
  core.loadMapPhysics(gateMap([], []));
  const begin = (speed: number) => {
    core.setSettings(settings(bar.defaults));
    core.reset();
    bar.setPosition(core, 0, 0, HIGH, 0);
    core.x.set_velocity(speed, 0, 0);
  };
  const SPEED = 400;

  // W pointing straight across the velocity on a turn of 152.6% pace, the fastest W-only speed gain there is.
  begin(SPEED);
  const wOnlyTurn = 1.526 * ideal(SPEED);
  const wOnly = [
    coreTick(core, bar, { forward: 0, side: 0, yaw: -90 + wOnlyTurn }),
    coreTick(core, bar, { forward: SIDE_SPEED, side: 0, yaw: -90 }),
  ];

  // D at 100% for a tick puts the velocity where the next tick's 180% turn still gains a little.
  begin(SPEED);
  const fast: Tick[] = [coreTick(core, bar, { forward: 0, side: 0, yaw: ideal(SPEED) })];
  fast.push(coreTick(core, bar, { forward: 0, side: SIDE_SPEED, yaw: 0 }));
  fast.push(coreTick(core, bar, { forward: 0, side: SIDE_SPEED, yaw: -1.8 * ideal(SPEED) }));

  // Turning D too far past the normal takes speed away. Then a turn that lands on the normal gains it back.
  begin(SPEED);
  const overturn = (Math.asin(40 / SPEED) * 180) / Math.PI;
  const lossToGain: Tick[] = [
    coreTick(core, bar, { forward: 0, side: 0, yaw: 0 }),
    coreTick(core, bar, { forward: 0, side: SIDE_SPEED, yaw: -overturn }),
  ];
  const { velocity } = core.state();
  const alongVelocity = (Math.atan2(velocity[1], velocity[0]) * 180) / Math.PI;
  lossToGain.push(coreTick(core, bar, { forward: 0, side: SIDE_SPEED, yaw: alongVelocity }));

  const sweep = (smoothing: number): Scenario => {
    begin(SPEED);
    const ticks: Tick[] = [coreTick(core, bar, { forward: 0, side: 0, yaw: 0 })];
    let yaw = 0;
    for (let i = 0; i < 80; i++) {
      const pace = [1, 1.2, 0.8, 1.5][Math.floor(i / 20)];
      const side = i < 40 ? SIDE_SPEED : -SIDE_SPEED;
      yaw -= Math.sign(side) * ideal(ticks[ticks.length - 1].speed) * pace;
      ticks.push(coreTick(core, bar, { forward: 0, side, yaw }));
    }
    return { name: `core sweep, smoothing ${smoothing}`, smoothing, ticks };
  };

  return [
    { name: "core: W across the velocity at 152.6%", smoothing: 1, ticks: wOnly },
    { name: "core: D at 180%", smoothing: 1, ticks: fast },
    { name: "core: loss, then gain", smoothing: 1, ticks: lossToGain },
    sweep(1),
    sweep(8),
    sweep(20),
  ];
}

function requireCoreFacts(
  scenarios: { name: string; ticks: { band: string; bar: number | null; delta: number | null }[] }[],
) {
  const named = (name: string) => {
    const found = scenarios.find((scenario) => scenario.name === name);
    if (!found) throw new Error(`Missing scenario ${name}`);
    return found.ticks;
  };
  const wOnly = named("core: W across the velocity at 152.6%").at(-1)!;
  if (wOnly.band !== "perfect" || Math.abs(wOnly.bar! - 152.6) > 0.5) {
    throw new Error(`W-only at 152.6%: ${JSON.stringify(wOnly)}`);
  }
  const fast = named("core: D at 180%").at(-1)!;
  if (fast.band !== "ok" || !(fast.delta! > 0) || Math.abs(fast.bar! - 180) > 1) {
    throw new Error(`D at 180%: ${JSON.stringify(fast)}`);
  }
  const bands = named("core: loss, then gain").map((tick) => tick.band);
  if (!bands.includes("high") || bands.at(-1) === "high" || bands.indexOf("high") > bands.lastIndexOf("perfect")) {
    throw new Error(`Loss then gain: ${bands.join(" ")}`);
  }
}

function runScenario(web: BarWeb, scenario: Scenario) {
  const { name, smoothing = 8, dimBelow = 0, style = "autohop", ticks } = scenario;
  const trainer = new web.StrafeTrainer();
  trainer.smoothing = smoothing;
  // Hud.configure: the Bar's zone is fixed, whatever the setting holds.
  trainer.zone = 10;
  const view = new web.StrafeTrainerView();
  view.configure({
    follow: true,
    zone: 30,
    dimBelow,
    color: "#ffffff",
    height: 1,
    style: "bar",
    hints: true,
    showPace: true,
  });
  const sample = { dt: DT, maxSpeed: MAX_SPEED, airAccelerate: AIR_ACCELERATE, style };
  const expected = ticks.map((tick) => {
    const command = { forward: tick.forward, side: tick.side, yaw: tick.yaw, pitch: 0, buttons: 0 };
    trainer.feed(command, {
      ...sample,
      tick: tick.tick,
      speed: tick.speed,
      grounded: tick.grounded,
      onLadder: tick.onLadder,
      jumped: tick.jumped,
      interrupted: tick.interrupted,
      airSpeedGain: tick.delta ?? NaN,
      airBestGain: tick.best ?? NaN,
    });
    view.render(trainer.reading, trainer.lastJump);
    const rail = view.el.children[0] as ViewElement;
    const fill = rail.children[3] as ViewElement;
    const reading = view.el.children[1] as ViewElement;
    return {
      in: tick,
      delta: tick.delta,
      pace: trainer.reading.pace,
      bar: trainer.reading.bar ?? null,
      barSide: trainer.reading.barSide ?? 0,
      gain: trainer.reading.gain ?? null,
      lastJump: trainer.lastJump,
      fill: Number.parseFloat(fill.style.transform.slice("scaleX(".length)),
      edge: view.el.dataset.edge,
      band: view.el.dataset.band,
      text: (reading.children[0] as ViewElement).textContent,
      hint: (reading.children[1] as ViewElement).textContent,
      dim: view.el.classes.has("st-dim"),
    };
  });
  return { name, smoothing, style, dimBelow, ticks: expected };
}

/** A reading with no gain is what a preview without a synthetic gain has: it must stay neutral. */
function previews(web: BarWeb) {
  const readings: Reading[] = [
    { cue: "good", pace: 100, side: 1 },
    { cue: "good", pace: 100, side: -1, gain: 1 },
    { cue: "slow", pace: 50, side: 1, bar: 50, barSide: 1, gain: 0.5 },
    { cue: "ready", pace: null, side: 0 },
    { cue: "unsupported", pace: null, side: 0 },
  ];
  return readings.map((reading) => {
    const view = new web.StrafeTrainerView();
    view.configure({
      follow: false,
      zone: 10,
      dimBelow: 0,
      color: "#ffffff",
      height: 1,
      style: "bar",
      hints: true,
      showPace: true,
    });
    view.render(reading, null);
    const fill = (view.el.children[0] as ViewElement).children[3] as ViewElement;
    return {
      reading: { ...reading, gain: reading.gain ?? null, bar: reading.bar ?? null, barSide: reading.barSide ?? 0 },
      band: view.el.dataset.band,
      edge: view.el.dataset.edge,
      fill: Number.parseFloat(fill.style.transform.slice("scaleX(".length)),
      hint: ((view.el.children[1] as ViewElement).children[1] as ViewElement).textContent,
    };
  });
}

export async function barVectors(web: BarWeb, core: BarCore) {
  const colours = [
    { ratio: -1 },
    { ratio: 0 },
    { ratio: 0.1 },
    { ratio: 0.9 },
    { ratio: 0.900001 },
    { ratio: 0.99 },
    { ratio: 0.990001 },
    { ratio: 1 },
    { ratio: 1.03 },
    { ratio: null },
  ].map(({ ratio }) => ({ ratio, band: web.barBand(ratio) }));
  const gains = [
    [0.0001, 0.45],
    [-0.0001, 0.45],
    [0.000101, 0.45],
    [-0.000101, 0.45],
    [1, 0],
    [1, -1],
  ].map(([delta, best]) => ({ delta, best, gain: web.barGain(delta, best) }));
  const scenarios = [
    ...pureColourScenarios(),
    ...geometryScenarios(),
    ...wOnlyScenarios(),
    scripted("random", randomSteps(1, 1500)),
    scripted("random, short window", randomSteps(2, 1500), { smoothing: 3 }),
    ...(await gainScenarios(core)),
    ...(await gateScenarios(core)),
  ].map((scenario) => runScenario(web, scenario));
  requireCoreFacts(scenarios);
  return {
    dt: DT,
    maxSpeed: MAX_SPEED,
    airAccelerate: AIR_ACCELERATE,
    colours,
    gains,
    previews: previews(web),
    scenarios,
  };
}
