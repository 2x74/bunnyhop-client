// Images in the Wavedash build. The frame is cross-origin isolated (COEP require-corp), so an image from another origin
// loads only as a CORS request (crossorigin) or with a Cross-Origin-Resource-Policy header. bunnyhop.lol sends the
// header (apps/api src/index.ts, tools/scripts/build-site.ts); Discord's avatar CDN only answers CORS. And the site's
// image paths ("/thumbs/x.jpg?v=...", in the map index and API answers) are root-relative: on the frame's origin they
// would 404. So, in this build only, every <img> asks for CORS and root-relative sources go to bunnyhop.lol, whichever
// way the source is set (img.src = ..., setAttribute, the ui/dom.ts h() helper). The site's images are asked for under
// their own cache key (env.ts freshKey), like map files.

import { freshKey, isSiteImage, siteUrl, WAVEDASH } from "./env";

export function installImages(): void {
  if (!WAVEDASH || typeof HTMLImageElement === "undefined") return;
  const proto = HTMLImageElement.prototype;
  const src = Object.getOwnPropertyDescriptor(proto, "src");
  if (!src?.set || !src.get) return;
  const setSrc = src.set;
  const prepare = (img: HTMLImageElement, v: string): string => {
    if (!v.startsWith("data:") && !v.startsWith("blob:") && img.crossOrigin === null) img.crossOrigin = "anonymous";
    const url = siteUrl(v);
    return isSiteImage(url) ? freshKey(url) : url;
  };
  Object.defineProperty(proto, "src", {
    configurable: true,
    enumerable: src.enumerable,
    get: src.get,
    set(this: HTMLImageElement, v: string) {
      setSrc.call(this, prepare(this, String(v)));
    },
  });
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if (this instanceof HTMLImageElement && name.toLowerCase() === "src") value = prepare(this, String(value));
    return setAttribute.call(this, name, value);
  };
}
