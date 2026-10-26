// Feedback plumbing that has to exist before the rest of the client runs (main.ts imports this first): a ring buffer
// of the last client errors (uncaught errors, unhandled rejections, console.error), the game-info provider the live
// session registers, and the run id of the last submission. Cheap on purpose: no DOM, no work until something fails.
// The form itself (feedback/modal.ts) loads on demand through openFeedback().

export interface ClientError {
  at: number;
  kind: "error" | "rejection" | "console";
  msg: string;
  src?: string;
  stack?: string;
}

const MAX_ERRORS = 20;
const errors: ClientError[] = [];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function describe(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function push(e: ClientError): void {
  errors.push({ ...e, msg: clip(e.msg, 400), stack: e.stack ? clip(e.stack, 900) : undefined });
  if (errors.length > MAX_ERRORS) errors.shift();
}

/** Newest last. */
export const recentErrors = (): ClientError[] => errors.slice();

let installed = false;
function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    // Runtime errors only (resource load failures don't bubble to window).
    push({ at: Date.now(), kind: "error", msg: e.message || describe(e.error), src: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined, stack: e.error instanceof Error ? e.error.stack : undefined });
  });
  window.addEventListener("unhandledrejection", (e) => {
    push({ at: Date.now(), kind: "rejection", msg: describe(e.reason), stack: e.reason instanceof Error ? e.reason.stack : undefined });
  });
  const orig = console.error;
  let inside = false;
  console.error = function (...args: unknown[]) {
    if (!inside) {
      inside = true;
      try {
        push({ at: Date.now(), kind: "console", msg: args.map(describe).join(" "), stack: args.find((a): a is Error => a instanceof Error)?.stack });
      } catch {
        /* never let logging fail */
      } finally {
        inside = false;
      }
    }
    return orig.apply(console, args);
  };
}
install();

// ---------------------------------------------------------------------------------------------
// Game info

export type GameInfo = Record<string, unknown>;
let provider: (() => GameInfo) | null = null;

/** The live session (main.ts) describes itself: map + sha, style, track, timer, position, build, ... */
export function setGameInfo(p: (() => GameInfo) | null): void {
  provider = p;
}

export function gameInfo(): GameInfo | null {
  try {
    return provider?.() ?? null;
  } catch {
    return null;
  }
}

let lastRunId: string | null = null;
/** online.ts: the server accepted a run (the feedback form attaches it, the admin panel links its replay). */
export const noteSubmittedRun = (id: string | null | undefined) => void (id && (lastRunId = id));
export const lastSubmittedRun = () => lastRunId;

// ---------------------------------------------------------------------------------------------
// Opening the form

/** "application": a moderator application (the form asks its own questions; apps/api src/feedback.ts). "tier": the
 * current map's tier is wrong (the form adds a tier pick). "report": a player report (apps/api src/player-reports.ts). */
export type FeedbackCategory = "bug" | "physics" | "map" | "tier" | "multiplayer" | "idea" | "other" | "application" | "report";

/** Who a player report is about: their id when the opener knows it (a profile, the room), else their full name; a run
 * of theirs when it's about one (the replay viewer: the server finds the player from the run). */
export interface ReportTarget {
  id?: string;
  name: string;
  run?: { id: string; map: string; time: number | null };
}

export interface FeedbackOpen {
  category?: FeedbackCategory;
  /** Text to start the message with. */
  message?: string;
  /** category "report": who it's about (no target: the form asks for a name). */
  report?: ReportTarget;
  /** Called after the dialog closed (focus goes back to the opener by itself). */
  onClose?: () => void;
}

/** Opens the feedback form (loads it on first use). */
export function openFeedback(o: FeedbackOpen = {}): void {
  void import("./modal").then((m) => m.showFeedback(o));
}
