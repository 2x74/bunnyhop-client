// Jump stats (!ssj) and the JHUD over a whole replay, from the viewer's cached ticks (viewer/player.ts RunData). DOM-free:
// the replay HUD (viewer/hud.ts) and head to head's jump table (h2h/jumps.ts) share it.

import { SsjTracker, type SsjCmd, type SsjMode, type SsjReport, type SsjState, type SsjTick } from "../ssj/stats";
import { JhudTracker, type JhudReport } from "../ssj/jhud";
import { F_GROUNDED, F_JUMPED, F_LADDER, F_TELEPORTED, STATUS_RUNNING, type RunData } from "./player";

/**
 * Jump stats (!ssj) over a whole replay, from its cached ticks exactly as the live game computes them (ssj/index.ts
 * LiveSsj): the state before each tick, the command stepped, the timer before the tick. Sorted by tick.
 */
export function replaySsj(d: RunData, mode: SsjMode): { tick: number; report: SsjReport }[] {
  const t = new SsjTracker(mode);
  const out: { tick: number; report: SsjReport }[] = [];
  eachReplayTick(d, (k, pre, cmd, at) => {
    const r = t.tick(pre, cmd, at);
    if (r) out.push({ tick: k, report: r });
  });
  return out;
}

/** The JHUD over a whole replay, the same way (ssj/index.ts LiveSsj). */
export function replayJhud(d: RunData): { tick: number; report: JhudReport }[] {
  const t = new JhudTracker();
  const out: { tick: number; report: JhudReport }[] = [];
  eachReplayTick(d, (k, pre, cmd, at) => {
    const r = t.tick(pre, cmd, { jumped: at.jumped, inStart: at.inStart, time: at.time });
    if (r) out.push({ tick: k, report: r });
  });
  return out;
}

function eachReplayTick(d: RunData, fn: (k: number, pre: SsjState, cmd: SsjCmd, t: SsjTick) => void): void {
  const pre = { position: [0, 0, 0], velocity: [0, 0, 0], grounded: false, onLadder: false };
  const cmd = { forward: 0, side: 0, yaw: 0, buttons: 0 };
  for (let k = 1; k <= d.n; k++) {
    const p = k - 1;
    for (let a = 0; a < 3; a++) (pre.position[a] = d.pos[p * 3 + a]), (pre.velocity[a] = d.vel[p * 3 + a]);
    pre.grounded = (d.flags[p] & F_GROUNDED) !== 0;
    pre.onLadder = (d.flags[p] & F_LADDER) !== 0;
    cmd.forward = d.forward[k];
    cmd.side = d.side[k];
    cmd.yaw = d.view[k * 2];
    cmd.buttons = d.buttons[k];
    fn(k, pre, cmd, {
      jumped: (d.flags[k] & F_JUMPED) !== 0,
      teleported: (d.flags[k] & F_TELEPORTED) !== 0,
      inStart: d.inStart[p] === 1,
      time: d.status[p] === STATUS_RUNNING ? d.runTicks[p] * d.interval : null,
    });
  }
}
