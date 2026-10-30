// Staff permissions: the one place that says what each staff role may do. DOM-free and shared: the API enforces it on
// every /admin/* endpoint and in-room chat command (apps/api/src/staff.ts, src/rooms/room.ts), and the /admin panel
// reads the same table (GET /admin/me returns the actor's permissions) only to hide what the server would refuse.
//
// Roles, highest first (the server decides them, apps/api/src/roles.ts; clients never claim one):
//   owner      OWNER_ID (and the ADMIN_TOKEN Bearer token, which acts with the owner's permissions)
//   admin      room_admins (D1) or the ROOM_ADMINS var
//   moderator  moderators (D1, migrations/0018)
//
// Each permission names the LOWEST role that holds it. Two rules sit on top of the table:
//   - rank: nobody but the owner acts on staff of their own rank or higher (outranks);
//   - moderator bans: temporary only, at most MOD_BAN_MAX_MINUTES, never replacing a ban set by an admin, and a
//     moderator lifts only bans set by moderators;
//   - every staff role can lift a shadowban, including automatic false positives, with a logged reason.

import type { StaffRole } from "../progression";

export const ROLE_RANK: Readonly<Record<StaffRole, number>> = { moderator: 1, admin: 2, owner: 3 };

/** Longest ban a moderator may give (7 days). */
export const MOD_BAN_MAX_MINUTES = 7 * 24 * 60;

export const PERMISSIONS = {
  // --- read (the panel's tabs)
  overview: "moderator",
  "chat.read": "moderator",
  "players.read": "moderator",
  /** The accounts behind a player's IP hash (moderators only get the "has alts" signal) and raw IP hashes. */
  "players.alts": "admin",
  /** Network / device / fingerprint bans (apps/api src/network.ts). */
  "players.network": "admin",
  "rooms.read": "moderator",
  /** Private lobbies (apps/api src/rooms/config.ts): the open ones with who is in them, and usage. Never their chat. */
  "lobbies.read": "admin",
  /** Kick a player out of a private lobby, or close one. Never its chat (lobby chat is private and never logged). */
  "lobbies.manage": "admin",
  "runs.read": "moderator",
  "names.read": "moderator",
  "feedback.read": "moderator",
  "integrity.read": "moderator",
  "log.read": "moderator",
  /**
   * The Staff page: who holds which role, each one's actions in the last 7 days and the latest moderator actions. It's
   * staff management and oversight of moderators, so admins. Who is staff stays public through the staff badges.
   */
  "staff.read": "admin",
  /** Any replay, in any state (rejected / flagged runs too). */
  "replays.any": "moderator",
  // --- player moderation
  "player.mute": "moderator",
  "player.kick": "moderator",
  /** Bans up to MOD_BAN_MAX_MINUTES, in a room or server-wide. */
  "player.ban.temp": "moderator",
  /** Permanent bans and bans longer than MOD_BAN_MAX_MINUTES. */
  "player.ban.perm": "admin",
  /** Lifting bans set by moderators. */
  "player.unban": "moderator",
  /** Lifting any ban (set by an admin, the owner or the token). */
  "player.unban.any": "admin",
  "player.links": "moderator",
  /** Remove a player's Discord avatar and block turning it back on (or allow it again). */
  "player.avatar": "moderator",
  "player.marks": "admin",
  /** Supporter: grant or revoke it (gifts, refunds, chargebacks; src/supporters.ts). */
  "player.supporter": "admin",
  "player.message": "admin",
  /**
   * A warning in the player's inbox, with the reason they read (src/admin-cases.ts). Fixed form ("A warning from
   * staff"), so moderators can send it; a free-form message stays player.message.
   */
  "player.warn": "moderator",
  /** Staff notes on a player (read and write; every staff role sees them, players never do). */
  "player.notes": "moderator",
  /** Work the Board tabs: move a case, assign it, label it, comment on it (src/admin-cases.ts). */
  "cases.work": "moderator",
  /**
   * Shadowban / un-shadow (src/shadow.ts: the player keeps playing, nobody else sees them). A softer action than a ban,
   * so moderators hold it like player.ban.temp; every lift requires a reason in the audit log.
   */
  "player.shadow": "moderator",
  /** Lifting any shadowban (set by an admin, the owner, the token, Bun-E or the anticheat / ban-evasion rules). */
  "player.unshadow.any": "moderator",
  // --- names
  "names.rename": "moderator",
  "names.unban": "admin",
  /** Blocked terms. Moderators may only suggest one (logged for an admin). */
  "names.terms": "admin",
  // --- feedback inbox: status, note, reply
  "feedback.reply": "moderator",
  /**
   * A moderator application's vetting summary (the applicant's account, runs, level, chat, moderation history and
   * anticheat flags in one place). Deciding who joins the staff is an admin's call (staff.moderators), so moderators
   * read and answer applications without it.
   */
  "applications.vet": "admin",
  // --- Suspicious view
  "integrity.review": "moderator",
  "integrity.approve": "admin",
  "integrity.ban": "admin",
  // --- runs, rooms, announcements
  "runs.manage": "admin",
  /** Change map, extend, force a map vote. */
  "rooms.map": "admin",
  "announce": "admin",
  /** Discord WR feed: settings, posts. */
  "discord": "admin",
  /** Boards → Maps and tiers: every map with its tier, ranked state, finishers, WR, open flags and feedback. */
  "maps.read": "admin",
  /** Change a map's tier or take it off the ranked boards (retire). Every board's points follow, so the owner's call. */
  "maps.manage": "owner",
  /** Pulse → what the Worker costs (D1 rows read and written today, from Cloudflare's analytics). */
  "costs.read": "admin",
  /** The one-off achievement XP backfill (api/src/achievement-xp.ts): every player's level can move, so the owner's. */
  "progression.backfill": "owner",
  // --- the staff handbook (/docs, apps/api/src/docs.ts; pages in docs/)
  /** Read the handbook's staff pages. Admins for now; players with the Contributor badge read them too (no role). */
  "docs.read": "admin",
  /** Read the handbook's admin pages too: anticheat internals, moderation policy, player data, Bun-E. */
  "docs.admin": "admin",
  // --- staff
  "staff.moderators": "admin",
  "staff.admins": "owner",
} as const satisfies Record<string, StaffRole>;

export type Permission = keyof typeof PERMISSIONS;

/** What each permission lets you do, for "Only admins can ..." refusals. */
const LABELS: Record<Permission, string> = {
  overview: "see the overview",
  "chat.read": "read the chat log",
  "players.read": "look up players",
  "players.alts": "see accounts that share an IP",
  "players.network": "ban networks or devices",
  "rooms.read": "see the live rooms",
  "lobbies.read": "see private lobbies",
  "lobbies.manage": "kick players from or close private lobbies",
  "runs.read": "list runs",
  "names.read": "see the name lists",
  "feedback.read": "read feedback",
  "integrity.read": "see the Suspicious view",
  "log.read": "read the moderation log",
  "staff.read": "see the staff list",
  "replays.any": "watch unverified replays",
  "player.mute": "mute players",
  "player.kick": "kick players",
  "player.ban.temp": "ban players",
  "player.ban.perm": `ban permanently or for more than ${MOD_BAN_MAX_MINUTES / 1440} days`,
  "player.unban": "unban players",
  "player.unban.any": "lift a ban an admin set",
  "player.links": "clear profile links",
  "player.avatar": "remove Discord avatars",
  "player.marks": "give Verified or Creator marks",
  "player.supporter": "grant or revoke Supporter",
  "player.shadow": "shadowban players",
  "player.unshadow.any": "lift a shadowban an admin or the anticheat set",
  "player.message": "message players directly",
  "player.warn": "warn players",
  "player.notes": "write player notes",
  "cases.work": "work the case boards",
  "names.rename": "rename players or ban names",
  "names.unban": "unban names",
  "names.terms": "block or unblock name terms",
  "feedback.reply": "reply to feedback",
  "applications.vet": "see the vetting summary on moderator applications",
  "integrity.review": "mark flagged runs reviewed",
  "integrity.approve": "approve rejected runs",
  "integrity.ban": "use Ban + invalidate",
  "runs.manage": "invalidate or re-verify runs",
  "rooms.map": "change the map, extend or start a map vote",
  announce: "send announcements",
  discord: "post to Discord or change its settings",
  "maps.read": "see the maps list",
  "maps.manage": "change map tiers or retire maps",
  "costs.read": "see what the servers cost",
  "progression.backfill": "pay achievement XP for achievements already held",
  "docs.read": "read the staff handbook",
  "docs.admin": "read the handbook's admin pages",
  "staff.moderators": "add or remove moderators",
  "staff.admins": "add or remove admins",
};

/** Whether `role` holds `perm` (null = not staff: nothing). */
export function can(role: StaffRole | null | undefined, perm: Permission): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[PERMISSIONS[perm]];
}

/** Every permission `role` holds (GET /admin/me, for the panel's UI gating). */
export function permissionsOf(role: StaffRole | null | undefined): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}

/** The refusal for a staff member without `perm`: "Only admins can invalidate or re-verify runs." */
export function deniedMessage(perm: Permission): string {
  return `Only ${PERMISSIONS[perm] === "owner" ? "the owner" : "admins"} can ${LABELS[perm]}.`;
}

/** Rank of a role; 0 = not staff. */
export const rankOf = (role: StaffRole | null | undefined): number => (role ? ROLE_RANK[role] : 0);

/** Whether `actor` may act on a player holding `target` (the owner acts on anyone; everyone else only on lower ranks). */
export function outranks(actor: StaffRole | null | undefined, target: StaffRole | null | undefined): boolean {
  if (!actor) return false;
  return actor === "owner" || rankOf(actor) > rankOf(target);
}

export const RANK_DENIED = "You can't act on staff of your own rank or higher.";

/**
 * A ban's length check: null when `role` may ban for `minutes` (null = permanent), else the refusal. Moderators: 1 to
 * MOD_BAN_MAX_MINUTES.
 */
export function banProblem(role: StaffRole | null | undefined, minutes: number | null): string | null {
  if (can(role, "player.ban.perm")) return null;
  if (!can(role, "player.ban.temp")) return deniedMessage("player.ban.temp");
  if (minutes === null || minutes > MOD_BAN_MAX_MINUTES) return `Moderators can ban for up to ${MOD_BAN_MAX_MINUTES / 1440} days (${MOD_BAN_MAX_MINUTES} minutes).`;
  return null;
}

/** Which role a granter may give or take: moderator (admins and the owner), admin (the owner only). */
export function grantPermission(role: "admin" | "moderator"): Permission {
  return role === "admin" ? "staff.admins" : "staff.moderators";
}
