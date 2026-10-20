// Display-name rules. Shared so the client can check as you type; the API (apps/api/src/names.ts) decides.
//
// 1. Normalise (cleanName): NFKC, invisible characters removed, accents stripped ("José" -> "Jose"), Cyrillic/Greek
//    lookalikes replaced by Latin letters, whitespace trimmed and squeezed. This is the form that gets saved.
// 2. Shape: 3-20 characters; ASCII letters, digits, space and _ . - only; starts and ends with a letter or digit; no
//    two separators in a row. ASCII only on purpose: it rules out homoglyph impersonation ("Hunter" with a Cyrillic
//    "е") and anything that could be markup.
// 3. Blocklist (./blocklist.ts via ./match.ts): slurs, sexual terms, profanity, staff impersonation, reserved names,
//    through leetspeak, stretched letters, separators, camelCase and inserted digits, with an allowlist for real names
//    (Scunthorpe, Nigel, Dickens, Hancock, Yamashita...). Moderators add terms at runtime (D1 blocked_terms).
// 4. Uniqueness (server): nameKey() folds case, separators and lookalike letters, so "Hunter", "hunter" and "Hun_ter"
//    are one name, as are "Bill" and "BiII" (capital i). Digits count as themselves ("Hunt3r" is a different name).
//
// Error messages never repeat the name back (no echo of a slur): see NAME_MESSAGES.

import { compileMatcher, type ExtraTerms, type Matcher } from "./match";
import { fold } from "./normalize";

export const NAME_MIN = 3;
export const NAME_MAX = 20;

export type NameProblem = "too_short" | "too_long" | "charset" | "edges" | "separators" | "blocked" | "reserved";
/** Every refusal the API can give for a name (problems plus uniqueness and rate limits). */
export type NameError = NameProblem | "taken" | "rename_limit" | "bad_name";

export const NAME_MESSAGES: Record<NameError, string> = {
  too_short: `At least ${NAME_MIN} characters.`,
  too_long: `Up to ${NAME_MAX} characters.`,
  charset: "Letters, numbers, spaces and _ . - only.",
  edges: "Start and end with a letter or number.",
  separators: "One space or symbol at a time.",
  blocked: "That name isn't allowed. Try another.",
  reserved: "That name is reserved. Try another.",
  taken: "That name is taken.",
  rename_limit: "You can change your name 3 times a day.",
  bad_name: "That name isn't allowed. Try another.",
};

/** Trim, squeeze and fold: "  Zoë   B " -> "Zoe B". The saved form. */
export function cleanName(raw: string): string {
  return fold(raw).replace(/\s+/g, " ").trim();
}

/** Default names handed to new guests ("guest-0042"). Players can't pick these. */
export const DEFAULT_NAME_RE = /^guest[ _.\-]?\d*$/i;
export const isDefaultName = (name: string) => DEFAULT_NAME_RE.test(name);

/** Shape only (after cleanName). */
export function shapeProblem(name: string): NameProblem | null {
  if (/[^A-Za-z0-9 _.\-]/.test(name)) return "charset";
  if (name.length < NAME_MIN) return "too_short";
  if (name.length > NAME_MAX) return "too_long";
  if (!/^[A-Za-z0-9]/.test(name) || !/[A-Za-z0-9]$/.test(name)) return "edges";
  if (/[ _.\-]{2}/.test(name)) return "separators";
  return null;
}

let base: Matcher | null = null;
const NAME_MATCH = { categories: ["hate", "sexual", "profanity", "staff"], reserved: true, ldnoobw: true } as const;

/** Everything except uniqueness, on the cleaned name. `extra` = moderator-added terms (D1 blocked_terms). */
export function nameProblem(raw: string, extra?: ExtraTerms): NameProblem | null {
  const name = cleanName(raw);
  const shape = shapeProblem(name);
  if (shape) return shape;
  if (isDefaultName(name)) return "reserved";
  const m = extra && (extra.inside.length || extra.whole.length) ? compileMatcher({ ...NAME_MATCH, categories: [...NAME_MATCH.categories], extra }) : (base ??= compileMatcher({ ...NAME_MATCH, categories: [...NAME_MATCH.categories] }));
  return m.name(name) ? "blocked" : null;
}

/**
 * The lookalike key for uniqueness (users.name_key is UNIQUE). In this order: capital I becomes l (they look the same
 * in most UI fonts), lowercase, drop space _ . -, then rn -> m and vv -> w. Digits stay digits; repeated letters stay
 * ("Ana" and "Anna" are different people). migrations/0007_names_email.sql does the same in SQL for the backfill.
 */
export function nameKey(name: string): string {
  return name.replace(/I/g, "l").toLowerCase().replace(/[ _.\-]/g, "").replace(/rn/g, "m").replace(/vv/g, "w");
}

// ---------------------------------------------------------------------------------------------
// Bhop-themed name suggestions (the dice button). Every combination passes nameProblem (apps/api/test/names.test.ts).

const ADJ = [
  "Turbo", "Silent", "Swift", "Fuzzy", "Lucky", "Sneaky", "Bouncy", "Mighty", "Floaty", "Zippy", "Cosmic", "Frosty", "Neon",
  "Velvet", "Rapid", "Lunar", "Tiny", "Hyper", "Sleepy", "Spicy", "Golden", "Dizzy", "Crispy", "Sonic", "Wobbly", "Noble",
  "Feral", "Jolly", "Pixel", "Stealthy", "Smooth", "Synced", "Perfect", "Airborne", "Elastic", "Rocket",
];
const NOUN = [
  "Hopper", "Bunny", "Strafer", "Hare", "Jackrabbit", "Kangaroo", "Frog", "Cricket", "Pogo", "Spring", "Carrot", "Burrow",
  "Whisker", "Thumper", "Glider", "Leaper", "Bounce", "Rabbit", "Sync", "Gain", "Prestrafe", "Airstrafe", "Ramp", "Tick",
  "Goblin", "Gremlin", "Wizard", "Comet", "Lagomorph", "Cottontail", "Hopscotch",
];
const WHOLE_NAMES = ["Sync Goblin", "Gain Gremlin", "Ramp Rabbit", "Carrot Cruiser", "Tick Perfect", "Strafe Wizard", "Hop Goblin", "Air Accel", "Scroll Wheel", "Edge Bug", "Perf Hop", "Long Jump", "Speed Cap"];

/** A random bhop-themed name, 3-20 chars ("TurboHopper", "Sneaky_Hare", "Gain Gremlin 42"). */
export function suggestName(rand: () => number = secureRandom): string {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const style = Math.floor(rand() * 5);
  let name: string;
  if (style === 0) name = pick(WHOLE_NAMES);
  else {
    const sep = ["", " ", "_", ".", ""][style] ?? "";
    name = `${pick(ADJ)}${sep}${pick(NOUN)}`;
  }
  if (rand() < 0.35) {
    let k = Math.floor(rand() * 99) + 1;
    if (k === 14 || k === 69 || k === 88) k += 1; // no hate codes or innuendo in a suggestion
    const n = String(k);
    name = name.length + n.length + 1 <= NAME_MAX ? `${name}${rand() < 0.5 ? " " : ""}${n}` : name;
  }
  return name.length > NAME_MAX ? pick(WHOLE_NAMES) : name;
}

/** For tests: every suggestion that can be produced (without numbers). */
export function allSuggestionBases(): string[] {
  const out = [...WHOLE_NAMES];
  for (const a of ADJ) for (const n of NOUN) for (const sep of ["", " ", "_", "."]) if ((a + sep + n).length <= NAME_MAX) out.push(a + sep + n);
  return out;
}

/** A free variant of a taken name: "Hunter" -> "Hunter42", shortened to fit. */
export function numberedName(name: string, n: number): string {
  const suffix = String(n);
  return `${name.slice(0, NAME_MAX - suffix.length).replace(/[ _.\-]+$/, "")}${suffix}`;
}

function secureRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

export type { ExtraTerms };
