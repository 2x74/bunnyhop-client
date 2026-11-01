// Golden vectors for the strafe trainer's Bar look (apps/native/src/strafe_trainer_bar_tests.cpp).
//
// Feeds scripted ticks through the web's StrafeTrainer and bar functions (apps/web/src/hud/strafe-trainer.ts, imported
// from a checkout) and records every tick. The C++ test feeds the same ticks through native::StrafeTrainer.
//
// Usage: bun tools/strafe-trainer-bar/generate-vectors.ts --web /path/to/bunnyhop
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    web: { type: "string" },
    out: { type: "string", default: "apps/native/src/strafe_trainer_bar_vectors.json" },
  },
});
if (!values.web) throw new Error("Pass --web /path/to/bunnyhop");
const web = resolve(values.web, "apps/web/src");
const mirror = resolve(import.meta.dir, "../../target/strafe-trainer-bar-oracle");
mkdirSync(mirror, { recursive: true });

function mirrored(path: string, change: (text: string) => string): string {
  const file = resolve(mirror, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, change(readFileSync(resolve(web, path), "utf8")));
  return file;
}
const withoutTypeImports = (text: string) => text.replace(/^import type .*;\n/gm, "");
const trainerModule = await import(mirrored("hud/strafe-trainer.ts", withoutTypeImports));
const paletteModule = await import(
  mirrored("palette.ts", (text) =>
    text.replace(
      /^import .*;$/m,
      "const DEFAULT_TRIGGER_PREFS = { colors: {} }; const KINDS = []; type KindId = string;",
    ),
  )
);
const { StrafeTrainer, barBand, barEdge, barFill } = trainerModule;

const DT = 0.01;
const SPEED = 400;
const ideal = (Math.atan2(30, SPEED) * 180) / Math.PI;

/** A tick: [pace share of ideal, side, overrides]. Side 1 is D, which turns right, so yaw falls. */
type Overrides = {
  speed?: number;
  grounded?: boolean;
  onLadder?: boolean;
  jumped?: boolean;
  interrupted?: boolean;
  againstKey?: boolean;
  gap?: number;
};
type Step = [pace: number, side: number, overrides?: Overrides];
const repeat = (count: number, step: Step): Step[] => Array.from({ length: count }, () => step);

const named: { name: string; smoothing?: number; zone?: number; style?: string; steps: Step[] }[] = [
  ...[1, 0.8, 0.55, 0.25].map((pace) => ({ name: `D at ${pace * 100}%`, steps: repeat(8, [pace, 1]) })),
  ...[1, 1.2, 1.5, 1.8].map((pace) => ({ name: `A at ${pace * 100}%`, steps: repeat(8, [pace, -1]) })),
  { name: "D past the far end", steps: repeat(8, [3, 1]) },
  { name: "under 100 u/s", steps: repeat(8, [1, 1, { speed: 99 }]) },
  { name: "no key", steps: repeat(8, [1, 0]) },
  { name: "against the key", steps: repeat(8, [1, 1, { againstKey: true }]) },
  { name: "strafe switch", steps: [...repeat(8, [1, 1]), ...repeat(8, [1, -1])] },
  {
    name: "one ground tick, then a second",
    steps: [...repeat(8, [1, -1]), [0, -1, { grounded: true }], [0, -1, { grounded: true }]],
  },
  { name: "keys let go", steps: [...repeat(8, [1, -1]), ...repeat(4, [1, 0])] },
  { name: "teleport", steps: [...repeat(8, [1, -1]), [1, -1, { interrupted: true }]] },
  { name: "tick gap", steps: [...repeat(8, [1, -1]), [1, -1, { gap: 5 }]] },
  { name: "smoothing 1", smoothing: 1, steps: repeat(3, [1, 1]) },
  { name: "unsupported style", style: "wonly", steps: repeat(4, [1, 1]) },
  {
    name: "last jump",
    steps: [...repeat(6, [0.9, 1]), [0, 1, { grounded: true }], ...repeat(3, [1, 1]), [0, 1, { jumped: true }]],
  },
  { name: "ladder keeps no jump", steps: [...repeat(6, [1, 1]), [1, 1, { onLadder: true }]] },
  { name: "longest window", smoothing: 50, steps: repeat(60, [1, 1]) },
  ...[20, 5, 30].map((zone) => ({
    name: `zone ${zone}`,
    zone,
    smoothing: 1,
    steps: [
      [1.15, 1],
      [1.25, 1],
      [1.35, 1],
      [0.65, 1],
      [0.01, 1],
    ] as Step[],
  })),
];

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
    const overrides: Overrides = {};
    if (roll < 0.05) overrides.grounded = true;
    else if (roll < 0.06) overrides.onLadder = true;
    else if (roll < 0.07) overrides.interrupted = true;
    else if (roll < 0.08) overrides.speed = 50;
    else if (roll < 0.1) overrides.jumped = true;
    else if (roll < 0.12) overrides.againstKey = true;
    const side = next() < 0.1 ? 0 : next() < 0.5 ? 1 : -1;
    steps.push([next() * 2.2, side, overrides]);
  }
  return steps;
}
const scenarios = [
  ...named,
  { name: "random", steps: randomSteps(1, 1500) },
  { name: "random, short window", smoothing: 3, zone: 5, steps: randomSteps(2, 1500) },
].map(({ name, smoothing = 8, zone = 10, style = "autohop", steps }) => {
  const trainer = new StrafeTrainer();
  trainer.smoothing = smoothing;
  trainer.zone = zone;
  const sample = { speed: SPEED, grounded: false, onLadder: false, dt: DT, maxSpeed: 250, airAccelerate: 1000, style };
  let tick = 0;
  let yaw = 0;
  trainer.feed({ forward: 0, side: 450, yaw, pitch: 0, buttons: 0 }, { ...sample, tick });
  const ticks = steps.map(([pace, side, overrides = {}]) => {
    const { againstKey, gap, ...state } = overrides;
    tick += 1 + (gap ?? 0);
    // A float, as a command's yaw is in both games.
    yaw = Math.fround(yaw - (againstKey ? -1 : 1) * side * ideal * pace);
    const cmd = { forward: 0, side: side * 450, yaw, pitch: 0, buttons: 0 };
    trainer.feed(cmd, { ...sample, ...state, tick });
    const reading = trainer.reading;
    const value = reading.bar ?? reading.pace;
    return {
      in: {
        tick,
        yaw,
        side: cmd.side,
        speed: SPEED,
        grounded: false,
        onLadder: false,
        jumped: false,
        interrupted: false,
        ...state,
      },
      pace: reading.pace,
      bar: reading.bar ?? null,
      barSide: reading.barSide ?? 0,
      lastJump: trainer.lastJump,
      fill: Math.round(barFill(value) * 1000) / 1000,
      edge: barEdge(reading.barSide ?? reading.side),
      band: value === null ? "" : barBand(value, zone),
    };
  });
  return { name, smoothing, zone, style, ticks };
});

const palettes = Object.fromEntries(
  Object.entries(paletteModule.PALETTES as Record<string, { trainer: { perfect: string } }>).map(([mode, palette]) => [
    mode,
    palette.trainer.perfect,
  ]),
);
const vectors = { dt: DT, maxSpeed: 250, airAccelerate: 1000, palettes, scenarios };
writeFileSync(values.out!, JSON.stringify(vectors) + "\n");
const ticks = scenarios.reduce((total, scenario) => total + scenario.ticks.length, 0);
console.log(`${scenarios.length} scenarios, ${ticks} ticks -> ${values.out}`);
