// The player action dialogs (ban, mute, kick, shadowban, network ban, message, warn) shared by the player page, the drawer,
// Live and the chat log. The ban dialog informs the call: the player's earlier bans in one line ("Second ban. Last: 1 day
// for chat spam, 4 days ago."), durations as one row of quiet buttons (a minutes field only after Custom; moderators
// only see what they may give), and the reason field offers this browser's recent reasons. Every reversible action
// leaves a 10 s Undo on its toast.

import { act, api, ask, may, minutesWord, ago, toast, undoCall, type ModRow } from "./core";
import { MOD_BAN_MAX_MINUTES } from "../moderation/staff";
import { rooms } from "./core";

const REASONS_KEY = "bh_admin_reasons";

/** The staff member's recent reasons in this browser (newest first), for the reason field's suggestions. */
export function recentReasons(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(REASONS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 12) : [];
  } catch {
    return [];
  }
}
export function rememberReason(r: string | null | undefined): void {
  const t = (r ?? "").trim();
  if (!t) return;
  try {
    localStorage.setItem(REASONS_KEY, JSON.stringify([t, ...recentReasons().filter((x) => x !== t)].slice(0, 12)));
  } catch {
    /* full or private */
  }
}

const ORDINAL = ["First", "Second", "Third", "Fourth", "Fifth"];

/** "Second ban. Last: 1 day for chat spam, 4 days ago." from the player's moderation history (null: first one). */
export function priorLine(actions: ModRow[] | undefined, kind: "ban" | "mute"): string | null {
  const past = (actions ?? []).filter((a) => a.action === kind);
  if (!past.length) return null;
  const last = past[0];
  let d: { minutes?: number | null; reason?: string | null } = {};
  try {
    d = JSON.parse(last.details ?? "{}");
  } catch {
    /* keep empty */
  }
  const nth = ORDINAL[past.length] ?? `${past.length + 1}th`;
  const len = d.minutes === null || d.minutes === undefined ? (kind === "ban" ? "permanent" : "permanent") : minutesWord(d.minutes);
  return `${nth} ${kind}. Last: ${len}${d.reason ? ` for ${d.reason}` : ""}, ${ago(last.created_at)}.`;
}

/** The player's moderation history when the caller doesn't have it (the lite detail: no room fan-out). */
async function historyOf(id: string): Promise<ModRow[]> {
  try {
    return (await api<{ actions: ModRow[] }>(`/admin/players/${encodeURIComponent(id)}?lite=1`)).actions ?? [];
  } catch {
    return [];
  }
}

const BAN_CHOICES: [string, string][] = [
  ["60", "1h"],
  ["360", "6h"],
  ["1440", "1d"],
  ["10080", "7d"],
  ["43200", "30d"],
  ["perm", "Permanent"],
  ["custom", "Custom"],
];
const MUTE_CHOICES: [string, string][] = [
  ["30", "30m"],
  ["60", "1h"],
  ["1440", "1d"],
  ["perm", "Permanent"],
  ["custom", "Custom"],
];

function minutesFrom(v: Record<string, string>, fallback: number): number | null {
  if (v.duration === "perm") return null;
  const m = Number(v.duration === "custom" ? v.minutes : v.duration);
  return Number.isFinite(m) && m > 0 ? Math.round(m) : fallback;
}

export interface Target {
  id: string;
  name: string;
}

/** Ban (server-wide). roomId: through that room (Live). Resolves with whether it was done. */
export async function banDialog(t: Target, o: { roomId?: string; actions?: ModRow[] } = {}): Promise<boolean> {
  const perm = may("player.ban.perm");
  // Moderators: temporary bans up to MOD_BAN_MAX_MINUTES; longer choices aren't offered (the API refuses them too).
  const choices = perm ? BAN_CHOICES : BAN_CHOICES.filter(([m]) => m === "custom" || (m !== "perm" && Number(m) <= MOD_BAN_MAX_MINUTES));
  const prior = priorLine(o.actions ?? (await historyOf(t.id)), "ban");
  const v = await ask({
    title: `Ban ${t.name}`,
    lead: prior,
    fields: [
      { name: "duration", label: "How long", kind: "seg", options: choices, value: "1440", reveal: { value: "custom", field: "minutes" } },
      { name: "minutes", label: perm ? "Minutes" : `Minutes (up to ${MOD_BAN_MAX_MINUTES})`, kind: "number", placeholder: "90" },
      { name: "reason", label: "Reason (the player sees it)", kind: "text", required: true, list: recentReasons() },
    ],
    confirm: "Ban",
    danger: true,
  });
  if (!v) return false;
  const minutes = minutesFrom(v, 1440);
  rememberReason(v.reason);
  const undo = { run: () => undoCall(`/admin/players/${encodeURIComponent(t.id)}`, { action: "unban" }, `Unbanned ${t.name}`) };
  const r = o.roomId
    ? await act(`/admin/rooms/${o.roomId}`, { op: "ban", user: t.id, minutes, reason: v.reason }, `Banned ${t.name}, ${minutesWord(minutes)}`, undo)
    : await act(`/admin/players/${encodeURIComponent(t.id)}`, { action: "ban", minutes, reason: v.reason }, `Banned ${t.name}, ${minutesWord(minutes)}`, undo);
  return !!r;
}

/** Mute (every room, or one). Resolves with whether it was done. */
export async function muteDialog(t: Target, o: { roomId?: string; actions?: ModRow[] } = {}): Promise<boolean> {
  const rs = o.roomId ? [] : await rooms();
  const prior = priorLine(o.actions, "mute");
  const v = await ask({
    title: `Mute ${t.name}`,
    lead: prior,
    text: "They can still play. Their chat is dropped and logged.",
    fields: [
      { name: "duration", label: "How long", kind: "seg", options: MUTE_CHOICES, value: "30", reveal: { value: "custom", field: "minutes" } },
      { name: "minutes", label: "Minutes", kind: "number", placeholder: "90" },
      ...(o.roomId ? [] : [{ name: "room", label: "Where", kind: "select" as const, options: [["*", "Every room"] as [string, string], ...rs.map((r): [string, string] => [r.id, r.name])], value: "*" }]),
    ],
    confirm: "Mute",
  });
  if (!v) return false;
  const minutes = minutesFrom(v, 30);
  return quickMute(t, minutes, o.roomId ?? (v.room && v.room !== "*" ? v.room : null));
}

/** Mute without a dialog (the roster's and the chat line's "Mute 30m"), with Undo. */
export async function quickMute(t: Target, minutes: number | null, roomId: string | null = null): Promise<boolean> {
  const undo = { run: () => (roomId ? undoCall(`/admin/rooms/${roomId}`, { op: "unmute", user: t.id }, `Unmuted ${t.name}`) : undoCall(`/admin/players/${encodeURIComponent(t.id)}`, { action: "unmute" }, `Unmuted ${t.name}`)) };
  const done = `Muted ${t.name}, ${minutesWord(minutes)}`;
  const r = roomId
    ? await act(`/admin/rooms/${roomId}`, { op: "mute", user: t.id, minutes }, done, undo)
    : await act(`/admin/players/${encodeURIComponent(t.id)}`, { action: "mute", minutes, room: null }, done, undo);
  return !!r;
}

/** Kick (one room, or every room they're in). Not undoable: they can rejoin. */
export async function kickDialog(t: Target, roomId?: string, lobby = false): Promise<boolean> {
  const v = await ask({
    title: `Kick ${t.name}`,
    text: lobby ? "They can't come back to this lobby while it lasts." : "They can rejoin right away.",
    fields: [{ name: "reason", label: "Reason (optional, the room sees it)", kind: "text", list: recentReasons() }],
    confirm: "Kick",
    danger: true,
  });
  if (!v) return false;
  rememberReason(v.reason);
  const r = roomId
    ? await act(`/admin/rooms/${roomId}`, { op: "kick", user: t.id, reason: v.reason || null }, `Kicked ${t.name}`)
    : await act(`/admin/players/${encodeURIComponent(t.id)}`, { action: "kick", reason: v.reason || null }, `Kicked ${t.name}`);
  return !!r;
}

/** Shadowban / lift it (src/shadow.ts), with Undo. Resolves with whether it was done. */
export async function shadowDialog(t: Target & { shadow_at?: number | null }): Promise<boolean> {
  const path = `/admin/players/${encodeURIComponent(t.id)}`;
  if (t.shadow_at) {
    const v = await ask({ title: `Lift ${t.name}'s shadowban?`, text: "Everyone sees their runs, ranks, profile and chat again. Their boards are re-scored now.", fields: [{ name: "reason", label: "Reason (staff only)", kind: "text", required: true, list: recentReasons() }], confirm: "Lift shadowban" });
    return !!(v && (await act(path, { action: "unshadow", reason: v.reason }, "Shadowban lifted", { run: () => undoCall(path, { action: "shadow", reason: `Undo lift: ${v.reason}` }, "Shadowbanned again") })));
  }
  const v = await ask({
    title: `Shadowban ${t.name}?`,
    text: "They keep playing and see their own runs and ranks. Nobody else does, and their boards are re-scored without them.",
    fields: [{ name: "reason", label: "Reason (staff only)", kind: "text", required: true, list: recentReasons() }],
    confirm: "Shadowban",
    danger: true,
  });
  if (!v) return false;
  rememberReason(v.reason);
  return !!(await act(path, { action: "shadow", reason: v.reason }, `Shadowbanned ${t.name}`, { run: () => undoCall(path, { action: "unshadow", reason: `Undo shadowban: ${v.reason}` }, "Shadowban lifted") }));
}

/** The warn box's example text. */
const WARN_PRESETS = ["Your name breaks the rules. Please change it."];

/**
 * Warn: a message in the player's inbox, "A warning from staff", with what they read (apps/api src/admin-cases.ts).
 * canRename: also give them a default name in the same go (a rule-breaking name, the usual reason). Logged.
 */
export async function warnDialog(t: Target, o: { canRename?: boolean; actions?: ModRow[] } = {}): Promise<boolean> {
  const prior = (o.actions ?? []).filter((a) => a.action === "player-warn");
  const v = await ask({
    title: `Warn ${t.name}`,
    text: `It lands in their inbox as a warning from staff, and stays in their history here.${prior.length ? ` ${prior.length === 1 ? "Warned once before" : `Warned ${prior.length} times before`}, last ${ago(prior[0].created_at)}.` : ""}`,
    fields: [
      { name: "reason", label: "What they read", kind: "textarea", placeholder: WARN_PRESETS[0] },
      ...(o.canRename ? [{ name: "rename", label: "Also give them a default name", kind: "check" as const }] : []),
    ],
    confirm: "Send warning",
  });
  if (!v) return false;
  if (!v.reason) return void toast("Write what they should read.", true), false;
  const path = `/admin/players/${encodeURIComponent(t.id)}`;
  const r = await act(path, { action: "warn", reason: v.reason }, `Warned ${t.name}`);
  if (r && v.rename) await act(path, { action: "rename", reason: v.reason }, `Warned and renamed ${t.name}`);
  return !!r;
}

export interface NetworkBan {
  id: number;
  kind: "net" | "device" | "fp";
  value: string;
  action: "block" | "shadow";
  source_user: string | null;
  source_name?: string | null;
  reason: string | null;
  created_at?: number;
  expires_at: number | null;
  accounts?: number;
}

export const KIND_LABEL: Record<NetworkBan["kind"], string> = { net: "network", device: "device", fp: "fingerprint" };

/**
 * Ban a network / device / fingerprint (apps/api src/network.ts): block = guest creation, sign-in and run submission
 * refused; shadow = accounts seen there are shadowbanned. With Undo (removes the ban row).
 */
export async function networkBanDialog(kind: NetworkBan["kind"], value: string, user: string | null): Promise<boolean> {
  const v = await ask({
    title: `Ban this ${KIND_LABEL[kind]}?`,
    text:
      kind === "net"
        ? "Networks are shared by homes, schools and carriers. Everyone on it is affected. Prefer the device."
        : kind === "fp"
          ? "Identical machines share a fingerprint. Use with care."
          : "No new guests, sign-ins or runs from this browser.",
    fields: [
      { name: "reason", label: "Reason (staff only)", kind: "text", required: true, list: recentReasons() },
      { name: "days", label: "Days (empty: permanent)", kind: "text", value: kind === "net" ? "30" : "" },
      { name: "shadow", label: "Shadowban accounts seen here instead of blocking them", kind: "check" },
    ],
    confirm: "Ban",
    danger: true,
  });
  if (!v) return false;
  rememberReason(v.reason);
  return !!(await act<{ id?: number }>("/admin/network", { action: "add", kind, value, mode: v.shadow ? "shadow" : "block", reason: v.reason, days: v.days || null, user }, `Banned the ${KIND_LABEL[kind]}`, (r) =>
    r.id ? { run: () => undoCall("/admin/network", { action: "remove", id: r.id }, "Ban removed") } : undefined,
  ));
}

export const MSG_CATEGORIES: [string, string][] = [
  ["announcement", "Announcement"],
  ["update", "Update"],
  ["event", "Event"],
  ["maintenance", "Maintenance"],
  ["support", "Support"],
];

/** A message to one player's inbox. */
export async function messageDialog(userId: string, name: string): Promise<void> {
  const v = await ask({
    title: `Message ${name}`,
    text: 'It lands in their in-game inbox, from "bunnyhop.lol staff".',
    fields: [
      { name: "subject", label: "Subject", kind: "text", required: true },
      { name: "body", label: "Message", kind: "textarea", required: true },
      { name: "category", label: "Category", kind: "select", options: MSG_CATEGORIES, value: "support" },
    ],
    confirm: "Send",
  });
  if (v) await act("/admin/messages", { user: userId, subject: v.subject, body: v.body, category: v.category }, "Message sent");
}
