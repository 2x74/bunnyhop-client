// Bunny avatars: the picture a player shows on boards, profiles and the friends dock when they don't show their Discord
// picture. DOM-free and three-free: shared by the editor (avatar/main.ts), the renderer (avatar/stage.ts) and the API
// (apps/api/src/bunny-avatar.ts), like loadout.ts.
//
// An avatar is a spec (what the bunny wears, its pose, the framing and the backdrop) and a 256 px WebP the editor
// renders from it. The API checks every cosmetic in the spec against what the account owns (progression.ts
// cosmeticsProblem, the same check as POST /me/cosmetics) and stores both. Until a player saves one they show a
// default: their colourway in one of a few poses (picked from their id), pre-rendered into the site
// (public-site/avatars/default/<outfit>-<n>.webp, tools/avatar/render-defaults.ts).

import { cosmetic, DEFAULT_COSMETICS, type CosmeticSlot } from "../progression";

export type AvatarPose =
  | "holdup" | "idle" | "showoff" | "hop" | "strafe" | "crouch" | "lookup" | "swing" | "run"
  | "wave" | "point" | "cheer" | "crossed" | "hips" | "salute" | "think" | "shrug";
/** `free`: an empty-hand gesture (the editor puts the knife away when one is picked). */
export const POSES: readonly { id: AvatarPose; name: string; free?: boolean }[] = [
  { id: "holdup", name: "Hold up" },
  { id: "showoff", name: "Show off" },
  { id: "idle", name: "Stand" },
  { id: "lookup", name: "Look up" },
  { id: "hop", name: "Hop" },
  { id: "strafe", name: "Strafe" },
  { id: "swing", name: "Swing" },
  { id: "crouch", name: "Crouch" },
  { id: "run", name: "Run" },
  { id: "wave", name: "Wave", free: true },
  { id: "point", name: "Point", free: true },
  { id: "cheer", name: "Cheer", free: true },
  { id: "crossed", name: "Arms crossed", free: true },
  { id: "hips", name: "Hands on hips", free: true },
  { id: "salute", name: "Salute", free: true },
  { id: "think", name: "Thinking", free: true },
  { id: "shrug", name: "Shrug", free: true },
];

export type AvatarFrame = "face" | "close" | "bust" | "full";
export const FRAMES: readonly { id: AvatarFrame; name: string }[] = [
  { id: "face", name: "Face" },
  { id: "close", name: "Close" },
  { id: "bust", name: "Chest up" },
  { id: "full", name: "Full body" },
];

/** What's in the right hand. Guns are the map-given ones (viewmodel/guns): not cosmetics, free for everyone. */
export type AvatarHand = "knife" | "gun" | "none";
export const GUN_IDS = ["usp", "glock", "fiveseven", "m3", "xm1014", "p90", "ak47", "awp"] as const;
export type AvatarGun = (typeof GUN_IDS)[number];

/**
 * Backdrops. "clear" (transparent), a plain colour, a two-tone studio gradient, or a map's in-engine hero shot
 * ("map:<name>", maps/index.json). All free: only the bunny's cosmetics are checked.
 */
export const BACKDROPS: readonly { id: string; name: string; top: string; bottom: string }[] = [
  { id: "ink", name: "Ink", top: "#26262d", bottom: "#0c0c0f" },
  { id: "amber", name: "Amber", top: "#ffc867", bottom: "#e08a12" },
  { id: "dusk", name: "Dusk", top: "#5a3a6e", bottom: "#1d1630" },
  { id: "sky", name: "Sky", top: "#8fd3ff", bottom: "#3f7fd8" },
  { id: "mint", name: "Mint", top: "#c9f2dc", bottom: "#4fae84" },
  { id: "sakura", name: "Sakura", top: "#ffe1ec", bottom: "#ff8fb4" },
  { id: "ember", name: "Ember", top: "#ff8a4a", bottom: "#7a1a14" },
  { id: "cream", name: "Cream", top: "#fbf6ec", bottom: "#d8cdb8" },
];
const HEX = /^#[0-9a-f]{6}$/;
const MAP = /^map:[a-z0-9_\-.]{1,64}$/;

export interface AvatarSpec {
  v: 1;
  /** progression.ts "outfit-*" id. */
  outfit: string;
  /** "body-a" | "body-b". */
  body: string;
  /** progression.ts "hat-*" id, or null. */
  hat: string | null;
  hand: AvatarHand;
  /** progression.ts "knife-*" / "fin-*" / "glove-*" ids. */
  knife: string;
  finish: string;
  glove: string;
  gun: AvatarGun;
  pose: AvatarPose;
  /** 0..1 through the pose (where a hop / swing / inspect is caught). */
  moment: number;
  /** Head tilt, -1..1 (right ear down +). */
  tilt: number;
  /** Ears, -1 (laid back) .. 1 (pricked). */
  ears: number;
  /** Which way the bunny faces, degrees from three-quarters (0; negative turns it toward the camera). Drag in the editor. */
  turn: number;
  frame: AvatarFrame;
  /** 0.7..1.6: closer / further than the frame's default. */
  zoom: number;
  /** "clear", a BACKDROPS id, "#rrggbb", or "map:<name>". */
  bg: string;
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
const item = (slot: CosmeticSlot, v: unknown, d: string): string => {
  const c = typeof v === "string" ? cosmetic(v) : null;
  return c && c.slot === slot ? c.id : d;
};

/** Default poses for players who haven't made one (and the defaults' file numbers: <outfit>-<index>.webp). */
export const DEFAULT_POSES: readonly Pick<AvatarSpec, "pose" | "hand" | "moment" | "tilt" | "ears" | "turn" | "zoom">[] = [
  { pose: "holdup", hand: "knife", moment: 0.3, tilt: 0.15, ears: 0.4, turn: -18, zoom: 0.84 },
  { pose: "wave", hand: "none", moment: 0.3, tilt: 0, ears: 0.5, turn: -18, zoom: 1.12 },
  { pose: "crossed", hand: "none", moment: 0.3, tilt: 0.2, ears: 0.3, turn: -15, zoom: 0.84 },
  { pose: "cheer", hand: "none", moment: 0.3, tilt: 0, ears: 0.8, turn: -10, zoom: 1.1 },
];

/**
 * Which default pose a player gets: the last character of their id, so SQL can pick the same one
 * (migrations/0073: unicode(substr(id, -1)) % 4). Ids end in random characters, so it's spread evenly enough.
 */
export const defaultPoseIndex = (userId: string) => (userId.length ? userId.charCodeAt(userId.length - 1) : 0) % DEFAULT_POSES.length;

/** The default backdrop for a colourway: a dark studio gradient lit in the colourway's swatch. */
export const defaultBg = (outfit: string) => `outfit:${item("outfit", outfit, DEFAULT_COSMETICS.outfit!)}`;

/** The avatar a player shows before making one: their colourway, a pose picked from their id, shoulders up. */
export function defaultAvatar(userId: string, outfit?: string | null): AvatarSpec {
  const o = item("outfit", outfit, DEFAULT_COSMETICS.outfit!);
  return {
    v: 1,
    outfit: o,
    body: "body-a",
    hat: null,
    knife: DEFAULT_COSMETICS.knife!,
    finish: DEFAULT_COSMETICS.finish!,
    glove: DEFAULT_COSMETICS.glove!,
    gun: "usp",
    // Head and shoulders: the defaults are mostly seen at 24 px on the boards.
    frame: "close",
    ...DEFAULT_POSES[defaultPoseIndex(userId)],
    bg: defaultBg(o),
  };
}

/** Site path of a player's default avatar image (public-site/avatars/default). */
export function defaultAvatarPath(userId: string, outfit?: string | null): string {
  return `/avatars/default/${item("outfit", outfit, DEFAULT_COSMETICS.outfit!)}-${defaultPoseIndex(userId)}.webp`;
}

/** Lenient read (stored JSON, the editor's URL hash): anything unknown falls back to the default. */
export function cleanAvatar(raw: unknown): AvatarSpec {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const outfit = item("outfit", r.outfit, DEFAULT_COSMETICS.outfit!);
  const bg = typeof r.bg === "string" && (r.bg === "clear" || HEX.test(r.bg) || MAP.test(r.bg) || BACKDROPS.some((b) => b.id === r.bg) || r.bg === defaultBg(outfit)) ? r.bg : defaultBg(outfit);
  return {
    v: 1,
    outfit,
    body: r.body === "body-b" ? "body-b" : "body-a",
    hat: r.hat === null || r.hat === undefined ? null : item("hat", r.hat, "") || null,
    hand: pick(r.hand, ["knife", "gun", "none"] as const, "knife"),
    knife: item("knife", r.knife, DEFAULT_COSMETICS.knife!),
    finish: item("finish", r.finish, DEFAULT_COSMETICS.finish!),
    glove: item("glove", r.glove, DEFAULT_COSMETICS.glove!),
    gun: pick(r.gun, GUN_IDS, "usp"),
    pose: pick(r.pose, POSES.map((p) => p.id), "holdup"),
    moment: clamp(r.moment, 0, 1, 0.5),
    tilt: clamp(r.tilt, -1, 1, 0),
    ears: clamp(r.ears, -1, 1, 0),
    turn: clamp(r.turn, -180, 180, 0),
    frame: pick(r.frame, FRAMES.map((f) => f.id), "bust"),
    zoom: clamp(r.zoom, 0.7, 1.6, 1),
    bg,
  };
}

/** The cosmetics an avatar wears, as a POST /me/cosmetics-shaped object (for progression.ts cosmeticsProblem). */
export function avatarCosmetics(s: AvatarSpec): Record<string, string | null> {
  return {
    outfit: s.outfit,
    body: s.body,
    hat: s.hat,
    // A hidden knife (gun or empty hand) still names one; the default is always owned.
    knife: s.hand === "knife" ? s.knife : DEFAULT_COSMETICS.knife!,
    finish: s.hand === "knife" ? s.finish : DEFAULT_COSMETICS.finish!,
    glove: s.glove,
  };
}

/** Compact, stable JSON for storage (keys in a fixed order, numbers rounded). */
export function packAvatar(s: AvatarSpec): string {
  const c = cleanAvatar(s);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return JSON.stringify({ ...c, moment: r2(c.moment), tilt: r2(c.tilt), ears: r2(c.ears), turn: Math.round(c.turn), zoom: r2(c.zoom) });
}

export function unpackAvatar(s: string | null | undefined): AvatarSpec | null {
  if (!s || s.length > 1000) return null;
  try {
    return cleanAvatar(JSON.parse(s));
  } catch {
    return null;
  }
}

/** Saved avatar images: 256 px square WebP, at most this many bytes. */
export const AVATAR_PX = 256;
export const AVATAR_MAX_BYTES = 96 * 1024;
