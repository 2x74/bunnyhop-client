// Golden vectors for native Release W on jump (apps/native/src/w_release_parity_tests.cpp).
//
// Runs scripted button and player-state streams through the web's WRelease and wReleaseAllowed (the vendored
// apps/web/src/w-release.ts) and records every command they produce. The C++ test feeds the same streams through
// native::WRelease and must match exactly.
//
// Usage: bun tools/w-release/generate-vectors.ts [--out apps/native/src/w_release_vectors.json]
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { WRelease, wReleaseAllowed, type WReleaseContext } from "../../apps/web/src/w-release";

const JUMP = 1 << 1;
const DUCK = 1 << 2;
const FORWARD = 1 << 3;
const BACK = 1 << 4;
const LEFT = 1 << 9;
const RIGHT = 1 << 10;
const RANDOM_COMMANDS = 2000;

type Place = "ground" | "air" | "ladder";
type Step = [buttons: number, place: Place] | "reset";

const context = (place: Place, autohop: boolean): WReleaseContext => ({
  grounded: place === "ground",
  onLadder: place === "ladder",
  autohop,
});

const repeat = <T>(count: number, item: T): T[] => Array.from({ length: count }, () => item);

const named: { name: string; autohop: boolean; steps: Step[] }[] = [
  {
    name: "jump holding W, airtime, landing brings it back",
    autohop: true,
    steps: [
      [FORWARD, "ground"],
      [FORWARD | JUMP, "ground"],
      ...repeat<Step>(60, [FORWARD | LEFT, "air"]),
      [FORWARD, "ground"],
    ],
  },
  {
    name: "autohop chain of perfect hops",
    autohop: true,
    steps: [
      [FORWARD | JUMP, "ground"],
      ...repeat<Step>(70, [FORWARD | JUMP | RIGHT, "air"]),
      [FORWARD | JUMP, "ground"],
      ...repeat<Step>(70, [FORWARD | JUMP | LEFT, "air"]),
      [FORWARD | JUMP, "ground"],
    ],
  },
  {
    name: "pressing W again in the air",
    autohop: true,
    steps: [
      [FORWARD | JUMP, "ground"],
      [FORWARD, "air"],
      [0, "air"],
      [FORWARD, "air"],
      [FORWARD, "air"],
    ],
  },
  {
    name: "scroll pulse without autohop",
    autohop: false,
    steps: [
      [FORWARD, "ground"],
      [FORWARD | JUMP, "ground"],
      [FORWARD, "air"],
      [FORWARD, "ground"],
    ],
  },
  {
    name: "jump held through a landing without autohop",
    autohop: false,
    steps: [
      [FORWARD | JUMP, "ground"],
      [FORWARD | JUMP, "air"],
      [FORWARD | JUMP, "ground"],
      [FORWARD | JUMP, "ground"],
    ],
  },
  {
    name: "jump without W",
    autohop: true,
    steps: [
      [JUMP, "ground"],
      [FORWARD, "air"],
    ],
  },
  {
    name: "null binds hand back from S",
    autohop: true,
    steps: [
      [FORWARD | JUMP, "ground"],
      [FORWARD, "air"],
      [BACK, "air"],
      [FORWARD, "air"],
    ],
  },
  {
    name: "ladder",
    autohop: true,
    steps: [
      [FORWARD | JUMP, "ground"],
      [FORWARD, "ladder"],
      [FORWARD, "air"],
    ],
  },
  {
    name: "only the forward bit changes",
    autohop: true,
    steps: [[FORWARD | JUMP | LEFT | DUCK | 1 | (3 << 14), "ground"]],
  },
  {
    name: "reset forgets what was held",
    autohop: false,
    steps: [[FORWARD | JUMP, "ground"], "reset", [FORWARD | JUMP, "air"], "reset", [FORWARD | JUMP, "ground"]],
  },
];

// The same stream on every run, so regenerating with an unchanged rule changes nothing.
function randomSteps(seed: number): Step[] {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const steps: Step[] = [];
  for (let i = 0; i < RANDOM_COMMANDS; i++) {
    if (next() < 0.002) {
      steps.push("reset");
      continue;
    }
    let buttons = 0;
    if (next() < 0.7) buttons |= FORWARD;
    if (next() < 0.1) buttons |= BACK;
    if (next() < 0.4) buttons |= JUMP;
    if (next() < 0.3) buttons |= LEFT;
    if (next() < 0.3) buttons |= RIGHT;
    const place = next();
    steps.push([buttons, place < 0.45 ? "ground" : place < 0.95 ? "air" : "ladder"]);
  }
  return steps;
}

function run(steps: Step[], autohop: boolean): number[][] {
  const rule = new WRelease();
  return steps.flatMap((step) => {
    if (step === "reset") {
      rule.reset();
      return [];
    }
    const [buttons, place] = step;
    return [[buttons, place === "ground" ? 0 : place === "air" ? 1 : 2, rule.apply(buttons, context(place, autohop))]];
  });
}

const scenarios = [
  ...named,
  { name: "random autohop", autohop: true, steps: randomSteps(1) },
  { name: "random without autohop", autohop: false, steps: randomSteps(2) },
].map(({ name, autohop, steps }) => ({
  name,
  autohop,
  // Places: 0 ground, 1 air, 2 ladder. A reset comes before the command at each index in `resets`.
  resets: steps.flatMap((step, index) =>
    step === "reset" ? [index - steps.slice(0, index).filter((s) => s === "reset").length] : [],
  ),
  commands: run(steps, autohop),
}));

const { values } = parseArgs({
  options: { out: { type: "string", default: "apps/native/src/w_release_vectors.json" } },
});
const styles = ["autohop", "legit", "scroll", "wonly", "sideways", "hsw", "lowgrav", "autostrafe", "segmented"];
const vectors = { allowed: Object.fromEntries(styles.map((style) => [style, wReleaseAllowed(style)])), scenarios };
writeFileSync(values.out!, JSON.stringify(vectors) + "\n");
const commands = scenarios.reduce((total, scenario) => total + scenario.commands.length, 0);
console.log(`${scenarios.length} scenarios, ${commands} commands -> ${values.out}`);
