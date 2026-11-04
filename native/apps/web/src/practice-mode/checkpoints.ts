// Practice mode checkpoints (bhoptimer's checkpoint menu without the menu): save where you are, teleport back to the
// current one, step to the previous / next. A checkpoint is a full snapshot of the simulation (player position,
// angles, velocity, duck state, plus doors, triggers and the event queue: crates/core state_snapshot), the run timer
// as it was, and the view. Teleporting restores all of it, so a section plays out the same way every time.
// DOM-free (apps/api/test/practice.test.ts).

import type { RunTimer } from "../timer";

/** Where snapshots live (the core's state_snapshot / state_restore / state_free / state_snapshot_bytes). */
export interface SnapshotStore {
  save(): number;
  restore(handle: number): boolean;
  free(handle: number): void;
  bytes(handle: number): number;
}

/**
 * Up to 1000, like bhoptimer (0.0.36; 100 before). Measured on the e6427bff6f87 core (state_snapshot_bytes, and wasm
 * memory growth over 4000 snapshots): about 96 KB each on bhop_eazy, 130 KB on bhop_moonlight, 176 KB on bhop_angkor,
 * 262 KB on bhop_synthetic_fix and 1.75 MB on bhop_treason. The byte budget below decides first wherever a snapshot is
 * over about 134 KB (treason keeps ~76), so the cap adds no worst case: at most the budget on top of the map, as before.
 */
export const MAX_CHECKPOINTS = 1000;
/**
 * Snapshots hold the map's whole entity state: maps with huge event queues make them large. Wasm memory never shrinks,
 * so this is also the most a tab's memory grows for checkpoints. It covers the JS side the checkpoints keep too
 * (CheckpointHooks.extraBytes: Segmented paths, segments.ts retainedBytes).
 */
export const CHECKPOINT_BUDGET_BYTES = 128 * 1024 * 1024;

export interface Checkpoint<T> {
  handle: number;
  bytes: number;
  data: T;
}

/** What the checkpoints' data holds outside the snapshots. */
export interface CheckpointHooks<T> {
  /** Bytes the data of the kept checkpoints holds now, counted in the budget (read again after each drop). */
  extraBytes?: () => number;
  /** A checkpoint's data is let go (dropped as the oldest, cleared, or its snapshot failed). */
  onDrop?: (data: T) => void;
}

export class Checkpoints<T> {
  private list: Checkpoint<T>[] = [];
  /** Index of the current checkpoint (teleport goes there); -1 when there are none. */
  private at = -1;

  constructor(
    private store: SnapshotStore,
    private limits: { max: number; budget: number } = { max: MAX_CHECKPOINTS, budget: CHECKPOINT_BUDGET_BYTES },
    private hooks: CheckpointHooks<T> = {},
  ) {}

  get count(): number {
    return this.list.length;
  }

  /** 1-based number of the current checkpoint (0 = none). */
  get number(): number {
    return this.at + 1;
  }

  /**
   * Saves a new checkpoint after the others and makes it the current one. The oldest go when there are more than
   * `max` or they hold more than `budget` bytes with their data's extraBytes (the new one always stays). Returns it,
   * or null if the store couldn't snapshot.
   */
  save(data: T): Checkpoint<T> | null {
    const handle = this.store.save();
    if (!handle) {
      this.hooks.onDrop?.(data);
      return null;
    }
    const cp = { handle, bytes: this.store.bytes(handle), data };
    this.list.push(cp);
    let total = this.list.reduce((n, c) => n + c.bytes, 0);
    const extra = () => this.hooks.extraBytes?.() ?? 0;
    while (this.list.length > 1 && (this.list.length > this.limits.max || total + extra() > this.limits.budget)) {
      const old = this.list.shift()!;
      total -= old.bytes;
      this.store.free(old.handle);
      this.hooks.onDrop?.(old.data);
    }
    this.at = this.list.length - 1;
    return cp;
  }

  /** The current checkpoint, or null. */
  current(): Checkpoint<T> | null {
    return this.list[this.at] ?? null;
  }

  /** Moves the current checkpoint by `delta` (stops at the first / last). Returns the new current, or null if none. */
  step(delta: number): Checkpoint<T> | null {
    if (!this.list.length) return null;
    this.at = Math.max(0, Math.min(this.list.length - 1, this.at + delta));
    return this.current();
  }

  /** Restores `cp`'s snapshot into the core. */
  restore(cp: Checkpoint<T>): boolean {
    return this.store.restore(cp.handle);
  }

  /** Frees every checkpoint. */
  clear(): void {
    const list = this.list;
    this.list = [];
    for (const c of list) {
      this.store.free(c.handle);
      this.hooks.onDrop?.(c.data);
    }
    this.at = -1;
  }
}

/** The run timer's state (everything but its zones, options and tick interval), for a checkpoint. */
export type TimerSnapshot = Record<string, unknown>;

const TIMER_FIXED = new Set(["zones", "options", "tickInterval"]);

export function saveTimer(t: RunTimer): TimerSnapshot {
  const s: TimerSnapshot = {};
  for (const [k, v] of Object.entries(t)) if (!TIMER_FIXED.has(k)) s[k] = Array.isArray(v) ? v.map((x) => (typeof x === "object" && x ? { ...x } : x)) : v;
  return s;
}

export function loadTimer(t: RunTimer, s: TimerSnapshot): void {
  const copy = saveTimer(s as unknown as RunTimer);
  Object.assign(t, copy);
}
