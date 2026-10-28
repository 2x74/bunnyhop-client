// @import in custom CSS (custom-css/index.ts): how a big theme ships. The player pastes a short file (the
// theme's settings as :root variables, plus `@import url(https://author.github.io/theme/theme.css);`) and the author
// updates the real theme at that address for everyone. DOM-free, tested in apps/web/test/custom-css.test.ts.
//
// Each imported file is fetched as text (through /api/css-asset, kind=css), its relative URLs made absolute against
// its own address (rewrite.ts absolutizeUrls), its own imports expanded the same way, and the result put where the
// @import was, inside @layer / @supports / @media blocks for the rule's conditions, which is how the browser would have
// applied it. Then the whole sheet goes through rewriteCss like pasted CSS: every link in an imported file is fetched up
// front too. Limits: MAX_DEPTH levels, MAX_IMPORTS files, MAX_IMPORTED_CHARS of text; past them a rule is dropped.

import { absolutizeUrls, findImports, MAX_CSS_CHARS } from "./rewrite";

export const MAX_DEPTH = 4;
export const MAX_IMPORTS = 24;
export const MAX_IMPORTED_CHARS = 2 * 1024 * 1024;

export interface ExpandResult {
  css: string;
  /** Files imported (absolute addresses, in order). */
  imported: string[];
  /** Imports that didn't load, and why. */
  failed: { url: string; why: string }[];
}

/** Splits an @import condition into its layer, supports() and media parts. */
export function splitCondition(cond: string): { layer: string | null; supports: string | null; media: string } {
  let rest = cond.trim();
  let layer: string | null = null;
  let supports: string | null = null;
  const lm = /^layer(?:\(\s*([\w.-]+)\s*\))?(?=\s|$|supports\()/i.exec(rest);
  if (lm) {
    layer = lm[1] ?? "";
    rest = rest.slice(lm[0].length).trim();
  }
  if (/^supports\(/i.test(rest)) {
    let depth = 0;
    let i = "supports".length;
    for (; i < rest.length; i++) {
      if (rest[i] === "(") depth++;
      else if (rest[i] === ")" && --depth === 0) break;
    }
    const inner = rest.slice("supports(".length, i).trim();
    // supports(display: grid) is a declaration; supports(not (x)) / supports((a) and (b)) / selector(...) a condition.
    supports = /^(\(|not\s|selector\()/i.test(inner) ? inner : `(${inner})`;
    rest = rest.slice(i + 1).trim();
  }
  return { layer, supports, media: rest };
}

/** `css` with its conditions as blocks around it. */
function wrap(css: string, cond: string): string {
  const { layer, supports, media } = splitCondition(cond);
  let out = css;
  if (layer !== null) out = `@layer${layer ? ` ${layer}` : ""} {\n${out}\n}`;
  if (supports) out = `@supports ${supports} {\n${out}\n}`;
  if (media && !/^all$/i.test(media)) out = `@media ${media} {\n${out}\n}`;
  return out;
}

/**
 * Expands the @import rules of `css` (whose own address is `base`, null for pasted CSS: then only absolute links
 * import). `fetchText(url)` gets a file's text or throws with a sentence.
 */
export async function expandImports(css: string, base: string | null, fetchText: (url: string) => Promise<string>): Promise<ExpandResult> {
  const imported: string[] = [];
  const failed: { url: string; why: string }[] = [];
  let chars = 0;
  const fail = (url: string, why: string) => (failed.push({ url, why }), "");

  const expand = async (text: string, from: string | null, depth: number, chain: string[]): Promise<string> => {
    const { src, rules } = findImports(text);
    if (!rules.length) return src;
    // Fetch this file's imports side by side; put them back in order.
    const parts = await Promise.all(
      rules.map(async (r): Promise<string> => {
        let url: string;
        try {
          url = new URL(r.url, from ?? undefined).href;
        } catch {
          return fail(r.url, "Only https:// links import.");
        }
        if (!/^https?:\/\//i.test(url)) return fail(url, "Only https:// links import.");
        if (chain.includes(url)) return fail(url, "It imports itself.");
        if (depth >= MAX_DEPTH) return fail(url, `Imports go ${MAX_DEPTH} levels deep at most.`);
        if (imported.length >= MAX_IMPORTS) return fail(url, `At most ${MAX_IMPORTS} files import.`);
        imported.push(url);
        let body: string;
        try {
          body = await fetchText(url);
        } catch (e) {
          return fail(url, e instanceof Error ? e.message : String(e));
        }
        chars += body.length;
        if (chars > MAX_IMPORTED_CHARS) return fail(url, "The imported files are too big together.");
        // @charset only means something at the very start of a real file.
        const own = absolutizeUrls(body.replace(/^﻿?@charset\s+"[^"]*"\s*;/i, ""), url);
        return wrap(await expand(own, url, depth + 1, [...chain, url]), r.condition);
      }),
    );
    let out = "";
    let at = 0;
    rules.forEach((r, k) => {
      out += src.slice(at, r.from) + parts[k];
      at = r.to;
    });
    return out + src.slice(at);
  };

  const out = await expand(css.slice(0, MAX_CSS_CHARS), base, 0, base ? [base] : []);
  return { css: out, imported, failed };
}
