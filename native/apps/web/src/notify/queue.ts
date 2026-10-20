// The notification scheduler: which notes are on screen, which wait, and when that changes. DOM-free and clock-free
// (every call takes `now` in ms), so the rules are unit-tested (apps/api/test/notify.test.ts) and the DOM layer
// (notify/index.ts) only renders the events it returns.
//
// Rules (research/NOTIFICATIONS.md, "Queueing"):
// - Lanes. Whispers, toasts, celebrations and banners queue separately; each lane shows at most `capacity` notes at
//   once (whispers: 1; toasts: 3 in menus, 1 in game; celebrations and banners: 1, so big moments play one at a time).
// - Merge. A note with the same `key` as one on screen or waiting updates it in place (count + 1, timer refreshed)
//   instead of stacking: "Link copied" twice is one toast, three achievements from one run are one card.
// - Priority. Waiting notes go highest priority first, then oldest. A note that outranks everything on screen in a
//   full lane cuts the lowest one short (it still gets `minShow` ms), so a world record never waits behind a toast.
// - Stagger. Two shows on a lane are at least `stagger` ms apart, and a freed slot rests `rest` ms before the next
//   note takes it: a burst cascades in instead of landing as one block.
// - Defer. `defer` notes (celebrations) wait while gameplay is running. If a run starts while one is on screen it
//   leaves; if it was up for less than `minSeen` ms it goes back to the front of the queue with its remaining time.
// - Overflow. More than `maxWaiting` waiting notes in a lane: the lowest priority, oldest one is dropped.
// - Hold. Hovering / focusing a note freezes its timer (`hold`); releasing gives it back what was left (at least 1 s).

export type Lane = "whisper" | "toast" | "celebration" | "banner";

export interface LaneRules {
  capacity: number;
  /** Min ms between two shows. */
  stagger: number;
  /** Min ms between a note leaving and the next one taking its slot. */
  rest: number;
  /** A note cut short by a higher-priority one still stays this long (ms). */
  minShow: number;
  maxWaiting: number;
}

export const DEFAULT_RULES: Record<Lane, LaneRules> = {
  whisper: { capacity: 1, stagger: 0, rest: 0, minShow: 0, maxWaiting: 2 },
  toast: { capacity: 3, stagger: 90, rest: 0, minShow: 900, maxWaiting: 6 },
  celebration: { capacity: 1, stagger: 0, rest: 380, minShow: 2200, maxWaiting: 12 },
  banner: { capacity: 1, stagger: 0, rest: 300, minShow: 1800, maxWaiting: 4 },
};

/** Default priorities (higher shows first). */
export const PRIORITY = { info: 10, error: 30, achievement: 40, level: 50, unlock: 60, record: 80 } as const;

export interface NoteInput<T> {
  lane: Lane;
  /** Notes with the same key merge (in any state but gone). */
  key?: string;
  priority?: number;
  /** How long it stays once shown (ms). */
  ms: number;
  /** Wait while gameplay is running (celebrations). */
  defer?: boolean;
  data: T;
}

export interface Note<T> {
  readonly id: number;
  lane: Lane;
  key: string | null;
  priority: number;
  ms: number;
  defer: boolean;
  data: T;
  /** 1 + merges so far. */
  count: number;
  /** Order it arrived in (ties in priority go oldest first). */
  seq: number;
  state: "waiting" | "shown" | "gone";
  shownAt: number | null;
  /** When it leaves (shown notes). */
  until: number | null;
  /** Remaining ms while held (hover), else null. */
  held: number | null;
}

export type NoteEvent<T> = { type: "show" | "update" | "hide"; note: Note<T> };

export class NotifyQueue<T> {
  private rules: Record<Lane, LaneRules>;
  private notes: Note<T>[] = [];
  private seq = 0;
  private ids = 0;
  private running = false;
  private lastShow: Record<Lane, number> = { whisper: -Infinity, toast: -Infinity, celebration: -Infinity, banner: -Infinity };
  private lastHide: Record<Lane, number> = { whisper: -Infinity, toast: -Infinity, celebration: -Infinity, banner: -Infinity };
  /** Events produced outside step() (merges, cuts) for the next step() to return. */
  private pending: NoteEvent<T>[] = [];
  /** Visible deferrable notes shorter than this go back to the queue when a run starts. */
  minSeen = 1500;

  constructor(
    rules: Partial<Record<Lane, Partial<LaneRules>>> = {},
    /** Combines a waiting / shown note's data with a merging one (default: the newer data wins). */
    private merge: (old: T, add: T, count: number) => T = (_o, a) => a,
  ) {
    this.rules = {
      whisper: { ...DEFAULT_RULES.whisper, ...rules.whisper },
      toast: { ...DEFAULT_RULES.toast, ...rules.toast },
      celebration: { ...DEFAULT_RULES.celebration, ...rules.celebration },
      banner: { ...DEFAULT_RULES.banner, ...rules.banner },
    };
  }

  /** Adds a note (or merges it into one with the same key). Run step() after to get the events. */
  push(input: NoteInput<T>, now: number): { note: Note<T>; merged: boolean; dropped: Note<T> | null } {
    const key = input.key ?? null;
    const same = key === null ? undefined : this.notes.find((n) => n.key === key && n.lane === input.lane && n.state !== "gone");
    if (same) {
      same.count++;
      same.data = this.merge(same.data, input.data, same.count);
      same.priority = Math.max(same.priority, input.priority ?? 0);
      same.ms = Math.max(same.ms, input.ms);
      if (same.state === "shown") {
        if (same.held !== null) same.held = Math.max(same.held, input.ms);
        else same.until = Math.max(same.until ?? now, now + input.ms);
        this.pending.push({ type: "update", note: same });
      }
      return { note: same, merged: true, dropped: null };
    }
    const note: Note<T> = {
      id: ++this.ids,
      lane: input.lane,
      key,
      priority: input.priority ?? 0,
      ms: input.ms,
      defer: !!input.defer,
      data: input.data,
      count: 1,
      seq: ++this.seq,
      state: "waiting",
      shownAt: null,
      until: null,
      held: null,
    };
    this.notes.push(note);
    const r = this.rules[note.lane];
    // A full lane and a note that outranks everything on it: cut the lowest one short.
    const shown = this.shown(note.lane);
    if (shown.length >= r.capacity && shown.every((s) => s.priority < note.priority) && (!note.defer || !this.running)) {
      const low = shown.reduce((a, b) => (b.priority < a.priority || (b.priority === a.priority && b.seq < a.seq) ? b : a));
      this.cut(low, now);
    }
    let dropped: Note<T> | null = null;
    const waiting = this.waiting(note.lane);
    if (waiting.length > r.maxWaiting) {
      const low = Math.min(...waiting.map((n) => n.priority));
      dropped = waiting.find((n) => n.priority === low)!; // oldest of the lowest: stale news goes first
      dropped.state = "gone";
      this.notes.splice(this.notes.indexOf(dropped), 1);
    }
    return { note, merged: false, dropped };
  }

  /** Gameplay running (a timed run in progress, no menu): deferrable notes wait, and visible ones leave. */
  setRunning(running: boolean, now: number): void {
    if (running === this.running) return;
    this.running = running;
    if (!running) return;
    for (const n of this.notes) {
      if (n.state !== "shown" || !n.defer) continue;
      const seen = now - (n.shownAt ?? now);
      if (seen < this.minSeen) {
        // Barely seen: back to the front of the queue with what it had left.
        const left = n.held ?? Math.max(0, (n.until ?? now) - now);
        n.state = "waiting";
        n.ms = Math.max(left, this.minSeen);
        n.seq = -n.seq - 1e9;
        n.shownAt = n.until = null;
        n.held = null;
        this.lastHide[n.lane] = now;
        this.pending.push({ type: "hide", note: n });
      } else n.until = now;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  setCapacity(lane: Lane, capacity: number, now: number): void {
    this.rules[lane].capacity = capacity;
    const shown = this.shown(lane).sort((a, b) => b.priority - a.priority || b.seq - a.seq);
    for (const n of shown.slice(capacity)) this.cut(n, now);
  }

  /** Freeze (hover / focus) or release a shown note's timer. */
  hold(id: number, on: boolean, now: number): void {
    const n = this.notes.find((x) => x.id === id && x.state === "shown");
    if (!n) return;
    if (on && n.held === null) {
      n.held = Math.max(0, (n.until ?? now) - now);
      n.until = null;
    } else if (!on && n.held !== null) {
      n.until = now + Math.max(1000, n.held);
      n.held = null;
    }
  }

  /** Close now (a click on ×, an action). */
  dismiss(id: number, now: number): void {
    const n = this.notes.find((x) => x.id === id && x.state !== "gone");
    if (!n) return;
    if (n.state === "waiting") {
      n.state = "gone";
      this.notes.splice(this.notes.indexOf(n), 1);
      return;
    }
    n.held = null;
    n.until = now;
  }

  /** Expires due notes, then shows waiting ones while their lane allows. Returns what changed, in order. */
  step(now: number): NoteEvent<T>[] {
    const out = this.pending;
    this.pending = [];
    for (const n of [...this.notes]) {
      if (n.state === "shown" && n.until !== null && n.until <= now) {
        n.state = "gone";
        this.notes.splice(this.notes.indexOf(n), 1);
        this.lastHide[n.lane] = now;
        out.push({ type: "hide", note: n });
      }
    }
    for (const lane of ["banner", "celebration", "toast", "whisper"] as Lane[]) {
      const r = this.rules[lane];
      for (;;) {
        const next = this.waiting(lane).find((n) => !n.defer || !this.running);
        if (!next || this.shown(lane).length >= r.capacity) break;
        if (now < this.lastShow[lane] + r.stagger || now < this.lastHide[lane] + r.rest) break;
        next.state = "shown";
        next.shownAt = now;
        next.until = now + next.ms;
        this.lastShow[lane] = now;
        out.push({ type: "show", note: next });
      }
    }
    return out;
  }

  /** When step() next has something to do (ms timestamp), or null when nothing is due (all held / empty). */
  nextAt(now: number): number | null {
    if (this.pending.length) return now;
    let t = Infinity;
    for (const n of this.notes) if (n.state === "shown" && n.until !== null) t = Math.min(t, n.until);
    for (const lane of ["banner", "celebration", "toast", "whisper"] as Lane[]) {
      const r = this.rules[lane];
      const next = this.waiting(lane).find((n) => !n.defer || !this.running);
      if (!next || this.shown(lane).length >= r.capacity) continue;
      t = Math.min(t, Math.max(now, this.lastShow[lane] + r.stagger, this.lastHide[lane] + r.rest));
    }
    return Number.isFinite(t) ? t : null;
  }

  /** Shown notes of a lane, in the order they were shown. */
  shown(lane: Lane): Note<T>[] {
    return this.notes.filter((n) => n.lane === lane && n.state === "shown").sort((a, b) => (a.shownAt ?? 0) - (b.shownAt ?? 0));
  }

  /** Waiting notes of a lane, in the order they will show. */
  waiting(lane: Lane): Note<T>[] {
    return this.notes.filter((n) => n.lane === lane && n.state === "waiting").sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }

  private cut(n: Note<T>, now: number): void {
    const r = this.rules[n.lane];
    const end = Math.max(now, (n.shownAt ?? now) + r.minShow);
    if (n.held !== null) {
      n.held = null;
      n.until = end;
    } else n.until = Math.min(n.until ?? end, end);
  }
}
