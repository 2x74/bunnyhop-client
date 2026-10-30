// Release W on jump (Settings > Keys, off by default): a jump taken while holding forward lets go of forward for the
// airtime, like the CS:S bind `alias +wjump "+jump; -forward"`. Strafing keys are untouched and the physical key stays
// held; only the command changes. DOM-free: input.ts applies it to each command's resolved buttons, and the replay
// header records that the setting was on (replay.ts FLAG_W_RELEASE). research/W-RELEASE-JUMP.md has the rule and why.
//
// The recorded commands are the released ones (no IN_FORWARD bit, forwardmove 0), so re-simulation needs nothing new.

const IN_JUMP = 1 << 1;
const IN_FORWARD = 1 << 3;

/**
 * Styles where it works. Not Legit Scroll (strict CS:S keys, like null binds and turn binds), and not the styles that
 * strafe with W (W-Only, Sideways, Half-Sideways), where letting go of W would stop the strafe. Practice allows it in
 * every style (main.ts bindPolicy).
 */
export const wReleaseAllowed = (style: string): boolean => style !== "scroll" && style !== "wonly" && style !== "sideways" && style !== "hsw";

/** The player before this command runs (the pre-tick state, as the style filter reads it). */
export interface WReleaseContext {
  grounded: boolean;
  onLadder?: boolean;
  /** The run's settings: with autohop a held jump jumps on every landing; without, only a new press does. */
  autohop: boolean;
}

/**
 * Per-command state. The rule, from the pre-tick state:
 *   - On the ground: a command whose jump takes off (jump held with autohop, else a new jump press) and that holds
 *     forward goes out without forward, and forward stays released. Any other ground command brings forward back
 *     (it lands with W still held: walking / prestrafe as usual).
 *   - In the air: forward stays released until W is pressed again (forward 0 -> 1 in the resolved keys).
 *   - On a ladder: never released (W climbs).
 * Perfect hops have no ground command without a jump, so W stays released over a whole chain of hops.
 */
export class WRelease {
  private released = false;
  private lastForward = false;
  private lastJump = false;

  /** True while forward is held back (the next command without a new W press drops it). */
  get active(): boolean {
    return this.released;
  }

  /** `buttons` with forward released when the rule says so (only the IN_FORWARD bit changes). */
  apply(buttons: number, ctx: WReleaseContext): number {
    const forward = (buttons & IN_FORWARD) !== 0;
    const jump = (buttons & IN_JUMP) !== 0;
    if (forward && !this.lastForward) this.released = false; // W pressed again (in the air: forward comes back)
    if (ctx.onLadder) this.released = false;
    else if (ctx.grounded) this.released = forward && jump && (ctx.autohop || !this.lastJump);
    this.lastForward = forward;
    this.lastJump = jump;
    return this.released ? buttons & ~IN_FORWARD : buttons;
  }

  /** Forget everything (setting off, keys released, a new world). */
  reset(): void {
    this.released = this.lastForward = this.lastJump = false;
  }
}
