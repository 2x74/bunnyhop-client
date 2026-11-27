import { GIFTER_SVG } from "./creators";
import { TIERS, tierLabel } from "./tiers";
const P = (d: string) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
export const textGlyph = (s: string, size = 9) => `<text x="12" y="15.5" text-anchor="middle" font-size="${size}" font-weight="800" fill="currentColor" font-family="ui-sans-serif, system-ui, sans-serif">${s}</text>`;

export const GLYPHS: Record<string, string> = {
  gift: GIFTER_SVG,
  flag: P("M6 21V4h11l-2.5 3.5L17 11H6"),
  map: P("M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14"),
  pb: P("M12 8v5l3 2M9 2h6M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z"),
  podium: P("M3 20h18M5 20v-6h4v6M10 20V9h4v11M15 20v-8h4v8"),
  crown: P("M3 8l4.5 4L12 5l4.5 7L21 8l-2 10H5z"),
  bonus: P("M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"),
  scroll: P("M12 3a6 6 0 0 1 6 6v6a6 6 0 0 1-12 0V9a6 6 0 0 1 6-6zM12 7v4"),
  w: textGlyph("W", 11),
  sw: textGlyph("SW", 9),
  hsw: textGlyph("HSW", 7.5),
  ad: textGlyph("AD", 9.5),
  bw: textGlyph("BW", 9),
  styles: P("M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"),
  clock: P("M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z"),
  sync: P("M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4"),
  jump: P("M3 18q3-7 6 0q4-11 8 0") + `<circle cx="19.5" cy="18" r="1.8" fill="currentColor"/>`,
  level: P("M6 14l6-6 6 6M6 20l6-6 6 6"),
  // Two hoppers side by side (Play with the Owner).
  together: P("M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 20a6 6 0 0 1 12 0M16 11a2.6 2.6 0 1 0 0-5.2M17.5 14.3A5.5 5.5 0 0 1 21.5 20"),
  // Community rewards (progression.ts DISCORD_LINK, DISCORD_MEMBER, DISCORD_BOOSTER, EARLY_HOPPER): two chain links; a
  // bunny's ears poking out of a burrow; a sparkle; a sprout. Our own marks, never Discord's logo.
  link: P("M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"),
  burrow: P("M2.5 20h19M4.5 20a7.5 7.5 0 0 1 15 0M9 20a3 3 0 0 1 6 0M10.6 17.2 9.8 12.6M13.4 17.2l.8-4.6"),
  spark: P("M12 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7zM18.5 16.5c.2 1.4.8 2 2.2 2.2-1.4.2-2 .8-2.2 2.2-.2-1.4-.8-2-2.2-2.2 1.4-.2 2-.8 2.2-2.2z"),
  // Supporter (progression.ts SUPPORTER): a heart, like the badge (creators.ts SUPPORTER_BADGE).
  heart: P("M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"),
  crystal: P("M12 2.5 17 7.6 16.3 17.6 12 21.5 7.7 17.6 7 7.6zM7 7.6l3.4 1.3h3.2L17 7.6M10.4 8.9l.2 9.6L12 21.5M13.6 8.9l-.2 9.6L12 21.5M12 2.5l-1.6 6.4M12 2.5l1.6 6.4"),
  sprout: P("M12 21v-9M12 12c0-3.6-2.6-6-6.5-6 0 3.6 2.6 6 6.5 6zM12 10c0-3.4 2.4-5.6 6.2-5.6 0 3.4-2.4 5.6-6.2 5.6z"),
  // Beat the Mapper (progression.ts BEAT_MAPPER): a block, like the Mapper badge,.
  mapper: P("M12 3.5 19 7.5v9l-7 4-7-4v-9zM5 7.5l7 4 7-4M12 11.5v9"),
  // Batch 1 (progression.ts): !race (two arrows passing), Halloween (a pumpkin).
  race: P("M4 7h13M13 3l4 4-4 4M20 17H7M11 13l-4 4 4 4"),
  // Winter (progression.ts winter_5 / winter_10): a six-armed snowflake, each arm with one pair of short branches.
  snowflake: P("M12 2.5v19M3.77 7.25l16.46 9.5M3.77 16.75l16.46-9.5M10.13 4.32L12 6.4l1.87-2.08M17.71 6.54l-.86 2.66 2.74.58M19.59 14.22l-2.74.58.86 2.66M13.87 19.68L12 17.6l-1.87 2.08M6.29 17.46l.86-2.66-2.74-.58M4.41 9.78l2.74-.58-.86-2.66"),
  pumpkin: P("M12 7c-5 0-8 3-8 7s3 7 8 7 8-3 8-7-3-7-8-7zM12 7c-2.2 2.5-2.2 11.5 0 14M12 7c2.2 2.5 2.2 11.5 0 14M12 7V4c1.2 0 2.2.5 2.8 1.3"),
  // True Architect (progression.ts TRUE_ARCHITECT, bhop_lol_backrooms): a set square with its ruler ticks.
  architect: P("M4 20V4l16 16zM8 16v-4.4l4.4 4.4zM4 8h2.5M4 12h1.6M8 20v-2M12 20v-1.6"),
  // The secret (progression.ts WINGS): a small wing, feathers sweeping back from a heel.
  wing: P("M5 18c1-6 5-10 14-12-2 3-4.5 4.4-7.5 5 3 .2 5 .9 6.5 2-3 2.3-6.6 3.2-10.5 2.6M5 18h4"),
  // Gauntlets (progression.ts GAUNTLET_ACHIEVEMENTS), one glyph each (alternatives: tools/gauntlets/mark-options.ts).
  // A route from a start dot to a finish flag; maps stacked up; MINI; a grid of maps, the last one ticked; podium
  // steps with a 1; a calendar page with a 1; 20; an hourglass.
  // The Daily Challenge (progression.ts DAILY_ACHIEVEMENTS): a sun; a sun rising over the days finished; the two effort
  // ones; podium steps under a sun; a sun with the wins in it.
  d_sun: P("M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6") + `<circle cx="12" cy="12" r="4.4" fill="currentColor"/>`,
  d_5: P("M7 8.2a5 5 0 0 1 10 0M12 1.6v1.4M5.6 3.6l1 1M18.4 3.6l-1 1") + `<text x="12" y="20.6" text-anchor="middle" font-size="10.5" font-weight="800" fill="currentColor" font-family="ui-sans-serif, system-ui, sans-serif">5</text>`,
  d_15: P("M7 8.2a5 5 0 0 1 10 0M12 1.6v1.4M5.6 3.6l1 1M18.4 3.6l-1 1") + `<text x="12" y="20.6" text-anchor="middle" font-size="10.5" font-weight="800" fill="currentColor" font-family="ui-sans-serif, system-ui, sans-serif">15</text>`,
  d_30: P("M7 8.2a5 5 0 0 1 10 0M12 1.6v1.4M5.6 3.6l1 1M18.4 3.6l-1 1") + `<text x="12" y="20.6" text-anchor="middle" font-size="10.5" font-weight="800" fill="currentColor" font-family="ui-sans-serif, system-ui, sans-serif">30</text>`,
  d_60: P("M7 8.2a5 5 0 0 1 10 0M12 1.6v1.4M5.6 3.6l1 1M18.4 3.6l-1 1") + `<text x="12" y="20.6" text-anchor="middle" font-size="10.5" font-weight="800" fill="currentColor" font-family="ui-sans-serif, system-ui, sans-serif">60</text>`,
  d_100: P("M7 8.2a5 5 0 0 1 10 0M12 1.6v1.4M5.6 3.6l1 1M18.4 3.6l-1 1") + `<text x="12" y="20.6" text-anchor="middle" font-size="9" font-weight="800" fill="currentColor" font-family="ui-sans-serif, system-ui, sans-serif">100</text>`,
  // Second Wind: a sun with an arrow turning back up to it. Upper Half: a board's rows, the top half filled.
  d_better: P("M5 16.5a8 8 0 0 1 13-6.2M18.5 5.5v5h-5") + `<circle cx="9.5" cy="16.5" r="2.6" fill="currentColor"/>`,
  d_half: P("M4 15.5h16M4 19.5h16") + `<path d="M4 4.2h16v3H4zM4 9.2h16v3H4z" fill="currentColor"/>`,
  d_podium: P("M3 20.5h18M4 20.5v-4.5h5.3v4.5M9.3 20.5v-8h5.4v8M14.7 20.5v-6H20v6") + `<circle cx="12" cy="6" r="2.6" fill="currentColor"/>`,
  d_win: P("M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M12 6.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6z") + `<text x="12" y="14.9" text-anchor="middle" font-size="8" font-weight="800" fill="currentColor" font-family="ui-sans-serif, system-ui, sans-serif">1</text>`,
  d_10: P("M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M12 6.2a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6z") + `<text x="12" y="14.4" text-anchor="middle" font-size="6.4" font-weight="800" fill="currentColor" font-family="ui-sans-serif, system-ui, sans-serif">10</text>`,
  g_route: P("M4.5 19.5c4 0 4-6 8-6 2 0 3.5-1 3.5-3M16 10V3.5l4.5 2.2L16 8") + `<circle cx="4.5" cy="19.5" r="1.8" fill="currentColor"/>`,
  g_stack: P("M12 3.5 3.5 8 12 12.5 20.5 8zM3.5 12 12 16.5 20.5 12M3.5 16 12 20.5 20.5 16"),
  g_mini: textGlyph("MINI", 7.4),
  g_every: P("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14.2 17.2l2.1 2.1 4-4.4"),
  g_podium: P("M3 20.5h18M4 20.5v-5h5.3v5M9.3 20.5V10h5.4v10.5M14.7 20.5v-7.5H20v7.5") + `<text x="12" y="8.6" text-anchor="middle" font-size="6.5" font-weight="800" fill="currentColor" font-family="ui-sans-serif, system-ui, sans-serif">1</text>`,
  g_weekly: P("M4 6h16v14.5H4zM8 3.5v4.5M16 3.5v4.5") + `<text x="12" y="18.2" text-anchor="middle" font-size="9.5" font-weight="800" fill="currentColor" font-family="ui-sans-serif, system-ui, sans-serif">1</text>`,
  g20: textGlyph("20", 10),
  g_hourglass: P("M7 3.5h10M7 20.5h10M8 3.5c0 5 8 5.5 8 8.5s-8 3.5-8 8.5M16 3.5c0 5-8 5.5-8 8.5s8 3.5 8 8.5"),
};
for (const t of TIERS) GLYPHS[`t${t}`] = textGlyph(tierLabel(t), t >= 10 ? 8 : 10);

