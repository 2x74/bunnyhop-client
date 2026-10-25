// The press that turned sound on (engine.ts records every gesture while audio is still locked; the last one is the
// one that unlocked it). A button that unlocked audio with its own press shouldn't also act on that press (the speaker
// button would mute what the player just asked to hear), but any later, deliberate click on it must. DOM-free (tests:
// test/audio-unlock.test.ts).

/** A press older than this never counts as the unlocking one (a press dragged off its button has no click). */
const WINDOW_MS = 1500;

export class UnlockPress {
  private target: unknown = null;
  private at = 0;

  /** A trusted gesture while audio was locked. */
  record(target: unknown, now: number): void {
    this.target = target;
    this.at = now;
  }

  /**
   * True once: for the click that belongs to the press that unlocked audio, when that press was on the element
   * (`contains(target)`). Later clicks (and clicks after an unlock done elsewhere) are false.
   */
  consume(contains: (target: unknown) => boolean, now: number): boolean {
    if (this.target === null || now - this.at > WINDOW_MS || !contains(this.target)) return false;
    this.target = null;
    return true;
  }
}
