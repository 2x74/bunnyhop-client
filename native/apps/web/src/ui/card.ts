import { countryFlag } from "./country-flag";
// Player card (profile hero, card editor preview). Borrowed from Aimperion's ID-card layout (cut corners, container
// units so it scales as one piece, 6° tilt + pointer sheen, off for touch / reduced motion) and hatchdle's card
// (frame band + background cosmetics, featured items, three badge chips, automatic picks when nothing is chosen).
// Styles: ui/profile.css (.pc-*).

import type { CosmeticChoice, Profile, RunCard } from "../api";
import { cosmetic, DEFAULT_COSMETICS } from "../progression";
import { peakOf, STAFF_LABEL, staffBadgeOf, type NameLook, type PeakTier } from "../creators";
import { fmtPoints, STYLE_WEIGHT, topPercent } from "../ranking";
import { styleLabel } from "../styles";
import { CARD_TIERS, cardTierCounts, cardTierLabel, tierColor, tierLabel } from "../tiers";
import { countWord } from "../hud/time-face";
import { formatTime } from "../timer";
import { trackName } from "../zones";
import { badgeChip } from "./badges";
import { LOGO_SVG } from "./brand";
import { avatarImg, pictureOf } from "./avatar";
import { h } from "./dom";
import { nameAttrs, nameMarks } from "./marks";
import { adminLink } from "../staff-lens";
import { decorated } from "./avatar-deco";
import { cardLayers, frameLayers, setPointer, watchCardFx } from "./card-fx";
import type { CardBorderId, CardEffectId } from "../supporter-looks";
import type { MapBgView } from "../map-bg";
import { MAP_BG_CLASS, mapBgLayer, mapBgSrc, wrLine } from "./card-mapbg";

/** Everything Edit card previews of a supporter's look over the saved one. */
export type SupporterLook = NameLook & { avatarDeco?: import("../supporter-looks").AvatarDecoId | null; cardBorder?: CardBorderId | null; cardEffect?: CardEffectId | null; hoverFx?: import("../supporter-looks").HoverFxId | null };


const CROWN_SVG = `<svg viewBox="0 0 20 14" aria-hidden="true"><path d="M2 12h16l1.4-9-5 3.6L10 1 5.6 6.6.6 3z" fill="currentColor"/><circle cx="10" cy="9" r="1.4" fill="rgba(0,0,0,0.35)"/></svg>`;

/** The owner's hats (progression.ts slot "hat"), drawn where the crown goes: a hat replaces the crown while it's on. */
const HAT_SVG: Record<string, string> = {
  "hat-founder-crown": `<svg viewBox="0 0 20 14" aria-hidden="true"><path d="M2 11.2 2.6 5l1.8 2.4 1.8-4.2 1.9 4.2L10 1l1.9 6.4 1.9-4.2 1.8 4.2L17.4 5l.6 6.2z" fill="#a77cff"/><rect x="1.8" y="8.4" width="16.4" height="3.6" rx="0.8" fill="#ff7a1a"/><rect x="1.8" y="11.6" width="16.4" height="1.6" rx="0.8" fill="#2a1660"/><ellipse cx="10" cy="10.2" rx="1.5" ry="1.3" fill="#3ff0ff"/><circle cx="10" cy="1.4" r="0.9" fill="#3ff0ff"/><circle cx="6.2" cy="3.4" r="0.75" fill="#3ff0ff"/><circle cx="13.8" cy="3.4" r="0.75" fill="#3ff0ff"/></svg>`,
  "hat-tophat": `<svg viewBox="0 0 20 14" aria-hidden="true"><ellipse cx="10" cy="12" rx="8.6" ry="1.7" fill="#3d3456" stroke="#b3a6e0" stroke-width="0.6"/><path d="M5.6 11.6 6.2 1.4h7.6l.6 10.2z" fill="#3d3456" stroke="#b3a6e0" stroke-width="0.6"/><path d="M5.85 8.4h8.3l.15 2.2H5.7z" fill="#ff7a1a"/></svg>`,
  "hat-beanie": `<svg viewBox="0 0 20 14" aria-hidden="true"><path d="M3 11.4C3 6.6 6.1 3.6 10 3.6s7 3 7 7.8z" fill="#ff7a1a"/><rect x="2.4" y="9.8" width="15.2" height="3.4" rx="1.2" fill="#d95a0c"/><circle cx="10" cy="2.6" r="2.1" fill="#3fbf5a"/></svg>`,
  "hat-gem-orbit": `<svg viewBox="0 0 20 14" aria-hidden="true"><ellipse cx="10" cy="8" rx="8.6" ry="3.2" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="0.6"/><path d="M3 2.6 5.2 6.4H.8z" fill="#c4cad5" stroke="#10202a" stroke-width="0.5" stroke-linejoin="round"/><path d="M8 3.4 9.6 6 8 8.6 6.4 6z" fill="#9b5cf5" stroke="#10202a" stroke-width="0.5" stroke-linejoin="round"/><path d="M14 9.4 16 10.8 15.2 13H12.8L12 10.8z" fill="#22c98e" stroke="#10202a" stroke-width="0.5" stroke-linejoin="round"/><path d="M16.6 3.2 18.6 3.2 19.4 4.4 17.6 6.8 15.8 4.4z" fill="#3f7ef0" stroke="#10202a" stroke-width="0.5" stroke-linejoin="round"/></svg>`,
  "hat-halo": `<svg viewBox="0 0 20 14" aria-hidden="true"><ellipse cx="10" cy="7" rx="8.4" ry="3.6" fill="none" stroke="#167a8c" stroke-width="2.4"/><ellipse cx="10" cy="6.4" rx="8.4" ry="3.6" fill="none" stroke="#5ff2df" stroke-width="1.8"/><path d="M3.2 4.6 4.6 3.8M15.4 3.8l1.4.8M10 10v0" stroke="#9a7cff" stroke-width="2" stroke-linecap="round"/><path d="M8.6 10h2.8" stroke="#9a7cff" stroke-width="2"/></svg>`,
  "hat-circlet": `<svg viewBox="0 0 20 14" aria-hidden="true"><path d="M1.6 10.6 1.4 8.2 7.6 7.2 10 2.4 12.4 7.2 18.6 8.2 18.4 10.6 12.6 10.2 10 12.2 7.4 10.2z" fill="#342a78" stroke="#9a7cff" stroke-width="0.7" stroke-linejoin="round"/><path d="M3.4 9.2 7.6 8.8M12.4 8.8l4.2.4" stroke="#5ff2df" stroke-width="1.1" stroke-linecap="round"/></svg>`,
  "hat-dealer-visor": `<svg viewBox="0 0 20 14" aria-hidden="true"><path d="M2 7.2C2 4.6 5.6 3.2 10 3.2s8 1.4 8 4" fill="none" stroke="#111216" stroke-width="2"/><path d="M2.6 6.4h14.8" stroke="#e0b13a" stroke-width="0.8"/><path d="M3.2 7.4C5 11.6 15 11.6 16.8 7.4 13.6 8.6 6.4 8.6 3.2 7.4z" fill="#1e9a5a" stroke="#5fd896" stroke-width="0.6" stroke-linejoin="round"/></svg>`,
  "hat-lucky-coins": `<svg viewBox="0 0 20 14" aria-hidden="true"><g stroke="#8a5a0c" stroke-width="0.6" fill="#ffcf4a"><ellipse cx="4" cy="5" rx="2.6" ry="2.6"/><ellipse cx="10" cy="3.4" rx="1.2" ry="2.6"/><ellipse cx="16" cy="5" rx="2.6" ry="2.6"/><ellipse cx="10" cy="10.6" rx="2.2" ry="2.6"/></g></svg>`,
  "hat-aurora": `<svg viewBox="0 0 20 14" aria-hidden="true"><defs><linearGradient id="hat-aurora-g" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#3ff0a0"/><stop offset="1" stop-color="#8a6bff"/></linearGradient></defs><path d="M1.5 8.5C4 5 6 10 10 7s6 1 8.5-2v4c-2.5 3-4.5-1-8.5 2s-6-2-8.5 1.5z" fill="url(#hat-aurora-g)"/></svg>`,
  "hat-starfish": `<svg viewBox="0 0 20 14" aria-hidden="true"><path d="M10 .8l1.9 4.3 4.7.4-3.6 3.1 1.1 4.6L10 10.8l-4.1 2.4 1.1-4.6-3.6-3.1 4.7-.4z" fill="#ff7f6e" stroke="#e25c4c" stroke-width="0.6" stroke-linejoin="round"/><g fill="#ffd8cc"><circle cx="10" cy="4" r=".6"/><circle cx="10" cy="7.4" r=".8"/><circle cx="13" cy="6.6" r=".5"/><circle cx="7" cy="6.6" r=".5"/></g></svg>`,
  "hat-pencil": `<svg viewBox="0 0 20 14" aria-hidden="true"><g transform="rotate(-14 10 7)"><rect x="4.2" y="5.4" width="10.6" height="3.2" fill="#ffc23d" stroke="#8a5a0c" stroke-width="0.5"/><path d="M4.2 6.47h10.6M4.2 7.53h10.6" stroke="#e8a92e" stroke-width="0.5"/><path d="M14.8 5.4 18.4 7l-3.6 1.6z" fill="#e8c79a" stroke="#8a5a0c" stroke-width="0.5" stroke-linejoin="round"/><path d="M17.2 6.47 18.4 7l-1.2.53z" fill="#2a2a2e"/><rect x="2.6" y="5.3" width="1.6" height="3.4" fill="#c9a24a"/><path d="M1 5.6c0-.4.3-.6.6-.6h1v4h-1c-.3 0-.6-.2-.6-.6z" fill="#f29bae"/></g></svg>`,
  "hat-wreath": `<svg viewBox="0 0 20 14" aria-hidden="true"><g fill="#e6ebf5" stroke="#7d879c" stroke-width="0.5" stroke-linejoin="round"><path d="M2.2 8.6c.3-1.6 1.4-2.5 2.6-2.6-.2 1.5-1.2 2.4-2.6 2.6z"/><path d="M3.6 11.4c.9-1.3 2.2-1.7 3.4-1.4-.8 1.2-2.1 1.7-3.4 1.4z"/><path d="M4.4 5.4c.7-1.4 2-2 3.2-1.8-.6 1.3-1.9 1.9-3.2 1.8z"/><path d="M17.8 8.6c-.3-1.6-1.4-2.5-2.6-2.6.2 1.5 1.2 2.4 2.6 2.6z"/><path d="M16.4 11.4c-.9-1.3-2.2-1.7-3.4-1.4.8 1.2 2.1 1.7 3.4 1.4z"/><path d="M15.6 5.4c-.7-1.4-2-2-3.2-1.8.6 1.3 1.9 1.9 3.2 1.8z"/></g><path d="M8.6 12.6C4.6 12 2.6 9.6 3 6.4M11.4 12.6c4-.6 6-3 5.6-6.2" fill="none" stroke="#7d879c" stroke-width="0.7" stroke-linecap="round"/></svg>`,
  "hat-santa": `<svg viewBox="0 0 20 14" aria-hidden="true"><path d="M3.4 10.6C3.6 6 6 3.2 9.6 2.6c2.6-.4 5 .4 6.6 2.2-1.6-.3-3 .2-3.6 1.4 1.4 1.2 2.6 2.8 3 4.4z" fill="#d0342c"/><rect x="2.4" y="9.6" width="15.2" height="3.4" rx="1.7" fill="#f5f2ec"/><circle cx="16.8" cy="5.4" r="1.9" fill="#f5f2ec"/></svg>`,
};

export interface CardOverrides {
  cosmetics?: CosmeticChoice;
  /**
   * A supporter's look being previewed in Edit card (undefined: the profile's own): name colour, effect and font, and
   * (v0.0.37) the avatar decoration and the card border and effect.
   */
  nameLook?: SupporterLook;
  badges?: string[];
  featured?: RunCard[];
  /** The card's first appearance on a screen: it rises in and a sheen sweeps across it once. */
  enter?: boolean;
  /**
   * v0.0.43: the map background to show (Edit card's preview of a held map, or null for none) instead of the profile's
   * own `mapBg` (undefined: the profile's).
   */
  mapBg?: MapBgView | null;
  /**
   * v0.0.43, Edit card → Flag: the flag to show instead of the profile's own (a hovered one; null: none). undefined:
   * the profile's.
   */
  country?: string | null;
  /** Edit card: with no flag, an empty outline where the flag goes, so it can be clicked like the card's other parts. */
  flagSlot?: boolean;
}

export function fmtHours(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)}h`;
}

/** The card's avatar: the player's Discord picture when they show it (an animated one plays here), else their bunny. */
export function avatarEl(p: { id?: string | null; name: string; avatarUrl: string | null }, cls = "pc-avatar"): HTMLElement {
  const letter = () => h(`span.${cls}.pc-plate`, { "aria-hidden": "true" }, (p.name[0] ?? "?").toUpperCase());
  const pic = pictureOf(p);
  return pic ? avatarImg(pic, { cls, px: 84, letter, eager: true, animate: true }) : letter();
}

/** Name of the title the player shows: the chosen title tag, else their rank title. */
export function displayTitle(p: Profile, c: CosmeticChoice = p.cosmetics): string {
  return cosmetic(c.title)?.name ?? p.rank.group.name;
}

/** "1,204 views" (null at none: the line stays quiet). */
export const viewsLabel = (n: number | undefined): string | null => (n ? `${n.toLocaleString("en-US")} ${n === 1 ? "view" : "views"}` : null);

/**
 * One of the card's three runs: tier and place, the map, the time with the points the record gives on the overall
 * board (record_points.points, as the profile's Top points list shows it; none when the run isn't a current record).
 */
export function featTile(r: RunCard): HTMLElement {
  const place = r.rank === 1 ? h("span.pc-place.wr", null, "WR") : r.rank ? h("span.pc-place", null, `#${r.rank}`) : null;
  const tags = [r.track ? trackName(r.track) : null, r.style !== "autohop" ? styleLabel(r.style) : null, viewsLabel(r.views)].filter(Boolean).join(" · ");
  const pts = r.points ? h("span.pc-feat-pts", { title: "Points this record gives on the overall board" }, fmtPoints(r.points), h("small", null, " pts")) : null;
  return h(
    `div.pc-feat-tile.t${r.tier ?? "x"}`,
    { "data-run": r.runId },
    h("div.pc-feat-top", null, h(`span.pc-tier.t${r.tier ?? "x"}`, null, tierLabel(r.tier)), place),
    h("div.pc-feat-map", null, r.map),
    h("div.pc-feat-row", null, h("span.pc-feat-time", null, formatTime(r.time)), pts),
    tags ? h("div.pc-feat-tag", null, tags) : null,
  );
}

/**
 * The peak treatment (v0.0.37): players whose hardest clear is T7 or higher (their peak mark) get a moving layer in
 * that tier's colour, growing with the tier. T7 a slow light sweep across the card; T8 adds a light running round the
 * frame; T9 adds motes drifting up; T10 has all three, brighter and quicker. CSS only, transform and opacity on their
 * own layers (ui/profile.css .pc-peak), so nothing re-lays out; still under reduced motion and on Potato.
 */
//
// Extension points (kept stable for other card effects, e.g. v37/supporter's borders and effects):
//   - peakLayers() returns { cls, style, aura, inner }. Both cards (playerCard, ui/hover-card.ts hoverCardBody) put
//     `aura` first inside the card (under .pc-inner / .hc-inner, so only the frame band shows it) and `inner` first
//     inside the content box (behind the content). Another effect can return the same shape and be spread beside it.
//   - CSS custom properties on the card: --peak (colour), --sweep / --sweep-a (sweep period and strength), --aura-t /
//     --aura-a (frame light period and strength), --motes-a; layer classes .pc-aura / .pc-glint / .pc-motes. All motion
//     is transform / opacity only, with a still state under prefers-reduced-motion and body.potato.
//   - Frames and backgrounds stay plain classes setting --frame / --bg-card (profile.css .pc-frame-* / .pc-bg-*) with
//     their OG twins in apps/api/src/og/cards.ts FRAMES / BGS; peakStill() there is the still version for images.
export function peakLayers(peak: PeakTier | null): { cls: string; style: string; aura: HTMLElement | null; inner: HTMLElement[] } {
  if (!peak) return { cls: "", style: "", aura: null, inner: [] };
  return {
    cls: `.pc-peak.pc-peak-${peak}`,
    style: `--peak:${tierColor(peak)}`,
    aura: peak >= 8 ? h("div.pc-aura", { "aria-hidden": "true" }) : null,
    inner: [...(peak >= 9 ? [h("div.pc-motes", { "aria-hidden": "true" })] : []), h("div.pc-glint", { "aria-hidden": "true" })],
  };
}

/** The card's element (.pc), nothing attached to it yet. */
function buildCard(p: Profile, o: CardOverrides): HTMLElement {
  const c = { ...DEFAULT_COSMETICS, ...p.cosmetics, ...o.cosmetics };
  const hatDef = cosmetic(c.hat);
  const hat = hatDef?.slot === "hat" && HAT_SVG[hatDef.id] ? hatDef : null;
  const badges = o.badges ?? p.badges;
  const featured = (o.featured ?? p.featured).slice(0, 3);
  const rank = p.rank;
  const s = p.stats;
  const title = displayTitle(p, c);
  // The peak's layers plus a supporter's border and effect (ui/card-fx.ts; stacking: supporter-looks.ts cardLayerPlan).
  const sl: SupporterLook = { nameColor: p.player.nameColor, avatarDeco: p.player.avatarDeco, cardBorder: p.player.cardBorder, cardEffect: p.player.cardEffect, ...o.nameLook };
  const peak = cardLayers(peakOf(p.player.special), sl);
  const clears = cardTierCounts(s.clearsByTier), ranked = cardTierCounts(s.rankedByTier);
  // The staff badge (older APIs: from the role).
  const staff = p.player.staff !== undefined ? p.player.staff : staffBadgeOf(p.role);
  /** A supporter's name look (Edit card → Name previews over what's saved). */
  const look = nameAttrs({ nameColor: p.player.nameColor, nameEffect: p.player.nameEffect, nameColor2: p.player.nameColor2, nameFont: p.player.nameFont, nameStyle: p.player.nameStyle, ...o.nameLook }, undefined, p.player.name);
  // A world record holder's map as the background (ui/card-mapbg.ts): only while the API says the record is held.
  const mapBg = o.mapBg !== undefined ? o.mapBg : (p.mapBg ?? null);
  const mapSrc = mapBgSrc(mapBg);
  // The profile flag before the name: a card part in edit mode (data-part), with an empty slot there when none is set.
  const flag = countryFlag(o.country !== undefined ? o.country : p.player.country) ?? (o.flagSlot ? h("span.pc-flag-empty", { title: "Add a flag" }) : null);
  flag?.setAttribute("data-part", "flag");
  const avatar = decorated(avatarEl(p.player), sl, { animate: true, watch: false });
  avatar.setAttribute("data-part", "avatar");

  // data-part: the parts the owner's card editor picks by clicking them (ui/profile.ts).
  const card = h(
    `div.pc.pc-frame-${(c.frame ?? "frame-plain").replace(/^frame-/, "")}.pc-bg-${(c.background ?? "bg-night").replace(/^bg-/, "")}${peak.cls}${mapSrc ? `.${MAP_BG_CLASS}` : ""}`,
    { style: `--rank:${rank.group.color}${peak.style ? `;${peak.style}` : ""}`, "data-part": "frame" },
    frameLayers(c.frame),
    peak.aura,
    h(
      "div.pc-inner",
      { "data-part": "background" },
      mapBg && mapSrc ? mapBgLayer(mapBg, mapSrc) : null,
      h("div.pc-art", { "aria-hidden": "true" }),
      ...peak.inner,
      h(
        "header.pc-head",
        null,
        h("span.pc-mark", { html: LOGO_SVG }),
        h("span.pc-brand", null, "bunnyhop", h("b", null, ".lol")),
        h(
          "span.pc-level",
          { title: `${p.level.xp.toLocaleString("en-US")} XP · ${p.level.into}/${p.level.need} to level ${p.level.level + 1}` },
          h("small", null, "Level"),
          h("b", null, String(p.level.level)),
          h("span.pc-xp", null, h("span", { style: `--f:${p.level.fraction}` })),
        ),
      ),
      h(
        "div.pc-id",
        null,
        avatar,
        h(
          "div.pc-who",
          null,
          // Staff shield, Verified check, Server Booster gem and Supporter badge after the name (in a supporter's name
          // colour); the staff word and the creator tag (icon + "Creator") on the line below. All from the API. The gem
          // and the supporter badge are card parts in edit mode (their switches live under Badges), and so is a supporter's name.
          h(
            "div.pc-nameline",
            // Earlier names (the API's previousNames), shown on hover or focus of the name line (profile.css).
            p.player.previousNames?.length ? { "data-prev": `Previously known as ${p.player.previousNames.join(", ")}`, tabindex: "0" } : null,
            flag,
            h(
              "div.pc-name",
              {
                style: [`--len:${Math.max(6, p.player.name.length + (staff ? 2 : 0) + (p.player.verified ? 2 : 0) + (p.player.booster ? 2 : 0) + (p.player.supporter ? 2 : 0))}`, look.style]
                  .filter(Boolean)
                  .join(";"),
                class: look.class,
                "data-nm-font": look["data-nm-font"],
                // (Everyone's since v0.0.43: a player who isn't a supporter can try the looks on.)
                "data-part": "name",
              },
              p.player.name,
            ),
            nameMarks({ ...p.player, staff }),
          ),
          h(
            "div.pc-line",
            null,
            // Staff badge from the API (the owner: Owner; admins; moderators): a mark clients can't fake.
            staff ? h(`span.pc-staff.${staff}`, null, STAFF_LABEL[staff]) : null,
            h("span.pc-title", { "data-part": "title" }, title),

            // "guest" only while the account is one; how a linked account signs in (Discord, email) is never shown.
            p.player.provider === "guest" ? h("span.pc-prov", null, "guest") : null,
            h("span.pc-since", null, `since ${new Date(p.player.since).getFullYear()}`),
            // Staff viewing someone else's card: "Open in admin" (staff-lens.ts; empty for players).
            adminLink(p.player.id, "pc-admin"),
          ),
        ),
      ),
      h(
        "div.pc-stats",
        null,
        h(
          "div.pc-rank",
          null,
          // (No "Rank" label: the rank's name is the label.)
          h(
            `b.pc-group${rank.group.name.length >= 10 ? ".long" : ""}`,
            null,
            // Holding overall #1 / #2 / #3: the crown the bunny wears (progression.ts crownOf), on the card too.
            // The owner's hat wins over it, like on the bunny (player/bunny/hats.ts headwear).
            hat
              ? h("span.pc-crown.pc-hat", { role: "img", "aria-label": hat.name, title: hat.name, style: `color:${hat.color}`, html: HAT_SVG[hat.id] })
              : rank.rank && rank.rank <= 3
                ? h(`span.pc-crown.t${rank.rank}`, { role: "img", "aria-label": `Holds overall #${rank.rank}`, title: `Holds overall #${rank.rank}`, html: CROWN_SVG })
                : null,
            rank.group.name,
          ),
          h("span.pc-rank-line", null, rank.rank ? `#${rank.rank} · ${topPercent(rank.rank, rank.ranked)}` : "no points yet"),
          h("span.pc-points", null, `${fmtPoints(rank.points)} pts`),
        ),
        h(
          "div.pc-tiers",
          { "aria-label": "Maps cleared per tier" },
          h("small", null, "Clears by tier"),
          h(
            "div.pc-bars",
            null,
            // Seven bars, the last "T7+" holding T7 to T10 (owner, v0.0.37: tiers.ts cardTierCounts).
            ...CARD_TIERS.map((t, i) => {
              const n = clears[i];
              const of = ranked[i];
              // How much of the tier is done (a sliver for any clear, so one T9 shows), full colour once swept. Until
              // v0.0.37 the height was clears over the biggest tier's map count, which left most players' bars empty.
              const done = of ? Math.min(1, n / of) : 0;
              return h(
                `div.pc-bar.t${t}${n ? "" : ".none"}`,
                { title: `${cardTierLabel(t)}: ${n} of ${of} maps` },
                h("span.pc-bar-track", null, h("span.pc-bar-fill", { style: `--f:${n ? Math.max(0.1, done) : 0};--full:${done >= 1 ? 1 : 0}` })),
                h("b", null, String(n)),
                h("small", null, cardTierLabel(t)),
              );
            }),
          ),
        ),
        h(
          "div.pc-recs",
          null,
          // Each count in its own column with its label; longer numbers step down a size so three of them never run
          // together ("102 155 141" read as one number: UI audit, 11-05).
          ...([[s.wrs, "WRs", ".wr", wrsNote()], [s.top10s, "Top 10s", "", null], [s.maps, "Maps", "", null]] as const).map(([n, label, cls, title]) => {
            const v = n.toLocaleString("en-US");
            return h(`div${v.length >= 5 ? ".xl" : v.length >= 3 ? ".l" : ""}`, title ? { title } : null, h(`b${cls}`, null, v), h("small", null, label));
          }),
        ),
      ),
      h(
        "div.pc-feat",
        null,
        ...(featured.length ? featured.map(featTile) : [h("div.pc-feat-empty", null, "No ranked runs yet")]),
      ),
      h("div.pc-badges", { "data-part": "badges" }, ...badges.map(badgeChip), mapBg && mapSrc ? wrLine(mapBg, "pc-wrline", true) : null),
      h(
        "footer.pc-band",
        null,
        h("span", null, h("b", null, s.runs.toLocaleString("en-US")), ` ${countWord(s.runs, "run")}`),
        h("span", null, h("b", null, fmtHours(s.playtime ?? 0)), " played"),
        h("span", null, h("b", null, s.jumps.toLocaleString("en-US")), ` ${countWord(s.jumps, "jump")}`),
        s.replayViews ? h("span", { title: "Views of this player's replays" }, h("b", null, s.replayViews.toLocaleString("en-US")), ` ${countWord(s.replayViews, "replay view")}`) : null,
      ),
      h("div.pc-sheen", { "aria-hidden": "true" }),
      o.enter ? h("div.pc-sweep", { "aria-hidden": "true" }) : null,
    ),
    // The frame's rim (ui/card-fx.css .pc-rim): a lit outer edge and a shaded inner one, over whatever runs in the band.
    h("div.pc-rim", { "aria-hidden": "true" }),
  );
  return card;
}

export function playerCard(p: Profile, o: CardOverrides = {}): HTMLElement {
  const card = buildCard(p, o);
  watchCardFx(card);
  const stage = h(`div.pc-stage${o.enter ? ".pc-enter" : ""}`, null, card);
  tilt(stage, card);
  return stage;
}

/**
 * Redraws a card that is on screen (`stage`: what playerCard returned) for new data or overrides, in place: the new
 * card is built and only its differences are carried onto the old one (morph, below). Whatever didn't change
 * keeps its node, so the avatar isn't loaded and decoded again, the layers that are running don't start over, and the
 * tilt, the pointer light and keyboard focus stay where they are. Use it wherever a card follows a picker (Edit card,
 * the Support page) instead of replacing the card with a new one.
 */
export function updatePlayerCard(stage: HTMLElement, p: Profile, o: CardOverrides = {}): HTMLElement {
  const card = stage.querySelector<HTMLElement>(":scope > .pc");
  if (!card) return stage;
  morph(card, buildCard(p, { ...o, enter: false }), true);
  // Layers may have arrived on a card that had none: the off-screen pause takes it (once more is harmless).
  watchCardFx(card);
  return stage;
}

/** State the page put on a live card, which a redraw must not take away. */
const LIVE_CLASSES = ["is-live", "fx-off"];
const POINTER_LAYER = ".pc-sheen, .pc-holo, .pc-sfx-foil";
const clockOf = (style: string | null): string | null => /--fx-t:[^;]+/.exec(style ?? "")?.[0] ?? null;
const keyOf = (n: Node): string => (n instanceof Element ? `${n.tagName}.${n.classList[0] ?? ""}.${n.getAttribute("data-run") ?? ""}` : `#${n.nodeType}`);

/** Makes `a` (on screen) the same as `b` (just built), touching only what differs and never moving a node that stays. */
function morph(a: Element, b: Element, root = false): void {
  const live = root ? LIVE_CLASSES.filter((c) => a.classList.contains(c)) : [];
  const keepStyle = !root && a.matches(POINTER_LAYER);
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name) && !(keepStyle && name === "style")) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) {
    let v = value;
    if (name === "style") {
      // A running layer keeps the clock it started on (a new delay would jump it), and the card its tilt.
      const was = clockOf(a.getAttribute("style")), now = clockOf(v);
      if (was && now) v = v.replace(now, was);
      const tf = root ? (a as HTMLElement).style.transform : "";
      if (tf) v = `${v};transform:${tf}`;
    }
    if (a.getAttribute(name) !== v) a.setAttribute(name, v);
  }
  for (const c of live) a.classList.add(c);
  // Children: each new one takes the old node of its kind if there is one (tag, first class, run), else itself.
  const olds = [...a.childNodes];
  const used = new Set<Node>();
  const want = [...b.childNodes].map((nb) => {
    const k = keyOf(nb);
    const hit = olds.find((n) => !used.has(n) && keyOf(n) === k);
    if (!hit) return nb;
    used.add(hit);
    if (hit instanceof Element) morph(hit, nb as Element);
    else if (hit.nodeValue !== nb.nodeValue) hit.nodeValue = nb.nodeValue;
    return hit;
  });
  for (const n of olds) if (!used.has(n)) a.removeChild(n);
  // What stayed is still in its old order: only new nodes (and the rare reordered one) are inserted.
  let at: Node | null = a.firstChild;
  for (const n of want) {
    if (n === at) at = at.nextSibling;
    else a.insertBefore(n, at);
  }
}

/**
 * Pointer tilt (max 4°) + sheen, one write per frame; nothing on touch, with reduced motion or on the Potato preset.
 * The pointer's place is taken against the stage's box (never transformed, so the tilt doesn't move its own
 * reference), measured once when the pointer arrives and again only after a scroll or a resize: reading it every frame
 * forced a style and layout pass each time (the card sits in a size container, and its tilt is easing). The tilt is
 * written as the card's transform and the pointer's place on the pointer layers alone (card-fx.ts setPointer): neither
 * restyles the card's content.
 */
const TILT = 4;
function tilt(stage: HTMLElement, card: HTMLElement): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let raf = 0;
  let x = 0;
  let y = 0;
  let box: DOMRect | null = null;
  let watching = false;
  const stale = () => {
    box = null;
    if (!stage.isConnected) unwatch();
  };
  const watch = () => {
    if (watching) return;
    watching = true;
    addEventListener("scroll", stale, { capture: true, passive: true });
    addEventListener("resize", stale, { passive: true });
  };
  const unwatch = () => {
    watching = false;
    removeEventListener("scroll", stale, { capture: true });
    removeEventListener("resize", stale);
  };
  const apply = () => {
    raf = 0;
    box ??= stage.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const px = Math.max(0, Math.min(1, (x - box.left) / box.width));
    const py = Math.max(0, Math.min(1, (y - box.top) / box.height));
    card.style.transform = `rotateX(${((0.5 - py) * 2 * TILT).toFixed(2)}deg) rotateY(${((px - 0.5) * 2 * TILT).toFixed(2)}deg)`;
    setPointer(card, px, py);
  };
  stage.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType === "touch" || document.body.classList.contains("potato")) return;
      x = e.clientX;
      y = e.clientY;
      // will-change only while the pointer is on the card (is-live).
      if (!card.classList.contains("is-live")) {
        card.classList.add("is-live");
        box = null;
        watch();
      }
      raf ||= requestAnimationFrame(apply);
    },
    { passive: true },
  );
  stage.addEventListener("pointerleave", () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    unwatch();
    card.classList.remove("is-live");
    card.style.transform = "";
  });
}

/**
 * The card's WRs: the overall rank's count (apps/api points.ts), so styles worth no overall points (STYLE_WEIGHT 0)
 * don't add to it. Said on hover; the profile's Ranks rows count each style's WRs.
 */
export function wrsNote(): string {
  const own = Object.entries(STYLE_WEIGHT).filter(([, w]) => w === 0).map(([id]) => styleLabel(id));
  const list = own.length > 1 ? `${own.slice(0, -1).join(", ")} and ${own.at(-1)}` : own.join("");
  return `World records in styles that count for the overall rank.${list ? ` ${list} records count on their own style's rank (profile, Ranks).` : ""}`;
}
