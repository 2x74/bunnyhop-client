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

/** bhoptimer keeps up to 1000; 100 is plenty here, and the memory budget below usually decides first on big maps. */
export const MAX_CHECKPOINTS = 100;
/** Snapshots hold the map's whole entity state: maps with huge event queues make them large. */
export const CHECKPOINT_BUDGET_BYTES = 128 * 1024 * 1024;

export interface Checkpoint<T> {
  handle: number;
  bytes: number;
  data: T;
}

export class Checkpoints<T> {
  private list: Checkpoint<T>[] = [];
  /** Index of the current checkpoint (teleport goes there); -1 when there are none. */
  private at = -1;

  constructor(
    private store: SnapshotStore,
    private limits: { max: number; budget: number } = { max: MAX_CHECKPOINTS, budget: CHECKPOINT_BUDGET_BYTES },
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
   * `max` or they hold more than `budget` bytes (the new one always stays). Returns it, or null if the store couldn't
   * snapshot.
   */
  save(data: T): Checkpoint<T> | null {
    const handle = this.store.save();
    if (!handle) return null;
    const cp = { handle, bytes: this.store.bytes(handle), data };
    this.list.push(cp);
    let total = this.list.reduce((n, c) => n + c.bytes, 0);
    while (this.list.length > 1 && (this.list.length > this.limits.max || total > this.limits.budget)) {
      const old = this.list.shift()!;
      total -= old.bytes;
      this.store.free(old.handle);
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
    for (const c of this.list) this.store.free(c.handle);
    this.list = [];
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
