// Copied from the website's apps/web/test/custom-css.test.ts (rewrite and @import parts) with rewrite.ts / imports.ts.

// bun test apps/web/test: custom CSS URL rewriting (custom-css/rewrite.ts). No URL in a player's CSS may reach the
// browser unless it's blob:, data: or #fragment; links are listed so the game can fetch them up front.
import { describe, expect, it } from "bun:test";
import { expandImports, splitCondition } from "../../../web/src/custom-css/imports";
import { BLANK, classifyUrl, onlySafeUrls, rewriteCss } from "../../../web/src/custom-css/rewrite";

const blob = (u: string) => `blob:https://bunnyhop.lol/${encodeURIComponent(u)}`;
const B = `url("${BLANK}")`;

describe("rewriteCss", () => {
  it("lists links and blanks them until their bytes arrive", () => {
    const r = rewriteCss("a{background:url(https://i.imgur.com/x.gif) no-repeat}");
    expect(r.remote).toEqual(["https://i.imgur.com/x.gif"]);
    expect(r.css).toBe(`a{background:${B} no-repeat}`);
    expect(onlySafeUrls(r.css)).toBe(true);
  });

  it("swaps links for the blob URLs it's given", () => {
    const r = rewriteCss("a{background:url('https://i.imgur.com/x.gif')}", blob);
    expect(r.css).toBe(`a{background:url("${blob("https://i.imgur.com/x.gif")}")}`);
  });

  it("never passes through a URL a resolver gets wrong", () => {
    expect(rewriteCss("a{b:url(https://x.test/a.png)}", () => "https://x.test/a.png").css).toBe(`a{b:${B}}`);
  });

  it("sees urls the way the browser does: case, spaces, escapes", () => {
    for (const css of [
      "a{b:URL(https://evil.test/1)}",
      'a{b:url(  "https://evil.test/1"  )}',
      "a{b:\\75rl(https://evil.test/1)}",
      'a{b:u\\72 l("https://evil.test/1")}',
      'a{b:url("\\68 ttps://evil.test/1")}',
      "a{b:url(https://evil.test/1",
      "a{--x:url(https://evil.test/1)}",
      "@font-face{font-family:F;src:url(https://evil.test/1) format('woff2'),local(Arial);unicode-range:U+61}",
      "a{cursor:url(https://evil.test/1),auto}",
      "a{b:-webkit-cross-fade(url(https://evil.test/1),url(data:,x),50%)}",
    ]) {
      const r = rewriteCss(css);
      expect(r.remote).toEqual(["https://evil.test/1"]);
      expect(onlySafeUrls(r.css)).toBe(true);
      expect(r.css).not.toContain("evil");
      expect(onlySafeUrls(css)).toBe(false);
    }
  });

  it("treats strings in image-set as URLs, but not strings in type()", () => {
    const r = rewriteCss('a{b:image-set("https://x.test/1.png" 1x type("image/png"), url(https://x.test/2.png) 2x)}', blob);
    expect(r.remote).toEqual(["https://x.test/1.png", "https://x.test/2.png"]);
    expect(r.css).toContain('type("image/png")');
    expect(r.css).not.toContain('"https://');
    expect(onlySafeUrls(r.css)).toBe(true);
  });

  it("blanks image-set and src() when a var() could hand them a link", () => {
    for (const css of ['a{--u:"https://evil.test/1";b:image-set(var(--u) 1x)}', 'a{--u:"https://evil.test/1";b:src(var(--u))}', "a{b:-webkit-image-set(attr(data-x) 1x)}"]) {
      const r = rewriteCss(css);
      expect(onlySafeUrls(r.css)).toBe(true);
      expect(r.css).toContain(B);
    }
  });

  it("drops @import", () => {
    const r = rewriteCss('@import url(https://x.test/a.css) screen;@import "b.css";a{color:red}');
    expect(r.css).toBe("a{color:red}");
    expect(r.imports).toBe(2);
    expect(r.remote).toEqual([]);
  });

  it("blocks relative paths, blob: and other schemes", () => {
    const r = rewriteCss("a{b:url(anime.gif);c:url(/api/me);d:url(blob:https://x/y);e:url(javascript:1);f:url(//evil.test/x)}");
    expect(r.blocked).toEqual(["anime.gif", "/api/me", "blob:https://x/y", "javascript:1", "//evil.test/x"]);
    expect(r.remote).toEqual([]);
    expect(onlySafeUrls(r.css)).toBe(true);
  });

  it("keeps data: URLs, #fragments, strings and comments", () => {
    const css = 'a{b:url(data:image/png;base64,AAAA);filter:url(#glow);content:"url(https://x.test/no)"}/* url(https://x.test/no) */';
    const r = rewriteCss(css);
    expect(r.remote).toEqual([]);
    expect(r.css).toBe(css.replace("url(data:image/png;base64,AAAA)", 'url("data:image/png;base64,AAAA")').replace("url(#glow)", 'url("#glow")'));
  });

  it("blanks bad urls", () => {
    const r = rewriteCss("a{b:url(https://x.test/a b)}");
    expect(r.css).toBe(`a{b:${B}}`);
  });

  it("escapes what it writes back", () => {
    const r = rewriteCss('a{b:url("data:image/svg+xml,<svg xmlns=\\"http://www.w3.org/2000/svg\\"/>")}');
    expect(onlySafeUrls(r.css)).toBe(true);
    expect(r.css).toContain('\\"http://www.w3.org/2000/svg\\"');
  });

  it("leaves CSS without URLs as it was", () => {
    const css = ':root{--hud-font:"Comic Sans MS";--accent:#7cf}\n#hud [data-el="speed"]{color:hotpink;width:calc(var(--hud-speed, 0) * 0.1px)}';
    expect(rewriteCss(css).css).toBe(css);
  });
});

describe("classifyUrl", () => {
  it("knows links from the rest", () => {
    expect(classifyUrl(" https://i.imgur.com/a.gif ").kind).toBe("remote");
    expect(classifyUrl("http://example.test/a.png").kind).toBe("remote");
    expect(classifyUrl("https://user:pw@example.test/a.png").kind).toBe("blocked");
    expect(classifyUrl("data:,x").kind).toBe("keep");
    expect(classifyUrl("#f").kind).toBe("keep");
    expect(classifyUrl("#").kind).toBe("blocked");
    expect(classifyUrl("").kind).toBe("blocked");
  });
});


describe("expandImports", () => {
  const files: Record<string, string> = {
    "https://tae.test/theme/theme.css": '@import "parts/hud.css" screen;\n#menu{background:url(img/bg.png)}',
    "https://tae.test/theme/parts/hud.css": "#hud{background:url(../img/hud.gif)} @font-face{font-family:F;src:url(//fonts.test/f.woff2)}",
    "https://tae.test/loop.css": "@import url(https://tae.test/loop.css); a{color:red}",
    "https://tae.test/layered.css": "b{color:blue}",
  };
  const fetchText = async (u: string) => {
    if (u in files) return files[u];
    throw new Error("Nothing is at that link.");
  };

  it("puts each imported file where its @import was, with its links made absolute", async () => {
    const r = await expandImports('@import url("https://tae.test/theme/theme.css");\n:root{--accent:red}', null, fetchText);
    expect(r.imported).toEqual(["https://tae.test/theme/theme.css", "https://tae.test/theme/parts/hud.css"]);
    expect(r.failed).toEqual([]);
    expect(r.css.indexOf("#hud")).toBeLessThan(r.css.indexOf("#menu"));
    expect(r.css.indexOf("#menu")).toBeLessThan(r.css.indexOf(":root"));
    expect(r.css).toContain("@media screen {");
    const links = rewriteCss(r.css).remote;
    expect(links).toEqual(["https://tae.test/theme/img/hud.gif", "https://fonts.test/f.woff2", "https://tae.test/theme/img/bg.png"]);
    expect(onlySafeUrls(rewriteCss(r.css).css)).toBe(true);
  });

  it("stops loops, missing files and relative imports in pasted CSS", async () => {
    const r = await expandImports("@import url(https://tae.test/loop.css);@import url(https://tae.test/gone.css);@import url(local.css);", null, fetchText);
    expect(r.css).toContain("a{color:red}");
    expect(r.failed.map((f) => f.why).sort()).toEqual(["It imports itself.", "Nothing is at that link.", "Only https:// links import."]);
  });

  it("keeps layer, supports and media conditions", async () => {
    const r = await expandImports("@import url(https://tae.test/layered.css) layer(theme) supports(display: grid) (min-width: 800px);", null, fetchText);
    expect(r.css.replace(/\s+/g, " ").trim()).toBe("@media (min-width: 800px) { @supports (display: grid) { @layer theme { b{color:blue} } } }");
  });

  it("splits conditions", () => {
    expect(splitCondition("layer")).toEqual({ layer: "", supports: null, media: "" });
    expect(splitCondition("supports(not (display: grid)) print")).toEqual({ layer: null, supports: "not (display: grid)", media: "print" });
    expect(splitCondition("screen and (max-width: 600px)")).toEqual({ layer: null, supports: null, media: "screen and (max-width: 600px)" });
  });
});
