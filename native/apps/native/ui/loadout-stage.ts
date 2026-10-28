// Browser-safe palette/shape previews for the native menu. The equipped model is rendered by the native game.
// This canvas intentionally uses only the 2D context; importing a model or Three here breaks the menu boundary.
import authored from "./authored-previews.json";
import { cosmetic } from "../../web/src/progression";
import { packLoadout, type CosmeticLoadout } from "../../web/src/loadout";
import { requestPreview, cancelPreview, nativePreviewAvailable } from "./loadout-preview";
import type { PreviewSpec } from "../../web/src/notify/item-preview";
import type { PlayerGlow } from "../../web/src/player/glow-config";
export type StageView = "fp" | "close" | "bunny" | "ghost";
export interface StageLook {
  outfit?: string | null;
  ghost?: string | null;
  trail?: string | null;
  veil?: boolean;
  playerGlow?: PlayerGlow | null;
  previewGlow?: boolean;
}
export type ThumbJob =
  | { key: string; kind: "knife"; knife: string; loadout: CosmeticLoadout }
  | { key: string; kind: "glove"; loadout: CosmeticLoadout }
  | { key: string; kind: "item"; spec: PreviewSpec; scene?: unknown };
export const THUMB_W = 384,
  THUMB_H = 240;
const CLOSE_UP_ZOOM = 1.3;
const thumbs = new Map<string, HTMLCanvasElement>();
const color = (id: string | undefined | null, fallback: string) => cosmetic(id)?.color ?? fallback;
const name = (id: string | undefined | null, fallback: string) => cosmetic(id)?.name ?? fallback;
const paintRevisions = new WeakMap<HTMLCanvasElement, number>();
const nativeImages = new Map<string, HTMLImageElement>();
function imageFor(id: string): HTMLImageElement | null {
  const src = (authored.images as Record<string, string>)[id];
  if (!src) return null;
  let image = nativeImages.get(id);
  if (!image) {
    image = new Image();
    image.src = src;
    nativeImages.set(id, image);
  }
  return image;
}
function previewId(spec: PreviewSpec): string {
  if (spec.kind === "bunny") return spec.body === "body-b" ? "body-b" : (spec.outfit ?? "outfit-cream");
  if (spec.kind === "ghost") return spec.key.startsWith("ghost-") ? spec.key : (spec.outfit ?? "outfit-cream");
  if (spec.kind === "hat") return spec.hat ?? "";
  if (spec.kind === "glove") return spec.glove ?? "glove-knit";
  if (spec.kind === "knife")
    return spec.knife === "knife-carrot" && spec.finish && spec.finish !== "fin-garden"
      ? spec.finish
      : (spec.knife ?? "knife-carrot");
  return spec.key;
}
// (No caption drawn in: the grid tile names its item under the picture, and the stage has its own caption.)
/** `zoom` frames the sample closer (the stage's Close-up view); the canvas crops what no longer fits. */
function paint(canvas: HTMLCanvasElement, spec: PreviewSpec, hero = false, zoom = 1): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const revision = (paintRevisions.get(canvas) ?? 0) + 1;
  paintRevisions.set(canvas, revision);
  canvas.width = hero ? 768 : THUMB_W;
  canvas.height = hero ? 480 : THUMB_H;
  const draw = () => {
    if (paintRevisions.get(canvas) !== revision) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const w = canvas.width,
      h = canvas.height;
    // The stage's own lit background (loadout-view.css, per view / rarity / supporter set) shows through the hero; tiles get a backdrop.
    if (!hero) {
      const background = ctx.createRadialGradient(w * 0.5, h * 0.4, 0, w * 0.5, h * 0.4, w * 0.6);
      background.addColorStop(0, "#27303c");
      background.addColorStop(1, "#111720");
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);
    }
    const id = previewId(spec),
      image = imageFor(id);
    if (image?.complete && image.naturalWidth) {
      const scale = Math.min((w * 0.83) / image.naturalWidth, (h * 0.84) / image.naturalHeight) * zoom;
      ctx.drawImage(
        image,
        (w - image.naturalWidth * scale) / 2,
        (h - image.naturalHeight * scale) / 2,
        image.naturalWidth * scale,
        image.naturalHeight * scale,
      );
      if (hero && spec.kind === "knife" && spec.finish && spec.finish !== "fin-garden" && id !== spec.finish) {
        const sample = imageFor(spec.finish);
        if (sample?.complete && sample.naturalWidth) {
          const size = Math.min((w * 0.28) / sample.naturalWidth, (h * 0.3) / sample.naturalHeight);
          ctx.fillStyle = "#121922dd";
          ctx.fillRect(w * 0.69, h * 0.66, w * 0.29, h * 0.32);
          ctx.drawImage(sample, w * 0.7, h * 0.67, sample.naturalWidth * size, sample.naturalHeight * size);
        }
      }
    } else {
      const colors = [
        spec.color ?? color(spec.finish, "#ff8b45"),
        color(spec.outfit, "#eee1c8"),
        spec.color2 ?? color(spec.glove, "#73849a"),
      ];
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = colors[i];
        ctx.fillRect(w * (0.24 + i * 0.18), h * 0.3, w * 0.16, h * 0.35);
      }
    }
  };
  draw();
  const ids = [previewId(spec), spec.finish ?? ""];
  for (const id of ids) {
    const image = imageFor(id);
    if (image && !image.complete) image.addEventListener("load", draw, { once: true });
  }
}

export class LoadoutStage {
  readonly canvas = document.createElement("canvas");
  onView: ((view: StageView) => void) | null = null;
  private received = 0;
  private animateUntil = 0;
  private yaw = 0;
  private pitch = 0;
  private inspectCount = 0;
  private held = false;
  private frame = 0;
  private active = false;
  private request = 0;
  private host: HTMLElement;
  private note: HTMLElement;
  private shown: CosmeticLoadout;
  private look: StageLook = {};
  private viewMode: StageView = "fp";
  private disposed = false;
  static acquire(host: HTMLElement, initial: CosmeticLoadout): LoadoutStage {
    return new LoadoutStage(host, initial);
  }
  static cached(key: string): HTMLCanvasElement | null {
    return thumbs.get(key) ?? null;
  }
  constructor(host: HTMLElement, initial: CosmeticLoadout) {
    this.host = host;
    this.shown = { ...initial };
    this.canvas.className = "lo-canvas native-loadout-preview";
    host.dataset.nativeStatic = "true";
    if (nativePreviewAvailable()) host.dataset.nativeHost = "true";
    this.canvas.setAttribute("role", "img");
    host.append(this.canvas);
    const note = document.createElement("p");
    note.className = "native-loadout-preview-note";
    note.textContent = "Native-rendered item samples · combinations shown in game";
    host.append(note);
    this.note = note;
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener("pointerdown", this.down);
    this.canvas.addEventListener("pointermove", this.move);
    this.canvas.addEventListener("pointerup", this.up);
    this.canvas.addEventListener("pointercancel", this.up);
    this.canvas.addEventListener("keydown", this.key);
    this.draw();
  }
  get view(): StageView {
    return this.viewMode;
  }
  display(loadout: CosmeticLoadout, look: StageLook = {}): void {
    this.shown = { ...loadout };
    this.look = { ...look };
    this.draw();
  }
  setView(view: StageView): void {
    this.viewMode = view;
    this.draw();
    this.onView?.(view);
  }
  private draw(): void {
    if (this.disposed) return;
    this.renderNative();
    const slot = this.canvas.closest(".lo")?.querySelector<HTMLElement>(".lo-tab.on")?.dataset.slot;
    const character = this.viewMode === "bunny" || this.viewMode === "ghost";
    let spec: PreviewSpec = {
      kind: this.viewMode === "ghost" ? "ghost" : character ? "bunny" : "knife",
      key: this.look.ghost ?? "stage",
      knife: this.shown.knife,
      finish: this.shown.finish,
      glove: this.shown.glove,
      body: this.shown.body,
      outfit: this.look.outfit ?? undefined,
      hat: this.shown.hat,
      color: this.viewMode === "ghost" ? color(this.look.ghost, "#ffc23d") : undefined,
      color2: this.viewMode === "ghost" ? cosmetic(this.look.ghost)?.color2 : undefined,
      veil: this.look.veil,
    };
    if (slot === "glove") spec = { ...spec, kind: "glove" };
    if (slot === "hat") spec = { ...spec, kind: "hat" };
    if (slot === "finish") spec = { ...spec, kind: "knife", knife: "knife-carrot" };
    const label =
      slot === "glove"
        ? name(this.shown.glove, "Gloves")
        : slot === "hat"
          ? name(this.shown.hat, "Hat")
          : character
            ? name(this.look.outfit, "Bunny")
            : name(this.shown.knife, "Knife") + " · " + name(this.shown.finish, "Finish");
    this.canvas.setAttribute("aria-label", label + " authored native-rendered item preview");
    // Close-up (web loadout-view.ts, the hands' categories): the same sample, framed closer.
    const zoom = this.viewMode === "close" && !character ? CLOSE_UP_ZOOM : 1;
    paint(this.canvas, spec, true, zoom);
  }
  private drag: { id: number; x: number; y: number } | null = null;
  private down = (e: PointerEvent) => {
    if (!nativePreviewAvailable() || e.button !== 0) return;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  private move = (e: PointerEvent) => {
    if (this.drag?.id !== e.pointerId) return;
    this.yaw += (e.clientX - this.drag.x) * 0.55;
    this.pitch = Math.max(-45, Math.min(45, this.pitch + (e.clientY - this.drag.y) * 0.35));
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.renderNative();
  };
  private up = (e: PointerEvent) => {
    if (this.drag?.id === e.pointerId) this.drag = null;
  };
  private key = (e: KeyboardEvent) => {
    if (!nativePreviewAvailable() || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(e.key))
      return;
    e.preventDefault();
    if (e.key === "Home") this.yaw = this.pitch = 0;
    else if (e.key === "ArrowLeft") this.yaw -= 10;
    else if (e.key === "ArrowRight") this.yaw += 10;
    else this.pitch = Math.max(-45, Math.min(45, this.pitch + (e.key === "ArrowUp" ? -5 : 5)));
    this.renderNative();
  };
  private renderNative(): void {
    if (this.disposed || !nativePreviewAvailable() || !this.canvas.isConnected || document.hidden) return;
    if (this.request) {
      this.active = true;
      return;
    }
    this.active = false;
    const id = requestPreview(
      {
        loadout: packLoadout(this.shown),
        outfit: this.look.outfit ?? "outfit-cream",
        ghost: this.look.ghost ?? "ghost-gold",
        playerGlow: this.look.playerGlow ?? null,
        view: this.viewMode,
        yaw: this.yaw,
        pitch: this.pitch,
        inspect: this.inspectCount,
        held: this.held,
        width: Math.min(960, Math.max(384, Math.round(this.canvas.clientWidth * (devicePixelRatio || 1)))),
        height: Math.min(600, Math.max(240, Math.round(this.canvas.clientHeight * (devicePixelRatio || 1)))),
      },
      (png) => {
        this.request = 0;
        if (this.disposed) return;
        if (png) {
          const received = ++this.received;
          const image = new Image();
          image.onload = () => {
            if (this.disposed || received !== this.received) return;
            this.canvas.width = image.naturalWidth;
            this.canvas.height = image.naturalHeight;
            this.canvas.getContext("2d")?.drawImage(image, 0, 0);
            this.host.dataset.nativeStatic = "false";
            this.host.dataset.nativeInteractive = "true";
            this.note.textContent = "Native live preview · drag or use arrow keys to turn";
          };
          image.src = png;
        }
        if (this.active || this.held || performance.now() < this.animateUntil) {
          this.frame = window.setTimeout(() => this.renderNative(), 66);
        }
      },
    );
    this.request = id;
  }
  inspect(): void {
    this.animateUntil = performance.now() + 8000;
    this.inspectCount++;
    this.renderNative();
  }
  holdInspect(held: boolean): void {
    this.held = held;
    this.renderNative();
  }
  flourish(_kind: string): void {
    this.inspect();
  }
  tint(color: string | null, _strength = 1): void {
    this.canvas.style.borderColor = color ?? "transparent";
  }
  requestThumb(job: ThumbJob, done: (canvas: HTMLCanvasElement) => void): void {
    if (this.disposed) return;
    let canvas = thumbs.get(job.key);
    if (!canvas) {
      canvas = document.createElement("canvas");
      const spec: PreviewSpec =
        job.kind === "item"
          ? job.spec
          : job.kind === "glove"
            ? { kind: "glove", key: job.key, glove: job.loadout.glove }
            : { kind: "knife", key: job.key, knife: job.knife, finish: job.loadout.finish };
      paint(canvas, spec);
      if (thumbs.size >= 240) thumbs.delete(thumbs.keys().next().value!);
      thumbs.set(job.key, canvas);
    }
    done(canvas);
  }
  cancelThumbs(_keep: (key: string) => boolean): void {
    /* All software thumbnails finish synchronously. */
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.frame);
    cancelPreview(this.request);
    this.canvas.removeEventListener("pointerdown", this.down);
    this.canvas.removeEventListener("pointermove", this.move);
    this.canvas.removeEventListener("pointerup", this.up);
    this.canvas.removeEventListener("pointercancel", this.up);
    this.canvas.removeEventListener("keydown", this.key);
    this.note.remove();
    this.canvas.remove();
  }
}
export function prewarmLoadout(_initial?: CosmeticLoadout, done?: () => void): Promise<void> {
  done?.();
  return Promise.resolve();
}
