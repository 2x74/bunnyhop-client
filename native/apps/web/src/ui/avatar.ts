// Player avatar pictures: the Discord avatar a player chose to show (opt-in, apps/api/src/auth.ts), drawn in place of
// their letter. One helper so every place sizes, lazy-loads and falls back the same way: the picture takes the letter's
// exact box (the caller's class sets the size, so nothing shifts when it loads) and turns back into the letter if it
// fails to load.

import { h } from "./dom";

const DISCORD_AVATAR = /^https:\/\/cdn\.discordapp\.com\/avatars\/\d+\/(a_)?[0-9a-f]+\.png(\?|$)/;

/**
 * The URL to load for a `px` CSS-pixel avatar: Discord avatars at the smallest CDN size that's sharp on this screen (64
 * or 128). `animate`: an animated Discord avatar plays (the profile card only, and not with reduced motion).
 */
export function avatarSrc(url: string, px: number, animate = false): string {
  const m = DISCORD_AVATAR.exec(url);
  if (!m) return url;
  const u = new URL(url);
  const want = px * (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  u.searchParams.set("size", want <= 64 ? "64" : "128");
  if (animate && m[1] && !matchMedia("(prefers-reduced-motion: reduce)").matches) u.pathname = u.pathname.replace(/\.png$/, ".gif");
  return u.toString();
}

/**
 * The picture for `url` with class spec `cls` (e.g. "img.rb-av"), `px` CSS pixels square. `letter` builds the
 * fallback that replaces it if the picture can't load. Lazy unless `eager` (long boards only fetch rows in view).
 */
export function avatarImg(url: string, o: { cls: string; px: number; letter: () => HTMLElement; eager?: boolean; animate?: boolean }): HTMLElement {
  const img = h(`img.${o.cls}`, {
    src: avatarSrc(url, o.px, o.animate),
    alt: "",
    width: o.px,
    height: o.px,
    loading: o.eager ? null : "lazy",
    decoding: "async",
    referrerpolicy: "no-referrer",
    draggable: "false",
  });
  img.addEventListener(
    "error",
    () => {
      const swap = () => img.isConnected && img.replaceWith(o.letter());
      if (img.isConnected) swap();
      else requestAnimationFrame(swap);
    },
    { once: true },
  );
  return img;
}
