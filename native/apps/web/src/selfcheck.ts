// Client self-check + diagnostics for submitted runs (session.ts finish()).
//
// The upload goes out at once, exactly as before (nothing here waits on it or delays it). Alongside, the replay is
// re-simulated in a worker (selfcheck-worker.ts) with the verifier the server runs, and once both are done a small
// diagnostics object is attached to the submitted run (api.runDiagnostics, apps/api src/diagnostics.ts): the self-check
// outcome, browser, sim / web build, fps over the run, the input stats summary, tab switches during the run and the
// device fingerprint's components (device.ts; the hash itself goes with every write). The
// server stays authoritative; a client-side mismatch is only flagged ("client desync" in the admin Runs view), which
// separates "this browser disagrees with its own recording" from "the server disagrees with the client".

import { api } from "./api";
import { physicsContent } from "./core";
import type { Input } from "./input";
import { summary as inputSummary } from "./input-debug";
import { ownBuild } from "./update";
import { VERSION } from "./version";
import { fingerprint } from "./device";

export interface SelfCheckResult {
  selfCheck: "ok" | "mismatch" | "error";
  firstMismatchTick?: number;
  problems?: string[];
  checkMs?: number;
}

type WorkerReply = { id: number; valid: boolean; firstMismatchTick: number | null; problems: string[]; simMs: number } | { id: number; error: string };

/** Starts work when the main thread is idle (the worker set-up copies the map once), within 2 s. */
const whenIdle = (fn: () => void) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 50));

/** One physics-only sim in a worker per map, created on the first finished run (the replay viewer's pattern, off-thread). */
export class SelfCheck {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, (r: SelfCheckResult) => void>();

  constructor(private o: { wasmBytes: Uint8Array; bsp: Uint8Array }) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./selfcheck-worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<WorkerReply>) => {
      const r = e.data;
      const done = this.pending.get(r.id);
      if (!done) return;
      this.pending.delete(r.id);
      if ("error" in r) done({ selfCheck: "error", problems: [r.error] });
      else
        done({
          selfCheck: r.valid ? "ok" : "mismatch",
          ...(r.firstMismatchTick !== null ? { firstMismatchTick: r.firstMismatchTick } : {}),
          ...(r.problems.length ? { problems: r.problems } : {}),
          checkMs: Math.round(r.simMs),
        });
    };
    w.onerror = (e) => {
      // The worker couldn't load (old browser, CSP): every waiting check reports it, the next one tries afresh.
      for (const done of this.pending.values()) done({ selfCheck: "error", problems: [`worker: ${e.message || "failed to start"}`] });
      this.pending.clear();
      w.terminate();
      this.worker = null;
    };
    // Prop collision models registered from hosted content (core.ts), so the worker simulates what the live run did.
    w.postMessage({ type: "init", wasm: this.o.wasmBytes, bsp: this.o.bsp, physics: physicsContent() });
    return (this.worker = w);
  }

  /** Re-simulates gzip .bhr bytes; never rejects (problems come back as selfCheck "error"). */
  check(replay: Uint8Array): Promise<SelfCheckResult> {
    return new Promise((resolve) => {
      const id = ++this.seq;
      const timeout = setTimeout(() => this.pending.get(id)?.({ selfCheck: "error", problems: ["self-check timed out"] }), 120_000);
      this.pending.set(id, (r) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        resolve(r);
      });
      whenIdle(() => {
        try {
          this.ensure().postMessage({ type: "check", id, replay });
        } catch (e) {
          this.pending.get(id)?.({ selfCheck: "error", problems: [String((e as Error)?.message ?? e)] });
        }
      });
    });
  }
}

/**
 * Frames and tab switches during a timed run (start() when the timer starts, stop() at the finish), and a clock
 * tripwire: the elapsed requestAnimationFrame time and performance.now time, each against Date.now's. A hooked frame
 * timestamp (a "timescale": the sim runs on it) shows as a ratio far from 1. Spoofable; review only (apps/api
 * src/integrity-rules.ts clock-skew).
 */
export class RunWatch {
  private running = false;
  private startAt = 0;
  private dateAt = 0;
  private rafFirst: number | null = null;
  private rafLast = 0;
  private frames = 0;
  private hidden = 0;
  private hiddenMs = 0;
  private hiddenAt: number | null = null;
  private blurs = 0;

  constructor() {
    addEventListener("visibilitychange", () => {
      if (!this.running) return;
      if (document.hidden) {
        this.hidden++;
        this.hiddenAt = performance.now();
      } else if (this.hiddenAt !== null) {
        this.hiddenMs += performance.now() - this.hiddenAt;
        this.hiddenAt = null;
      }
    });
    addEventListener("blur", () => this.running && this.blurs++);
  }

  start(): void {
    this.running = true;
    this.startAt = performance.now();
    this.dateAt = Date.now();
    this.rafFirst = null;
    this.frames = this.hidden = this.hiddenMs = this.blurs = 0;
    this.hiddenAt = document.hidden ? this.startAt : null;
  }

  /** Every rendered frame (`raf`: its requestAnimationFrame timestamp). */
  frame(raf?: number): void {
    if (!this.running) return;
    this.frames++;
    if (raf !== undefined) {
      this.rafFirst ??= raf;
      this.rafLast = raf;
    }
  }

  stop(): { fps: number; visibility: { hidden: number; hiddenMs: number; blurs: number }; clock?: { raf: number; perf: number; secs: number } } {
    const now = performance.now();
    this.running = false;
    const hiddenMs = this.hiddenMs + (this.hiddenAt !== null ? now - this.hiddenAt : 0);
    const secs = (now - this.startAt) / 1000;
    const wall = Date.now() - this.dateAt;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const clock = wall > 0 && this.rafFirst !== null ? { raf: r2((this.rafLast - this.rafFirst) / wall), perf: r2((now - this.startAt) / wall), secs: Math.round(wall / 100) / 10 } : undefined;
    return { fps: secs > 0 ? Math.round((this.frames / secs) * 10) / 10 : 0, visibility: { hidden: this.hidden, hiddenMs: Math.round(hiddenMs), blurs: this.blurs }, ...(clock ? { clock } : {}) };
  }
}

/**
 * After a submitted run: waits for the self-check and the upload (its run id; "" = not stored: offline, refused at
 * upload), then attaches the diagnostics. Fire and forget.
 */
export async function reportRun(o: { check: Promise<SelfCheckResult>; upload: Promise<string>; watched: ReturnType<RunWatch["stop"]>; input: Input; wasm: string }): Promise<void> {
  const [check, id, fp] = await Promise.all([o.check, o.upload, fingerprint().catch(() => null)]);
  if (!id) return;
  await api.runDiagnostics(id, {
    ...check,
    ua: navigator.userAgent,
    wasm: o.wasm,
    web: ownBuild() ?? "dev",
    version: VERSION,
    fps: o.watched.fps,
    input: inputSummary(o.input),
    visibility: o.watched.visibility,
    ...(o.watched.clock ? { clock: o.watched.clock } : {}),
    ...(fp ? { fp: fp.components } : {}),
  });
}
