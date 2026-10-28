// Credits: the website's /credits page in the menu (credits-document.ts, the site's page verbatim). Its map table is
// filled from the live map index by the web's own renderCreditsPage, as the site's build does. The native client's
// own libraries follow the site's "Engine and code".
//
// In-page links scroll here (main.ts); every other link goes through the menu's link handling to the browser.
import { CREDITS_PAGE as creditsPage } from "./credits-document";
import "../../web/src/about/legal.css";
import { renderCreditsPage, type CreditMap } from "../../web/src/about/credits-page";
import { h } from "../../web/src/ui/dom";
import { fetchMapIndex } from "../../web/src/ui/maps";

/** Libraries compiled into the native client (vendor/README.md, packaging/licenses/). */
const NATIVE_LIBRARIES: readonly { name: string; url: string; licence: string }[] = [
  { name: "SDL 3", url: "https://github.com/libsdl-org/SDL", licence: "zlib" },
  { name: "nlohmann/json", url: "https://github.com/nlohmann/json", licence: "MIT" },
  {
    name: "dr_libs (dr_wav, dr_mp3, dr_flac)",
    url: "https://github.com/mackron/dr_libs",
    licence: "MIT-0 or public domain",
  },
  { name: "stb_vorbis", url: "https://github.com/nothings/stb", licence: "MIT or public domain" },
  { name: "Unicode Character Database", url: "https://www.unicode.org/", licence: "Unicode License v3" },
  {
    name: "Microsoft Edge WebView2 (Windows)",
    url: "https://developer.microsoft.com/microsoft-edge/webview2/",
    licence: "Microsoft software licence",
  },
];

/** The page's <main> (contributors, maps, zones, code, fonts, art and audio) and its footer disclaimer. */
function pageParts(html: string): { main: HTMLElement; disclaimer: HTMLElement | null } {
  const page = new DOMParser().parseFromString(html, "text/html");
  const main = page.querySelector<HTMLElement>("main.legal") ?? h("main.legal");
  const disclaimer = page.querySelector<HTMLElement>(".credits-disclaimer");
  return {
    main: document.importNode(main, true),
    disclaimer: disclaimer ? document.importNode(disclaimer, true) : null,
  };
}

function nativeSection(): HTMLElement {
  const items = NATIVE_LIBRARIES.map((library) =>
    h("li", null, h("a", { href: library.url }, library.name), ` — ${library.licence}.`),
  );
  return h(
    "section",
    { "aria-labelledby": "native" },
    h("h2", { id: "native" }, "Desktop client"),
    h("p", null, "The desktop client also includes:"),
    h("ul", null, ...items),
  );
}

/** The map index as the credits table reads it (licence and source come from the catalogue). */
function creditMaps(maps: readonly object[]): CreditMap[] {
  return maps.map((map) => {
    const entry = map as Record<string, unknown>;
    const text = (key: string) => (typeof entry[key] === "string" ? (entry[key] as string) : null);
    return {
      name: String(entry.name),
      author: text("author"),
      url: text("url"),
      license: text("license"),
      source: text("source"),
    };
  });
}

export function creditsPanel(): HTMLElement {
  const { main, disclaimer } = pageParts(renderCreditsPage(creditsPage, []));
  main.querySelector("h1")?.remove();
  main.querySelector('section[aria-labelledby="code"]')?.after(nativeSection());
  const mapsSection = main.querySelector('section[aria-labelledby="maps"]');
  const body = h("div.native-credits-body", null, main, disclaimer);
  void fetchMapIndex()
    .then((maps) => {
      if (!mapsSection) return;
      const filled = pageParts(renderCreditsPage(creditsPage, creditMaps(maps)));
      const section = filled.main.querySelector('section[aria-labelledby="maps"]');
      if (section && mapsSection) mapsSection.replaceWith(section);
    })
    .catch(() => {});
  return body;
}
