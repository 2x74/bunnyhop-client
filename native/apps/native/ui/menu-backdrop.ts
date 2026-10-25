// The map behind the native menus, layered like the web's (style.css #game + #overlay): the scene first, the
// overlay's scrim over it. The web draws the background map live (attract.ts); natively the host does, behind the
// transparent menu view, and this file only asks for it and follows what the host reports:
//
//   UI → host   {type:"menuBackdrop", map}    home screen with no map loaded: the map backgroundPick() chose
//                                              (featured.ts), or null to release it.
//   host → UI   bunnyhopNativeBackdrop(source, map)
//               "native"            the live scene is on screen behind the view (html[data-native-backdrop=scene])
//               "data:image/png…"   a still of it, shown in #native-backdrop (html[data-native-backdrop=static])
//               "cut"               the tour cuts: fade through black until the next "native"
//               "none"              no scene (loading failed, released): the map's own picture again
//
// Until the host has a scene (and whenever it has none), #native-backdrop shows the same map's 1280×720 render from
// bunnyhop.lol, so the menu never stands on a blank background.

import { mapArt } from "../../web/src/ui/thumbs";
import { send, state } from "./bridge";

const MAP_ID = /^[a-zA-Z0-9_.-]{1,128}$/;
const MAX_PNG = 2_000_000;

let requested: string | null = null;
let sent: string | null | undefined;
let artMap: string | null = null;
let source: "scene" | "static" | null = null;
let layer: HTMLElement | null = null;

declare global {
  interface Window { bunnyhopNativeBackdrop?: (source: string, map?: string) => void }
}

function root(): HTMLElement {
  layer ??= document.getElementById("native-backdrop") ?? document.body.insertBefore(Object.assign(document.createElement("div"), { id: "native-backdrop" }), document.body.firstChild);
  layer.setAttribute("aria-hidden", "true");
  return layer;
}

/** The map the background should show: the loaded map in game, else the home screen's pick. */
const wanted = () => state.map ?? requested;

function live(on: boolean): void {
  document.body.classList.toggle("attract-live", on);
  if (!on) document.body.classList.remove("attract-cut");
}

/** The map's picture under the scrim (no host scene, or until it's ready). */
function paintArt(): void {
  const map = wanted();
  if (source === "static") return;
  if (!map) {
    artMap = null;
    root().querySelector(".native-backdrop-art")?.remove();
    if (!source) live(false);
    return;
  }
  if (artMap === map && root().querySelector(".native-backdrop-art")) return;
  artMap = map;
  const art = mapArt(map, null, { className: "native-backdrop-art", size: "hero", eager: true, priority: true });
  const ready = () => artMap === map && (source || art.classList.contains("loaded") || art.querySelector("img.lqip")) && live(true);
  art.addEventListener("load", ready, { capture: true });
  for (const old of root().querySelectorAll(".native-backdrop-art, .native-backdrop-still")) old.remove();
  root().append(art);
  ready();
}

function setSource(next: "scene" | "static" | null): void {
  source = next;
  if (next) document.documentElement.dataset.nativeBackdrop = next;
  else delete document.documentElement.dataset.nativeBackdrop;
}

/** Home screen (no map loaded): ask the host for this map's scene. Same map again: nothing. */
export function requestBackdrop(map: string | null): void {
  if (map !== null && !MAP_ID.test(map)) map = null;
  requested = map;
  if (!state.map && !state.loading && sent !== map) {
    sent = map;
    send({ type: "menuBackdrop", map });
  }
  paintArt();
}

/** Host state changed (a map loaded or unloaded): the art follows the map in view. */
export function syncBackdrop(): void {
  // A gameplay map (loading or loaded) replaces the home scene and the host drops home requests meanwhile; back on
  // the home screen (also after a failed load) it's asked for again.
  if (state.map || state.loading) sent = undefined;
  else if (requested !== null && sent !== requested) requestBackdrop(requested);
  paintArt();
}

export function installMenuBackdrop(): void {
  root();
  window.bunnyhopNativeBackdrop = (src: string, map?: string) => {
    if (typeof src !== "string") return;
    // Stale: a scene for a map that's neither the loaded one nor the one last asked for. ("" is no map: the release.)
    const target = map === "" ? null : map;
    if (target !== undefined && target !== state.map && target !== requested) return;
    if (src === "native") {
      setSource("scene");
      document.body.classList.remove("attract-cut");
      live(true);
    } else if (src === "cut") {
      if (source === "scene" && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.body.classList.add("attract-cut");
    } else if (src === "none") {
      setSource(null);
      document.body.classList.remove("attract-cut");
      artMap = null;
      paintArt();
    } else if (src.length <= MAX_PNG && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(src)) {
      const image = new Image();
      image.className = "native-backdrop-still";
      image.alt = "";
      image.onload = () => {
        if (target !== undefined && target !== wanted()) return;
        for (const old of root().querySelectorAll(".native-backdrop-art, .native-backdrop-still")) if (old !== image) old.remove();
        artMap = null;
        root().append(image);
        setSource("static");
        live(true);
      };
      image.src = src;
    }
  };
}
