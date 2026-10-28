import { appHref } from "./platform/navigation";
import type { AvatarSpec } from "./avatar/spec";
import type { PlayerGlow } from "./player/glow-config";
// Client contract for the bunnyhop.lol backend (apps/api). UI code depends only on these signatures.
// When VITE_API_URL is unset (or the API is unreachable) callers should degrade gracefully:
// leaderboards show "offline", submissions stay local.
//
// Identity is guest-first: the first call to me() issues a guest identity (HttpOnly session cookie set by the API,
// display name like "guest-1234"). discordLoginUrl() optionally links a Discord account so progress is saved
// across devices; existing guest runs carry over. All requests use credentials: "include".
//
// Session creation and run submissions carry the device id and fingerprint hash (device.ts: x-bh-device / x-bh-fp; the server's
// network / device bans and ban-evasion checks, apps/api src/network.ts). Reads carry the device id in its cookie.

import type { NameColorId, NameEffect, PlayerMarks, ProfileLink, ProfileLinks } from "./creators";
import { deviceHeaders } from "./device";
import { resolveMe } from "./me-rules";
import { WAVEDASH } from "./platform/env";
import { wavedashCredentials, wavedashUserId } from "./platform/wavedash";
import type { GiftTarget, GiftWallet, GiftPreview, GiftDelivery } from "./gifting";

/** Account-owned name badge selection and Prism appearance. */
/** One of your map groups (map-groups.ts; GET / POST /me/map-groups). */
export interface ApiMapGroup {
  id: string;
  name: string;
  maps: string[];
}
/** A change to one map group: {id, delete: true}, or a name (creates or renames) and maps to add / remove. */
export type ApiMapGroupChange = { id: string; delete: true } | { id: string; name?: string; add?: string[]; remove?: string[] };

export interface GameStats {
  now: number;
  totals: { maps: number; players: number; playersWhoJumped: number; verifiedRuns: number; mapsCompleted: number; jumps: number; playtimeSeconds: number; runTimeMs: number; replayViews?: number };
  concurrency: { current: number | null; peak24h: { count: number; at: number } | null; peakAllTime: { count: number; at: number } | null; trackingSince: number | null; windowMs: number; unit: string; history?: { at: number; count: number }[] } | null;
  mostWatched?: MostWatchedEntry[];
}

export interface MostWatchedEntry { rank: number; views: number; player: ApiPlayer }
/** The Stats screen's player leaderboards (apps/api src/stat-boards.ts). */
export type StatBoardId = "wrs" | "hardest" | "maps" | "finishes" | "playtime" | "views" | "gifts";
/** value: the count (hardest clears: maps at `tier`, the highest tier cleared). */
export interface StatBoardEntry { rank: number; value: number; tier?: number; player: ApiPlayer }
export interface StatBoardPage { total: number; offset: number; entries: StatBoardEntry[]; me: StatBoardEntry | null; matches?: number }

export interface NameBadgeSettings {
  staff?: import("./creators").StaffBadge | null;
  /** A moderator holding Contributor: picking it wears it in the shield's place. */
  contributorForStaff?: boolean;
  nameBadges: string[];
  owned: string[];
  giftsSent: number;
  gifterColors: string[];
  gifterAnimated: boolean;
}

/** A supporter's own settings (apps/api src/supporters.ts). */
export interface SupporterSettings {
  playerGlow: PlayerGlow;
  since: string;
  nameColor: NameColorId | null;
  /** Name effect (creators.ts NAME_EFFECTS), null = plain. */
  nameEffect: NameEffect | null;
  /** The gradient's second colour, null = automatic. */
  nameColor2: NameColorId | null;
  showBadge: boolean;
  /** On Top supporters and the About page's thank-you list (shown by default). */
  showOnBoard: boolean;
}

/** One row of Top supporters (GET /supporters): biggest total first, ties to the earliest supporter. */
export interface TopSupporter {
  id: string;
  name: string;
  /** Total contributed, whole US dollars. */
  dollars: number;
  /** Supporter since (ms). */
  since: number;
  nameColor: NameColorId | null;
  nameEffect: NameEffect | null;
  nameColor2: NameColorId | null;
  /** The supporter badge shows (not hidden by the player). */
  badge: boolean;
}

/** GET /me/supporter: your support (null = not a supporter yet), the minimum payment and whether payments are open. */
export interface MySupport {
  supporter: SupporterSettings | null;
  minUsd: number;
  /** Stripe payments are open (the API has its key); else the Support page shows "Coming soon". */
  payments?: boolean;
}

/** Profile links as the owner edits them: handles per platform and the "show on my profile" switch. */
export interface LinkSettings {
  links: ProfileLinks;
  show: boolean;
}

export interface User {
  id: string;
  name: string;
  avatarUrl: string | null;
  /** "guest" | "discord" (more providers may be added). */
  provider: string;
  /**
   * Own account only (me()), Discord linked: the Discord avatar (null: Discord's default one, so the letter shows) and
   * whether it's shown publicly as avatarUrl.
   */
  discordAvatarUrl?: string | null;
  useDiscordAvatar?: boolean;
  /** Own account only: staff removed the Discord avatar and blocked turning it back on. */
  discordAvatarBlocked?: boolean;
  /** Own account only: onboarding finished or skipped (ui/onboarding.ts). */
  onboarded?: boolean;
  /** Own account only: a supporter (the reserved slot in a full room, ui/servers.ts). Absent = no. */
  supporter?: boolean;
  /** setDisplayName(): a guest asked for a taken name and got a numbered variant. */
  nameAdjusted?: boolean;
}

/** GET /names/check (rules: moderation/names.ts; policy: apps/api/src/names.ts). */
export interface NameCheck {
  ok: boolean;
  /** As it would be saved (trimmed, folded). */
  name?: string;
  available?: boolean;
  error?: string;
  message?: string;
  /** A free numbered variant when taken. */
  suggestion?: string | null;
  /** Saving would use `suggestion` automatically (guests). */
  adjusts?: boolean;
}

export interface SignInMethod {
  /** "wavedash": the player's Wavedash account (the Wavedash build signs in with it). */
  provider: "discord" | "email" | "wavedash";
  label: string;
  since: string;
}

export interface OnboardingState {
  done: boolean;
  at: string | null;
  steps: Record<string, number>;
}

/** GET /me/account */
export interface AccountView {
  user: User;
  methods: SignInMethod[];
  canUnlink: Record<string, boolean>;
  name: { isDefault: boolean; changesLeft: number; limit: number; resetAt: string | null };
  onboarding: OnboardingState;
}

export interface EmailStart {
  ok: boolean;
  expiresIn: number;
  /** Local dev only: the API logs instead of sending and hands these back. */
  devCode?: string;
  devLink?: string;
}

export interface LeaderboardEntry {
  rank: number;
  runId: string;
  /** `provider` is "guest" for guest players (show a badge). */
  player: ApiPlayer;
  /** Verified time in ticks and seconds (server-computed from the replay). */
  ticks: number;
  time: number;
  /** ISO date the run was verified. */
  date: string;
  jumps: number;
  strafes?: number | null;
  perf?: number | null;
  sync: number;
  /** Physics version the run was played with (core.ts PHYSICS_*; absent from APIs before physics versions = 1). */
  physics?: number;
}

export interface Leaderboard {
  /** 0 = main, N = bonus N. */
  track?: number;
  map: string;
  style: string;
  /** Total ranked players on this board. */
  total: number;
  entries: LeaderboardEntry[];
  /** The signed-in player's own entry, if ranked (may be outside `entries`). */
  me: LeaderboardEntry | null;
  /** First row returned (differs from the request only with `around`). Absent from older APIs. */
  offset?: number;
  /** The board's first row (world record), on every page. Absent from older APIs. */
  wr?: LeaderboardEntry | null;
  /** With `q`: the search echoed back and how many players match (entries = the first matches). */
  query?: string;
  matches?: number;
}

/**
 * Board read options (GET /leaderboards/..., /ranks/...). `around`: return the page of `limit` rows holding this
 * player, on the page grid that starts at `offset`. `q`: player-name search (case-insensitive, at most 20 matches).
 */
export interface BoardReadOptions {
  offset?: number;
  limit?: number;
  around?: string;
  q?: string;
  /** Map boards: "following" = only the players you follow, and you (true ranks). */
  scope?: "following";
}

/** error: the server couldn't verify the run (a problem on our side, after retries); not a verdict on the run. */
export type SubmissionStatus = "queued" | "verifying" | "verified" | "rejected" | "error";

export interface Submission {
  /** Immutable verified finish cue; rank can change later or tie another run. */
  announcer?: "pb" | "wr" | null;
  pb?: boolean;
  /** Empty when the server refused the upload outright (status "rejected", see `reason`). */
  id: string;
  status: SubmissionStatus;
  /** While a long run is verifying: the share of its replay re-simulated so far (0-1). */
  progress?: number;
  /** Present once verified. */
  rank?: number;
  time?: number;
  /** Present when rejected (desync, wrong map hash, zone mismatch, ...). */
  reason?: string;
  /** Machine-readable rejection code for refused uploads (e.g. "unranked_map", "zones_mismatch", "rate_limited"). */
  code?: string;
  // --- progression (verified runs): XP earned, points the run holds, achievements it unlocked, the player's level
  xp?: number;
  points?: number | null;
  achievements?: string[];
  level?: LevelView;
  /** POST /runs?gauntlet=<attemptId> only: whether the run became the attempt's next split (apps/api src/gauntlets.ts). */
  gauntlet?: GauntletSplitResult;
}

// ---------------------------------------------------------------------------------------------
// Gauntlets (apps/api src/gauntlets.ts, research/GAUNTLETS.md): a fixed, ordered list of maps cleared in one attempt.
// Times in seconds (ticks x tick interval) like map boards; dates in ms since the epoch.

export type GauntletAttemptState = "open" | "finished_pending" | "complete" | "failed" | "expired" | "abandoned";

/** The 202 reply's `gauntlet` for a run submitted with ?gauntlet=. */
export interface GauntletSplitResult {
  attemptId: string;
  /** The split's index, or null: not a split (`reason`). */
  split: number | null;
  reason?: string;
  state?: GauntletAttemptState;
}

interface GauntletHead {
  slug: string;
  title: string;
  official: boolean;
  style: string;
  startsAt: number | null;
  endsAt: number | null;
  publishedAt: number | null;
  maxMs: number;
  /** permanent | weekly (Monday to Monday, `week` its Monday) | event (dated). Absent from a pre-0.0.25 server. */
  kind?: GauntletKind;
  week?: string | null;
}

export type GauntletKind = "permanent" | "weekly" | "event";

export interface GauntletListItem extends GauntletHead {
  maps: number;
  finishers: number;
  /** The world record's total (seconds), null without finishers. */
  wrTime?: number | null;
  /** Your rank and total (seconds) on it, when you have finished it. */
  me?: { rank: number; time: number } | null;
}

/** GET /gauntlets: this week's weekly, the permanent ones and events, past weeks with their winner. */
export interface GauntletHub {
  weekly: (GauntletListItem & {
    mapList: { idx: number; map: string; title: string; tier: number | null }[];
    top: { rank: number; player: ApiPlayer; time: number }[];
  }) | null;
  gauntlets: GauntletListItem[];
  past: (GauntletListItem & { winner: { player: ApiPlayer; time: number } | null })[];
}

/** GET /gauntlets/attempts/:id/watch: an attempt to watch whole (gauntlet/watch.ts, viewer/gauntlet-layer.ts). */
export interface GauntletWatchPlan {
  attemptId: string;
  state: GauntletAttemptState;
  gauntlet: { slug: string; title: string; kind: GauntletKind; maps: number };
  player: ApiPlayer;
  totalTicks: number | null;
  realMs: number | null;
  finishedAt: number | null;
  /** In order; `mapSha256`: the build the run was played on (its replay re-simulates on that BSP). */
  splits: { idx: number; map: string; runId: string; ticks: number; time: number; mapSha256: string; verified: boolean }[];
  record: { attemptId: string; player: ApiPlayer; splits: { idx: number; time: number }[] } | null;
}

/** GET /players/:id/gauntlets. */
export interface PlayerGauntlets {
  pbs: { slug: string; title: string; kind: GauntletKind; week: string | null; attemptId?: string; rank: number; of: number; ticks: number; time: number; at: number }[];
  /** Weekly podiums (rank 1-3), latest first. */
  weeklyWins: { week: string; slug: string; title: string; rank: number; time: number }[];
}

export interface GauntletSplit {
  idx: number;
  map: string;
  runId: string;
  ticks: number;
  time: number;
}

export interface GauntletEntry {
  rank: number;
  attemptId: string;
  player: ApiPlayer;
  totalTicks: number;
  /** Sum of the splits' run times (s): the ranked total. */
  time: number;
  /** First start to last arrival (ms), shown, never ranked. */
  realMs: number;
  date: number;
  splits: GauntletSplit[];
}

export interface GauntletDetail extends GauntletHead {
  maps: { idx: number; map: string; title: string; tier: number | null; track: number }[];
  finishers: number;
  wr: GauntletEntry | null;
  /** Your gauntlet PB (null: none, or signed out). */
  me: GauntletEntry | null;
}

export interface GauntletBoard {
  slug: string;
  total: number;
  offset: number;
  entries: GauntletEntry[];
  me: GauntletEntry | null;
}

export interface GauntletAttempt {
  id: string;
  gauntlet: { slug: string; title: string; maxMs: number };
  state: GauntletAttemptState;
  step: number;
  startedAt: number;
  lastPingAt: number;
  expiresAt: number | null;
  finishedAt: number | null;
  realMs: number | null;
  totalTicks: number | null;
  maps: { idx: number; map: string; track: number }[];
  /** The map to play now (open attempts), else null. */
  next: { idx: number; map: string } | null;
  splits: (GauntletSplit & { arrivedAt: number; verified: boolean })[];
}

// ---------------------------------------------------------------------------------------------
// Profiles, ranks, cosmetics (apps/api/src/profile.ts). Formula + titles: ranking.ts; XP/achievements: progression.ts.

export interface LevelView {
  level: number;
  xp: number;
  into: number;
  need: number;
  fraction: number;
}

export interface RankView {
  /** "all" (overall) or a style id. */
  scope: string;
  points: number;
  rank: number | null;
  ranked: number;
  records: number;
  wrs: number;
  top10s: number;
  group: { id: string; name: string; color: string };
}

/** A verified run on a profile (featured, recent PBs, replay list). */
export interface RunCard {
  runId: string;
  map: string;
  tier: number | null;
  style: string;
  track: number;
  ticks: number;
  time: number;
  jumps: number;
  strafes: number;
  sync: number;
  date: string;
  rank: number | null;
  players: number | null;
  points: number | null;
  pb: boolean;
  /** Counted replay views (absent from older APIs). */
  views?: number;
}

/** GET /players/:id/points: the records giving the most points on a rank board (scope "all" or a style). */
export interface PointsRecord {
  map: string;
  tier: number;
  style: string;
  track: number;
  rank: number;
  players: number;
  runId: string;
  /** What the record scores on that board (Overall: style-weighted; a style: raw). */
  points: number;
  /** What it adds to the total after the 0.975-per-place weighting. */
  counted: number;
}

export type CosmeticChoice = Record<"background" | "frame" | "title" | "ghost" | "trail" | "outfit" | "knife" | "finish" | "glove" | "hat" | "body", string | null>;

/**
 * A player as boards, ranks, records and profiles name them. verified / creator: admin-granted marks (creators.ts),
 * decided by the server; absent from older APIs.
 */
export interface ApiPlayer extends PlayerMarks {
  playerGlow?: PlayerGlow | null;
  country?: string | null;
  id: string;
  name: string;
  avatarUrl: string | null;
  provider?: string;
}

/** Staff role the API reports for a player (progression.ts StaffRole): "owner" | "admin" | "moderator". */
export type ApiStaffRole = "owner" | "admin" | "moderator";

export interface Profile {
  nameBadgeSettings?: NameBadgeSettings | null;
  player: ApiPlayer & { provider: string; since: string; mouse?: import("./mouse-settings").MouseSettings & { updatedAt?: number } | null };
  /**
   * Your own profile while you boost the Discord server: the "Show booster badge" switch (Edit card → Badges). null /
   * absent otherwise (older APIs too).
   */
  boosterSettings?: { show: boolean } | null;
  /**
   * Your own profile while you're a supporter: the name colour (null = white), the "Show supporter badge" switch and the
   * About page listing (Edit card → Name, Badges). null / absent otherwise.
   */
  supporterSettings?: SupporterSettings | null;
  /** Staff role ("owner" / "admin"), decided by the server; null / absent (older APIs) = none. */
  role?: ApiStaffRole | null;
  /** The viewer is this player. */
  mine: boolean;
  /** Profile links the player shows (URLs built by the server from allowlisted domains). Absent from older APIs. */
  links?: ProfileLink[];
  /** Your own profile: the link editor's state (Customise → Links). */
  linkSettings?: LinkSettings | null;
  level: LevelView;
  rank: RankView;
  styles: RankView[];
  stats: {
    clearsByTier: number[];
    rankedByTier: number[];
    maps: number;
    pbs: number;
    wrs: number;
    top10s: number;
    bonuses: number;
    runs: number;
    jumps: number;
    /** Seconds on the clock in verified finishes (Clocked In / Overtime). */
    seconds: number;
    /** Seconds actually played (apps/api src/playtime.ts): the card's "12.4h played". */
    playtime: number;
    replayViews: number;
    styleMaps: Record<string, number>;
    clearedMaps: string[];
  };
  /**
   * Followers / following / friends (apps/api src/social.ts followCounts); `you`: how a signed-in visitor stands with
   * this player. Absent from older APIs.
   */
  social?: ProfileSocial;
  cosmetics: CosmeticChoice;
  badges: string[];
  /** map: where the run that earned it was (absent when no run did: level-ups, community rewards, older records). */
  achievements: { id: string; unlockedAt: string; map?: string }[];
  /** Owner only: [current, goal] for locked achievements. */
  progress: Record<string, [number, number]> | null;
  /**
   * Your own profile: unlock notices already shown on any device (notices.ts; ui/unlocks.ts celebrates nothing in it).
   * null / absent: unknown (someone else's profile, an older API, or it couldn't be read).
   */
  notices?: string[] | null;
  featured: RunCard[];
  /** No picks saved: featured = best records by points. */
  featuredAuto: boolean;
  recentPBs: RunCard[];
  suggestions: { map: string; tier: number; reason: string }[];
}

export interface RankEntry extends RankView {
  player: ApiPlayer & { provider: string };
  level: number;
  title: string | null;
}

export interface RankBoard {
  scope: string;
  total: number;
  entries: RankEntry[];
  me: RankEntry | null;
  /** First row returned (differs from the request only with `around`). Absent from older APIs. */
  offset?: number;
  /** The row just above the page (for "points to the next place"); null on the first page. */
  above?: RankEntry | null;
  /** With `q`: the search echoed back and how many players match. */
  query?: string;
  matches?: number;
}

export interface MapSummary {
  name: string;
  title: string;
  author: string;
  thumbnailUrl: string | null;
  /** Ranked boards exist for this map (zones pinned). */
  ranked: boolean;
  tier: number | null;
  /** `id`: the holder's player id (absent from older APIs). */
  wr: { player: string; time: number; id?: string | null } | null;
  /** Players on the main-track board in this style (absent from older APIs). */
  runners?: number;
  /** When the map came to bunnyhop.lol, ms (absent from older APIs). */
  added?: number;
}

/** A recently set personal best on a ranked board (newest first). rank 1 = world record. */
export interface RecentRecord {
  map: string;
  style: string;
  rank: number;
  runId: string;
  player: ApiPlayer;
  ticks: number;
  time: number;
  /** ISO date the run was submitted. */
  date: string;
}

/** GET /maps/:name — summary plus the current build and its pinned (ranked) zone set. */
export interface MapDetail extends MapSummary {
  gamebananaId: number | null;
  license: string | null;
  sha256: string | null;
  size: number | null;
  /** Canonical zones JSON ({ map, zones }, see zones.ts) pinned for ranked runs, or null (unranked). */
  zones: unknown | null;
  /** Tracks of the pinned zone set: 0 = main, N = bonus N. Each has its own board (leaderboard opts.track). */
  tracks: number[];
}

/** GET /servers row (apps/api/src/rooms/routes.ts). */
export interface ServerListing {
  id: string;
  name: string;
  region: string;
  tiers: [number, number];
  maxPlayers: number;
  timeLimitMinutes: number;
  /** The room answered (false: shown greyed out). */
  online: boolean;
  players: number;
  map: string | null;
  tier: number | null;
  /** Time left on the current map when listed (ms); null while changing / offline. */
  timeLeftMs: number | null;
  /** Map the room is switching to right now, if any. */
  changing: string | null;
}

/** A private lobby as an invite shows it (GET /lobbies/:id, POST /lobbies; apps/api/src/rooms/room.ts LobbyInfo). */
export interface LobbyInfo {
  id: string;
  name: string;
  region: string;
  hostId: string;
  hostName: string;
  map: string | null;
  tier: number | null;
  /** The map it is switching to right now (join on that one). */
  changing: string | null;
  players: number;
  maxPlayers: number;
  createdAt: number;
}

// --- friends (apps/api src/social.ts) ---

export interface ProfileSocial {
  followers: number;
  following: number;
  friends: number;
  you?: { following: boolean; followsYou: boolean; blocked: boolean };
}
export type FollowList = "followers" | "following" | "friends";

/** Where a friend is (a private lobby comes without its id: friends ask to join). */
export type FriendWhere =
  | { k: "menu" }
  | { k: "solo"; map: string; style?: string }
  | { k: "server"; id: string; name?: string; map?: string }
  | { k: "lobby"; map?: string }
  | { k: "replay"; map?: string };

export interface Friend extends ApiPlayer {
  since: number;
  where: FriendWhere | null;
  lastSeen: number | null;
  unread: number;
}

export interface FriendsView {
  appearOffline: boolean;
  /** Signed in (guests can't send messages). */
  canMessage: boolean;
  friends: Friend[];
  /** You follow them; they don't follow you back. */
  following: (ApiPlayer & { since: number })[];
  /** They follow you; you don't follow back. */
  followers: (ApiPlayer & { since: number })[];
  blocked: { id: string; name: string }[];
  unreadNotes: number;
}

export type DmKind = "text" | "map" | "replay" | "profile" | "lobby";
export interface Dm {
  id: number;
  from: string;
  to: string;
  kind: DmKind;
  body: string;
  ref: string | null;
  at: number;
  read: boolean;
}
export interface Conversation {
  with: { id: string; name: string };
  friends: boolean;
  messages: Dm[];
  more: boolean;
}

export type NoteFilter = "all" | "invites" | "friends" | "records";
export interface Note {
  id: number;
  kind: "follow" | "invite" | "ask" | "beat";
  at: number;
  read: boolean;
  actor: ApiPlayer;
  data: Record<string, unknown> | null;
  expired?: boolean;
  /** You follow the actor (follow notes: "Follow back"). */
  following?: boolean;
}
export interface NotesView {
  notes: Note[];
  unread: number;
  more: boolean;
}

export const API_URL: string | null = ((import.meta.env?.VITE_API_URL as string | undefined) || null)?.replace(/\/+$/, "") ?? null;

export class ApiUnavailable extends Error {
  constructor() {
    super("API unavailable");
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** The whole error body (extra fields such as a name `suggestion` or `attemptsLeft`). */
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function base(): string {
  if (API_URL === null) throw new ApiUnavailable();
  return API_URL;
}

/** Only handlers calling requestOrigin() need device headers. Diagnostics carry components in their body;
 * gifting's "fingerprint" is its transaction target JSON, not a browser fingerprint. */
type ApiRequestInit = RequestInit & { device?: boolean };
async function withDevice(init: ApiRequestInit): Promise<RequestInit> {
  const { device, ...plain } = init;
  if (!device) return plain;
  const h = new Headers(plain.headers);
  for (const [k, v] of Object.entries(await deviceHeaders())) h.set(k, v);
  return { ...plain, headers: h };
}

/**
 * Writes sent from this page (anything but GET / HEAD, counted as they go out): a read shared between screens
 * (account-state.ts profileFor, shared-reads.ts) is reused only while no write went out after it was asked.
 */
let writes = 0;
const countWrite = (init: RequestInit) => {
  const m = (init.method ?? "GET").toUpperCase();
  if (m !== "GET" && m !== "HEAD") writes++;
};

/** Optional ownership fence around the actual fetch, after asynchronous headers. */
export type RequestDispatch = ((send: () => Promise<Response>) => Promise<Response>) & {current?:()=>boolean};
/** Recheck ownership after a streamed body, before any API cache effects. */
export async function readOwnedJson(res:Response,dispatch?:RequestDispatch):Promise<unknown> {
  const body=await res.json().catch(()=>null);
  if(dispatch?.current&&!dispatch.current())throw new Error("Account changed. Reopen this profile.");
  return body;
}

async function request(path: string, init: ApiRequestInit = {}, dispatch?: RequestDispatch): Promise<Response> {
  countWrite(init);
  let res: Response;
  try {
    const url = base() + path;
    const prepared = { credentials: "include" as const, ...(await withDevice(init)) };
    const send = () => fetch(url, prepared);
    res = await (dispatch ? dispatch(send) : send());
  } catch (e) {
    if (e instanceof ApiUnavailable) throw e;
    throw new ApiUnavailable();
  }
  if (res.status >= 500) throw new ApiUnavailable();
  return res;
}

async function json<T>(path: string, init: ApiRequestInit = {}, dispatch?: RequestDispatch): Promise<T> {
  const res = await request(path, init, dispatch);
  const body = (await readOwnedJson(res,dispatch)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? "error", body?.message ?? `HTTP ${res.status}`, (body ?? {}) as Record<string, unknown>);
  return body as T;
}

/** Like json(), but 5xx answers with an error body (email_failed, email_unavailable) become ApiErrors too. */
async function jsonOr5xx<T>(path: string, init: ApiRequestInit, dispatch?:RequestDispatch): Promise<T> {
  countWrite(init);
  let res: Response;
  try {
    const prepared=await withDevice(init);
    const send=()=>fetch(base()+path,{credentials:"include",...prepared});
    res=await (dispatch?dispatch(send):send());
  } catch (e) {
    if (e instanceof ApiUnavailable) throw e;
    throw new ApiUnavailable();
  }
  const body = (await readOwnedJson(res,dispatch)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok) {
    if (!body?.error) throw new ApiUnavailable();
    throw new ApiError(res.status, body.error, body.message ?? `HTTP ${res.status}`, body as Record<string, unknown>);
  }
  return body as T;
}

const post = (body?: unknown, device = false): ApiRequestInit => ({
  device,
  method: "POST",
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// ---------------------------------------------------------------------------------------------
// Who's playing. Only the server's explicit "no session" (GET /me answering null, twice for a browser that was signed in
// to an account) means signed out; a failed request (offline, 5xx, a cut-off body) never does. Until an answer comes the
// player is the last one this browser saw (lastKnownMe), so the account chip doesn't flip to "guest" over a blip.
// The decision itself: me-rules.ts.

const LAST_ME_KEY = "bunnyhop:last-me";
/** The player this browser last had a confirmed answer for (public fields only); null if none or signed out. */
export function lastKnownMe(): User | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_ME_KEY) ?? "null") as Partial<User> | null;
    if (!v || typeof v.id !== "string" || typeof v.name !== "string" || typeof v.provider !== "string") return null;
    return { id: v.id, name: v.name, avatarUrl: typeof v.avatarUrl === "string" ? v.avatarUrl : null, provider: v.provider };
  } catch {
    return null;
  }
}

function rememberMe(u: User | null): void {
  try {
    if (u) localStorage.setItem(LAST_ME_KEY, JSON.stringify({ id: u.id, name: u.name, avatarUrl: u.avatarUrl, provider: u.provider }));
    else localStorage.removeItem(LAST_ME_KEY);
  } catch {
    /* storage blocked */
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One GET /me with a definite answer: the player, or null for "no session". Anything else throws (ApiUnavailable: no
 * answer; ApiError: a 4xx), including a 200 whose body isn't JSON (cut off): that's not the server saying null.
 */
async function askMe(): Promise<User | null> {
  const res = await request("/me", { cache: "no-store" });
  if (!res.ok) throw new ApiError(res.status, "error", `HTTP ${res.status}`);
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw new ApiUnavailable();
  }
  if (body === null) return null;
  if (body && typeof body === "object" && typeof (body as User).id === "string") return body as User;
  throw new ApiUnavailable();
}

let meCache: Promise<User | null> | null = null;
/** The last me() answer was the remembered player because the API couldn't be reached (account-state.ts re-checks). */
let meStale = false;

/** Sets the cached player (after a rename, sign-in, unlink, ...). */
function setMe(u: User | null): void {
  meCache = Promise.resolve(u);
  meStale = false;
  rememberMe(u);
}

/**
 * The Wavedash build's sign-in: the player's Wavedash JWT for a session. null: carry on like the site (no Wavedash
 * player, or the API turned the token down for good). A failure that may pass (offline, 5xx, rate limited, the SDK
 * slow to answer) throws, so me() keeps no guest and tries again later (account-state.ts recheckLater) rather than
 * starting this player as a guest. Once it has answered, later me() calls in the page (after a sign-in or sign-out
 * there) ask GET /me like the site.
 */
let wavedashDone = false;
async function wavedashSession(): Promise<User | null> {
  if (wavedashDone) return null;
  // A few quick tries in place (a slow SDK, a blip): the player shouldn't sit signed out for the recheck's 5 s+.
  for (let attempt = 0; ; attempt++) {
    try {
      const c = await wavedashCredentials();
      if (!c) return ((wavedashDone = true), null);
      const r = await json<{ user: User; outcome: string }>("/auth/wavedash", post(c, true));
      wavedashDone = true;
      return r.user;
    } catch (e) {
      if (e instanceof ApiError && e.status !== 429 && e.status < 500) return ((wavedashDone = true), null);
      if (attempt >= 3) throw new ApiUnavailable();
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/**
 * Wavedash build: the player has a Wavedash account, so the game never starts them as a guest (a guest would lose the
 * name and progress to the account, and counts against the network's guest limit): until the account signs in, the
 * player is "not answered yet" and me() tries again.
 */
const wavedashPlayer = () => WAVEDASH && !!wavedashUserId();

export const api = {
  async personalBests(after: string | null = null): Promise<{ user: string; pbs: import("./pb").ServerPB[]; next: string | null }> {
    return json(`/me/pbs${after ? `?after=${encodeURIComponent(after)}` : ""}`);
  },
  available(): boolean {
    return API_URL !== null;
  },
  /** How many writes this page has sent (see countWrite): a cached read asked before the last one may be stale. */
  writes(): number {
    return writes;
  },
  /**
   * The current player; issues a guest identity on first visit. Never throws: without an answer from the API (offline,
   * 5xx) it's the last player this browser had (lastKnownMe, possibly null) and meStale() is true until one comes.
   */
  async me(): Promise<User | null> {
    if (!api.available()) return null;
    if (!meCache) {
      // The Wavedash build signs in with the player's Wavedash account first (no guest is made for them); without one
      // (no SDK, a signed-out Wavedash visitor, the API refusing) it carries on like the site.
      const platform = WAVEDASH ? wavedashSession() : Promise.resolve(null);
      const pending: Promise<User | null> = platform.then((signedIn) => signedIn ?? resolveMe<User>({
        ask: askMe, transient: (e) => e instanceof ApiUnavailable,
        guest: () => {
          // A superseded lookup must never replace a newly signed-in session with a guest cookie.
          if (meCache !== pending || wavedashPlayer()) throw new ApiUnavailable();
          return json<User>("/auth/guest", post({}, true));
        }, known: lastKnownMe,
        forget: () => { if (meCache === pending) rememberMe(null); }, wait: sleep,
      })).then(
        (u) => {
          if (meCache === pending) { meStale = false; rememberMe(u); }
          return u;
        },
        () => {
          if (meCache === pending) { meCache = null; meStale = true; }
          return lastKnownMe();
        },
      );
      meCache = pending;
    }
    return meCache;
  },
  /** The last me() came from memory, not from the server (it couldn't be reached). */
  meStale(): boolean {
    return meStale;
  },
  /** Sets the cached player after an account change made in the page (account-state.ts accountChanged). */
  setMe(u: User | null): void {
    setMe(u);
  },
  /**
   * Full-page navigation target for "Save progress with Discord". Returns to `returnTo` with ?login=discord or
   * ?login_error=… (The community server rewards need nothing here: the API's bot looks the account up on sign-in.)
   */
  discordLoginUrl(returnTo: string): string {
    return `${base()}/auth/discord/login?returnTo=${encodeURIComponent(returnTo)}`;
  },
  /**
   * Sets the display name (rules: moderation/names.ts). Throws ApiError 400 <problem> (too_short, charset, blocked,
   * reserved, ...), 409 "taken" (body.suggestion; registered players), 429 "rename_limit". Guests asking for a taken
   * name get a numbered variant: the result has nameAdjusted.
   */
  async setMouseSettings(mouse: import("./mouse-settings").MouseSettings, dispatch?: RequestDispatch): Promise<import("./mouse-settings").MouseSettings> {
    return json("/me/mouse", post(mouse), dispatch);
  },
  async countrySettings(): Promise<{ country: string | null; detected: string | null }> {
    return json("/me/country");
  },
  async setCountry(country: string | null, dispatch?: RequestDispatch): Promise<{ country: string | null }> {
    return json("/me/country", post({ country }), dispatch);
  },
  async setDisplayName(name: string, dispatch?: RequestDispatch): Promise<User> {
    // Without a session the server would make a guest for the name: a Wavedash player names their account instead.
    if (wavedashPlayer() && !(await api.me())) throw new ApiUnavailable();
    const user = await json<User>("/me/name", post({ name }), dispatch);
    setMe(user);
    return user;
  },
  /** What saving `name` would do (live validation while typing). */
  async checkName(name: string): Promise<NameCheck> {
    return json<NameCheck>(`/names/check?name=${encodeURIComponent(name)}`, { cache: "no-store" });
  },
  /** Sign-in methods the server offers. */
  async providers(): Promise<{ discord: boolean; email: boolean }> {
    return json("/auth/providers");
  },
  /**
   * Public site config: the community Discord invite (null = none, hide the links), and whether the community server's
   * membership rewards can be earned (false / absent: hide them).
   */
  async config(): Promise<{ discordInvite: string | null; discordMembership?: boolean }> {
    return json("/config");
  },
  /** Profile links (Customise → Links): handles per platform + "show on my profile". */
  async links(): Promise<LinkSettings> {
    return json("/me/links", { cache: "no-cache" });
  },
  /** Strict: 400 bad_links names the platform (`body.platform`) and what's wrong. */
  async saveLinks(s: Partial<LinkSettings>, dispatch?: RequestDispatch): Promise<LinkSettings> {
    return json("/me/links", post(s), dispatch);
  },
  /** The "Show booster badge" switch; `boosting`: the badge would show now (the bot's latest read). */
  async saveBooster(show: boolean, dispatch?: RequestDispatch): Promise<{ show: boolean; boosting: boolean }> {
    return json("/me/booster", post({ show }), dispatch);
  },
  /** Your support (Settings → Account, the Support page). 401 without a session. */
  async mySupport(): Promise<MySupport> {
    return json("/me/supporter", { cache: "no-store" });
  },
  async giftWallet(): Promise<GiftWallet> {
    return json("/me/gifts", { cache: "no-store" });
  },
  async giftPreview(target: GiftTarget, dispatch?: RequestDispatch): Promise<GiftPreview> {
    return json("/me/gifts/preview", post(target), dispatch);
  },
  async sendGifts(target: GiftTarget, requestId: string, maxCost: number, dispatch?: RequestDispatch): Promise<GiftDelivery> {
    return json("/me/gifts", post({ ...target, requestId, maxCost }), dispatch);
  },
  async myNameBadges(): Promise<NameBadgeSettings> {
    return json("/me/name-badges", { cache: "no-store" });
  },
  async saveNameBadges(settings: { nameBadges: string[]; gifterColors?: string[]; gifterAnimated?: boolean }, dispatch?: RequestDispatch): Promise<NameBadgeSettings> {
    return json("/me/name-badges", post(settings), dispatch);
  },
  /** A supporter's name look, badge switch, About listing (403 not_supporter for everyone else). */
  async saveSupporter(s: Partial<Pick<SupporterSettings, "nameColor" | "nameEffect" | "nameColor2" | "showBadge" | "showOnBoard" | "playerGlow">>, dispatch?: RequestDispatch): Promise<SupporterSettings> {
    return json("/me/supporter", post(s), dispatch);
  },
  /**
   * A Stripe Checkout page for a one-time payment of `amountCents` (the Support page sends the player there). ApiError:
   * signin_required (guests), bad_amount, payments_closed, rate_limited, checkout_failed.
   */
  async supportCheckout(amountCents: number, dispatch?: RequestDispatch): Promise<{ url: string }> {
    // checkout_failed (502) and payments_closed (503) carry their message: show it rather than "offline".
    return jsonOr5xx("/support/checkout", post({ amountCents }), dispatch);
  },
  /** The About page's thank-you list (names of supporters who opted in). */
  async supporters(): Promise<{ names: string[]; top: TopSupporter[] }> {
    return json("/supporters");
  },
  /** Your sign-in methods, unlink rules, renames left, onboarding. 401 without a session. */
  async account(): Promise<AccountView> {
    return json<AccountView>("/me/account", { cache: "no-store" });
  },
  /** Removes a sign-in method (refused for the last one: ApiError 400 "last_method"). */
  async unlink(provider: SignInMethod["provider"], dispatch?: RequestDispatch): Promise<AccountView> {
    const v = await json<AccountView>("/me/unlink", post({ provider }), dispatch);
    setMe(v.user);
    return v;
  },
  /** Emails a 6-digit code + link. ApiError: bad_email, rate_limited, email_busy, email_failed, undeliverable, email_unavailable. */
  async emailStart(email: string, returnTo = appHref()): Promise<EmailStart> {
    return jsonOr5xx<EmailStart>("/auth/email/start", post({ email, returnTo }));
  },
  /**
   * Verifies the code (this browser) or a link token. ApiError: bad_code (body.attemptsLeft), code_expired, link_expired,
   * confirm_switch (409: a link this browser didn't ask for would leave its player; body.email masked, body.current;
   * re-post with confirm: true after asking).
   */
  async emailVerify(v: { code: string } | { token: string; confirm?: boolean }): Promise<{ user: User; outcome: "linked" | "signed_in" | "merged" | "created"; keptGuest?: boolean }> {
    const r = await json<{ user: User; outcome: "linked" | "signed_in" | "merged" | "created"; keptGuest?: boolean }>("/auth/email/verify", post(v, true));
    setMe(r.user);
    return r;
  },
  /** Settings saved with the account (platform/settings-sync.ts): the Settings document, or null. */
  async savedSettings(): Promise<{ doc: unknown; updatedAt?: number }> {
    return json("/me/settings", { cache: "no-store" });
  },
  async saveSettings(doc: unknown): Promise<{ updatedAt: number }> {
    return json("/me/settings", post({ doc }));
  },
  async onboarding(): Promise<OnboardingState> {
    return json<OnboardingState>("/me/onboarding", { cache: "no-store" });
  },
  /** Records finished steps; done: true = finished/skipped, false = show it again. */
  async saveOnboarding(o: { steps?: Record<string, boolean>; done?: boolean }): Promise<OnboardingState> {
    return json<OnboardingState>("/me/onboarding", post(o));
  },
  /** Discord-linked players: show (or hide) their Discord avatar publicly. Off by default; there are no uploads. */
  async setUseDiscordAvatar(on: boolean, dispatch?: RequestDispatch): Promise<User> {
    const user = await json<User>("/me/avatar", post({ useDiscord: on }), dispatch);
    setMe(user);
    return user;
  },
  /** Ends the session (everywhere: on every device); the next me() issues a fresh guest. */
  async logout(everywhere = false, dispatch?: RequestDispatch): Promise<void> {
    // A guarded native dialog must finish its captured session request before
    // clearing account memory; an old response cannot log out a new identity.
    if (api.available()) await request("/auth/logout", post(everywhere ? { everywhere: true } : {}), dispatch);
    meCache = null;
    rememberMe(null);

  },
  /** Forget the cached player (after signing in elsewhere in the page). */
  forgetMe(): void {
    meCache = null;
  },
  /** All maps; `wr` is the main-track world record in `style`. */
  async reportPlaytime(seconds:number,dispatch?:RequestDispatch):Promise<unknown> {
    return json("/me/playtime",post({seconds}),dispatch);
  },
  async playerStats(id: string): Promise<{ totals: { verifiedRuns: number; jumps: number; playtimeSeconds: number; runTimeMs: number; mapsCompleted: number }; styles: { style: string; runs: number; maps: number }[]; maps: { map: string; runs: number }[]; activity: { at: number; runs: number }[] }> {
    return json(`/players/${encodeURIComponent(id)}/stats`);
  },
  async statBoard(board: StatBoardId, opts: BoardReadOptions = {}, init: RequestInit = {}): Promise<StatBoardPage> {
    const p = new URLSearchParams();
    for (const [key, value] of Object.entries(opts)) if (value !== undefined) p.set(key, String(value));
    return json(`/stats/boards/${board}?${p}`, init);
  },
  async stats(): Promise<GameStats> {
    return json("/stats", { cache: "no-store" });
  },
  async maps(style = "autohop"): Promise<MapSummary[]> {
    return json<MapSummary[]>(`/maps?style=${encodeURIComponent(style)}`);
  },
  /** Newest personal bests across all ranked boards (rank 1 = new world record). */
  async recentRecords(style = "autohop", limit = 6): Promise<RecentRecord[]> {
    return json<RecentRecord[]>(`/records/recent?style=${encodeURIComponent(style)}&limit=${limit}`);
  },
  async mapDetail(name: string): Promise<MapDetail> {
    return json<MapDetail>(`/maps/${encodeURIComponent(name)}`);
  },
  /** Board of one track (0 = main, default; N = bonus N). */
  async leaderboard(map: string, style: string, opts?: BoardReadOptions & { track?: number }, init: RequestInit = {}): Promise<Leaderboard> {
    const q = new URLSearchParams();
    if (opts?.offset !== undefined) q.set("offset", String(opts.offset));
    if (opts?.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts?.track) q.set("track", String(opts.track));
    if (opts?.around) q.set("around", opts.around);
    if (opts?.q) q.set("q", opts.q);
    if (opts?.scope) q.set("scope", opts.scope);
    // Always revalidate: boards change after every verified run and `me` depends on the session cookie.
    return json<Leaderboard>(`/leaderboards/${encodeURIComponent(map)}/${encodeURIComponent(style)}${q.size ? `?${q}` : ""}`, { cache: "no-cache", ...init });
  },
  /**
   * Uploads a finished run's replay (gzip .bhr bytes). Verification is asynchronous: poll submission(id).
   * Uploads the server refuses outright (unranked map, zone/build mismatch, rate limit, ...) resolve to
   * { id: "", status: "rejected", reason, code } rather than throwing.
   */
  async submitRun(replay: Uint8Array, opts: { room?: string | null; race?: string | null; gauntlet?: string | null; beats?: string[]; mouse?: import("./mouse-settings").MouseSettings | null; dispatch?: RequestDispatch } = {}): Promise<Submission> {
    // ?room=<id>: played in a multiplayer room, so the room announces the verified result (PB / top 10 / SR / WR).
    // &race=<id>: a run for the room's race you're in (net/race.ts): the room ties it to the race.
    // ?gauntlet=<attemptId>: a run in a gauntlet attempt (gauntlet/): the reply says whether it became the next split.
    const q = new URLSearchParams();
    if (opts.room) q.set("room", opts.room);
    if (opts.room && opts.race) q.set("race", opts.race);
    if (opts.gauntlet) q.set("gauntlet", opts.gauntlet);
    const path = q.size ? `/runs?${q}` : "/runs";
    // With run-session tokens (run-clock.ts): multipart, the replay plus a `beats` field (JSON array). Without: the raw
    // bytes, as before.
    let init: RequestInit = { method: "POST", headers: { "content-type": "application/octet-stream" }, body: replay as Uint8Array<ArrayBuffer> };
    if (opts.beats?.length || opts.mouse) {
      const form = new FormData();
      form.append("replay", new Blob([replay as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }), "run.bhr");
      if (opts.beats?.length) form.append("beats", JSON.stringify(opts.beats));
      if (opts.mouse) form.append("mouse", JSON.stringify(opts.mouse));
      init = { method: "POST", body: form };
    }
    const res = await request(path, { ...init, device: true }, opts.dispatch);
    const body = (await res.json().catch(() => null)) as (Submission & { error?: string; message?: string }) | null;
    if (!res.ok || !body) return { id: "", status: "rejected", reason: body?.message ?? `HTTP ${res.status}`, code: body?.error ?? "error" };
    meCache = null; // the server may have just issued a guest identity
    return body;
  },
  /** A run-session heartbeat (run-clock.ts): the server signs what was recorded so far. */
  async runBeat(body: { sid: string | null; map: string; track: number; style: string; tick: number; hash: string; paused: boolean; att?: [number, number, number, number] }, dispatch?: RequestDispatch): Promise<{ sid: string; token: string }> {
    return json("/runs/beat", { ...post(body, true), keepalive: true }, dispatch);
  },
  // --- gauntlets
  async gauntlets(): Promise<GauntletHub> {
    const r = await json<Partial<GauntletHub>>("/gauntlets", { cache: "no-cache" });
    return { weekly: r.weekly ?? null, gauntlets: r.gauntlets ?? [], past: r.past ?? [] };
  },
  async gauntletWatch(attemptId: string): Promise<GauntletWatchPlan> {
    return json<GauntletWatchPlan>(`/gauntlets/attempts/${encodeURIComponent(attemptId)}/watch`);
  },
  async playerGauntlets(id: string): Promise<PlayerGauntlets> {
    return json<PlayerGauntlets>(`/players/${encodeURIComponent(id)}/gauntlets`);
  },
  async gauntlet(slug: string, init: RequestInit = {}): Promise<GauntletDetail> {
    return json<GauntletDetail>(`/gauntlets/${encodeURIComponent(slug)}`, { cache: "no-cache", ...init });
  },
  async gauntletBoard(slug: string, offset = 0, init: RequestInit = {}): Promise<GauntletBoard> {
    return json<GauntletBoard>(`/gauntlets/${encodeURIComponent(slug)}/board${offset ? `?offset=${offset}` : ""}`, { cache: "no-cache", ...init });
  },
  /** Opens an attempt (your open one, on any gauntlet, is abandoned). ApiError 409 gauntlet_closed outside its dates. */
  async startGauntlet(slug: string): Promise<GauntletAttempt> {
    return json<GauntletAttempt>(`/gauntlets/${encodeURIComponent(slug)}/attempts`, post());
  },
  /** Your attempt (ApiError 404 unknown_attempt for anyone else's, 401 without a session). */
  async gauntletAttempt(id: string): Promise<GauntletAttempt> {
    return json<GauntletAttempt>(`/gauntlets/attempts/${encodeURIComponent(id)}`, { cache: "no-store" });
  },
  async pingGauntlet(id: string): Promise<{ id: string; state: GauntletAttemptState; step: number; expiresAt: number | null }> {
    return json(`/gauntlets/attempts/${encodeURIComponent(id)}/ping`, { ...post(), keepalive: true });
  },
  async abandonGauntlet(id: string): Promise<GauntletAttempt> {
    return json<GauntletAttempt>(`/gauntlets/attempts/${encodeURIComponent(id)}/abandon`, post());
  },
  async submission(id: string): Promise<Submission> {
    return json<Submission>(`/submissions/${encodeURIComponent(id)}`);
  },
  /**
   * Attaches the client's diagnostics to a run it just uploaded (selfcheck.ts: its own re-simulation + session
   * numbers). Triage only; the server never verifies with it. Best effort: never throws.
   */
  async runDiagnostics(id: string, diagnostics: object): Promise<void> {
    try {
      await request(`/runs/${encodeURIComponent(id)}/diagnostics`, { ...post(diagnostics), keepalive: true });
    } catch {
      /* offline: diagnostics are optional */
    }
  },
  /** What's deployed (update.ts): VERSION, the web build (entry script path, null without a site build) and the sim build. */
  async version(): Promise<{ version: string; build: string | null; wasm: string }> {
    return json(`/version`, { cache: "no-store" });
  },
  // --- profiles + ranks
  async profile(id: string): Promise<Profile> {
    return json<Profile>(`/players/${encodeURIComponent(id)}`, { cache: "no-cache" });
  },
  /** Verified runs, newest first (pbOnly: current PBs only). */
  async playerRuns(id: string, opts: { offset?: number; limit?: number; pbOnly?: boolean } = {}): Promise<{ total: number; runs: RunCard[] }> {
    const q = new URLSearchParams({ offset: String(opts.offset ?? 0), limit: String(opts.limit ?? 20) });
    if (opts.pbOnly) q.set("pb", "1");
    return json(`/players/${encodeURIComponent(id)}/runs?${q}`);
  },
  /** Overall ("all") or per-style rank leaderboard. */
  async ranks(scope = "all", opts: BoardReadOptions = {}, init: RequestInit = {}): Promise<RankBoard> {
    const q = new URLSearchParams({ offset: String(opts.offset ?? 0), limit: String(opts.limit ?? 50) });
    if (opts.around) q.set("around", opts.around);
    if (opts.q) q.set("q", opts.q);
    return json<RankBoard>(`/ranks/${encodeURIComponent(scope)}?${q}`, { cache: "no-cache", ...init });
  },
  /**
   * Records unlock notices shown to `user` (notices.ts; unknown ids are ignored). ApiError 401 without a session, 409
   * wrong_account when the session is another player's.
   */
  async addNotices(user: string, ids: string[]): Promise<void> {
    await json("/me/notices", { ...post({ user, ids }), keepalive: ids.length <= 200 });
  },
  /** Your favorite maps (favorites.ts). ApiError 401 without a session. */
  async favorites(): Promise<string[]> {
    return (await json<{ maps: string[] }>("/me/favorites", { cache: "no-store" })).maps;
  },
  /**
   * Stars / unstars maps for `user`; the list after the change. ApiError 401 without a session, 409 wrong_account (the
   * session is another player's) or favorites_full, 429 rate_limited.
   */
  async saveFavorites(user: string, add: string[], remove: string[]): Promise<string[]> {
    return (await json<{ maps: string[] }>("/me/favorites", { ...post({ user, add, remove }), keepalive: true })).maps;
  },
  /** Your map groups (map-groups.ts), oldest first. ApiError 401 without a session. */
  async mapGroups(): Promise<ApiMapGroup[]> {
    return (await json<{ groups: ApiMapGroup[] }>("/me/map-groups", { cache: "no-store" })).groups;
  },
  /**
   * Creates, renames and deletes `user`'s map groups and changes their maps; the groups after the change. ApiError 401
   * without a session, 409 wrong_account (the session is another player's), groups_full or group_full, 429 rate_limited.
   */
  async saveMapGroups(user: string, changes: ApiMapGroupChange[]): Promise<ApiMapGroup[]> {
    return (await json<{ groups: ApiMapGroup[] }>("/me/map-groups", { ...post({ user, changes }), keepalive: true })).groups;
  },
  /** Your bunny avatar (avatar/spec.ts): the saved one, or your default; `url` is its picture. ApiError 401 without a session. */
  async bunnyAvatar(): Promise<{ spec: AvatarSpec; custom: boolean; url: string }> {
    return json("/me/avatar/bunny", { cache: "no-store" });
  },
  /**
   * Saves a bunny avatar: its spec and the editor's 256 px WebP render (base64). ApiError 400 bad_cosmetic names a slot
   * when an item isn't yours, 429 rate_limited.
   */
  async saveBunnyAvatar(spec: AvatarSpec, image: string): Promise<{ spec: AvatarSpec; custom: boolean; url: string }> {
    return json("/me/avatar/bunny", post({ spec, image }));
  },
  /** Back to the default avatar (your colourway, the pose your id picks). */
  async resetBunnyAvatar(): Promise<{ spec: AvatarSpec; custom: boolean; url: string }> {
    return json("/me/avatar/bunny", { method: "DELETE" });
  },
  async myCosmetics(): Promise<{ level: number; choice: CosmeticChoice; unlocked: string[]; role?: ApiStaffRole | null; playerGlow?: PlayerGlow | null }> {
    return json("/me/cosmetics", { cache: "no-cache" });
  },
  /** Partial update; throws ApiError(400, "bad_cosmetic") naming the slot when an item is locked or unknown. */
  async saveCosmetics(patch: Partial<CosmeticChoice>, dispatch?: RequestDispatch): Promise<CosmeticChoice> {
    return json<CosmeticChoice>("/me/cosmetics", post(patch), dispatch);
  },
  /** Up to 5 of your verified run ids ([] = automatic). */
  async saveFeatured(runs: string[], dispatch?: RequestDispatch): Promise<string[]> {
    return (await json<{ runs: string[] }>("/me/featured", post({ runs }), dispatch)).runs;
  },
  /** Up to 3 earned achievement ids to showcase ([] = automatic). */
  async saveBadges(badges: string[], dispatch?: RequestDispatch): Promise<string[]> {
    return (await json<{ badges: string[] }>("/me/badges", post({ badges }), dispatch)).badges;
  },
  /** Public URL of a verified run's replay (watch links: ?replay=<url>). */
  replayUrl(runId: string): string {
    return `${base()}/runs/${encodeURIComponent(runId)}/replay`;
  },
  // --- multiplayer rooms (apps/api/src/rooms; client: net/*)
  /** Persistent servers with live player counts and their current map. */
  async servers(): Promise<ServerListing[]> {
    return json<ServerListing[]>("/servers", { cache: "no-cache" });
  },
  /**
   * Your private lobby (signed in only: ApiError 403 signin_required for guests, 429 lobby_limit). While yours is open it
   * answers with that one ({existing: true}). `map`: where a new lobby starts (any map; else a random one).
   */
  async createLobby(map?: string | null): Promise<LobbyInfo & { existing: boolean }> {
    return json("/lobbies", post(map ? { map } : {}));
  },
  /** The lobby an invite points at; ApiError 404 lobby_closed once it has closed. */
  async lobby(id: string): Promise<LobbyInfo> {
    return json<LobbyInfo>(`/lobbies/${encodeURIComponent(id)}`, { cache: "no-store" });
  },
  /** Round trip (ms) through the API to the room's Durable Object: the server browser's ping column. */
  async serverPing(id: string): Promise<number> {
    const t0 = performance.now();
    await json(`/servers/${encodeURIComponent(id)}/ping`, { cache: "no-store" });
    return performance.now() - t0;
  },
  /** WebSocket URL of a room (the session cookie authenticates it). */
  roomSocketUrl(id: string, version: number, style: string): string {
    const u = new URL(`${base()}/servers/${encodeURIComponent(id)}/ws`, location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.searchParams.set("v", String(version));
    u.searchParams.set("style", style);
    return u.toString();
  },
  /** Gzip .bhr bytes of a verified run, for ghosts and watch mode. */
  /** A run's player as the server knows them (a replay's own player name is whatever its client wrote). */
  async runPlayer(id: string): Promise<{ id: string; name: string; playerGlow: PlayerGlow | null }> {
    const p = (await json<{ player: { id: string; name: string; playerGlow?: PlayerGlow | null } }>(`/runs/${encodeURIComponent(id)}`)).player;
    return { id: p.id, name: p.name, playerGlow: p.playerGlow ?? null };
  },
  async playerPoints(id: string, scope = "all"): Promise<{ scope: string; records: PointsRecord[] }> {
    return json(`/players/${encodeURIComponent(id)}/points?scope=${encodeURIComponent(scope)}`);
  },
  async replayViews(runId: string): Promise<number> {
    return (await json<{views:number}>(`/runs/${encodeURIComponent(runId)}/views`)).views;
  },
  async startReplayView(runId: string): Promise<string | null> {
    return (await json<{token:string|null}>(`/runs/${encodeURIComponent(runId)}/views/start`,post({}))).token;
  },
  async recordReplayView(runId: string, token: string): Promise<{views:number;counted:boolean}> {
    return json(`/runs/${encodeURIComponent(runId)}/views`,post({token}));
  },
  async replay(runId: string): Promise<Uint8Array> {
    const res = await request(`/runs/${encodeURIComponent(runId)}/replay`);
    if (!res.ok) throw new ApiError(res.status, "not_found", "replay not available");
    return new Uint8Array(await res.arrayBuffer());
  },
  /** Owner-only privacy intake: no screenshot, game context or device headers. */
  async sendPrivacyRequest(body: PrivacyRequestBody): Promise<{ ok: boolean; id: string; duplicate?: boolean }> {
    return json("/feedback", post({ category: "privacy", kind: body.kind, note: body.note, contact: body.contact }));
  },

  /**
   * In-game feedback (POST /feedback; apps/api src/feedback.ts). Works with or without a session. With a screenshot
   * the body is multipart (data = the JSON, screenshot = image/jpeg). Throws ApiError 400 <problem> / 429
   * rate_limited, ApiUnavailable when the API can't be reached.
   */
  async sendFeedback(body: FeedbackBody, screenshot?: Blob | null): Promise<{ ok: boolean; id: string }> {
    if (!screenshot) return json("/feedback", post(body));
    const form = new FormData();
    form.set("data", JSON.stringify(body));
    form.set("screenshot", screenshot, "screenshot.jpg");
    return json("/feedback", { method: "POST", body: form });
  },
  /**
   * The player's inbox (GET /me/inbox; apps/api src/inbox.ts): their feedback tickets with staff replies, announcements
   * and system letters. Never creates a guest (no session: signedIn false, nothing in it). ApiError 429 when polled
   * too often.
   */
  async inbox(): Promise<InboxView> {
    return json<InboxView>("/me/inbox", { cache: "no-store" });
  },
  /** Just the unread count (the menu badge poll). */
  async inboxUnread(): Promise<number> {
    return (await json<{ unread: number }>("/me/inbox?view=count", { cache: "no-store" })).unread;
  },
  /** Marks those message ids (or, without ids, everything) read. Returns the new unread count. */
  async markInboxRead(ids?: number[]): Promise<number> {
    return (await json<{ unread: number }>("/me/inbox/read", post(ids ? { ids } : {}))).unread;
  },
  /**
   * The player answers staff on their own ticket (POST /feedback/:id/reply; apps/api src/inbox.ts). Returns the stored
   * reply (from "you") and the ticket's status. ApiError 400 missing_field | body_too_long | blocked_words, 404 (not
   * their ticket), 409 nothing_to_answer, 429 rate_limited.
   */
  async replyToTicket(id: string, body: string): Promise<{ reply: InboxReply; status: Extract<InboxThread, { type: "ticket" }>["status"] }> {
    return json(`/feedback/${encodeURIComponent(id)}/reply`, post({ body }));
  },
  // --- friends (apps/api src/social.ts; client: social/) ---
  /** Players with a chosen name starting with `q` (at most 8). */
  async searchPlayers(q: string, init: RequestInit = {}): Promise<ApiPlayer[]> {
    return (await json<{ players: ApiPlayer[] }>(`/players/search?q=${encodeURIComponent(q)}`, init)).players;
  },
  async friends(): Promise<FriendsView> {
    return json<FriendsView>("/me/friends", { cache: "no-store" });
  },
  async follow(id: string, on = true): Promise<{ following: boolean; mutual?: boolean }> {
    return json(`/me/follows/${encodeURIComponent(id)}`, post(on ? {} : { follow: false }));
  },
  /** Hide (or show again) a follower you don't follow back from your Friends panel. */
  async dismissFollower(id: string, on = true): Promise<{ dismissed: boolean }> {
    return json(`/me/followers/${encodeURIComponent(id)}/${on ? "dismiss" : "undismiss"}`, post({}));
  },
  async block(id: string, on = true): Promise<{ blocked: boolean }> {
    return json(`/me/blocks/${encodeURIComponent(id)}`, post(on ? {} : { block: false }));
  },
  async setAppearOffline(on: boolean): Promise<{ appearOffline: boolean }> {
    return json("/me/social", post({ appearOffline: on }));
  },
  async conversation(id: string, before?: number): Promise<Conversation> {
    return json<Conversation>(`/me/dms/${encodeURIComponent(id)}${before ? `?before=${before}` : ""}`, { cache: "no-store" });
  },
  async sendDm(id: string, m: { body: string } | { kind: Exclude<DmKind, "text">; ref: string }): Promise<{ message: Dm }> {
    return json(`/me/dms/${encodeURIComponent(id)}`, post(m));
  },
  async readDms(id: string): Promise<void> {
    await json(`/me/dms/${encodeURIComponent(id)}/read`, post({}));
  },
  async notes(filter: NoteFilter = "all", before?: number): Promise<NotesView> {
    const q = new URLSearchParams();
    if (filter !== "all") q.set("filter", filter);
    if (before) q.set("before", String(before));
    return json<NotesView>(`/me/notes${q.size ? `?${q}` : ""}`, { cache: "no-store" });
  },
  async readNotes(ids?: number[]): Promise<void> {
    await json("/me/notes/read", post(ids ? { ids } : {}));
  },
  async invite(to: string): Promise<void> {
    await json("/social/invite", post({ to }));
  },
  async askToJoin(to: string): Promise<void> {
    await json("/social/ask", post({ to }));
  },
  /** A player's followers / following / friends, newest first (at most 100). */
  async followList(id: string, list: FollowList): Promise<ApiPlayer[]> {
    return (await json<{ players: ApiPlayer[] }>(`/players/${encodeURIComponent(id)}/follows?list=${list}`, { cache: "no-store" })).players;
  },
  /** The live socket's URL (wss), or null offline. */
  socialSocketUrl(): string | null {
    if (API_URL === null) return null;
    const u = new URL(API_URL + "/social/ws", location.href);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  },
};

/** A message under a ticket. `from` is "staff" | "system" | "you" (the player's own reply), never a person's name. Times are unix ms. */
export interface InboxReply {
  id: number;
  body: string;
  from: string;
  created_at: number;
  read_at: number | null;
}

export type InboxThread =
  | { type: "ticket"; id: string; category: string; message: string; status: "new" | "triaged" | "resolved" | "wontfix"; created_at: number; updated_at: number; replies: InboxReply[] }
  | { type: "announcement" | "system"; id: number; subject: string | null; body: string; category: string | null; from: string; created_at: number; read_at: number | null };

export interface InboxView {
  signedIn: boolean;
  unread: number;
  /** Newest activity first. */
  threads: InboxThread[];
}

export type PrivacyRequestKind = "export" | "delete" | "correct" | "other";
export interface PrivacyRequestBody {
  kind: PrivacyRequestKind;
  note?: string;
  contact?: string;
}

export interface FeedbackBody {
  category: "bug" | "physics" | "map" | "tier" | "multiplayer" | "idea" | "other" | "application" | "report";
  /** Ignored for applications: the server writes it from `application`. Optional (may be "") for "tier". */
  message: string;
  /** category "tier": the map and the tier the player thinks it should be (the server writes the "Tier:" line). */
  tier?: { map: string; current: number | null; suggested: number };
  /** category "report" (apps/api src/player-reports.ts): who (id, else full name, else the run's player) and why. The
   * message is optional; the server writes the "Reported:" line. */
  report?: { player?: string; name?: string; runId?: string; reason: "cheating" | "chat" };
  /** category "application": the moderator application's answers, each optional (the API needs a few words in all). */
  application?: { discord?: string; hours?: string; why?: string; experience?: string };
  contact?: string;
  /** Game info (feedback/modal.ts gameContext); omitted when the player unticks "attach game info". */
  context?: Record<string, unknown>;
}
