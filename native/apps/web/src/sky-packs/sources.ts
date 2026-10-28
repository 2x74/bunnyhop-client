// Where skies come from without hunting for files (Settings → Graphics → Sky). Nothing here downloads anything: a sky
// is fetched only when a player picks it.
//   - hosted: our own .bhsky.json files (apps/web/public-site/sky-packs, built by tools/sky-packs/build-curated.ts), with
//     a calibrated sun.
//   - polyhaven: a CC0 Poly Haven "pure sky" HDRI, fetched as its 2k .hdr through /api/css-asset?kind=sky and turned into
//     a sky pack in the browser (sky-packs/from-hdr.ts).
// A player can also paste a Poly Haven page link, a direct .hdr / PNG / JPEG / WebP panorama link or a .bhsky.json link
// (parseSkyLink).

export type SkyClouds = "clear" | "sparse" | "photographic";
export type CuratedSky =
  | { id: string; name: string; mb: number; kind: "hosted"; path: string }
  | { id: string; name: string; mb: number; kind: "polyhaven"; asset: string; clouds: SkyClouds };

export const CURATED_SKIES: CuratedSky[] = [
  { id: "clear-day", name: "Clear day", mb: 6.2, kind: "hosted", path: "/sky-packs/clear-day.bhsky.json" },
  { id: "cloudy-day", name: "Cloudy day", mb: 7.3, kind: "hosted", path: "/sky-packs/cloudy-day.bhsky.json" },
  { id: "sunset", name: "Sunset", mb: 5.5, kind: "hosted", path: "/sky-packs/sunset.bhsky.json" },
  { id: "overcast_soil_puresky", name: "Overcast", mb: 4.6, kind: "polyhaven", asset: "overcast_soil_puresky", clouds: "photographic" },
  { id: "belfast_sunset_puresky", name: "Golden hour", mb: 4.6, kind: "polyhaven", asset: "belfast_sunset_puresky", clouds: "photographic" },
  { id: "qwantani_dusk_2_puresky", name: "Dusk", mb: 4.6, kind: "polyhaven", asset: "qwantani_dusk_2_puresky", clouds: "clear" },
  { id: "kloppenheim_02_puresky", name: "Starry night", mb: 5.6, kind: "polyhaven", asset: "kloppenheim_02_puresky", clouds: "clear" },
];

/** Poly Haven's sky HDRIs, for players who want more than the list. */
export const MORE_SKIES_URL = "https://polyhaven.com/hdris/skies";

/** The 2k .hdr of a Poly Haven HDRI (the size the sky budget allows: 4k decodes past SKY_LIMITS.decoded). */
export const polyhavenHdr = (asset: string) => `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/${asset}_2k.hdr`;
/** Poly Haven's public metadata (name, categories) for an HDRI. */
export const polyhavenInfo = (asset: string) => `https://api.polyhaven.com/info/${asset}`;

export type SkyLink = { kind: "polyhaven"; asset: string } | { kind: "hdr"; url: string } | { kind: "image"; url: string } | { kind: "pack"; url: string };

/**
 * What a pasted link points at: a Poly Haven HDRI (its page, or any of its files), a direct .hdr file, a PNG / JPEG / WebP
 * panorama, or a .bhsky.json sky pack (anything else https is tried as a pack, and is a picture if its bytes say so). Null for something that isn't an https link.
 */
export function parseSkyLink(raw: string): SkyLink | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "polyhaven.com" || host === "www.polyhaven.com") {
    const m = /^\/a\/([a-z0-9_]{1,63})\/?$/.exec(u.pathname);
    return m ? { kind: "polyhaven", asset: m[1]! } : null;
  }
  if (host === "dl.polyhaven.org") {
    const m = /\/HDRIs\/[a-z]+\/\d+k\/([a-z0-9_]{1,63})_\d+k\.[a-z]+$/.exec(u.pathname);
    if (m) return { kind: "polyhaven", asset: m[1]! };
  }
  if (/\.hdr$/i.test(u.pathname)) return { kind: "hdr", url: u.toString() };
  if (/\.(png|jpe?g|webp)$/i.test(u.pathname)) return { kind: "image", url: u.toString() };
  return { kind: "pack", url: u.toString() };
}

/** A pack id from a file name or HDRI name: lower case, [a-z0-9_-], at most 64 characters. */
export function skyIdFrom(name: string): string {
  const id = name.toLowerCase().replace(/\.[a-z]+$/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 64);
  return id || "sky";
}
