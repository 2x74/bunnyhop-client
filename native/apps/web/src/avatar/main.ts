// The avatar editor (/avatar, avatar.html): your bunny in what you own, posed and framed, over a backdrop. "Use as my
// avatar" saves it to your account (the picture on the boards, your profile and the friends dock: apps/api/src/
// bunny-avatar.ts); Download / Copy give a PNG (any backdrop, "Clear" for a transparent one) to use anywhere else.
//
// Signed in, the choices are what your account owns (GET /me/cosmetics, the same rules the server checks on save) and the
// editor opens on your saved avatar, else your default pose in the loadout you wear. Without a session (or offline) it
// offers the free items, opens on this browser's loadout and keeps a draft here; the PNG still works. Dev: ?all lists
// every item.
//
// Cosmetics (colourway, headwear, knife, finish, gloves) are picked from 3D thumbnails: a row per slot shows what you
// wear, clicking it turns the controls column into that slot's picker, hovering a choice puts it on the big preview
// (until the pointer leaves), clicking wears it. Thumbnails are drawn by a second, offscreen AvatarStage and cached.

import { api, ApiError, type User } from "../api";
import { COSMETICS, cosmetic, type CosmeticDef } from "../progression";
import { FINISH_STYLE, GLOVE_STYLE, HAIR_DEFAULT, HAIR_LENGTH, HAIR_PRESETS, LENGTH_HATS, hairColorOf, hairHex, isWig } from "../loadout";
import { glowColorPicker } from "../ui/glow-color-picker";
import { KNIVES } from "../viewmodel/knives/index";
import { GUNS } from "../viewmodel/guns/index";
import { isHat } from "../player/bunny/hats";
import { AvatarStage, GESTURES, paintBackdrop, type Focus, type MapShots } from "./stage";
import { avatarWebpBase64, mapIndex, playerAnims, settleOnAnims } from "./refresh";
import { getLoadout, getOutfit } from "../player/cosmetics";
import { AVATAR_PX, AVATAR_RENDER_VERSION, BACKDROPS, cleanAvatar, defaultAvatar, defaultBg, FRAMES, GUN_IDS, packAvatar, POSES, type AvatarSpec } from "./spec";

const q = new URLSearchParams(location.search);
const DRAFT_KEY = "bunnyhop:avatar-draft";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------------------------------------
// What you can pick

let unlocked = new Set<string>();
let showAll = import.meta.env.DEV && q.has("all");
const owns = (c: CosmeticDef | null | undefined): boolean => !!c && (showAll || c.unlock.kind === "free" || unlocked.has(c.id));
const ofSlot = (slot: CosmeticDef["slot"]) => COSMETICS.filter((c) => c.slot === slot && owns(c));

interface Options {
  outfits: CosmeticDef[];
  hats: CosmeticDef[];
  knives: CosmeticDef[];
  finishes: CosmeticDef[];
  gloves: CosmeticDef[];
}
function options(): Options {
  return {
    outfits: ofSlot("outfit"),
    hats: ofSlot("hat").filter((c) => isHat(c.id)),
    knives: KNIVES.map((k) => cosmetic(k.cosmeticId)).filter((c): c is CosmeticDef => owns(c)),
    finishes: ofSlot("finish").filter((c) => FINISH_STYLE[c.id]),
    gloves: ofSlot("glove").filter((c) => GLOVE_STYLE[c.id]),
  };
}

/** The spec with anything you don't own put back to the default for that slot. */
function ownedOnly(s: AvatarSpec): AvatarSpec {
  const d = defaultAvatar("", null);
  const ok = (id: string | null) => !id || owns(cosmetic(id));
  return cleanAvatar({
    ...s,
    outfit: ok(s.outfit) ? s.outfit : d.outfit,
    hat: ok(s.hat) ? s.hat : null,
    // Hair settings only with a wig you own on (the server checks them like the hat).
    hairColor: s.hat && isWig(s.hat) && ok(s.hat) ? s.hairColor : undefined,
    hairLength: s.hat && isWig(s.hat) && ok(s.hat) ? s.hairLength : undefined,
    knife: ok(s.knife) ? s.knife : d.knife,
    finish: ok(s.finish) ? s.finish : d.finish,
    glove: ok(s.glove) ? s.glove : d.glove,
    bg: s.bg.startsWith("outfit:") && !ok(s.bg.slice(7)) ? defaultBg(d.outfit) : s.bg,
  });
}

// ---------------------------------------------------------------------------------------------
// State

let spec: AvatarSpec = defaultAvatar("guest", null);
let user: User | null = null;
let signedIn = false;
let custom = false;
let mapList: { name: string; hero: string }[] = [];
const maps: MapShots = { hero: (name) => mapList.find((m) => m.name === name)?.hero ?? null };

/** A choice being hovered in a picker (or a backdrop swatch): shown on the big preview, not saved. */
let preview: Partial<AvatarSpec> | null = null;
const shown = (): AvatarSpec => (preview ? cleanAvatar({ ...spec, ...preview }) : spec);
function setPreview(p: Partial<AvatarSpec> | null): void {
  preview = p;
  draw();
}

const stage = new AvatarStage($("av-gl") as HTMLCanvasElement);
const view = $("av-view");
const bgCanvas = $("av-bg") as HTMLCanvasElement;

function setSpec(patch: Partial<AvatarSpec>, o: { quiet?: boolean } = {}): void {
  spec = cleanAvatar({ ...spec, ...patch });
  if (!signedIn) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(spec));
    } catch {
      /* private mode */
    }
  }
  draw();
  if (!o.quiet) renderControls();
  status("");
}

// ---------------------------------------------------------------------------------------------
// Drawing

let bgKey = "";
let drawQueued = false;
function draw(): void {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    const px = Math.round(view.clientWidth * Math.min(2, devicePixelRatio || 1));
    if (!px) return;
    const s = shown();
    stage.set(s);
    stage.draw(px, px);
    const key = `${s.bg}|${px}`;
    if (key !== bgKey) {
      bgKey = key;
      bgCanvas.width = bgCanvas.height = px;
      void paintBackdrop(bgCanvas.getContext("2d")!, s.bg, px, maps);
    }
    view.classList.toggle("is-clear", s.bg === "clear");
    if (!preview) scheduleSmall();
  });
}

/** The small previews (a round profile picture, a board row) from the real 256 px picture, a moment after changes. */
let smallTimer = 0;
function scheduleSmall(): void {
  clearTimeout(smallTimer);
  smallTimer = window.setTimeout(async () => {
    const c = await stage.render(spec, AVATAR_PX, maps);
    const url = c.toDataURL("image/png");
    ($("av-round") as HTMLImageElement).src = url;
    ($("av-row-img") as HTMLImageElement).src = url;
    draw();
  }, 260);
}

// ---------------------------------------------------------------------------------------------
// Thumbnails: the bunny wearing one choice, drawn one at a time by an offscreen stage once the animations have settled.

let animsSettled: () => void = () => {};
const animsReady = new Promise<void>((r) => (animsSettled = r));
let thumbStage: AvatarStage | null = null;
let thumbChain: Promise<unknown> = animsReady;
const thumbCache = new Map<string, Promise<string>>();
const THUMB_PX = 168;

function thumb(s: AvatarSpec, focus?: Focus): Promise<string> {
  const key = packAvatar(s) + (focus ?? "");
  let p = thumbCache.get(key);
  if (!p) {
    p = thumbChain.then(async () => {
      await new Promise((r) => setTimeout(r, 0)); // one per task: the page stays responsive
      if (!thumbStage) {
        thumbStage = new AvatarStage();
        await settle(thumbStage);
      }
      return (await thumbStage.render(s, THUMB_PX, null, focus)).toDataURL("image/webp", 0.9);
    });
    thumbChain = p.catch(() => undefined);
    thumbCache.set(key, p);
  }
  return p;
}

/** An <img> that fills in when its thumbnail is drawn. */
function thumbImg(s: AvatarSpec, cls: string, focus?: Focus): HTMLImageElement {
  const img = el("img", { class: cls, alt: "", width: THUMB_PX / 2, height: THUMB_PX / 2, draggable: "false" }) as HTMLImageElement;
  void thumb(s, focus).then((url) => (img.src = url));
  return img;
}

type Slot = "outfit" | "hat" | "knife" | "finish" | "glove";
/** How each slot's choices are shown: the bunny as you've made it, wearing the choice, posed and framed to show it. */
const THUMB: Record<Slot, (id: string) => AvatarSpec> = {
  outfit: (id) => cleanAvatar({ ...spec, outfit: id, pose: "idle", moment: 0.5, tilt: 0.2, ears: 0.5, turn: -15, frame: "close", zoom: 1, bg: "clear" }),
  hat: (id) => cleanAvatar({ ...spec, hat: id || null, pose: "idle", moment: 0.5, tilt: 0, ears: 0.4, turn: -15, frame: "face", zoom: 1.08, bg: "clear" }),
  knife: (id) => cleanAvatar({ ...spec, knife: id, hand: "knife", pose: "holdup", moment: 0.3, tilt: 0, ears: 0.4, turn: -30, bg: "clear" }),
  finish: (id) => cleanAvatar({ ...spec, finish: id, hand: "knife", pose: "holdup", moment: 0.3, tilt: 0, ears: 0.4, turn: -30, bg: "clear" }),
  glove: (id) => cleanAvatar({ ...spec, glove: id, hand: "none", pose: "wave", moment: 0.3, tilt: 0, ears: 0.4, turn: -30, bg: "clear" }),
};
/** Knives, finishes and gloves are framed on the hand (AvatarStage Focus); the rest on the bunny. */
const FOCUS: Partial<Record<Slot, Focus>> = { knife: "hand", finish: "hand", glove: "glove" };
const SLOT_NAME: Record<Slot, string> = { outfit: "Colourway", hat: "Headwear", knife: "Knife", finish: "Finish", glove: "Gloves" };

/** Waits for a stage's bunny to switch to the CS:S animations (when the player content is there), then poses it. */
async function settle(st: AvatarStage): Promise<void> {
  await animsReady;
  st.set(spec);
  for (let i = 0; i < 40 && st.animSource !== "cs" && hasAnims; i++) {
    st.repose();
    await new Promise((r) => setTimeout(r, 50));
  }
  st.repose();
}
let hasAnims = false;

addEventListener("resize", () => draw());

// Drag to turn the bunny.
{
  let drag: { x: number; turn: number } | null = null;
  view.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, turn: spec.turn };
    view.setPointerCapture(e.pointerId);
    view.classList.add("is-dragging");
  });
  view.addEventListener("pointermove", (e) => {
    if (!drag) return;
    let t = drag.turn + ((e.clientX - drag.x) / Math.max(200, view.clientWidth)) * 300;
    t = ((((t + 180) % 360) + 360) % 360) - 180;
    setSpec({ turn: t }, { quiet: true });
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    view.classList.remove("is-dragging");
    renderControls();
  };
  view.addEventListener("pointerup", end);
  view.addEventListener("pointercancel", end);
}

// ---------------------------------------------------------------------------------------------
// Controls

const controls = $("av-controls");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") e.className = String(v);
    else if (k === "style") e.setAttribute("style", String(v));
    else if (k in e && typeof v !== "string") (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids) if (k !== null && k !== false) e.append(k);
  return e;
}

/** A section: a heading (with the current choice's name beside it) and its body. */
const section = (title: string, current: string | null, ...body: (Node | null | false)[]) =>
  el("div", { class: "av-sec" }, el("h2", {}, title, current ? el("span", { class: "av-cur" }, current) : null), ...body);

/** A plain list of choices (the pause menu's rail: amber bar on the chosen one). */
function list<T extends string>(items: readonly { id: T; name: string }[], current: T | null, pick: (id: T) => void, cls = ""): HTMLElement {
  return el(
    "div",
    { class: `av-list ${cls}`, role: "listbox" },
    ...items.map((it) =>
      el("button", { type: "button", class: "av-opt", role: "option", "aria-selected": String(it.id === current), onclick: () => pick(it.id) }, it.name),
    ),
  );
}

/** Colour swatches (colourways, backdrops): the name is the tooltip and the heading's current label. */
function swatches(items: readonly { id: string; name: string; color: string; color2?: string }[], current: string, pick: (id: string) => void, hover?: (id: string | null) => void): HTMLElement {
  return el(
    "div",
    { class: "av-swatches", role: "listbox", onpointerleave: hover ? () => hover(null) : null },
    ...items.map((it) =>
      el("button", {
        type: "button",
        class: "av-sw",
        role: "option",
        title: it.name,
        "aria-label": it.name,
        "aria-selected": String(it.id === current),
        style: `--sw:${it.color};--sw2:${it.color2 ?? it.color}`,
        onpointerenter: hover ? () => hover(it.id) : null,
        onclick: () => ((preview = null), pick(it.id)),
      }),
    ),
  );
}

function slider(label: string, value: number, min: number, max: number, step: number, set: (v: number) => void): HTMLElement {
  const input = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
  input.addEventListener("input", () => set(Number(input.value)));
  input.addEventListener("change", () => renderControls());
  return el("label", { class: "av-slider" }, el("span", {}, label), input);
}

/** The slot whose picker fills the controls column, or null for the controls. */
let picking: Slot | null = null;

function choicesOf(slot: Slot, o: Options): { id: string; name: string }[] {
  const list = slot === "outfit" ? o.outfits : slot === "hat" ? o.hats : slot === "knife" ? o.knives : slot === "finish" ? o.finishes : o.gloves;
  const items = list.map((c) => ({ id: c.id, name: c.id === "fin-garden" ? "Plain" : c.name }));
  return slot === "hat" ? [{ id: "", name: "None" }, ...items] : items;
}
const currentOf = (slot: Slot): string => (slot === "hat" ? spec.hat ?? "" : spec[slot]);

function openPicker(slot: Slot): void {
  picking = slot;
  renderControls();
  controls.scrollIntoView({ block: "start", behavior: "smooth" });
}
function closePicker(): void {
  picking = null;
  setPreview(null);
  renderControls();
}
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && picking) closePicker();
});

/** A slot's picker: every choice you own as a 3D thumbnail; hover previews it on the big avatar, click wears it. */
function renderPicker(slot: Slot): void {
  const items = choicesOf(slot, options());
  const cur = currentOf(slot);
  const patch = (id: string): Partial<AvatarSpec> =>
    slot === "hat" ? { hat: id || null } : slot === "outfit" ? { outfit: id, bg: spec.bg.startsWith("outfit:") ? defaultBg(id) : spec.bg } : slot === "glove" ? { glove: id } : { [slot]: id, hand: "knife" };
  const grid = el(
    "div",
    { class: "av-grid", role: "listbox", "aria-label": SLOT_NAME[slot], onpointerleave: () => setPreview(null) },
    ...items.map((it) =>
      el(
        "button",
        {
          type: "button",
          class: "av-tile",
          role: "option",
          "aria-selected": String(it.id === cur),
          onpointerenter: () => setPreview(patch(it.id)),
          onfocus: () => setPreview(patch(it.id)),
          onclick: () => {
            preview = null;
            setSpec(patch(it.id), { quiet: true });
            closePicker();
          },
        },
        thumbImg(THUMB[slot](it.id), "av-tile-img", FOCUS[slot]),
        el("span", { class: "av-tile-name" }, it.name),
      ),
    ),
  );
  const name = items.find((i) => i.id === cur)?.name ?? null;
  controls.replaceChildren(
    el(
      "div",
      { class: "av-picker" },
      el("div", { class: "av-picker-top" }, el("h2", {}, SLOT_NAME[slot], name ? el("span", { class: "av-cur" }, name) : null), el("button", { type: "button", class: "av-link", onclick: closePicker }, "Done")),
      grid,
    ),
  );
}

// Hair (a wig on: Space Buns, Ponytail): the Loadout's colours (loadout.ts HAIR_PRESETS) and its custom colour picker,
// and the Ponytail's length. Only while a wig you own is on; the default colour and length stay out of the spec.
let hairDialog: HTMLDialogElement | null = null;
function hairControls(): HTMLElement[] {
  const hat = spec.hat;
  if (!hat || !isWig(hat) || !owns(cosmetic(hat))) return [];
  const cur = hairHex(hairColorOf(spec.hairColor) ?? HAIR_DEFAULT);
  const preset = HAIR_PRESETS.find((p) => p.hex === cur);
  const setHair = (hex: string | null) => setSpec({ hairColor: !hex || hex === hairHex(HAIR_DEFAULT) ? undefined : hex });
  const custom = el(
    "button",
    {
      type: "button",
      class: "av-link av-hair-custom",
      "aria-haspopup": "dialog",
      "aria-pressed": String(!preset),
      title: preset ? "Choose any colour" : `Custom colour ${cur.toUpperCase()}`,
      onclick: () => {
        if (hairDialog) return hairDialog.focus();
        hairDialog = glowColorPicker({
          title: "Hair colour",
          intro: "Choose a colour for your hair.",
          current: cur as `#${string}`,
          preview: (hex) => setPreview({ hairColor: hex }),
          apply: (hex) => ((preview = null), setHair(hex)),
          closed: () => ((hairDialog = null), setPreview(null)),
        });
      },
    },
    el("span", { class: "av-hair-dot", style: `--sw:${cur}`, "aria-hidden": "true" }),
    "Custom…",
  );
  const out: HTMLElement[] = [
    el("h3", {}, "Hair", el("span", { class: "av-cur" }, preset?.name ?? cur.toUpperCase())),
    el(
      "div",
      { class: "av-hair" },
      swatches(
        HAIR_PRESETS.map((p) => ({ id: p.hex, name: p.name, color: p.hex })),
        preset ? cur : "",
        (hex) => setHair(hex),
        (hex) => setPreview(hex ? { hairColor: hex } : null),
      ),
      custom,
    ),
  ];
  if (LENGTH_HATS.includes(hat)) {
    const n = spec.hairLength ?? HAIR_LENGTH.default;
    out.push(slider("Length", n, HAIR_LENGTH.min, HAIR_LENGTH.max, 5, (v) => setSpec({ hairLength: v === HAIR_LENGTH.default ? undefined : v }, { quiet: true })));
  }
  return out;
}

/** A row that opens a slot's picker: what you wear there, as a thumbnail and a name. */
function pickRow(slot: Slot, o: Options): HTMLElement | null {
  const items = choicesOf(slot, o);
  if (items.length < 2) return null;
  const cur = currentOf(slot);
  return el(
    "button",
    { type: "button", class: "av-pick", onclick: () => openPicker(slot) },
    thumbImg(THUMB[slot](cur), "av-pick-img", FOCUS[slot]),
    el("span", { class: "av-pick-label" }, SLOT_NAME[slot]),
    el("span", { class: "av-pick-name" }, items.find((i) => i.id === cur)?.name ?? "None"),
    el("span", { class: "av-pick-more", "aria-hidden": "true" }, "›"),
  );
}

function renderControls(): void {
  if (picking) return renderPicker(picking);
  const o = options();
  const name = (id: string | null) => (id ? cosmetic(id)?.name ?? id : null);
  const knifeName = o.knives.find((k) => k.id === spec.knife)?.name ?? name(spec.knife);
  const gun = GUNS.find((g) => g.id === spec.gun);
  const bgName =
    spec.bg === "clear"
      ? "Clear"
      : spec.bg.startsWith("outfit:")
        ? "Colourway"
        : spec.bg.startsWith("map:")
          ? spec.bg.slice(4)
          : spec.bg.startsWith("#")
            ? spec.bg
            : BACKDROPS.find((b) => b.id === spec.bg)?.name ?? null;

  const mapInput = el("input", { type: "text", class: "av-map", placeholder: "Map name", list: "av-maps", value: spec.bg.startsWith("map:") ? spec.bg.slice(4) : "", "aria-label": "Map backdrop" }) as HTMLInputElement;
  mapInput.addEventListener("change", () => {
    const m = mapList.find((x) => x.name === mapInput.value.trim().toLowerCase());
    if (m) setSpec({ bg: `map:${m.name}` });
  });
  const colour = el("input", { type: "color", class: "av-color", value: spec.bg.startsWith("#") ? spec.bg : "#1c1c22", "aria-label": "Your own colour" }) as HTMLInputElement;
  colour.addEventListener("input", () => setSpec({ bg: colour.value }, { quiet: true }));
  colour.addEventListener("change", () => renderControls());

  controls.replaceChildren(
    ...[
    section(
      "Pose",
      POSES.find((p) => p.id === spec.pose)?.name ?? null,
      // Empty-hand gestures put the knife away; the knife poses take it back out.
      list(POSES, spec.pose, (pose) => setSpec({ pose, hand: POSES.find((p) => p.id === pose)?.free ? "none" : ["holdup", "showoff", "swing"].includes(pose) && spec.hand === "none" ? "knife" : spec.hand }), "av-cols"),
      slider("Moment", spec.moment, 0, 1, 0.01, (moment) => setSpec({ moment }, { quiet: true })),
      slider("Head tilt", spec.tilt, -1, 1, 0.01, (tilt) => setSpec({ tilt }, { quiet: true })),
      slider("Ears", spec.ears, -1, 1, 0.01, (ears) => setSpec({ ears }, { quiet: true })),
    ),
    section(
      "Framing",
      FRAMES.find((f) => f.id === spec.frame)?.name ?? null,
      list(FRAMES, spec.frame, (frame) => setSpec({ frame }), "av-row4"),
      slider("Zoom", 2.3 - spec.zoom, 0.7, 1.6, 0.01, (z) => setSpec({ zoom: 2.3 - z }, { quiet: true })),
    ),
    section(
      "Look",
      null,
      el("div", { class: "av-picks" }, pickRow("outfit", o), pickRow("hat", o), spec.hand === "knife" ? pickRow("knife", o) : null, spec.hand === "knife" ? pickRow("finish", o) : null, pickRow("glove", o)),
      ...hairControls(),
      el("h3", {}, "Build", el("span", { class: "av-cur" }, name(spec.body) ?? "")),
      list(
        [
          { id: "body-a", name: "Model A" },
          { id: "body-b", name: "Model B" },
        ],
        spec.body,
        (body) => setSpec({ body }),
        "av-row3",
      ),
      el("h3", {}, "In hand", el("span", { class: "av-cur" }, spec.hand === "knife" ? knifeName ?? "" : spec.hand === "gun" ? gun?.name ?? spec.gun : "Nothing")),
      list(
        [
          { id: "knife", name: "Knife" },
          { id: "gun", name: "Gun" },
          { id: "none", name: "Nothing" },
        ] as const,
        spec.hand,
        (hand) => setSpec({ hand }),
        "av-row3",
      ),
      spec.hand === "gun" ? list(GUN_IDS.map((id) => ({ id, name: GUNS.find((g) => g.id === id)?.name ?? id })), spec.gun, (g) => setSpec({ gun: g }), "av-cols") : null,
    ),
    section(
      "Backdrop",
      bgName,
      swatches(
        [
          { id: "clear", name: "Clear (transparent)", color: "transparent" },
          { id: defaultBg(spec.outfit), name: "Colourway", color: "#18181d", color2: cosmetic(spec.outfit)?.color ?? "#ffb43c" },
          ...BACKDROPS.map((b) => ({ id: b.id, name: b.name, color: b.bottom, color2: b.top })),
        ],
        spec.bg,
        (bg) => setSpec({ bg }),
        (bg) => setPreview(bg ? { bg } : null),
      ),
      el("div", { class: "av-bgrow" }, colour, mapInput, el("button", { type: "button", class: "av-link", onclick: () => mapList.length && setSpec({ bg: `map:${mapList[Math.floor(Math.random() * mapList.length)].name}` }) }, "Random map")),
      el("datalist", { id: "av-maps" }, ...mapList.map((m) => el("option", { value: m.name }))),
    ),
    ].filter((x): x is HTMLDivElement => x !== null),
  );
}

// ---------------------------------------------------------------------------------------------
// Actions

function status(text: string, bad = false): void {
  const s = $("av-status");
  s.textContent = text;
  s.classList.toggle("bad", bad);
}

const blobOf = (c: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob | null>((res) => c.toBlob(res, type, quality));

const webpBase64 = () => avatarWebpBase64(stage, spec, maps);

$("av-save").addEventListener("click", async () => {
  const btn = $("av-save") as HTMLButtonElement;
  if (!signedIn) {
    location.href = "/";
    return;
  }
  btn.disabled = true;
  status("Saving…");
  try {
    const r = await api.saveBunnyAvatar(spec, await webpBase64());
    custom = r.custom;
    spec = ownedOnly(r.spec);
    $("av-reset").hidden = !custom;
    status(user?.useDiscordAvatar ? "Saved. Your Discord picture still shows: switch it off below to show this one." : "Saved. It shows on the boards and your profile now.");
  } catch (e) {
    status(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Couldn't reach the server.", true);
  } finally {
    btn.disabled = false;
  }
});

$("av-download").addEventListener("click", async () => {
  const size = Number(($("av-size") as HTMLSelectElement).value) || 1024;
  const blob = await blobOf(await stage.render(spec, size, maps), "image/png");
  if (!blob) return status("Couldn't make the picture.", true);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bunnyhop-avatar-${size}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

$("av-copy").addEventListener("click", async () => {
  try {
    const blob = await blobOf(await stage.render(spec, 1024, maps), "image/png");
    if (!blob) throw new Error();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    status("Copied.");
  } catch {
    status("This browser won't copy pictures. Download it instead.", true);
  }
});

$("av-shuffle").addEventListener("click", () => {
  const o = options();
  const any = <T,>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
  const outfit = any(o.outfits).id;
  setSpec({
    outfit,
    hat: o.hats.length && Math.random() < 0.6 ? any(o.hats).id : null,
    knife: any(o.knives).id,
    finish: any(o.finishes).id,
    glove: any(o.gloves).id,
    hand: Math.random() < 0.85 ? "knife" : "gun",
    gun: any(GUN_IDS),
    pose: any(POSES).id,
    moment: Math.random(),
    tilt: (Math.random() - 0.5) * 0.8,
    ears: Math.random() * 2 - 1,
    turn: (Math.random() - 0.5) * 70,
    bg: Math.random() < 0.5 ? defaultBg(outfit) : any(BACKDROPS).id,
  });
});

$("av-reset").addEventListener("click", async () => {
  try {
    const r = await api.resetBunnyAvatar();
    custom = false;
    $("av-reset").hidden = true;
    spec = ownedOnly(r.spec);
    draw();
    renderControls();
    status("Back to your default.");
  } catch (e) {
    status(e instanceof ApiError ? e.message : "Couldn't reach the server.", true);
  }
});

$("av-discord-box").addEventListener("change", async (e) => {
  const box = e.currentTarget as HTMLInputElement;
  box.disabled = true;
  try {
    user = await api.setUseDiscordAvatar(box.checked);
    status(box.checked ? "Your Discord picture shows instead." : "Your bunny shows now.");
  } catch (err) {
    box.checked = !box.checked;
    status(err instanceof ApiError ? err.message : "Couldn't reach the server.", true);
  } finally {
    box.disabled = false;
  }
});

// ---------------------------------------------------------------------------------------------
// Start

/** What a loadout puts on the avatar (the default pose stays). */
const wearing = (l: { outfit?: string | null; knife?: string | null; finish?: string | null; glove?: string | null; hat?: string | null; body?: string | null; hairColor?: string | number | null; hairLength?: number | null }): Partial<AvatarSpec> => {
  const p: Partial<AvatarSpec> = {};
  for (const k of ["outfit", "knife", "finish", "glove", "body"] as const) if (l[k]) p[k] = l[k]!;
  p.hat = l.hat ?? null;
  // Your hair as you wear it (the Hair controls under Look change it for the avatar only).
  const hair = hairColorOf(l.hairColor);
  if (hair !== null) p.hairColor = hairHex(hair);
  if (l.hairLength) p.hairLength = l.hairLength;
  if (p.outfit) p.bg = defaultBg(p.outfit);
  return p;
};

/**
 * The saved avatar, re-rendered with this build's look and saved again exactly as it was (the server checks it like
 * any save), once the animations are in; on a stage of its own, offscreen, so the preview never flickers. Silent.
 */
async function refreshOnOpen(saved: AvatarSpec): Promise<void> {
  await animsReady;
  if (!hasAnims) return;
  const st = new AvatarStage();
  try {
    st.set(saved);
    if (!(await settleOnAnims(st))) return;
    await api.saveBunnyAvatar(saved, await avatarWebpBase64(st, saved, maps));
    console.info(`avatar: re-rendered your saved avatar for look ${AVATAR_RENDER_VERSION}`);
  } catch {
    /* the old picture stays until the next try or the deploy batch */
  } finally {
    st.dispose();
  }
}

async function start(): Promise<void> {
  // Until the account answers: this browser's draft, else the loadout this browser wears.
  try {
    const d = localStorage.getItem(DRAFT_KEY);
    spec = ownedOnly(d ? cleanAvatar(JSON.parse(d)) : cleanAvatar({ ...spec, ...wearing({ outfit: getOutfit(), ...getLoadout() }) }));
  } catch {
    /* none */
  }
  renderControls();
  draw();

  // Maps: backdrops, and the player content (the bunny's CS:S animations) named by any map's content manifest.
  void mapIndex().then(async (list) => {
    mapList = list.filter((m) => m.hero).map((m) => ({ name: m.name, hero: m.hero! }));
    renderControls();
    if (spec.bg.startsWith("map:")) (bgKey = ""), draw();
    if (await playerAnims(list)) {
      // The model switches to the CS:S animations on its next update; pose again once it has.
      await settleOnAnims(stage);
      draw();
      hasAnims = true;
    }
    animsSettled();
    (window as unknown as { avatarReady?: boolean }).avatarReady = true;
  });

  try {
    user = await api.me();
  } catch {
    user = null;
  }
  if (user) {
    try {
      const [cos, mine] = await Promise.all([api.myCosmetics(), api.bunnyAvatar()]);
      unlocked = new Set(cos.unlocked);
      signedIn = true;
      custom = mine.custom;
      // Your avatar: the saved one, else your default pose in the loadout you wear.
      spec = ownedOnly(mine.custom ? mine.spec : cleanAvatar({ ...mine.spec, ...wearing(cos.choice) }));
      $("av-row-name").textContent = user.name;
      // Saved with an older look (spec.ts AVATAR_RENDER_VERSION): draw it again as saved, quietly (avatar/refresh.ts).
      if (mine.custom && (mine.render ?? 1) < AVATAR_RENDER_VERSION) void refreshOnOpen(mine.spec);
    } catch {
      signedIn = false;
    }
  }
  $("av-save").textContent = signedIn ? "Use as my avatar" : "Sign in to use it";
  $("av-reset").hidden = !(signedIn && custom);
  const discord = $("av-discord");
  discord.hidden = !(signedIn && user?.discordAvatarUrl && !user.discordAvatarBlocked);
  ($("av-discord-box") as HTMLInputElement).checked = !!user?.useDiscordAvatar;
  if (!signedIn) status("Not signed in: free items only. Downloads still work.");
  renderControls();
  draw();
}

Object.assign(window, {
  __avatar: {
    get spec() {
      return spec;
    },
    set: (p: Partial<AvatarSpec>) => setSpec(p),
    /** A finished picture as a data URL (tools/avatar/render-defaults.ts). */
    render: async (s: Partial<AvatarSpec>, size: number, type = "image/png") => (await stage.render(cleanAvatar({ ...spec, ...s }), size, maps)).toDataURL(type, 0.92),
    /** The saved picture for a spec, exactly as "Use as my avatar" makes it (base64 WebP; tools/avatar/rerender-saved.ts). */
    picture: (s: unknown) => avatarWebpBase64(stage, cleanAvatar(s), maps),
    /** The look this build draws (spec.ts AVATAR_RENDER_VERSION) and the animations it poses with ("cs" once loaded). */
    renderVersion: AVATAR_RENDER_VERSION,
    anim: () => stage.animSource,
    /** Dev only: every item (the server still checks ownership on save). */
    showAll: () => import.meta.env.DEV && ((showAll = true), renderControls()),
    debug: () => stage.debugFrame(),
    /** Dev only: the stage itself (research/avatar-refresh/clearance.cjs measures hands and knives against the hood). */
    stage: import.meta.env.DEV ? stage : null,
    gestures: GESTURES,
  },
});

void start();
