// Settings → Graphics → Sky: one picker for the map's own sky, procedural daylight, the installed sky packs, a short
// list of skies to download (sources.ts) and, in the desktop app, the skies folder (folder.ts), plus Advanced → Sky packs
// (add from a link or a file, save, remove, open the skies folder). A sky file (.hdr, PNG/JPEG/WebP, .bhsky.json) dropped on Settings while
// Graphics is open is imported like a file (ui/settings-panel.ts calls importSkyFile). The guide is /custom-skies.
// Nothing downloads until a player picks a sky; the converters (from-hdr.ts, from-image.ts) load only for such a sky.
import { openClientSkiesFolder } from "../client-bridge";
import { composerPreset } from "../graphics/presets";
import type * as Controls from "../ui/controls";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { prefs } from "../ui/settings";
import { registerSettingsSection } from "../ui/settings-registry";
import { folderSkies, folderSkiesAvailable, folderSkiesKnown, folderSkyPack, isFolderSkyId, startFolderSkies, watchFolderSkies } from "./folder";
import { SKY_LIMITS, type SkyPack } from "./manifest";
import { CURATED_SKIES, MORE_SKIES_URL, parseSkyLink, polyhavenHdr, polyhavenInfo, skyIdFrom, type CuratedSky, type SkyClouds } from "./sources";
import { downloadSkyPack, fetchSkyBytes, installedSkyPacks, installSkyPack, removeSkyPack, watchSkyPacks, type InstalledSkyPack } from "./store";

type Ui = typeof Controls;
type Ctx = { refresh: () => void };

let records: InstalledSkyPack[] = [];
let loaded = false;
let controller: AbortController | null = null;
/** One line under the picker: a download's progress or what went wrong; empty when there's nothing to say. */
let status = "";
let tone: "" | "bad" = "";
const statusNodes = new Set<HTMLElement>();
/** Re-renders the Graphics section on screen (the picker and Advanced → Sky packs share its ctx). */
let refreshAll = () => {};
/** The skies guide (apps/web/custom-skies.html). */
export const SKIES_GUIDE_URL = "https://bunnyhop.lol/custom-skies";

// A folder sky that's selected and then leaves the folder: back to the map's sky.
watchFolderSkies(() => {
  const g = prefs.get().graphics;
  if (g.skyMode === "pack" && isFolderSkyId(g.skyPackId) && folderSkiesKnown() && !folderSkies().some((s) => s.id === g.skyPackId && !s.error))
    prefs.update((p) => {
      p.graphics.skyMode = "map";
      p.graphics.skyPackId = null;
    });
  refreshAll();
});

function paint(): void {
  for (const n of statusNodes) {
    if (!n.isConnected) {
      statusNodes.delete(n);
      continue;
    }
    n.querySelector(".sky-status-text")!.textContent = status;
    n.dataset.tone = tone;
    n.hidden = !status;
    n.querySelector<HTMLButtonElement>("button")!.hidden = !controller;
  }
}
function say(text: string, bad = false): void {
  status = text;
  tone = bad ? "bad" : "";
  paint();
}

function load(ctx: Ctx): void {
  refreshAll = ctx.refresh;
  if (loaded) return;
  loaded = true;
  const reload = async () => {
    records = await installedSkyPacks();
    refreshAll();
  };
  // The composer reports the selected sky's state (graphics/composer-pipeline.ts) on document.
  document.addEventListener("bunnyhop:sky-status", (event) => {
    const d = (event as CustomEvent).detail;
    if ((window as { bunnyhop?: { graphicsPipeline?: unknown } }).bunnyhop?.graphicsPipeline !== d?.pipeline || controller) return;
    if (d.loading) say(LOADING);
    else if (d.error) say(`The sky couldn't load, so the map's own sky is showing. ${d.error}`, true);
    else if (status === LOADING) say("");
  });
  watchSkyPacks(() => void reload());
  void reload().catch((e) => say(String((e as Error).message ?? e), true));
}

const LOADING = "Loading the sky…";
/** A curated sky by its name in the list ("Clear day", not the hosted file's "Clear Day · Poly Haven"). */
const skyName = (pack: SkyPack) => CURATED_SKIES.find((c) => c.id === pack.id)?.name ?? pack.name;
const mb = (n: number) => (n / 1048576).toFixed(1);

/** Runs one download / import at a time, with progress and Cancel in the status line; selects the sky it added. */
function run(label: string, task: (signal: AbortSignal, progress: (n: number, total: number) => void) => Promise<string | SkyPack>): void {
  if (controller) return;
  const c = (controller = new AbortController());
  say(`${label}…`);
  // Re-render once so the other download buttons and the picker's Download list are disabled meanwhile.
  refreshAll();
  void task(c.signal, (n, total) => say(`${label}… ${mb(n)}${total ? ` / ${mb(total)}` : ""} MB`))
    .then(async (sky) => {
      records = await installedSkyPacks();
      controller = null;
      say("");
      if (typeof sky === "string") useSky(sky);
      else useSky(sky.id, sky);
    })
    .catch((e) => {
      controller = null;
      if (c.signal.aborted) say("");
      else say(String((e as Error).message ?? e), true);
    })
    .finally(refreshAll);
}

/** Shows the sky `id`. Sky packs draw in the Enhanced / Cinematic looks: Source and Plain switch to Enhanced. */
function useSky(id: string, pack = records.find((r) => r.pack.id === id)?.pack): void {
  const was = prefs.get().graphics.preset;
  prefs.update((p) => {
    p.graphics.skyPackId = id;
    p.graphics.skyMode = "pack";
    p.graphics.preset = composerPreset(p.graphics.preset);
    // A photograph has its clouds in it: volumetric clouds on top would double them.
    if (pack?.clouds === "photographic") p.graphics.clouds = false;
  });
  if (composerPreset(was) !== was) say("Sky packs show in the Enhanced look, so Look is now Enhanced.");
  refreshAll();
}

async function hdrSky(url: string, src: { id: string; name: string; clouds: SkyClouds; sourceURL: string; license?: string }, signal: AbortSignal, progress: (n: number, total: number) => void): Promise<string> {
  const bytes = await fetchSkyBytes(url, signal, progress, SKY_LIMITS.compressed);
  const { skyPackFromHdr } = await import("./from-hdr");
  const pack = await skyPackFromHdr(bytes, src);
  signal.throwIfAborted();
  await installSkyPack(pack, signal);
  return pack.id;
}

/** Installs a PNG / JPEG / WebP panorama's sky pack (from-image.ts) and returns its id. */
async function imageSky(bytes: Uint8Array, src: { id: string; name: string; sourceURL: string }, signal: AbortSignal): Promise<string> {
  const { skyPackFromImage } = await import("./from-image");
  const pack = await skyPackFromImage(bytes, { ...src, clouds: "photographic" });
  signal.throwIfAborted();
  await installSkyPack(pack, signal);
  return pack.id;
}
const fileName = (url: string) => decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "sky");
const PICTURE = /\.(png|jpe?g|webp)$/i;
/** A PNG, JPEG or WebP file's first bytes. */
const isPicture = (b: Uint8Array) => (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x52 && b[8] === 0x57);

function getCurated(c: CuratedSky): void {
  run(`Downloading ${c.name}`, async (signal, progress) => {
    if (c.kind === "hosted") {
      await downloadSkyPack(c.path, signal, progress);
      return c.id;
    }
    return hdrSky(polyhavenHdr(c.asset), { id: c.id, name: c.name, clouds: c.clouds, sourceURL: `https://polyhaven.com/a/${c.asset}`, license: "CC0-1.0" }, signal, progress);
  });
}

function addFromLink(raw: string): void {
  const link = parseSkyLink(raw);
  if (!link) return say("Paste an https:// link: a Poly Haven HDRI page, a .hdr or PNG/JPEG panorama, or a .bhsky.json sky pack.", true);
  run("Downloading the sky", async (signal, progress) => {
    if (link.kind === "pack" || link.kind === "image") {
      const bytes = await fetchSkyBytes(link.url, signal, progress);
      const name = fileName(link.url).replace(PICTURE, "") || "sky";
      // A picture's link without its extension (an image host's /i/abc) is still a picture.
      if (link.kind === "image" || isPicture(bytes)) return imageSky(bytes, { id: skyIdFrom(name), name, sourceURL: link.url }, signal);
      const pack = JSON.parse(new TextDecoder().decode(bytes)) as SkyPack;
      await installSkyPack(pack, signal);
      return pack.id;
    }
    if (link.kind === "hdr") {
      const file = fileName(link.url);
      return hdrSky(link.url, { id: skyIdFrom(file), name: file.replace(/\.hdr$/i, ""), clouds: "photographic", sourceURL: link.url }, signal, progress);
    }
    // Poly Haven: its name and whether the sky is clear come from its metadata (a plain id if that fails).
    let name = link.asset, clouds: SkyClouds = "photographic";
    try {
      const info = JSON.parse(new TextDecoder().decode(await fetchSkyBytes(polyhavenInfo(link.asset), signal, () => {}, 1024 * 1024))) as { name?: unknown; categories?: unknown };
      if (typeof info.name === "string") name = info.name.replace(/\s*\(Pure Sky\)\s*$/i, "");
      if (Array.isArray(info.categories) && info.categories.includes("clear") && !info.categories.includes("partly cloudy")) clouds = "clear";
    } catch {
      signal.throwIfAborted();
    }
    return hdrSky(polyhavenHdr(link.asset), { id: link.asset, name, clouds, sourceURL: `https://polyhaven.com/a/${link.asset}`, license: "CC0-1.0" }, signal, progress);
  });
}

/** What a file is by its name: a .hdr panorama, a PNG / JPEG / WebP panorama, a sky pack (.bhsky.json, or any .json), or neither. */
export function skyFileKind(name: string): "hdr" | "image" | "pack" | null {
  return /\.hdr$/i.test(name) ? "hdr" : PICTURE.test(name) ? "image" : /\.json$/i.test(name) ? "pack" : null;
}

/** Imports a .hdr, PNG / JPEG / WebP or .bhsky.json file (Import file, or dropped on Settings → Graphics) and selects it. */
export function importSkyFile(file: File): void {
  const kind = skyFileKind(file.name);
  if (!kind) return say("Skies are 2:1 panoramas (.hdr, PNG, JPEG or WebP) or .bhsky.json sky packs.", true);
  run("Importing the sky", async (signal) => {
    if (kind === "image") {
      if (file.size > SKY_LIMITS.compressed) throw Error("That picture is over 32 MB. Use a 4096×2048 one.");
      const name = file.name.replace(PICTURE, "");
      return imageSky(new Uint8Array(await file.arrayBuffer()), { id: skyIdFrom(name), name, sourceURL: file.name }, signal);
    }
    if (kind === "hdr") {
      if (file.size > SKY_LIMITS.compressed) throw Error("That sky is too big. Use the 2k version.");
      const { skyPackFromHdr } = await import("./from-hdr");
      const name = file.name.replace(/\.hdr$/i, "");
      const pack = await skyPackFromHdr(new Uint8Array(await file.arrayBuffer()), { id: skyIdFrom(name), name, clouds: "photographic", sourceURL: file.name });
      signal.throwIfAborted();
      await installSkyPack(pack, signal);
      return pack.id;
    }
    if (file.size > SKY_LIMITS.file) throw Error("That sky file is over 45 MB.");
    let pack: SkyPack;
    try {
      pack = JSON.parse(await file.text()) as SkyPack;
    } catch {
      throw Error("That file isn't a sky pack.");
    }
    await installSkyPack(pack, signal);
    return pack.id;
  });
}

/** Picks a sky from the skies folder: made into a sky pack first (once per version of the file). */
function useFolderSky(id: string, name: string): void {
  run(`Loading ${name}`, () => folderSkyPack(id));
}

function statusNode(): HTMLElement {
  const n = h("div.set-note.sky-status", { role: "status" }, h("span.sky-status-text"), h("button.link-btn", { type: "button", onclick: () => controller?.abort() }, "Cancel"));
  statusNodes.add(n);
  queueMicrotask(paint);
  return n;
}

/** The Sky group in Settings → Graphics (settings-panel.ts). */
export function skyGroup(ui: Ui, ctx: Ctx): HTMLElement {
  load(ctx);
  const g = () => prefs.get().graphics;
  const up = (fn: (x: ReturnType<typeof g>) => void) => prefs.update((p) => fn(p.graphics));
  const folder = folderSkiesAvailable() ? (startFolderSkies(), folderSkies()) : [];
  const installed = new Set([...records.map((r) => r.pack.id), ...folder.filter((s) => !s.error).map((s) => s.id)]);
  const current = () => (g().skyMode === "pack" && g().skyPackId && installed.has(g().skyPackId!) ? `pack:${g().skyPackId}` : g().skyMode === "procedural" ? "procedural" : "map");
  const picker = ui.select<string>("Sky", current, (v) => {
    if (v.startsWith("get:")) {
      const c = CURATED_SKIES.find((x) => x.id === v.slice(4));
      if (c) getCurated(c);
      (picker.querySelector("select") as HTMLSelectElement).value = current();
    } else if (v.startsWith("pack:") && isFolderSkyId(v.slice(5))) {
      const s = folder.find((x) => x.id === v.slice(5));
      if (s) useFolderSky(s.id, s.name);
      (picker.querySelector("select") as HTMLSelectElement).value = current();
    } else if (v.startsWith("pack:")) useSky(v.slice(5));
    else {
      up((x) => {
        x.skyMode = v as "map" | "procedural";
        if (v === "procedural") x.preset = composerPreset(x.preset);
      });
      ctx.refresh();
    }
  }, [
    ["map", "Map sky"],
    ["procedural", "Procedural daylight"],
    ...records.map((r) => [`pack:${r.pack.id}`, skyName(r.pack)] as [string, string]),
  ], {
    desc: "The background behind the map. Sky packs and procedural daylight show in the Enhanced and Cinematic looks (picking one switches Source or Plain to Enhanced); the map's openings, 3D skybox and lighting stay as they are. Skies under Download are fetched once, when you pick them.",
    keywords: "sky skybox skies background hdr hdri panorama sky pack poly haven download sunset night clouds",
  });
  const missing = CURATED_SKIES.filter((c) => !installed.has(c.id));
  if (missing.length) {
    const sel = picker.querySelector("select")!;
    sel.append(h("optgroup", { label: "Download" }, ...missing.map((c) => h("option", { value: `get:${c.id}`, disabled: !!controller }, `${c.name} · ${c.mb} MB`))));
  }
  // The skies folder: its skies, and the files that can't be used with why (greyed out).
  if (folder.length) {
    const sel = picker.querySelector("select")!;
    sel.append(h("optgroup", { label: "From your skies folder" }, ...folder.map((s) => h("option", { value: `pack:${s.id}`, disabled: !!s.error || !!controller }, s.error ? `${s.name} · ${s.error}` : s.name))));
    sel.value = current();
  }
  const isPack = () => g().skyMode === "pack" && !!g().skyPackId;
  return ui.group(
    "Sky",
    picker,
    statusNode(),
    ui.range("Sky rotation", () => g().skyRotation, (v) => up((x) => (x.skyRotation = v)), { min: -180, max: 180, step: 1, unit: "°", when: isPack, desc: "Turns the sky pack around you. Its sun turns with it when Sky lighting is on.", keywords: "sky rotate turn yaw" }),
    ui.range("Sky brightness", () => g().skyExposure, (v) => up((x) => (x.skyExposure = v)), { min: -4, max: 4, step: 0.1, when: isPack, desc: "Brighter or darker sky pack, in stops: +1 doubles it, 0 is as it was photographed.", keywords: "sky exposure brightness stops" }),
    ui.toggle("Sky lighting", () => g().lightingSource === "pack", (v) => up((x) => {
      x.lightingSource = v ? "pack" : "map";
      if (v) {
        x.dynamicShadows = true;
        if (x.lightingProfile === "map" && !x.ambienceShowcase) x.lightingProfile = "balanced";
      }
    }), { when: isPack, desc: "Light the map with the sky pack's sun and ambient colour (turns on sun shadows). Off keeps the map's own lights. A sky without a sun leaves the map's lights alone.", keywords: "sky lighting sun ambient light source" }),
    h("div.set-aside", null, h("a.link-btn", { href: SKIES_GUIDE_URL, target: "_blank", rel: "noopener" }, "How skies work", icon("chevronRight"))),
  );
}

// Advanced → Sky packs: adding skies from elsewhere, and the installed ones.
registerSettingsSection("sky-packs", (ui, ctx) => {
  load(ctx);
  const input = h("input", { type: "file", accept: ".hdr,.png,.jpg,.jpeg,.webp,.bhsky.json,application/json", hidden: true, onchange: () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) importSkyFile(file);
  } }) as HTMLInputElement;
  const address = h("input.text-input", { type: "url", placeholder: "polyhaven.com/a/… or https://…/sky.png", "aria-label": "Sky link", spellcheck: false, onkeydown: (e: Event) => {
    if ((e as KeyboardEvent).key === "Enter") addFromLink(address.value);
  } }) as HTMLInputElement;
  const save = (r: InstalledSkyPack) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(r.pack)], { type: "application/json" }));
    h("a", { href: url, download: `${r.pack.id}.bhsky.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const remove = async (id: string) => {
    if (prefs.get().graphics.skyPackId === id) prefs.update((p) => {
      p.graphics.skyPackId = null;
      p.graphics.skyMode = "map";
    });
    await removeSkyPack(id);
  };
  return [
    ui.group(
      "Sky packs",
      ui.row("Add from a link", h("div.set-link", null, address, ui.button("Add", () => addFromLink(address.value), { disabled: !!controller })), {
        desc: "A Poly Haven HDRI page (its 2k file is used), a direct 2:1 panorama (.hdr, PNG, JPEG or WebP) or a .bhsky.json sky pack. Fetched through bunnyhop.lol, so the host never sees you.",
        keywords: "sky link url download poly haven hdri hdr png jpg jpeg webp anime bhsky add",
      }),
      ui.row("More skies", h("a.btn.btn-sm", { href: MORE_SKIES_URL, target: "_blank", rel: "noopener" }, "Poly Haven"), { desc: "Free (CC0) sky photographs. Copy a sky's page link into Add from a link.", keywords: "more skies browse poly haven free hdri" }),
      ui.row("Sky file", h("div.btn-row", null, input, ui.button("Import file", () => input.click(), { disabled: !!controller })), { desc: "A 2:1 panorama (.hdr, PNG, JPEG or WebP, up to 4096×2048 is kept) or a .bhsky.json sky pack. You can also drop one on this page.", keywords: "import sky pack file bhsky hdr png jpg jpeg webp anime picture drop drag" }),
      folderSkiesAvailable() ? ui.row("Skies folder", ui.button("Open skies folder", openClientSkiesFolder), { desc: ".hdr, PNG, JPEG, WebP and .bhsky.json files in this folder show in the Sky picker as soon as they're saved there.", keywords: "skies folder desktop app open files hdr bhsky" }) : null,
      ...records.map((r) => ui.actions(skyName(r.pack), [ui.button("Save", () => save(r), { title: `Save ${r.pack.id}.bhsky.json` }), ui.button("Remove", () => void remove(r.pack.id).catch((e) => say(String((e as Error).message ?? e), true)))], {
        keywords: "installed sky pack remove delete save export",
      })),
    ),
  ];
}, { advancedUnder: "graphics", label: "Sky packs", icon: "graphics", order: 74 });
