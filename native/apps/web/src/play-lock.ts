// Getting into (and staying in) the game: pointer lock, "Fullscreen when playing" (Fullscreen API + Keyboard Lock),
// Esc pause / resume, and the leave-page guard against Ctrl+W.
//
// Resume (Play / Resume / Esc on the pause menu / clicking the menu backdrop or the "Click to resume" veil):
//  - With user activation (a click): fullscreen on <html> (Settings → Graphics → Fullscreen when playing, default on;
//    menus, the map browser and the replay viewer are overlays, so they stay fullscreen too), then
//    navigator.keyboard.lock(LOCK_KEYS) (Chromium; only active while fullscreen), then pointer lock.
//  - Pointer lock can be refused: Esc is not user activation, so once the browser itself released the lock (native
//    Esc) a request from an Esc keydown fails, and Chrome refuses every request for ~1 s after the player leaves the
//    lock. Then the pause menu closes onto a "Click to resume" veil (a click anywhere resumes, Esc brings the menu
//    back) and, inside the cooldown, one automatic retry. Never a silent failure, never a hidden menu without a veil.
//  - A new player's first look at a map (main.ts) opens on the same veil in its quiet form, one "Click to start" line
//    over the world (showStartPrompt), instead of the pause menu.
//  - Under keyboard lock (Chromium fullscreen) Esc reaches the page. Esc while playing then releases pointer lock from
//    here: a page-initiated exit, after which the browser lets the next Esc re-lock without a click, so Esc toggles
//    pause / resume. Holding Esc leaves fullscreen (browser UI); that pauses too.
//  - Leaving fullscreen: a page navigation (map change, main menu) ends it; if the player leaves it themselves while
//    paused (hold Esc, F11, browser UI) it isn't forced back for the rest of this map. Firefox / Safari drop
//    fullscreen on every Esc (no Keyboard Lock), so there it comes back with the next resume click. If fullscreen is
//    lost while playing, the game pauses (pointer unlocked, pause menu).
//
// Ctrl+W (crouch on Ctrl + forward on W): Chromium only lets a page see / cancel it under keyboard lock in
// fullscreen; there the keydown is cancelled while playing. Everywhere (Firefox, Safari, Chromium windowed) a
// beforeunload guard turns Ctrl+W mid-run into the browser's "Leave site?" prompt. In-app navigation (menu clicks,
// room map changes via allowLeave()) skips it. Where Ctrl+W can't be caught (Firefox on Windows / Linux, or Chromium
// with fullscreen off) and crouch is on Ctrl, the pause menu shows a hint on the first few map loads offering Shift for
// crouch (if Shift is free) or fullscreen. macOS closes tabs with Cmd+W, so Ctrl there is harmless.
//
// Browser zoom while playing: crouch defaults to Ctrl and many players jump on the scroll wheel, so a crouch-hop is a
// Ctrl+wheel, which zooms the page in every browser (as do trackpad pinches, delivered as ctrlKey wheel events in
// Chromium / Firefox and as gesture events in Safari, and Ctrl / Cmd + '+' / '-' / '0'). While playing (pointer lock or
// the "Click to resume" veil) a non-passive window wheel listener cancels the zoom; the event still reaches input.ts,
// so a wheel jump bound alongside still registers. It's only attached while playing: menus keep native pinch / Ctrl
// zoom and passive (compositor) scrolling. OS-level zoom (macOS "Use scroll gesture with modifier keys to zoom")
// happens before the browser and can't be blocked from a page.

import type { Input } from "./input";
import { setPauseMenuVisible } from "./menu";
import { h } from "./ui/dom";
import { keyLabel, prefs } from "./ui/settings";

/**
 * Keys whose browser shortcuts the page should get while fullscreen (Keyboard Lock). Chromium's reserved shortcuts
 * (the page can't cancel them otherwise): Ctrl+W / Ctrl+Shift+W, Ctrl+T, Ctrl+N, Ctrl+Q, Ctrl+PageUp / PageDown.
 * Escape: Esc pauses instead of leaving fullscreen (hold Esc to leave). Not Tab / Alt / Meta (Alt+Tab, the Windows
 * key keep working); Ctrl+Tab still switches tabs (the run just pauses).
 */
const LOCK_KEYS = ["Escape", "KeyW", "KeyT", "KeyN", "KeyQ", "PageUp", "PageDown"];
/** Ctrl+<code> cancelled while playing (only reachable under keyboard lock for the reserved ones). */
const CTRL_BLOCK = new Set(["KeyW", "KeyT", "KeyN", "KeyQ", "KeyR", "PageUp", "PageDown", "F4", "F5"]);
/** Ctrl / Cmd + these zoom the page (by code, and by key for layouts where '+' / '-' sit elsewhere). */
const ZOOM_CODES = new Set(["Equal", "Minus", "Digit0", "NumpadAdd", "NumpadSubtract", "Numpad0"]);
const ZOOM_KEYS = new Set(["+", "=", "-", "_", "0"]);

/** A refused request right after the player left the lock is Chrome's cooldown: retry once it's over. */
const RELOCK_COOLDOWN_MS = 1250;
/** A fullscreen exit this soon after the lock went is the same Esc (Firefox / Safari leave both at once). */
const SAME_ESC_MS = 700;
/** Menu clicks / Enter this recent mean an in-app navigation, not an accident. */
const DELIBERATE_MS = 1500;
/** Ctrl+W hint: "1" once answered, else how many map loads showed it (it stops after HINT_SHOWS). */
const HINT_KEY = "bunnyhop:ctrlw-hint";
const HINT_SHOWS = 3;

interface KeyboardLockApi {
  lock(codes?: string[]): Promise<void>;
  unlock(): void;
}
const keyboard = (navigator as Navigator & { keyboard?: Partial<KeyboardLockApi> }).keyboard;
/** Keyboard Lock exists (Chromium: Chrome, Edge, Opera, Brave). Firefox and Safari don't have it. */
export const keyboardLockSupported = typeof keyboard?.lock === "function";
const fullscreenSupported = () => !!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === "function";
const isMac = () => /Mac|iPhone|iPad/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent);
/** True while the page has user activation (no API: assume yes and let the browser decide). */
const activated = () => (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? true;

const S = {
  input: null as Input | null,
  /** A timed attempt is in progress (set once the map's session exists). */
  attempt: null as (() => boolean) | null,
  /** Fullscreen this page asked for (vs F11 / none). */
  ownFullscreen: false,
  /** The player left fullscreen on purpose while paused: don't force it back on this map. */
  userLeftFullscreen: false,
  exitingFullscreen: false,
  lockLostAt: -1e9,
  lastUiGesture: -1e9,
  leaving: false,
  veil: null as HTMLElement | null,
  retry: 0,
  hint: null as HTMLElement | null,
  /** The zoom guard (wheel / gesture listeners) is attached. */
  zoomGuard: false,
};

const locked = () => !!S.input?.locked;
const veilUp = () => !!S.veil && !S.veil.hidden;
/** A <dialog> is up (every game dialog is modal: showModal): the page under it is inert and Esc is the dialog's. */
export const modalOpen = (): boolean => !!document.querySelector("dialog[open]");

/** Installs the handlers. Call once at startup with the game's input. */
export function initPlayLock(input: Input): void {
  S.input = input;
  document.addEventListener("pointerlockchange", () => {
    if (locked()) {
      hideVeil();
      S.hint?.remove(); // pause menu only
      S.hint = null;
    } else S.lockLostAt = performance.now();
    syncZoomGuard();
  });
  document.addEventListener("fullscreenchange", onFullscreenChange);
  // Window capture: before the game's and the replay viewer's own key handlers.
  addEventListener("keydown", onKeyDown, true);
  // In-app navigations come from menu clicks / Enter; the leave guard lets those through.
  const gesture = (e: Event) => {
    if (!locked() && !(e instanceof KeyboardEvent && e.key !== "Enter" && e.key !== " ")) S.lastUiGesture = performance.now();
  };
  addEventListener("pointerdown", gesture, true);
  addEventListener("keydown", gesture, true);
  addEventListener("beforeunload", onBeforeUnload);
  let wanted = prefs.get().graphics.fullscreen;
  prefs.watch((p) => {
    if (p.graphics.fullscreen === wanted) return;
    wanted = p.graphics.fullscreen;
    // Turned off while fullscreen (only reachable from a menu): leave the fullscreen we asked for. Turned on: from the
    // next resume, even if they left fullscreen earlier on this map.
    if (!wanted && S.ownFullscreen && document.fullscreenElement) exitFullscreen();
    if (wanted) S.userLeftFullscreen = false;
  });
}

/** In a map: what counts as an attempt in progress for the leave guard (e.g. the timer is running). */
export function setPlayAttempt(fn: () => boolean): void {
  S.attempt = fn;
  maybeShowCtrlWHint();
}

/** Deliberate navigation coming (room map change, leaving a room): no "Leave site?" prompt. */
export function allowLeave(): void {
  S.leaving = true;
}

/** Back into the game from a menu (a click, Enter or Esc). */
export async function resumePlay(): Promise<void> {
  const input = S.input;
  if (!input || input.locked) return;
  clearTimeout(S.retry);
  // Fullscreen needs user activation (a click / Enter; Esc doesn't count): ask first, in the same task, then lock the
  // pointer (Chromium grants that after a fullscreen request in the same click; Firefox needs the same handler).
  if (activated()) enterFullscreen();
  const lostAt = S.lockLostAt;
  if (await input.lock()) return;
  showVeil();
  const since = performance.now() - lostAt;
  if (since < RELOCK_COOLDOWN_MS) S.retry = window.setTimeout(() => veilUp() && void input.lock(), RELOCK_COOLDOWN_MS - since);
}

// ---------------------------------------------------------------------------------------------
// Fullscreen + keyboard lock

function enterFullscreen(): void {
  if (!prefs.get().graphics.fullscreen || S.userLeftFullscreen || !fullscreenSupported()) return;
  if (document.fullscreenElement) return void lockKeys();
  S.ownFullscreen = true;
  document.documentElement.requestFullscreen({ navigationUI: "hide" }).then(lockKeys, () => (S.ownFullscreen = false));
}

function exitFullscreen(): void {
  S.exitingFullscreen = true;
  void document.exitFullscreen().catch(() => {}).finally(() => (S.exitingFullscreen = false));
}

function lockKeys(): void {
  if (keyboardLockSupported && document.fullscreenElement) keyboard!.lock!(LOCK_KEYS).catch(() => {});
}

function onFullscreenChange(): void {
  if (document.fullscreenElement) return;
  keyboard?.unlock?.();
  const ours = S.ownFullscreen;
  S.ownFullscreen = false;
  if (S.exitingFullscreen || !ours) return;
  if (locked()) {
    // Lost while playing (browser UI, Firefox's Esc that also drops the lock): pause, pointer unlocked. Not a choice
    // to stay windowed: the next resume goes fullscreen again.
    document.exitPointerLock();
  } else if (performance.now() - S.lockLostAt > SAME_ESC_MS) {
    // Left while paused (hold Esc under keyboard lock, F11, the browser's exit button): their call for this map.
    S.userLeftFullscreen = true;
  }
}

// ---------------------------------------------------------------------------------------------
// Keys while playing

function onKeyDown(e: KeyboardEvent): void {
  if (!locked() && !veilUp()) {
    // Just paused: the Ctrl+W of a crouch-forward can land a moment after the lock went.
    if (!(e.ctrlKey && CTRL_BLOCK.has(e.code) && performance.now() - S.lockLostAt < 1000 && S.attempt)) return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (ZOOM_CODES.has(e.code) || ZOOM_KEYS.has(e.key))) {
    e.preventDefault(); // Ctrl / Cmd + '+' / '-' / '0': no browser zoom mid-run (input.ts still sees the key)
    return;
  }
  if (e.ctrlKey && !e.metaKey && CTRL_BLOCK.has(e.code)) {
    e.preventDefault(); // Ctrl+W / T / N / Q / R / PageUp / PageDown / F4 / F5 while crouching: never a browser shortcut
    return;
  }
  if (e.code === "F5" || (e.altKey && (e.code === "ArrowLeft" || e.code === "ArrowRight"))) {
    e.preventDefault(); // reload / back / forward
    return;
  }
  if (e.code !== "Escape") return;
  // A modal dialog over the game (Last jump, Paint options, ...) takes its own Esc: it closes, nothing behind it opens.
  if (modalOpen()) return;
  if (veilUp()) {
    // Veil: Esc goes back to the pause menu.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) backToMenu();
    return;
  }
  // Locked and the page got the Esc (keyboard lock; some browsers deliver it anyway): pause from here. Holding Esc
  // (to leave fullscreen) repeats; only the first press counts. The chat input stops its own Esc before this.
  if (S.input?.locked && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) document.exitPointerLock();
  }
}

// ---------------------------------------------------------------------------------------------
// Zoom guard (see the header): only attached while playing

const playing = () => locked() || veilUp();

/** Ctrl / Cmd + wheel (and Chromium / Firefox trackpad pinches, which arrive as ctrlKey wheels): no page zoom. */
function onZoomWheel(e: WheelEvent): void {
  if ((e.ctrlKey || e.metaKey) && playing()) e.preventDefault();
}

/** Safari trackpad pinch (GestureEvent, WebKit only). */
function onGesture(e: Event): void {
  if (playing()) e.preventDefault();
}

function syncZoomGuard(): void {
  const on = playing();
  if (on === S.zoomGuard) return;
  S.zoomGuard = on;
  // Non-passive (window-level wheel listeners default to passive in Chromium, which would ignore preventDefault).
  const opts: AddEventListenerOptions = { capture: true, passive: false };
  for (const [type, fn] of [["wheel", onZoomWheel], ["gesturestart", onGesture], ["gesturechange", onGesture]] as const) {
    if (on) addEventListener(type, fn as EventListener, opts);
    else removeEventListener(type, fn as EventListener, opts);
  }
}

// ---------------------------------------------------------------------------------------------
// "Click to resume" veil

/**
 * A new player's first look at a map (main.ts): the world with one line, "Click to start", instead of the pause menu.
 * It's the veil in its quiet form: a click anywhere starts (pointer lock), Esc opens the pause menu.
 */
export function showStartPrompt(): void {
  showVeil("start");
}

function showVeil(kind: "resume" | "start" = "resume"): void {
  if (locked()) return;
  if (!S.veil) {
    const v = h("div#resume-veil", { role: "button", tabindex: "-1" });
    v.hidden = true;
    v.addEventListener("click", (e) => {
      e.preventDefault();
      void resumePlay();
    });
    v.addEventListener("contextmenu", (e) => e.preventDefault());
    document.body.append(v);
    S.veil = v;
  }
  const label = kind === "start" ? "Click to start" : "Click to resume";
  if (S.veil.getAttribute("aria-label") !== label) {
    S.veil.setAttribute("aria-label", label);
    S.veil.classList.toggle("start", kind === "start");
    S.veil.replaceChildren(kind === "start" ? h("p.rv-line", null, label) : h("div.rv-card", null, h("b", null, label), h("small", null, h("kbd", null, "Esc"), " menu")));
  }
  setPauseMenuVisible(false);
  S.veil.hidden = false;
  S.veil.focus({ preventScroll: true });
  syncZoomGuard();
}

function hideVeil(): void {
  clearTimeout(S.retry);
  if (S.veil) S.veil.hidden = true;
  syncZoomGuard();
}

function backToMenu(): void {
  hideVeil();
  setPauseMenuVisible(true);
}

// ---------------------------------------------------------------------------------------------
// Leave guard

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (S.leaving || !S.attempt) return;
  const now = performance.now();
  const playing = locked() || veilUp() || now - S.lockLostAt < 3000;
  if (!playing && !S.attempt()) return;
  // Menu click / Enter just before: an in-app navigation (main menu, change map, open a replay elsewhere).
  if (!locked() && now - S.lastUiGesture < DELIBERATE_MS) return;
  e.preventDefault();
  e.returnValue = ""; // older Chromium / Safari
}

// ---------------------------------------------------------------------------------------------
// One-time hint where Ctrl+W can't be blocked

/** Ctrl+W can close the tab mid-run here: no keyboard lock (Firefox, Safari) or fullscreen off, not macOS. */
export function ctrlWUnblockable(): boolean {
  return !isMac() && !(keyboardLockSupported && fullscreenSupported() && prefs.get().graphics.fullscreen);
}

function maybeShowCtrlWHint(): void {
  const p = prefs.get();
  const ctrl = p.binds.duck.filter((c) => c === "ControlLeft" || c === "ControlRight");
  const seen = localStorage.getItem(HINT_KEY);
  if (!ctrl.length || !ctrlWUnblockable() || seen === "1" || Number(seen) >= HINT_SHOWS) return;
  const store = (v: string) => {
    try {
      localStorage.setItem(HINT_KEY, v);
    } catch {
      /* private mode: shows again next time */
    }
  };
  store(String(Number(seen ?? 0) + 1));
  const shiftFree = !Object.values(p.binds).some((codes) => codes.includes("ShiftLeft"));
  const done = () => {
    store("1");
    S.hint?.remove();
    S.hint = null;
  };
  const chromium = keyboardLockSupported && fullscreenSupported();
  const fix = chromium
    ? h("button.btn.btn-sm.primary", { type: "button", onclick: () => (prefs.update((q) => (q.graphics.fullscreen = true)), done()) }, "Turn on fullscreen")
    : shiftFree
      ? h("button.btn.btn-sm.primary", {
          type: "button",
          onclick: () => {
            prefs.update((q) => (q.binds.duck = [...q.binds.duck.filter((c) => c !== "ControlLeft" && c !== "ControlRight"), "ShiftLeft"]));
            done();
          },
        }, "Crouch on Shift")
      : null;
  S.hint = h(
    "aside#ctrlw-hint",
    { role: "note" },
    h(
      "p",
      null,
      h("b", null, "Ctrl+W closes the tab"),
      chromium
        ? " when the game isn't fullscreen. Crouching on Ctrl while holding W could close it mid-run (you'd get a \"Leave site?\" prompt first). Fullscreen when playing lets the game catch it."
        : ` in this browser, and the game can't block it. Crouching on ${keyLabel(ctrl[0])} while holding W could close it mid-run (you'd get a "Leave site?" prompt first). Chrome and Edge in fullscreen don't have this problem.`,
    ),
    h("div.cw-actions", null, fix, h("button.btn.btn-sm", { type: "button", onclick: done }, fix ? (chromium ? "Not now" : "Keep Ctrl") : "Got it")),
  );
  document.body.append(S.hint);
}
