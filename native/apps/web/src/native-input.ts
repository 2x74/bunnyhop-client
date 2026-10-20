/** Narrow Electron preload contract. Native report times are monotonic epoch milliseconds. */
export interface NativeInputStatus {
  captured: boolean;
  raw: boolean;
  backend: string;
  error?: string;
}
export interface NativeMotionSample { dx: number; dy: number; time: number }
export interface NativeInputBridge {
  capture(enabled: boolean): Promise<NativeInputStatus>;
  drain(): NativeMotionSample[];
  status?(): NativeInputStatus;
}
declare global {
  interface Window { bunnyhopNativeInput?: NativeInputBridge }
}

/** Owns native capture lifetime independently of DOM lock events and stale IPC replies. */
export class NativeMouse {
  active = false;
  pending = false;
  backend = "";
  error = "";
  private epoch = 0;
  private checkedAt = 0;
  constructor(private readonly bridge: NativeInputBridge | undefined) {}

  async start(): Promise<boolean> {
    if (!this.bridge) return false;
    const epoch = ++this.epoch;
    this.pending = true;
    this.active = false;
    try {
      const status = await this.bridge.capture(true);
      if (epoch !== this.epoch) return false;
      this.backend = status.backend;
      this.error = status.error ?? "";
      this.active = status.captured && status.raw;
      if (status.captured && !status.raw) void this.bridge.capture(false).catch(() => {});
      this.checkedAt = 0;
      return this.active;
    } catch (e) {
      if (epoch === this.epoch) this.error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      if (epoch === this.epoch) this.pending = false;
    }
  }

  stop(): void {
    ++this.epoch;
    this.active = this.pending = false;
    if (this.bridge) void this.bridge.capture(false).catch(() => {});
  }

  drain(now: number): NativeMotionSample[] {
    if (!this.bridge || !this.active) return [];
    try {
      if (this.bridge.status && now - this.checkedAt >= 250) {
        this.checkedAt = now;
        const status = this.bridge.status();
        if (!(status.captured && status.raw)) {
          this.error = status.error ?? "Native capture was released";
          this.stop();
          return [];
        }
      }
      return this.bridge.drain();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.stop();
      return [];
    }
  }
}
