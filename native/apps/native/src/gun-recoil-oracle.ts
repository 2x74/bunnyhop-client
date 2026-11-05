// The website's gun recoil over fixed streams of frames (guns/anim.ts GunAnimator: fire, dryFire, draw, setGun), and
// where it puts the gun and the right hand (guns/pose.ts GunPoser) next to the same gun left alone. gun_recoil_tests.cpp
// replays the streams on the C++ port and compares every frame.
import { writeFile } from "node:fs/promises";
import { GunAnimator } from "../../web/src/viewmodel/guns/anim";
import { GunPoser } from "../../web/src/viewmodel/guns/pose";
import { gunRig } from "../../web/src/viewmodel/guns/rig";
import { gunById } from "../../web/src/viewmodel/guns/index";
import type { GunDef } from "../../web/src/viewmodel/guns/types";

const FRAME_SECONDS = [1 / 30, 1 / 144, 1 / 60, 1 / 240, 1 / 97];

type Event = "shot" | "dry" | "draw" | `gun:${string}` | "";

interface Stream {
  gun: string;
  /** Seconds at which each event happens (applied on the first frame at or after it, before that frame's update). */
  events: [number, Event][];
  seconds: number;
}

/** A Glock burst is three rounds 6 ticks apart (core.ts: the burst-mode Glock as on srcds). */
const burst = (at: number): [number, Event][] => [0, 0.06, 0.12].map((d) => [at + d, "shot"]);

const STREAMS: Stream[] = [
  { gun: "glock", events: [...burst(0.2), ...burst(0.9), [1.6, "draw"], ...burst(1.75)], seconds: 3 },
  {
    gun: "p90",
    events: [...Array.from({ length: 16 }, (_, k): [number, Event] => [0.1 + k * 0.07, "shot"]), [1.6, "dry"]],
    seconds: 2.6,
  },
  {
    gun: "usp",
    events: [
      [0.1, "shot"],
      [0.6, "shot"],
      [0.9, "gun:ak47"],
      [1.0, "shot"],
      [1.1, "shot"],
      [1.5, "gun:usp"],
      [1.6, "shot"],
    ],
    seconds: 2.4,
  },
  {
    gun: "awp",
    events: [
      [0.05, "shot"],
      [1.3, "shot"],
    ],
    seconds: 2.5,
  },
];

/** The recoil springs' values: pitch, back, roll, yaw, sink (private to the animator). */
function springValues(anim: GunAnimator): number[] {
  return Array.from((anim as unknown as { rx: Float64Array }).rx);
}

function apply(anim: GunAnimator, event: Event): void {
  if (event === "shot") anim.fire();
  else if (event === "dry") anim.dryFire();
  else if (event === "draw") anim.draw();
  else if (event.startsWith("gun:")) anim.setGun(gunById(event.slice(4))!);
}

function record(stream: Stream) {
  const anim = new GunAnimator(gunById(stream.gun)!);
  anim.setGun(gunById(stream.gun)!);
  const frames = [];
  let time = 0;
  let next = 0;
  for (let f = 0; time < stream.seconds; f++) {
    const dt = FRAME_SECONDS[f % FRAME_SECONDS.length];
    const events: Event[] = [];
    while (next < stream.events.length && stream.events[next][0] <= time) events.push(stream.events[next++][1]);
    for (const event of events) apply(anim, event);
    anim.update(dt);
    time += dt;
    frames.push({ dt, events, springs: springValues(anim) });
  }
  return { gun: stream.gun, recoil: recoilOf(gunById(stream.gun)!), frames };
}

function recoilOf(def: GunDef) {
  const { kick, back, roll, settle } = def.recoil;
  return { kick, back, roll, settle };
}

/** A Furrow fired every 0.1 s next to one left idle: the gun bone and right hand of both, and the springs. */
function placement() {
  const def = gunById("ak47")!;
  const rig = gunRig();
  const gun = rig.part("Gun") * 12;
  const hand = rig.hands.bone("Right_Hand") * 12;
  const fired = new GunPoser();
  const still = new GunPoser();
  fired.setGun(def, "knit");
  still.setGun(def, "knit");
  const frames = [];
  for (let f = 0; f < 240; f++) {
    const dt = FRAME_SECONDS[f % FRAME_SECONDS.length];
    const shot = f % 9 === 0 && f < 150;
    if (shot) fired.anim.fire();
    fired.update(dt);
    still.update(dt);
    frames.push({
      dt,
      shot,
      springs: springValues(fired.anim),
      gun: [Array.from(still.bonesW.slice(gun, gun + 12)), Array.from(fired.bonesW.slice(gun, gun + 12))],
      hand: [Array.from(still.bonesW.slice(hand, hand + 12)), Array.from(fired.bonesW.slice(hand, hand + 12))],
    });
  }
  return { grip: Array.from(def.right.o), frames };
}

await writeFile(
  process.argv[2] ?? "gun-recoil-oracle.json",
  JSON.stringify({
    streams: STREAMS.map(record),
    recoil: Object.fromEntries(["glock", "usp", "p90", "ak47", "awp"].map((id) => [id, recoilOf(gunById(id)!)])),
    placement: placement(),
  }),
);
