import { markSeen, unseen } from "./unlock-seen";

export class NewTracker {
  readonly snapshot: Set<string>;
  private pending: Set<string>;
  private listeners = new Set<() => void>();

  constructor(private uid: string | null, owned: readonly string[]) {
    this.snapshot = uid ? unseen(uid, owned) : new Set();
    this.pending = new Set(this.snapshot);
  }

  isNew(id: string): boolean {
    return this.snapshot.has(id);
  }
  /** Ids among `ids` not yet viewed. */
  pendingIn(ids: Iterable<string>): number {
    let n = 0;
    for (const id of ids) if (this.pending.has(id)) n++;
    return n;
  }
  get pendingCount(): number {
    return this.pending.size;
  }
  see(ids: Iterable<string>): void {
    if (!this.uid) return;
    const hit = [...ids].filter((id) => this.pending.has(id));
    if (!hit.length) return;
    for (const id of hit) this.pending.delete(id);
    markSeen(this.uid, hit);
    for (const l of this.listeners) l();
  }
  /** Explicit dismissal also removes the dots kept visible after viewing a category. */
  clear(ids: Iterable<string>): void {
    if (!this.uid) return;
    const hit = [...ids].filter((id) => this.snapshot.has(id));
    if (!hit.length) return;
    markSeen(this.uid, hit);
    for (const id of hit) {
      this.snapshot.delete(id);
      this.pending.delete(id);
    }
    for (const l of this.listeners) l();
  }
  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
