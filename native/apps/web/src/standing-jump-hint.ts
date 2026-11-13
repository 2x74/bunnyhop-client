// A new player who holds W and jump from a standstill hops in place at about 30 u/s: with no time on the ground there is
// nothing to speed up from (correct CS:S movement), and once play starts nothing says why. After three such jumps in a
// row, one line says what to do. Only on a player's first few visits and until their first finish; once said, or once
// they finish a map, never again. Not in the tutorial (its coach covers this) or a room. Pure counters from main.ts's
// tick (StuckHint's shape).

const KEY = "bunnyhop:standing-jump-hint";
const EVENT_JUMPED = 1 << 1;
/** Visits it can show on (a visit = a map load). */
const MAX_VISITS = 5;
/** Slow jumps with W held, in a row, before the line. */
const JUMPS = 3;
/** Takeoff speed under this (u/s) is a jump from a standstill or near it (W from rest gives 30). */
const SLOW = 40;

export const STANDING_JUMP_LINE = "Let go of jump and run forward first: jumping from a standstill keeps you slow.";

const read = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const write = (v: string) => {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* storage blocked: once per page */
  }
};

export class StandingJumpHint {
  private slow = 0;
  private done = false;

  /** This visit's hint, or null: said before (or a map finished since), or past the player's first visits. */
  static start(): StandingJumpHint | null {
    const v = read();
    if (v === "done") return null;
    const visits = Number(v) || 0;
    if (visits >= MAX_VISITS) return null;
    write(String(visits + 1));
    return new StandingJumpHint();
  }

  /** Every simulated tick: `forward` W held, `speed` the horizontal speed after it. True once, when to say the line. */
  tick(events: number, forward: boolean, speed: number, finished: boolean): boolean {
    if (this.done) return false;
    if (finished) return (this.end(), false);
    if (!(events & EVENT_JUMPED)) return false;
    this.slow = forward && speed < SLOW ? this.slow + 1 : 0;
    if (this.slow < JUMPS) return false;
    this.end();
    return true;
  }

  private end(): void {
    this.done = true;
    write("done");
  }
}
