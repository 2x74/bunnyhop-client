// The bunny mascot: a small 2D take on the game's bunny (player/bunny/mesh.ts): cream hoodie with the hood up and
// bunny ears (amber inner panels), dark face, the amber visor band with two glowing eyes, amber drawstrings, dark
// gloves, and the carrot. Built here as one inline SVG (no assets), every mood's parts in the same drawing; the mood is
// a data attribute and CSS (notify/mascot.css) shows the right eyes / mouth / arm poses and runs the idle loops
// (blink, breathing, ear flop) and one-shot reactions (hop, jolt) with transforms only.
//
//   const m = mascot("cheer", { size: "5rem" }); el.append(m.el); m.set("proud"); m.react("hop");
//
// Moods: idle, cheer, proud, surprised, sleepy, sad, thinking, waving. Performance: every moving part is a separate
// composited HTML layer (see HTML below) and life comes in short bursts only while visible (Life), so an idle bunny
// costs nothing per frame (research/NOTIFICATIONS.md, "The bunny: performance"). Colours come from CSS custom properties
// (--m-hood, --m-trim, --m-face, --m-accent, --m-eye ...), so a colourway is a style attribute away (colourwayVars).
// Used tastefully: big celebrations, the inbox, feedback thanks, error / stall screens and the tutorial finish; never
// in plain toasts and never while a run is going.

import "./mascot.css";
import { COLOURWAYS } from "../player/bunny/palettes";

export type Mood = "idle" | "cheer" | "proud" | "surprised" | "sleepy" | "sad" | "thinking" | "waving";
export const MOODS: Mood[] = ["idle", "waving", "cheer", "proud", "surprised", "thinking", "sleepy", "sad"];

export interface Mascot {
  el: HTMLElement;
  mood: Mood;
  set(mood: Mood): void;
  /** One-shot reaction on top of the mood: a hop (good news), a jolt (surprise / error), a nod. */
  react(kind: "hop" | "jolt" | "nod"): void;
}

// Drawn like the Discord stickers (tools/discord/assets/stickers): every part has a thick ink outline (.k: a stroke
// painted under its fill, so only the outer half shows), flat fills, a chibi head on a short body. Ear: outer shell and
// inner panel, pointing up from the base (0, 0).
const EAR = "M-7.2 3C-10.4-9-10-25.5-0.4-31C9.6-25.5 10.6-9 7.2 3Z";
const EAR_IN = "M-3.6 0C-5.6-9-5.4-20.6-0.3-25C5-20.6 5.6-9 3.6 0Z";
// Sleeve from the shoulder (0, 0) down to its cuff; the mitten (thumb towards the body: `side` 1 or -1) below it.
const SLEEVE = `<path class="m-sleeve k" d="M-5.6-2C-7.8 4.6-7.8 11.2-6.2 16.8H6C7.4 11.2 7.4 4.6 5.4-2Z"/><path class="m-shade" d="M2.6-1.6C4.6 4.6 4.6 11.2 3.2 14H6C7.4 11.2 7.4 4.6 5.4-2Z"/><path class="m-cuff" d="M-6.2 13.8H6V16.8H-6.2Z"/><path class="m-seam" d="M-6.6 13.8H6.4"/>`;
const mitten = (x: number, y: number, side: number) => `<ellipse class="m-paw k" cx="${x + side * 4.4}" cy="${y - 2}" rx="2.5" ry="2.3"/><circle class="m-paw k" cx="${x}" cy="${y}" r="5.2"/>`;

const CARROT = `<g class="m-carrot"><path class="m-leaf k-thin" d="M0-2.5C-3-7-2.5-10.5-1.2-12C-0.4-9-0.2-6 0-2.5Z"/><path class="m-leaf m-leaf2 k-thin" d="M0.4-2.5C2.6-6.6 5.6-8.4 7.6-8.6C6-5.6 3.6-3.6 0.4-2.5Z"/><path class="m-root k" d="M-3.6-2.2C-1.4-3.6 1.6-3.6 3.6-2.2L0.6 20.5C0.3 21.4-0.3 21.4-0.6 20.5Z"/><path class="m-ridge" d="M-2.4 3.4L0.8 4.2M-1.6 8.6L1.2 9.2M-1 13.6L0.9 14"/></g>`;

// Layers. Every part that moves is its own HTML layer holding a full-size SVG with the same viewBox, so its motion is a
// CSS transform on an HTML box: composited, no repaint. (Animating elements *inside* one SVG repaints the whole SVG
// every frame, which cost a weak GPU ~40 fps.) Joint pivots are percentages of the 100 × 124 box (mascot.css).
const svg = (body: string, defs = "") => `<svg viewBox="0 0 100 124" focusable="false">${defs}${body}</svg>`;
const layer = (cls: string, body: string, defs = "") => `<i class="m-l ${cls}">${svg(body, defs)}</i>`;

const SHOE_L = `<path class="m-sole k" d="M35.4 114.6H49.4V116.6C49.4 117.6 48.8 118.2 47.8 118.2H37C36 118.2 35.4 117.6 35.4 116.6Z"/><path class="m-shoe k" d="M35.4 113.4C35.4 110.8 37.2 109.2 39.8 109.2H46.8C48.4 109.2 49.4 110.4 49.4 112V114.6H35.4Z"/>`;
const SHOE_R = `<path class="m-sole k" d="M50.6 114.6H64.6V116.6C64.6 117.6 64 118.2 63 118.2H52.2C51.2 118.2 50.6 117.6 50.6 116.6Z"/><path class="m-shoe k" d="M64.6 113.4C64.6 110.8 62.8 109.2 60.2 109.2H53.2C51.6 109.2 50.6 110.4 50.6 112V114.6H64.6Z"/>`;
const LEGS = `<path class="m-pants k" d="M38.4 99H49L48.6 110.6H39ZM51 99H61.6L61 110.6H51.4Z"/><path class="m-stripe" d="M40.6 100.4V109.6M59.4 100.4V109.6"/>${SHOE_L}${SHOE_R}`;
const HOODIE = "M36.6 75.2C42.4 72.6 57.6 72.6 63.4 75.2C68.4 79.6 70.6 89.6 70.2 98.4C70.1 100.6 68.8 101.8 66.8 101.8H33.2C31.2 101.8 29.9 100.6 29.8 98.4C29.4 89.6 31.6 79.6 36.6 75.2Z";
const TORSO = `<path class="m-hoodie k" d="${HOODIE}"/><path class="m-shade" clip-path="url(#CLIP-body)" d="M62 70C68 80 70 92 64 104H76V70Z"/><path class="m-pocket m-seam" d="M39.6 87.4H60.4L62.4 96.8H37.6Z"/><path class="m-hem" d="M30.1 96.8H69.9V98.4C69.9 100.4 68.6 101.8 66.8 101.8H33.2C31.4 101.8 30.1 100.4 30.1 98.4Z"/><path class="m-seam" d="M30.2 96.8H69.8"/><path class="m-string-k" d="M46 75.6V86M54 75.6V87.6"/><path class="m-string" d="M46 75.6V86M54 75.6V87.6"/><circle class="m-aglet k-thin" cx="46" cy="86.8" r="1.5"/><circle class="m-aglet k-thin" cx="54" cy="88.4" r="1.5"/>`;
const ARM_R = `<g transform="translate(34 78.4)">${SLEEVE}<g transform="translate(0 20.8)">${CARROT}</g>${mitten(0, 20.6, 1)}</g>`;
const ARM_L = `<g transform="translate(66 78.4)">${SLEEVE}${mitten(0, 20.6, -1)}</g>`;
const EAR_R = `<g transform="translate(40 31) rotate(-12)"><path class="m-ear-out k" d="${EAR}"/><path class="m-ear-in" d="${EAR_IN}"/></g>`;
const EAR_L = `<g transform="translate(60 31) rotate(12)"><path class="m-ear-out k" d="${EAR}"/><path class="m-ear-in" d="${EAR_IN}"/></g>`;
const FACE = `<ellipse class="m-hood k" cx="50" cy="52.5" rx="30" ry="27.5"/><path class="m-shade" clip-path="url(#CLIP-hood)" d="M74 30C82 46 78 70 56 80H84V30Z"/><ellipse class="m-rim k-in" cx="50" cy="55" rx="22.4" ry="20.6"/><ellipse class="m-face" cx="50" cy="55.8" rx="19.8" ry="18.4"/><g clip-path="url(#CLIP-face)"><rect class="m-visor" x="28" y="45.6" width="44" height="10.4"/><rect class="m-visor-lo" x="28" y="54.2" width="44" height="1.8"/><rect class="m-visor-hi" x="28" y="45.6" width="44" height="1.3"/></g><ellipse class="m-mouth m-mouth-dot" cx="50" cy="63.4" rx="1.6" ry="1.9"/><path class="m-mouth m-mouth-smile" d="M46.4 61.8Q50 67.4 53.6 61.8Z"/><ellipse class="m-mouth m-mouth-o" cx="50" cy="63.8" rx="2.2" ry="2.8"/><path class="m-mouth m-mouth-frown" d="M47 65.2Q50 62 53 65.2"/>`;
const EYES = `<g class="m-eyes m-eyes-open"><circle class="m-eye" cx="42.4" cy="50.8" r="3.4"/><circle class="m-eye" cx="57.6" cy="50.8" r="3.4"/></g><g class="m-eyes m-eyes-happy"><path class="m-eye-line" d="M38.8 52.6Q42.4 47.4 46 52.6M54 52.6Q57.6 47.4 61.2 52.6"/></g><g class="m-eyes m-eyes-proud"><path class="m-eye" d="M38.9 50.2H45.9C45.9 52.4 44.3 53.6 42.4 53.6C40.5 53.6 38.9 52.4 38.9 50.2ZM54.1 50.2H61.1C61.1 52.4 59.5 53.6 57.6 53.6C55.7 53.6 54.1 52.4 54.1 50.2Z"/></g><g class="m-eyes m-eyes-wide"><circle class="m-eye" cx="42.4" cy="50.8" r="4.2"/><circle class="m-eye" cx="57.6" cy="50.8" r="4.2"/></g><g class="m-eyes m-eyes-sleepy"><path class="m-eye-line" d="M39 51Q42.4 53.2 45.8 51M54.2 51Q57.6 53.2 61 51"/></g><g class="m-eyes m-eyes-sad"><ellipse class="m-eye" cx="42.6" cy="51.4" rx="3.2" ry="2" transform="rotate(-16 42.6 51.4)"/><ellipse class="m-eye" cx="57.4" cy="51.4" rx="3.2" ry="2" transform="rotate(16 57.4 51.4)"/></g><g class="m-eyes m-eyes-think"><ellipse class="m-eye" cx="44" cy="50" rx="3.2" ry="2.5"/><path class="m-eye-line" d="M55 50.8H61"/></g>`;

// The die-cut: a copy of the figure behind it, every shape filled and thickly stroked in --m-cut (mascot.css .m-cutset),
// like the stickers' white border. Its layers carry the same classes as the real ones, so every pose and animation
// moves both together (still transforms only). Effects get one too; the eyes don't need it.
const FACE_DEFS = `<defs><clipPath id="CLIP-face"><ellipse cx="50" cy="55.8" rx="19.8" ry="18.4"/></clipPath><clipPath id="CLIP-hood"><ellipse cx="50" cy="52.5" rx="30" ry="27.5"/></clipPath><clipPath id="CLIP-body"><path d="${HOODIE}"/></clipPath></defs>`;
const figure = (cut: boolean) =>
  `<i class="m-l m-fig">${layer("m-legs", LEGS)}${layer("m-torso", TORSO, cut ? "" : FACE_DEFS)}${layer("m-arm m-arm-r", ARM_R)}${layer("m-arm m-arm-l", ARM_L)}<i class="m-l m-head">${layer("m-ear m-ear-r", EAR_R)}${layer("m-ear m-ear-l", EAR_L)}${layer("m-facel", FACE)}${cut ? "" : layer("m-eyesl", EYES)}${layer("m-chinpaw", mitten(57.4, 73, -1))}</i></i>`;
const FX = `${layer("m-fx m-fx-z1", `<text x="74" y="30">z</text>`)}${layer("m-fx m-fx-z2", `<text x="80" y="22">z</text>`)}${layer("m-fx m-fx-t1", `<circle class="k-thin" cx="76" cy="34" r="1.6"/>`)}${layer("m-fx m-fx-t2", `<circle class="k-thin" cx="81.4" cy="27.4" r="2.2"/>`)}${layer("m-fx m-fx-t3", `<circle class="k-thin" cx="88" cy="19.6" r="3"/>`)}${layer("m-fx m-fx-s1", `<path class="k-thin" d="M12 34l1.4 3.8 3.8 1.4-3.8 1.4L12 44.4l-1.4-3.8-3.8-1.4 3.8-1.4z"/>`)}${layer("m-fx m-fx-s2", `<path class="k-thin" d="M88 40l1 2.8 2.8 1-2.8 1L88 47.6l-1-2.8-2.8-1 2.8-1z"/>`)}`;

// Order = paint order (later on top): the arms go behind the head, so a raised arm passes behind the hood.
const HTML = `<i class="m-stage">${layer("m-shadow", `<ellipse cx="50" cy="119.8" rx="20" ry="2.4"/>`)}<i class="m-l m-cutset">${figure(true)}${FX}</i>${figure(false)}${FX}</i>`;

let uid = 0;
let reactSound: (kind: "hop" | "jolt" | "nod") => void = () => {};

/** notify/index.ts: the sound a reaction makes (the hop's boing), played as it starts. Only visible reactions sound. */
export function setMascotSound(fn: (kind: "hop" | "jolt" | "nod") => void): void {
  reactSound = fn;
}

// ---------------------------------------------------------------------------------------------
// Life: still most of the time ("idle UI is still, motion is feedback"). While a bunny is visible (on screen, tab
// shown) a timer plays short bursts: its mood's loop a couple of times (class m-live, finite iterations in CSS), a
// blink (m-blink, 160 ms), now and then an ear flop (m-flop). Between bursts nothing animates, so nothing is drawn.
// Off screen, in a hidden tab, detached or with reduced motion: no timer, no animation.

/** How long one burst of a mood's loop runs (CSS iteration count × duration), ms. */
const BURST: Record<Mood, number> = { idle: 3000, waving: 3800, cheer: 3000, proud: 2600, surprised: 0, thinking: 3400, sleepy: 4300, sad: 4000 };
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

class Life {
  private visible = false;
  /** Has been on screen (after that, leaving the document ends it for good). */
  private seen = false;
  private timer = 0;
  private io: IntersectionObserver | null = null;
  private onVis = () => this.update();
  constructor(private m: Mascot) {}

  /** First connection: watch visibility. */
  start(): void {
    if (this.io || reducedMotion() || typeof IntersectionObserver === "undefined") return;
    this.io = new IntersectionObserver((e) => {
      this.visible = e[e.length - 1].isIntersecting;
      if (this.visible) this.seen = true;
      this.update();
    });
    this.io.observe(this.m.el);
    document.addEventListener("visibilitychange", this.onVis);
  }

  private stop(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    this.m.el.classList.remove("m-live", "m-blink", "m-flop");
  }

  private dispose(): void {
    this.stop();
    this.io?.disconnect();
    this.io = null;
    document.removeEventListener("visibilitychange", this.onVis);
  }

  update(): void {
    if (this.seen && !this.m.el.isConnected) return this.dispose();
    const on = this.visible && !document.hidden;
    if (!on) return this.stop();
    if (!this.timer) this.burst(true);
  }

  /** One burst, then the next one in 4–7 s (the first: the mood's loop at once, so a fresh bunny is alive). */
  private burst(first = false): void {
    const el = this.m.el;
    if (!el.isConnected) return this.dispose();
    const loop = BURST[this.m.mood];
    const roll = Math.random();
    if (loop && (first || roll < 0.55)) this.play("m-live", loop);
    else if (roll < 0.8 || !["idle", "waving"].includes(this.m.mood)) this.play("m-blink", 170);
    else this.play("m-flop", 1000);
    this.timer = window.setTimeout(() => this.burst(), (first ? loop : 0) + 4000 + Math.random() * 3000);
  }

  private play(cls: string, ms: number): void {
    const el = this.m.el;
    el.classList.remove(cls);
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(cls);
    window.setTimeout(() => el.classList.remove(cls), ms + 50);
  }

  /** Mood changed: its loop plays now (if visible). */
  restart(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.m.el.classList.remove("m-live");
    this.burst(true);
  }
}

/** A mascot element in `mood`. `size`: CSS width (height follows, 100:124). `label`: alt text when it carries meaning. */
export function mascot(mood: Mood = "idle", opts: { size?: string; label?: string; colourway?: string; className?: string } = {}): Mascot {
  const el = document.createElement("span");
  el.className = `mascot${opts.className ? ` ${opts.className}` : ""}`;
  // clipPath ids must be unique per document.
  el.innerHTML = HTML.replaceAll("CLIP-", `m-clip-${++uid}-`);
  if (opts.size) el.style.setProperty("--m-size", opts.size);
  if (opts.colourway) el.setAttribute("style", `${el.getAttribute("style") ?? ""};${colourwayVars(opts.colourway)}`);
  if (opts.label) {
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", opts.label);
  } else el.setAttribute("aria-hidden", "true");
  const m: Mascot = {
    el,
    mood,
    set(next) {
      if (next === m.mood && el.dataset.mood) return;
      m.mood = next;
      el.dataset.mood = next;
      life.restart();
    },
    react(kind) {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      el.classList.remove("m-react-hop", "m-react-jolt", "m-react-nod");
      void el.offsetWidth; // restart the one-shot
      el.classList.add(`m-react-${kind}`);
      if (el.isConnected) reactSound(kind);
      // Other layers' animations end too (and bubble here): wait for the reaction's own end.
      const done = (e: AnimationEvent) => {
        if (!e.animationName.startsWith("m-react")) return;
        el.classList.remove(`m-react-${kind}`);
        el.removeEventListener("animationend", done);
      };
      el.addEventListener("animationend", done);
    },
  };
  const life = new Life(m);
  el.dataset.mood = mood;
  life.start(); // the observer reports once it's in the document and on screen
  return m;
}

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** CSS custom properties dressing the mascot in a colourway (palettes.ts): hood, trim, face, accent. */
export function colourwayVars(id: string): string {
  const c = COLOURWAYS[id];
  if (!c) return "";
  return `--m-hood:${hex(c.hoodie)};--m-trim:${hex(c.trim)};--m-face:${hex(c.face)};--m-accent:${hex(c.accent)};--m-paw:${hex(c.glove)};--m-pants:${hex(c.pants)};--m-shoe:${hex(c.shoe)}`;
}
