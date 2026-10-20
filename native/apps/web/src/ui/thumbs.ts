// Map imagery: in-engine renders (tools/thumbs/render.ts → maps/thumbs/, listed in maps/index.json) with GameBanana
// screenshots as gallery extras and fallback.
//   - every map in the index has a tiny blurred placeholder (LQIP, a ~150-byte WebP data URI in index.json), shown
//     instantly while the real image streams in, so cards never fall back to the gradient + initials;
//   - grid cards use the 480×270 card render, big art (hero panel, loading screen, featured card) the 1280×720 hero;
//   - images load lazily when the box nears the viewport (IntersectionObserver);
//   - maps not in the index (or remote URLs) still get the per-map gradient + initials and a blurred preview cached
//     in localStorage the first time their image loads.
// mapArt() resolves the right image from the index by map name, so callers can keep passing their old URL as a
// fallback; registerMapImages() is called by fetchMapIndex() (ui/maps.ts).

import { h } from "./dom";
import "./thumbs.css";

const LQIP_PREFIX = "bunnyhop:lqip:";
const LQIP_W = 32;
const LQIP_H = 18;

export interface MapImages {
  /** 480×270 in-engine card render (else a GameBanana screenshot). */
  thumbnail?: string | null;
  /** 1280×720 in-engine hero render. */
  hero?: string | null;
  /** Blurred placeholder data URI. */
  lqip?: string | null;
  /** In-engine shots (hero first). */
  shots?: string[];
  /** GameBanana screenshots (local copy first, then remote). */
  screenshots?: string[];
}

const registry = new Map<string, MapImages>();

/** Index entries (maps/index.json) → image lookup by map name. */
export function registerMapImages(maps: ({ name: string } & MapImages)[]): void {
  for (const m of maps) registry.set(m.name, { thumbnail: m.thumbnail, hero: m.hero, lqip: m.lqip, shots: m.shots, screenshots: m.screenshots });
}

export function mapImages(name: string): MapImages | null {
  return registry.get(name) ?? null;
}

/** Every distinct image for a map's gallery: in-engine shots, then GameBanana screenshots. */
export function galleryOf(name: string, fallback?: string | null): string[] {
  const m = registry.get(name);
  return [...new Set([m?.hero, ...(m?.shots ?? []), ...(m?.screenshots ?? []), fallback].filter((u): u is string => !!u))];
}

export function initials(name: string): string {
  return name.replace(/^(bhop|kz|surf)_/i, "").slice(0, 2).toUpperCase();
}

export function hue(name: string): number {
  let x = 0;
  for (let i = 0; i < name.length; i++) x = (x * 31 + name.charCodeAt(i)) >>> 0;
  return x % 360;
}

function lqipKey(url: string): string {
  return LQIP_PREFIX + url.replace(/^https?:\/\//, "").slice(-120);
}

function cachedLqip(url: string): string | null {
  try {
    return localStorage.getItem(lqipKey(url));
  } catch {
    return null;
  }
}

function storeLqip(img: HTMLImageElement, url: string): void {
  try {
    if (localStorage.getItem(lqipKey(url))) return;
    const c = document.createElement("canvas");
    c.width = LQIP_W;
    c.height = LQIP_H;
    const g = c.getContext("2d")!;
    // Cover-crop to 16:9.
    const r = img.naturalWidth / img.naturalHeight;
    let sw = img.naturalWidth;
    let sh = img.naturalHeight;
    if (r > 16 / 9) sw = sh * (16 / 9);
    else sh = sw / (16 / 9);
    g.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, LQIP_W, LQIP_H);
    localStorage.setItem(lqipKey(url), c.toDataURL("image/jpeg", 0.7));
  } catch {
    /* tainted canvas (no CORS) or quota: no placeholder next time */
  }
}

let io: IntersectionObserver | null = null;
function observer(): IntersectionObserver {
  io ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io!.unobserve(e.target);
        (e.target as HTMLElement & { __load?: () => void }).__load?.();
      }
    },
    { rootMargin: "300px" },
  );
  return io;
}

type ArtSize = "card" | "hero";

/** Loads `url` into the art box as its full image (cross-fading over whatever is there). */
function showImage(art: HTMLElement, url: string, storePreview: boolean, priority = false): void {
  const load = (cors: boolean) => {
    const img = h("img.full", { alt: "", decoding: "async", referrerpolicy: "no-referrer" });
    if (priority) img.fetchPriority = "high"; // the home screen's featured art is the page's LCP
    if (cors) img.crossOrigin = "anonymous";
    img.addEventListener("load", () => {
      if (art.dataset.src !== url) return img.remove(); // superseded (gallery navigation)
      for (const old of art.querySelectorAll("img.full")) if (old !== img) old.remove();
      img.classList.add("in");
      art.classList.add("loaded");
      if (cors && storePreview) storeLqip(img, url);
    });
    img.addEventListener("error", () => {
      img.remove();
      if (cors) load(false); // host without CORS: still show the image, just don't cache a preview
    });
    img.src = url;
    art.append(img);
  };
  art.dataset.src = url;
  load(true);
}

/**
 * A 16:9 art box for a map: blurred placeholder (or gradient + initials), lazily loaded image. The image comes from
 * the map index by name (card render, or the hero render for big art: `size: "hero"`, or a hero/feat/load class),
 * else `url`. Call `observeThumbs(container)` after inserting it into the DOM (or pass eager).
 */
export function mapArt(name: string, url: string | null | undefined, o: { eager?: boolean; className?: string; size?: ArtSize; priority?: boolean } = {}): HTMLElement {
  const art = h(`div.card-art${o.className ? "." + o.className : ""}`, { style: `--h:${hue(name)}` }, h("span.card-initials", { "aria-hidden": "true" }, initials(name)));
  const size: ArtSize = o.size ?? (o.className && /hero|feat|load/.test(o.className) ? "hero" : "card");
  const reg = registry.get(name);
  const src = (size === "hero" ? (reg?.hero ?? reg?.thumbnail) : (reg?.thumbnail ?? reg?.hero)) ?? url ?? null;
  if (!src) return art;
  const lq = reg?.lqip ?? cachedLqip(src);
  if (lq) {
    art.append(h("img.lqip", { src: lq, alt: "", "aria-hidden": "true", decoding: "async" }));
    art.classList.add("has-lqip");
  }
  const storePreview = !reg?.lqip;
  if (o.eager) showImage(art, src, storePreview, o.priority);
  else {
    art.dataset.lazy = "";
    (art as HTMLElement & { __load?: () => void }).__load = () => showImage(art, src, storePreview);
  }
  return art;
}

/**
 * The hero panel's art: the hero render plus a small gallery (in-engine shots, then GameBanana screenshots) with
 * prev/next buttons, dots and ←/→ when focused. Other images load only when picked.
 */
export function mapGallery(name: string, url: string | null | undefined, o: { className?: string } = {}): HTMLElement {
  const art = mapArt(name, url, { eager: true, size: "hero", className: o.className });
  const images = galleryOf(name, url);
  if (images.length < 2) return art;
  const engine = new Set(registry.get(name)?.shots ?? []);
  let i = Math.max(0, images.indexOf(art.dataset.src ?? ""));
  const dots = images.map((src, k) =>
    h(`button.gal-dot${engine.has(src) ? "" : ".gb"}`, {
      type: "button",
      tabindex: "-1",
      title: engine.has(src) ? `In-game view ${k + 1}` : "GameBanana screenshot",
      "aria-label": `Image ${k + 1} of ${images.length}`,
      onclick: (e: Event) => (e.stopPropagation(), go(k)),
    }),
  );
  const label = h("span.gal-src", null);
  const go = (k: number) => {
    i = (k + images.length) % images.length;
    showImage(art, images[i], false);
    dots.forEach((d, j) => d.classList.toggle("on", j === i));
    label.textContent = engine.has(images[i]) ? "" : "GameBanana";
  };
  const btn = (dir: -1 | 1) =>
    h(`button.gal-nav.${dir < 0 ? "prev" : "next"}`, { type: "button", tabindex: "-1", "aria-label": dir < 0 ? "Previous image" : "Next image", onclick: (e: Event) => (e.stopPropagation(), go(i + dir)) }, dir < 0 ? "‹" : "›");
  art.classList.add("has-gallery");
  art.tabIndex = 0;
  art.setAttribute("role", "group");
  art.setAttribute("aria-label", `${name} images (left/right to browse)`);
  art.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    go(i + (e.key === "ArrowLeft" ? -1 : 1));
  });
  art.append(btn(-1), btn(1), h("div.gal-dots", null, ...dots), label);
  dots[i]?.classList.add("on");
  return art;
}

/** Starts lazy loading for art boxes inside `root` (call once they are in the DOM). */
export function observeThumbs(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>(".card-art[data-lazy]")) {
    delete el.dataset.lazy;
    observer().observe(el);
  }
}

let prefetched = false;
/**
 * Warms the HTTP cache for thumbnails while the home screen is idle, so the map browser opens with images.
 * Maps in the index prefetch their (small, local) card render instead of the URL passed in.
 */
export function prefetchThumbs(urls: (string | null | undefined)[], concurrency = 6): void {
  if (prefetched) return;
  prefetched = true;
  const cards = [...registry.values()].map((m) => m.thumbnail);
  const queue = [...new Set((registry.size ? cards : urls).filter((u): u is string => !!u))];
  const next = () => {
    const url = queue.shift();
    if (!url) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.onload = () => (registry.size ? null : storeLqip(img, url), next());
    img.onerror = () => next();
    img.src = url;
  };
  for (let i = 0; i < concurrency; i++) next();
}
