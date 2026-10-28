// Map art and tiers in the admin: a 48×27 chip of the map's card render in front of every map name (the ~150-byte
// blurred LQIP from maps/index.json at once, the 480×270 card render once the chip nears the viewport), the 1280×720
// hero for a live room's backdrop, and the tier in the game's tier colour ("T3"). The index is the one the game reads
// (/index.json); a map not in it gets its initials on a hue of its own. Plain DOM; no game UI code.

import { clampTier, tierLabel } from "../tiers";
import { h } from "./core";

interface Entry {
  name: string;
  tier?: number | string | null;
  lqip?: string | null;
  thumbnail?: string | null;
  hero?: string | null;
}

const index = new Map<string, Entry>();
let loading: Promise<void> | null = null;
const waiting = new Set<HTMLElement>();

/** Loads /index.json once (chips made before it arrives fill in when it does). */
export function loadMapIndex(): Promise<void> {
  loading ??= fetch("/index.json")
    .then((r) => (r.ok && (r.headers.get("content-type") ?? "").includes("json") ? r.json() : { maps: [] }))
    .then((j: { maps?: Entry[] }) => {
      for (const m of j.maps ?? []) index.set(m.name, m);
      for (const el of waiting) paint(el);
      waiting.clear();
    })
    .catch(() => undefined);
  return loading;
}

export const mapTier = (name: string): number | null => {
  const t = Number(index.get(name)?.tier);
  return Number.isFinite(t) && t >= 1 ? Math.min(6, Math.round(t)) : null;
};

const hue = (name: string) => {
  let x = 0;
  for (let i = 0; i < name.length; i++) x = (x * 31 + name.charCodeAt(i)) >>> 0;
  return x % 360;
};

// Chips upgrade to the card render when they come near the viewport.
const io =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const el = e.target as HTMLElement;
            io!.unobserve(el);
            const src = el.dataset.src;
            if (!src) continue;
            const img = new Image();
            img.decoding = "async";
            img.onload = () => el.style.setProperty("--art", `url("${src}")`);
            img.src = src;
          }
        },
        { rootMargin: "200px" },
      )
    : null;

function paint(el: HTMLElement): void {
  const name = el.dataset.map!;
  const m = index.get(name);
  if (!m) {
    if (!loading) void loadMapIndex();
    el.classList.add("plain");
    el.style.setProperty("--h", String(hue(name)));
    if (!el.textContent) el.textContent = name.replace(/^(bhop|kz|surf)_/i, "").slice(0, 2).toUpperCase();
    return;
  }
  el.classList.remove("plain");
  el.textContent = "";
  if (m.lqip) el.style.setProperty("--art", `url("${m.lqip}")`);
  const big = el.classList.contains("hero") ? m.hero ?? m.thumbnail : m.thumbnail;
  if (big) {
    el.dataset.src = big;
    io?.observe(el);
  }
}

/** The map's art chip (decorative: the name next to it says which map). */
export function mapArt(name: string, cls = ""): HTMLElement {
  const el = h("span", { class: `map-art ${cls}`.trim(), "data-map": name, "aria-hidden": "true" });
  if (index.size) paint(el);
  else {
    waiting.add(el);
    el.classList.add("plain");
    el.style.setProperty("--h", String(hue(name)));
    void loadMapIndex();
  }
  return el;
}

/** "T3" in its tier colour ("T?" when unrated). */
export function tierTag(tier: number | null | undefined): HTMLElement {
  const t = clampTier(tier);
  return h("span", { class: `tier t${t ?? "x"}`, title: t ? `Tier ${tier}` : "Unrated" }, tierLabel(t));
}

/** A map line: chip, name, tier, and an optional track ("b1"). `href`: the name links there. */
export function mapLine(name: string, o: { tier?: number | null; track?: number; href?: string; style?: string } = {}): HTMLElement {
  const tier = o.tier !== undefined ? o.tier : mapTier(name);
  return h(
    "span",
    { class: "map-line" },
    mapArt(name),
    o.href ? h("a", { href: o.href, class: "map-name" }, name) : h("span", { class: "map-name" }, name),
    o.track ? h("span", { class: "faint" }, `b${o.track}`) : null,
    tier !== null || o.tier !== undefined ? tierTag(tier) : null,
    o.style ? h("span", { class: "faint" }, o.style) : null,
  );
}
