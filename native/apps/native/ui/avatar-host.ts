// The avatar editor's line to the host's renderer (src/avatar_service.hpp). The menu has no WebGL, so the host poses,
// frames and draws the bunny for a spec and sends back a picture: a PNG to show, the WebP to save to the account, or a
// PNG written to the Downloads folder.
import { avatarCosmetics, type AvatarSpec } from "../../web/src/avatar/spec";
import { BACKDROPS } from "../../web/src/avatar/spec";
import { loadoutFor, packLoadout } from "../../web/src/loadout";
import { cosmetic } from "../../web/src/progression";
import { send } from "./bridge";

export type AvatarOutput = "preview" | "webp" | "file";
/** Thumbnail close-ups (stage.ts Focus): a knife in the raised hand, or a glove. */
export type AvatarFocus = "hand" | "glove";
export type AvatarBackdrop =
  | { kind: "clear" }
  | { kind: "solid"; top: string }
  | { kind: "studio"; top: string; bottom: string; glow: string | null };

/** The spec as the host reads it: the cosmetics already packed the way the game's loadout carries them. */
export interface AvatarRenderSpec {
  outfit: string;
  loadout: string;
  pose: string;
  knife: string;
  gun: string;
  hand: AvatarSpec["hand"];
  moment: number;
  tilt: number;
  ears: number;
  turn: number;
  frame: AvatarSpec["frame"];
  zoom: number;
}

export interface AvatarRenderRequest {
  output: AvatarOutput;
  size: number;
  /** The big preview: a newer one replaces it on the host if it hasn't been drawn yet. */
  live?: boolean;
  focus?: AvatarFocus;
  spec: AvatarRenderSpec;
  backdrop: AvatarBackdrop;
}

export type AvatarHostMessage = ({ type: "avatarRender"; id: number } & AvatarRenderRequest) | { type: "avatarClose" };

/** A PNG data URL, the WebP (base64), the path a file went to, or why there's none. */
export type AvatarPicture = { png: string } | { webp: string } | { saved: string } | { error: string };

declare global {
  interface Window {
    bunnyhopNativeAvatar?: (reply: unknown) => void;
  }
}

const REPLY_TIMEOUT_MS = 30_000;
let serial = 0;
const pending = new Map<number, { done: (picture: AvatarPicture) => void; timer: ReturnType<typeof setTimeout> }>();

function pictureOf(reply: Record<string, unknown>): AvatarPicture {
  if (typeof reply.png === "string" && reply.png.startsWith("data:image/png;base64,")) return { png: reply.png };
  if (typeof reply.webp === "string") return { webp: reply.webp };
  if (typeof reply.saved === "string") return { saved: reply.saved };
  return { error: typeof reply.error === "string" ? reply.error : "The picture couldn't be drawn." };
}

function receive(reply: unknown): void {
  if (!reply || typeof reply !== "object") return;
  const r = reply as Record<string, unknown>;
  const job = typeof r.id === "number" ? pending.get(r.id) : undefined;
  if (!job) return;
  clearTimeout(job.timer);
  pending.delete(r.id as number);
  job.done(pictureOf(r));
}

/** Why a picture didn't come ("replaced" and "closed" are quiet: a newer preview, or the editor closed). */
export function pictureError(picture: AvatarPicture, fallback = "The picture couldn't be drawn."): string {
  return "error" in picture ? picture.error : fallback;
}

/** Asks the host for a picture. Resolves with an error (never rejects) when it can't make one. */
export function renderAvatar(request: AvatarRenderRequest): Promise<AvatarPicture> {
  window.bunnyhopNativeAvatar = receive;
  const id = ++serial;
  return new Promise((done) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      done({ error: "The picture took too long." });
    }, REPLY_TIMEOUT_MS);
    pending.set(id, { done, timer });
    send({ type: "avatarRender", id, ...request });
  });
}

/** The editor closed: the host drops queued pictures and its renderer. */
export function closeAvatarRenderer(): void {
  for (const [id, job] of pending) {
    clearTimeout(job.timer);
    job.done({ error: "closed" });
    pending.delete(id);
  }
  send({ type: "avatarClose" });
}

export function renderSpec(spec: AvatarSpec): AvatarRenderSpec {
  return {
    outfit: spec.outfit,
    // avatarCosmetics carries whatever the spec's look includes (a wig's hair too, where the web code has it).
    loadout: packLoadout(loadoutFor(avatarCosmetics(spec))),
    pose: spec.pose,
    knife: spec.knife,
    gun: spec.gun,
    hand: spec.hand,
    moment: spec.moment,
    tilt: spec.tilt,
    ears: spec.ears,
    turn: spec.turn,
    frame: spec.frame,
    zoom: spec.zoom,
  };
}

// stage.ts paintBackdrop's colours: the default studio, the colourway studio and a map shot that couldn't load.
const STUDIO_TOP = "#26262d";
const STUDIO_BOTTOM = "#0c0c0f";
const COLOURWAY_TOP = "#22222a";
const COLOURWAY_BOTTOM = "#0e0e12";
const COLOURWAY_FALLBACK = "#ffb43c";
const MAP_FALLBACK = "#1c1c22";

/**
 * spec.bg as the host paints it. Map shots aren't drawn natively: they show the plain colour the website shows while
 * a shot can't load.
 */
export function backdropOf(bg: string): AvatarBackdrop {
  if (bg === "clear") return { kind: "clear" };
  if (bg.startsWith("#")) return { kind: "solid", top: bg.toLowerCase() };
  if (bg.startsWith("map:")) return { kind: "solid", top: MAP_FALLBACK };
  if (bg.startsWith("outfit:")) {
    const glow = cosmetic(bg.slice(7))?.color ?? COLOURWAY_FALLBACK;
    return { kind: "studio", top: COLOURWAY_TOP, bottom: COLOURWAY_BOTTOM, glow: glow.toLowerCase() };
  }
  const named = BACKDROPS.find((b) => b.id === bg);
  return { kind: "studio", top: named?.top ?? STUDIO_TOP, bottom: named?.bottom ?? STUDIO_BOTTOM, glow: null };
}
