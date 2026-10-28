// The matcher behind the search box at the top of Settings (ported from Aimperion's settings search). A player looking
// for "the thing that makes the hands smaller" doesn't know it's called Viewmodel FOV under Viewmodel; this finds it
// from "viewmodel", "hands", "carrot fov" or "veiwmodel".
//
// WHAT IT SEARCHES. Every row's label, hint and ⓘ text (the row's `desc`), the section and group it sits in, the row's
// own `keywords`, and the hand-written ALIASES below: the words players actually use (sens, fov, keybinds, crouch,
// autohop, name tags...), which the labels deliberately don't, because a label is one word and a search is whatever
// comes to mind.
//
// HOW IT RANKS. Every query word must land somewhere on a row (AND, not OR: "music volume" shouldn't surface every row
// with "volume" in it above the one with both), and the row's score is the sum of its best hit per word: a word that IS
// a label word (or the label's initials: "fov" is Field of view) beats one that starts it, beats one inside it, beats one in an alias, beats one in the section / group
// name, beats one buried in the description. A word nothing matches exactly is tried at an edit distance of one (two
// for long words) against the label and alias words only: enough for a typo, not so loose that "volume" finds "value".
//
// SHORT WORDS (4 letters or fewer: "sens", "fov", "dpi") are mostly abbreviations. They match label words exactly or
// as a prefix ("sens" → Sensitivity, "vol" → Master volume) and aliases exactly or up to a break inside the alias
// ("cm" → cm/360, "fov" → fov_desired) or its plural ("hand" → hands) as usual, but as the front of a longer alias word ("sens" in "sensitivity") they
// only count as a weak hit, below SPECIFIC: it keeps a half-typed "prof" finding Account (alias "profile") when nothing
// else matches, but no longer lets "sens" bring First-visit intro (keywords: "sensitivity") along with Sensitivity.
// And they get no typo slack ("bind" isn't "wind").
//
// STOPWORDS. "how do i change my mouse speed" is a fine query; the words that carry it are "mouse" and "speed". Question
// glue is dropped before matching, but never the whole query (a query that is ALL glue keeps its words).
//
// NOTHING FOUND. didYouMean() offers the query with each unmatched word swapped for the nearest word the settings use,
// with more slack than the matcher allows itself ("crosshr" → crosshair, "sems" → sens): a suggestion the player
// confirms (a click, or Enter), never a silent result.
//
// No DOM: settings-panel.ts builds the entries from the rows it rendered and applies the result by hiding what didn't
// match (rows behind a section's Advanced disclosure included: the disclosure opens while it holds a match).
// Tested in apps/api/test/settings-search.test.ts.

/**
 * Words players use that the labels don't, keyed by the label of the row, the group (subsection title) or the section
 * they belong to. A section's and a group's aliases apply to every row in it, but rank below a row's own. Lowercase,
 * spelling variants included. Row-specific words for labels that repeat across sections ("Opacity", "Size", "Style")
 * live in that row's `keywords` instead.
 */
export const SETTING_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  /* sections */
  "Mouse & view": "mouse sens sensitivity aim dpi cpi edpi cm/360 cm360 360 fov view zoom input",
  Crosshair: "crosshair xhair reticle cursor dot cross sight",
  HUD: "hud overlay on-screen onscreen interface elements show hide layout screen",
  Keys: "keys keybinds keybind binds bind hotkey hotkeys shortcut shortcuts rebind controls key keyboard",
  Ghost: "ghost ghosts race racing replay",
  Graphics: "graphics video display performance quality render gpu",
  Viewmodel: "viewmodel hands carrot knife weapon gun first-person arms",
  Audio: "audio sound sounds sfx",
  Account: "account profile login",

  /* groups */
  "Mouse input": "mouse input polling hz flick flicks diagnostics",
  "Show on screen": "show hide on-screen onscreen visible hud elements",
  "More elements": "hud elements show hide",
  /* (A group and the switch under Show on screen: the row's own words are its keywords.) */
  "Keys overlay": "keys overlay wasd inputs input display keystrokes keyboard",
  "Share layout": "share code export import",
  "Name tags": "name names tag tags nametag nametags label labels",
  "Show / hide": "toggle toggles show hide",
  "Mute channels": "mute silence",
  "Movement feel": "bob sway feel",
  Position: "position offset viewmodel_offset",
  Loadout: "loadout player model character bunny colourway colorway hat knife knives finish finishes gloves skin skins cosmetic",
  Display: "display screen quality performance",

  /* rows */
  Sensitivity: "sens sensitivity m_yaw mouse speed aim",
  "Mouse DPI": "dpi cpi edpi",
  "Invert mouse Y": "invert inverted y axis flip pitch",
  "Raw input": "raw acceleration accel unadjusted pointer",
  "Spike filter": "spike spikes flick flicks jump jumps snap skip skips filter jitter polling",
  "Show input stats": "input stats debug diagnostics polling hz stutter stutters freeze overlay",
  "Field of view": "fov fov_desired zoom wide",
  Jump: "jump scroll wheel mwheeldown mwheelup autohop bhop hop space",
  Duck: "duck crouch ctrl control",
  "Restart run": "restart reset respawn",
  "Hold to restart": "hold restart reset accidental accident protect confirm",
  "Show / hide keys overlay": "keys overlay toggle hotkey wasd",
  "Show / hide viewmodel": "viewmodel hands toggle hotkey",
  "Edit HUD layout": "hud editor f2",
  "Resolution scale": "fps performance render quality resolution lag",
  "Anisotropic filtering": "af aniso quality texture textures filtering sharp",
  "Fullscreen when playing": "fullscreen full screen keyboard lock",
  "Menu background": "menu background attract main live flythrough",
  Colourway: "colorway colourway color colour outfit cosmetic skin",
  "Show viewmodel": "viewmodel hands carrot r_drawviewmodel",
  "Viewmodel FOV": "viewmodel_fov fov hands bigger smaller",
  "Offset X": "viewmodel_offset_x offset side left right",
  "Offset Y": "viewmodel_offset_y offset forward back",
  "Offset Z": "viewmodel_offset_z offset up down height",
  Equipped: "loadout knife finish gloves skin equipped",
  "Master volume": "volume master loud quiet sound",
  "Play music": "music songs soundtrack playlist",
  "FPS counter": "fps frames framerate counter",
  "Show ghosts": "ghost ghosts race",
  "Ghost tags": "name names tag tags nametag",
  "Player tags": "name names tag tags nametag nametags players",
  "Names through walls": "name names tag tags walls nametag wallhack",
  "Edit layout": "hud editor move drag position f2",
  "Layout code": "share code export import hud layout",
  "HUD scale": "hud size scale bigger smaller",
  "Colour blind": "colorblind colourblind color colour blind blindness deuteranopia protanopia tritanopia accessibility",
});

/* Question glue: the words of "how do I turn off the ..." that name no setting. "on" / "off" / "up" / "down" too: every
   switch is on or off, so the word picks nothing out; "hide" is "off" said another way ("hide keys overlay" is the keys
   overlay switch, not the Show / hide bind). "show" stays: it's in row names. */
const STOPWORDS = new Set([
  "how", "do", "i", "the", "a", "an", "my", "me", "to", "of", "for", "is", "it", "can", "where", "what", "which",
  "setting", "settings", "option", "options", "make", "want", "find", "please", "in", "and", "with", "be", "change",
  "turn", "set", "adjust", "get", "enable", "disable", "toggle", "on", "off", "up", "down", "more", "less", "hide",
]);

/** Lowercase, accents stripped, punctuation to spaces, except the marks that are part of a settings word ('/', ':',
 *  '-', '.', '_'), which stay so "cm/360", "4:3", "first-person" and "viewmodel_fov" survive as words. */
export function normalize(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9/:._\-\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Query words, glue removed. All-glue queries keep their words. */
export function tokenize(q: string): string[] {
  const words = normalize(q).split(" ").filter(Boolean);
  const kept = words.filter((w) => !STOPWORDS.has(w));
  return kept.length ? kept : words;
}

/** Edit distance with adjacent transpositions counted as one edit (optimal string alignment): "crosshiar" is one slip
 *  from "crosshair". Capped: returns `max + 1` as soon as it's exceeded. */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] | null = null;
  let prev: number[] = new Array(b.length + 1);
  let cur: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
    cur = new Array(b.length + 1);
  }
  return prev[b.length];
}

/** Query words this long or shorter are abbreviations (see SHORT WORDS in the header). */
const SHORT = 4;

/** How many edits a typo in a word of this length is allowed: none for short words. */
function slack(word: string): number {
  if (word.length >= 8) return 2;
  if (word.length > SHORT) return 1;
  return 0;
}

/** `w` (not equal to `aw`) starts alias word `aw` as a full prefix: any word longer than SHORT, or a short one that is
 *  a whole word of `aw` (up to a break: "cm" in "cm/360") or its plural ("hand" in "hands"). A short word cut off
 *  mid-word ("sens" in "sensitivity") is a weak hit. */
function aliasPrefix(aw: string, w: string, full: number): number {
  if (!aw.startsWith(w)) return 0;
  if (w.length > SHORT) return full;
  const rest = aw.slice(w.length);
  return rest === "s" || rest === "es" || !/[a-z0-9]/.test(rest[0]) ? full : S.shortAliasPrefix;
}

export interface SearchEntry<N = unknown> {
  label: string;
  hint?: string;
  /** The ⓘ / description text. */
  tip?: string;
  /** Section label ("HUD"). */
  group?: string;
  /** Group (subsection) title ("Keys overlay"). */
  sub?: string;
  /** Row's own extra words, space-separated. */
  aliases?: string;
  /** Whatever the caller wants back (the row element). */
  node?: N;
}

export interface IndexedEntry<N = unknown> {
  entry: SearchEntry<N>;
  label: string;
  labelWords: string[];
  /** Initials of a label of 2+ words ("fov" for Field of view): typing them is typing the name. */
  acronym: string;
  aliasWords: string[];
  groupAliasWords: string[];
  group: string;
  sub: string;
  hint: string;
  tip: string;
}

/** Pre-normalise one entry once; searching re-uses it per keystroke. */
export function indexEntry<N>(entry: SearchEntry<N>): IndexedEntry<N> {
  const label = normalize(entry.label);
  const labelWords = label.split(" ").filter(Boolean);
  // The row's own aliases and its section / group's are kept apart: "carrot" is on the Viewmodel section so the word
  // finds SOMETHING there, but the rows that name the carrot come first.
  const own = [entry.aliases, SETTING_ALIASES[entry.label]].filter(Boolean).join(" ");
  const inherited = [entry.group && SETTING_ALIASES[entry.group], entry.sub && SETTING_ALIASES[entry.sub]].filter(Boolean).join(" ");
  return {
    entry,
    label,
    labelWords,
    acronym: labelWords.length >= 2 ? labelWords.map((w) => w[0]).join("") : "",
    aliasWords: normalize(own).split(" ").filter(Boolean),
    groupAliasWords: normalize(inherited).split(" ").filter(Boolean),
    group: normalize(entry.group),
    sub: normalize(entry.sub),
    hint: normalize(entry.hint),
    tip: normalize(entry.tip),
  };
}

/* Scores, best per word. The ladder is the header's argument. */
const S = {
  labelExact: 12,
  labelPrefix: 9,
  labelSub: 6,
  aliasExact: 7,
  aliasPrefix: 5,
  groupAliasExact: 4,
  groupAliasPrefix: 3,
  /** A short word as the front of a longer alias word (aliasPrefix): weak, like help text. */
  shortAliasPrefix: 2.5,
  groupWord: 4.5,
  subWord: 4.5,
  hintSub: 2,
  tipSub: 1.5,
  fuzzy: 3,
};

/* A word that landed on the row's own name or aliases, or on the name of its section or group, is a SPECIFIC hit; one
   carried only by an inherited alias, a sentence of help text or a typo guess is not. When any row is specifically hit
   on every word, rows that aren't are dropped: "crouch" means the Duck bind, not every row of Keys the section alias
   would let through. When nothing is specific (a typo, a word only the descriptions use) everything that matched at
   all stays, because that's all there is. */
const SPECIFIC = 4.5;

function scoreWord(ix: IndexedEntry, w: string): number {
  let best = 0;
  const up = (v: number) => {
    if (v > best) best = v;
  };
  for (const lw of ix.labelWords) {
    if (lw === w) up(S.labelExact);
    else if (lw.startsWith(w)) up(S.labelPrefix);
  }
  if (ix.acronym && w === ix.acronym) up(S.labelExact);
  if (best < S.labelSub && ix.label.includes(w)) up(S.labelSub);
  for (const aw of ix.aliasWords) {
    if (aw === w) up(S.aliasExact);
    else up(aliasPrefix(aw, w, S.aliasPrefix));
  }
  if (best < S.groupAliasExact) {
    for (const aw of ix.groupAliasWords) {
      if (aw === w) up(S.groupAliasExact);
      else up(aliasPrefix(aw, w, S.groupAliasPrefix));
    }
  }
  if (best < S.groupWord) {
    if (ix.group && ix.group.includes(w)) up(S.groupWord);
    if (ix.sub && ix.sub.includes(w)) up(S.subWord);
  }
  if (best === 0) {
    if (ix.hint.includes(w)) up(S.hintSub);
    if (ix.tip.includes(w)) up(S.tipSub);
  }
  if (best === 0) {
    const max = slack(w);
    if (max > 0) {
      for (const cand of [...ix.labelWords, ...ix.aliasWords, ...ix.groupAliasWords]) {
        if (editDistance(w, cand, max) <= max) {
          up(S.fuzzy);
          break;
        }
      }
    }
  }
  return best;
}

/**
 * Ranks indexed entries against a query: best first. An empty (or all-whitespace) query returns every entry with score
 * 0 in index order.
 */
export function searchSettings<N>(index: IndexedEntry<N>[], query: string): { entry: SearchEntry<N>; score: number }[] {
  const words = tokenize(query);
  if (!words.length) return index.map((ix) => ({ entry: ix.entry, score: 0 }));
  const whole = words.join(" ");
  let out: { entry: SearchEntry<N>; score: number; specific: boolean }[] = [];
  let anySpecific = false;
  for (const ix of index) {
    let total = 0;
    let weakest = Infinity;
    for (const w of words) {
      const s = scoreWord(ix, w);
      if (s === 0) {
        weakest = 0;
        break;
      }
      total += s;
      if (s < weakest) weakest = s;
    }
    if (weakest === 0) continue;
    // The whole query at the start of the label is the thing they typed, spelled out: it wins over a row that happens
    // to contain every word somewhere.
    if (ix.label.startsWith(whole) || (ix.acronym && whole === ix.acronym)) total += 6;
    else if (ix.label.includes(whole)) total += 3;
    const specific = weakest >= SPECIFIC;
    if (specific) anySpecific = true;
    out.push({ entry: ix.entry, score: total, specific });
  }
  if (anySpecific) out = out.filter((r) => r.specific);
  // Stable: equal scores keep form order.
  out.sort((a, b) => b.score - a.score);
  return out.map(({ entry, score }) => ({ entry, score }));
}

/**
 * "Did you mean": for a query nothing matches, the same query with each word nothing matched swapped for the closest
 * word the settings use (a label or alias word, within about a third of its letters: more slack than the matcher's own,
 * since this is a suggestion the player confirms, not a result). Null when no swap gives the query a match.
 */
export function didYouMean<N>(index: IndexedEntry<N>[], query: string): string | null {
  const words = tokenize(query);
  if (!words.length) return null;
  const vocab: string[] = [];
  const seen = new Set<string>();
  for (const ix of index)
    for (const w of [...ix.labelWords, ...ix.aliasWords])
      if (w.length >= 3 && /^[a-z]+$/.test(w) && !seen.has(w)) (seen.add(w), vocab.push(w));
  let changed = false;
  const fixed = words.map((w) => {
    if (w.length < 3 || searchSettings(index, w).length) return w;
    const max = Math.max(1, Math.round(w.length / 3));
    // Fewest edits; on a tie the word that starts the same way for longer ("crosshr": crosshair, not cross).
    let best: string | null = null;
    let bestD = max + 1;
    let bestP = -1;
    for (const v of vocab) {
      const d = editDistance(w, v, max);
      if (d > max || d > bestD) continue;
      let p = 0;
      while (p < w.length && p < v.length && w[p] === v[p]) p++;
      if (d < bestD || p > bestP) (bestD = d), (bestP = p), (best = v);
    }
    if (!best) return w;
    changed = true;
    return best;
  });
  if (!changed) return null;
  const q = fixed.join(" ");
  return searchSettings(index, q).length ? q : null;
}

/**
 * Where to mark in a label: [start, end) ranges of the query words that appear in it verbatim (case-insensitively),
 * merged. Fuzzy and alias hits get no mark: there's nothing in the label to mark.
 */
export function matchRanges(label: string, query: string): [number, number][] {
  const low = String(label ?? "").toLowerCase();
  const ranges: [number, number][] = [];
  for (const w of tokenize(query)) {
    let from = 0;
    for (;;) {
      const i = low.indexOf(w, from);
      if (i < 0) break;
      ranges.push([i, i + w.length]);
      from = i + w.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
