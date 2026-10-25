// bunnyhop.lol notifications: one system for every message the game shows on its own (research/NOTIFICATIONS.md).
//
// Four tiers. How much of the screen a message takes is how much it matters to the player right now; each tier has one
// look, one motion (the hop: in along a short arc, landing with a squash) and one sound.
//   whisper(text)        an echo of something you just did ("Flashlight on", "Copied"): no box, one short line in
//                        white. At the control that caused it (`at`), top centre in game, else bottom centre. Silent
//                        (the click already made a sound); a repeat re-stamps the word in place.
//   toast(text)          a Notice: something to read or act on (update ready, an upload retry, a friend's invite,
//                        errors). A solid slab led by a glyph (↻ update, a red ! for errors) or the friend's avatar,
//                        one text action. Bottom centre in menus (up to 3), top centre in game (one at a time).
//   moment(spec)         something earned, in the menus (community rewards, level-ups outside a run): the slab with the
//                        reward stamping out of it. No time bar, no ×: a click or a swipe dismisses it, hover holds it.
//                        In game the end card's reward reel (hud.ts) tells a run's rewards instead.
//   celebrate(spec)      the Celebration: takes the screen for the top moments (Heirloom / Golden items, a new rank
//                        group, the secret, graduating the tutorial, Supporter thanks). Dim, a band in the moment's
//                        colour, the title slams in, the reward hops in on a dotted arc, the bunny hops in beside it,
//                        confetti from both bottom corners. Any key, a click or 3.5 s ends it.
//   banner(spec)         an announcement across the top (room records): a band that hops in and shines once.
//   nudge(el) / ring(el) an inline cue on something already on screen (a badge count going up, a new dot).
//
// Moments and celebrations play one at a time and wait while a run is going (and while the UI is hidden).
// Scheduling lives in queue.ts (merge, priority, stagger, defer: unit-tested); motion in spring.ts (springs as CSS
// linear() easings on the compositor). Everything here animates transform / opacity only, measures layout only when a
// note enters or leaves, and nothing runs per frame except confetti (only outside runs) and count-ups (≤0.8 s).
// body.potato: no confetti, no squash, no arc dots, a still 3D model. Reduced motion: short fades, sounds still play.
// Screen readers: two visually hidden live regions (polite, and assertive for errors) get each note's text once.
// Sounds go through setNotifySound (audio/index.ts wires it). A Notice lands on toast_pop (ui_error, softer, for
// errors); moments and celebrations land on stamp plus their own cue; count_tick for count-ups, bunny_boing for the
// mascot's hop, shine for the item sweep. Accents tied to a motion (ticks, boing, shine) are skipped with reduced
// motion, since the motion is.

import "./notify.css";
import { h } from "../ui/dom";
import { NotifyQueue, PRIORITY, type Note, type NoteEvent } from "./queue";
import { EASE_IN, EASE_OUT, SPRINGS, spring, hopKeyframes, hopOffKeyframes, arcKeyframes, arcPoints } from "./spring";
import { countUpValue, readingMs, TickPacer } from "./timing";
import { burst, stopConfetti } from "./confetti";
import { mascot, setMascotSound, type Mood } from "./mascot";

export { PRIORITY } from "./queue";
export { mascot, MOODS, type Mood } from "./mascot";

// ---------------------------------------------------------------------------------------------
// Public types

export type Tone = "info" | "good" | "bad";
export interface Action {
  label: string;
  run: () => void;
}

export interface WhisperOpts {
  /** The control that caused it: the word rises out of it (menus). Without: top centre in game, bottom centre in menus. */
  at?: Element | null;
  /** Same key (default: same place) re-stamps the word on screen instead of replacing it. */
  key?: string;
  /** ms on screen (default 1.2–1.8 s by length). */
  ms?: number;
  /** Stays visible with the UI hidden (Hide UI's own "how to get it back" line). */
  always?: boolean;
  /** px between the control and the word (default 6). */
  gap?: number;
}

export interface ToastOpts {
  /** ms on screen (default: reading time, 2.2–8 s). */
  ms?: number;
  /** Same key: updates the toast in place (with a ×N count) instead of stacking. */
  key?: string;
  tone?: Tone;
  action?: Action;
  priority?: number;
  /** Waits while a timed run is going and shows when it ends (friends' messages and invites: never mid-run). */
  defer?: boolean;
  /** What leads the line: a friend's avatar (social/), or a glyph ("update": ↻). Errors get a red ! on their own. */
  lead?: Node | "update";
}

export interface CelebrationSpec {
  /** Small line above the title, sentence case ("Heirloom", "Achievement"). Optional; a celebration doesn't show it. */
  kicker?: string;
  title: string;
  /** One plain line under the title (an item's name, "Overall #142"). */
  detail?: string;
  /** Hover text on the card (why it unlocked: kept off the card itself). */
  hint?: string;
  /** The reward itself: an achievement token, an item swatch... (stamped in, shined if `shine`). */
  emblem?: Node;
  /**
   * A live 3D model of the reward (notify/item3d.ts), over the emblem's disc and breaking out of it. While it loads and
   * once it shows, the emblem's own icon and shine are hidden; if it can't show, they stay.
   */
  model?: { readonly el: HTMLElement; show(): void };
  /** A level-up: the emblem is the level number, counting from → to. */
  level?: [number, number];
  /** Accent of this moment (a rarity colour); default amber. */
  color?: string;
  /** The bunny: peeks over a moment's card, hops in beside a celebration's band (big moments only). */
  mood?: Mood;
  /** Light sweep over the emblem (items). */
  shine?: boolean;
  /** A ring spreads from the emblem as it lands (rare and up). */
  ring?: boolean;
  /** Confetti: true, or a count. A moment's comes from its emblem, a celebration's from both bottom corners. */
  confetti?: boolean | number;
  /** The secret's unlock (progression.ts WINGS): the emblem flutters like a wingbeat, the confetti is feathers. */
  feathers?: boolean;
  /** Sound id (audio/catalog.ts SfxId) played as the emblem lands, and its playback rate (rarity: notify ladder). */
  sound?: string;
  rate?: number;
  action?: Action;
  ms?: number;
  key?: string;
  priority?: number;
}

export interface BannerSpec {
  title: string;
  sub?: string;
  /** Colour family: wr (gold), sr (amber-orange), top10, pb, info. */
  tone?: "wr" | "sr" | "top10" | "pb" | "info";
  /** The small band (someone else's record in a room; always so while a run is going). */
  compact?: boolean;
  ms?: number;
  sound?: string;
  confetti?: boolean;
  key?: string;
  priority?: number;
}

type Data =
  | { kind: "whisper"; text: string; at: Element | null; always: boolean; gap: number }
  | { kind: "toast"; text: string; tone: Tone; action?: Action; lead?: Node | "update" }
  | { kind: "celebration"; spec: CelebrationSpec; stage: boolean }
  | { kind: "banner"; spec: BannerSpec };

// ---------------------------------------------------------------------------------------------
// State

// Rests: just longer than the exits (celebration 240 ms, banner 220 ms), so one leaves before the next lands.
const q = new NotifyQueue<Data>({ celebration: { rest: 260 }, banner: { rest: 240 } });
const rendered = new Map<number, { el: HTMLElement; cleanup?: () => void; same?: number }>();
let timer = 0;
let playSound: (id: string, gain?: number, rate?: number) => void = () => {};
/** Moments in one sequence rise a semitone each (tixy's "repeated successes climb"), reset after a pause. */
let streak = { n: 0, at: 0 };
let runFlag = false;
/** Hide UI is on (holdCelebrations): moments and celebrations wait as during a run. */
let held = false;
/** count_tick pacing, shared by every count-up (a fast count, or two at once, never machine-guns). */
const ticks = new TickPacer();

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Low-end PCs (Settings → Graphics → Potato): no squash, no arc dots, no confetti. */
const potato = () => document.body.classList.contains("potato");
const now = () => performance.now();

/** audio/index.ts: how notifications play their sounds (kept out of here so this module doesn't load the audio engine). */
export function setNotifySound(fn: (id: string, gain?: number, rate?: number) => void): void {
  playSound = fn;
}

// The bunny's hop boings (very quietly); never while a run is going.
setMascotSound((kind) => {
  if (kind === "hop" && !q.isRunning) playSound("bunny_boing");
});

// ---------------------------------------------------------------------------------------------
// Containers (created on first use; moved into an open modal dialog so they stay above its backdrop)

type Roots = { whispers: HTMLElement; toasts: HTMLElement; cels: HTMLElement; banners: HTMLElement; polite: HTMLElement; alert: HTMLElement };
let roots: Roots | null = null;
let watching = false;

function ensureRoots(): Roots {
  if (roots && roots.toasts.isConnected) return roots;
  roots = {
    whispers: h("div#nt-whispers"),
    toasts: h("div#nt-toasts"),
    cels: h("div#nt-cels"),
    banners: h("div#nt-banners"),
    polite: h("div.sr-only#nt-live", { role: "status", "aria-live": "polite", "aria-atomic": "true" }),
    alert: h("div.sr-only#nt-alert", { role: "alert", "aria-live": "assertive", "aria-atomic": "true" }),
  };
  document.body.append(roots.banners, roots.cels, roots.toasts, roots.whispers, roots.polite, roots.alert);
  if (!watching) {
    watching = true;
    // Game vs menus: the toast lane's size and the run gate follow the body classes main.ts / menu.ts set.
    new MutationObserver(() => syncContext()).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    // A dialog closing (capture: before its own handlers may remove it): notes inside it move back out, still showing.
    document.addEventListener("close", () => roots?.toasts.isConnected && placeRoots(), true);
  }
  syncContext();
  return roots;
}

/** Topmost open modal dialog, or body: the notes' containers live there while they show. */
function hostFor(): HTMLElement {
  const open = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter((d) => d.matches(":modal"));
  return open[open.length - 1] ?? document.body;
}

function placeRoots(): void {
  const r = ensureRoots();
  const host = hostFor();
  for (const el of [r.banners, r.cels, r.toasts, r.whispers, r.polite, r.alert]) if (el.parentElement !== host) host.append(el);
}

function inGame(): boolean {
  const c = document.body.classList;
  return c.contains("in-game") && !c.contains("menu-open") && !c.contains("viewer-open");
}

function syncContext(): void {
  const t = now();
  q.setCapacity("toast", inGame() ? 1 : 3, t);
  q.setRunning((runFlag && inGame()) || held, t);
  if ((runFlag && inGame()) || held) stopConfetti();
  pump();
}

/** A timed run is going in game (celebrations are held; notify/item3d.ts builds models later then). */
export const runGoing = (): boolean => q.isRunning;

/**
 * The HUD reports whether a timed run is going (on change only). While it is (and no menu is open), moments and
 * celebrations wait and a visible one steps aside, so nothing big covers the screen mid-run.
 */
export function setRunActive(running: boolean): void {
  if (running === runFlag) return;
  runFlag = running;
  if (roots) syncContext();
}

/** Hide UI (ui/hide-ui.ts): moments and celebrations wait, like during a run, and show once the UI is back. */
export function holdCelebrations(on: boolean): void {
  if (on === held) return;
  held = on;
  if (roots) syncContext();
}

// ---------------------------------------------------------------------------------------------
// Public API

/** Whisper: an echo of something the player just did (see the top of this file). */
export function whisper(text: string, o: WhisperOpts = {}): void {
  ensureRoots();
  const t = now();
  const at = o.at && (o.at as HTMLElement).isConnected ? o.at : null;
  const shown = q.shown("whisper")[0];
  const sd = shown?.data.kind === "whisper" ? shown.data : null;
  // Same place (or key): the word on screen re-stamps; anywhere else: the one up gives way at once.
  const key = o.key ?? (sd && sd.at === at ? shown!.key! : `w${t}`);
  if (shown && shown.key !== key) q.dismiss(shown.id, t);
  const ms = o.ms ?? Math.min(1800, 1200 + text.length * 25);
  q.push({ lane: "whisper", key, ms, priority: PRIORITY.info, data: { kind: "whisper", text, at, always: !!o.always, gap: o.gap ?? 6 } }, t);
  pump();
}

/** Notice: something to read or act on (see the top of this file). */
export function toast(text: string, o: ToastOpts = {}): void {
  ensureRoots();
  const t = now();
  // In game a newer toast replaces the one up (one lane, top centre, never a backlog during a run).
  if (inGame()) for (const n of q.shown("toast")) if (!o.key || n.key !== o.key) q.dismiss(n.id, t);
  q.push({ lane: "toast", key: o.key, ms: o.ms ?? readingMs(text), defer: o.defer, priority: o.priority ?? (o.tone === "bad" ? PRIORITY.error : PRIORITY.info), data: { kind: "toast", text, tone: o.tone ?? "info", action: o.action, lead: o.lead } }, t);
  pump();
}

/** Takes down the notes with this key, shown or waiting (a sticky Notice whose reason is over). */
export function dismissKey(key: string): void {
  if (!roots) return;
  const t = now();
  for (const lane of ["whisper", "toast", "celebration", "banner"] as const) for (const n of [...q.shown(lane), ...q.waiting(lane)]) if (n.key === key) q.dismiss(n.id, t);
  pump();
}

/** Moment: something earned, told in the menus (see the top of this file). */
export function moment(spec: CelebrationSpec): void {
  ensureRoots();
  q.push({ lane: "celebration", key: spec.key, ms: spec.ms ?? 4000, defer: true, priority: spec.priority ?? PRIORITY.achievement, data: { kind: "celebration", spec, stage: false } }, now());
  pump();
}

/** Celebration: the screen for a top moment (see the top of this file). 3.5 s, or until any key or a click. */
export function celebrate(spec: CelebrationSpec): void {
  ensureRoots();
  q.push({ lane: "celebration", key: spec.key, ms: STAGE_MS, defer: true, priority: spec.priority ?? PRIORITY.record, data: { kind: "celebration", spec, stage: true } }, now());
  pump();
}
const STAGE_MS = 3500;

/** A moment or celebration is on screen (the tutorial's prompt line steps aside for it: tutorial/mode.ts). */
export function celebrating(): boolean {
  return !!roots && q.shown("celebration").length > 0;
}

export function banner(spec: BannerSpec): void {
  ensureRoots();
  q.push({ lane: "banner", key: spec.key, ms: spec.ms ?? 5000, priority: spec.priority ?? (spec.tone === "wr" ? PRIORITY.record : PRIORITY.info), data: { kind: "banner", spec } }, now());
  pump();
}

// ---------------------------------------------------------------------------------------------
// The pump: run the queue, render its events, sleep until the next one

function pump(): void {
  clearTimeout(timer);
  const t = now();
  const events = q.step(t);
  if (events.length) placeRoots();
  for (const e of events) render(e);
  const next = q.nextAt(now());
  if (next !== null) timer = window.setTimeout(pump, Math.max(16, next - now()));
}

function render(e: NoteEvent<Data>): void {
  const n = e.note;
  if (e.type === "hide") return void leave(n);
  if (e.type === "update") return update(n);
  const d = n.data;
  if (d.kind === "whisper") showWhisper(n, d);
  else if (d.kind === "toast") showToast(n, d);
  else if (d.kind === "celebration") (d.stage ? showStage : showMoment)(n, d.spec);
  else showBanner(n, d.spec);
}

function announce(text: string, assertive = false): void {
  const r = ensureRoots();
  const el = assertive ? r.alert : r.polite;
  el.textContent = "";
  // Next frame, so the same text twice is announced twice.
  requestAnimationFrame(() => (el.textContent = text));
}

/** Hover / focus holds a note's timer. */
function holdable(el: HTMLElement, n: Note<Data>): void {
  const set = (on: boolean) => {
    q.hold(n.id, on, now());
    pump();
  };
  el.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && set(true));
  el.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && !el.contains(document.activeElement) && set(false));
  el.addEventListener("focusin", () => set(true));
  el.addEventListener("focusout", (e) => !el.contains(e.relatedTarget as Node | null) && set(false));
}

/** Touch: swipe sideways to dismiss. */
function swipeable(el: HTMLElement, n: Note<Data>): void {
  let start: { x: number; y: number; id: number } | null = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || (e.target as Element).closest("button")) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    el.style.translate = `${dx}px 0`;
    el.style.opacity = String(1 - Math.min(0.7, Math.abs(dx) / 240));
  });
  const end = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    start = null;
    if (Math.abs(dx) > 70) {
      el.dataset.fling = String(Math.sign(dx));
      q.dismiss(n.id, now());
      pump();
    } else {
      el.animate({ translate: [`${dx}px 0`, "0 0"] }, spring(SPRINGS.pop));
      el.style.translate = "";
      el.style.opacity = "";
    }
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

const dismiss = (n: Note<Data>) => (q.dismiss(n.id, now()), pump());

function actionButton(n: Note<Data>, a: Action): HTMLButtonElement {
  return h("button.nt-act", {
    type: "button",
    onclick: () => {
      dismiss(n);
      a.run();
    },
  }, a.label) as HTMLButtonElement;
}

// ---------------------------------------------------------------------------------------------
// Whispers

function showWhisper(n: Note<Data>, d: Extract<Data, { kind: "whisper" }>): void {
  const r = ensureRoots();
  const el = h(`div.nt-whisper${d.always ? ".always" : ""}${d.at ? ".at" : ""}`, null, d.text);
  if (d.at) {
    // Rises out of the control: centred over it (under it when there's no room above), clamped to the screen.
    const b = d.at.getBoundingClientRect();
    const below = b.top < 48;
    const x = Math.max(60, Math.min(innerWidth - 60, b.left + b.width / 2));
    Object.assign(el.style, { left: `${x}px`, top: `${below ? b.bottom + d.gap : b.top - d.gap}px` });
    if (below) el.classList.add("below");
  }
  r.whispers.replaceChildren(el);
  rendered.set(n.id, { el });
  announce(d.text);
  if (reduced()) return void el.animate({ opacity: [0, 1] }, { duration: 120 });
  el.animate({ transform: ["translateY(6px)", "none"], opacity: [0, 1] }, { duration: 120, easing: EASE_OUT });
}

/** A repeat of the word on screen: it stamps again (1.08 → 1) instead of counting. */
function restamp(el: HTMLElement): void {
  if (!reduced()) el.animate({ transform: ["scale(1.08)", "none"] }, { duration: 160, easing: EASE_OUT });
}

// ---------------------------------------------------------------------------------------------
// Notices (toasts)

function leadOf(d: Extract<Data, { kind: "toast" }>): Node | null {
  if (d.lead === "update") return h("i.nt-glyph", { "aria-hidden": "true" }, "↻");
  if (d.lead) return h("span.nt-lead", { "aria-hidden": "true" }, d.lead);
  if (d.tone === "bad") return h("i.nt-glyph.bad", { "aria-hidden": "true" }, "!");
  return null;
}

function showToast(n: Note<Data>, d: Extract<Data, { kind: "toast" }>): void {
  const r = ensureRoots();
  const el = h(`div.nt-toast.tone-${d.tone}`, null, leadOf(d), h("span.nt-text", null, d.text), h("b.nt-count", { "aria-hidden": "true" }), d.action ? actionButton(n, d.action) : null);
  holdable(el, n);
  swipeable(el, n);
  flip(r.toasts, () => r.toasts.prepend(el));
  rendered.set(n.id, { el });
  announce(d.text, d.tone === "bad");
  // Every Notice lands on a soft tick (an error on the softer error click instead); not mid-run.
  if (!q.isRunning) d.tone === "bad" ? playSound("ui_error", 0.6) : playSound("toast_pop");
  if (reduced()) return void el.animate({ opacity: [0, 1] }, { duration: 120 });
  const top = inGame();
  // The hop: in along a short arc, landing with a squash (from above in game, from below in the menus).
  el.animate(hopKeyframes(top ? -14 : 16, top ? 4 : 8, !potato()), { duration: 300, fill: "backwards" });
  if (d.tone === "bad") el.animate({ translate: ["0 0", "-5px 0", "4px 0", "-2px 0", "0 0"] }, { duration: 320, delay: 160, easing: "ease-out" });
}

function update(n: Note<Data>): void {
  const r = rendered.get(n.id);
  if (!r) return;
  const d = n.data;
  if (d.kind === "whisper") {
    r.el.textContent = d.text;
    announce(d.text);
    restamp(r.el);
  } else if (d.kind === "toast") {
    // ×N counts repeats of the same words; a different line under the same key just replaces the text.
    const t = r.el.querySelector(".nt-text")!;
    r.same = t.textContent === d.text ? (r.same ?? 1) + 1 : 1;
    t.textContent = d.text;
    const c = r.el.querySelector<HTMLElement>(".nt-count")!;
    c.textContent = r.same > 1 ? `×${r.same}` : "";
    // Its action follows the newest line (or goes, when the newest has none).
    const act = r.el.querySelector(".nt-act");
    if (act?.textContent !== d.action?.label) {
      act?.remove();
      if (d.action) r.el.append(actionButton(n, d.action));
    }
    announce(d.text, d.tone === "bad");
    if (d.action && !q.isRunning) playSound("toast_pop");
    if (reduced()) return;
    r.el.animate({ transform: ["scale(1.045)", "none"] }, spring(SPRINGS.pop));
    if (r.same > 1) c.animate({ transform: ["scale(0.4)", "none"], opacity: [0, 1] }, spring(SPRINGS.bouncy));
  } else if (d.kind === "celebration") {
    // A merge into the card on screen (one more achievement from the same run): new text, a fresh punch.
    const s = d.spec;
    const title = r.el.querySelector(".nt-cel-title, .nt-stage-title");
    if (title) title.textContent = s.title;
    const det = r.el.querySelector(".nt-cel-detail, .nt-stage-sub");
    if (det) det.textContent = s.detail ?? "";
    if (!reduced()) for (const e of r.el.querySelectorAll(".nt-cel-emblem, .nt-model")) e.animate({ transform: ["scale(1.18)", "none"] }, spring(SPRINGS.bouncy));
  }
}

/** FLIP: runs `mutate`, then slides the container's other children from where they were to where they are now. */
function flip(container: HTMLElement, mutate: () => void): void {
  const kids = [...container.children] as HTMLElement[];
  const before = reduced() ? null : kids.map((k) => k.getBoundingClientRect().top);
  mutate();
  if (!before) return;
  kids.forEach((k, i) => {
    if (!k.isConnected || k.classList.contains("nt-leaving")) return;
    const dy = before[i] - k.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) k.animate({ translate: [`0 ${dy}px`, "0 0"] }, spring(SPRINGS.pop));
  });
}

// ---------------------------------------------------------------------------------------------
// Moments and celebrations: shared parts

/** The reward's disc: the level number, the emblem given, or a spark. */
/** The emblem wrap's classes for its 3D model: `.has-model`, and `.nt-model-off` if it gave up already (item3d.ts). */
const modelClass = (s: CelebrationSpec): string => (s.model ? (s.model.el.dataset.state === "off" ? ".has-model.nt-model-off" : ".has-model") : "");

function emblemOf(s: CelebrationSpec): { emblem: HTMLElement; level: HTMLElement | null; shine: HTMLElement | null } {
  const emblem = h("span.nt-cel-emblem", { "aria-hidden": "true" });
  let level: HTMLElement | null = null;
  if (s.level) emblem.append((level = h("b.nt-level-n", null, String(s.level[0]))));
  else if (s.emblem) emblem.append(s.emblem);
  else emblem.append(h("span.nt-spark"));
  const shine = s.shine ? h("i.nt-shine") : null;
  if (shine) emblem.append(shine);
  return { emblem, level, shine };
}

/** The cue as the reward lands; a sequence of moments climbs a semitone each, on top of the rarity's own rate. */
function landSound(s: CelebrationSpec, at: number): void {
  const t = now();
  streak = t - streak.at < 12_000 ? { n: Math.min(streak.n + 1, 4), at: t } : { n: 0, at: t };
  const rate = (s.rate ?? 1) * Math.pow(2, streak.n / 12);
  if (s.sound) window.setTimeout(() => playSound(s.sound!, 1, rate), reduced() ? 0 : at);
}

/** Beats that follow the landing: the shine, the level counting up, the wingbeat. Returns its timers. */
function afterLanding(s: CelebrationSpec, emblem: HTMLElement, level: HTMLElement | null, shine: HTMLElement | null, at: number): number[] {
  const timers: number[] = [];
  if (s.feathers)
    emblem.animate(
      { transform: ["none", "translateY(-5px) scale(1.04, 0.96)", "none", "translateY(-4px) scale(1.03, 0.97)", "none", "translateY(-2px)", "none"] },
      { duration: 900, delay: at + 360, easing: "ease-in-out" },
    );
  if (shine) {
    shine.animate({ transform: ["translateX(-130%) skewX(-18deg)", "translateX(130%) skewX(-18deg)"] }, { duration: 700, delay: at + 220, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "both" });
    timers.push(window.setTimeout(() => playSound("shine"), at + 220));
  }
  const lv = s.level;
  if (level && lv) timers.push(window.setTimeout(() => countUp(level, lv[0], lv[1], 650, () => level.animate({ transform: ["scale(1.35)", "none"] }, spring(SPRINGS.bouncy))), at + 100));
  return timers;
}

// ---------------------------------------------------------------------------------------------
// Moments (menus)

function showMoment(n: Note<Data>, s: CelebrationSpec): void {
  const r = ensureRoots();
  const color = s.color ?? "#ffb43a";
  const { emblem, level, shine } = emblemOf(s);
  const ringEl = s.ring ? h("i.nt-ring", { "aria-hidden": "true" }) : null;
  const kicker = s.kicker ? h("span.nt-cel-kicker", null, s.kicker) : null;
  const title = h("b.nt-cel-title", null, s.title);
  const detail = s.detail ? h("span.nt-cel-detail", null, s.detail) : null;
  const m = s.mood ? mascot(s.mood, { className: "nt-cel-mascot" }) : null;
  const slab = h("div.nt-cel-slab", null, h(`span.nt-cel-emblem-wrap${modelClass(s)}`, null, ringEl, emblem, s.model?.el ?? null), h("div.nt-cel-text", null, kicker, title, detail), s.action ? actionButton(n, s.action) : null);
  const el = h(`div.nt-cel${m ? ".has-mascot" : ""}`, { style: `--c:${color}`, title: s.hint ?? null }, m?.el ?? null, slab);
  holdable(el, n);
  swipeable(el, n);
  // A click anywhere but its action dismisses it.
  el.addEventListener("click", (e) => !(e.target as Element).closest("button") && dismiss(n));
  r.cels.replaceChildren(el);
  s.model?.show();
  // Toasts in the same corner sit above it (and above the bunny peeking over it). Measured before anything moves.
  const box = el.getBoundingClientRect();
  const top = Math.min(box.top, m ? m.el.getBoundingClientRect().top : Infinity);
  document.documentElement.style.setProperty("--nt-cel-h", `${Math.round(box.bottom - top)}px`);
  document.documentElement.classList.add("nt-has-cel");
  const entry: { el: HTMLElement; cleanup?: () => void } = { el };
  rendered.set(n.id, entry);
  announce(`${s.kicker ? `${s.kicker}: ` : ""}${s.title}${s.detail ? `. ${s.detail}` : ""}`);

  landSound(s, 200);
  if (reduced()) {
    if (level && s.level) level.textContent = String(s.level[1]);
    el.animate({ opacity: [0, 1] }, { duration: 120 });
    return;
  }
  // The hop: the slab comes in on a short arc and lands; the reward stamps out of it as it does, the ring spreads.
  slab.animate(hopKeyframes(18, 8, !potato()), { duration: 300, fill: "backwards" });
  stamp(emblem, 150);
  ringEl?.animate({ transform: ["scale(0.9)", "scale(1.8)"], opacity: [0.75, 0] }, { duration: 560, delay: 220, easing: EASE_OUT, fill: "both" });
  [kicker, title, detail].forEach((x, i) => x?.animate({ transform: ["translateX(-8px)", "none"], opacity: [0, 1] }, { duration: 260, delay: 140 + i * 55, easing: EASE_OUT, fill: "backwards" }));
  const timers = afterLanding(s, emblem, level, shine, 200);
  if (s.confetti && !q.isRunning)
    timers.push(window.setTimeout(() => {
      const b = emblem.getBoundingClientRect();
      burst({ x: b.left + b.width / 2, y: b.top + b.height / 2, count: Math.min(120, typeof s.confetti === "number" ? s.confetti : 40), accent: color, feathers: s.feathers, ...(s.feathers ? { power: 0.7, spread: 120 } : {}) });
    }, 220));
  if (m) {
    // Rises from behind the slab once it's there (hidden until then), then hops.
    m.el.animate({ transform: ["translateY(70%)", "none"] }, { ...spring(SPRINGS.bouncy), delay: 260, fill: "backwards" });
    m.el.animate({ opacity: [0, 1] }, { duration: 90, delay: 260, fill: "backwards" });
    timers.push(window.setTimeout(() => m.react("hop"), 780));
  }
  entry.cleanup = () => timers.forEach(clearTimeout);
}

// ---------------------------------------------------------------------------------------------
// Celebrations: the stage

/** Where the reward hops in from (px off its rest) and how high the arc rises. */
const ARC = { x: -170, y: 70, lift: 80 };

function showStage(n: Note<Data>, s: CelebrationSpec): void {
  const r = ensureRoots();
  const color = s.color ?? "#ffb43a";
  const lite = potato();
  const { emblem, level, shine } = emblemOf(s);
  const ringEl = h("i.nt-ring", { "aria-hidden": "true" });
  // The dotted trail the reward leaves on its way in (the wordmark's hop line): 6 dots, opacity only. Not on Potato.
  const dots = lite ? [] : arcPoints(ARC.x, ARC.y, ARC.lift).map((p) => h("i.nt-arc-dot", { style: `left:${p.x.toFixed(1)}px;top:${p.y.toFixed(1)}px` }));
  const wrap = h(`span.nt-stage-reward${modelClass(s)}`, null, h("span.nt-arc", { "aria-hidden": "true" }, ...dots), ringEl, emblem, s.model?.el ?? null);
  const title = h("b.nt-stage-title", null, s.title);
  const sub = s.detail ? h("span.nt-stage-sub", null, s.detail) : null;
  const dim = h("i.nt-stage-dim", { "aria-hidden": "true" });
  const band = h("i.nt-stage-band", { "aria-hidden": "true" });
  const m = s.mood ? mascot(s.mood, { className: "nt-stage-mascot" }) : null;
  const body = h("div.nt-stage-body", null, wrap, title, sub, s.action ? actionButton(n, s.action) : null, m?.el ?? null);
  const el = h("div.nt-stage", { style: `--c:${color}`, title: s.hint ?? null, role: "dialog", "aria-label": s.title }, dim, band, body);
  holdable(el, n);
  el.addEventListener("click", (e) => !(e.target as Element).closest("button") && dismiss(n));
  // Any key ends it. In game the key still does what it does (R restarts); in the menus it only ends it (Enter or
  // Space would press whatever has focus behind the dim).
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat || ["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    if (!inGame()) {
      e.preventDefault();
      e.stopPropagation();
    }
    dismiss(n);
  };
  addEventListener("keydown", onKey, true);
  r.cels.replaceChildren(el);
  s.model?.show();
  const entry: { el: HTMLElement; cleanup?: () => void } = { el };
  rendered.set(n.id, entry);
  announce(`${s.title}${s.detail ? `. ${s.detail}` : ""}`);
  landSound(s, 520);
  const timers: number[] = [];
  entry.cleanup = () => {
    timers.forEach(clearTimeout);
    removeEventListener("keydown", onKey, true);
  };
  if (reduced()) {
    if (level && s.level) level.textContent = String(s.level[1]);
    el.animate({ opacity: [0, 1] }, { duration: 120 });
    timers.push(window.setTimeout(() => playSound("stamp"), 0));
    return;
  }
  // 0: the dim. 60: the band wipes out from the centre. 180: the title slams in, the screen kicks.
  dim.animate({ opacity: [0, 1] }, { duration: 160, easing: EASE_OUT, fill: "backwards" });
  band.animate({ transform: ["scaleX(0)", "none"] }, { ...spring(SPRINGS.land), delay: 60, fill: "backwards" });
  band.animate({ opacity: [0, 1] }, { duration: 120, delay: 60, fill: "backwards" });
  stamp(title, 180);
  timers.push(window.setTimeout(() => kick(), 225));
  sub?.animate({ transform: ["translateY(8px)", "none"], opacity: [0, 1] }, { duration: 260, delay: 320, easing: EASE_OUT, fill: "backwards" });
  // 260: the reward hops in on its arc and lands (520) with a squash; the dots appear behind it one after another.
  const hopAt = 260;
  const hopMs = 300;
  wrap.animate(arcKeyframes(ARC.x, ARC.y, ARC.lift, !lite), { duration: hopMs, delay: hopAt, fill: "backwards", easing: "linear" });
  dots.forEach((d, i) => d.animate({ opacity: [0, 0.8, 0.8, 0], offset: [0, 0.08, 0.6, 1] }, { duration: 1500, delay: hopAt + 40 + i * 42, fill: "backwards" }));
  ringEl.animate({ transform: ["scale(0.9)", "scale(2)"], opacity: [0.8, 0] }, { duration: 620, delay: hopAt + hopMs - 30, easing: EASE_OUT, fill: "both" });
  timers.push(...afterLanding(s, emblem, level, shine, hopAt + hopMs));
  // 640: the bunny hops in from the right on its own arc and lands beside the band (the boing comes with its hop).
  if (m) {
    m.el.animate(arcKeyframes(220, 0, 70, false), { duration: 340, delay: 640, fill: "backwards", easing: "linear" });
    timers.push(window.setTimeout(() => m.react("hop"), 640 + 330));
  }
  // 700: confetti from both bottom corners, upwards and inwards, so it stays on screen. Never mid-run, never on Potato.
  if (s.confetti && !q.isRunning && !lite) {
    const count = Math.min(120, typeof s.confetti === "number" ? s.confetti * 1.5 : 110);
    timers.push(window.setTimeout(() => {
      const opts = { count: Math.round(count / 2), accent: color, feathers: s.feathers, spread: 30, power: 1.25 };
      burst({ ...opts, x: 0, y: innerHeight, angle: 28 });
      burst({ ...opts, x: innerWidth, y: innerHeight, angle: -28 });
    }, 700));
  }
}

/** The screen's little kick as a celebration's title lands: the menu (or the HUD) drops 4 px and springs back. */
function kick(): void {
  if (reduced()) return;
  const target = document.body.classList.contains("menu-open") || !document.body.classList.contains("in-game") ? document.getElementById("menu") : document.getElementById("hud");
  target?.animate({ translate: ["0 4px", "0 0"] }, { duration: 140, easing: EASE_OUT });
}

/**
 * Counts `el`'s text from → to over `ms` (ease-out), calling `onStep` each time the number changes. Each change ticks
 * (count_tick, paced and rising, see TickPacer) unless a run is going.
 */
export function countUp(el: HTMLElement, from: number, to: number, ms = 700, onStep?: () => void, fmt: (n: number) => string = String): void {
  if (reduced() || from === to) {
    el.textContent = fmt(to);
    return;
  }
  const t0 = now();
  let shown = from;
  const tick = () => {
    const t = Math.min(1, (now() - t0) / ms);
    const v = countUpValue(from, to, t);
    if (v !== shown) {
      shown = v;
      el.textContent = fmt(v);
      if (!q.isRunning && el.isConnected) {
        const rate = ticks.next(now());
        if (rate !== null) playSound("count_tick", 1, rate);
      }
      if (Math.abs(to - from) < 20) onStep?.();
    }
    if (t < 1 && el.isConnected) requestAnimationFrame(tick);
    else if (Math.abs(to - from) >= 20) onStep?.();
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------------------------
// Banners

function showBanner(n: Note<Data>, s: BannerSpec): void {
  const r = ensureRoots();
  const title = h("b.nt-banner-title", null, s.title);
  const sub = s.sub ? h("span.nt-banner-sub", null, s.sub) : null;
  const band = h("div.nt-banner-band", null, title, sub);
  const el = h(`div.nt-banner.tone-${s.tone ?? "info"}${q.isRunning || s.compact ? ".compact" : ""}`, null, band);
  r.banners.replaceChildren(el);
  rendered.set(n.id, { el });
  announce(`${s.title}${s.sub ? `. ${s.sub}` : ""}`);
  if (s.sound) window.setTimeout(() => playSound(s.sound!), reduced() ? 0 : 90);
  if (reduced()) return void el.animate({ opacity: [0, 1] }, { duration: 120 });
  // The hop, down from above; the title stamps down (from 1.4x), the sub line follows; one shine across the title.
  band.animate(hopKeyframes(-16, 5, !potato()), { duration: 320, fill: "backwards" });
  title.animate({ transform: ["scale(1.4)", "none"], opacity: [0, 1] }, { ...spring(SPRINGS.land), delay: 60, fill: "backwards" });
  sub?.animate({ transform: ["translateY(-6px)", "none"], opacity: [0, 1] }, { duration: 260, delay: 170, easing: EASE_OUT, fill: "backwards" });
  // The shine animates background-position (not compositable): menus and after a run only, never mid-run.
  if (!q.isRunning) title.animate({ backgroundPosition: ["150% 0", "-50% 0"] }, { duration: 900, delay: 320, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "both" });
  // Confetti from both bottom corners (from the band itself it would leave the screen at once).
  if (s.confetti && !q.isRunning)
    window.setTimeout(() => {
      burst({ x: 0, y: innerHeight, count: 55, spread: 30, power: 1.25, angle: 28 });
      burst({ x: innerWidth, y: innerHeight, count: 55, spread: 30, power: 1.25, angle: -28 });
    }, 140);
}

// ---------------------------------------------------------------------------------------------
// Leaving

async function leave(n: Note<Data>): Promise<void> {
  const r = rendered.get(n.id);
  rendered.delete(n.id);
  if (!r) return;
  r.cleanup?.();
  const el = r.el;
  if (n.lane === "celebration") document.documentElement.classList.remove("nt-has-cel");
  if (!el.isConnected) return el.remove();
  if (reduced()) {
    await el.animate({ opacity: [1, 0] }, { duration: 120, fill: "forwards" }).finished.catch(() => {});
    return el.remove();
  }
  const fling = Number(el.dataset.fling ?? 0);
  if (n.lane === "whisper") {
    el.classList.add("nt-leaving");
    await el.animate({ opacity: [1, 0] }, { duration: 300, easing: EASE_IN, fill: "forwards" }).finished.catch(() => {});
  } else if (n.lane === "toast") {
    const top = inGame();
    // Out of the flow at once, pinned where it is (fixed, in the host: the lane's own box shrinks and re-centres), so
    // the others slide into place while it fades.
    const box = roots!.toasts;
    flip(box, () => {
      const b = el.getBoundingClientRect();
      el.classList.add("nt-leaving");
      Object.assign(el.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px` });
      (box.parentElement ?? document.body).append(el);
    });
    await (fling
      ? el.animate({ transform: ["none", `translateX(${fling * 120}px)`], opacity: [1, 0] }, { duration: 150, easing: EASE_IN, fill: "forwards" })
      : el.animate(hopOffKeyframes(top ? -10 : 12), { duration: 200, fill: "forwards" })
    ).finished.catch(() => {});
  } else if (n.lane === "celebration" && el.classList.contains("nt-stage")) {
    el.style.pointerEvents = "none";
    el.querySelector(".nt-stage-body")?.animate(hopOffKeyframes(-14), { duration: 220, fill: "forwards" });
    await el.animate({ opacity: [1, 0] }, { duration: 240, delay: 40, easing: EASE_IN, fill: "forwards" }).finished.catch(() => {});
  } else if (n.lane === "celebration") {
    el.querySelector<HTMLElement>(".nt-cel-mascot")?.animate({ transform: ["none", "translateY(80%)"] }, { duration: 140, easing: EASE_IN, fill: "forwards" });
    await (fling
      ? el.animate({ transform: ["none", `translateX(${fling * 160}px)`], opacity: [1, 0] }, { duration: 190, easing: EASE_IN, fill: "forwards" })
      : el.animate(hopOffKeyframes(14), { duration: 220, delay: 40, fill: "forwards" })
    ).finished.catch(() => {});
  } else {
    await el.animate(hopOffKeyframes(-12), { duration: 220, fill: "forwards" }).finished.catch(() => {});
  }
  el.remove();
}

// ---------------------------------------------------------------------------------------------
// Inline cues

/**
 * A badge / dot on screen changed: it pops (scale 0.55 → 1 on the bouncy spring). Animates the `scale` property, so
 * it composes with whatever `transform` places the element.
 */
export function nudge(el: Element): void {
  if (reduced() || !(el as HTMLElement).isConnected) return;
  el.animate({ scale: ["0.55", "1"] }, spring(SPRINGS.bouncy));
}

/** A ring spreading from `el` once (new message, a fresh "new" dot). */
export function ring(el: HTMLElement, color = "var(--accent)"): void {
  if (reduced() || !el.isConnected) return;
  const r = h("i.nt-ping", { "aria-hidden": "true", style: `--c:${color}` });
  el.append(r);
  r.animate({ transform: ["scale(0.8)", "scale(2.6)"], opacity: [0.8, 0] }, { duration: 650, easing: EASE_OUT }).finished.then(() => r.remove(), () => r.remove());
}

/**
 * A big word stamping onto the screen (an end-of-run "New PB", the verified place): from 1.7x down past 1 and back
 * (tixy's slam), with a soft thump as it lands (~45 ms in, where the ease reaches the 0.94 squash). Reduced motion: no
 * slam, the thump still marks it appearing.
 */
export function stamp(el: Element, delay = 0): void {
  window.setTimeout(() => (el as HTMLElement).isConnected && playSound("stamp"), reduced() ? delay : delay + 45);
  if (reduced()) return;
  el.animate({ transform: ["scale(1.7) rotate(-6deg)", "scale(0.94) rotate(1deg)", "scale(1.02)", "none"], opacity: [0, 1, 1, 1], offset: [0, 0.4, 0.7, 1] }, { duration: 460, delay, easing: "cubic-bezier(0.2, 0.9, 0.3, 1)", fill: "backwards" });
}

/** Springs an element in from below (cards, panels that should land rather than appear). */
export function landIn(el: Element, from = "translateY(14px) scale(0.97)", delay = 0): void {
  if (reduced()) return;
  el.animate({ transform: [from, "none"] }, { ...spring(SPRINGS.pop), delay, fill: "backwards" });
  el.animate({ opacity: [0, 1] }, { duration: 160, delay, easing: EASE_OUT, fill: "backwards" });
}

if (import.meta.env?.DEV && typeof window !== "undefined") Object.assign(window, { __notify: { whisper, toast, moment, celebrate, banner, nudge, ring, stamp, setRunActive, queue: q } });
