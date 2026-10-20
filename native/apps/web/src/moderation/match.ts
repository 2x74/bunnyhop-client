// Blocklist matching (ported from hatchdle shared/names.ts and generalised for chat). Input is expected to be folded
// already (./normalize.ts fold()), so only ASCII letters, digits and separators matter here.
//
// A "matcher" is compiled once from a choice of categories: display names use all of them, chat a lighter set
// (./chat.ts). Matching works on readings of each word (leetspeak undone in a few ways) and on joins of short pieces,
// so "f u c k", "Shi t", "N1gg3r", "niiiigger" and "fUCK" are caught while "Scunthorpe", "Nigel", "Dickens", "Assassin",
// "Cocktail" and "Hancock" pass.

import { ALLOW, BRAND, DIGIT_TERMS, INSIDE, LDNOOBW_EXCEPTIONS, PREFIXES, RESERVED, SEVERE, SKELETONS, SUFFIXES, WHOLE, WHOLE_ONLY, type Category } from "./blocklist";
import { LDNOOBW_EN } from "./ldnoobw-en";

/** A term as a pattern that sees through stretched letters: any run of a single letter ("Niigger", "Shiiit"). A double
 * letter needs at least two, so "nigg" doesn't match "Nigel", "Niger" or "Niigata". */
const loose = (term: string) => term.replace(/(.)\1*/g, (m) => (m.length > 1 ? `${m[0]}{${m.length},}` : `${m[0]}+`));
/** Stricter, for WHOLE words: a single letter matches one, or three or more, but not exactly two, so "Rapper", "Mood"
 * and "Assess" don't read as "raper", "mod" and "asses". */
const strict = (term: string) => term.replace(/(.)\1*/g, (m) => (m.length > 1 ? `${m[0]}{${m.length},}` : `(?:${m[0]}|${m[0]}{3,})`));
const alt = (terms: readonly string[], p: (t: string) => string) => terms.map(p).join("|");
const uniq = (xs: string[]) => xs.filter((x, i) => x && xs.indexOf(x) === i);
const NEVER = /(?!)/;
const re = (src: string) => (src ? new RegExp(src) : NEVER);

const LEET: Record<string, string> = { "0": "o", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t", "8": "b", "9": "g" };

/**
 * Readings of a lowercase piece as plain letters. plain: digits as letters with 1 read as i, the same with 1 read as l,
 * and with the digits dropped ("f4uck"). In a number after letters, 6 and 9 stay digits, so "Dani96" isn't "danigg".
 * severe adds an l between two consonants read as i ("nlgger", "Hltler"), for SEVERE terms only, because it makes near
 * misses of real names ("Shilton").
 */
export function readings(s: string): { plain: string[]; severe: string[] } {
  const tail = /[0-9]+$/.exec(s)?.[0] ?? "";
  const body = tail && tail.length < s.length ? s.slice(0, -tail.length) + tail.replace(/[69]/g, "") : s;
  const leet = body.replace(/[0-9]/g, (d) => LEET[d] ?? d);
  const a = leet.replace(/1/g, "i").replace(/[^a-z]/g, "");
  const plain = uniq([a, leet.replace(/1/g, "l").replace(/[^a-z]/g, ""), s.replace(/[^a-z]/g, "")]);
  return { plain, severe: uniq([...plain, a.replace(/(?<=[^aeiouy])l(?=[^aeiouy])/g, "i")]) };
}

/** Blank out the allowed pieces of real names before looking for terms inside a word ("Yamashita", "Niggli"). */
const allowed = (f: string) => ALLOW.reduce((x, part) => x.replaceAll(part, "-"), f);

/** The pieces of a name, split on separators, and also on camelCase when camel is set. */
export const pieces = (name: string, camel: boolean) =>
  (camel ? name.replace(/([a-z])([A-Z])/g, "$1 $2") : name).toLowerCase().split(/[\s_.\-]+/).filter(Boolean);

/**
 * The words to check one at a time: each piece; runs of one- and two-letter pieces joined ("f u c k"); and a one- or
 * two-letter piece joined to each neighbour ("Shi t", "c unt", "Fu cking", "shiT"). Two longer words are never joined
 * here, so "Ash Ito" and "Josh Itzel" pass.
 */
function words(ps: string[]): string[] {
  const out = [...ps];
  let run: string[] = [];
  for (const p of [...ps, ""]) {
    if (p && p.length <= 2) {
      run.push(p);
      continue;
    }
    if (run.length > 1) out.push(run.join(""));
    run = [];
  }
  for (let i = 0; i + 1 < ps.length; i++) if (ps[i].length <= 2 || ps[i + 1].length <= 2) out.push(ps[i] + ps[i + 1]);
  return out;
}

/** Plain lowercase letters, the form terms are stored in ("N1gg@" -> "nigg"). Used for admin-added terms. */
export const cleanTerm = (t: string) => readings(t.toLowerCase().replace(/[^a-z0-9]/g, "")).plain[0] ?? "";

/** LDNOOBW entries as squeezed letters ("white power" -> "whitepower"), minus the exceptions. Entries with digits
 * ("2g1c") are kept as squeezed letters and digits. */
const LDNOOBW_SET: ReadonlySet<string> = (() => {
  const skip = new Set(LDNOOBW_EXCEPTIONS.map((e) => e.toLowerCase()));
  const out = new Set<string>();
  for (const e of LDNOOBW_EN) {
    if (skip.has(e.toLowerCase())) continue;
    const k = e.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (k.length >= 3) out.add(k);
  }
  return out;
})();

export interface MatchOptions {
  /** INSIDE / WHOLE categories to use. SEVERE always applies. */
  categories: readonly Category[];
  /** RESERVED whole names and BRAND anywhere (display names only). */
  reserved?: boolean;
  /** LDNOOBW whole words and phrases. */
  ldnoobw?: boolean;
  /** Admin-added terms (D1 blocked_terms): inside = anywhere, whole = whole words. */
  extra?: ExtraTerms;
}

export interface ExtraTerms {
  inside: string[];
  whole: string[];
}

export interface Matcher {
  /** A whole display name (folded). Checks words, joins across words and the squeezed name. */
  name(name: string): boolean;
  /** One word, already lowercased letters and digits (chat). */
  word(w: string): boolean;
  /** A run of words joined with nothing between them: hits only for SEVERE starts and LDNOOBW phrases (chat). */
  phrase(joined: string): boolean;
}

export function compileMatcher(o: MatchOptions): Matcher {
  const inside = o.categories.flatMap((c) => (c === "staff" ? [] : INSIDE[c]));
  const whole = o.categories.flatMap((c) => WHOLE[c]);
  const SEVERE_RE = re(alt(SEVERE, loose));
  const SEVERE_START = re(`^(?:${alt(SEVERE, loose)})`);
  const INSIDE_RE = re(alt(inside, loose));
  const WHOLE_RE = re(whole.length ? `^(?:${PREFIXES.join("|")})?(?:${alt(whole, strict)})(?:${SUFFIXES.join("|")})?$` : "");
  const RESERVED_RE = o.reserved ? re(`^(?:${alt(RESERVED, strict)})$`) : NEVER;
  const extraInside = o.extra?.inside.length ? re(alt(o.extra.inside, loose)) : NEVER;
  const extraWhole = o.extra?.whole.length ? re(`^(?:${alt(o.extra.whole, strict)})$`) : NEVER;
  const ld = o.ldnoobw ? LDNOOBW_SET : new Set<string>();

  const word = (w: string): boolean => {
    // A number tacked on doesn't hide a whole-word term ("R4pe67", "Nazi88"): check the word without it too.
    const core = w.replace(/[0-9]+$/, "");
    if (core !== w && core.length >= 3 && word(core)) return true;
    const { plain, severe } = readings(w);
    if (severe.map(allowed).some((f) => SEVERE_RE.test(f))) return true;
    // Vowel-dropped / digit-masked slurs (blocklist.ts SKELETONS), like SEVERE: every filter level.
    if (SKELETONS.some((s) => (s.raw ? s.re.test(w) : severe.map(allowed).some((f) => s.re.test(f))))) return true;
    if (plain.map(allowed).some((f) => INSIDE_RE.test(f) || extraInside.test(f))) return true;
    if (plain.some((f) => WHOLE_RE.test(f) || extraWhole.test(f) || ld.has(f))) return true;
    return ld.has(w.replace(/[^a-z0-9]/g, ""));
  };
  const phrase = (joined: string): boolean => {
    const { plain, severe } = readings(joined);
    return severe.map(allowed).some((f) => SEVERE_START.test(f)) || plain.some((f) => ld.has(f));
  };

  return {
    word,
    phrase,
    name(name: string): boolean {
      // split with and without camelCase: "BigDick" needs the split, "retArd" needs the plain word
      const camel = pieces(name, true);
      const flat = pieces(name, false);
      for (const w of uniq([...words(camel), ...words(flat)])) if (word(w)) return true;
      // Across words, starting at the beginning of one: SEVERE ("nig ger", "White Power", "Gas the Jews") and LDNOOBW
      // phrases ("Blow Job"). Starting mid-word would read "Conn Iggulden" and "Jan Iggy" as slurs.
      for (const ps of [camel, flat]) {
        for (let i = 0; i + 1 < ps.length; i++) {
          for (let j = i + 2; j <= Math.min(ps.length, i + 4); j++) if (phrase(ps.slice(i, j).join(""))) return true;
          if (readings(ps.slice(i).join("")).severe.map(allowed).some((f) => SEVERE_START.test(f))) return true;
        }
      }
      // the whole name with separators squeezed out: "S.E.X", "N4z_1", "Mod Team", and admin terms anywhere
      const squashed = flat.join("");
      const { plain, severe } = readings(squashed);
      if (plain.some((f) => WHOLE_RE.test(f) || RESERVED_RE.test(f) || extraWhole.test(f) || ld.has(f) || WHOLE_ONLY.includes(f))) return true;
      if (severe.some((f) => extraInside.test(f))) return true;
      if (DIGIT_TERMS.some((d) => squashed.includes(d))) return true; // "1488", "Clan 14 88", "rule34"
      // brand impersonation: "BunnyHop.lol", "Bunnyh0p lol"
      if (o.reserved && plain.some((f) => BRAND.some((b) => f.replace(/1/g, "l").includes(b)))) return true;
      return false;
    },
  };
}
