// The case view's "Why" line: which rule set a flag's score, by name, and one sentence on what it catches. The score
// is 1 - Π(1 - weight) over the scored rules (apps/api src/integrity-rules.ts), and any blatant rule makes it 100, so
// a 100 on a slow new player is a tool catch, not a skill reading. Only rules that can score are listed (review-only
// notes never set a score); any other code reads as its code. Staff only. Kinds: tool (a script or a modified client,
// whatever the player's skill), skill (numbers past every measured human), clock (the game ran at the wrong speed).

import type { Evidence } from "./cases";

export type RuleKind = "tool" | "skill" | "clock";

export const RULE_WORDS: Record<string, { name: string; line: string; kind: RuleKind }> = {
  "key-sync": { name: "Key script", line: "The keys switch at one fixed offset from the mouse turning, nearly every time. Mouse-to-key scripts do this.", kind: "tool" },
  "key-sync-share": { name: "Key script", line: "Most key switches land at one fixed offset from the mouse turning, more than any hand.", kind: "tool" },
  "key-follows-mouse": { name: "Keys follow the mouse", line: "The keys never switch before the mouse turns. Hands switch early; a script reacting to the mouse can't.", kind: "tool" },
  "style-key-sync": { name: "Key script", line: "On this style's keys, the switches land at one fixed offset from the mouse turning.", kind: "tool" },
  "bw-key-sync": { name: "Key script", line: "Facing back, the switches land at one fixed offset from the mouse turning.", kind: "tool" },
  "strafe-rate": { name: "Key spam", line: "More A/D switches per second than a hand can press.", kind: "tool" },
  "style-strafe-rate": { name: "Key spam", line: "More switches per second on this style's keys than a hand can press.", kind: "tool" },
  "bw-strafe-rate": { name: "Key spam", line: "More switches per second than a hand can press.", kind: "tool" },
  "perfect-angle": { name: "Strafe hack", line: "The movement is held exactly square to the velocity far more often than any hand manages.", kind: "tool" },
  "aim-lock": { name: "Aim lock", line: "The view stays locked to the best strafe angle more tightly than any hand.", kind: "tool" },
  "aim-lock-band": { name: "Aim lock", line: "The view stays locked to the best strafe angle about as tightly as an assist.", kind: "tool" },
  "style-aim-lock": { name: "Aim lock", line: "On this style, the view stays locked to the best strafe angle more tightly than any hand.", kind: "tool" },
  "adonly-aim-lock": { name: "Aim lock", line: "On A/D-Only, the view stays locked to the best strafe angle more tightly than any hand.", kind: "tool" },
  "bw-aim-lock": { name: "Aim lock", line: "Facing back, the view stays locked to the best strafe angle more tightly than any hand.", kind: "tool" },
  "aim-response": { name: "Instant aim", line: "The turn corrects the aim error on the same tick, faster than hands react.", kind: "tool" },
  "forged-commands": { name: "Modified client", line: "The replay has commands the game's own input can't produce.", kind: "tool" },
  "input-reuse": { name: "Copied input", line: "Stretches of input match another run's exactly. No two hands ever repeat these.", kind: "tool" },
  "no-counted-yaw": { name: "Turns without the mouse", line: "The view turned without the mouse counts that should have turned it.", kind: "tool" },
  "yaw-unexplained": { name: "Turns without the mouse", line: "View turns that neither the mouse nor a turn bind explains.", kind: "tool" },
  "turn-no-event": { name: "Turns without the mouse", line: "The mouse counts changed with no mouse event the page saw.", kind: "tool" },
  "constant-turn": { name: "Scripted turning", line: "The same yaw change many ticks in a row, longer than any hand holds it.", kind: "tool" },
  "off-grid": { name: "Scripted turning", line: "The yaw changes aren't whole mouse counts: the view wasn't turned by a mouse.", kind: "tool" },
  "gain": { name: "Gain", line: "Air gain over the whole run above every hand-strafed run measured.", kind: "skill" },
  "gain-window": { name: "Gain over 6 jumps", line: "Six jumps in a row above every hand-strafed run measured, as an optimizer switched on for a few jumps reads.", kind: "skill" },
  "angle-near": { name: "Strafe angle", line: "The movement is near square to the velocity more often than hands manage.", kind: "skill" },
  "angle-exact": { name: "Strafe angle", line: "The movement is exactly square to the velocity more often than hands manage.", kind: "skill" },
  "angle-streak": { name: "Strafe angle", line: "Square to the velocity for more ticks in a row than hands manage.", kind: "skill" },
  "style-gain": { name: "Gain", line: "Air gain over the run above every human run on this style.", kind: "skill" },
  "style-gain-window": { name: "Gain over 6 jumps", line: "Six jumps in a row above every human run on this style.", kind: "skill" },
  "nulls": { name: "Instant switches", line: "Key switches with no overlap or gap at all, as snap tap or null binds make them.", kind: "skill" },
  "clock": { name: "Slowed game", line: "The run advanced slower than real time: a slowed-down game or a hooked timer.", kind: "clock" },
  "clock-pace": { name: "Game speed", line: "The run's heartbeats say the game ran slower than real time.", kind: "clock" },
  "clock-skew": { name: "Game speed", line: "The client's own clocks disagree with real time.", kind: "clock" },
};

const KIND_NOTE: Record<RuleKind, string> = {
  tool: "It looks for a tool, not skill, so a slow run can still carry it.",
  skill: "It reads how good the strafing is, so strong players come near it.",
  clock: "It looks at the game's speed, not the movement.",
};

/** The rule that set the score (a blatant one first, else the heaviest scored one), or null when nothing scored. */
export function scoringRule(evidence: readonly Evidence[]): Evidence | null {
  const blatant = evidence.find((e) => e.blatant);
  if (blatant) return blatant;
  return evidence.filter((e) => !e.review).sort((a, b) => b.weight - a.weight)[0] ?? null;
}

/** "Key script (key-sync). The keys switch at one fixed offset ... It looks for a tool, not skill, ..." */
export function whyText(e: Evidence): string {
  const w = RULE_WORDS[e.code];
  if (!w) return `${e.code}. ${e.blatant ? "A blatant rule: the score is 100." : "Read the evidence below."}`;
  return `${w.name} (${e.code}). ${w.line} ${KIND_NOTE[w.kind]}`;
}

/** The score's title: what the number means. */
export const SCORE_TITLE = "0 to 100 from the scored rules together; any blatant rule makes it 100. Not a probability.";
