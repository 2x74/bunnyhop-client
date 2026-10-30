// Test-only oracle: runs the web SSJ reference (apps/web/src/ssj/stats.ts) over a deterministic
// tick stream and records both the stream and every report it produced, so src/ssj_tests.cpp can
// replay the identical input through the C++ port and compare. No generated value is used by the
// native application.
//
// The stream does not have to be physical — SSJ only ever reads what it is handed — but it does
// have to reach every branch: ground chains longer than BHOP_FRAMES, the jump-from-start reset,
// ladders, noclip, teleports, the double jump-event guard, and keyless air ticks.
import { writeFileSync } from "node:fs";
import { SsjTracker, type SsjMode } from "../../web/src/ssj/stats";

const IN_JUMP = 1 << 1,
  IN_FORWARD = 1 << 3,
  IN_BACK = 1 << 4,
  IN_MOVELEFT = 1 << 9,
  IN_MOVERIGHT = 1 << 10;

/** xorshift32: the stream must be identical on every run, which Math.random is not. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export interface Tick {
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  onLadder: boolean;
  forward: number;
  side: number;
  yaw: number;
  buttons: number;
  jumped: boolean;
  teleported: boolean;
  inStart: boolean;
  noclip: boolean;
  time: number | null;
}

export function stream(seed: number, count: number): Tick[] {
  const random = rng(seed);
  const ticks: Tick[] = [];
  let x = 0,
    y = 0,
    z = 64,
    yaw = random() * 360,
    speed = 250 + random() * 900;
  let airborne = 0,
    groundLeft = 1 + Math.floor(random() * 3);
  let doubleFire = false;
  for (let i = 0; i < count; i++) {
    if (doubleFire) {
      // A second jump event with nothing sampled since the last one. It takes a grounded tick with
      // no jump key to produce one, which is what the plugin's double-fire guard is written for;
      // without this the guard is dead code that no stream reaches.
      doubleFire = false;
      const previous = ticks[ticks.length - 1];
      ticks.push({
        ...previous,
        grounded: true,
        onLadder: false,
        forward: 0,
        side: 0,
        buttons: 0,
        jumped: true,
        teleported: false,
        noclip: false,
      });
      groundLeft = 1;
      continue;
    }
    // Stands are either short or long enough to cross BHOP_FRAMES, and the lengths straddle it:
    // a stand of only 1 or of 12+ cannot tell a limit of 10 from one of 9.
    const standing = groundLeft > 0;
    const noclip = random() < 0.01;
    const onLadder = !standing && random() < 0.03;
    const inStart = i < 40 || random() < 0.02;
    const teleported = random() < 0.004;
    // Jump on the first ground tick of a short stand; a long stand sits past BHOP_FRAMES first.
    const jumping = standing && groundLeft === 1 && random() < 0.9;
    let buttons = jumping ? IN_JUMP : 0;
    // Keyless air ticks are deliberately common: the reference counts them as fully in sync.
    if (!standing && random() > 0.12) {
      buttons |= random() < 0.5 ? IN_MOVELEFT : IN_MOVERIGHT;
      if (random() < 0.8) buttons |= IN_FORWARD;
      if (random() < 0.05) buttons |= IN_BACK;
    }
    const forward = buttons & IN_FORWARD ? 450 : buttons & IN_BACK ? -450 : 0;
    const side = buttons & IN_MOVERIGHT ? 450 : buttons & IN_MOVELEFT ? -450 : 0;
    const radians = (yaw * Math.PI) / 180;
    ticks.push({
      px: x,
      py: y,
      pz: z,
      vx: Math.cos(radians) * speed,
      vy: Math.sin(radians) * speed,
      vz: airborne > 0 ? 100 - airborne * 8 : 0,
      grounded: standing,
      onLadder,
      forward,
      side,
      yaw,
      buttons,
      // A jump event lands on the tick the player leaves the ground. Two in a row with no air tick
      // between them exercises the plugin's double-fire guard.
      jumped: jumping || (random() < 0.004 && !standing),
      teleported,
      inStart,
      noclip,
      time: random() < 0.8 ? Number((i * 0.01).toFixed(3)) : null,
    });
    // Advance the crude kinematics.
    x += Math.cos(radians) * speed * 0.01;
    y += Math.sin(radians) * speed * 0.01;
    yaw += (random() - 0.5) * 9;
    speed += (random() - 0.45) * 14;
    speed = Math.max(80, Math.min(2200, speed));
    if (standing) {
      groundLeft--;
      if (jumping) {
        airborne = 18 + Math.floor(random() * 22);
        groundLeft = 0;
        doubleFire = random() < 0.06;
      }
    } else if (airborne > 0) {
      airborne--;
      z += (100 - airborne * 8) * 0.01;
      if (airborne === 0) {
        groundLeft = random() < 0.3 ? 8 + Math.floor(random() * 6) : 1;
        z = Math.round(z);
      }
    } else {
      groundLeft = 1;
    }
  }
  return ticks;
}

if (import.meta.main) {
  const modes: SsjMode[] = ["sixth", "every", "everySixth"];
  const cases = modes.flatMap((mode, index) =>
    [11, 97, 4242].map((seed) => {
      const ticks = stream(seed + index * 1000, 2600);
      const tracker = new SsjTracker(mode);
      const reports = ticks.map((t) =>
        tracker.tick(
          { position: [t.px, t.py, t.pz], velocity: [t.vx, t.vy, t.vz], grounded: t.grounded, onLadder: t.onLadder },
          { forward: t.forward, side: t.side, yaw: t.yaw, buttons: t.buttons },
          { jumped: t.jumped, teleported: t.teleported, inStart: t.inStart, noclip: t.noclip, time: t.time },
        ),
      );
      return { mode, seed, ticks, reports };
    }),
  );

  const out = process.argv[2];
  if (!out) throw new Error("usage: ssj_oracle.ts <output.json>");
  writeFileSync(out, JSON.stringify({ cases }));
  const total = cases.reduce((n, c) => n + c.reports.filter(Boolean).length, 0);
  console.log(`SSJ oracle: ${cases.length} cases, ${cases[0].ticks.length} ticks each, ${total} reports`);
}
