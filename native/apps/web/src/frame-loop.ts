// What drives the game's frames (main.ts frame()): requestAnimationFrame, or, with Settings → Graphics → Exceed monitor
// FPS while playing, an uncapped loop. Both honour the FPS limit. Same design as Aimperion's engine (src/core/engine.js):
//
// - Default: rAF, paced by the display. A limit below the refresh rate draws only the frames that are due, on a fixed
//   cadence (a limit that divides the refresh rate draws every Nth vsync; others alternate, averaging the limit).
// - Uncapped: "coarse wait, fine spin". A setTimeout covers most of the wait to the next due frame, a MessageChannel
//   message the last 2.5 ms (setTimeout alone is too coarse; a bare message spin ran 9,000+ loops a second in Aimperion
//   and felt worse than vsync). With no limit (Unlimited) it draws as soon as the GPU has finished the last frame
//   (gpuIdle: a WebGL fence), so at most one frame is ever queued.
// - In menus (not playing) and in a hidden tab it is rAF again: nothing to gain there, and rAF stops in a hidden tab.
//
// Frames past the refresh rate only reach the screen with the low-latency canvas (main.ts, desynchronized) or a
// browser started with --disable-gpu-vsync --disable-frame-rate-limit; otherwise the compositor still shows one per
// refresh. Mouse motion for the frames between vsyncs comes from pointerrawupdate (input.ts) in uncapped mode.
//
// `frame` gets performance.now() in uncapped mode: rAF timestamps and performance.now() share the clock, so the run's
// clock checks (selfcheck.ts) see the same pace either way.

export interface FrameLoopOptions {
  /** Draw one frame. */
  frame: (now: number) => void;
  /** Use the uncapped loop now (Exceed monitor FPS while playing). */
  uncapped: () => boolean;
  /** The FPS limit now (0 = none). */
  limit: () => number;
  /** The GPU has finished the last frame (uncapped mode only; true when unknown). */
  gpuIdle?: () => boolean;
  /**
   * rAF also waits on gpuIdle. For the desktop client's "Uncap the whole browser" (--disable-frame-rate-limit
   * --disable-gpu-vsync): rAF then fires as fast as the main thread allows with nothing holding frames back, so
   * without the gate the GPU queue fills and every frame shows late.
   */
  gateRaf?: () => boolean;
}

/** Below this wait the uncapped loop spins on MessageChannel messages instead of a setTimeout (ms). */
const SPIN_MS = 2.5;
/**
 * The spin's slice (ms): each MessageChannel task waits this long in place, on the clock or on the GPU, before yielding.
 * A task per poll is a MessageEvent, and isInputPending takes an options object: both are garbage in Blink's own heap
 * (Oilpan), not V8's. At 300,000 tasks a second, or millions of calls, they filled the global GC limit about once a
 * second. Each of those full collections ends in a run of 5 ms sweep tasks, one between each frame, which shows as a
 * small stutter every 1-3 s (research/PERF-WEB.md). A WebGL fence's status only updates between tasks (Blink caches it
 * per task), so a GPU wait still takes a task per poll, just far fewer. Other work, input included, waits a slice at most.
 */
const SLICE_MS = 0.05;
type Scheduling = { isInputPending?: (o?: { includeContinuous?: boolean }) => boolean };
const scheduling = (globalThis.navigator as { scheduling?: Scheduling } | undefined)?.scheduling;
/** Mouse motion counts: it is what the frames between vsyncs exist for. */
const PENDING_OPTS = { includeContinuous: true };
const inputPending: () => boolean = typeof scheduling?.isInputPending === "function" ? () => scheduling.isInputPending!(PENDING_OPTS) : () => false;
/** rAF timestamps sit on vsync: a frame this early is still due (ms), so a limit that divides the refresh rate holds. */
const RAF_SLACK_MS = 1;

export class FrameLoop {
  private lastRender = -1e9;
  private uncappedOn = false;
  private chan: MessageChannel | null = null;
  /** Bumped to cancel a pending uncapped step (a message or timeout already queued). */
  private gen = 0;
  /** This frame has already yielded once to let waiting input in. */
  private yielded = false;

  constructor(private o: FrameLoopOptions) {}

  /** Frames come from the uncapped loop right now. */
  get uncappedActive(): boolean {
    return this.uncappedOn;
  }

  start(): void {
    requestAnimationFrame(this.raf);
  }

  /** Is a frame due at `now` under a limit of `fps`? Advances the cadence if so. */
  private due(now: number, fps: number, slack: number): boolean {
    if (!(fps > 0)) {
      this.lastRender = now;
      return true;
    }
    const minMs = 1000 / fps;
    if (now - this.lastRender < minMs - slack) return false;
    // A fixed cadence, snapped forward after a stall (no burst of catch-up frames).
    this.lastRender = Math.max(this.lastRender + minMs, now - minMs);
    return true;
  }

  /** due() without advancing the cadence. */
  private dueAt(now: number, fps: number, slack: number): boolean {
    return !(fps > 0) || now - this.lastRender >= 1000 / fps - slack;
  }

  private raf = (now: number): void => {
    if (this.o.uncapped() && document.visibilityState !== "hidden") {
      this.uncappedOn = true;
      this.step();
      return;
    }
    requestAnimationFrame(this.raf);
    // A busy GPU skips this callback without advancing the cadence, as in the uncapped loop.
    if (this.o.gateRaf?.() && !(this.o.gpuIdle?.() ?? true)) return;
    if (this.due(now, this.o.limit(), RAF_SLACK_MS)) this.o.frame(now);
  };

  private step = (): void => {
    if (!this.o.uncapped() || document.visibilityState === "hidden") {
      // Back to rAF (menus, hidden tab): drop anything still queued.
      this.uncappedOn = false;
      this.gen++;
      requestAnimationFrame(this.raf);
      return;
    }
    const fps = this.o.limit();
    let now = performance.now();
    // One read per task: the fence's status can't change inside one (SLICE_MS).
    const gpuIdle = this.o.gpuIdle?.() ?? true;
    // Waiting, on the GPU or on the clock: the rest of this slice here.
    const end = now + SLICE_MS;
    while (!gpuIdle || !this.dueAt(now, fps, 0.05)) {
      now = performance.now();
      if (now >= end) break;
    }
    // The GPU gate first: a busy GPU doesn't advance the cadence.
    if (gpuIdle && this.dueAt(now, fps, 0.05)) {
      // Waiting input goes first, so this frame shows it. Once a frame, and only one yield: a fast mouse can't hold it off.
      if (!this.yielded && inputPending()) {
        this.yielded = true;
      } else {
        this.yielded = false;
        this.due(now, fps, 0.05);
        try {
          this.o.frame(now);
        } catch (e) {
          // As with rAF (scheduled first): an exception costs one frame, not the loop.
          console.error(e);
        }
      }
    }
    this.schedule();
  };

  private schedule(): void {
    if (!this.uncappedOn) return;
    const fps = this.o.limit();
    const wait = fps > 0 ? 1000 / fps - (performance.now() - this.lastRender) : 0;
    const gen = ++this.gen;
    if (wait > SPIN_MS) {
      setTimeout(() => gen === this.gen && this.step(), Math.floor(wait - 1));
      return;
    }
    if (!this.chan) {
      this.chan = new MessageChannel();
      this.chan.port1.onmessage = (e) => e.data === this.gen && this.step();
    }
    this.chan.port2.postMessage(gen);
  }
}

/**
 * GPU back-pressure for the uncapped loop (Aimperion render/index.js): a fence after each frame, polled without
 * waiting. Not idle while the last frame's fence hasn't signalled. WebGL1 has no fences: always idle.
 */
export class GpuFence {
  private fence: WebGLSync | null = null;
  constructor(private gl: WebGLRenderingContext | WebGL2RenderingContext) {}

  /** After a frame's draw calls. */
  mark(): void {
    const gl = this.gl;
    if (!("fenceSync" in gl)) return;
    if (this.fence) gl.deleteSync(this.fence);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  idle(): boolean {
    const gl = this.gl;
    if (!this.fence || !("fenceSync" in gl)) return true;
    const r = gl.clientWaitSync(this.fence, 0, 0);
    if (r === gl.TIMEOUT_EXPIRED) {
      // The GPU process only reports a finished fence when it next sees work: without this it waits for its own poll,
      // about 0.5 ms a frame on M5 Metal. Fewer polls (SLICE_MS) made that wait show.
      gl.flush();
      return false;
    }
    gl.deleteSync(this.fence);
    this.fence = null;
    return true;
  }

  /** The loop left uncapped mode: forget the last fence. */
  clear(): void {
    if (this.fence && "deleteSync" in this.gl) this.gl.deleteSync(this.fence);
    this.fence = null;
  }
}
