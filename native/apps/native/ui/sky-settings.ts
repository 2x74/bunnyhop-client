// The website's Sky group and Advanced → Sky packs (web sky-packs/settings.ts) for the native menu. The rows and words
// are the website's; the skies live with the host (sky_library.cpp): the seven built-ins, fetched once when picked,
// and the player's skies folder, where Add from a link and Import file put what they get. The host reports them in
// its state as `skies`, and does every download and decode off its frame loop.

import { composerPreset } from "../../web/src/graphics/presets";
import type * as Controls from "../../web/src/ui/controls";
import { h } from "../../web/src/ui/dom";
import { icon } from "../../web/src/ui/icons";
import { prefs } from "../../web/src/ui/settings";
import { registerSettingsSection } from "../../web/src/ui/settings-registry";
import { send } from "./bridge";

type Ui = typeof Controls;
type Ctx = { refresh: () => void };

export const SKIES_GUIDE_URL = "https://bunnyhop.lol/custom-skies";
const MORE_SKIES_URL = "https://polyhaven.com/hdris/skies";

export interface HostSky {
  id: string;
  name: string;
  source: "builtin" | "folder";
  downloaded?: boolean;
  mb?: number;
  error?: string | null;
}

export interface HostSkies {
  skies: HostSky[];
  busy: boolean;
  status: string;
  error: string;
  added: string;
}

let host: HostSkies = { skies: [], busy: false, status: "", error: "", added: "" };
let shape = "";
/** An Add from a link or Import file this menu asked for: the sky it adds gets picked. */
let adding = false;
let lastAdded: string | null = null;
let refreshAll = () => {};
const statusNodes = new Set<HTMLElement>();

/** The host's `skies` state, checked; null for anything malformed. */
export function readHostSkies(value: unknown): HostSkies | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.skies)) return null;
  const skies: HostSky[] = [];
  for (const item of raw.skies.slice(0, 64)) {
    const s = item as Record<string, unknown>;
    if (!s || typeof s.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s.id)) continue;
    if (typeof s.name !== "string" || (s.source !== "builtin" && s.source !== "folder")) continue;
    skies.push({
      id: s.id,
      name: s.name.slice(0, 100),
      source: s.source,
      downloaded: s.downloaded === true,
      mb: typeof s.mb === "number" && Number.isFinite(s.mb) ? s.mb : undefined,
      error: typeof s.error === "string" ? s.error.slice(0, 200) : null,
    });
  }
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string).slice(0, 300) : "");
  return { skies, busy: raw.busy === true, status: text("status"), error: text("error"), added: text("added") };
}

function paint(): void {
  const text =
    host.status || (host.error ? `The sky couldn't load, so the map's own sky is showing. ${host.error}` : "");
  for (const node of statusNodes) {
    if (!node.isConnected) {
      statusNodes.delete(node);
      continue;
    }
    node.querySelector(".sky-status-text")!.textContent = text;
    node.dataset.tone = host.error && !host.status ? "bad" : "";
    node.hidden = !text;
    node.querySelector<HTMLButtonElement>("button")!.hidden = !host.busy;
  }
}

/** Takes the host's state (main.ts receive): its `skies`, when it sends them. */
export function applyHostSkies(value: unknown): void {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>).skies : undefined;
  const next = readHostSkies(raw);
  if (!next) return;
  if (lastAdded === null) lastAdded = next.added;
  const added = next.added !== lastAdded ? next.added : "";
  lastAdded = next.added;
  host = next;
  if (adding && added) {
    adding = false;
    useSky(added);
  } else if (adding && !next.busy && next.error) adding = false;
  const nextShape = JSON.stringify(next.skies);
  if (nextShape !== shape) {
    shape = nextShape;
    refreshAll();
  }
  paint();
}

function listen(ctx: Ctx): void {
  refreshAll = ctx.refresh;
}

/** Shows the sky `id`. Sky packs draw in the Enhanced and Cinematic looks: Source and Plain switch to Enhanced. */
function useSky(id: string): void {
  prefs.update((p) => {
    p.graphics.skyPackId = id;
    p.graphics.skyMode = "pack";
    p.graphics.preset = composerPreset(p.graphics.preset);
  });
  refreshAll();
}

function statusNode(): HTMLElement {
  const cancel = h(
    "button.link-btn",
    { type: "button", onclick: () => send({ type: "sky", action: "cancel" }) },
    "Cancel",
  );
  const node = h("div.set-note.sky-status", { role: "status" }, h("span.sky-status-text"), cancel);
  statusNodes.add(node);
  queueMicrotask(paint);
  return node;
}

const usable = (s: HostSky) => !s.error;

function pickerOptions(): [string, string][] {
  const ready = host.skies.filter((s) => s.source === "builtin" && s.downloaded);
  return [
    ["map", "Map sky"],
    ["procedural", "Procedural daylight"],
    ...ready.map((s) => [`pack:${s.id}`, s.name] as [string, string]),
  ];
}

function addGroups(select: HTMLSelectElement): void {
  const missing = host.skies.filter((s) => s.source === "builtin" && !s.downloaded);
  if (missing.length)
    select.append(
      h(
        "optgroup",
        { label: "Download" },
        ...missing.map((s) => h("option", { value: `pack:${s.id}`, disabled: host.busy }, `${s.name} · ${s.mb} MB`)),
      ),
    );
  const folder = host.skies.filter((s) => s.source === "folder");
  if (folder.length)
    select.append(
      h(
        "optgroup",
        { label: "From your skies folder" },
        ...folder.map((s) =>
          h("option", { value: `pack:${s.id}`, disabled: !usable(s) }, s.error ? `${s.name} · ${s.error}` : s.name),
        ),
      ),
    );
}

/** The Sky group in Settings → Graphics (web settings-panel.ts calls it). */
export function skyGroup(ui: Ui, ctx: Ctx): HTMLElement {
  listen(ctx);
  const g = () => prefs.get().graphics;
  const up = (fn: (x: ReturnType<typeof g>) => void) => prefs.update((p) => fn(p.graphics));
  const known = (id: string | null) => !!id && host.skies.some((s) => s.id === id);
  const current = () =>
    g().skyMode === "pack" && known(g().skyPackId)
      ? `pack:${g().skyPackId}`
      : g().skyMode === "procedural"
        ? "procedural"
        : "map";
  const choose = (value: string) => {
    if (value.startsWith("pack:")) return useSky(value.slice(5));
    up((x) => {
      x.skyMode = value as "map" | "procedural";
      if (value === "procedural") x.preset = composerPreset(x.preset);
    });
    ctx.refresh();
  };
  const picker = ui.select<string>("Sky", current, choose, pickerOptions(), {
    desc:
      "The background behind the map. Sky packs and procedural daylight show in the Enhanced and Cinematic looks " +
      "(picking one switches Source or Plain to Enhanced); the map's openings, 3D skybox and lighting stay as they " +
      "are. Skies under Download are fetched once, when you pick them.",
    keywords: "sky skybox skies background hdr hdri panorama sky pack poly haven download sunset night clouds",
  });
  const select = picker.querySelector("select");
  if (select) {
    addGroups(select);
    select.value = current();
  }
  const isPack = () => g().skyMode === "pack" && !!g().skyPackId;
  return ui.group(
    "Sky",
    picker,
    statusNode(),
    ui.range(
      "Sky rotation",
      () => g().skyRotation,
      (v) => up((x) => (x.skyRotation = v)),
      {
        min: -180,
        max: 180,
        step: 1,
        unit: "°",
        when: isPack,
        desc: "Turns the sky pack around you. Its sun turns with it when Sky lighting is on.",
        keywords: "sky rotate turn yaw",
      },
    ),
    ui.range(
      "Sky brightness",
      () => g().skyExposure,
      (v) => up((x) => (x.skyExposure = v)),
      {
        min: -4,
        max: 4,
        step: 0.1,
        desc: "Brighter or darker sky, in stops: +1 doubles it, 0 is as it was photographed.",
        keywords: "sky exposure brightness stops",
      },
    ),
    ui.toggle("Sky lighting", () => g().lightingSource === "pack", skyLighting, {
      when: isPack,
      desc:
        "Light the map with the sky pack's sun and ambient colour (turns on sun shadows). Off keeps the map's own " +
        "lights. A sky without a sun leaves the map's lights alone.",
      keywords: "sky lighting sun ambient light source",
    }),
    h(
      "div.set-aside",
      null,
      h(
        "a.link-btn",
        { href: SKIES_GUIDE_URL, target: "_blank", rel: "noopener" },
        "How skies work",
        icon("chevronRight"),
      ),
    ),
  );
}

function skyLighting(on: boolean): void {
  prefs.update((p) => {
    p.graphics.lightingSource = on ? "pack" : "map";
    if (!on) return;
    p.graphics.dynamicShadows = true;
    if (p.graphics.lightingProfile === "map" && !p.graphics.ambienceShowcase) p.graphics.lightingProfile = "balanced";
  });
}

/** Files dropped on Settings → Graphics: the desktop client imports skies through Import file or the skies folder. */
export function skyFileKind(_name: string): null {
  return null;
}

export function importSkyFile(_file: File): void {
  host = { ...host, error: "Use Import file in Advanced → Sky packs, or put the file in your skies folder." };
  paint();
}

function addFromLink(address: string): void {
  adding = true;
  send({ type: "sky", action: "link", url: address.trim().slice(0, 2048) });
}

function linkRow(ui: Ui): HTMLElement {
  const address = h("input.text-input", {
    type: "url",
    placeholder: "polyhaven.com/a/… or https://…/sky.hdr",
    "aria-label": "Sky link",
    spellcheck: false,
    onkeydown: (e: Event) => {
      if ((e as KeyboardEvent).key === "Enter") addFromLink(address.value);
    },
  }) as HTMLInputElement;
  return ui.row(
    "Add from a link",
    h(
      "div.set-link",
      null,
      address,
      ui.button("Add", () => addFromLink(address.value)),
    ),
    {
      desc:
        "A Poly Haven HDRI page (its 2k file is used), a direct 2:1 panorama (.hdr, PNG or JPEG) or a .bhsky.json sky " +
        "pack. Fetched through bunnyhop.lol, so the host never sees you. It's saved in your skies folder.",
      keywords: "sky link url download poly haven hdri hdr png jpg jpeg bhsky add",
    },
  );
}

function removeRows(ui: Ui): HTMLElement[] {
  const removable = host.skies.filter((s) => s.source === "folder" || s.downloaded);
  return removable.map((s) =>
    ui.actions(s.name, [ui.button("Remove", () => removeSky(s.id))], {
      keywords: "installed sky pack remove delete",
    }),
  );
}

function removeSky(id: string): void {
  if (prefs.get().graphics.skyPackId === id)
    prefs.update((p) => {
      p.graphics.skyPackId = null;
      p.graphics.skyMode = "map";
    });
  send({ type: "sky", action: "remove", id });
}

// Advanced → Sky packs: adding skies from elsewhere, the skies folder, and removing skies.
registerSettingsSection(
  "sky-packs",
  (ui, ctx) => {
    listen(ctx);
    const importFile = () => {
      adding = true;
      send({ type: "sky", action: "import" });
    };
    return [
      ui.group(
        "Sky packs",
        linkRow(ui),
        ui.row(
          "More skies",
          h("a.btn.btn-sm", { href: MORE_SKIES_URL, target: "_blank", rel: "noopener" }, "Poly Haven"),
          {
            desc: "Free (CC0) sky photographs. Copy a sky's page link into Add from a link.",
            keywords: "more skies browse poly haven free hdri",
          },
        ),
        ui.row("Sky file", ui.button("Import file", importFile), {
          desc: "A 2:1 panorama (.hdr, PNG or JPEG, up to 4096×2048 is kept) or a .bhsky.json sky pack.",
          keywords: "import sky pack file bhsky hdr png jpg jpeg picture",
        }),
        ui.row(
          "Skies folder",
          ui.button("Open skies folder", () => send({ type: "sky", action: "openFolder" })),
          {
            desc: ".hdr, PNG, JPEG and .bhsky.json files in this folder show in the Sky picker as soon as they're saved there.",
            keywords: "skies folder desktop app open files hdr bhsky",
          },
        ),
        ...removeRows(ui),
      ),
    ];
  },
  { advancedUnder: "graphics", label: "Sky packs", icon: "graphics", order: 74 },
);
