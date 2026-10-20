// Tiny DOM-free request bus so UI (settings, leaderboard rows, menus) can ask the running session to race a ghost
// without importing the session or three.js. The ghost manager (ghost.ts) subscribes while a map is loaded.

export type RaceRequest =
  /** A leaderboard run (fetched with api.replay). */
  | { kind: "run"; runId: string; name: string; track?: number; time?: number }
  /** Raw .bhr bytes (a loaded replay file). */
  | { kind: "bytes"; bytes: Uint8Array; name?: string }
  /** Remove the custom ghost. */
  | { kind: "clear" };

type Listener = (r: RaceRequest) => void;
const listeners = new Set<Listener>();
let pending: RaceRequest | null = null;

/** Ask the in-game session to race this ghost (queued until a session is listening, e.g. from the home screen). */
export function requestRace(r: RaceRequest): void {
  if (listeners.size) for (const l of listeners) l(r);
  else pending = r;
}

// --- profiles: "Race this ghost" from another map reloads the page; the request survives in sessionStorage.
const PENDING_KEY = "bunnyhop:pending-race";
try {
  const saved = sessionStorage.getItem(PENDING_KEY);
  if (saved) {
    sessionStorage.removeItem(PENDING_KEY);
    pending = JSON.parse(saved) as RaceRequest;
  }
} catch {
  /* no storage */
}

/** Queues a leaderboard-run race for after a page navigation (e.g. to the run's map). */
export function requestRaceAfterReload(r: Extract<RaceRequest, { kind: "run" }>): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(r));
  } catch {
    /* no storage: the race is dropped */
  }
}

export function onRaceRequest(l: Listener): () => void {
  listeners.add(l);
  if (pending) {
    const p = pending;
    pending = null;
    l(p);
  }
  return () => listeners.delete(l);
}
