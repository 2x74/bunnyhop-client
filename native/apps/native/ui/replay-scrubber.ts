/** Bounded native seeks while dragging, with exact final seek and playback restoration. */
export class ReplayScrubber {
  active = false;
  value = 0;
  private paused = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: number | null = null;
  private sent: number | null = null;
  constructor(private hooks: { seek: (tick: number) => void; pause: (paused: boolean) => void; delay?: number }) {}
  begin(paused: boolean, tick: number) {
    if (this.active) return;
    this.active = true;
    this.paused = paused;
    this.value = tick;
    this.sent = null;
    if (!paused) this.hooks.pause(true);
  }
  private schedule() {
    this.timer = setTimeout(() => {
      if (this.active && this.pending !== null) {
        this.flush();
        this.schedule();
      } else this.timer = null;
    }, this.hooks.delay ?? 66);
  }
  update(tick: number) {
    this.value = Math.max(0, Math.round(tick));
    this.pending = this.value;
    if (!this.timer) {
      this.flush();
      this.schedule();
    }
  }
  private flush() {
    if (this.pending === null) return;
    const tick = this.pending;
    this.pending = null;
    if (this.sent !== tick) {
      this.sent = tick;
      this.hooks.seek(tick);
    }
  }
  finish(tick: number) {
    if (!this.active) return;
    this.value = Math.max(0, Math.round(tick));
    this.pending = this.value;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
    this.active = false;
    if (!this.paused) this.hooks.pause(false);
  }
  cancel(restore = true) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    const resume = this.active && !this.paused;
    this.active = false;
    if (restore && resume) this.hooks.pause(false);
  }
}
