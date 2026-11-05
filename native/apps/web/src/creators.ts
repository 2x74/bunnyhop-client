// Verified / Creator marks and profile links. Shared: the API validates and stores them (apps/api/src/links.ts,
// admin-panel.ts), the web UI draws them (ui/marks.ts), the OG cards reuse the icon geometry (apps/api/src/og/cards.ts).
//
// - Verified: a blue check next to the name ("this is really them"). Admin-granted only (users.verified).
// - Creator: YouTube, Twitch, TikTok or X ("makes content"), admin-granted, independent of Verified (users.creator).
// - Server Booster: a pink gem while the player boosts the bunnyhop.lol Discord server (automatic: the API's Discord bot
//   reads the linked account's member premium_since, apps/api/src/community.ts). The player can hide it.
// - Profile links: any player may set a channel / handle per platform. Only the handle is stored; the URL is always
//   built here from an allowlisted domain, so a link can never point anywhere else. Hidden unless the player turns
//   "show on my profile" on (off by default).
// - Staff: a small shield before the other marks. Owner (gold, a crown; the owner only: OWNER_ID), Admin (sky),
//   Moderator (mint). The owner shows Owner alone, not Owner + Admin. Follows the role (apps/api/src/roles.ts), which
//   staff can't hide (players should always know who can act on them), with one exception: a moderator who also holds
//   Contributor may wear it in the shield's place (owner's call, 2026-10-25). Public data is the badge only, never
//   permissions.
// - Supporter: a small badge (SUPPORTER_BADGE) for players who supported bunnyhop.lol (an admin's grant; payments come later:
//   users.supporter_since, apps/api/src/supporters.ts). Permanent; the player can hide it like the booster gem.
// - Name colour and effect: supporters may pick one of NAME_COLORS for their name on boards, ranks, records, chat, the
//   room scoreboard, name tags and their card, and how the name wears it (NAME_EFFECTS: plain, a glow, a gradient
//   to a second colour, that gradient drifting, or a bright shine sweeping across the name). Off (plain white)
//   unless picked. Like the badge, both only show while the player is a supporter (gated on write and on every read).
// - Name font and avatar decoration (v0.0.37): supporter-looks.ts NAME_FONTS / AVATAR_DECOS, gated the same way.
// - Special badges (users.special_badges, 0.0.21): staff-granted for events (SPECIAL_BADGES). The first: Clipper, for
//   taking part in the clip campaign, and a gold Creator mark per platform for its top creator. Contributor (2026-10-25):
//   worked on the game or the client; no permissions (the Discord role of the same name sits between Admin and Moderator).
//   Mapper (2026-10-28): made maps on the site; staff link the player to their author names (apps/api/src/mappers.ts).
// Marks are server-authoritative: they come from the API / the room, never from the client.
// Order after a name (unless the player picks their own, Edit card → Badges): staff, Verified, Creator, Server
// Booster, Supporter, special badges.

import type { StaffRole } from "./progression";
import { avatarDecoOf, nameFontOf, type AvatarDecoId, type NameFontId } from "./supporter-looks";

export type CreatorKind = "youtube" | "twitch" | "tiktok" | "x";
export const CREATOR_KINDS: readonly CreatorKind[] = ["youtube", "twitch", "tiktok", "x"];
export const isCreatorKind = (v: unknown): v is CreatorKind => typeof v === "string" && (CREATOR_KINDS as readonly string[]).includes(v);
export const CREATOR_LABEL: Record<CreatorKind, string> = { youtube: "YouTube creator", twitch: "Twitch creator", tiktok: "TikTok creator", x: "X creator" };

/** The marks a name can carry (API player objects, room roster and chat lines). */
export interface PlayerMarks {
  nameBadges?: string[];
  giftsSent?: number;
  gifterColors?: string[];
  gifterAnimated?: boolean;
  verified?: boolean;
  creator?: CreatorKind | null;
  /** Boosting the community Discord server (and not hidden by the player). Absent from older APIs / servers. */
  booster?: boolean;
  /** Staff badge (staffBadgeOf). Absent from older APIs / servers. */
  staff?: StaffBadge | null;
  /** Supporter badge (and not hidden by the player). Absent from older APIs / servers. */
  supporter?: boolean;
  /** A supporter's picked name colour (NAME_COLORS id); null / absent = the default white. */
  nameColor?: NameColorId | null;
  /** A supporter's name effect (NAME_EFFECTS); null / absent = plain colour. */
  nameEffect?: NameEffect | null;
  /** The gradient's second colour (NAME_COLORS id) for "paint"; null / absent = a paler shade of the first. */
  nameColor2?: NameColorId | null;
  /** A supporter's name font (supporter-looks.ts NAME_FONTS); null / absent = the default font. v0.0.37. */
  nameFont?: NameFontId | null;
  /** A supporter's avatar decoration (supporter-looks.ts AVATAR_DECOS); null / absent = none. v0.0.37. */
  avatarDeco?: AvatarDecoId | null;
  /** Special badges the player holds (SPECIAL_BADGES ids, staff-granted). Absent from older APIs / servers. */
  special?: string[];
}

/** How a supporter's name looks: colour, effect, second colour (PlayerMarks' name fields). */
export type NameLook = Pick<PlayerMarks, "nameColor" | "nameEffect" | "nameColor2" | "nameFont">;

// ---------------------------------------------------------------------------------------------
// Supporter name colours. Six, picked to read on every surface a name shows on (board rows, chat over the game, the
// room scoreboard, name tags, every card background: WCAG contrast 4.5 or more) and to stay clear of the colours that
// mean something already: WR gold, the staff shields (mint, sky, gold), the Verified blue, the Booster pink and red
// (apps/api/test/supporters.test.ts checks both). In hue order.

export type NameColorId = "rose" | "peach" | "sand" | "lime" | "aqua" | "periwinkle";
export const NAME_COLORS: readonly { id: NameColorId; name: string; hex: string }[] = [
  { id: "rose", name: "Rose", hex: "#ffa8cb" },
  { id: "peach", name: "Peach", hex: "#ffab8f" },
  { id: "sand", name: "Sand", hex: "#d2c2a5" },
  { id: "lime", name: "Lime", hex: "#c4ee6a" },
  { id: "aqua", name: "Aqua", hex: "#6ff0f0" },
  { id: "periwinkle", name: "Periwinkle", hex: "#a8b8ff" },
];
export const isNameColor = (v: unknown): v is NameColorId => typeof v === "string" && NAME_COLORS.some((c) => c.id === v);

/**
 * Supporter name effects (ui/marks.css draws them; player/tag.ts does colour, glow and a still gradient on the 3D name
 * tags). glow: a soft halo in the colour. paint ("Gradient"): a gradient across the letters to the second colour.
 * sparkle ("Shine"): the plain colour with a bright shine sweeping across it every few seconds (CSS only, still under
 * prefers-reduced-motion). The ids are what's stored (users.name_effect). "shimmer" (a drifting gradient, dropped
 * 2026-10-09: too close to Gradient) still in a row reads as "paint" (nameEffectOf); no migration rewrites it.
 */
export type NameEffect = "glow" | "paint" | "sparkle";
export const NAME_EFFECTS: readonly { id: NameEffect; name: string }[] = [
  { id: "glow", name: "Glow" },
  { id: "paint", name: "Gradient" },
  { id: "sparkle", name: "Shine" },
];
export const isNameEffect = (v: unknown): v is NameEffect => typeof v === "string" && NAME_EFFECTS.some((e) => e.id === v);
/** Effects that use the second colour. */
export const usesColor2 = (e: NameEffect | null | undefined) => e === "paint";
/** A stored effect as shown now: a known one, the dropped "shimmer" as "paint", anything else none. */
export const nameEffectOf = (v: unknown): NameEffect | null => (v === "shimmer" ? "paint" : isNameEffect(v) ? v : null);
/** The CSS colour of a name colour id (null for none or anything unknown, so a stray value never reaches a style). */
export const nameColorHex = (v: unknown): string | null => (isNameColor(v) ? NAME_COLORS.find((c) => c.id === v)!.hex : null);

/**
 * The staff badge a name carries: the owner's is Owner; admins and moderators show their role. The owner's id stays
 * "developer" (it was labelled Developer until 2026-10-25; API payloads and older clients carry the id).
 */
export type StaffBadge = "developer" | "admin" | "moderator";
export const STAFF_BADGES: readonly StaffBadge[] = ["developer", "admin", "moderator"];
export const STAFF_LABEL: Record<StaffBadge, string> = { developer: "Owner", admin: "Admin", moderator: "Moderator" };
export const isStaffBadge = (v: unknown): v is StaffBadge => typeof v === "string" && (STAFF_BADGES as readonly string[]).includes(v);
export function staffBadgeOf(role: StaffRole | null | undefined): StaffBadge | null {
  return role === "owner" ? "developer" : role === "admin" ? "admin" : role === "moderator" ? "moderator" : null;
}

export const BOOSTER_LABEL = "Server Booster";
/** A booster read older than this (the bot off or failing for days) stops showing the gem. */
export const BOOSTER_STALE_MS = 2 * 86_400_000;

/**
 * Marks from a users row (verified 0/1, creator text) plus booster_at: the latest bot read (ms) that saw the player
 * boosting, NULL when hidden or not boosting (apps/api/src/community.ts BOOSTER_AT). Anything unexpected reads as none.
 */
export function marksOf(
  row: {
    name_badges?: string | null;
    gifts_sent?: number | null;
    gifter_colors?: string | null;
    gifter_animated?: number | null;
    verified?: number | boolean | null;
    creator?: string | null;
    booster_at?: number | null;
    staff?: StaffBadge | null;
    supporter_badge?: number | null;
    name_color?: string | null;
    name_effect?: string | null;
    name_color2?: string | null;
    name_font?: string | null;
    avatar_deco?: string | null;
    special_badges?: string | null;
  },
  now = Date.now(),
): PlayerMarks &
  Required<Pick<PlayerMarks, "verified" | "creator" | "booster" | "staff" | "supporter" | "nameColor" | "nameEffect" | "nameColor2">> {
  const at = row.booster_at;
  return {
    ...(row.gifts_sent !== undefined ? { giftsSent: Math.max(0, row.gifts_sent ?? 0) } : {}),
    ...nameBadgesOf(row.name_badges),
    gifterColors: (row.gifts_sent ?? 0) >= 100 ? parseBadgeList(row.gifter_colors).filter(isGifterColor).slice(0, 3) : undefined,
    ...(row.gifter_animated !== undefined ? { gifterAnimated: row.gifter_animated !== 0 } : {}),
    verified: !!row.verified,
    creator: isCreatorKind(row.creator) ? row.creator : null,
    booster: typeof at === "number" && now - at <= BOOSTER_STALE_MS,
    staff: isStaffBadge(row.staff) ? row.staff : null,
    // supporter_badge / name_color / name_effect / name_color2: apps/api/src/supporter-cols.ts SUPPORTER_COLS (null
    // unless the player is a supporter).
    supporter: !!row.supporter_badge,
    nameColor: isNameColor(row.name_color) ? row.name_color : null,
    nameEffect: nameEffectOf(row.name_effect),
    nameColor2: isNameColor(row.name_color2) ? row.name_color2 : null,
    // name_font / avatar_deco: SUPPORTER_COLS too (v0.0.37, supporter-looks.ts); absent from older rows / queries.
    ...(row.name_font !== undefined ? { nameFont: nameFontOf(row.name_font) } : {}),
    ...(row.avatar_deco !== undefined ? { avatarDeco: avatarDecoOf(row.avatar_deco) } : {}),
    ...(row.special_badges !== undefined ? { special: onePeak(oneWeeklyPerMedal(parseBadgeList(row.special_badges).filter(isSpecialBadge))) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Icons (24 x 24 viewBox), drawn as SVG in the UI and in the OG cards.

export const VERIFIED_BLUE = "#3b9eff";
/** The check stroke inside the verified disc. */
export const VERIFIED_CHECK = "M7 12.4l3.3 3.3L17.2 8.8";
/**
 * YouTube: rounded play button. Twitch: speech bubble with two bars. Brand colours. TikTok and X: a dark rounded tile
 * with a line drawing on it (a note with cyan / pink offsets, a two-stroke X): our own, not the platforms' logos.
 */
export const CREATOR_COLOR: Record<CreatorKind, string> = { youtube: "#ff3d3d", twitch: "#a970ff", tiktok: "#25f4ee", x: "#e7e9ea" };

/** The tile marks (TikTok, X) as primitives, so SVG (UI, OG cards) and canvas (player name tags) draw the same thing. */
export interface TileMark {
  /** Rounded square x = y = 2.5, 19 x 19, radius 5. */
  tile: string;
  edge: string;
  /** Stroked paths in order (offset copies first), round caps / joins. */
  strokes: { d: string; color: string; width: number; dx?: number; dy?: number }[];
}
export const TILE_RECT = { x: 2.5, y: 2.5, size: 19, r: 5 } as const;
const NOTE = "M7.8 15.4a2.7 2.7 0 1 0 5.4 0a2.7 2.7 0 1 0-5.4 0M13.2 15.4V6.2c.5 2 1.9 3.1 3.9 3.3";
export const TILE_MARKS: Record<"tiktok" | "x", TileMark> = {
  tiktok: {
    tile: "#121318",
    edge: "#3a3d48",
    strokes: [
      { d: NOTE, color: "#25f4ee", width: 2.1, dx: -0.7, dy: -0.5 },
      { d: NOTE, color: "#fe2c55", width: 2.1, dx: 0.7, dy: 0.5 },
      { d: NOTE, color: "#fff", width: 2.1 },
    ],
  },
  x: {
    tile: "#0b0c0f",
    edge: "#3a3d48",
    strokes: [
      { d: "M7.6 6.8 16.4 17.2", color: "#fff", width: 2.8 },
      { d: "M16.4 6.8 7.6 17.2", color: "#fff", width: 1.4 },
    ],
  },
};
const tileSvg = (m: TileMark) =>
  `<rect x="${TILE_RECT.x}" y="${TILE_RECT.y}" width="${TILE_RECT.size}" height="${TILE_RECT.size}" rx="${TILE_RECT.r}" fill="${m.tile}" stroke="${m.edge}" stroke-width="1"/>` +
  m.strokes
    .map((s) => `<path d="${s.d}"${s.dx || s.dy ? ` transform="translate(${s.dx ?? 0} ${s.dy ?? 0})"` : ""} fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join("");

/** Inner markup of each mark for a `viewBox="0 0 24 24"` SVG (UI, SEO blocks and OG cards draw the same shapes). */
export const VERIFIED_SVG = `<circle cx="12" cy="12" r="11" fill="${VERIFIED_BLUE}"/><path d="${VERIFIED_CHECK}" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
/**
 * Server Booster: a white cut gem (flat table, crown, girdle, pavilion) on a pink disc, the Verified check's size and
 * weight. Our own drawing, not Discord's boost icon. BOOSTER_GEM is the gem alone (canvas name tags draw it too).
 */
export const BOOSTER_PINK = "#e05cf3";
export const BOOSTER_GEM = "M8.7 6.8h6.6l3.3 4L12 18.4 5.4 10.8z";
export const BOOSTER_GIRDLE = "M5.4 10.8h13.2";
export const BOOSTER_SVG = `<circle cx="12" cy="12" r="11" fill="${BOOSTER_PINK}"/><path d="${BOOSTER_GEM}" fill="#fff" stroke="#fff" stroke-width="0.6" stroke-linejoin="round"/><path d="${BOOSTER_GIRDLE}" stroke="${BOOSTER_PINK}" stroke-width="1.5"/>`;
/**
 * Supporter: the badge after a supporter's name, the Verified check's height. A few drawings to choose from (owner's
 * pick, 2026-10-09: the heart; SUPPORTER_BADGE is the one shown, changing it is a one-line change): a gold coin with a dollar
 * sign, a small heart, a gold coin with a star, and the Geode crystals. Each stands free or as a coin with its own mark,
 * apart from the round Verified check (blue, a tick), the Booster's pink disc with a gem and the shields. Our own
 * drawings. As layers (filled or stroked paths, back to front), so canvas name tags (Path2D) draw the same thing.
 */
export const SUPPORTER_LABEL = "Supporter";
export type SupporterBadgeId = "coin" | "heart" | "star" | "crystal";
/** The badge shown everywhere. */
export const SUPPORTER_BADGE: SupporterBadgeId = "heart";
export interface BadgeLayer {
  d: string;
  fill?: string;
  stroke?: string;
  width?: number;
}
const INK = "#10202a";
const COIN: BadgeLayer[] = [
  { d: "M1.8 12a10.2 10.2 0 1 0 20.4 0a10.2 10.2 0 1 0 -20.4 0z", fill: "#f4bf3a", stroke: "#7a4f0c", width: 1 },
  { d: "M4.3 12a7.7 7.7 0 1 0 15.4 0a7.7 7.7 0 1 0 -15.4 0z", stroke: "#c98a1a", width: 0.9 },
];
export const SUPPORTER_BADGES: Record<SupporterBadgeId, readonly BadgeLayer[]> = {
  coin: [...COIN, { d: "M15 8.9c-.45-1.05-1.6-1.75-3-1.75-1.75 0-3 .95-3 2.3 0 3.2 6.1 1.7 6.1 5.1 0 1.45-1.35 2.5-3.15 2.5-1.5 0-2.75-.75-3.25-1.9M12 5.4v13.2", stroke: "#6b4208", width: 1.9 }],
  heart: [
    { d: "M12 20.8C6.2 16.7 2.7 13.4 2.7 9.3 2.7 6.6 4.8 4.6 7.3 4.6c2 0 3.6 1 4.7 2.7 1.1-1.7 2.7-2.7 4.7-2.7 2.5 0 4.6 2 4.6 4.7 0 4.1-3.5 7.4-9.3 11.5z", fill: "#ff5a6e", stroke: "#7a1424", width: 0.9 },
    { d: "M6.4 7.6c-.9.4-1.4 1.2-1.4 2.2", stroke: "#ffd0d6", width: 1.3 },
  ],
  star: [...COIN, { d: "M12 6.9 13.35 10.44 17.14 10.63 14.19 13.01 15.17 16.67 12 14.6 8.83 16.67 9.81 13.01 6.86 10.63 10.65 10.44z", fill: "#8a5a0c" }],
  crystal: [
    { d: "M18.2 5.8 15 9.6 14.4 21.6H18.4L18.6 10.4z", fill: "#5ff2df" },
    { d: "M18.2 5.8 18.6 10.4 18.4 21.6H20.8L22 10.2z", fill: "#1a8f9c" },
    { d: "M18.2 5.8 22 10.2 20.8 21.6H14.4L15 9.6z", stroke: INK, width: 0.8 },
    { d: "M9.4 1.6 3.8 6.8 9.6 7.8z", fill: "#ddd2ff" },
    { d: "M9.4 1.6 9.6 7.8 15.4 6.2z", fill: "#a58bff" },
    { d: "M3.8 6.8 9.6 7.8 9.8 21.6H4.8z", fill: "#9a7cff" },
    { d: "M9.6 7.8 15.4 6.2 14.8 21.6H9.8z", fill: "#5a40cc" },
    { d: "M9.4 1.6 15.4 6.2 14.8 21.6H4.8L3.8 6.8z", stroke: INK, width: 0.8 },
  ],
};
/** The shown badge's layers (SUPPORTER_BADGE). */
export const SUPPORTER_LAYERS: readonly BadgeLayer[] = SUPPORTER_BADGES[SUPPORTER_BADGE];
/** A badge's layers as SVG for a `viewBox="0 0 24 24"`. */
export const badgeSvg = (layers: readonly BadgeLayer[]) =>
  layers
    .map((l) => `<path d="${l.d}" fill="${l.fill ?? "none"}"${l.stroke ? ` stroke="${l.stroke}" stroke-width="${l.width ?? 1}" stroke-linecap="round" stroke-linejoin="round"` : ""}/>`)
    .join("");
export const SUPPORTER_SVG = badgeSvg(SUPPORTER_LAYERS);
/**
 * Staff: a shield in the role's colour (the chat tags' gold / sky / mint) with dark ink, the Verified check's height.
 * Moderator: one chevron. Admin: two. Owner: a crown (filled; until 2026-10-25 a code bracket pair). Our own drawing.
 * The canvas name tags draw the same primitives (player/tag.ts).
 */
export const STAFF_SHIELD = "M12 1.4 20.8 4.6v6.6c0 5.4-3.7 9.6-8.8 11.3-5.1-1.7-8.8-5.9-8.8-11.3V4.6z";
export const STAFF_INK = "#0b0d12";
export const STAFF_COLOR: Record<StaffBadge, string> = { developer: "#ffc23d", admin: "#79d2ff", moderator: "#7fe0b0" };
/** Paths drawn on the shield in ink: stroked (round caps and joins), and also filled when `fill` is set. */
export const STAFF_STROKES: Record<StaffBadge, { d: string; width: number; fill?: boolean }[]> = {
  moderator: [{ d: "M7.6 14 12 9.8l4.4 4.2", width: 2.6 }],
  admin: [{ d: "M7.6 11.2 12 7.2l4.4 4", width: 2.4 }, { d: "M7.6 16.2 12 12.2l4.4 4", width: 2.4 }],
  developer: [{ d: "M6.9 15.4 6.4 8.4l3 2.6L12 6.6l2.6 4.4 3-2.6-.5 7z", width: 1, fill: true }],
};
export const STAFF_SVG: Record<StaffBadge, string> = Object.fromEntries(
  STAFF_BADGES.map((b) => [
    b,
    `<path d="${STAFF_SHIELD}" fill="${STAFF_COLOR[b]}"/>` +
      STAFF_STROKES[b].map((s) => `<path d="${s.d}" fill="${s.fill ? STAFF_INK : "none"}" stroke="${STAFF_INK}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round"/>`).join(""),
  ]),
) as Record<StaffBadge, string>;
export const CREATOR_SVG: Record<CreatorKind, string> = {
  youtube: `<rect x="1.5" y="4.8" width="21" height="14.4" rx="4.4" fill="${CREATOR_COLOR.youtube}"/><path d="M10 8.7v6.6l5.6-3.3z" fill="#fff"/>`,
  twitch: `<path d="M5 2.5 3 6.6v13h4.6V22h2.6l2.4-2.4h3.8L21 15V2.5z" fill="${CREATOR_COLOR.twitch}"/><path d="M10.6 7h2v5.6h-2zM15.2 7h2v5.6h-2z" fill="#fff"/>`,
  tiktok: tileSvg(TILE_MARKS.tiktok),
  x: tileSvg(TILE_MARKS.x),
};

// ---------------------------------------------------------------------------------------------
// Special badges (users.special_badges): staff-granted for events, worn like any other name badge. Ids are permanent
// (stored on accounts); a new event adds ids, never reuses one.

/** Clipper: a film frame with a play button, in lime (clear of the Verified blue, the platforms and the staff shields). */
export const CLIPPER_COLOR = "#9be15d";
const CLIPPER_INK = "#14200a";
export const CLIPPER_SVG = `<rect x="2.5" y="4.5" width="19" height="15" rx="3.2" fill="${CLIPPER_COLOR}"/><g fill="${CLIPPER_INK}">${[5, 9, 13, 17].map((x) => `<rect x="${x}" y="6.2" width="2" height="1.6" rx=".4"/><rect x="${x}" y="16.2" width="2" height="1.6" rx=".4"/>`).join("")}</g><path d="M10.4 9.6v4.8l4.1-2.4z" fill="${CLIPPER_INK}"/>`;

/** The gold Creator marks: the platform's icon in gold (the shine is CSS / the name tag's, as Gold Gifter's). */
export const GOLD_LIGHT = "#ffe9a3";
export const GOLD_MID = "#f2b628";
export const GOLD_DARK = "#c98a1c";
export const GOLD_INK = "#3a2606";
const goldFill = (id: string) => `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${GOLD_LIGHT}"/><stop offset=".55" stop-color="${GOLD_MID}"/><stop offset="1" stop-color="${GOLD_DARK}"/></linearGradient></defs>`;
export const CREATOR_GOLD_SVG: Record<CreatorKind, string> = {
  youtube: `${goldFill("cg-yt")}<rect x="1.5" y="4.8" width="21" height="14.4" rx="4.4" fill="url(#cg-yt)"/><path d="M10 8.7v6.6l5.6-3.3z" fill="${GOLD_INK}"/>`,
  twitch: `${goldFill("cg-tw")}<path d="M5 2.5 3 6.6v13h4.6V22h2.6l2.4-2.4h3.8L21 15V2.5z" fill="url(#cg-tw)"/><path d="M10.6 7h2v5.6h-2zM15.2 7h2v5.6h-2z" fill="${GOLD_INK}"/>`,
  tiktok: `${goldFill("cg-tt")}<rect x="2" y="2" width="20" height="20" rx="6" fill="url(#cg-tt)"/><path d="M13.6 5.5h2.4c.2 1.6 1.3 2.8 3 3v2.4c-1.2 0-2.2-.3-3-.9v4.9a4.5 4.5 0 1 1-4.5-4.5h.4v2.4h-.4a2.1 2.1 0 1 0 2.1 2.1z" fill="${GOLD_INK}"/>`,
  x: `${goldFill("cg-x")}<rect x="2" y="2" width="20" height="20" rx="6" fill="url(#cg-x)"/><path d="M7 6.5h3.1l2.6 3.6 3.1-3.6h1.7l-4 4.6 4.6 6.4h-3.1l-2.8-3.9-3.4 3.9H7.1l4.3-4.9z" fill="${GOLD_INK}"/>`,
};

// Gauntlet marks (research/GAUNTLETS.md "Marks"): earned in play, never granted (apps/api/src/admin-tools.ts refuses
// them), and stored with the special badges (apps/api/src/gauntlets.ts awards them: a complete attempt, a closed week).
// One plate, one colour, dark ink, like the staff shields and Clipper, so each reads at 14 px:
//   gauntlet          a periwinkle disc with a finish flag: cleared any gauntlet (worn when picked)
//   weekly-winner     a gold calendar page engraved with how many weekly gauntlets the player won (v0.0.36: counted,
//                     "weekly-winner-N" from 2 wins; the tangerine page with a 1 before). weekly-second / weekly-third
//                     (-N): the silver and bronze pages for 2nd and 3rd places, worn when picked (owner, 11-03).
//   gauntlet-classic  a gold octagon with 20 engraved, with the gold glint: cleared the 20-map Bunny Hop Map Gauntlet
// The alternatives drawn for the owner (B / C of each) are in tools/gauntlets/mark-options.ts.
export const GAUNTLET_PERIWINKLE = "#8e9cff";
export const GAUNTLET_INK = "#0e1428";
export const WEEKLY_TANGERINE = "#ff9b54";
/** Bold ink numerals (system font, like the level tokens' digits). */
const engraved = (t: string, y: number, size: number, fill: string) =>
  `<text x="12" y="${y}" text-anchor="middle" font-size="${size}" font-weight="900" fill="${fill}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif">${t}</text>`;
export const GAUNTLET_SVG =
  `<circle cx="12" cy="12" r="11" fill="${GAUNTLET_PERIWINKLE}"/><path d="M8.2 5.4v13.4" stroke="${GAUNTLET_INK}" stroke-width="2.2" stroke-linecap="round"/>` +
  `<path d="M9.2 5.6h8.6l-2.5 3.5 2.5 3.5H9.2z" fill="${GAUNTLET_INK}"/>`;
export const WEEKLY_WINNER_SVG =
  `<rect x="2.5" y="4.2" width="19" height="17.6" rx="3.6" fill="${WEEKLY_TANGERINE}"/><path d="M7.4 2.4v4M16.6 2.4v4" stroke="${GAUNTLET_INK}" stroke-width="2.2" stroke-linecap="round"/>` +
  engraved("1", 19.4, 13, GAUNTLET_INK);
/** Medal fills of the weekly podium marks: light, mid, dark (gold is the Creator gold). */
const MEDALS = {
  winner: { light: GOLD_LIGHT, mid: GOLD_MID, dark: GOLD_DARK, word: "gold" },
  second: { light: "#f4f6fa", mid: "#c5ccd8", dark: "#8d96a6", word: "silver" },
  third: { light: "#f6c896", mid: "#c9824a", dark: "#8f5328", word: "bronze" },
} as const;
export type WeeklyMedal = keyof typeof MEDALS;
/** Counts engraved past this read as it ("99"). */
export const WEEKLY_MARK_MAX = 99;
/** The weekly podium mark for `n` (1..) places of a medal: "weekly-winner", "weekly-winner-3", "weekly-third-2". */
export const weeklyMarkId = (medal: WeeklyMedal, n: number) => `weekly-${medal}${n > 1 ? `-${Math.min(WEEKLY_MARK_MAX, Math.floor(n))}` : ""}`;
/** The medal and count of a weekly podium mark id, or null. */
export function weeklyMarkOf(id: string): { medal: WeeklyMedal; n: number } | null {
  const m = /^weekly-(winner|second|third)(?:-(\d{1,2}))?$/.exec(id);
  if (!m) return null;
  const n = m[2] === undefined ? 1 : Number(m[2]);
  if (m[2] !== undefined && (n < 2 || n > WEEKLY_MARK_MAX)) return null;
  return { medal: m[1] as WeeklyMedal, n };
}
const weeklySvg = (medal: WeeklyMedal, n: number) => {
  const c = MEDALS[medal];
  const id = `wk-${medal}-${n}`;
  const digits = String(n);
  return (
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.light}"/><stop offset=".55" stop-color="${c.mid}"/><stop offset="1" stop-color="${c.dark}"/></linearGradient></defs>` +
    `<rect x="2.5" y="4.2" width="19" height="17.6" rx="3.6" fill="url(#${id})"/><path d="M7.4 2.4v4M16.6 2.4v4" stroke="${GAUNTLET_INK}" stroke-width="2.2" stroke-linecap="round"/>` +
    engraved(digits, digits.length > 1 ? 18.4 : 19.4, digits.length > 1 ? 10.5 : 13, GAUNTLET_INK)
  );
};
/** Every weekly podium mark, 1 to WEEKLY_MARK_MAX of each medal. Gold is shown by default; silver and bronze when picked. */
const WEEKLY_MARKS = Object.fromEntries(
  (Object.keys(MEDALS) as WeeklyMedal[]).flatMap((medal) =>
    Array.from({ length: WEEKLY_MARK_MAX }, (_, i) => {
      const n = i + 1;
      return [weeklyMarkId(medal, n), { name: `Weekly gauntlet ${MEDALS[medal].word}${n > 1 ? ` ×${n}` : ""}`, svg: weeklySvg(medal, n), gold: medal === "winner", earned: true, quiet: medal !== "winner" }];
    }),
  ),
);
/**
 * A list of special badges with one weekly podium mark per medal, the highest count (an account merge can bring two),
 * in the list's order.
 */
export function oneWeeklyPerMedal(ids: string[]): string[] {
  const best = new Map<WeeklyMedal, number>();
  for (const id of ids) {
    const w = weeklyMarkOf(id);
    if (w && w.n > (best.get(w.medal) ?? 0)) best.set(w.medal, w.n);
  }
  return ids.filter((id) => {
    const w = weeklyMarkOf(id);
    if (!w) return true;
    if (best.get(w.medal) !== w.n) return false;
    best.set(w.medal, -1); // once
    return true;
  });
}

export const GAUNTLET_CLASSIC_SVG =
  `${goldFill("gc-oct")}<path d="M8.1 1.4h7.8l5.7 5.7v7.8l-5.7 5.7H8.1l-5.7-5.7V7.1z" fill="url(#gc-oct)"/>` +
  `<path d="M8.7 3h6.6l4.7 4.7v6.6L15.3 19H8.7L4 14.3V7.7z" fill="none" stroke="${GOLD_INK}" stroke-width=".8" opacity=".5"/>${engraved("20", 15.6, 10.5, GOLD_INK)}`;

/**
 * Contributor: worked on the game or the client (staff-granted, no permissions). A wrench across a teal disc, the jaw
 * open to the top right. Teal sits clear of the Moderator mint, the Admin sky and the Verified blue. A moderator who
 * holds it may wear it in the shield's place (equippedNameBadges).
 */
export const CONTRIBUTOR_TEAL = "#3fd4c6";
const CONTRIBUTOR_INK = "#0e1428";
export const CONTRIBUTOR_SVG =
  `<circle cx="12" cy="12" r="11" fill="${CONTRIBUTOR_TEAL}"/><path d="M6.9 17.1 12.6 11.4" stroke="${CONTRIBUTOR_INK}" stroke-width="4" stroke-linecap="round"/>` +
  `<circle cx="14.9" cy="9.1" r="4.9" fill="${CONTRIBUTOR_INK}"/><path d="M14.9 9.1 17.3 3.4 20.6 6.7z" fill="${CONTRIBUTOR_TEAL}"/>`;

/**
 * Mapper: made maps that are on the site (staff link the player to their author names: apps/api/src/mappers.ts, which also
 * gives the badge). A block, the brush mappers build with, in ink on a coral disc: the lit faces are the disc showing
 * through. Coral is clear of the owner's amber, the weekly tangerine, the Creator reds and the Booster pink.
 */
export const MAPPER_CORAL = "#ff8a70";
const MAPPER_INK = "#0e1428";
export const MAPPER_SVG =
  `<circle cx="12" cy="12" r="11" fill="${MAPPER_CORAL}"/><path d="M12 5 18.2 8.5v7L12 19l-6.2-3.5v-7z" fill="${MAPPER_INK}"/>` +
  `<path d="M5.8 8.5 12 12l6.2-3.5M12 12v7" fill="none" stroke="${MAPPER_CORAL}" stroke-width="1.5" stroke-linejoin="round"/>`;

/**
 * Peak marks (v0.0.37): the hardest tier the player has cleared, for T7 to T10 (tiers.ts TIER_COLORS: Insane indigo,
 * Brutal pink, Nightmare azure, Impossible white). A pointed hexagon in the tier's colour, cut light to dark, with the tier
 * engraved. One per player, the highest: a database trigger keeps it in users.special_badges as the First T7 to T10
 * achievements are recorded (migrations/0088_peak_mark_t7.sql), so it follows the achievements: permanent, kept when
 * a map is re-tiered later. A pick of any peak mark (Edit card → Badges) wears the one held (equippedNameBadges).
 */
export const PEAK_TIERS = [7, 8, 9, 10] as const;
export type PeakTier = (typeof PEAK_TIERS)[number];
const PEAK_FILL: Record<PeakTier, { light: string; mid: string; dark: string; ink: string }> = {
  // T7 (v0.0.37, the second pass): the tier's own indigo, calmer than the three above it.
  7: { light: "#c9ccff", mid: "#7c83ff", dark: "#474db8", ink: "#0d0f2a" },
  8: { light: "#ffc2e6", mid: "#ff6ec7", dark: "#b8337f", ink: "#2a0a1c" },
  9: { light: "#c4e6ff", mid: "#4fb8ff", dark: "#1f6fc0", ink: "#06182c" },
  10: { light: "#ffffff", mid: "#f2f4ff", dark: "#aab3c8", ink: "#141a28" },
};
export const peakMarkId = (t: PeakTier) => `peak-${t}`;
/** The tier of a peak mark id, or null. */
export function peakMarkOf(id: string): PeakTier | null {
  const m = /^peak-(\d{1,2})$/.exec(id);
  const t = m ? Number(m[1]) : NaN;
  return (PEAK_TIERS as readonly number[]).includes(t) ? (t as PeakTier) : null;
}
const PEAK_HEX = "M12 1.3 21.2 6.6v10.8L12 22.7 2.8 17.4V6.6z";
const peakSvg = (t: PeakTier) => {
  const c = PEAK_FILL[t];
  const id = `pk-${t}`;
  return (
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.light}"/><stop offset=".5" stop-color="${c.mid}"/><stop offset="1" stop-color="${c.dark}"/></linearGradient></defs>` +
    `<path d="${PEAK_HEX}" fill="url(#${id})" stroke="${c.dark}" stroke-width=".8" stroke-linejoin="round"/>` +
    engraved(String(t), t >= 10 ? 15.6 : 16.6, t >= 10 ? 10 : 12.5, c.ink)
  );
};
const PEAK_MARKS = Object.fromEntries(PEAK_TIERS.map((t) => [peakMarkId(t), { name: `Cleared a T${t} map`, svg: peakSvg(t), earned: true }]));
/** The hardest tier a player has cleared, from their special badges (their peak mark), or null below T7. */
export function peakOf(special: readonly string[] | null | undefined): PeakTier | null {
  let top: PeakTier | null = null;
  for (const id of special ?? []) {
    const t = peakMarkOf(id);
    if (t && (!top || t > top)) top = t;
  }
  return top;
}
/** A list of special badges with one peak mark, the highest (an account merge can bring two), in the list's order. */
export function onePeak(ids: string[]): string[] {
  const top = Math.max(0, ...ids.map((id) => peakMarkOf(id) ?? 0));
  return ids.filter((id, i) => {
    const t = peakMarkOf(id);
    return t === null || (t === top && ids.findIndex((x) => peakMarkOf(x) === top) === i);
  });
}

/** earned: awarded by play (never staff-granted). quiet: worn only when the player picks it (a common mark). */
export const SPECIAL_BADGES: Record<string, { name: string; svg: string; gold?: boolean; earned?: boolean; quiet?: boolean }> = {
  clipper: { name: "Clipper", svg: CLIPPER_SVG },
  contributor: { name: "Contributor", svg: CONTRIBUTOR_SVG },
  mapper: { name: "Mapper", svg: MAPPER_SVG },
  gauntlet: { name: "Gauntlet clear", svg: GAUNTLET_SVG, earned: true, quiet: true },
  ...WEEKLY_MARKS,
  "gauntlet-classic": { name: "Bunny Hop Map Gauntlet", svg: GAUNTLET_CLASSIC_SVG, gold: true, earned: true },
  ...PEAK_MARKS,
  ...Object.fromEntries(
    CREATOR_KINDS.map((k) => [`creator-gold-${k}`, { name: `Top ${({ youtube: "YouTube", twitch: "Twitch", tiktok: "TikTok", x: "X" } as const)[k]} creator`, svg: CREATOR_GOLD_SVG[k], gold: true }]),
  ),
};
export const isSpecialBadge = (id: unknown): id is string => typeof id === "string" && Object.hasOwn(SPECIAL_BADGES, id);
/** Special badges staff may give or take: not the ones earned by play (the gauntlet marks). */
export const isGrantableBadge = (id: unknown): id is string => isSpecialBadge(id) && !SPECIAL_BADGES[id].earned;
export const GRANTABLE_BADGES = Object.fromEntries(Object.entries(SPECIAL_BADGES).filter(([, d]) => !d.earned));

// ---------------------------------------------------------------------------------------------
// Profile links

export type LinkPlatform = "youtube" | "twitch" | "x" | "tiktok";
export const LINK_PLATFORMS: readonly LinkPlatform[] = ["youtube", "twitch", "x", "tiktok"];
export const PLATFORM_NAME: Record<LinkPlatform, string> = { youtube: "YouTube", twitch: "Twitch", x: "X", tiktok: "TikTok" };
export const isLinkPlatform = (v: unknown): v is LinkPlatform => typeof v === "string" && (LINK_PLATFORMS as readonly string[]).includes(v);

/** Stored handles per platform (no "@", no URL). */
export type ProfileLinks = Partial<Record<LinkPlatform, string>>;

/** A link as profiles show it: the canonical URL is built from the platform's own domain. */
export interface ProfileLink {
  platform: LinkPlatform;
  handle: string;
  /** "@name" / "name", as the platform writes it. */
  label: string;
  url: string;
}

const YT_CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const RULES: Record<LinkPlatform, { hosts: string; ok: (h: string) => boolean; hint: string }> = {
  // Handles: 3-30 letters, digits, _ - . (not starting or ending with "."). Or a channel id (UC + 22).
  youtube: { hosts: "(?:www\\.|m\\.)?youtube\\.com", ok: (h) => YT_CHANNEL.test(h) || /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]{1,28})[A-Za-z0-9_-]$/.test(h), hint: "Your @handle: 3-30 letters, numbers, _ - ." },
  // 4-25 letters, digits and _, not starting with _.
  twitch: { hosts: "(?:www\\.|m\\.)?twitch\\.tv", ok: (h) => /^[A-Za-z0-9][A-Za-z0-9_]{3,24}$/.test(h), hint: "Your channel name: 4-25 letters, numbers and _" },
  // 1-15 letters, digits and _.
  x: { hosts: "(?:www\\.|mobile\\.)?(?:x|twitter)\\.com", ok: (h) => /^[A-Za-z0-9_]{1,15}$/.test(h), hint: "Your @handle: up to 15 letters, numbers and _" },
  // 2-24 letters, digits, _ and . (not ending with ".").
  tiktok: { hosts: "(?:www\\.|m\\.)?tiktok\\.com", ok: (h) => /^[A-Za-z0-9_.]{1,23}[A-Za-z0-9_]$/.test(h), hint: "Your @handle: 2-24 letters, numbers, _ and ." },
};

export const linkHint = (p: LinkPlatform) => RULES[p].hint;

/**
 * What a player typed -> the handle to store, or an error. Accepts "name", "@name" or a pasted profile URL on the
 * platform's own domain ("https://www.twitch.tv/name"); anything else (other sites, paths, query strings) is refused.
 * "" = no link.
 */
export function parseHandle(p: LinkPlatform, raw: string): { handle: string } | { error: string } {
  let s = raw.trim();
  if (!s) return { handle: "" };
  if (s.length > 120) return { error: `That doesn't look like a ${PLATFORM_NAME[p]} handle.` };
  const url = new RegExp(`^(?:https?://)?${RULES[p].hosts}/(.*)$`, "i").exec(s);
  if (url) {
    s = url[1].replace(/[?#].*$/, "").replace(/\/+$/, "");
    if (p === "youtube" && /^channel\//i.test(s)) s = s.slice(8);
  } else if (/[/:]/.test(s)) return { error: `Enter your ${PLATFORM_NAME[p]} handle or a link to your ${PLATFORM_NAME[p]} page.` };
  s = s.replace(/^@/, "");
  if (!RULES[p].ok(s)) return { error: `${RULES[p].hint}.` };
  return { handle: s };
}

/** The canonical URL of a stored handle (null if it no longer validates). */
export function linkUrl(p: LinkPlatform, handle: string): string | null {
  if (!RULES[p]?.ok(handle)) return null;
  const h = encodeURIComponent(handle);
  switch (p) {
    case "youtube":
      return YT_CHANNEL.test(handle) ? `https://www.youtube.com/channel/${h}` : `https://www.youtube.com/@${h}`;
    case "twitch":
      return `https://www.twitch.tv/${h}`;
    case "x":
      return `https://x.com/${h}`;
    case "tiktok":
      return `https://www.tiktok.com/@${h}`;
  }
}

export const linkLabel = (p: LinkPlatform, handle: string) => (p === "twitch" || (p === "youtube" && YT_CHANNEL.test(handle)) ? handle : `@${handle}`);

/** Stored JSON -> the valid links, in platform order. */
export function cleanLinks(raw: unknown): ProfileLinks {
  const out: ProfileLinks = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const p of LINK_PLATFORMS) {
    const v = (raw as Record<string, unknown>)[p];
    if (typeof v === "string" && v && RULES[p].ok(v)) out[p] = v;
  }
  return out;
}

export function linkList(links: ProfileLinks): ProfileLink[] {
  return LINK_PLATFORMS.flatMap((p) => {
    const handle = links[p];
    const url = handle ? linkUrl(p, handle) : null;
    return handle && url ? [{ platform: p, handle, label: linkLabel(p, handle), url }] : [];
  });
}

// ---------------------------------------------------------------------------------------------
// Discord invite (DISCORD_INVITE var, GET /config)

/** Only real Discord invite URLs are ever shown (anything else in the var reads as "no invite"). */
export function cleanInvite(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^https:\/\/(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]{2,32}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------------------------------------

export const GIFTER_TIERS = [
  { id: "gifter-bronze", name: "Bronze Gifter", goal: 1, color: "#c98a50" },
  { id: "gifter-silver", name: "Silver Gifter", goal: 5, color: "#b9c3d6" },
  { id: "gifter-gold", name: "Gold Gifter", goal: 25, color: "#f2b628" },
  { id: "gifter-prism", name: "Prism Gifter", goal: 100, color: "#b98cff" },
] as const;
export const GIFTER_BOW =
  "M12 8C8.8 8 4.5 7.4 4.5 4.4c0-4.1 5.4-4.5 7.5.2 2.1-4.7 7.5-4.3 7.5-.2 0 3-4.3 3.6-7.5 3.6ZM10.3 5.9C9.1 3.4 6.5 3.3 6.5 4.4c0 .7 1.4 1.3 3.8 1.5Zm3.4 0c2.4-.2 3.8-.8 3.8-1.5 0-1.1-2.6-1-3.8 1.5Z";
export const GIFTER_PATH = "M3 7h8v5H3zm10 0h8v5h-8zM4 14h7v7H5a1 1 0 0 1-1-1zm9 0h7v6a1 1 0 0 1-1 1h-6z";
export const GIFTER_SVG = `<path d="${GIFTER_BOW}" fill="currentColor" fill-rule="evenodd" stroke="#000" stroke-width=".7" stroke-linejoin="round"/><path d="${GIFTER_PATH}" fill="currentColor" stroke="#000" stroke-width=".7" stroke-linejoin="round"/>`;
export const isGifterColor = (x: unknown): x is string => typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x);
export function parseBadgeList(x: unknown): string[] {
  try {
    const a = typeof x === "string" ? JSON.parse(x) : x;
    return Array.isArray(a) ? a.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
/** Name badge ids a player can wear: their marks, a Gifter tier and special badges, never achievements. */
export const isNameBadge = (id: string) => ["verified", "creator", "booster", "supporter", "gifter"].includes(id) || id.startsWith("gifter-") || isSpecialBadge(id);
/**
 * A saved selection, minus anything that isn't a name badge (0.0.20 let achievements be picked). A selection that held
 * only achievements reads as no selection, so the player gets the default marks back.
 */
function nameBadgesOf(saved: string | null | undefined): { nameBadges?: string[] } {
  if (saved === undefined || saved === null) return {};
  const all = parseBadgeList(saved);
  const ids = all.filter(isNameBadge);
  return ids.length || !all.length ? { nameBadges: ids } : {};
}
export const gifterTier = (n = 0) => [...GIFTER_TIERS].reverse().find((t) => n >= t.goal);
export function equippedNameBadges(m: PlayerMarks): string[] {
  const special = onePeak(m.special ?? []);
  const legacy = [m.verified && "verified", m.creator && "creator", m.booster && "booster", m.supporter && "supporter", ...special.filter((id) => !SPECIAL_BADGES[id]?.quiet)].filter(
    (x): x is string => typeof x === "string",
  );
  const tier = gifterTier(m.giftsSent);
  // Name badges are the marks a player holds (verified, creator, booster, supporter, a Gifter tier), never achievements.
  // An older selection made only of achievements falls back to the default marks.
  const owned = (id: string) =>
    id === "verified"
      ? m.verified
      : id === "creator"
        ? m.creator
        : id === "booster"
          ? m.booster
          : id === "supporter"
            ? m.supporter
            : id === "gifter" || id.startsWith("gifter-")
              ? !!tier
              : weeklyMarkOf(id)
                ? !!heldWeekly(id)
                : peakMarkOf(id)
                  ? !!heldPeak()
                  : isSpecialBadge(id) && special.includes(id);
  // A picked peak mark follows the player's hardest clear (a pick of "peak-8" wears "peak-9" once they clear a T9).
  const heldPeak = () => special.find((x) => peakMarkOf(x) !== null) ?? null;
  // A picked weekly podium mark follows its medal's count (a pick of "weekly-winner" wears "weekly-winner-3").
  const heldWeekly = (id: string) => {
    const medal = weeklyMarkOf(id)?.medal;
    return special.find((x) => weeklyMarkOf(x)?.medal === medal) ?? null;
  };
  const picked = m.nameBadges?.filter(owned);
  const selected = picked && (picked.length || !m.nameBadges!.length) ? picked : legacy;
  const ids = [...new Set(selected.map((id) => (id === "gifter" || id.startsWith("gifter-") ? tier!.id : weeklyMarkOf(id) ? heldWeekly(id)! : peakMarkOf(id) ? heldPeak()! : id)))];
  // A moderator who picked Contributor wears it in the shield's place (wearsContributorForStaff).
  if (wearsContributorForStaff(m)) return ["contributor", ...ids.filter((id) => id !== "staff" && id !== "contributor").slice(0, 2)];
  return [...(m.staff ? ["staff"] : []), ...ids.filter((id) => id !== "staff").slice(0, m.staff ? 2 : 3)];
}
/**
 * Staff who may wear Contributor instead of their shield: moderators (Contributor ranks above them on Discord; admins
 * and the owner always show theirs). They swap by picking Contributor among their name badges.
 */
export const mayWearContributorForStaff = (m: Pick<PlayerMarks, "staff" | "special">) => m.staff === "moderator" && !!m.special?.includes("contributor");
export const wearsContributorForStaff = (m: PlayerMarks) => mayWearContributorForStaff(m) && !!m.nameBadges?.includes("contributor");
