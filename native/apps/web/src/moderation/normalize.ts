// Text normalisation shared by display names and chat (client and API).
//
// fold(): NFKC (fullwidth and styled letters become plain: "Ｈｕｎｔｅｒ", "𝐇𝐮𝐧𝐭𝐞𝐫"), invisible and formatting characters
// removed (zero-width, bidi overrides, fillers), diacritics stripped ("Zoë" -> "Zoe"), and Cyrillic / Greek / other
// letters that look like Latin ones replaced by them ("Неllo" with a Cyrillic Н and е -> "Hello"). Case is kept.

/** C0/C1 controls, soft hyphen, zero-width and bidi controls, word joiners / invisible operators, Hangul fillers, variation
 * selectors, BOM, interlinear annotations. */
export const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￻]/g;

/** Lookalikes that NFKC and diacritic stripping leave alone. Case-preserving. */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y", І: "I", Ј: "J", Ѕ: "S", Ԁ: "D", Ԛ: "Q", Ԝ: "W", Ү: "Y",
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", һ: "h", ӏ: "l", ԛ: "q", ԝ: "w", ү: "y", ь: "b", п: "n", т: "t", к: "k", м: "m", в: "b", г: "r",
  // Greek
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  α: "a", β: "b", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ϲ: "c", ϳ: "j",
  // Latin letters without a decomposition
  ı: "i", ȷ: "j", ł: "l", Ł: "L", ø: "o", Ø: "O", đ: "d", Đ: "D", ħ: "h", Ħ: "H", ß: "ss", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ŀ: "l", ƚ: "l", ɡ: "g", ɑ: "a", ʀ: "R",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "gu");

export function foldConfusables(s: string): string {
  return s.replace(CONFUSABLE_RE, (c) => CONFUSABLES[c] ?? c);
}

/** Strips combining marks ("José" -> "Jose"). */
export function foldDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}+/gu, "").normalize("NFC");
}

/** The full fold used before any check. Keeps case and spacing (callers squeeze whitespace themselves). */
export function fold(raw: string): string {
  return foldConfusables(foldDiacritics(raw.normalize("NFKC").replace(INVISIBLE, "")));
}

/** Symbols people use for letters in chat ("@ss", "$hit", "b!tch"). Names can't contain these characters at all. */
export const SYMBOL_LEET: Record<string, string> = { "@": "a", $: "s", "!": "i", "|": "l", "+": "t", "€": "e", "£": "l", "¡": "i" };
