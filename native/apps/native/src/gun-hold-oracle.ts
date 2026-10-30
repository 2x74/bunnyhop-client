// The website's two-handed gun hold (player/bunny/gun-hold.ts) over a fixed stream of aims, shots, reloads and a
// snap, for usp, m3, ak47 and awp. gun_hold_tests.cpp replays the same stream on the C++ port and compares the arm
// bones, the gun's two bones and the muzzle frame by frame.
import { writeFile } from "node:fs/promises";
import { rig } from "../../web/src/player/bunny/rig";
import { fistFrames, GunHold } from "../../web/src/player/bunny/gun-hold";
import { bunnyHold } from "../../web/src/viewmodel/guns/meshes";
import { gunById } from "../../web/src/viewmodel/guns/index";
import { holdData } from "./gun-hold-data";

// Shots jitter their kick with Math.random; the port takes the same numbers as arguments.
const JITTER = 0.5;
Math.random = () => JITTER;
const FRAMES = 90;
const SHOT_FRAMES = new Set([6, 40, 41]);
const RELOAD_FRAME = 14;
const SNAP_FRAME = 70;

interface Event {
  shot: boolean;
  reload: boolean;
}

function eventAt(frame: number): Event {
  return { shot: SHOT_FRAMES.has(frame), reload: frame === RELOAD_FRAME };
}

function aimAt(frame: number) {
  return {
    yaw: 25 * Math.sin(frame / 9),
    pitch: -35 + frame * 0.9,
    dt: frame % 5 === 0 ? 1 / 30 : 1 / 144,
    snap: frame === SNAP_FRAME,
  };
}

const r = rig();
const runs = [];
for (const id of ["usp", "m3", "ak47", "awp"]) {
  const def = gunById(id)!;
  const data = bunnyHold(def);
  const hold = new GunHold(r);
  hold.setGun(data, true);
  hold.silenced = id === "usp";
  const frames = [];
  for (let frame = 0; frame < FRAMES; frame++) {
    // The rest pose every frame, as the animation hands the hold a fresh pose.
    const S = new Float32Array(r.names.length * 12);
    for (let b = 0; b < r.names.length; b++) S.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], b * 12);
    const event = eventAt(frame);
    if (event.shot) hold.shot();
    if (event.reload) {
      const shells = def.timing.shells;
      hold.reload(shells ? shells.each : (def.timing.reload ?? 2), !!shells, id === "ak47");
    }
    const aim = aimAt(frame);
    hold.apply(S, { ...aim, crouched: false, grounded: true, speed: 0, still: false });
    frames.push({
      ...aim,
      ...event,
      skinning: Array.from(S),
      skin: Array.from(hold.skin),
      muzzle: Array.from(hold.muzzle),
    });
  }
  runs.push({ id, hold: holdData(data), silenced: hold.silenced, frames });
}
const fists = fistFrames(r);
const out = {
  jitter: JITTER,
  rig: { names: r.names, parent: Array.from(r.parent), bind: Array.from(r.bind), csBones: r.csBones },
  fists: { R: Array.from(fists.R), L: Array.from(fists.L), Rinv: Array.from(fists.Rinv), Linv: Array.from(fists.Linv) },
  runs,
};
await writeFile(process.argv[2] ?? "gun-hold-oracle.json", JSON.stringify(out));
