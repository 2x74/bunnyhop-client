// UI sounds for every menu without touching the screens: delegated hover / press / click / toggle / Esc listeners on
// the document, classified by element (back buttons, primary actions, map list rows, switches). Plus the speaker button
// (menus and replay viewer), the muted indicator on the HUD and the audio toast (mute, now playing; notify/).
//
// The kit is the game's own foley (catalog.ts, tools/audio/foley.ts): hover is a tile footstep that walks up a scale
// row by row, press is the jump "hup" on pointerdown, confirm / back land, toggles click the gun's fire-mode switch,
// errors dry-fire. Never in game (pointer lock); prefers-reduced-motion does not touch sound.

import { isTextField } from "../input";
import type { SfxId } from "./catalog";
import { toast as notifyToast } from "../notify";

const HOVER = "button, a[href], select, [role=tab], [role=radio], label.rv-check, input[type=checkbox]";
const CLICK = "button, a[href], .mb-row, [role=tab], [role=radio]";

/** Pitch ladder: +2.5% per row, capped at +18%. */
const LADDER_STEP = 0.025;
const LADDER_MAX = 0.18;
/** Toggle click pitch: up turning on, down turning off. */
const SWITCH_ON = 1.12;
const SWITCH_OFF = 0.88;

type Play = (id: SfxId, gain?: number, rate?: number) => void;
let out: Play | null = null;
const inGame = () => typeof document !== "undefined" && !!document.pointerLockElement;

/** A UI sound (silent in game). For screens that need one outside the delegated listeners. */
export function uiSound(id: SfxId, gain = 1, rate = 1): void {
  if (out && !inGame()) out(id, gain, rate);
}

/** A switch / pressed-state change: the fire-mode click, pitched up for on and down for off. */
export function toggleSound(on: boolean): void {
  uiSound("ui_switch", 1, on ? SWITCH_ON : SWITCH_OFF);
}

/** A screen or panel opening: a short puff of air. */
export function uiOpen(): void {
  uiSound("ui_open");
}

/** A screen or panel closing: the same puff reversed. */
export function uiClose(): void {
  uiSound("ui_close");
}

/** What a click on `el` sounds like (data-sound="..." overrides). ui_click means "just the press". */
function clickSound(el: Element): SfxId | null {
  const forced = (el as HTMLElement).dataset?.sound;
  if (forced === "none") return null;
  if (forced) return forced as SfxId;
  if (el.matches(".mb-row")) return "ui_card";
  if (el.matches(".back, [aria-label^='Back'], [aria-label^='Close']")) return "ui_back";
  if (el.matches(".primary, .rv-accent, .menu-btn.primary")) return "ui_confirm";
  if (el.matches("input[type=checkbox], label.rv-check")) return null; // "change" plays the toggle
  return "ui_click";
}

/** The new state if `el` is a toggle-like button (radio / aria-pressed), read before its own click handler runs. */
function toggleState(el: Element): boolean | null {
  if (el.matches("[role=radio]")) return el.getAttribute("aria-checked") === "true" ? null : true;
  const p = el.getAttribute("aria-pressed");
  if (p === "true" || p === "false") return p !== "true";
  return null;
}

/** Row of `el` in its list: its index among sibling hover targets (or among siblings holding one, for wrapped rows). */
function rowIndex(el: Element): number {
  let node: Element = el;
  for (let depth = 0; depth < 3 && node.parentElement; depth++) {
    const p: Element = node.parentElement;
    const rows = Array.from(p.children).filter((c) => c.matches(HOVER) || !!c.querySelector(HOVER));
    if (rows.length > 1) return Math.max(0, rows.indexOf(node));
    node = p;
  }
  return 0;
}

const ladder = (el: Element) => 1 + Math.min(LADDER_MAX, LADDER_STEP * rowIndex(el));

export function installUiSounds(play: Play): void {
  out = play;
  let lastHover: Element | null = null;
  let pressed: Element | null = null;
  document.addEventListener(
    "pointerover",
    (e) => {
      if (inGame() || (e as PointerEvent).pointerType === "touch") return;
      const el = (e.target as Element | null)?.closest?.(HOVER) ?? null;
      if (el === lastHover) return;
      lastHover = el;
      if (!el || (el as HTMLButtonElement).disabled || el.closest("[hidden], .hud")) return;
      play("ui_hover", 1, ladder(el));
    },
    true,
  );
  // Press on the way down (the hop); confirm / back / map cards land on the click.
  document.addEventListener(
    "pointerdown",
    (e) => {
      pressed = null;
      if (inGame() || !e.isTrusted || e.button !== 0 || !e.isPrimary) return;
      const el = (e.target as Element | null)?.closest?.(CLICK);
      if (!el || (el as HTMLButtonElement).disabled || !clickSound(el)) return;
      pressed = el;
      play("ui_press");
    },
    true,
  );
  document.addEventListener(
    "click",
    (e) => {
      if (inGame() || !e.isTrusted) return;
      const el = (e.target as Element | null)?.closest?.(CLICK);
      const wasPressed = !!el && pressed === el;
      pressed = null;
      if (!el || (el as HTMLButtonElement).disabled) return;
      const s = clickSound(el);
      if (!s) return;
      const on = s === "ui_click" ? toggleState(el) : null;
      if (on !== null) play("ui_switch", 1, on ? SWITCH_ON : SWITCH_OFF);
      else if (s !== "ui_click") play(s);
      else if (!wasPressed) play("ui_press"); // keyboard activation (no pointerdown)
    },
    true,
  );
  document.addEventListener(
    "change",
    (e) => {
      const t = e.target as HTMLInputElement | HTMLSelectElement | null;
      if (!t || inGame()) return;
      if (t instanceof HTMLInputElement && t.type === "checkbox") play("ui_switch", 1, t.checked ? SWITCH_ON : SWITCH_OFF);
      else if (t instanceof HTMLSelectElement) play("ui_switch");
    },
    true,
  );
  // Keyboard navigation through menus ticks like hovering.
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target as HTMLElement | null;
      if (!el || inGame() || isTextField(el)) return;
      try {
        if (!el.matches(":focus-visible") || !el.matches(HOVER)) return;
      } catch {
        return;
      }
      if (el === lastHover) return;
      lastHover = el;
      play("ui_hover", 1, ladder(el));
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || inGame() || e.repeat) return;
    const overlay = document.getElementById("overlay");
    if ((overlay && !overlay.classList.contains("hidden")) || document.body.classList.contains("viewer-open")) play("ui_back");
  });
}

// -------------------------------------------------------------------------------------------------
// Speaker button, muted indicator, toast

const ICON_ON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 9.2a4 4 0 0 1 0 5.6M18.6 6.6a7.6 7.6 0 0 1 0 10.8"/></svg>`;
const ICON_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>`;

export interface AudioChrome {
  setMuted(muted: boolean, key: string | null): void;
  /** Audio is waiting for the browser's first click / key press (autoplay policy). */
  setLocked(locked: boolean): void;
  toast(text: string, ms?: number): void;
}

/**
 * `toggle` mutes / unmutes; `unlockedBy(btn)` is true (once) for the click whose press on the button just turned
 * sound on: that click doesn't also mute. Every later click does.
 */
export function mountAudioChrome(toggle: () => void, unlockedBy: (el: Element) => boolean = () => false): AudioChrome {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "audio-btn";
  btn.dataset.sound = "none";
  btn.addEventListener("click", () => {
    if (unlockedBy(btn) && !muted) return paint();
    toggle();
  });
  const mutedEl = document.createElement("div");
  mutedEl.id = "audio-muted";
  mutedEl.setAttribute("aria-hidden", "true");
  mutedEl.innerHTML = ICON_OFF;
  document.body.append(btn, mutedEl);
  let muted = false;
  let locked = false;
  let key: string | null = null;
  const paint = () => {
    const off = muted || locked;
    btn.innerHTML = off ? ICON_OFF : ICON_ON;
    btn.classList.toggle("off", muted);
    btn.classList.toggle("locked", locked && !muted);
    const label = locked && !muted ? "Click for sound" : `${muted ? "Unmute" : "Mute"} sound${key ? ` (${key})` : ""}`;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-pressed", String(muted));
    document.body.classList.toggle("audio-muted", muted);
  };
  return {
    setMuted(m, k) {
      muted = m;
      key = k;
      paint();
    },
    setLocked(l) {
      if (l === locked) return;
      locked = l;
      paint();
    },
    // One toast for sound / music news (mute, now playing): the newest replaces it in place.
    toast(text, ms = 2200) {
      notifyToast(text, { ms, key: "audio" });
    },
  };
}
