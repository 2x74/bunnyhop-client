// Staff lens: the few places staff reach the admin panel from inside the game. Players never see any of it: everything
// waits for the viewer's own role (myProfile().role, decided by the server) and renders nothing otherwise.
//   - adminLink(userId): "Open in admin" on player cards, "Admin" on leaderboard rows (/admin#/player/<id>, a new tab);
//   - replayDeepLink(): ?t=<tick> or ?jump=<n> on a replay URL, read once when the viewer opens (the admin's Watch
//     buttons link to the flagged jump);
//   - staffButton(): the shield left of the bell in the menu dock (social/dock.ts) that opens /admin in the same window
//     (the desktop client has no tabs; the panel's rail has Back to game), with what is waiting for staff
//     (GET /admin/waiting, at most every WAITING_EVERY_MS);
//   - evidenceTicks(runId, data): the jumps the run's analysis flagged (its best 6-jump gain window, GET
//     /admin/integrity/run/<id>, staff-only), as replay ticks for the viewer's timeline to mark once. Never in live play.

import { appHref } from "./platform/navigation";
import { API_URL } from "./api";
import { myProfile } from "./ui/account-state";
import type { StaffRole } from "./progression";
import { STAFF_LABEL, STAFF_SVG, staffBadgeOf } from "./creators";

let role: Promise<StaffRole | null> | null = null;

/** The viewer's staff role (null: not staff, signed out or offline). Asked once per page. */
export function staffRole(): Promise<StaffRole | null> {
  role ??= myProfile()
    .then((p) => (p?.role as StaffRole | null | undefined) ?? null)
    .catch(() => null);
  return role;
}

/**
 * An empty inline slot that becomes a small "Open in admin" link when the viewer is staff (not on their own card).
 * Costs nothing for players: the slot stays empty.
 */
export function adminLink(userId: string, cls = "staff-lens", label = "Open in admin"): HTMLElement {
  const slot = document.createElement("span");
  slot.className = `${cls}-slot`;
  void staffRole().then(async (r) => {
    if (!r) return;
    const mine = await myProfile().then((p) => p?.player.id ?? null).catch(() => null);
    if (mine === userId) return;
    const a = document.createElement("a");
    a.className = cls;
    // Styled here so the hook needs no CSS in the card's or the board's stylesheet.
    // Quiet like the row's Watch / Race links; amber only on hover.
    a.style.cssText = "margin-left:0.6em;color:var(--faint,#7f796e);font-size:0.85em;font-weight:600;text-decoration:none;white-space:nowrap";
    a.addEventListener("pointerenter", () => (a.style.color = "var(--accent,#ffb43c)"));
    a.addEventListener("pointerleave", () => (a.style.color = "var(--faint,#7f796e)"));
    a.href = `/admin#/player/${encodeURIComponent(userId)}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = label;
    a.title = "Open in the admin panel";
    a.addEventListener("click", (e) => e.stopPropagation());
    slot.replaceChildren(a);
  });
  return slot;
}

const WAITING_EVERY_MS = 3 * 60_000;

/**
 * The dock's staff button: hidden for players. For staff, their own shield (Owner, Admin or Moderator) with the
 * count of what waits in the panel's Queue. refresh() re-reads the count (the dock calls it when a menu opens).
 */
export function staffButton(): { el: HTMLButtonElement; refresh: () => void } {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "fd-btn fd-staff";
  el.hidden = true;
  el.addEventListener("click", () => location.assign("/admin#/queue"));
  let last = 0;
  let on = false;
  const paint = (n: number) => {
    el.querySelector(".fd-badge")?.remove();
    if (n > 0) {
      const b = document.createElement("span");
      b.className = "fd-badge";
      b.textContent = n > 99 ? "99+" : String(n);
      el.append(b);
    }
    el.setAttribute("aria-label", n ? `Admin panel, ${n} waiting` : "Admin panel");
    el.title = n ? `Admin panel: ${n} waiting` : "Admin panel";
  };
  const refresh = () => {
    if (!on || Date.now() - last < WAITING_EVERY_MS) return;
    last = Date.now();
    void fetch(`${API_URL}/admin/waiting`, { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<{ count?: number }>) : null))
      .then((j) => j && paint(j.count ?? 0))
      .catch(() => undefined);
  };
  void staffRole().then((r) => {
    const badge = staffBadgeOf(r);
    if (!r || !badge) return;
    on = true;
    el.innerHTML = `<svg class="fd-shield" viewBox="0 0 24 24" aria-hidden="true">${STAFF_SVG[badge]}</svg>`;
    el.dataset.role = badge;
    el.title = `Admin panel (${STAFF_LABEL[badge]})`;
    paint(0);
    el.hidden = false;
    refresh();
  });
  return { el, refresh };
}

/** ?t=<tick> / ?jump=<n> on the page URL (a replay link), read before the viewer rewrites the URL. */
export function replayDeepLink(href = appHref()): { tick: number | null; jump: number | null } {
  const q = new URL(href).searchParams;
  const num = (k: string) => {
    const v = Number(q.get(k));
    return q.has(k) && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  };
  return { tick: num("t"), jump: num("jump") };
}

/** The n-th jump (1-based) of the timed run as a replay tick (jumps counted from the start zone, like the analysis). */
export function jumpTick(d: { jumpTicks: number[]; startTick: number; endTick: number }, n: number): number | null {
  const timed = d.jumpTicks.filter((t) => t >= d.startTick && (!d.endTick || t <= d.endTick));
  return timed[n - 1] ?? null;
}

type JumpRow = [number, number, number, number | null, number | null, number];

/** The best 6-jump gain window (the analysis' summary jumps: not the first or last, 40+ air ticks, with a gain). */
function bestWindow(rows: JumpRow[]): number[] {
  const used: number[] = [];
  for (let i = 1; i < rows.length - 1; i++) if (rows[i][0] >= 40 && rows[i][3] !== null) used.push(i);
  let best = -Infinity;
  let at = -1;
  for (let k = 0; k + 6 <= used.length; k++) {
    const sl = used.slice(k, k + 6);
    const g = sl.reduce((a, i) => a + rows[i][3]! * rows[i][0], 0) / sl.reduce((a, i) => a + rows[i][0], 0);
    if (g > best) (best = g), (at = k);
  }
  return at < 0 ? [] : used.slice(at, at + 6);
}

/** Staff only: the flagged jumps of a run as replay ticks (empty for everyone else, or a run without an analysis). */
export async function evidenceTicks(runId: string, d: { jumpTicks: number[]; startTick: number; endTick: number }): Promise<number[]> {
  if (!API_URL || !(await staffRole())) return [];
  try {
    const res = await fetch(`${API_URL}/admin/integrity/run/${encodeURIComponent(runId)}`, { credentials: "include" });
    if (!res.ok) return [];
    const x = (await res.json()) as { features?: { jumps?: { rows?: JumpRow[] } } | null };
    return bestWindow(x.features?.jumps?.rows ?? [])
      .map((i) => jumpTick(d, i + 1))
      .filter((t): t is number => t !== null);
  } catch {
    return [];
  }
}
