// Live updates: one poll of GET /admin/live (apps/api src/admin-live.ts) every 15 s while the tab is visible (core.ts
// poll: nothing while it is hidden, at once when it comes back). The answer is a few change stamps and the waiting
// numbers; views subscribe and refetch only what moved (the boards, the queue, an open thread), so a player's reply
// shows up on the board without a reload. main.ts paints the rail's badges and the tab title from it, and a new
// waiting ticket (a player wrote back, or a new one came in) gets a toast with Open while you are elsewhere.

import { api, NotAdmin, poll } from "./core";
import { toast } from "./ui";

export interface LiveParts {
  feedback: number | null;
  cases: number;
  flags: string | null;
}

export interface LiveState {
  parts: LiveParts;
  waiting: { feedback: { new: number; player: number; waiting: number } | null; flags: number | null };
  latest: { id: string; user_name: string | null; category: string; reply: boolean; at: number } | null;
  at: number;
}

/** What moved since the last answer: a part, or the waiting numbers. */
export type Changed = Set<keyof LiveParts | "waiting">;
/** `initial`: the first answer after sign-in (the badges paint from it; views already have fresh data). */
type Listener = (s: LiveState, changed: Changed, initial: boolean) => void;

export const LIVE_MS = 15_000;
const listeners = new Set<Listener>();
let last: LiveState | null = null;
let stop: (() => void) | null = null;
let inflight: Promise<void> | null = null;

/** Subscribe; returns the unsubscribe (a view's cleanup). */
export function onLive(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export const liveState = () => last;

const CATEGORY: Record<string, string> = { bug: "bug report", physics: "physics report", map: "map report", tier: "tier suggestion", report: "player report", multiplayer: "multiplayer report", idea: "idea", other: "ticket", application: "moderator application", privacy: "privacy request" };

/** A new waiting ticket while you're not looking at it: a toast with Open. */
function announce(prev: LiveState | null, next: LiveState): void {
  const l = next.latest;
  const p = prev?.latest;
  if (!prev || !l || (p && p.id === l.id && p.at >= l.at) || (p && l.at < p.at)) return;
  const here = location.hash.startsWith(`#/feedback/${encodeURIComponent(l.id)}`) || location.hash.startsWith("#/fbboard");
  if (here) return;
  const who = l.user_name ?? "A player";
  toast(l.reply ? `${who} replied on their ticket` : `New ${CATEGORY[l.category] ?? "ticket"} from ${who}`, false, { label: "Open", run: () => void (location.hash = `#/feedback/${encodeURIComponent(l.id)}`), hold: 8000 });
}

/** Polls now (also what the timer runs); concurrent callers share the request. */
export function pollLive(): Promise<void> {
  inflight ??= (async () => {
    try {
      const next = await api<LiveState>("/admin/live");
      const changed: Changed = new Set();
      if (last) {
        for (const k of ["feedback", "cases", "flags"] as const) if (last.parts[k] !== next.parts[k]) changed.add(k);
        if (JSON.stringify(last.waiting) !== JSON.stringify(next.waiting)) changed.add("waiting");
      } else changed.add("waiting");
      const prev = last;
      last = next;
      if (changed.size) for (const fn of [...listeners]) fn(next, changed, !prev);
      announce(prev, next);
    } catch (e) {
      // An API without /admin/live (an older Worker) or a blip: the next beat tries again; NotAdmin is the router's.
      if (e instanceof NotAdmin) throw e;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Starts the beat once (main.ts, after sign-in). */
export function startLive(): void {
  if (stop) return;
  void pollLive().catch(() => undefined);
  stop = poll(() => pollLive().catch(() => undefined), LIVE_MS);
}
