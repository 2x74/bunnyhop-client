// A new player stuck on a map (never finished one): after a minute and a half of play and six goes back to the start
// (falls or R) without finishing, one line says where the way out is. Once per map load, never in the tutorial or a
// room. Pure counters, from main.ts's tick.

const EVENT_TELEPORTED = 1 << 0;
const PLAYED_S = 90;
const GOES = 6;

export const STUCK_LINE = "Stuck? Press Esc for the tutorial or an easier map.";

export class StuckHint {
  private played = 0;
  private goes = 0;
  private done = false;

  /** Every simulated tick. True once, on the tick the line should show. */
  tick(events: number, locked: boolean, finished: boolean, tickS: number): boolean {
    if (this.done) return false;
    if (finished) return !(this.done = true);
    if (locked) this.played += tickS;
    if (events & EVENT_TELEPORTED) this.goes++;
    if (this.played < PLAYED_S || this.goes < GOES) return false;
    this.done = true;
    return true;
  }

  restarted(): void {
    this.goes++;
  }
}
