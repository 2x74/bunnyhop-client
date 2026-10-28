// Settings screen (v0.0.4 redesign, after Aimperion's settings page): one scrolling page of sections (Mouse & view,
// Crosshair, HUD, Keys, Ghost, Graphics, Viewmodel, Audio, Account + any registered through settings-registry.ts), a
// rail on the left with a glyph per section that tracks where you are and jumps between them, and a search box across
// the top that filters every row in place (settings-search.ts: aliases, typos, AND semantics, ranking).
//
// Each section: a header (glyph, title, one-line description, "Reset" with a confirm click), then its groups, in two
// columns where the screen is wide enough and one below that. Each row reads  label · hint  |  control · ⓘ  (controls.ts).
// Most-used rows first; rarely used ones go behind the section's "Advanced" line (closed by default, opened by the search
// while it holds a match). HUD opens with "Show on screen" (ui/quick-toggles.ts): the keys overlay's switch and the other
// pieces players switch most, the same switches as the pause menu's On screen tab. A few of them (name tags, ghosts,
// viewmodel) are shortcuts to rows in other sections: they stay in step with those rows and the search skips them.
// Toolbar: the Profile menu (settings-profile-menu.ts: saved setups to switch between), Export / Import
// (settings-transfer.ts: a code to paste or a .json file) and Reset all (with a confirm card).
// Every change is written to the pref store immediately and applied live by its subscribers (main.ts, hud.ts).
//
// Keys: / or Ctrl+F search (Esc clears it, ↓ / Enter go to the best match), Q / E previous / next section, ↑ / ↓ move
// in the rail (the page follows) or between rows, → from the rail into its section, ←/→ adjust the focused control,
// Esc (outside the search box) goes back.
//
// THE JUMP IS INSTANT. Clicking a rail item cuts to its section (with a small arrival fade on the header when motion is
// allowed) rather than scrolling through everything in between: a 3000px smooth scroll is a journey, the destination is
// the message. Scrolling by hand moves the rail marker; the last section can always reach the top (a measured tail of
// padding), so its rail item never lies about where you are.

import { cinematicSettings } from "../graphics/cinematic-preset";
import { composerPreset } from "../graphics/presets";
import { hybridStatusNode } from "../graphics/hybrid-status";
import { importSkyFile, skyFileKind, skyGroup } from "../sky-packs/settings";
import { DEFAULT_PREFS, gameView, horizontalFovAt, keyLabel, prefs, ACTIONS, bindIsDefault, resetBind, type Action, type CrosshairStyle, applyGraphicsPreset, graphicsPreset, applyTrainerPreset, trainerPreset, type TrainerPreset, type TrainerStyle, type AspectFit, type AspectRatio, type GraphicsPreset, type MenuBackground, type PlaceReadout, type Prefs } from "./settings";
import { arrowNav, h } from "./dom";
import * as ui from "./controls";
import { group, range, rowDesc, segmented, select, toggle, check, color, row, button, syncSwitches, SWATCHES } from "./controls";
import { DEFAULT_TRIGGER_PREFS, KINDS, TRIGGER_OPACITY, TRIGGER_STYLES, TRIGGER_THICKNESS, type TriggerStyle } from "../triggers/volumes";
import { onSettingsSections, registeredSections, type SettingsContent } from "./settings-registry";
import { didYouMean, indexEntry, matchRanges, searchSettings, tokenize, type IndexedEntry } from "./settings-search";
import { confirmDialog, openSettingsTransfer } from "./settings-transfer";
import { profileMenu } from "./settings-profile-menu";
import { icon, sectionIcon } from "./icons";
import { renderCrosshair } from "../hud";
import { EDITOR_CLOSED, hudEditorAvailable, openHudEditor } from "../hud/editor";
import { mouseFromPrefs } from "../mouse-settings";
import { api } from "../api";
import { uiSound } from "../audio/ui";
import { KeysOverlay, PREVIEW_BITS } from "../hud/keys";
import { StrafeTrainerView } from "../hud/strafe-trainer-view";
import { trainerZone } from "../hud/strafe-trainer";
import { clampScale, cloneLayout, decodeLayout, encodeLayout, HUD_ELEMENTS, HUD_SCALE, PRESETS, sameLayout, type HudElId, type KeysStyle } from "../hud/layout";
import { hideUiKeeps, hideUiSwitch, hudMiniature } from "./quick-toggles";
import { ssjRows } from "../ssj";
import { movementRows } from "../movement-stats";
import { requestRace } from "../player/race";
import { guardSideMouseButtons, mouseCode } from "../binds";
import { ANGLE_SPEED_KEY_RANGE, YAW_SPEED_RANGE } from "../turn-binds";
import "./settings.css";
import { nativeClient, openClientSettings } from "../client-bridge";
import { GHOST_CSS, type GhostKind } from "../player/colors";
import type { GhostRouteMode, GhostRouteSource } from "../ghost-route-data";
import type { AutoRestartAction, AutoRestartWhen } from "../auto-restart";
import { COLOR_BLIND_MODES, type ColorBlindMode } from "../palette";

interface Ctx {
  /** Re-render this section (after changes that affect other rows). */
  refresh: () => void;
  openControls?: () => void;
}

interface Section {
  id: string;
  label: string;
  blurb: string;
  order: number;
  icon?: string;
  render: (ctx: Ctx) => SettingsContent;
  reset?: () => void;
}

const P = () => prefs.get();
const up = (fn: (p: Prefs) => void) => prefs.update(fn);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const resetKeys = (...keys: (keyof Prefs)[]) => () =>
  prefs.update((p) => {
    for (const k of keys) (p as unknown as Record<string, unknown>)[k] = clone(DEFAULT_PREFS[k]);
  });
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------------------------------------
// Mouse & view

function mouseSection(): SettingsContent {
  const cm = h("b");
  const edpi = h("b");
  const hfov = h("b");
  const hsub = h("small");
  const paint = () => {
    const p = P();
    cm.textContent = ((360 / (p.sensitivity * 0.022) / Math.max(1, p.dpi)) * 2.54).toFixed(1);
    edpi.textContent = String(Math.round(p.sensitivity * p.dpi));
    hfov.textContent = `${horizontalFovAt(p.fov, innerWidth / innerHeight).toFixed(1)}°`;
    hsub.textContent = `at ${innerWidth}×${innerHeight}`;
  };
  paint();
  const stat = (value: HTMLElement, label: string, sub?: HTMLElement | string) => h("div.set-stat", null, value, h("small", null, label), sub ? (typeof sub === "string" ? h("small.dim", null, sub) : sub) : null);
  return {
    columns: [
      [
        group(
          "Mouse",
          range("Sensitivity", () => P().sensitivity, (v) => (up((p) => (p.sensitivity = Math.round(v * 1000) / 1000)), paint()), {
            min: 0.1, max: 10, step: 0.01, inputRange: [0.01, 100],
            hint: "CS:S units, as in your config",
            desc: "CS:S sensitivity: degrees per count = sensitivity × m_yaw (0.022), same as CS:S. Type values beyond the slider in the box (up to 100).",
            keywords: "sens m_yaw aim mouse speed",
          }),
          range("Mouse DPI", () => P().dpi, (v) => (up((p) => (p.dpi = Math.round(v), p.dpiConfirmed = true)), paint()), { min: 100, max: 6400, step: 50, inputRange: [50, 32000], desc: "Your mouse's DPI (CPI). The browser can't detect it. Used for the eDPI and cm/360 readouts.", keywords: "cpi edpi" }),
          api.available()
            ? toggle("Show DPI on profile", () => mouseFromPrefs(P()).dpi !== null, (v) => up((p) => (v ? ((p.dpiHidden = false), (p.dpiConfirmed = true)) : (p.dpiHidden = true))), {
                desc: `Your profile always shows your sensitivity. Off: it shows ${DEFAULT_PREFS.dpi} DPI, the default, instead of yours.`,
                keywords: "profile dpi sensitivity edpi mouse public share hide",
              })
            : null,
          toggle("Separate vertical sensitivity", () => P().verticalSensitivityEnabled, (v) => up((p) => (p.verticalSensitivityEnabled = v)), { desc: "Use a separate sensitivity for looking up and down. Off: Sensitivity controls both axes.", keywords: "mouse pitch y axis vertical sensitivity" }),
          range("Vertical sensitivity", () => P().verticalSensitivity, (v) => up((p) => (p.verticalSensitivity = Math.round(v * 1000) / 1000)), { min: 0.1, max: 10, step: 0.01, inputRange: [0.01, 100], when: () => P().verticalSensitivityEnabled, desc: "Same CS:S units as Sensitivity. Invert mouse Y still applies.", keywords: "mouse pitch y axis vertical sensitivity" }),
          toggle("Invert mouse Y", () => P().invertY, (v) => up((p) => (p.invertY = v)), { desc: "Moving the mouse up looks down.", keywords: "pitch invert flip" }),
          toggle("Raw input", () => P().rawInput, (v) => up((p) => (p.rawInput = v)), { desc: "Pointer lock with unadjusted movement (Chromium browsers): the OS pointer speed and acceleration don't touch your aim. Applies the next time you click into the game.", keywords: "acceleration accel unadjusted" }),
        ),
      ],
      [
        group(
          "View",
          range("Field of view", () => P().fov, (v) => (up((p) => (p.fov = v)), paint()), { min: 75, max: 120, step: 1, unit: "°", peek: true, hint: "Horizontal at 4:3, like CS:S", desc: "fov_desired (CS:S default 90). Wider screens see more at the sides (Hor+), like CS:S.", keywords: "fov fov_desired zoom" }),
          h("div.set-stats", null, stat(cm, "cm / 360°"), stat(edpi, "eDPI"), stat(hfov, "horizontal FOV", hsub)),
        ),
      ],
    ],
    advanced: [
      group(
        "Mouse input",
        toggle("Spike filter", () => P().spikeFilter, (v) => up((p) => (p.spikeFilter = v)), { desc: "Some browsers now and then report a mouse jump you never made, mostly with a 1000 Hz or faster mouse when raw input is off or unsupported, and right after you click into the game. The filter drops a single mouse report only when it is far bigger than the ones around it, which no real flick is. Turn it off if your aim ever feels like it skips.", keywords: "flick flicks jump snap polling hz spike spikes skip skipping filter jitter" }),
        toggle("Timestamped input", () => P().timedInput, (v) => up((p) => (p.timedInput = v)), { desc: "Each tick takes exactly the mouse movement and strafe keys you made before it, like CS:S at a high frame rate, instead of whatever the last frame had. Strafe gain and !ssj match CS:S at any monitor refresh rate. The view on screen is the same either way.", keywords: "timing timestamp gain ssj sync strafe tick subtick refresh fps aliasing source accurate" }),
        toggle("Show input stats", () => P().inputStats, (v) => up((p) => (p.inputStats = v)), { desc: "While you play: mouse events and reports per second, the size of each movement, spikes the filter dropped, frame times and stutters (also ?inputdebug=1 in the address). Screenshot it when you report flicks or freezes.", keywords: "debug diagnostics polling hz rate stutter freeze frame time input stats overlay lag" }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Crosshair

const XH_STYLES: [CrosshairStyle, string][] = [
  ["cross", "Cross"],
  ["cross-dot", "Cross + dot"],
  ["t", "T"],
  ["dot", "Dot"],
  ["circle", "Circle"],
  ["none", "None"],
];
const XH_BACKDROPS = ["sky", "dark", "bright"] as const;

function crosshairSection(): SettingsContent {
  const anchor = h("span.xh-anchor");
  const preview = h("div.xhair-preview", { "data-bg": sessionStorage.getItem("bunnyhop:xh-bg") ?? "sky", "aria-hidden": "true" }, anchor);
  // (The tiles' anchors are kept, not looked up: renderCrosshair rewrites their xh-* classes, xh-anchor included.)
  const tiles: [CrosshairStyle, HTMLElement, HTMLElement][] = [];
  const paint = () => {
    renderCrosshair(anchor, P().crosshair);
    for (const [s, el, a] of tiles) {
      renderCrosshair(a, { ...P().crosshair, style: s, alpha: 1 });
      const on = P().crosshair.style === s;
      el.classList.toggle("on", on);
      el.setAttribute("aria-checked", String(on));
      el.tabIndex = on ? 0 : -1;
    }
  };
  const c = <K extends keyof Prefs["crosshair"]>(k: K, v: Prefs["crosshair"][K]) => (up((p) => (p.crosshair[k] = v)), paint());
  const styleGrid = h("div.xh-styles", { role: "radiogroup", "aria-label": "Crosshair style" });
  for (const [s, label] of XH_STYLES) {
    const a = h("span.xh-anchor");
    const tile = h("button.xh-tile", { type: "button", role: "radio", title: label, "aria-label": label, onclick: () => c("style", s) }, h("span.xhair-preview.xh-mini", { "aria-hidden": "true" }, a), h("small", null, label));
    tiles.push([s, tile, a]);
    styleGrid.append(tile);
  }
  arrowNav(styleGrid, "button");
  const bg = h(
    "div.seg.seg-xs",
    { role: "radiogroup", "aria-label": "Preview background" },
    ...XH_BACKDROPS.map((b) =>
      h(`button${preview.dataset.bg === b ? ".on" : ""}`, {
        type: "button",
        role: "radio",
        "aria-checked": String(preview.dataset.bg === b),
        onclick: (e: Event) => {
          preview.dataset.bg = b;
          sessionStorage.setItem("bunnyhop:xh-bg", b);
          for (const x of (e.currentTarget as HTMLElement).parentElement!.children) {
            x.classList.toggle("on", x === e.currentTarget);
            x.setAttribute("aria-checked", String(x === e.currentTarget));
          }
        },
      }, b[0].toUpperCase() + b.slice(1)),
    ),
  );
  paint();
  return {
    columns: [
      [
        group("Style", h("div.xh-stage", null, preview, h("div.xh-stage-bar", null, h("small.dim", null, "Backdrop"), bg)), row("Style", styleGrid, { desc: "Crosshair shape. None hides it.", keywords: "shape cross dot circle t none crosshair style hide" })),
      ],
      [
        group(
          "Look",
          color("Color", () => P().crosshair.color, (v) => c("color", v), { peek: true, desc: "Pick a preset or any colour.", keywords: "colour crosshair color" }),
          range("Size", () => P().crosshair.size, (v) => c("size", v), { min: 1, max: 20, step: 1, unit: "px", peek: true, desc: "Arm length.", keywords: "length crosshair size bigger smaller" }),
          range("Thickness", () => P().crosshair.thickness, (v) => c("thickness", v), { min: 1, max: 6, step: 0.5, unit: "px", peek: true, desc: "Arm width.", keywords: "width thick thin" }),
          range("Gap", () => P().crosshair.gap, (v) => c("gap", v), { min: 0, max: 16, step: 1, unit: "px", peek: true, desc: "Space between the centre and the arms.", keywords: "spacing" }),
          range("Opacity", () => P().crosshair.alpha, (v) => c("alpha", v), { min: 0.2, max: 1, step: 0.05, scale: 100, unit: "%", peek: true, desc: "How see-through the crosshair is.", keywords: "alpha transparency transparent crosshair" }),
          toggle("Outline", () => P().crosshair.outline, (v) => c("outline", v), { desc: "Thin dark outline: readable on bright walls.", keywords: "border stroke crosshair" }),
        ),
      ],
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// HUD

/**
 * HUD elements in the Show on screen picture (quick-toggles.ts) or in their own group (Jump stats); the rest are under
 * Advanced → More elements.
 */
const QUICK_ELEMENTS = new Set<HudElId>(["keys", "speed", "timer", "split", "stats", "sync", "fps", "chat", "jumpStats", "strafeTrainer", "strafeOffsets", "firstJump", "longJump", "spectators", "practice"]);
const ELEMENT_NOTES: Partial<Record<HudElId, string>> = {
  track: "Which bonus you're running (hidden on the main track).",
  stage: "Stage / checkpoint progress on staged maps.",
  ghostKeys: "The PB ghost's inputs, in step with the ghost.",
  graph: "Last 2 s of speed with each jump's gain.",
  map: "Map, tier and style.",
  pb: "Your personal best on this map and track.",
  ammo: "Rounds left in the clip while a gun is out.",
};

function hudSection(ctx: Ctx): SettingsContent {
  const bind = P().binds.hudEditor[0];
  const avail = hudEditorAvailable();
  const presetSeg = h("div.seg", { role: "group", "aria-label": "Layout presets" });
  const paintPresets = () =>
    presetSeg.replaceChildren(
      ...PRESETS.map((pr) => {
        const on = sameLayout(P().hud.layout, pr.layout);
        return h(`button${on ? ".on" : ""}`, { type: "button", "aria-pressed": String(on), onclick: () => (up((p) => (p.hud.layout = cloneLayout(pr.layout))), ctx.refresh()) }, pr.label);
      }),
    );
  paintPresets();
  const code = h("input.text-input.share-code", { type: "text", placeholder: "bhl1.…", "aria-label": "Layout code", spellcheck: "false" });
  const exp = button("Export", () => {
    code.value = encodeLayout(P().hud.layout, P().hud.keys);
    code.select();
    void navigator.clipboard?.writeText(code.value).then(() => flash(exp, "Copied"), () => flash(exp, "Select + copy"));
  });
  const imp = button("Import", () => {
    const r = decodeLayout(code.value);
    if (!r) return flash(imp, "Not a code");
    up((p) => ((p.hud.layout = r.layout), (p.hud.keys = r.keys)));
    ctx.refresh();
  });

  const preview = new KeysOverlay();
  const previewBox = h("div.keys-preview", { "aria-hidden": "true" }, preview.el);
  const repaintPreview = () => {
    preview.configure(P().hud.keys);
    preview.preview(PREVIEW_BITS);
    preview.render();
    previewBox.style.setProperty("--s", String(P().hud.layout.keys.s));
  };
  repaintPreview();
  const kp = (fn: (k: Prefs["hud"]["keys"]) => void) => (up((p) => fn(p.hud.keys)), repaintPreview());
  const rowsChip = (label: string, key: keyof Prefs["hud"]["keys"]["rows"]) => {
    const b = h(`button.chip-btn${P().hud.keys.rows[key] ? ".on" : ""}`, { type: "button", "aria-pressed": String(P().hud.keys.rows[key]) }, label);
    b.addEventListener("click", () => {
      kp((k) => (k.rows[key] = !k.rows[key]));
      b.classList.toggle("on", P().hud.keys.rows[key]);
      b.setAttribute("aria-pressed", String(P().hud.keys.rows[key]));
    });
    return b;
  };

  // The trainer's preview: a made-up reading swinging through the zones, switching strafe side, so the look and
  // Follow the turn can be judged without a map. Stops once the settings close.
  const trainerPrev = new StrafeTrainerView();
  const trainerBox = h("div.keys-preview.st-preview", { "aria-hidden": "true" }, trainerPrev.el);
  const repaintTrainer = () => {
    trainerPrev.configure(P().hud.strafeTrainer);
    trainerBox.style.setProperty("--s", String(P().hud.layout.strafeTrainer.s));
  };
  repaintTrainer();
  const t0 = performance.now();
  const swing = (now: number) => {
    const t = (now - t0) / 1000;
    const side = Math.floor(t / 1.6) % 2 ? -1 : 1;
    const pace = reducedMotion() ? 108 : 100 + 38 * Math.sin(t * 2.3) + 22 * Math.sin(t * 0.7);
    const zone = trainerZone(pace, P().hud.strafeTrainer.zone);
    trainerPrev.render({ cue: zone === "good" ? "good" : pace < 100 ? "slow" : "fast", pace, side });
    if (trainerBox.isConnected || now - t0 < 2000) requestAnimationFrame(swing);
  };
  requestAnimationFrame(swing);
  const tp = (fn: (t: Prefs["hud"]["strafeTrainer"]) => void) => (up((p) => fn(p.hud.strafeTrainer)), repaintTrainer());

  const presetRow = row("Preset", presetSeg, { desc: "Start from a ready-made layout. The switches above and under More elements follow it.", keywords: "classic minimal streamer layout" });
  // Any switch that shows / hides an element can make the layout match a preset or stop matching it.
  (presetRow as HTMLElement & { repaint?: () => void }).repaint = paintPresets;

  return {
    columns: [
      [
        group(
          "Show on screen",
          hudMiniature(),
          select<PlaceReadout>("Leaderboard place", () => P().hud.place, (v) => up((p) => (p.hud.place = v)), [["off", "Off"], ["place", "Place"], ["top", "Place and top %"]], {
            desc: "The place your time would take on the leaderboard, beside the split.",
            keywords: "rank place position leaderboard board top percent percentile standing",
          }),
          toggle("Spectator list", () => P().hud.layout.spectators.on, (v) => up((p) => (p.hud.layout.spectators.on = v)), {
            desc: "Who is watching you in a room, on the left. While you spectate, who else is watching them. Edit layout moves it.",
            keywords: "spectator spectators spec specs speclist spec list watching viewers who is watching observers hud element",
          }),
          toggle("Practice", () => P().hud.layout.practice.on, (v) => up((p) => (p.hud.layout.practice.on = v)), {
            desc: "Says Practice under the crosshair while your run won't count, after a checkpoint teleport or noclip. Edit layout moves it.",
            keywords: "practice mode indicator banner label warning reminder noclip checkpoint teleport not counting unranked yellow hud element",
          }),
        ),
        group("Hide UI", hideUiSwitch(), hideUiKeeps()),
        group(
          "Colours",
          segmented<ColorBlindMode>("Colour blind", () => P().colorBlind, (v) => up((p) => (p.colorBlind = v)), [...COLOR_BLIND_MODES], {
            desc: "Swaps the red and green (or blue and yellow) of speed, splits, the strafe trainer, zones and triggers for colours that stay apart. Colours you picked yourself stay.",
            keywords: "colorblind colourblind color colour blind blindness deuteranopia protanopia tritanopia deutan protan tritan accessibility palette red green blue yellow",
          }),
        ),
        group(
          "Layout",
          row("Edit layout", button(h("span.btn-inner", null, icon("hud"), "Edit layout"), () => openHudEditor(), { primary: true, disabled: !avail }), {
            hint: avail ? (bind ? `${keyLabel(bind)} in game` : undefined) : "Load a map first",
            desc: avail ? "Drag, resize and snap every element over the game." : "Load a map to edit the layout in place, over the game.",
            keywords: "move drag position editor hud layout f2",
          }),
          presetRow,
          range("HUD scale", () => P().hud.scale, (v) => up((p) => (p.hud.scale = v)), { ...HUD_SCALE, scale: 100, unit: "%", desc: "The whole HUD, chat included. The gaps between elements grow with it.", keywords: "hud size scale bigger smaller ultrawide 21:9 1440p 4k resolution small text" }),
        ),
      ],
      [
        group(
          "Keys overlay",
          previewBox,
          segmented<KeysStyle>("Style", () => P().hud.keys.style, (v) => kp((k) => (k.style = v)), [
            ["classic", "Classic"],
            ["keycaps", "Keycaps"],
            ["minimal", "Minimal"],
          ], { keywords: "keys overlay look style" }),
          range("Size", () => P().hud.layout.keys.s, (v) => (up((p) => (p.hud.layout.keys.s = clampScale(v))), repaintPreview()), { min: 0.5, max: 2.5, step: 0.05, scale: 100, unit: "%", keywords: "keys overlay scale bigger smaller size" }),
          range("Opacity", () => P().hud.keys.opacity, (v) => kp((k) => (k.opacity = v)), { min: 0.2, max: 1, step: 0.05, scale: 100, unit: "%", keywords: "keys overlay alpha transparent opacity" }),
          color("Pressed", () => P().hud.keys.pressed, (v) => kp((k) => (k.pressed = v)), { desc: "Colour of held keys.", keywords: "keys overlay colour color held" }),
          color("Idle", () => P().hud.keys.idle, (v) => kp((k) => (k.idle = v)), { desc: "Colour of released keys.", keywords: "keys overlay colour color released" }),
          row("Rows", h("div.btn-row", null, rowsChip("W A S D", "wasd"), rowsChip("Duck · Jump", "actions"), rowsChip("Mouse", "mouse")), {
            desc: "Jump flashes once per scroll notch; Mouse lights while the view turns.",
            keywords: "keys overlay wasd duck jump mouse turn arrows rows",
          }),
        ),
        group(
          "Strafe trainer",
          trainerBox,
          segmented<TrainerPreset>("Preset", () => trainerPreset(P().hud.strafeTrainer) as TrainerPreset, (v) => (tp((t) => applyTrainerPreset(t, v)), ctx.refresh()), [
            ["beginner", "Beginner"],
            ["standard", "Standard"],
            ["strict", "Strict"],
          ], { desc: "Beginner is wide and steady with hints. Strict is tight and quick. Colour, height, dimming and sound stay yours.", keywords: "strafetrainer strafe trainer preset new player beginner easy hard" }),
          segmented<TrainerStyle>("Style", () => P().hud.strafeTrainer.style, (v) => tp((t) => (t.style = v)), [
            ["classic", "Classic"],
            ["detailed", "Detailed"],
            ["minimal", "Minimal"],
          ], { desc: "Classic is the original thin gauge. Detailed is a thick bar with coloured zones. Minimal is a thin zoned line with a marker.", keywords: "strafetrainer strafe trainer look style bar line" }),
          check("Follow the turn", () => P().hud.strafeTrainer.follow, (v) => tp((t) => (t.follow = v)), { desc: "100% sits in the middle and turning faster moves the marker the way you turn. Off: 0% on the left, 200% on the right.", keywords: "strafetrainer strafe trainer centre center middle direction mirror left right" }),
          range("Smoothing", () => P().hud.strafeTrainer.smoothing, (v) => tp((t) => (t.smoothing = v)), { min: 1, max: 20, step: 1, hint: "ticks", desc: "Averages the reading over this many ticks. 1 shows every tick as it is.", keywords: "strafetrainer strafe trainer smooth average jitter tickrate" }),
          range("On-pace zone", () => P().hud.strafeTrainer.zone, (v) => tp((t) => (t.zone = v)), { min: 2, max: 30, step: 1, unit: "%", desc: "How close to 100% counts as on pace. Amber reaches three times as far.", keywords: "strafetrainer strafe trainer zone width green tolerance" }),
          range("Height", () => P().hud.strafeTrainer.height, (v) => tp((t) => (t.height = v)), { min: 0.5, max: 3, step: 0.1, scale: 100, unit: "%", desc: "Thickness of the gauge. Edit layout changes the whole size.", keywords: "strafetrainer strafe trainer thick thickness bar size" }),
          range("Dim below", () => P().hud.strafeTrainer.dimBelow, (v) => tp((t) => (t.dimBelow = v)), { min: 0, max: 90, step: 5, unit: "%", desc: "The trainer fades while your pace is under this, and between strafes. 0 never fades it.", keywords: "strafetrainer strafe trainer dim fade threshold opacity" }),
          color("Trainer color", () => P().hud.strafeTrainer.color, (v) => tp((t) => (t.color = v)), { desc: "Colour of the marker and percentage. Pick a preset or any colour.", keywords: "strafetrainer strafe trainer colour color" }),
          check("Percentage", () => P().hud.strafeTrainer.showPace, (v) => tp((t) => (t.showPace = v)), { desc: "Show the pace number under the gauge.", keywords: "strafetrainer strafe trainer number percent text" }),
          check("Turn hints", () => P().hud.strafeTrainer.hints, (v) => tp((t) => (t.hints = v)), { desc: "Show small turn more and ease turn hints beside the percentage.", keywords: "strafetrainer strafe trainer coaching feedback hints" }),
          check("Jump sound", () => P().hud.strafeTrainer.sound, (v) => tp((t) => (t.sound = v)), { desc: "A tick on every jump: high when that jump was on pace, low when it was far off.", keywords: "strafetrainer strafe trainer sound audio tick beep jump" }),
        ),
        group("Jump stats", ...ssjRows(), toggle("Start Pre", () => P().hud.layout.startPre.on, (v) => up((p) => (p.hud.layout.startPre.on = v)), { desc: "Speed just before your first takeoff from the start zone. Stays until the next start or restart. Edit layout moves it.", keywords: "prestrafe start pre first jump speed" })),
        ...movementRows(),
      ],
    ],
    advanced: [
      group(
        "More elements",
        h(
          "div.check-grid",
          null,
          ...HUD_ELEMENTS.filter((e) => !QUICK_ELEMENTS.has(e.id)).map((e) => check(e.label, () => P().hud.layout[e.id].on, (v) => up((p) => (p.hud.layout[e.id].on = v)), { desc: ELEMENT_NOTES[e.id], keywords: "hud element show hide" })),
          check("Speed colours", () => P().hud.speedColors, (v) => up((p) => (p.hud.speedColors = v)), { desc: "Speed turns green while gaining, red while losing.", keywords: "gain loss color colour" }),
          check("Gain ticks", () => P().hud.gainTicks, (v) => up((p) => (p.hud.gainTicks = v)), { desc: "Each jump's speed gain floats off the speed.", keywords: "gain loss jump ssj speed tick" }),
          check("Edge glow", () => P().hud.edgeGlow, (v) => up((p) => (p.hud.edgeGlow = v)), { desc: "The edges of the screen glow at high speed.", keywords: "speed glow vignette edge effect" }),
          check("Zones", () => P().showZones, (v) => up((p) => (p.showZones = v)), { desc: "Start (green) and end (red) zone boxes in the world.", keywords: "start end box show zones" }),
        ),
      ),
      triggersGroup(),
      group(
        "Share layout",
        row("Layout code", h("div.share-row", null, code, exp, imp), { desc: "Export copies your HUD layout as a code; paste one and Import to use it. (Your whole setup: Export at the top of Settings.)", keywords: "share export import copy paste hud layout code" }),
      ),
    ],
  };
}

/** HUD → Advanced: the trigger and clip overlays (triggers/), on / off and their look. */
function triggersGroup(): HTMLElement {
  const t = () => P().triggers;
  const ut = (fn: (t: Prefs["triggers"]) => void) => up((p) => fn(p.triggers));
  return group(
    "Triggers and clips",
    toggle("Triggers", () => t().show, (v) => ut((x) => (x.show = v)), { desc: "Teleports, boosters and other map triggers in the world. !triggers picks which.", keywords: "show triggers teleport booster push gravity showtriggers" }),
    toggle("Clips", () => t().clips, (v) => ut((x) => (x.clips = v)), { desc: "Player clips and invisible walls in the world.", keywords: "show clips playerclip invisible walls showclips" }),
    segmented<TriggerStyle>("Style", () => t().style, (v) => ut((x) => (x.style = v)), [...TRIGGER_STYLES], {
      desc: "Filled: see-through boxes. Outline: their edges. Bottom: only the edges of each floor.",
      keywords: "trigger triggers clip clips style look outline wireframe edges bottom floor line filled transparent box",
    }),
    range("Line thickness", () => t().thickness, (v) => ut((x) => (x.thickness = v)), { min: TRIGGER_THICKNESS[0], max: TRIGGER_THICKNESS[1], step: 0.5, unit: "px", peek: true, desc: "Width of the edges.", keywords: "trigger triggers clip clips line lines width thick thin outline edges" }),
    range("Fill opacity", () => t().opacity, (v) => ut((x) => (x.opacity = v)), { min: TRIGGER_OPACITY[0], max: TRIGGER_OPACITY[1], step: 0.01, scale: 100, unit: "%", peek: true, when: () => t().style === "filled", desc: "How solid the filled boxes look.", keywords: "trigger triggers clip clips fill alpha transparency transparent see-through opacity" }),
    ...KINDS.map((k) => {
      const def = DEFAULT_TRIGGER_PREFS.colors[k.id];
      return color(k.label, () => t().colors[k.id], (v) => ut((x) => (x.colors[k.id] = v)), {
        swatches: [def, ...SWATCHES.filter((s) => s !== def)],
        peek: true,
        desc: `Colour of ${k.label.toLowerCase()}.`,
        keywords: `trigger triggers clip clips colour color ${k.id}`,
      });
    }),
  );
}

function flash(b: HTMLElement, text: string): void {
  const old = b.dataset.label ?? b.textContent ?? "";
  b.dataset.label = old;
  b.textContent = text;
  setTimeout(() => (b.textContent = old), 1400);
}

// ---------------------------------------------------------------------------------------------
// Keys (binds)

let capturing: (() => void) | null = null;

function bindSlot(action: Action, slot: number, refresh: () => void): HTMLElement {
  const code = prefs.get().binds[action][slot];
  const label = ACTIONS.find((a) => a.id === action)!.label;
  const b = h("button.bind", { type: "button", "data-action": action, "data-slot": String(slot), "aria-label": `${label} bind ${slot + 1}: ${code ? keyLabel(code) : "unbound"}. Press Enter to rebind` }, code ? keyLabel(code) : "—");
  if (!code) b.classList.add("empty");
  b.addEventListener("click", () => {
    capturing?.();
    b.classList.add("capturing");
    b.textContent = "Press a key or mouse button…";
    const assign = (c: string | null) => {
      stop();
      // The key leaves any other action that had it: that action's slots shake so you see where it came from.
      const took = c ? (Object.keys(prefs.get().binds) as Action[]).filter((a) => a !== action && prefs.get().binds[a].includes(c)) : [];
      prefs.update((p) => {
        if (c) for (const a of Object.keys(p.binds) as Action[]) p.binds[a] = p.binds[a].filter((x) => x !== c);
        const list = [...p.binds[action]];
        if (c) list[slot] = c;
        else list.splice(slot, 1);
        p.binds[action] = list.filter(Boolean);
      });
      refresh();
      if (c) landed(action, prefs.get().binds[action].indexOf(c), took);
    };
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") return stop(), refresh();
      if (e.key === "Backspace" || e.key === "Delete") return assign(null);
      assign(e.code);
    };
    const mouse = (e: MouseEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      assign(mouseCode(e.button));
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      assign(e.deltaY < 0 ? "MWheelUp" : "MWheelDown");
    };
    const block = (e: Event) => (e.preventDefault(), e.stopImmediatePropagation());
    const stop = () => {
      removeEventListener("keydown", key, true);
      removeEventListener("mousedown", mouse, true);
      removeEventListener("wheel", wheel, true);
      removeEventListener("contextmenu", block, true);
      capturing = null;
    };
    capturing = () => (stop(), refresh());
    // Defer so the click that started capture isn't captured as "Mouse 1".
    setTimeout(() => {
      addEventListener("keydown", key, true);
      addEventListener("mousedown", mouse, true);
      addEventListener("wheel", wheel, { capture: true, passive: false });
      addEventListener("contextmenu", block, true);
    }, 0);
  });
  return b;
}

/** A key that lands: the new keycap drops and settles with a low click; slots that lost the key shake. */
function landed(action: Action, slot: number, took: Action[]): void {
  const cap = document.querySelector<HTMLElement>(`.bind[data-action="${action}"][data-slot="${slot}"]`);
  const again = (el: Element, cls: string) => (el.classList.remove(cls), void (el as HTMLElement).offsetWidth, el.classList.add(cls));
  if (cap) again(cap, "landed");
  uiSound("ui_click", 1, 0.7);
  if (!took.length) return;
  for (const a of took) for (const el of document.querySelectorAll(`.bind[data-action="${a}"]`)) again(el.parentElement ?? el, "bind-nope");
  uiSound("ui_error", 0.6);
}

/** The ghost's colour as a small square beside its switch (instead of naming the colour). */
function ghostDot(kind: GhostKind, r: HTMLElement): HTMLElement {
  r.querySelector(".set-control")!.prepend(h("span.ghost-dot", { style: `--c:${GHOST_CSS[kind]}`, "aria-hidden": "true" }));
  return r;
}

const BIND_GROUPS: [string, Action[]][] = [
  ["Movement", ["forward", "back", "left", "right", "jump", "duck", "turnLeft", "turnRight", "turnFast"]],
  ["Run", ["restart", "restartBonus", "restartMain", "setStart", "clearStart", "cycleStyle", "mainMenu"]],
  ["Show / hide", ["keysOverlay", "hideUi", "viewmodel", "thirdPerson", "flashlight", "mute", "nextTrack"]],
  ["Carrot", ["attack", "attack2", "inspect"]],
  ["Practice", ["practice", "noclip", "cpSave", "cpTeleport", "cpPrev", "cpNext"]],
  ["Tools", ["hudEditor", "measurePoint", "clearMeasure", "lastLj"]],
  ["Weapons", ["slot1", "slot2", "slot3", "lastWeapon", "nextWeapon", "prevWeapon", "drop", "reload", "giveUsp", "giveGlock", "gunMenu"]],
  ["Paint", ["paint", "paintOnce", "clearPaint"]],
];
/** The words players use for each action (search). */
const BIND_KEYWORDS: Partial<Record<Action, string>> = {
  paint: "+paint hold draw color colour route landmark mouse4 mouse5 side button",
  paintOnce: "paint single mark stamp",
  clearPaint: "paint clear erase remove reset",
  forward: "forward walk run w move",
  back: "back backward backwards s move",
  left: "strafe left a move",
  right: "strafe right d move",
  jump: "jump scroll wheel mwheeldown mwheelup autohop bhop hop space",
  duck: "duck crouch ctrl control",
  use: "use doors buttons e interact",
  restart: "restart reset respawn r",
  restartBonus: "bonus next track main b f4",
  mainMenu: "main menu home leave quit exit lobby back backspace",
  restartMain: "main track m",
  setStart: "set start point position setstart ss spawn restart angle",
  clearStart: "clear delete start point position clearstart deletestart delstart spawn restart",
  cycleStyle: "style styles autohop scroll legit w-only sideways hsw f3",
  hudEditor: "hud editor layout f2",
  thirdPerson: "third person thirdperson camera t",
  attack: "slash attack mouse1 carrot knife",
  attack2: "stab attack2 mouse2 carrot knife",
  inspect: "inspect carrot knife f",
  viewmodel: "viewmodel hands carrot hide show",
  keysOverlay: "keys overlay wasd input display hide show toggle hud",
  hideUi: "hide ui hud interface clean clip record recording video screenshot timeline cinematic cl_drawhud f1 replay spectate",
  mute: "mute sound audio silence",
  nextTrack: "music next track skip song",
  practice: "practice mode training unranked",
  noclip: "noclip fly flying through walls practice z",
  cpSave: "checkpoint save cp saveloc practice c",
  cpTeleport: "checkpoint teleport tp load gocheck back practice x",
  cpPrev: "checkpoint previous prev back practice",
  cpNext: "checkpoint next forward practice",
  turnLeft: "+left turn left keyboard yaw arrow cl_yawspeed mouse4 mouse5 ranked",
  turnRight: "+right turn right keyboard yaw arrow cl_yawspeed mouse4 mouse5 ranked",
  turnFast: "+speed fast turn quick turn around 180 keyboard yaw arrow cl_anglespeedkey ranked",
  slot1: "weapon gun primary slot 1 shotgun rifle sniper",
  slot2: "weapon gun pistol secondary slot 2 glock usp",
  slot3: "weapon knife carrot slot 3",
  lastWeapon: "weapon gun last previous lastinv quick switch q",
  nextWeapon: "weapon gun next invnext scroll wheel cycle",
  prevWeapon: "weapon gun previous prev invprev scroll wheel cycle",
  drop: "weapon gun drop throw g",
  reload: "weapon gun reload ammo clip r",
  giveUsp: "usp pistol cottontail gun weapon give command !usp",
  giveGlock: "glock pistol thumper gun weapon give command !glock",
  gunMenu: "guns gun menu weapons picker give command !gun !guns ak awp",
};

/** The default keys of `action`, for people ("W", "Space, Wheel ↕", "unbound"). */
const defaultKeys = (action: Action) => DEFAULT_PREFS.binds[action].map(keyLabel).join(", ") || "unbound";

/**
 * A row's way back to its default keys: kept in place (so the keycaps line up down the page) but hidden and out of the
 * tab order while the row has them.
 */
function bindReset(action: Action, label: string, refresh: () => void): HTMLElement {
  const off = bindIsDefault(P().binds, action);
  const keys = defaultKeys(action);
  const b = h("button.bind-reset", { type: "button", disabled: off, title: `Default: ${keys}`, "aria-label": `Reset ${label} to its default keys: ${keys}` }, icon("reset"));
  b.addEventListener("click", () => {
    capturing?.();
    let took: Action[] = [];
    up((p) => (took = resetBind(p.binds, action)));
    refresh();
    landed(action, 0, took);
    // The button goes with the change: focus stays on the row.
    document.querySelector<HTMLElement>(`.bind[data-action="${action}"][data-slot="0"]`)?.focus({ preventScroll: true });
  });
  return b;
}

function keysSection(ctx: Ctx): SettingsContent {
  const bindRow = (a: Action) => {
    const label = ACTIONS.find((x) => x.id === a)!.label;
    const r = row(label, h("div.bind-line", null, h("div.bind-pair", null, bindSlot(a, 0, ctx.refresh), bindSlot(a, 1, ctx.refresh)), bindReset(a, label, ctx.refresh)), {
      // (How to rebind is said once, in the section's header line, not on every row.)
      desc: () => (bindIsDefault(P().binds, a) ? "" : `Default: ${defaultKeys(a)}.`),
      keywords: `bind key rebind keybind ${BIND_KEYWORDS[a] ?? ""}`,
    });
    r.classList.add("bind-row");
    return r;
  };
  const [move, run, toggles, carrot, practice, tools, weapons, paint] = BIND_GROUPS;
  return {
    columns: [
      [
        group(
          move[0],
          ...move[1].map(bindRow),
          toggle("Null binds", () => P().nullBinds, (v) => up((p) => (p.nullBinds = v)), {
            info: "When you hold A and D together, the last one you pressed wins instead of both cancelling out. Same for W and S.",
            desc: "Letting go of the newer key goes back to the one still held. Works in every style except Legit Scroll, and always in practice.",
            keywords: "null bind binds nulls snap tap socd last input priority a d w s cancel overlap strafe script",
          }),
          range("Turn speed", () => P().yawSpeed, (v) => up((p) => (p.yawSpeed = Math.round(v))), {
            min: YAW_SPEED_RANGE[0], max: YAW_SPEED_RANGE[1], step: 5, unit: "°/s",
            desc: "How fast Turn left and Turn right turn the view. CS:S cl_yawspeed (default 210). A change applies from your next restart.",
            keywords: "cl_yawspeed turn speed yaw rate +left +right keyboard arrow",
          }),
          range("Fast turn", () => P().angleSpeedKey, (v) => up((p) => (p.angleSpeedKey = Math.round(v * 20) / 20)), {
            min: ANGLE_SPEED_KEY_RANGE[0], max: ANGLE_SPEED_KEY_RANGE[1], step: 0.05, unit: "×",
            desc: "Turn speed multiplier while Fast turn is held. CS:S cl_anglespeedkey.",
            keywords: "cl_anglespeedkey +speed fast turn quick 180 multiplier",
          }),
        ),
        group(carrot[0], ...carrot[1].map(bindRow)),
        group(paint[0], ...paint[1].map(bindRow)),
        group(
          practice[0],
          ...practice[1].map(bindRow),
          toggle("Teleport keeps speed", () => P().practice.keepVelocity, (v) => up((p) => (p.practice.keepVelocity = v)), {
            desc: "On: a checkpoint teleport gives you back the speed you saved it with. Off: you arrive standing still.",
            keywords: "checkpoint teleport velocity speed keep zero stop practice",
          }),
        ),
        ctx.openControls ? h("div.set-aside", null, h("button.link-btn", { type: "button", onclick: ctx.openControls }, "How to bhop and every control", icon("chevronRight"))) : null,
      ].filter((x): x is HTMLElement => !!x),
      [
        group(
          run[0],
          ...run[1].map(bindRow),
          toggle("Hold to restart", () => P().holdRestart, (v) => up((p) => (p.holdRestart = v)), {
            desc: "Restart, bonus and main track keys only act after a short hold (half a second); a quick tap does nothing. Off: they act on press. Chat !r / !b stay instant.",
            keywords: "hold restart reset accident accidental confirm protect long run r",
          }),
          select<AutoRestartWhen>("Auto restart", () => P().autoRestart.when, (v) => up((p) => (p.autoRestart.when = v)), [["off", "Off"], ["pb", "Past your PB"], ["wr", "Past the world record"], ["ghost", "Past the custom ghost"]], {
            desc: "Restarts a timed run once its time passes that one. Not in practice or during a !race.",
            keywords: "auto automatic restart reset pb wr world record ghost race custom slower behind short maps",
          }),
          segmented<AutoRestartAction>("When it passes", () => P().autoRestart.action, (v) => up((p) => (p.autoRestart.action = v)), [["restart", "Restart"], ["sound", "Sound only"]], {
            when: () => P().autoRestart.when !== "off",
            desc: "Sound only plays a low beep and lets the run go on.",
            keywords: "auto restart sound beep cue warning",
          }),
        ),
        group(toggles[0], ...toggles[1].map(bindRow)),
        group(weapons[0], ...weapons[1].map(bindRow)),
      ],
    ],
    advanced: [group(tools[0], ...tools[1].map(bindRow), row("Pause / menu", h("div.bind-line", null, h("div.bind-pair", null, h("span.bind.fixed", null, "Esc")), h("span.bind-reset", { "aria-hidden": "true" })), { desc: "Fixed: Esc always opens the menu.", keywords: "escape esc pause menu" }))],
  };
}

// ---------------------------------------------------------------------------------------------
// Ghost

function ghostSection(): SettingsContent {
  const g = <K extends keyof Prefs["ghost"]>(k: K) => (v: Prefs["ghost"][K]) => up((p) => (p.ghost[k] = v));
  const file = h("input", { type: "file", accept: ".bhr,application/octet-stream", hidden: true, "aria-label": "Replay file to race" });
  const load = button("Load .bhr…", () => file.click());
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    requestRace({ kind: "bytes", bytes: new Uint8Array(await f.arrayBuffer()) });
    flash(load, "Loaded");
    file.value = "";
  });
  return {
    columns: [
      [
        group(
          "Race",
          toggle("Show ghosts", () => P().showGhost, (v) => up((p) => (p.showGhost = v)), { desc: "Ghosts start with your timer when you leave the start zone. The switches below pick which ones.", keywords: "race ghost ghosts" }),
          ghostDot("pb", toggle("Your PB", () => P().ghost.pb, g("pb"), { desc: "Your fastest run on this map and track.", keywords: "personal best gold pb ghost" })),
          ghostDot("wr", toggle("World record", () => P().ghost.wr, g("wr"), { desc: "The #1 run on the leaderboard.", keywords: "wr blue world record ghost" })),
          ghostDot("custom", toggle("Custom ghost", () => P().ghost.custom, g("custom"), { desc: "A loaded replay file or a leaderboard run you chose to race.", keywords: "white custom ghost" })),
        ),
        group(
          "Players and name tags",
          toggle("Ghost tags", () => P().ghost.tag, g("tag"), { hint: "Name, time and live +/-", keywords: "name tag label delta ghost" }),
          toggle("Player glow", () => P().showPlayerGlow, (v) => up((p) => (p.showPlayerGlow = v)), { desc: "Show supporters’ coloured outline and aura on players and replays.", keywords: "supporter glow outline aura players" }),
          toggle("First-person glow", () => P().firstPersonGlow, (v) => up((p) => (p.firstPersonGlow = v)), { desc: "Your own supporter glow on your hands and knife.", keywords: "supporter glow first person viewmodel hands knife" }),
          toggle("Player tags", () => P().tags.players, (v) => up((p) => (p.tags.players = v)), { desc: "Name and run time above other players on a server.", keywords: "name names tag tags nametag label players multiplayer room server mp_playerid" }),
          toggle("Names through walls", () => P().tags.throughWalls, (v) => up((p) => (p.tags.throughWalls = v)), {
            hint: "Off: like CS:S",
            desc: "Ghost and player tags stay visible behind walls. Off: like CS:S, a tag only shows while you can see who it belongs to.",
            keywords: "name tag nametag label wallhack wall occlusion players multiplayer mp_playerid",
          }),
        ),
      ],
      [
        group(
          "Look",
          range("Opacity", () => P().ghost.opacity, g("opacity"), { min: 0.15, max: 1, step: 0.05, scale: 100, unit: "%", desc: "How solid ghosts look.", keywords: "alpha transparent ghost opacity" }),
          toggle("Trail", () => P().ghost.trail, g("trail"), { desc: "Fading path of the ghost's last few seconds.", keywords: "path line ghost trail" }),
        ),
        group(
          "Route guide",
          toggle("Ghost route", () => P().ghost.route, g("route"), { desc: "A persistent path with white boxes at each takeoff, visible before and during your run. Only you see it. Show ghosts and the chosen source must be on.", keywords: "route ghost path line jump jumps takeoff marker box beam trace practice racing optimize" }),
          select<GhostRouteSource>("Route ghost", () => P().ghost.routeSource, g("routeSource"), [["auto", "Auto (custom, PB, WR)"], ["pb", "Your PB"], ["wr", "World record"], ["custom", "Custom ghost"]], { when: () => P().ghost.route, desc: "Auto follows the custom ghost you chose to race, or your PB, then the WR. A specific source shows a route only when that ghost is loaded and enabled.", keywords: "route ghost choose source race replay leaderboard pb wr custom" }),
          segmented<GhostRouteMode>("Route path", () => P().ghost.routeMode, g("routeMode"), [["jumps", "Jump to jump"], ["path", "Recorded path"]], { when: () => P().ghost.route, desc: "Jump to jump draws straight links between takeoffs. Recorded path follows every movement tick, including turns and air arcs. Both break at teleports and mark the same takeoffs.", keywords: "route straight line path exact full curved jump jumps" }),
        ),
      ],
    ],
    advanced: [
      group(
        "More",
        toggle("Fade when close", () => P().ghost.nearFade, g("nearFade"), { desc: "Ghosts fade out when you run through them, so they never block your view.", keywords: "fade near close ghost" }),
        row("Replay file", h("div.btn-row", null, load, button("Clear", () => (requestRace({ kind: "clear" }), flash(load, "Cleared"))), file), {
          desc: "Race any .bhr replay: it appears when you run its map and track.",
          keywords: "bhr load race custom replay file",
        }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Graphics

/** Keyboard Lock (Chromium) — same check as play-lock.ts, inlined to keep the settings screen free of game modules. */
const keyboardLockSupported = typeof (navigator as Navigator & { keyboard?: { lock?: unknown } }).keyboard?.lock === "function";

let cinematicController:AbortController|null=null;
const cinematicBackupKey="bunnyhop:cinematic-custom-v1";
let cinematicPrevious:Prefs["graphics"]|null=null;
try{const saved=JSON.parse(localStorage.getItem(cinematicBackupKey)??"null");if(saved&&typeof saved==="object"&&["source","classic","enhanced","cinematic"].includes(saved.preset))cinematicPrevious=saved;}catch{}
let cinematicGeneration=0;
let cinematicRestore:(()=>Promise<void>)|null=null;
/** One line under Look while Cinematic downloads or switches back; empty (hidden) otherwise. */
let cinematicStatus="";
const cinematicNodes=new Set<HTMLElement>();
function cinematicStatusNode(){const node=h("p.set-note",{role:"status",hidden:!cinematicStatus},cinematicStatus);cinematicNodes.add(node);return node;}
function paintCinematicStatus(){for(const node of cinematicNodes){if(node.isConnected){node.textContent=cinematicStatus;node.hidden=!cinematicStatus;}else cinematicNodes.delete(node);}}
async function chooseGraphicsPreset(value:Prefs["graphics"]["preset"]){
 const generation=++cinematicGeneration;cinematicController?.abort();cinematicController=null;
 if(value!=="cinematic"){
  // Disabling graphics must not depend on storage/network recovery succeeding.
  const leaving=!!cinematicPrevious;
  up(p=>{p.graphics=cinematicPrevious?{...cinematicPrevious,preset:value}:{...p.graphics,preset:value};});
  let restoreError:unknown=null;
  try{if(cinematicRestore){const restore=cinematicRestore;cinematicRestore=null;await restore();}
    else if(cinematicPrevious){const {restoreCinematicAssets}=await import("../graphics/cinematic-assets");await restoreCinematicAssets();}}
  catch(error){restoreError=error;}
  if(generation!==cinematicGeneration)return;
  if(!restoreError){cinematicPrevious=null;localStorage.removeItem(cinematicBackupKey);}
  cinematicStatus=restoreError?"Your settings are back, but the Cinematic materials couldn't be switched off. Pick Plain to try again. "+String((restoreError as Error).message??restoreError):leaving?"Your settings from before Cinematic are back. Textures change from the next map.":"";paintCinematicStatus();return;
 }
 cinematicPrevious??={...P().graphics};localStorage.setItem(cinematicBackupKey,JSON.stringify(cinematicPrevious));const controller=new AbortController();cinematicController=controller;
 up(p=>{p.graphics=cinematicSettings(p.graphics);});cinematicStatus="Downloading the Cinematic sky and materials…";paintCinematicStatus();
 try{const {ensureCinematicAssets}=await import("../graphics/cinematic-assets");controller.signal.throwIfAborted();const assets=await ensureCinematicAssets(controller.signal);if(controller.signal.aborted||P().graphics.preset!=="cinematic"){await assets.restore();return;}cinematicRestore=assets.restore;cinematicStatus="Cinematic is on. Its textures show from the next map.";}
 catch(error){if(controller.signal.aborted)return;cinematicStatus="Cinematic is on, but its sky and materials couldn't download. "+String((error as Error).message??error);}
 finally{if(cinematicController===controller)cinematicController=null;paintCinematicStatus();}
}

function graphicsSection(ctx: Ctx): SettingsContent {
  const res = h("small.set-readout");
  const paintRes = () => {
    const v = gameView(P().graphics, innerWidth, innerHeight);
    res.textContent = `${v.bufW}×${v.bufH}`;
  };
  paintRes();
  const G = () => P().graphics;
  const fitRow = segmented<AspectFit>("Fit", () => G().aspectFit, (v) => (up((p) => (p.graphics.aspectFit = v)), paintRes()), [
    ["stretch", "Stretched"],
    ["bars", "Black bars"],
  ], { desc: "Stretched fills your screen with the fixed aspect ratio. Black bars keeps its shape.", keywords: "stretched black bars letterbox pillarbox fit aspect" });
  fitRow.hidden = G().aspect === "native";
  // Quality presets set Potato mode, antialiasing, anisotropic filtering, resolution and water reflections together;
  // changing any of them by hand shows no preset lit (custom).
  const presetRow = segmented<GraphicsPreset>("Preset", () => graphicsPreset(G()) as GraphicsPreset, (v) => (up((p) => applyGraphicsPreset(p.graphics, v)), ctx.refresh()), [
    ["lowest", "Lowest"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
  ], {
    desc: "Lowest: Potato mode at half resolution, for PCs without a real graphics card. Low: Potato mode. Medium: full textures without antialiasing or water reflections. High: everything on. Antialiasing changes apply after a reload.",
    keywords: "preset quality low medium high lowest potato performance fps lag laptop school chromebook integrated",
  });
  const repaintPreset = () => (presetRow as HTMLElement & { repaint?: () => void }).repaint?.();
  // A setting under a switch that's off (shadow strength under Sun shadows off) hides until it applies.
  const profiled = () => G().lightingProfile !== "map" || G().ambienceShowcase || G().lightingSource === "pack";
  const giOn = () => G().dynamicGI || G().tracedGI;
  return {
    columns: [
      [
        group(
          "Quality",
          presetRow,
          select("Look", () => G().preset, (v) => void chooseGraphicsPreset(v), [
            ["source", "Source"], ["classic", "Plain"], ["enhanced", "Enhanced"], ["cinematic", "Cinematic · experimental"],
          ], { hint: G().potato ? "Potato mode overrides this" : undefined, desc: "Source draws maps the way CS:S does: reflective water, and auto exposure and bloom on maps with HDR lighting. Plain is the fastest. Enhanced and Cinematic add effects CS:S doesn't have (their settings are under Advanced); Cinematic downloads its sky and materials once (about 23 MB).", keywords: "look source css cs:s hdr bloom exposure water reflections plain classic enhanced cinematic graphics" }),
          cinematicStatusNode(),
          toggle("Potato mode", () => G().potato, (v) => (up((p) => (p.graphics.potato = v)), paintRes(), repaintPreset()), {
            hint: "Flat colours, fewer effects",
            desc: "For slow GPUs and laptops: flat colours like dev textures, plain water and sky, no 3D skybox, no HiDPI.",
            keywords: "potato low performance fps lag laptop slow graphics quality textures dev flat",
          }),
          toggle("Antialiasing", () => G().antialias, (v) => (up((p) => (p.graphics.antialias = v)), repaintPreset()), {
            hint: "Applies after a reload",
            desc: "Smooths jagged edges (MSAA). Turning it off is one of the biggest FPS gains on integrated graphics and slow PCs.",
            keywords: "antialiasing anti-aliasing aa msaa jagged edges smooth performance fps",
          }),
          toggle("Water reflections", () => G().waterReflections, (v) => (up((p) => (p.graphics.waterReflections = v)), repaintPreset()), {
            desc: "Water reflects the map, like CS:S. Draws the scene again wherever water is in view, so it costs FPS near water. Source look only.",
            keywords: "water reflections reflect expensive performance fps",
          }),
          select("Anisotropic filtering", () => G().anisotropy, (v) => (up((p) => (p.graphics.anisotropy = v)), repaintPreset()), [
            [1, "Off"],
            [2, "2×"],
            [4, "4×"],
            [8, "8×"],
            [16, "16×"],
          ], { desc: "Sharper textures on floors and walls seen at an angle. Costs a little GPU time, and a lot on PCs drawing without a graphics card.", keywords: "af texture filtering quality" }),
        ),
        skyGroup(ui, ctx),
      ],
      [
        group(
          "Colour & visibility",
          range("Brightness", () => G().brightness, (v) => up((p) => (p.graphics.brightness = v)), {
            min: 0.5, max: 2, step: 0.05, scale: 100, unit: "%", peek: true,
            desc: "Lighten or darken the game view. 100% keeps the original brightness. Does not affect HUD or menu colours.",
            keywords: "brightness light dark exposure visibility video",
          }),
          range("Gamma", () => G().gamma, (v) => up((p) => (p.graphics.gamma = v)), {
            min: 0.5, max: 2.5, step: 0.05, peek: true,
            desc: "Raise gamma to reveal dark midtones without changing pure black and white. 1 is neutral.",
            keywords: "gamma dark shadows visibility video",
          }),
          range("Vibrance", () => G().vibrance, (v) => up((p) => (p.graphics.vibrance = v)), {
            min: 0, max: 2, step: 0.05, scale: 100, unit: "%", peek: true,
            desc: "Adjust colour intensity in the game view. 100% keeps map colours; 0% is greyscale.",
            keywords: "vibrance saturation colour color video",
          }),
          toggle("Fullbright", () => G().fullbright, (v) => up((p) => (p.graphics.fullbright = v)), {
            peek: true,
            desc: "Remove baked lighting from map surfaces and props to make dark platforms easier to see. Keeps textures, fog and transparency. Works in Potato mode. Local view only.",
            keywords: "fullbright full bright lighting dark map shadows visibility video",
          }),
          toggle("Flashlight", () => G().flashlight, (v) => up((p) => (p.graphics.flashlight = v)), { hint: P().binds.flashlight?.[0] ? `${keyLabel(P().binds.flashlight[0])} in game` : undefined, desc: "Light up dark platforms where you look. Works in Potato mode and starts off on each map. Local view only; its state is not recorded in replays.", keywords: "flashlight torch dark lighting visibility lamp" }),
        ),
        group(
          "Display",
          toggle("Fullscreen when playing", () => G().fullscreen, (v) => up((p) => (p.graphics.fullscreen = v)), {
            hint: keyboardLockSupported ? "Also keeps Ctrl+W from closing the tab" : "Clicking into the game goes fullscreen",
            desc: keyboardLockSupported
              ? "Clicking into the game goes fullscreen and takes the keyboard: Ctrl+W (crouch + forward) can't close the tab, Esc pauses and resumes. Hold Esc to leave fullscreen."
              : "Clicking into the game goes fullscreen. This browser can't take the keyboard in fullscreen, so Esc also leaves fullscreen and Ctrl+W can still close the tab (you get a \"Leave site?\" prompt mid-run).",
            keywords: "fullscreen full screen keyboard lock ctrl+w close tab esc",
          }),
          range("Resolution", () => G().resolutionScale, (v) => (up((p) => (p.graphics.resolutionScale = v)), paintRes(), repaintPreset()), {
            min: 0.25, max: 2, step: 0.05, scale: 100, unit: "%", readout: res, peek: true,
            desc: "The game's render resolution. Lower it for more FPS on slow GPUs and laptops; above 100% sharpens edges and costs a lot. 100% = your screen (capped at 2× pixel density).",
            keywords: "fps performance render quality resolution scale scaling low res upscale downscale",
          }),
          select<AspectRatio>("Aspect ratio", () => G().aspect, (v) => (up((p) => (p.graphics.aspect = v)), paintRes(), fitRow.hidden = v === "native"), [
            ["native", "Screen"],
            ["4:3", "4:3"],
            ["5:4", "5:4"],
            ["16:10", "16:10"],
            ["16:9", "16:9"],
          ], {
            desc: "Draw the game at a fixed aspect ratio instead of your screen's. Stretched fills the screen, so everything looks wider (CS players' 4:3 stretched); black bars keeps the shape. Your FOV stays horizontal at 4:3, as in CS:S. In game only.",
            keywords: "aspect ratio stretched stretch 4:3 5:4 16:10 black bars letterbox res resolution cs krunker",
          }),
          fitRow,
          toggle("Sharp pixels", () => G().pixelated, (v) => up((p) => (p.graphics.pixelated = v)), {
            desc: "Scale a lowered resolution up with crisp square pixels instead of smoothing it.",
            keywords: "pixelated pixel nearest sharp crisp retro upscale filter blurry",
          }),
          segmented<MenuBackground>("Menu background", () => G().menuBackground, (v) => up((p) => (p.graphics.menuBackground = v)), [
            ["live", "Live map"],
            ["still", "Still"],
            ["off", "Off"],
          ], { desc: "A live map flythrough (or your PB ghost) behind the main menu. It drops to a still frame by itself if your GPU can't keep up.", keywords: "attract menu background main menu performance" }),
        ),
        group(
          "Frame rate",
          select("FPS limit", () => G().fpsLimit, (v) => up((p) => (p.graphics.fpsLimit = v)), [
            [60, "60"],
            [100, "100"],
            [144, "144"],
            [240, "240"],
            [360, "360"],
            [480, "480"],
            [720, "720"],
            [1000, "1000"],
            [0, "Unlimited"],
          ], {
            desc: "Above your refresh rate needs Exceed monitor FPS.",
            keywords: "fps cap limit max frame rate frames framerate unlimited uncapped vsync 1000",
          }),
          toggle("Exceed monitor FPS", () => G().uncapped, (v) => up((p) => (p.graphics.uncapped = v)), {
            desc: "Needs Low-latency canvas (Advanced), or a browser started with --disable-gpu-vsync --disable-frame-rate-limit.",
            keywords: "uncapped unlimited fps vsync latency frame rate exceed refresh",
          }),
        ),
      ],
    ],
    advanced: [
      group(
        "Effects",
        toggle("Bloom", () => G().bloom, (v) => up((p) => (p.graphics.bloom = v)), { desc: "Glow around bright surfaces. Source look: CS:S's bloom, on maps with HDR lighting only (as in CS:S). Enhanced and Cinematic: their own, softer glow.", keywords: "glow bloom hdr" }),
        toggle("Map visual profiles", () => G().mapProfiles, (v) => up((p) => (p.graphics.mapProfiles = v)), { desc: "Gentle bloom and haze tuning made for a few maps. Other maps look as they do without it. Enhanced and Cinematic only.", keywords: "map visual profile" }),
        toggle("Material detail", () => G().materialResponse, (v) => up((p) => (p.graphics.materialResponse = v)), { desc: "Roughness and normal detail lit by the map's own sun, on top of its baked lighting. Enhanced and Cinematic only.", keywords: "normal roughness material detail pbr" }),
        toggle("Edge smoothing", () => G().spatialAA, (v) => up((p) => (p.graphics.spatialAA = v)), { desc: "Smooths geometry edges in Enhanced and Cinematic, before the viewmodel and HUD are drawn.", keywords: "antialiasing fxaa edges" }),
        toggle("Contact shading", () => G().contactShading, (v) => up((p) => (p.graphics.contactShading = v)), { desc: "Soft shading in corners and where surfaces touch. Enhanced and Cinematic only; costs an extra pass.", keywords: "ambient occlusion ssao shadows depth" }),
        toggle("Atmospheric haze", () => G().atmosphere, (v) => up((p) => (p.graphics.atmosphere = v)), { desc: "A light haze over distance. Enhanced and Cinematic only; costs an extra pass.", keywords: "fog atmosphere depth" }),
        toggle("Sun shafts", () => G().sunShafts, (v) => up((p) => (p.graphics.sunShafts = v)), { desc: "Light rays from the sun, on maps that have one. Enhanced and Cinematic only.", keywords: "sun shafts god rays light" }),
        toggle("Volumetric light", () => G().volumetric, (v) => up((p) => (p.graphics.volumetric = v)), { desc: "Light scattering in the air, blocked by the sun's shadows. Needs Sun shadows and a map with a sun. Enhanced and Cinematic only.", keywords: "volumetric atmosphere fog light scattering" }),
      ),
      group(
        "Lighting",
        select("Lighting profile", () => G().ambienceShowcase && G().lightingProfile === "map" ? "ambience" : G().lightingProfile, (v) => up((p) => { p.graphics.lightingProfile = v; p.graphics.ambienceShowcase = v === "ambience"; if (v !== "map") { p.graphics.preset = composerPreset(p.graphics.preset); p.graphics.dynamicShadows = true; } if (v === "ambience") p.graphics.skyMode = "procedural"; }), [["map", "Map's own"], ["auto", "Automatic"], ["balanced", "Balanced"], ["daylight", "Daylight"], ["indoor", "Indoor / night"], ["ambience", "Ambience showcase"]], { desc: "Extra light over the map's baked lighting. Anything but the map's own switches Source or Plain to Enhanced and turns on sun shadows. Automatic picks daylight on maps with a sun, indoor on the rest. Ambience showcase is made for one map.", keywords: "lighting profile ambience cinematic sun indoor night daylight" }),
        range("Sun strength", () => G().directContribution, (v) => up((p) => (p.graphics.directContribution = v)), { min: 0, max: 2, step: 0.05, scale: 100, unit: "%", when: profiled, desc: "How strong the profile's sun light is, over the baked lighting.", keywords: "direct light contribution sun strength" }),
        range("Ambient strength", () => G().ambientContribution, (v) => up((p) => (p.graphics.ambientContribution = v)), { min: 0, max: 2, step: 0.05, scale: 100, unit: "%", when: profiled, desc: "How much fill light the profile (or the sky pack) adds.", keywords: "sky ambient contribution fill" }),
        select("Sun shadows", () => G().dynamicShadows ? G().shadowQuality : "off", (v) => up((p) => { p.graphics.dynamicShadows = v !== "off"; if (v !== "off") p.graphics.shadowQuality = v; }), [["off", "Off"], ["low", "Low · 512"], ["medium", "Medium · 1024"], ["high", "High · 2048"]], { desc: "Real sun shadows from moving things and players, over the baked lighting. Maps with a sun, Enhanced and Cinematic only.", keywords: "dynamic sun shadow map moving players quality" }),
        range("Shadow strength", () => G().shadowStrength, (v) => up((p) => (p.graphics.shadowStrength = v)), { min: 0, max: .4, step: .01, scale: 100, unit: "%", when: () => G().dynamicShadows, desc: "How dark the extra shadows are. Dark rooms keep their detail.", keywords: "shadow contribution strength" }),
        range("Shadow range", () => G().shadowDistance, (v) => up((p) => (p.graphics.shadowDistance = v)), { min: 256, max: 4096, step: 128, unit: " units", when: () => G().dynamicShadows, desc: "How far around you shadows reach. Smaller is sharper.", keywords: "shadow range distance" }),
        select("Nearby light shadows", () => G().localLights ? G().localQuality : "off", (v) => up((p) => { p.graphics.localLights = v !== "off"; if (v !== "off") p.graphics.localQuality = v; }), [["off", "Off"], ["low", "Low · 128"], ["medium", "Medium · 256"], ["high", "High · 512"]], { desc: "Coloured light and shadows from the map's lamps near you. Can be expensive. Enhanced and Cinematic only.", keywords: "point spot local light shadows lamps" }),
        select("Nearby lights", () => G().localBudget, (v) => up((p) => (p.graphics.localBudget = v)), [[1, "One"], [2, "Two"]], { when: () => G().localLights, desc: "How many lamps at once. Only lamps in view count.", keywords: "local light budget" }),
        range("Nearby light strength", () => G().localStrength, (v) => up((p) => (p.graphics.localStrength = v)), { min: 0, max: .5, step: .01, scale: 100, unit: "%", when: () => G().localLights, desc: "How much the lamps add over the baked lighting.", keywords: "local light contribution strength" }),
        select("Bounce light", () => G().tracedGI ? "traced" : G().dynamicGI ? "screen" : "off", (v) => up((p) => { p.graphics.tracedGI = v === "traced"; p.graphics.dynamicGI = v === "screen"; }), [["off", "Off"], ["screen", "Screen-space"], ["traced", "Traced · experimental"]], { desc: "Light bouncing off surfaces, over the baked lighting. Traced follows one bounce through the whole map and loads only when picked; it can be slow. Enhanced and Cinematic only.", keywords: "ray tracing world gi indirect bounce global illumination experimental" }),
        ui.dependsOn(hybridStatusNode(), () => G().tracedGI),
        select("Bounce quality", () => G().giQuality, (v) => up((p) => (p.graphics.giQuality = v)), [["low", "Low"], ["medium", "Medium"]], { when: () => G().dynamicGI, desc: "Screen-space bounce quality." , keywords: "indirect gi quality" }),
        range("Bounce strength", () => G().giStrength, (v) => up((p) => (p.graphics.giStrength = v)), { min: 0, max: .5, step: .01, scale: 100, unit: "%", when: giOn, desc: "How much bounced light is added.", keywords: "indirect contribution gi strength" }),
        range("Bounce range", () => G().giRange, (v) => up((p) => (p.graphics.giRange = v)), { min: 32, max: 512, step: 32, unit: " units", when: giOn, desc: "How far light travels in a bounce.", keywords: "indirect range gi distance" }),
      ),
      group(
        "Clouds",
        toggle("Volumetric clouds", () => G().clouds, (v) => up((p) => { p.graphics.clouds = v; if (v) p.graphics.preset = composerPreset(p.graphics.preset); }), { desc: "Moving 3D clouds (switches Source or Plain to Enhanced). Best with a clear sky; photographed skies have their own clouds. Costs GPU time.", keywords: "clouds weather volumetric" }),
        select("Cloud quality", () => G().cloudQuality, (v) => up((p) => (p.graphics.cloudQuality = v)), [["low", "Low · 320×180"], ["medium", "Medium · 480×270"], ["high", "High · 640×360"]], { when: () => G().clouds, desc: "The resolution clouds are drawn at.", keywords: "cloud quality" }),
        range("Cloud coverage", () => G().cloudCoverage, (v) => up((p) => (p.graphics.cloudCoverage = v)), { min: 0, max: 1, step: .01, scale: 100, unit: "%", when: () => G().clouds, keywords: "cloud coverage amount" }),
        range("Cloud density", () => G().cloudDensity, (v) => up((p) => (p.graphics.cloudDensity = v)), { min: 0, max: 2, step: .05, scale: 100, unit: "%", when: () => G().clouds, keywords: "cloud density thickness" }),
      ),
      group(
        "Frame rate",
        toggle("Low-latency canvas", () => G().lowLatency, (v) => up((p) => (p.graphics.lowLatency = v)), {
          desc: "Applies after a reload.",
          keywords: "low latency desynchronized canvas vsync fps tearing uncapped",
        }),
        select("FPS limit in menus", () => G().menuFps, (v) => up((p) => (p.graphics.menuFps = v)), [
          [0, "Same as playing"],
          [30, "30"],
          [60, "60"],
          [120, "120"],
        ], { keywords: "menu fps cap battery power pause" }),
      ),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Audio (default content until an audio module registers "audio")

function audioSection(): SettingsContent {
  return {
    columns: [
      [group("Volume", range("Master volume", () => P().volume, (v) => up((p) => (p.volume = v)), { min: 0, max: 1, step: 0.05, scale: 100, unit: "%", desc: "Overall game volume.", keywords: "sound audio" }))],
      [],
    ],
  };
}

// ---------------------------------------------------------------------------------------------

const BUILTIN: Section[] = [
  { id: "mouse", label: "Mouse & view", blurb: "", order: 10, render: mouseSection, reset: resetKeys("sensitivity", "verticalSensitivityEnabled", "verticalSensitivity", "dpi", "dpiConfirmed", "dpiHidden", "invertY", "rawInput", "spikeFilter", "timedInput", "inputStats", "fov") },
  { id: "crosshair", label: "Crosshair", blurb: "", order: 20, render: crosshairSection, reset: resetKeys("crosshair") },
  { id: "hud", label: "HUD", blurb: "", order: 30, render: hudSection, reset: resetKeys("hud", "showZones", "triggers") },
  { id: "keys", label: "Keys", blurb: "Click a slot, then press a key. Backspace clears.", order: 40, render: keysSection, reset: resetKeys("binds", "holdRestart", "autoRestart", "practice", "nullBinds", "yawSpeed", "angleSpeedKey") },
  { id: "ghost", label: "Ghosts & players", blurb: "", order: 50, render: ghostSection, reset: resetKeys("showGhost", "ghost", "tags", "showPlayerGlow", "firstPersonGlow") },
  { id: "graphics", label: "Graphics", blurb: "", order: 60, render: graphicsSection, reset: () => void chooseGraphicsPreset("source").then(() => { resetKeys("graphics")(); up((p) => (p.models = clone(DEFAULT_PREFS.models))); }) },
  { id: "audio", label: "Audio", blurb: "", order: 70, render: audioSection, reset: resetKeys("volume") },
];

/** Built-ins with registered sections merged in (same id replaces the content; new ids add sections). */
function sections(): Section[] {
  const out = BUILTIN.map((s) => ({ ...s }));
  const nested = registeredSections().filter(r => r.advancedUnder);
  for (const r of registeredSections().filter(r => !r.advancedUnder)) {
    const base = out.find((s) => s.id === r.id);
    const entry: Section = {
      id: r.id,
      label: r.label ?? base?.label ?? r.id,
      blurb: r.blurb ?? base?.blurb ?? "",
      order: r.order ?? base?.order ?? 100,
      icon: r.icon ?? base?.icon,
      render: (ctx) => r.render(ui, ctx),
      reset: r.reset,
    };
    if (base) Object.assign(base, entry);
    else out.push(entry);
  }
  for (const parent of out) {
    const children=nested.filter(r=>r.advancedUnder===parent.id).sort((a,b)=>(a.order??100)-(b.order??100));
    if(!children.length)continue;
    const render=parent.render;
    parent.render=ctx=>{const content=render(ctx);const base=Array.isArray(content)?{columns:[content],advanced:[]}:content;
      return {...base,advanced:[...(base.advanced??[]),...children.flatMap(child=>{const content=child.render(ui,ctx);return Array.isArray(content)?content:[...content.columns.flat(),...(content.advanced??[])];})]};};
  }
  return out.sort((a, b) => a.order - b.order);
}

/** Lays content out in columns (explicit, or a flat list balanced by CSS columns); one column on narrow screens. */
function layout(content: SettingsContent): HTMLElement {
  if (Array.isArray(content)) return h("div.set-cols.auto", null, ...content);
  return h("div.set-cols", null, ...content.columns.filter((c) => c.length).map((c) => h("div.set-col", null, ...c)));
}

/** Sections whose Advanced disclosure is open (this tab only: it's where you were, not a setting). */
const ADV_OPEN = "bunnyhop:settings-advanced";
const advOpen = (): Set<string> => {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(ADV_OPEN) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

/**
 * The section's rarely used rows, behind one "Advanced" line under its groups. Closed until opened; the search opens it
 * while it shows a match inside (and puts it back as it was after).
 */
function advancedBlock(id: string, groups: HTMLElement[]): HTMLElement | null {
  if (!groups.length) return null;
  // Rows hidden until they apply (a `when` row) aren't counted.
  const n = groups.reduce((k, g) => k + g.querySelectorAll(".set-row:not([hidden])").length, 0);
  const d = h(
    "details.set-adv",
    { "data-sec": id },
    h("summary.set-adv-sum", null, h("span.set-adv-chev", { "aria-hidden": "true" }, icon("chevronRight")), h("span", null, "Advanced"), h("small", null, `${n} more`)),
    h("div.set-cols.auto", null, ...groups),
  ) as HTMLDetailsElement;
  d.open = advOpen().has(id);
  d.addEventListener("toggle", () => {
    if (d.dataset.searchOpen !== undefined) return;
    const open = advOpen();
    if (d.open) open.add(id);
    else open.delete(id);
    sessionStorage.setItem(ADV_OPEN, JSON.stringify([...open]));
  });
  return d;
}

const LAST_SECTION = "bunnyhop:settings-tab";
const FOCUSABLE = "button:not([disabled]), input:not([hidden]):not([type=hidden]), select, textarea, [tabindex]:not([tabindex='-1'])";
/** Sections whose rows print current binds (re-rendered when Keys changes). */
const BIND_READERS = ["viewmodel", "audio", "hud"];
const SUGGESTIONS = ["sens", "fov", "crosshair", "keys overlay", "keybinds", "volume"];

export interface SettingsPanelOpts {
  /** "How to bhop" (Keys section). */
  openControls?: () => void;
}

interface SecDom {
  s: Section;
  el: HTMLElement;
  body: HTMLElement;
  head: HTMLElement;
  rail: HTMLButtonElement;
  reset: HTMLButtonElement | null;
}

export function settingsPanel(o: SettingsPanelOpts = {}): HTMLElement {
  let all = sections();
  let query = "";
  let index: IndexedEntry<HTMLElement>[] | null = null;
  /** "Did you mean" for a query with no matches (Enter takes it). */
  let suggestion: string | null = null;
  const dom = new Map<string, SecDom>();
  let current = sessionStorage.getItem(LAST_SECTION) ?? "";
  if (current === "controls") current = "keys";

  // ---- chrome
  const search = h("input.set-q", { type: "search", placeholder: "Search settings: sens, fov, keys overlay, crosshair…", "aria-label": "Search settings", spellcheck: "false", autocomplete: "off", "aria-controls": "set-scroll" });
  const clearBtn = h("button.set-q-clear", { type: "button", "aria-label": "Clear search", hidden: true }, icon("close"));
  const count = h("span.set-q-count", { "aria-hidden": "true" });
  const status = h("span.sr-only", { role: "status", "aria-live": "polite" });
  const searchBox = h("label.set-search", null, h("span.set-q-icon", { "aria-hidden": "true" }, icon("search")), search, count, clearBtn, h("kbd.set-q-kbd", { "aria-hidden": "true" }, "/"), status);
  const actBtn = (ic: string, label: string, cls: string, onclick: () => void, title: string) => h(`button.btn.btn-sm.btn-ghost.set-act${cls}`, { type: "button", title, onclick }, icon(ic), h("span", null, label));
  const rerenderAll = () => paintAll(false);
  const exportBtn = actBtn("export", "Export", "", () => openSettingsTransfer("export", { onApplied: rerenderAll }), "Copy your settings as a code or save them as a file");
  const importBtn = actBtn("import", "Import", "", () => openSettingsTransfer("import", { onApplied: rerenderAll }), "Paste a settings code or load a settings file");
  const resetAllBtn = actBtn("reset", "Reset all", ".set-reset-all", () => void resetAll(), "Put every setting back to its default");
  const rail = h("nav.set-rail", { "aria-label": "Settings sections" });
  const list = h("div.set-sections");
  const empty = h("div.set-empty", { hidden: true });
  const scroller = h("div.set-scroll", { id: "set-scroll", tabindex: "-1" }, list, empty);
  // Every write is saved at once: a tick flashes at the foot of the rail (no standing "Saved automatically" line).
  const saved = h("span.set-saved", { role: "img", "aria-label": "Saved" }, icon("check"));
  // The hovered (else focused) row's description, in one quiet line under the page (no ⓘ on every row).
  const help = h("p.set-help", { "aria-hidden": "true" });
  const root = h(
    "div.settings",
    null,
    h("div.set-top", null, searchBox, h("div.set-actions", null, profileMenu({ onApplied: rerenderAll }), exportBtn, importBtn, resetAllBtn, nativeClient()?.openSettings ? actBtn("settings", "Desktop", "", openClientSettings, "Open desktop client settings") : null)),
    h("aside.set-side", null, rail, saved),
    scroller,
    help,
  );

  // ---- a sky file (.hdr, PNG/JPEG/WebP, .bhsky.json) dropped on the page while Graphics is open: imported like Import file there
  let dropOff = 0;
  const graphicsOpen = (e: DragEvent) => current === "graphics" || !!(e.target as Element | null)?.closest?.('[data-sec="graphics"]');
  const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
  root.addEventListener("dragover", (e) => {
    if (!carriesFiles(e) || !graphicsOpen(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
    root.classList.add("sky-drop");
    // dragover repeats while a file is held over the page; it stops when the file leaves or is dropped.
    clearTimeout(dropOff);
    dropOff = window.setTimeout(() => root.classList.remove("sky-drop"), 200);
  });
  root.addEventListener("drop", (e) => {
    if (!carriesFiles(e) || !graphicsOpen(e)) return;
    e.preventDefault();
    root.classList.remove("sky-drop");
    const files = [...(e.dataTransfer?.files ?? [])];
    importSkyFile(files.find((f) => skyFileKind(f.name)) ?? files[0]!);
  });

  // ---- sections
  function buildSections(): void {
    capturing?.();
    dom.clear();
    rail.replaceChildren();
    list.replaceChildren();
    for (const s of all) {
      const id = `set-sec-${s.id}`;
      const resetBtn = s.reset ? h("button.btn.btn-sm.btn-ghost.set-sec-reset", { type: "button", "aria-label": `Reset ${s.label} to defaults` }, icon("reset"), h("span", null, "Reset")) : null;
      const head = h(
        "header.set-sec-head",
        null,
        h("div.set-sec-title", null, h("h3", { id: `${id}-h` }, s.label), s.blurb ? h("p", null, s.blurb) : null),
        resetBtn,
      );
      const body = h("div.set-sec-body");
      const el = h("section.set-sec", { id, "data-sec": s.id, "aria-labelledby": `${id}-h` }, head, body);
      const item = h("button.set-rail-item", { type: "button", "data-sec": s.id, "aria-controls": id }, h("span.set-rail-icon", { "aria-hidden": "true" }, sectionIcon(s.id, s.icon)), h("span.set-rail-label", null, s.label)) as HTMLButtonElement;
      item.addEventListener("click", () => jump(s.id));
      item.addEventListener("focus", () => item.matches(":focus-visible") && s.id !== current && jump(s.id));
      rail.append(item);
      list.append(el);
      const d: SecDom = { s, el, body, head, rail: item, reset: resetBtn };
      dom.set(s.id, d);
      if (resetBtn) armReset(resetBtn, s);
      paintSection(d, false);
    }
    if (!dom.has(current)) current = all[0]?.id ?? "";
    mark(current);
  }

  function ctxFor(d: SecDom): Ctx {
    return {
      refresh: () => {
        paintSection(d, true);
        if (d.s.id === "keys") for (const id of BIND_READERS) dom.get(id) && paintSection(dom.get(id)!, false);
      },
      openControls: o.openControls,
    };
  }

  /** Renders one section's body. keepFocus: re-rendered in place (the focused control keeps focus). */
  function paintSection(d: SecDom, keepFocus: boolean): void {
    capturing?.();
    const focusIdx = keepFocus ? [...d.body.querySelectorAll<HTMLElement>(FOCUSABLE)].indexOf(document.activeElement as HTMLElement) : -1;
    let content: SettingsContent;
    try {
      content = d.s.render(ctxFor(d));
    } catch (e) {
      console.error(`settings: section ${d.s.id} failed`, e);
      content = [h("p.dim", null, "This section couldn't be shown.")];
    }
    d.body.replaceChildren(layout(content), ...(Array.isArray(content) ? [] : [advancedBlock(d.s.id, content.advanced ?? [])].filter((x): x is HTMLElement => !!x)));
    index = null;
    if (query) applySearch(false);
    if (focusIdx >= 0) d.body.querySelectorAll<HTMLElement>(FOCUSABLE)[focusIdx]?.focus({ preventScroll: true });
    queueTail();
  }

  function paintAll(keepScroll = true): void {
    const top = scroller.scrollTop;
    for (const d of dom.values()) paintSection(d, false);
    if (keepScroll) scroller.scrollTop = top;
  }

  // ---- reset
  function armReset(btn: HTMLButtonElement, s: Section): void {
    let armed = 0;
    const label = btn.querySelector("span")!;
    const disarm = () => {
      clearTimeout(armed);
      armed = 0;
      btn.classList.remove("armed");
      label.textContent = "Reset";
      btn.setAttribute("aria-label", `Reset ${s.label} to defaults`);
    };
    btn.addEventListener("blur", () => armed && setTimeout(() => document.activeElement !== btn && disarm(), 0));
    btn.addEventListener("click", () => {
      if (!armed) {
        armed = window.setTimeout(disarm, 3500);
        btn.classList.add("armed");
        label.textContent = `Reset ${s.label}?`;
        btn.setAttribute("aria-label", `Click again to reset ${s.label} to defaults`);
        return;
      }
      disarm();
      s.reset?.();
      // Other sections can show what a reset changed (Graphics → models → Ghost model): re-render them all.
      paintAll();
      label.textContent = "Done";
      btn.classList.add("done");
      setTimeout(() => (btn.isConnected && !armed ? ((label.textContent = "Reset"), btn.classList.remove("done")) : undefined), 1400);
    });
  }

  async function resetAll(): Promise<void> {
    const ok = await confirmDialog({
      title: "Reset all settings?",
      body: "Every setting goes back to its default: sensitivity, FOV, crosshair, HUD layout, key binds, ghosts, graphics, viewmodel and sound. Your account, runs, profiles and bunny colourway aren't touched. Tip: Export first to keep a copy.",
      confirm: "Reset everything",
      danger: true,
    });
    if (!ok || !root.isConnected) return;
    prefs.reset();
    paintAll();
    flash(resetAllBtn.querySelector("span")!, "Done");
    resetAllBtn.focus({ preventScroll: true });
  }

  // ---- rail: which section you're in, jumping
  function mark(id: string): void {
    current = id;
    sessionStorage.setItem(LAST_SECTION, id);
    for (const [sid, d] of dom) {
      const on = sid === id;
      d.rail.classList.toggle("on", on);
      if (on) d.rail.setAttribute("aria-current", "true");
      else d.rail.removeAttribute("aria-current");
      d.rail.tabIndex = on ? 0 : -1;
      if (on) d.rail.dataset.autofocus = "";
      else delete d.rail.dataset.autofocus;
    }
  }

  let jumpedAt = -Infinity;
  /** Cuts to a section (see the header: instant, with an arrival fade on its header). */
  function jump(id: string): void {
    const d = dom.get(id);
    if (!d) return;
    jumpedAt = performance.now();
    mark(id);
    if (!scroller.isConnected) return;
    // Clear of the scroller's top fade (settings.css: 0.6rem).
    const fade = 0.6 * parseFloat(getComputedStyle(document.documentElement).fontSize);
    scroller.scrollTop += d.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - fade;
    if (!reducedMotion()) {
      d.head.classList.remove("arrive");
      void d.head.offsetWidth;
      d.head.classList.add("arrive");
    }
  }

  const visibleSecs = () => [...dom.values()].filter((d) => !d.el.classList.contains("s-miss"));
  function spy(): void {
    if (performance.now() - jumpedAt < 250 || !scroller.clientHeight) return;
    const secs = visibleSecs();
    if (!secs.length) return;
    // The end of the scroll is the last section, by fiat (its top may never reach the band on a tall screen).
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max > 4 && scroller.scrollTop >= max - 4) return mark(secs[secs.length - 1].s.id);
    const band = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.3;
    let at = secs[0];
    for (const d of secs) if (d.el.getBoundingClientRect().top <= band) at = d;
    if (at.s.id !== current) mark(at.s.id);
  }
  let spyQueued = false;
  scroller.addEventListener(
    "scroll",
    () => {
      if (spyQueued) return;
      spyQueued = true;
      requestAnimationFrame(() => ((spyQueued = false), spy()));
    },
    { passive: true },
  );

  /** Lets the last visible section scroll to the top (measured: zero whenever the content already reaches). */
  let tailQueued = false;
  function queueTail(): void {
    if (tailQueued) return;
    tailQueued = true;
    requestAnimationFrame(() => ((tailQueued = false), fitTail()));
  }
  function fitTail(): void {
    const secs = visibleSecs();
    const last = secs[secs.length - 1]?.el;
    list.style.setProperty("--set-tail", "0px");
    if (!last || !scroller.clientHeight) return;
    const below = list.getBoundingClientRect().bottom - last.getBoundingClientRect().top;
    if (below <= 0) return;
    list.style.setProperty("--set-tail", `${Math.max(0, Math.round(scroller.clientHeight - below))}px`);
  }

  // First layout (the panel is built before it's attached): land on the remembered section.
  let placed = false;
  const ro = new ResizeObserver(() => {
    // (Built before it's attached: the first callback can come while it's still detached. Only a panel that was on
    // the page and left it is done.)
    if (!root.isConnected) return placed ? ro.disconnect() : undefined;
    if (!scroller.clientHeight) return;
    fitTail();
    if (!placed) {
      placed = true;
      if (current && current !== all[0]?.id && !query) jump(current);
    }
  });
  ro.observe(scroller);

  // ---- search
  function buildIndex(): IndexedEntry<HTMLElement>[] {
    const out: IndexedEntry<HTMLElement>[] = [];
    for (const d of dom.values()) {
      for (const r of d.body.querySelectorAll<HTMLElement>(".set-row")) {
        // Shortcut switches (HUD → Show on screen) for a setting whose own row is in another section: the search finds
        // that row, once, where it lives.
        if (r.dataset.mirror !== undefined) continue;
        const name = r.querySelector<HTMLElement>(".set-name");
        if (name && name.dataset.orig === undefined) name.dataset.orig = name.textContent ?? "";
        out.push(
          indexEntry({
            label: r.dataset.label ?? "",
            hint: r.querySelector(".set-hint")?.textContent ?? "",
            tip: rowDesc(r),
            group: d.s.label,
            sub: r.closest<HTMLElement>(".set-group")?.dataset.group ?? "",
            aliases: r.dataset.keywords ?? "",
            node: r,
          }),
        );
      }
    }
    return out;
  }

  function markName(r: HTMLElement, q: string): void {
    const name = r.querySelector<HTMLElement>(".set-name");
    const text = name?.dataset.orig;
    if (!name || text === undefined) return;
    const ranges = q ? matchRanges(text, q) : [];
    if (!ranges.length) {
      if (name.firstElementChild || name.textContent !== text) name.textContent = text;
      return;
    }
    name.textContent = "";
    let at = 0;
    for (const [a, b] of ranges) {
      if (a > at) name.append(text.slice(at, a));
      name.append(h("mark", null, text.slice(a, b)));
      at = b;
    }
    if (at < text.length) name.append(text.slice(at));
  }

  /** Filters every row in place. toTop: scroll the results to the top (a new query). */
  function applySearch(toTop: boolean): void {
    const active = tokenize(query).length > 0;
    if (!index) index = buildIndex();
    const results = active ? searchSettings(index, query).filter((r) => !r.entry.node!.hidden) : [];
    const hit = new Set(results.map((r) => r.entry.node!));
    const best = results[0]?.entry.node ?? null;
    root.classList.toggle("is-searching", active);
    for (const d of dom.values()) {
      let any = false;
      for (const g of d.body.querySelectorAll<HTMLElement>(".set-group")) {
        let gAny = false;
        for (const r of g.querySelectorAll<HTMLElement>(".set-row")) {
          const show = !active || hit.has(r);
          r.classList.toggle("s-miss", !show);
          r.classList.toggle("is-top", active && r === best);
          markName(r, active ? query : "");
          if (show && !r.hidden) gAny = true;
        }
        // Furniture (previews, readouts) goes with the query; wrappers of rows go when all their rows did.
        for (const c of g.querySelectorAll<HTMLElement>(".set-group-rows > :not(.set-row)")) {
          const rows = [...c.querySelectorAll<HTMLElement>(".set-row")];
          c.classList.toggle("s-miss", active && (!rows.length || rows.every((r) => r.classList.contains("s-miss") || r.hidden)));
        }
        g.classList.toggle("s-miss", active && !gAny);
        any ||= gAny;
      }
      for (const c of d.body.querySelectorAll<HTMLElement>(".set-col > :not(.set-group), .set-cols > :not(.set-col):not(.set-group)")) c.classList.toggle("s-miss", active);
      // Advanced: opened while it holds a match, back as it was when the search is cleared.
      for (const adv of d.body.querySelectorAll<HTMLDetailsElement>("details.set-adv")) {
        const hasHit = active && !!adv.querySelector(".set-group:not(.s-miss)");
        adv.classList.toggle("s-miss", active && !hasHit);
        if (hasHit && adv.dataset.searchOpen === undefined) {
          adv.dataset.searchOpen = String(adv.open);
          adv.open = true;
        } else if (!active && adv.dataset.searchOpen !== undefined) {
          adv.open = adv.dataset.searchOpen === "true";
          setTimeout(() => delete adv.dataset.searchOpen, 0);
        }
      }
      d.el.classList.toggle("s-miss", active && !any);
      d.rail.classList.toggle("s-miss", active && !any);
    }
    const n = results.length;
    count.textContent = active ? (n ? `${n} ${n === 1 ? "match" : "matches"}` : "") : "";
    status.textContent = active ? (n ? `${n} ${n === 1 ? "setting matches" : "settings match"}. Enter goes to the first.` : `No settings match ${query.trim()}. Try sens, fov, keys overlay or volume.`) : "";
    clearBtn.hidden = !search.value;
    empty.hidden = !active || n > 0;
    list.hidden = active && !n;
    suggestion = active && !n ? didYouMean(index, query) : null;
    if (active && !n) {
      empty.replaceChildren(
        h("span.set-empty-icon", { "aria-hidden": "true" }, icon("search")),
        h("strong", null, `No settings match “${query.trim()}”`),
        ...(suggestion ? [h("span", null, "Did you mean ", h("button.link-btn.set-dym", { type: "button", onclick: () => setQuery(suggestion!, true) }, suggestion), "? Enter searches it.")] : []),
        h("span.dim", null, suggestion ? "Or try one of these:" : "Try one of these:"),
        h("div.set-empty-chips", null, ...SUGGESTIONS.map((w) => h("button.chip-btn", { type: "button", onclick: () => setQuery(w, true) }, w))),
      );
    }
    if (toTop) scroller.scrollTop = 0;
    queueTail();
    if (active && best) {
      const sec = best.closest<HTMLElement>(".set-sec")?.dataset.sec;
      if (sec) mark(sec);
    } else if (!active) requestAnimationFrame(spy);
  }

  function setQuery(q: string, focus = false): void {
    search.value = q;
    query = q.trim();
    applySearch(true);
    if (focus) search.focus();
  }

  search.addEventListener("input", () => {
    query = search.value.trim();
    applySearch(true);
  });
  clearBtn.addEventListener("click", (e) => {
    e.preventDefault();
    setQuery("", true);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      // Esc clears the search before it means anything else (Back).
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    } else if (e.key === "Enter" && suggestion) {
      e.preventDefault();
      setQuery(suggestion);
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      const best = query ? list.querySelector<HTMLElement>(".set-row.is-top") ?? list.querySelector<HTMLElement>(".set-row:not(.s-miss):not([hidden])") : null;
      const target = best ? best.querySelector<HTMLElement>(`${FOCUSABLE}:not([tabindex="-1"])`) ?? best.querySelector<HTMLElement>(FOCUSABLE) : rail.querySelector<HTMLElement>(".set-rail-item.on");
      if (!target) return;
      e.preventDefault();
      target.focus();
      if (best) best.scrollIntoView({ block: e.key === "Enter" ? "center" : "nearest" });
      if (e.key === "Enter" && target instanceof HTMLInputElement && target.type === "number") target.select();
    }
  });

  // The same pref can have a switch in two places (HUD → Show on screen and its own section), and a switch can change
  // what another row reads (a HUD element vs the layout presets): after any change, every switch and segmented row
  // re-reads its value. (Cheap: a hundred-odd rows, on a click.)
  root.addEventListener("change", (e) => {
    if (e.target === search) return;
    syncSwitches(list);
    for (const r of list.querySelectorAll<HTMLElement>(".set-row")) (r as HTMLElement & { repaint?: () => void }).repaint?.();
  });

  // ---- keyboard
  arrowNav(rail, "button");
  rail.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight") return;
    const d = dom.get(current);
    const first = d?.body.querySelector<HTMLElement>(`.set-row:not(.s-miss):not([hidden]) :is(${FOCUSABLE})`);
    if (first) (e.preventDefault(), e.stopPropagation(), first.focus({ preventScroll: true }), first.scrollIntoView({ block: "nearest" }));
  });
  // Content: ↑ / ↓ move between rows (sliders, selects and number boxes adjust with ← / → instead).
  scroller.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const t = e.target as HTMLElement;
    if (t.closest(".xh-styles, .swatches") || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    // (An Advanced line is a stop too: ↓ reaches it, Enter / Space opens it, ↓ goes on into what it opened.)
    const rows = [...list.querySelectorAll<HTMLElement>(".set-row, .set-aside .link-btn, .set-adv-sum")].filter((r) => r.offsetParent !== null);
    const cur = t.closest<HTMLElement>(".set-row") ?? t.closest<HTMLElement>(".set-aside .link-btn, .set-adv-sum");
    const i = cur ? rows.indexOf(cur) : -1;
    if (i < 0) return;
    const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
    e.preventDefault();
    if (!next) {
      if (e.key === "ArrowUp") search.focus();
      return;
    }
    const target = next.matches(`${FOCUSABLE}, summary`) ? next : next.querySelector<HTMLElement>(`${FOCUSABLE}:not([tabindex="-1"])`) ?? next.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest" });
  });

  // Global keys while the panel is open: / or Ctrl+F search, Q / E previous / next section.
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return cleanup();
    if (capturing || e.defaultPrevented || document.querySelector("dialog[open]")) return;
    const t = e.target as HTMLElement;
    const typing = (t instanceof HTMLInputElement && ["text", "search", "number"].includes(t.type)) || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || t.isContentEditable;
    if ((e.key === "/" && !typing) || (e.key.toLowerCase() === "f" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      search.focus();
      search.select();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === "q" || k === "e") {
      const secs = visibleSecs();
      const i = secs.findIndex((d) => d.s.id === current);
      const n = secs[(i + (k === "e" ? 1 : -1) + secs.length) % secs.length];
      if (!n) return;
      e.preventDefault();
      jump(n.s.id);
      if ((document.activeElement as HTMLElement)?.closest?.(".set-rail")) n.rail.focus({ preventScroll: true });
    }
  };
  addEventListener("keydown", onKey);
  // Keep the guard through release / auxclick after capture has assigned the bind and re-rendered its row.
  const stopMouseGuard = guardSideMouseButtons(window, () => root.isConnected);

  // Re-render when the HUD layout editor closes (toggles follow the layout) or sections are (un)registered.
  const onEditorClosed = () => (root.isConnected ? dom.get("hud") && paintSection(dom.get("hud")!, true) : cleanup());
  addEventListener(EDITOR_CLOSED, onEditorClosed);
  const unsubSections = onSettingsSections(() => {
    if (!root.isConnected) return cleanup();
    all = sections();
    const top = scroller.scrollTop;
    buildSections();
    scroller.scrollTop = top;
    if (query) applySearch(false);
  });
  function cleanup(): void {
    stopMouseGuard();
    removeEventListener("keydown", onKey);
    removeEventListener(EDITOR_CLOSED, onEditorClosed);
    unsubSections();
    unwatch();
    ro.disconnect();
  }

  // ---- the help line: the row under the pointer, else the focused one. Rows that preview in the world say so in game.
  let hovered: HTMLElement | null = null;
  const describe = (r: HTMLElement | null) => {
    let text = r ? rowDesc(r) : "";
    if (r?.classList.contains("can-peek") && document.body.classList.contains("in-game")) text = `${text}${text ? " " : ""}Hold it to see the game.`;
    if (help.textContent === text) return;
    help.textContent = text;
    if (text && !reducedMotion()) help.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 100, easing: "linear" });
  };
  const focusedRow = () => (document.activeElement instanceof HTMLElement && scroller.contains(document.activeElement) ? document.activeElement.closest<HTMLElement>(".set-row") : null);
  scroller.addEventListener("pointerover", (e) => {
    const r = (e.target as Element).closest<HTMLElement>(".set-row");
    if (r === hovered) return;
    hovered = r;
    describe(r ?? focusedRow());
  });
  scroller.addEventListener("pointerleave", () => ((hovered = null), describe(focusedRow())));
  scroller.addEventListener("focusin", (e) => !hovered && describe((e.target as Element).closest<HTMLElement>(".set-row")));
  scroller.addEventListener("focusout", () => requestAnimationFrame(() => !hovered && describe(focusedRow())));

  // ---- saved tick
  let first = true;
  let savedTimer = 0;
  let attached = false;
  const unwatch = prefs.watch(() => {
    if (first) return void (first = false);
    if (!root.isConnected) return void (attached && unwatch());
    attached = true;
    saved.classList.remove("on");
    void saved.offsetWidth;
    saved.classList.add("on");
    clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => saved.classList.remove("on"), 600);
  });

  buildSections();
  return root;
}

/** Cancels an in-progress key capture (when the panel closes). */
export function cancelBindCapture(): void {
  capturing?.();
}
