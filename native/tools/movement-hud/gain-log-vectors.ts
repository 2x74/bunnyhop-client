// Gain log windows from the website's own GainLogTracker (apps/web/src/ssj/logs.ts), for gain_logs_tests.cpp: each
// scenario's ticks and the report (or none) the website makes on each. The scenarios are the website's
// test/ssj-logs.test.ts cases: whole windows, turn-bind jumps left out, four of six, three of six, short hops, standing
// still. Inputs are rounded to f32, as the core reports them.
// Usage: bun tools/movement-hud/gain-log-vectors.ts [--out path]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { GainLogTracker, gainLogText } from "../../apps/web/src/ssj/logs";
import { IN_LEFT } from "../../apps/web/src/turn-binds";
import manifest from "../../upstream-manifest.json";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { out: { type: "string" } } });
const output = resolve(values.out ?? resolve(import.meta.dir, "../../apps/native/src/gain_log_vectors.json"));

const IN_JUMP = 1 << 1;
const IN_MOVELEFT = 1 << 9;
const IN_MOVERIGHT = 1 << 10;
const f = Math.fround;

/** One tick as the C++ test feeds it: grounded, vx, vy, forward, side, yaw, buttons, jumped. */
type Tick = [boolean, number, number, number, number, number, number, boolean];

/**
 * Hops every `period` ticks (one ground tick, jump held), strafing A / D in the air while turning; `bind(jump, t)` says
 * whether that air tick turns with +left (the website test's `hop`).
 */
function hop(
  jumps: number,
  period = 70,
  bind: (jump: number, t: number) => boolean = () => false,
  lean: (t: number) => number = () => 3,
): Tick[] {
  const ticks: Tick[] = [];
  let jump = 0;
  for (let t = 0; jump < jumps; t++) {
    const k = t % period;
    const grounded = k < 1;
    const jumping = k === 0;
    const side = (t >> 3) & 1;
    const buttons =
      (jumping ? IN_JUMP : 0) | (side ? IN_MOVERIGHT : IN_MOVELEFT) | (!grounded && bind(jump, t) ? IN_LEFT : 0);
    const y = (t * 3 * Math.PI) / 180;
    const vx = f(300 * Math.cos(y) + lean(t) * Math.sin(y));
    const vy = f(300 * Math.sin(y) - lean(t) * Math.cos(y));
    ticks.push([grounded, vx, vy, 0, side ? 400 : -400, f(t * 3), buttons, jumping]);
    if (jumping) jump++;
  }
  return ticks;
}

/** Four hops, 30 ticks standing, then hops again (the website test's "standing still starts the count over"). */
function stop(): Tick[] {
  const ticks: Tick[] = [];
  for (let t = 0; t < 70 * 20; t++) {
    const still = t >= 4 * 70 && t < 4 * 70 + 30;
    const k = t % 70;
    const grounded = still || k === 0;
    const jumping = !still && k === 0;
    ticks.push([grounded, 300, 0, 0, 400, f(t), jumping ? IN_JUMP : 0, jumping]);
  }
  return ticks;
}

function run(name: string, ticks: Tick[]) {
  const tracker = new GainLogTracker();
  const expected = ticks.map(([grounded, vx, vy, forward, side, yaw, buttons, jumped]) => {
    const r = tracker.tick(
      { position: [0, 0, 0], velocity: [vx, vy, 0], grounded },
      { forward, side, yaw, buttons },
      {
        jumped,
      },
    );
    return r ? { ...r, text: gainLogText(r) } : null;
  });
  const reports = expected.filter((r) => r !== null).length;
  return { name, ticks, expected, reports };
}

const scenarios = [
  run("whole windows", hop(13)),
  run(
    "one turn-bind tick drops its jump",
    hop(13, 70, (j, t) => j === 8 && t % 70 === 30),
  ),
  run(
    "four of six still make a line",
    hop(13, 70, (j) => j === 7 || j === 8),
  ),
  run(
    "three of six make none",
    hop(13, 70, (j) => j >= 7 && j <= 9),
  ),
  run(
    "all turned with binds",
    hop(13, 70, () => true),
  ),
  run("50 air ticks a jump make none", hop(13, 50)),
  run("52 air ticks a jump", hop(13, 52)),
  run("standing still starts over", stop()),
  // Uneven strafes: the gain lands between whole numbers, so the rounding is checked too.
  run(
    "uneven strafes",
    hop(
      25,
      61,
      (j, t) => j === 15 && t % 61 === 9,
      (t) => 3 + 9 * Math.sin(t * 0.37),
    ),
  ),
];
writeFileSync(
  output,
  JSON.stringify({ generator: "native/tools/movement-hud/gain-log-vectors.ts", web: manifest.commit, scenarios }) +
    "\n",
);
console.log(scenarios.map((s) => `${s.name}: ${s.reports}`).join("\n"));
