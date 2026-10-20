// Words display names can't contain and chat masks. Shared by the client (live pre-check), the API (the decision) and
// room chat (apps/api/src/rooms/chat.ts). Matching rules are in ./match.ts; name rules in ./names.ts.
//
// Two sources:
// 1. The curated lists below, ported from hatchdle (shared/blocklist.ts, the same author's project), which were
//    assembled by hand from LDNOOBW, the Wikipedia lists of ethnic and LGBT slurs and the ADL hate-symbol glossary,
//    trimmed to words that are unambiguous in a game nickname. These are matched through leetspeak, stretched letters,
//    separators, camelCase and inserted digits.
// 2. LDNOOBW (./ldnoobw-en.ts, CC BY 4.0), matched as whole words and whole phrases only, never inside a longer word,
//    minus LDNOOBW_EXCEPTIONS (ordinary words in a bhop nickname: "suck", "hardcore", "xx", ...).
//
// Write curated terms in plain lowercase letters, with no leetspeak or spacing: matching undoes 0/1/3/4/5/6/7/8/9 for
// letters, stretched letters ("fuuuck"), separators ("f.u.c.k"), camelCase ("fUCK"), a detached letter ("Shi t"),
// inserted digits and, for SEVERE terms, l-for-i ("nlgger"). A doubled letter in a term must be doubled in the input
// ("nigg" doesn't match "Nigel"). After adding a term, add a case to apps/api/test/names.test.ts and run the tests to
// check the must-allow names still pass.
//
// Known gaps, accepted to keep real names working: a split in the middle of a longer word ("bi tch"), l-for-i inside
// non-SEVERE terms ("Shlt"), and a slur glued to the end of an ordinary word across a space. Moderators handle those
// (POST /admin/names: rename, ban-name, block-term; apps/api/README.md).

/** Hate terms. Matched anywhere in a word with any number of repeated letters ("Niigger"), and across words when they
 * start at the beginning of one ("nig ger", "White Power"), so "Conn Iggulden" passes. Masked in chat at every level. */
export const SEVERE = [
  "nigg", "niqq", "nygg", "nigger", "faggot", "hitler", "swastika", "kukluxklan", "kluxklan", "battyman", "battyboy", "battyboi",
  "whitepower", "whitepride", "whitesupremac", "heilhitler", "siegheil", "sandnigger", "porchmonkey", "junglebunny",
  "cameljockey", "chingchong", "kneegrow", "kneegro", "gasthejews", "gasjews", "killthejews", "killalljews", "killjews", "hangjews", "jewkiller",
  "killblacks", "hangblacks", "lynchblacks", "killgays", "killallgays", "killyourself", "killurself", "killyrself",
  "hangyourself", "neckyourself", "neckurself",
];

/**
 * Vowel-dropped and digit-masked forms of the worst slurs (v0.0.10: live names "nggas", "n.ggas", "ngga", "nggaz",
 * "nygger", "nyggabhops", "fggt", "n1g4kill4h", "n44erk1ller", "blackniger" all passed the lists above). Regexes over
 * the readings of one word (match.ts readings: leetspeak undone; `raw` ones over the word as typed, digits kept),
 * applied wherever SEVERE is (names and chat, every filter level). Each is anchored or narrowed so real names pass:
 *   ngg / nygg   only at the start of a word: "Angga", "Anggi", "Tanggu" (Indonesian names) have "ngg" inside.
 *   niger        inside a longer word ("blackniger", "nigerkiller", "Niger1") but not Nigeria / Nigerian / Nigerien;
 *                "Niger" alone as the whole name is blocked too (nameProblem: a bhop nickname, used as a slur), while
 *                "Niger Delta" (the country as one word of several) passes.
 *   n?g + kill   the n-word glued to "kill" / "hate" ("n1g4kill4h").
 *   n + 2 digits + er   the gg masked with a doubled digit ("n44er", "n00er").
 *   f?gg?t       faggot without vowels ("fggt", "fggot", "faggt"); "Faggin", "Faggioli" and "Fagan" pass.
 * Tests: apps/api/test/names.test.ts (must-block and must-allow lists).
 */
export const SKELETONS: { re: RegExp; raw?: boolean }[] = [
  { re: /^n+[iy]?g{2,}/ },
  { re: /n+[iy]+g+e+r+(?!i[ae]|ien)[a-z]|[a-z]n+[iy]+g+e+r+(?!i[ae]|ien)/ },
  { re: /^n+[iy]?g+[aeu]+h?(?:k+i+l+|h+a+t+e)/ },
  { re: /^n(\d)\1[e3]r/, raw: true },
  { re: /f+[a4]?g{2,}[aeio]?t/ },
];
/** Whole names (squeezed, lowercase letters) blocked on their own though fine as one word of several. */
export const WHOLE_ONLY = ["niger"];

export type Category = "hate" | "sexual" | "profanity" | "staff";

/** Matched anywhere inside a word ("Sh1tposter", "Wanker"), stretched letters included ("Shiit"). */
export const INSIDE: Record<Exclude<Category, "staff">, string[]> = {
  profanity: ["fuck", "fucc", "fvck", "phuck", "phuk", "fck", "motherf", "shit", "wanker", "wanking", "bastard", "asshole", "arsehole", "butthole", "dickhead", "bollocks"],
  sexual: [
    "cunt", "bitch", "biatch", "whore", "slut", "skank", "cocksuck",
    "dildo", "pussy", "pussies", "vagina", "porno", "pornhub", "pornstar", "pornograph", "jizz", "cumshot", "cumslut",
    "creampie", "blowjob", "handjob", "rimjob", "bukkake", "hentai", "bdsm", "orgasm", "masturbat", "fellatio", "cunnilingus",
    "clitoris", "testicle", "scrotum", "ballsack", "nutsack", "titties", "boobies", "nipple", "seggs", "sexting", "shemale",
    "lolicon", "shotacon",
  ],
  hate: [
    // racist
    "nibba", "niglet", "nignog", "wetback", "redskin", "towelhead", "raghead", "jigaboo", "golliwog", "zipperhead", "kaffir",
    "dindu", "pickaninn", "piccaninn",
    // homophobic and transphobic
    "faggy", "faggit", "fagget", "tranny", "trannie", "poofter", "pooftah", "sodomite",
    // ableist
    "retard", "spastic", "mongoloid",
    // abuse and hate
    "molest", "pedophil", "paedo", "incest", "zoophil", "bestiality", "necrophil", "holocaust", "holohoax", "zyklon", "rahowa",
    "kkk",
  ],
};

/** Matched only as a whole word, or the whole name with spaces squeezed out. Each is fine inside longer words
 * (Sussex, Analyst, Cocktail, Grape, Therapist, Raccoon, Spicer, Petits, Torpedo, Fagan, Penistone, Pornchai). A word
 * also counts with one of PREFIXES or SUFFIXES glued on ("Bigdick", "Kikelord", "Sexx", "Coons"). Exactly two of a
 * letter doesn't count as stretching here, so "Rapper", "Mood" and "Assess" pass. */
export const WHOLE: Record<Category, string[]> = {
  profanity: ["ass", "arse", "fuk", "fuq", "fuc", "twat", "wank", "prick", "kunt", "mofo"],
  sexual: [
    "sex", "sexy", "cum", "anal", "anus", "cock", "dick", "tits", "titty", "boob", "penis", "clit", "hoe", "thot", "milf", "dilf",
    "gilf", "nude", "horny", "boner", "orgy", "xxx", "cuck", "porn", "loli",
  ],
  hate: [
    // racist
    "coon", "spic", "spick", "kike", "kyke", "gook", "chink", "chinky", "chinaman", "jap", "paki", "wop", "wog", "dago",
    "kraut", "honky", "honkey", "squaw", "negroes", "negroid", "darkie", "darky", "gyppo", "pikey", "yid", "heeb", "hymie",
    "beaner", "injun", "kafir", "nig", "nigs", "niga", "nigah", "nigr", "nigur", "nigguh", "negr",
    // homophobic and transphobic
    "fag", "fagot", "faget", "fgt", "dyke", "lesbo", "lezzie", "lezzy", "homo", "poof",
    // ableist
    "spaz", "tard", "midget",
    // abuse and hate
    "rape", "raped", "raping", "rapist", "raper", "pedo", "nonce", "nazi", "slave", "kys", "reggin", "toggaf",
  ],
  // impersonating staff (names only; chat never masks these)
  staff: ["admin", "administrator", "moderator", "staff", "official", "support"],
};
export const PREFIXES = ["big", "lil", "mr", "xx", "im", "iam"];
export const SUFFIXES = ["s", "x", "xx", "lord", "queen", "master", "boy", "girl", "god", "lover", "fan", "gang", "squad", "life", "team"];

/**
 * Reserved: only as the whole name (spaces and separators squeezed out, leetspeak read): fine inside a real name
 * ("Dev Patel", "Mod Squad", "Rootbeer", "Bunny Hopper"), not on its own. Moderators add more with ban-name.
 */
export const RESERVED = [
  "dev", "devs", "developer", "devteam", "mod", "mods", "modteam", "system", "sysop", "owner", "root", "server", "console",
  "bot", "anonymous", "anon", "nobody", "everyone", "null", "undefined", "unknown", "deleted", "banned",
  "guest", "bunnyhop", "bunnyhoplol", "bhoplol", "bunnyhopteam", "bunnyhopstaff", "bunnyhopadmin", "bunnyhopofficial",
  "negro",
];

/** Brand impersonation: blocked anywhere in the squeezed name ("BunnyHop.lol", "bunnyhop_lol_staff"). */
export const BRAND = ["bunnyhoplol", "bhoplol"];

/** Digit codes, matched in the name with separators removed. */
export const DIGIT_TERMS = ["1488", "rule34"];

/** Pieces of real names and words that contain a blocked term. They're blanked out before the INSIDE and SEVERE checks
 * (WHOLE still applies): Yamashita, Harshit, Kshitij, Yoshito, Shittu, Phuket, Slutsky, Niggli, Shiite, Scunthorpe. */
export const ALLOW = ["shita", "kshit", "rshit", "yoshit", "toshit", "shittu", "shiite", "shiitake", "phuket", "slutsk", "niggli", "scunthorpe"];

/**
 * LDNOOBW entries that are ordinary words or names in a bhop nickname or chat line, so they are not matched from that
 * list. (Curated terms above still apply: "Big Dick" is blocked by WHOLE, not by LDNOOBW "big black".)
 */
export const LDNOOBW_EXCEPTIONS = [
  "suck", "sucks", "butt", "hardcore", "hard core", "xx", "escort", "domination", "skeet", "scat", "twink", "twinkie",
  "swinger", "mong", "snatch", "tied up", "god damn", "hot chick", "cumming", "hooker", "shota", "santorum", "tainted love",
  "how to kill", "how to murder", "big black", "tight white", "taste my", "tongue in a", "girl on", "jelly donut", "spunk",
  "negro", "eunuch", "kinkster", "playboy", "s&m", "dommes", "birdlock", "goodpoop", "nutten", "nawashi", "sexo",
];
