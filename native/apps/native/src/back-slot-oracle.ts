// The website's back items (player/back-fx.ts, player/robe-fx.ts, loadout.ts) over a fixed movement stream and a set of
// packed options; back_slot_tests.cpp replays the same and must land on the same uniforms, tones and options.
import { writeFile } from "node:fs/promises";
import { Object3D, Skeleton } from "three";
import {
  advanceBack,
  backMotion,
  backUniform,
  backUniformMid,
  backUniformTip,
  capeTones,
  type BackKind,
} from "../../web/src/player/back-fx";
import { advanceSleeves, robeTones, sleeveMotion, sleeveUniform } from "../../web/src/player/robe-fx";
import { RobeSleeves } from "../../web/src/viewmodel/robe-sleeves";
import { playerUniforms } from "../../web/src/player/materials";
import { packCape, packRobe, unpackCape, unpackRobe, type CosmeticLoadout } from "../../web/src/loadout";

interface Step {
  velocity: [number, number, number];
  yaw: number;
  dt: number;
  jumped: boolean;
  snap: boolean;
}

/** Running up to 1,500 u/s while turning, hopping every half second, a sideways stretch, a snap and a stop. */
function movementStream(): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < 720; i++) {
    const seconds = i / 120;
    const speed = i < 600 ? Math.min(1500, i * 5) : 0;
    const yaw = 50 * Math.sin(seconds * 2.3);
    const heading = ((yaw + (i > 360 && i < 480 ? 90 : 0)) * Math.PI) / 180;
    const phase = seconds % 0.5;
    const velocity: [number, number, number] = [
      speed * Math.cos(heading),
      speed * Math.sin(heading),
      i < 600 ? 290 - 800 * phase : 0,
    ];
    const jumped = i < 600 && phase < 1 / 120;
    steps.push({ velocity, yaw, dt: i % 9 === 0 ? 1 / 30 : 1 / 144, jumped, snap: i === 300 });
  }
  return steps;
}

const KINDS: BackKind[] = ["key", "pinwheel", "cape", "balloon", "jet", "wings", "pack", "blade", "robe"];
const steps = movementStream();
const runs = [];
for (const kind of KINDS)
  for (const variant of kind === "cape" ? [1, 1.8, 2.6] : kind === "robe" ? [0, 1] : [1]) {
    const motion = backMotion();
    const len = kind === "cape" ? variant : 1;
    const tied = kind === "robe" && variant === 1;
    const uniforms: number[][] = [];
    for (const step of steps) {
      advanceBack(motion, kind, step.velocity, step.yaw, step.jumped, step.dt, step.snap, false, len, tied);
      const speed = Math.hypot(step.velocity[0], step.velocity[1]);
      const back = backUniform(motion, kind, speed);
      uniforms.push([...back, ...backUniformTip(motion, kind), ...backUniformMid(motion, kind, back, len)]);
    }
    runs.push({ kind, len, tied, uniforms });
  }

const sleeves = sleeveMotion();
const sleeveUniforms: number[][] = [];
steps.forEach((step, i) => {
  const swing = 6 * Math.sin(i / 11);
  const anchors = [2 + swing, 12, 40, 2 - swing, -12, 40 + swing / 3];
  advanceSleeves(sleeves, anchors, step.velocity, step.yaw, step.dt, step.snap, false);
  sleeveUniforms.push([...sleeveUniform(sleeves, 0), ...sleeveUniform(sleeves, 1)]);
});

// The first-person sleeves' lag: the class keeps its springs private, so it is stepped through its uniforms.
const fpUniforms = playerUniforms();
const fp = new RobeSleeves(new Object3D(), new Skeleton([]), fpUniforms);
(fp as unknown as { mesh: object }).mesh = {};
const fpSleeveUniforms: number[][] = [];
steps.forEach((step, i) => {
  fp.update(step.dt, { velocity: step.velocity, yaw: step.yaw }, i < 500 ? 1 : 0.45, i > 600);
  fpSleeveUniforms.push(fpUniforms.uRobeL.value.toArray());
});

const accent: [number, number, number] = [0.8, 0.12, 0.05];
const pants: [number, number, number] = [0.03, 0.035, 0.04];
const picks: (number | null)[] = [null, 0x000000, 0xffffff, 0x3a7bd5, 0xf0f0f0, 0x101010, 0xc81e1e];
const tones = [];
for (const a of picks)
  for (const b of picks)
    tones.push({ outer: a, lining: b, cape: capeTones(accent, a, b), robe: robeTones(pants, accent, a, b) });

const loadouts: Partial<CosmeticLoadout>[] = [
  { back: "back-cape" },
  { back: "back-cape", capeLength: 185 },
  { back: "back-cape", capeLength: 260, capeColor: 0x3a7bd5, capeLining: 0xffffff },
  { back: "back-cape", capeLining: 0x101010 },
  { back: "back-robe", robePattern: 3 },
  { back: "back-robe", robeTied: true, robeColor: 0xc81e1e },
  { back: "back-robe", robePattern: 4, robeTied: true, robeColor: 0x000000, robePrint: 0xf0f0f0 },
];
const fields = [
  ...loadouts.map((l) => ({
    field: l.back === "back-robe" ? packRobe(l as CosmeticLoadout) : packCape(l as CosmeticLoadout),
    robe: l.back === "back-robe",
  })),
  ...["", "z", "!!", "zz", "0", "4k", "0g000", "0w", "0f", "AA", "40000"].flatMap((field) => [
    { field, robe: false },
    { field, robe: true },
  ]),
];
const options = fields.map(({ field, robe }) => ({ field, robe, value: robe ? unpackRobe(field) : unpackCape(field) }));

await writeFile(
  process.argv[2],
  JSON.stringify({ steps, runs, sleeveUniforms, fpSleeveUniforms, accent, pants, tones, options }),
);
