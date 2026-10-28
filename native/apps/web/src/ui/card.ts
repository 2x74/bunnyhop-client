import { countryFlag } from "./country-flag";
// Player card (profile hero, card editor preview). Borrowed from Aimperion's ID-card layout (cut corners, container
// units so it scales as one piece, 6° tilt + pointer sheen, off for touch / reduced motion) and hatchdle's card
// (frame band + background cosmetics, featured items, three badge chips, automatic picks when nothing is chosen).
// Styles: ui/profile.css (.pc-*).

import type { CosmeticChoice, Profile, RunCard } from "../api";
import { cosmetic, DEFAULT_COSMETICS } from "../progression";
import { STAFF_LABEL, staffBadgeOf, type NameLook } from "../creators";
import { fmtPoints, topPercent } from "../ranking";
import { styleLabel } from "../styles";
import { tierLabel, TIERS } from "../tiers";
import { formatTime } from "../timer";
import { trackName } from "../zones";
import { badgeChip } from "./badges";
import { LOGO_SVG } from "./brand";
import { avatarImg, pictureOf } from "./avatar";
import { h } from "./dom";
import { nameAttrs, nameMarks } from "./marks";
import { adminLink } from "../staff-lens";


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
};

export interface CardOverrides {
  cosmetics?: CosmeticChoice;
  /** A supporter's name colour being previewed in Edit card (undefined: the profile's own). */
  nameLook?: NameLook;
  badges?: string[];
  featured?: RunCard[];
  /** The card's first appearance on a screen: it rises in and a sheen sweeps across it once. */
  enter?: boolean;
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

function featTile(r: RunCard): HTMLElement {
  const place = r.rank === 1 ? h("span.pc-place.wr", null, "WR") : r.rank ? h("span.pc-place", null, `#${r.rank}`) : null;
  const tags = [r.track ? trackName(r.track) : null, r.style !== "autohop" ? styleLabel(r.style) : null, viewsLabel(r.views)].filter(Boolean).join(" · ");
  return h(
    `div.pc-feat-tile.t${r.tier ?? "x"}`,
    { "data-run": r.runId, title: "Show in the list" },
    h("div.pc-feat-top", null, h(`span.pc-tier.t${r.tier ?? "x"}`, null, tierLabel(r.tier)), place),
    h("div.pc-feat-map", null, r.map.replace(/^bhop_/, "")),
    h("div.pc-feat-time", null, formatTime(r.time)),
    tags ? h("div.pc-feat-tag", null, tags) : null,
  );
}

export function playerCard(p: Profile, o: CardOverrides = {}): HTMLElement {
  const c = { ...DEFAULT_COSMETICS, ...p.cosmetics, ...o.cosmetics };
  const hatDef = cosmetic(c.hat);
  const hat = hatDef?.slot === "hat" && HAT_SVG[hatDef.id] ? hatDef : null;
  const badges = o.badges ?? p.badges;
  const featured = (o.featured ?? p.featured).slice(0, 3);
  const rank = p.rank;
  const s = p.stats;
  const title = displayTitle(p, c);
  const maxClears = Math.max(1, ...TIERS.map((t) => s.rankedByTier[t] ?? 0));
  // The staff badge (older APIs: from the role).
  const staff = p.player.staff !== undefined ? p.player.staff : staffBadgeOf(p.role);
  /** A supporter's name look (Edit card → Name previews over what's saved). */
  const look = nameAttrs({ nameColor: p.player.nameColor, nameEffect: p.player.nameEffect, nameColor2: p.player.nameColor2, ...o.nameLook });

  // data-part: the parts the owner's card editor picks by clicking them (ui/profile.ts).
  const card = h(
    `div.pc.pc-frame-${(c.frame ?? "frame-plain").replace(/^frame-/, "")}.pc-bg-${(c.background ?? "bg-night").replace(/^bg-/, "")}`,
    { style: `--rank:${rank.group.color}`, "data-part": "frame" },
    h(
      "div.pc-inner",
      { "data-part": "background" },
      h("div.pc-art", { "aria-hidden": "true" }),
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
        avatarEl(p.player),
        h(
          "div.pc-who",
          null,
          // Staff shield, Verified check, Server Booster gem and Supporter badge after the name (in a supporter's name
          // colour); the staff word and the creator tag (icon + "Creator") on the line below. All from the API. The gem
          // and the supporter badge are card parts in edit mode (their switches live under Badges), and so is a supporter's name.
          h(
            "div.pc-nameline",
            null,
            countryFlag(p.player.country),
            h(
              "div.pc-name",
              {
                style: [`--len:${Math.max(6, p.player.name.length + (staff ? 2 : 0) + (p.player.verified ? 2 : 0) + (p.player.booster ? 2 : 0) + (p.player.supporter ? 2 : 0))}`, look.style]
                  .filter(Boolean)
                  .join(";"),
                class: look.class,
                "data-part": p.supporterSettings ? "name" : undefined,
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
            "b.pc-group",
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
            ...TIERS.map((t) => {
              const n = s.clearsByTier[t] ?? 0;
              const of = s.rankedByTier[t] ?? 0;
              return h(
                `div.pc-bar.t${t}`,
                { title: `T${t}: ${n}/${of} maps` },
                h("span.pc-bar-track", null, h("span.pc-bar-fill", { style: `--f:${of ? n / maxClears : 0};--full:${of ? Math.min(1, n / of) : 0}` })),
                h("b", null, String(n)),
                h("small", null, `T${t}`),
              );
            }),
          ),
        ),
        h(
          "div.pc-recs",
          null,
          h("div", null, h("b.wr", null, String(s.wrs)), h("small", null, "WRs")),
          h("div", null, h("b", null, String(s.top10s)), h("small", null, "Top 10s")),
          h("div", null, h("b", null, String(s.maps)), h("small", null, "Maps")),
        ),
      ),
      h(
        "div.pc-feat",
        null,
        ...(featured.length ? featured.map(featTile) : [h("div.pc-feat-empty", null, "No ranked runs yet")]),
      ),
      h("div.pc-badges", { "data-part": "badges" }, ...badges.map(badgeChip)),
      h(
        "footer.pc-band",
        null,
        h("span", null, h("b", null, s.runs.toLocaleString("en-US")), " runs"),
        h("span", null, h("b", null, fmtHours(s.playtime ?? 0)), " played"),
        h("span", null, h("b", null, s.jumps.toLocaleString("en-US")), " jumps"),
        s.replayViews ? h("span", { title: "Views of this player's replays" }, h("b", null, s.replayViews.toLocaleString("en-US")), " replay views") : null,
      ),
      h("div.pc-sheen", { "aria-hidden": "true" }),
      o.enter ? h("div.pc-sweep", { "aria-hidden": "true" }) : null,
    ),
  );
  const stage = h(`div.pc-stage${o.enter ? ".pc-enter" : ""}`, null, card);
  tilt(stage, card);
  return stage;
}

/** Pointer tilt (max 4°) + sheen, one write per frame; nothing on touch, with reduced motion or on the Potato preset. */
const TILT = 4;
function tilt(stage: HTMLElement, card: HTMLElement): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let raf = 0;
  let px = 0.5;
  let py = 0.5;
  const apply = () => {
    raf = 0;
    card.style.setProperty("--rx", `${(0.5 - py) * 2 * TILT}deg`);
    card.style.setProperty("--ry", `${(px - 0.5) * 2 * TILT}deg`);
    card.style.setProperty("--mx", String(px));
    card.style.setProperty("--my", String(py));
  };
  stage.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" || document.body.classList.contains("potato")) return;
    const r = card.getBoundingClientRect();
    px = (e.clientX - r.left) / r.width;
    py = (e.clientY - r.top) / r.height;
    // will-change only while the pointer is on the card (is-live).
    card.classList.add("is-live");
    raf ||= requestAnimationFrame(apply);
  });
  stage.addEventListener("pointerleave", () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    card.classList.remove("is-live");
    card.style.setProperty("--rx", "0deg");
    card.style.setProperty("--ry", "0deg");
  });
}
