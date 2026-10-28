// Chat masking with the same normaliser and blocklist as display names (apps/api/src/rooms/chat.ts builds the room's
// filter from this). Words that hit are replaced with asterisks of the same length; the rest of the line is untouched.
//
// Levels (wrangler var CHAT_FILTER):
//   "standard" (default): hate terms and slurs, sexual terms.
//   "strict": also everyday profanity and every LDNOOBW word / phrase.
//   "off": nothing (the CHAT_BLOCKLIST extra words still apply).
// Staff words and reserved names are never masked in chat ("ask an admin" is fine).

import { compileMatcher, readings, type Matcher } from "./match";
import { fold, SYMBOL_LEET } from "./normalize";

export type ChatFilterLevel = "off" | "standard" | "strict";

export function parseChatLevel(v: string | undefined | null): ChatFilterLevel {
  return v === "off" || v === "strict" ? v : "standard";
}

const matchers = new Map<ChatFilterLevel, Matcher | null>();
function matcher(level: ChatFilterLevel): Matcher | null {
  if (!matchers.has(level)) {
    matchers.set(
      level,
      level === "off" ? null : level === "strict" ? compileMatcher({ categories: ["hate", "sexual", "profanity"], ldnoobw: true }) : compileMatcher({ categories: ["hate", "sexual"] }),
    );
  }
  return matchers.get(level)!;
}

/** A token as the matcher sees it: folded, lowercased, symbols read as letters, only letters and digits left. */
function core(token: string): string {
  return [...fold(token).toLowerCase()].map((c) => SYMBOL_LEET[c] ?? c).join("").replace(/[^a-z0-9]/g, "");
}

/** Masks blocked words in a chat line. `extra` are exact words (case-insensitive, leetspeak folded) from CHAT_BLOCKLIST. */
export function maskChat(text: string, level: ChatFilterLevel, extra: ReadonlySet<string> = new Set()): { text: string; masked: boolean } {
  const m = matcher(level);
  if (!m && !extra.size) return { text, masked: false };
  const tokens = [...text.matchAll(/\S+/gu)].map((x) => ({ start: x.index!, raw: x[0], core: core(x[0]) }));
  const hit = new Array<boolean>(tokens.length).fill(false);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.core) continue;
    if ((extra.size && readings(t.core).plain.concat(t.core).some((f) => extra.has(f))) || (m && m.word(t.core))) hit[i] = true;
  }
  if (m) {
    // Joins only count when no single word in them hit already, so a slur doesn't drag its neighbours into the mask.
    const alone = [...hit];
    const clean = (a: number, b: number) => !alone.slice(a, b + 1).some(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      if (!tokens[i].core) continue;
      // Spans of 2-4 words: SEVERE starting at a word ("nig ger") and LDNOOBW phrases ("blow job").
      let joined = tokens[i].core;
      for (let j = i + 1; j < Math.min(tokens.length, i + 4) && clean(i, j); j++) {
        joined += tokens[j].core;
        if (m.phrase(joined)) {
          for (let k = i; k <= j; k++) hit[k] = true;
          break;
        }
      }
      // A detached letter ("shi t", "c unt") or spelled-out letters ("f u c k").
      if (i + 1 < tokens.length && clean(i, i + 1) && (tokens[i].core.length === 1 || tokens[i + 1].core.length === 1) && m.word(tokens[i].core + tokens[i + 1].core)) hit[i] = hit[i + 1] = true;
      let run = i;
      while (run < tokens.length && tokens[run].core.length === 1) run++;
      if (run - i >= 3 && m.word(tokens.slice(i, run).map((t) => t.core).join(""))) for (let k = i; k < run; k++) hit[k] = true;
    }
  }
  if (!hit.some(Boolean)) return { text, masked: false };
  let out = "";
  let at = 0;
  tokens.forEach((t, i) => {
    out += text.slice(at, t.start) + (hit[i] ? "*".repeat([...t.raw].length) : t.raw);
    at = t.start + t.raw.length;
  });
  return { text: out + text.slice(at), masked: true };
}

/** Folds an extra blocklist word the way maskChat reads tokens ("B4dw0rd" -> "badword"). */
export const chatWordKey = (w: string) => readings(core(w)).plain[0] ?? "";
