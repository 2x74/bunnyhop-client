// A player in context: the data behind GET /admin/players/:id (full page and ?lite=1), and the pieces the player drawer
// (drawer.ts) and the anticheat case view (cases.ts) share: who they are in state words, their flags and how each ended,
// alts and linked accounts, bans, recent chat, recent runs and moderation.

import { ago, badge, clientTag, emptyLine, fmtTime, h, n, plural, playerLink, staffShield, when, type ChatRow, type Child, type ModRow, type RunClient } from "./core";
import { mapArt } from "./art";
import { actionWords, detailSentence } from "./words";
import type { NetworkBan } from "./dialogs";
import type { StaffRole } from "../progression";
import type { Note } from "./notes";

export interface PlayerNetwork {
  devices: { device_id: string; fp_hash: string | null; first_seen: number; last_seen: number }[];
  nets: { net_hash: string; first_seen: number; last_seen: number }[];
  linked: { id: string; name: string; via: "device" | "fp" | "net"; banned: boolean; shadowed: boolean }[];
  bans: NetworkBan[];
}

export interface FlagRow {
  run_id: string;
  tier: "blatant" | "suspicious";
  score: number;
  review: string | null;
  /** "system": closed on arrival, the player was already shadowed / banned (apps/api src/shadow.ts dealtWithNote). */
  reviewed_by?: string | null;
  reviewed_at: number | null;
  note: string | null;
  map: string;
  style: string;
  status: string;
  time: number | null;
  created_at: number;
  client?: RunClient;
}

export interface PlayerDetail {
  user: {
    id: string; name: string; provider: string; avatar_url: string | null; ip_hash?: string | null; merged_into: string | null; created_at: number; updated_at: number; verified?: number; creator?: string | null; special_badges?: string | null;
    discord_avatar_url?: string | null; use_discord_avatar?: number; discord_avatar_blocked?: number;
    bunny_avatar_url?: string | null; bunny_custom?: number;
    shadow_at?: number | null; shadow_reason?: string | null; shadow_source?: string | null;
  };
  links?: { links: Record<string, string>; show: boolean };
  booster?: { member: boolean; boosting: boolean; since: number | null; checkedAt: number; hidden: boolean; shown: boolean } | null;
  wings?: { earned: boolean; at: number | null; runId: string | null };
  supporter?: { since: number; source: string | null; badgeShown: boolean; nameColor: string | null; nameEffect?: string | null; shown?: boolean; cents?: number } | null;
  configAdmin: boolean;
  sessions: { sessions: number; last_seen: number | null };
  runStats: { status: string; n: number }[];
  runs: { id: string; map: string; style: string; track: number; status: string; reason: string | null; time: number | null; room_id: string | null; created_at: number; pb: number | null; client?: RunClient }[];
  bans: { room_id: string; until: number | null; reason: string | null; banned_by: string | null; created_at: number }[];
  admin: { note: string | null; created_at: number } | null;
  names: { old_name: string | null; new_name: string; source: string; actor_id: string | null; reason: string | null; created_at: number }[];
  chat: ChatRow[];
  actions: ModRow[];
  points: { points: number; records: number; wrs: number; top10s: number } | null;
  alts: { id: string; name: string; provider: string; created_at: number; banned?: number; shadowed?: number }[];
  altCount?: number;
  role?: StaffRole | null;
  identities: { provider: string; username: string | null; created_at: number }[];
  network?: PlayerNetwork | null;
  rooms: { id: string; name: string; reachable: boolean; online: boolean; slot: number | null; muted: number | null }[];
  /** 0.0.22: flags (how each ended) and feedback tickets; lite = no rooms or network. */
  lite?: boolean;
  flags?: FlagRow[];
  tickets?: { id: string; category: string; status: string; message: string; created_at: number }[];
  /** Player reports about them (apps/api src/player-reports.ts), newest first. */
  reports?: { id: string; status: string; user_id: string | null; user_name: string | null; message: string; created_at: number }[];
  /** Staff notes on the player, pinned first (apps/api src/admin-cases.ts). */
  notes?: Note[];
}

export const activeBan = (d: PlayerDetail, now = Date.now()) => d.bans.find((b) => b.until === null || b.until > now) ?? null;
export const roleOf = (d: PlayerDetail): StaffRole | null => (d.role !== undefined ? d.role : d.admin || d.configAdmin ? "admin" : null);

/** The player's states as words: account kind, staff role, banned, shadowed, merged, joined. */
export function stateWords(d: PlayerDetail): HTMLElement[] {
  const u = d.user;
  const ban = activeBan(d);
  const role = roleOf(d);
  return [
    badge(u.provider === "guest" ? "guest" : "signed in", u.provider === "guest" ? "" : "info"),
    role ? badge(role, "acc") : null,
    ban ? badge(ban.until ? `banned until ${when(ban.until)}` : "banned for good", "bad") : null,
    u.shadow_at ? badge(`shadowed ${ago(u.shadow_at)}${u.shadow_source && u.shadow_source !== "admin" ? ` by ${u.shadow_source.replace(/^auto:/, "")}` : ""}`, "warn") : null,
    u.merged_into ? badge("merged", "warn") : null,
    ...d.rooms.filter((r) => r.online).map((r) => badge(`in ${r.id}`, "ok")),
    ...d.rooms.filter((r) => r.muted !== null).map((r) => badge(`muted in ${r.id}`, "bad")),
    h("span", { class: "faint" }, `joined ${ago(u.created_at)}`),
  ].filter((x): x is HTMLElement => !!x);
}

/** reviewed_by of flags closed on arrival (apps/api src/shadow.ts AUTO_REVIEWER). */
export const AUTO_REVIEWER = "system";

/** How a flag ended, as a word with its colour. */
export function flagEnd(f: FlagRow): HTMLElement {
  if (f.review === "cleared") return badge("cleared", "");
  if (f.review === "approved") return badge("approved", "ok");
  if (f.review === "actioned" && f.reviewed_by === AUTO_REVIEWER) return badge(f.note ?? "already shadowed", "");
  if (f.review === "actioned") return badge("actioned", "bad");
  return badge(f.tier === "blatant" ? "open, blatant" : "open", f.tier === "blatant" ? "bad" : "warn");
}

/** A compact list section: a title with its count, then rows (or one empty line). */
export function listSection(title: string, rows: Child[], empty: string, extra?: Child): HTMLElement {
  const list = rows.filter(Boolean);
  return h("section", { class: "ctx-sec" }, h("h3", null, title, list.length ? h("small", null, String(list.length)) : null, extra ?? null), list.length ? h("div", { class: "ctx-rows" }, list) : emptyLine(empty));
}

export function flagRows(flags: FlagRow[], max = 8): HTMLElement[] {
  return flags.slice(0, max).map((f) =>
    h(
      "a",
      { class: "ctx-row two", href: `#/suspicious?run=${encodeURIComponent(f.run_id)}` },
      h("span", { class: `score-n ${f.score >= 90 ? "hi" : f.score >= 70 ? "mid" : ""}` }, String(f.score)),
      mapArt(f.map),
      h("span", { class: "ctx-main" }, h("span", { class: "ctx-name" }, f.map, " ", h("span", { class: "t-run" }, fmtTime(f.time))), h("span", { class: "ctx-sub" }, flagEnd(f), h("span", { class: "faint" }, ago(f.created_at)), clientTag(f.client))),
    ),
  );
}

export function chatLines(chat: ChatRow[], max = 10): HTMLElement[] {
  return chat.slice(0, max).map((m) =>
    h(
      "div",
      { class: `ctx-chat${m.blocked || m.muted ? " dropped" : ""}`, title: when(m.created_at) },
      h("span", { class: "faint ctx-when" }, ago(m.created_at)),
      h("span", { class: "ctx-msg" }, m.shown ?? m.raw),
      m.blocked ? badge("blocked", "bad") : m.muted ? badge("muted", "bad") : m.filtered ? badge("filtered", "warn") : null,
    ),
  );
}

export function runRows(runs: PlayerDetail["runs"], max = 5): HTMLElement[] {
  return runs.slice(0, max).map((r) =>
    h(
      "div",
      { class: "ctx-row two" },
      h("span"),
      mapArt(r.map),
      h(
        "span",
        { class: "ctx-main" },
        h("span", { class: "ctx-name" }, r.map, r.track ? h("span", { class: "faint" }, ` b${r.track}`) : null, " ", h("span", { class: "t-run" }, fmtTime(r.time))),
        h("span", { class: "ctx-sub" }, r.status === "verified" ? (r.pb ? badge("PB", "acc") : h("span", { class: "faint" }, "verified")) : badge(r.status, r.status === "rejected" || r.status === "error" ? "bad" : ""), h("span", { class: "faint" }, ago(r.created_at)), clientTag(r.client)),
      ),
    ),
  );
}

export function modRows(actions: ModRow[], max = 5): HTMLElement[] {
  return actions.slice(0, max).map((e) => {
    const [w, k] = actionWords(e.action);
    return h(
      "div",
      { class: "ctx-mod" },
      h("span", { class: `act-word ${k}` }, w),
      h("span", { class: "faint" }, ` by ${e.actor_id === "token" ? "the admin token" : (e.actor_name ?? e.actor_id)}, ${ago(e.created_at)}`),
      detailSentence(e.action, e.details, e.room_id) ? h("div", { class: "faint ctx-detail" }, detailSentence(e.action, e.details, e.room_id)) : null,
    );
  });
}

/** Alts (same IP hash) and accounts linked through a device / fingerprint / network, with their states. */
export function altRows(d: PlayerDetail): HTMLElement[] {
  const rows: HTMLElement[] = d.alts.map((a) => h("div", { class: "ctx-row" }, playerLink(a.id, a.name), h("span", { class: "faint" }, "same IP"), a.banned ? badge("banned", "bad") : null, a.shadowed ? badge("shadowed", "warn") : null));
  for (const l of d.network?.linked ?? []) {
    if (d.alts.some((a) => a.id === l.id)) continue;
    rows.push(h("div", { class: "ctx-row" }, playerLink(l.id, l.name), h("span", { class: "faint" }, `same ${l.via === "fp" ? "fingerprint" : l.via === "net" ? "network" : "device"}`), l.banned ? badge("banned", "bad") : null, l.shadowed ? badge("shadowed", "warn") : null));
  }
  if (!rows.length && d.altCount) rows.push(h("div", { class: "ctx-row faint" }, `${plural(d.altCount, "other account")} on the same IP. Admins see which.`));
  return rows;
}

/** One line of standing: points, records, WRs, top 10s. */
export function standing(d: PlayerDetail): string {
  const p = d.points;
  const verified = d.runStats.find((x) => x.status === "verified")?.n ?? 0;
  return p ? `${n(Math.round(p.points))} points, ${plural(p.wrs, "WR")}, ${plural(p.top10s, "top 10")}, ${n(verified)} verified runs` : `Unranked, ${n(verified)} verified runs`;
}

export const nameWithShield = (d: PlayerDetail) => [d.user.name, staffShield(roleOf(d))];
