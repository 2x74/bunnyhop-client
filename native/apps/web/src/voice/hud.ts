// Voice HUD: a talker list in the bottom left (each person talking: their picture, name and a live spectrum of their
// voice), your own row while you hold the push to talk key, and a plain line when you can't talk (no account, muted in
// the room, the microphone blocked). The spectrum comes from the decoded audio (voice/client.ts), never from the
// network. Clicking a row (while the cursor is free) opens the person's voice menu (voice/menu.ts).
//
// The look (v0.0.40): each row is a plate, the menu's leaning shape (notify.css). A supporter's row is their card in
// small: its background and frame, their card effect behind the name, the name in their colour, effect and font, their
// avatar decoration, and the spectrum in their colours. Everyone else gets the plain plate and their slot colour.
//
// Custom CSS: #voice-hud, .vh-row[data-slot], .vh-row.self, .vh-row.vh-card, .vh-graph, .vh-line.

import type { RosterCard } from "../net/protocol";
import { nameColorHex, type PlayerMarks } from "../creators";
import { h } from "../ui/dom";
import { avatarImg, pictureOf } from "../ui/avatar";
import { decorated } from "../ui/avatar-deco";
import { cardLayers, SUPPORTER_FX } from "../ui/card-fx";
import { icon } from "../ui/icons";
import { nameAttrs } from "../ui/marks";
import "./voice.css";

export interface TalkerView {
  /** Stable key (slot, or "self"). */
  key: string;
  slot: number;
  name: string;
  color: string;
  id?: string;
  avatarUrl?: string | null;
  self?: boolean;
  /** Muted by you (shown dimmed, no graph: you hear nothing). */
  mutedByYou?: boolean;
  /** Live level 0..1, read every graph step. */
  level: () => number;
  /**
   * The frequency bands of what's audible now into `out` (8 to 16 bands, 0..1, low to high; voice/spectrum.ts); false
   * (zeros) while silent. Computed when called, from the frame playing (or your latest microphone frame): call it only
   * while drawing, about 30 times a second.
   */
  bands: (out: Float32Array) => boolean;
  /** How the talker's card looks, from the room's roster (no fetch): a supporter's row can take their card. */
  look: TalkerLook;
}

/** The roster's looks for a talker row: name colour, effect and font, avatar decoration, the card's layers. */
export type TalkerLook = Pick<PlayerMarks, "supporter" | "nameColor" | "nameEffect" | "nameColor2" | "nameFont" | "avatarDeco"> & { card?: RosterCard | null };

/** Spectrum: BARS frequency bands, redrawn every STEP_MS; a bar rises at once and falls by FALL a step. */
const STEP_MS = 33;
const BARS = 12;
const FALL = 0.72;
const MAX_ROWS = 5;

interface Row {
  view: TalkerView;
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  /** What is drawn (eased), and where bands() writes. */
  bars: Float32Array;
  raw: Float32Array;
  /** The spectrum's colours, low to high. */
  tint: [string, string];
}

export class VoiceHud {
  readonly el = h("div#voice-hud", { "aria-live": "off" });
  private list = h("div.vh-list");
  private line = h("div.vh-line", { hidden: true });
  private rows = new Map<string, Row>();
  private timer = 0;
  onRowClick: ((view: TalkerView, el: HTMLElement) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.el.append(this.list, this.line);
    parent.append(this.el);
  }

  /** The people talking now (yours first when you transmit). */
  set(views: TalkerView[]): void {
    const keep = new Set(views.slice(0, MAX_ROWS).map((v) => v.key));
    for (const [k, r] of this.rows) if (!keep.has(k)) (r.el.remove(), this.rows.delete(k));
    let prev: HTMLElement | null = null;
    for (const v of views.slice(0, MAX_ROWS)) {
      let r = this.rows.get(v.key);
      if (!r) {
        r = this.row(v);
        this.rows.set(v.key, r);
      } else if (r.view.mutedByYou !== v.mutedByYou || r.view.name !== v.name) {
        r.el.classList.toggle("muted", !!v.mutedByYou);
        r.el.querySelector(".vh-name")!.textContent = v.name;
      }
      r.view = v;
      // In order: yours first, then by when they started.
      const want: Element | null = prev ? prev.nextElementSibling : this.list.firstElementChild;
      if (want !== r.el) this.list.insertBefore(r.el, want);
      prev = r.el;
    }
    this.el.classList.toggle("on", this.rows.size > 0 || !this.line.hidden);
    if (this.rows.size && !this.timer) this.timer = window.setInterval(() => this.step(), STEP_MS);
    else if (!this.rows.size && this.timer) (clearInterval(this.timer), (this.timer = 0));
  }

  /** A plain line under the list (null hides it): "You need an account to talk." */
  say(text: string | null): void {
    this.line.hidden = !text;
    this.line.textContent = text ?? "";
    this.el.classList.toggle("on", this.rows.size > 0 || !!text);
  }

  get talking(): string[] {
    return [...this.rows.keys()];
  }

  dispose(): void {
    clearInterval(this.timer);
    this.el.remove();
  }

  private row(v: TalkerView): Row {
    const letter = () => h("span.vh-av.letter", { style: `background:${v.color}` }, (v.name[0] ?? "?").toUpperCase());
    const url = pictureOf({ id: v.id ?? null, avatarUrl: v.avatarUrl ?? null });
    const canvas = h("canvas.vh-graph", { width: 72, height: 22, "aria-hidden": "true" }) as HTMLCanvasElement;
    const avatar = url ? avatarImg(url, { cls: "vh-av", px: 32, letter, eager: true }) : letter();
    // A supporter's row is their card in small; everyone else's is the plain plate.
    const k = v.look;
    const card = k.supporter ? k.card ?? {} : null;
    const frame = (card?.frame ?? "frame-plain").replace(/^frame-/, "");
    const bg = (card?.background ?? "bg-night").replace(/^bg-/, "");
    const fx = card?.effect ? cardLayers(null, { cardEffect: card.effect, nameColor: k.nameColor }) : null;
    const c1 = nameColorHex(k.nameColor) ?? SUPPORTER_FX;
    const tint: [string, string] = card ? [c1, nameColorHex(k.nameColor2) ?? "#ffffff"] : v.self ? ["#ffffff", "#ffffff"] : [v.color, v.color];
    const el = h(
      `div.vh-row${v.self ? ".self" : ""}${v.mutedByYou ? ".muted" : ""}${card ? `.vh-card.pc-frame-${frame}.pc-bg-${bg}` : ""}`,
      { "data-slot": String(v.slot), style: [`--vc:${v.color}`, fx?.style].filter(Boolean).join(";") },
      card ? h("span.vh-plate", { "aria-hidden": "true" }, ...(fx?.inner ?? [])) : null,
      card ? decorated(avatar, k, { animate: true }) : avatar,
      h("span.vh-name", card ? nameAttrs(k, undefined, v.name) : null, v.name),
      v.self ? icon("mic", { cls: "vh-mic" }) : null,
      canvas,
    );
    el.addEventListener("click", () => this.onRowClick?.(this.rows.get(v.key)?.view ?? v, el));
    const r: Row = { view: v, el, canvas, bars: new Float32Array(BARS), raw: new Float32Array(BARS), tint };
    this.draw(r);
    return r;
  }

  private step(): void {
    // Nothing to draw while the page or the HUD is hidden (hide-UI bind, menus over it).
    if (document.hidden || !this.el.checkVisibility?.()) return;
    for (const r of this.rows.values()) {
      const live = !r.view.mutedByYou && r.view.bands(r.raw);
      for (let i = 0; i < BARS; i++) r.bars[i] = Math.max(live ? Math.min(1, r.raw[i]) : 0, r.bars[i] * FALL);
      this.draw(r);
    }
  }

  /** The spectrum: bars mirrored around the middle line, low notes on the left, in the row's colours. */
  private draw(r: Row): void {
    const c = r.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth || 72;
    const hh = c.clientHeight || 22;
    if (c.width !== Math.round(w * dpr)) (c.width = Math.round(w * dpr)), (c.height = Math.round(hh * dpr));
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    const bw = w / BARS;
    const mid = hh / 2;
    const paint = g.createLinearGradient(0, 0, w, 0);
    paint.addColorStop(0, r.tint[0]);
    paint.addColorStop(1, r.tint[1]);
    g.fillStyle = paint;
    const wide = Math.max(1.5, bw - 2);
    for (let i = 0; i < BARS; i++) {
      // A floor so silence still reads as a line, and a curve so speech fills the height.
      const half = Math.max(1, Math.pow(r.bars[i], 0.65) * mid);
      g.beginPath();
      g.roundRect(i * bw + 1, mid - half, wide, half * 2, Math.min(wide / 2, 1.5));
      g.fill();
    }
  }
}

/** The speaker mark drawn next to a talking player's name (name tags, spectator line, scoreboards). */
export function speakerMark(): HTMLElement {
  return h("span.voice-mark", { title: "Talking" }, icon("audio"));
}
