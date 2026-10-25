// Staff / Verified / Creator / Server Booster marks next to a name, and profile link chips (rules + icon geometry:
// ../creators.ts). The marks only ever come from the server (API player objects, the room roster and chat lines); this
// file just draws them. Styles: ./marks.css.

import "./marks.css";
import {
  equippedNameBadges, GIFTER_TIERS, GIFTER_SVG, isGifterColor, SPECIAL_BADGES,
  BOOSTER_LABEL,
  BOOSTER_SVG,
  CREATOR_LABEL,
  CREATOR_SVG,
  nameEffectOf,
  nameColorHex,
  PLATFORM_NAME,
  STAFF_LABEL,
  STAFF_SVG,
  SUPPORTER_LABEL,
  SUPPORTER_SVG,
  VERIFIED_SVG,
  type LinkPlatform,
  type NameLook,
  type PlayerMarks,
  type ProfileLink,
  type StaffBadge,
} from "../creators";
import { h } from "./dom";

const svg = (inner: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${inner}</svg>`;

export const VERIFIED_TITLE = "Verified: this is really them";

/** The staff shield: Owner, Admin or Moderator. */
export function staffMark(b: StaffBadge): HTMLElement {
  return h(`span.nm-staff.${b}`, { role: "img", "aria-label": STAFF_LABEL[b], title: STAFF_LABEL[b], html: svg(STAFF_SVG[b]) });
}

/** The blue check. */
export function verifiedMark(): HTMLElement {
  return h("span.nm-verified", { role: "img", "aria-label": "Verified", title: VERIFIED_TITLE, html: svg(VERIFIED_SVG) });
}

/** The Server Booster gem (boosting the bunnyhop.lol Discord server). */
export function boosterMark(): HTMLElement {
  return h("span.nm-booster", { role: "img", "aria-label": BOOSTER_LABEL, title: BOOSTER_LABEL, html: svg(BOOSTER_SVG) });
}

/** The Supporter badge (supported bunnyhop.lol; creators.ts SUPPORTER_BADGE). */
export function supporterMark(): HTMLElement {
  return h("span.nm-supporter", { role: "img", "aria-label": SUPPORTER_LABEL, title: SUPPORTER_LABEL, html: svg(SUPPORTER_SVG) });
}

/** The default name white (what a supporter's effect wears without a picked colour). */
const NAME_WHITE = "#eef1f6";

/**
 * A supporter's name look as attributes for the name element: the colour (and the second colour) as an inline style
 * and custom properties, the effect as a class (marks.css .nm-fx-*). Every value is a known id mapped to our own hex,
 * so nothing from the server reaches a style unchecked. `fallback`: a colour for names without a look (chat's slot
 * colour). Spread into h(): h("b.name", nameAttrs(p), p.name).
 */
export function nameAttrs(m: NameLook | null | undefined, fallback?: string): { style?: string; class?: string } {
  const c = nameColorHex(m?.nameColor);
  const fx = nameEffectOf(m?.nameEffect);
  if (!c && !fx) return fallback ? { style: `color:${fallback}` } : {};
  const base = c ?? NAME_WHITE;
  const c2 = nameColorHex(m?.nameColor2);
  return { style: `color:${base};--nm-c:${base}${c2 ? `;--nm-c2:${c2}` : ""}`, class: fx ? `nm-fx nm-fx-${fx}` : undefined };
}

/** The colour part of nameAttrs alone, for a style list (undefined: the default white). */
export const nameStyle = (m: NameLook | null | undefined): string | undefined => nameAttrs(m).style;

/**
 * Staff shield + check + creator icon + booster gem + supporter badge after a name, in that order (null when
 * there's nothing to show). label: also write "Creator" after the creator icon (profile card); everywhere else the
 * icon alone, with the platform in its tooltip.
 */
export function nameMarks(m: PlayerMarks | null | undefined, o: { label?: boolean } = {}): HTMLElement | null {
  if (!m) return null;
  const ids = equippedNameBadges(m);
  return ids.length ? h("span.nm-marks", null, ...ids.map(id => {
    if (id === "staff") return staffMark(m.staff!);
    if (id === "verified") return verifiedMark();
    if (id === "booster") return boosterMark();
    if (id === "supporter") return supporterMark();
    if (id === "creator") return h(`span.nm-creator.${m.creator}${o.label ? ".labelled" : ""}`, { role: "img", "aria-label": CREATOR_LABEL[m.creator!], title: CREATOR_LABEL[m.creator!] }, h("span.nm-icon", { html:svg(CREATOR_SVG[m.creator!]) }), o.label ? h("span.nm-label",null,"Creator") : null);
    const special = SPECIAL_BADGES[id];
    if (special) {
      // Gold ones shine like Gold Gifter: a glint cut to the icon's own shape (marks.css .nm-special.gold).
      const mask = special.gold ? `--mask:url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${special.svg}</svg>`)}")` : undefined;
      return h(`span.nm-special.${id}${special.gold ? ".gold" : ""}`, { role: "img", "aria-label": special.name, title: special.name, style: mask, html: svg(special.svg) });
    }
    const tier = GIFTER_TIERS.find(t => t.id === id);
    if (!tier) return null;
    const colors = tier.goal === 100 ? (m.gifterColors?.filter(isGifterColor)?.length ? m.gifterColors.filter(isGifterColor) : ["#b98cff", "#7fcfff", "#ffb9db"]) : undefined;
    const color = colors?.[0] ?? tier.color;
    return h(`span.nm-gifter.${id}${m.gifterAnimated !== false && (colors?.length ?? 2) > 1 ? ".animated" : ""}`, { role: "img", "aria-label": tier.name, title: tier.name, style: `color:${color};--gift-a:${color};--gift-b:${colors?.[1] ?? "#7fcfff"};--gift-c:${colors?.[2] ?? color}`, html: svg(GIFTER_SVG) });
  })) : null;
}

/** Monochrome glyphs for the link chips (YouTube / Twitch use their mark colours). */
const LINK_SVG: Record<LinkPlatform, string> = {
  youtube: CREATOR_SVG.youtube,
  twitch: CREATOR_SVG.twitch,
  x: `<path d="M4 3.5h4.3l4 5.5 4.8-5.5h2.6l-6.2 7.1 6.9 9.9h-4.3l-4.4-6.1-5.4 6.1H3.7l6.6-7.6z" fill="currentColor"/>`,
  tiktok: `<path d="M13.6 3h3.1c.3 2.1 1.7 3.6 3.9 3.9v3.1c-1.5 0-2.8-.4-3.9-1.1v6.3a5.8 5.8 0 1 1-5.8-5.8h.6v3.1h-.6a2.7 2.7 0 1 0 2.7 2.7z" fill="currentColor"/>`,
};

export function linkIcon(p: LinkPlatform): HTMLElement {
  return h(`span.lk-icon.${p}`, { html: svg(LINK_SVG[p]) });
}

/** The links a profile shows: one chip each, opening in a new tab, never passing ranking signals. */
export function linkChips(links: ProfileLink[] | undefined): HTMLElement | null {
  if (!links?.length) return null;
  return h(
    "div.lk-chips",
    { "aria-label": "Links" },
    ...links.map((l) =>
      h("a.lk-chip", { href: l.url, target: "_blank", rel: "nofollow ugc noopener", title: `${PLATFORM_NAME[l.platform]}: ${l.label}` }, linkIcon(l.platform), h("span", null, l.label)),
    ),
  );
}
