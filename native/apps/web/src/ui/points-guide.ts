// What "How points work" (ui/ranks.ts) says, as plain data. DOM-free so a test can hold every number to ranking.ts:
// the dialog can't drift from the rules the API scores with.

import {
  BONUS_MAX_TIER,
  BONUS_TRACK_FACTOR,
  CLEAR_FLOOR,
  CLEAR_TIME,
  CLEAR_WEIGHT,
  LENGTH_DOWN_STEPS,
  LENGTH_REF_JUMPS,
  LENGTH_UP_STEPS,
  lengthFactorFor,
  lengthStep,
  PLACEMENT_WEIGHT,
  PLAYERS_POWER,
  RANK_GROUPS,
  RECORD_WEIGHTING,
  STYLE_MAX_TIER,
  STYLE_WEIGHT,
  TIER_BASE,
  TOP_PLACES,
  WR_FULL_PLAYERS,
} from "../ranking";
import { STYLE_DEFS, styleLabel } from "../styles";
import { tierLabel, type Tier } from "../tiers";

export interface PointsGuide {
  /** The three paragraphs above the tables: a record's points (with map length), styles (with their tier caps), the total. */
  intro: string[];
  /** Tier, base points; then what gives none. */
  tiers: [string, string][];
  /** Style, its weight in the Overall rank; heaviest first, the styles ranked only on their own board last. */
  styles: [string, string][];
  /** Rank title, its colour, what it takes. */
  ladder: { name: string; color: string; needs: string }[];
  /** The exact rules, for the dialog's last section. */
  exact: string[];
}

const n = (v: number) => v.toLocaleString("en-US");
const pct = (factor: number) => `${Math.round(Math.abs(factor - 1) * 100)}%`;

/** The length factor (ranking.ts lengthFactorFor) in the dialog's words: where it starts and how far it goes either way. */
function lengthRule(): { from: Tier; most: number; least: number; step: number; maxStep: number; maxFrom: Tier } {
  const tiers = Object.keys(TIER_BASE).map(Number) as Tier[];
  const longest = (t: Tier) => lengthFactorFor(t, LENGTH_REF_JUMPS[t] * 2 ** LENGTH_UP_STEPS);
  const shortest = (t: Tier) => lengthFactorFor(t, LENGTH_REF_JUMPS[t] / 2 ** LENGTH_DOWN_STEPS);
  const from = tiers.find((t) => lengthStep(t) > 0)!;
  const maxStep = Math.max(...tiers.map(lengthStep));
  return { from, most: Math.max(...tiers.map(longest)), least: Math.min(...tiers.map(shortest)), step: lengthStep(from), maxStep, maxFrom: tiers.find((t) => lengthStep(t) === maxStep)! };
}

export function pointsGuide(): PointsGuide {
  const weighted = STYLE_DEFS.filter((d) => (STYLE_WEIGHT[d.id] ?? 0) > 0).sort((a, b) => STYLE_WEIGHT[b.id] - STYLE_WEIGHT[a.id]);
  const own = STYLE_DEFS.filter((d) => STYLE_WEIGHT[d.id] === 0);
  const len = lengthRule();
  const capped = Object.entries(STYLE_MAX_TIER).map(([id, cap]) => ` ${styleLabel(id)} runs are scored as ${tierLabel(cap)} at most, whatever the map's tier.`);
  return {
    intro: [
      "Every verified personal best on a tiered map scores points: some for finishing, more for a fast time and more for every player you beat." +
        ` From ${tierLabel(len.from)} up, a map that takes more jumps than is usual for its tier pays up to ${pct(len.most)} more, and a very short one up to ${pct(len.least)} less.`,
      `The Overall rank counts every style at its weight, and each style has a board of its own.${capped.join("")}`,
      `Your total adds your records best first, each worth ${RECORD_WEIGHTING}× the one before, so a strong set of records beats grinding easy maps.`,
    ],
    tiers: [
      ...Object.entries(TIER_BASE).map(([t, v]): [string, string] => [tierLabel(Number(t)), n(v)]),
      ["No tier", "0"],
      ["Bonus track", BONUS_MAX_TIER >= 1 ? `×${BONUS_TRACK_FACTOR}, as T${BONUS_MAX_TIER} at most` : "0"],
    ],
    styles: [...weighted.map((d): [string, string] => [d.name, `×${STYLE_WEIGHT[d.id]}`]), ...own.map((d): [string, string] => [d.name, "Own board only"])],
    ladder: RANK_GROUPS.map((g) => {
      const place = g.maxRank === 1 ? "#1" : g.maxRank ? `Top ${g.maxRank}` : g.top! < 1 ? `Top ${Math.round(g.top! * 100)}%` : "Everyone else";
      return { name: g.name, color: g.color, needs: g.minPoints >= 1 ? `${place} with ${n(g.minPoints)} points` : place };
    }),
    exact: [
      `Clear = ${CLEAR_WEIGHT} × base × (${CLEAR_FLOOR} + ${CLEAR_TIME} × (WR time ÷ your time)²)`,
      `Placement = ${PLACEMENT_WEIGHT} × √(base ÷ 10) × ((players ÷ place)^${PLAYERS_POWER} − 1) × (1 + 1 ÷ place)`,
      `A record scores clear plus placement. A WR pays 2× second place from ${WR_FULL_PLAYERS} players up and less on smaller boards. Alone on a board you get the clear only.`,
      `Length moves a main-track record up or down part of a tier: ${len.step} of a tier at ${tierLabel(len.from)} for each doubling of the map's jumps over what is usual for its tier, rising to ${len.maxStep} from ${tierLabel(len.maxFrom)}, for at most ${LENGTH_UP_STEPS} doublings up and ${LENGTH_DOWN_STEPS} down.`,
      `Past the top ${TOP_PLACES}, players and places round to small steps, so your points move when you cross a step.`,
      "Your own points and rank update as soon as your run is verified. Everyone else on that board follows within about 10 minutes, or an hour on the biggest maps.",
    ],
  };
}
