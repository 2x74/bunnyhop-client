// HUD layout editor: drag elements anywhere, resize from the corner handle, snap to a grid and the
// screen centre lines, nudge with the arrow keys, toggle elements, apply presets, reset, and
// export/import the layout as a short string. Opened from Settings → HUD → "Edit layout" or the
// hudEditor bind (default F2). Changes preview live and are saved to prefs on release.
//
// Its controls are a slim bar (presets, Elements, More, Done) so the HUD it edits stays in view. The element list and
// the rest (HUD scale, snap, the layout code, the keys) are two panels of Settings rows that open from the bar.
//
// Nothing of the editor may be in a piece's way. A dragged piece is held exactly under the pointer (hud.ts places it in
// CSS px while it is held; its stored place is worked out from that box on every move). The bar takes whichever edge,
// top or bottom, is clear of the piece being dragged or selected and covers the fewest others (layout.ts barSide), so
// a piece under the bar is freed by picking it (the Elements list, Tab) or by dragging another piece there. An open
// panel closes when a drag starts and when the piece picked from it sits underneath it. The selected piece is drawn
// over the others, so one that another piece covers can be grabbed once it is picked.

import { takeFreeCursor } from "../free-cursor";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { keyLabel, prefs } from "../ui/settings";
import { range, row, toggle } from "../ui/controls";
import { anchorX, anchorY, barSide, clampScale, dragBox, presetLayout, decodeLayout, encodeLayout, HUD_ELEMENTS, HUD_SCALE, placeFromRect, PRESETS, remFraction, sameLayout, unzoomPlace, type Box, type HudElId, type HudLayout, type HudPlace } from "./layout";

export interface EditorHost {
  root: HTMLElement;
  els: Record<HudElId, HTMLElement>;
  /**
   * Applies a place to an element's DOM without saving (live drag preview). `at`: the element's top-left corner in CSS
   * px while the pointer holds it there (a move; a resize has none).
   */
  preview(id: HudElId, p: HudPlace, at?: { left: number; top: number }): void;
  /** Called when edit mode starts / ends (the HUD swaps in demo content while editing). */
  setEditing(on: boolean): void;
}

// --- tiny bus so the settings panel can open the editor without importing the HUD instance ---
let opener: (() => void) | null = null;
/** Window event fired when the editor closes (the settings panel re-reads the layout). */
export const EDITOR_CLOSED = "bunnyhop:hud-editor-closed";
export const hudEditorAvailable = () => !!opener;
export function openHudEditor(): boolean {
  opener?.();
  return !!opener;
}

const ANCHOR_NAMES = ["top-left", "top", "top-right", "left", "centre", "right", "bottom-left", "bottom", "bottom-right"];
/** Where an element sits, for its row's tooltip. */
const placeReadout = (p: HudPlace): string => `Anchored ${ANCHOR_NAMES[p.a]}, x ${(p.x * 100).toFixed(1)}%, y ${(p.y * 100).toFixed(1)}%, size ${Math.round(p.s * 100)}%`;
/** The keys the bar's two sentences leave out (the More panel lists them). */
const KEYS: [string, string][] = [
  ["Nudge the selected piece", "Arrow keys"],
  ["Nudge it 10 pixels", "Shift + arrow keys"],
  ["Resize it", "+ and −, or the wheel"],
  ["Hide or show it", "H"],
  ["Pick the next piece", "Tab"],
  ["Drag without snapping", "Hold Alt"],
];

export class HudEditor {
  active = false;
  private selected: HudElId | null = null;
  private bar: HTMLElement | null = null;
  private grid: HTMLElement;
  private guideV: HTMLElement;
  private guideH: HTMLElement;
  private rows = new Map<HudElId, { row: HTMLElement; sw: HTMLInputElement }>();
  private presetBtns = new Map<string, HTMLButtonElement>();
  /** The panel showing under the bar, if any, and what closes it. */
  private panel: { el: HTMLElement; hide: () => void } | null = null;
  private snap = true;
  private relock = false;
  private drag: { id: HudElId; mode: "move" | "resize"; x0: number; y0: number; r0: DOMRect; p0: HudPlace; pid: number; cur: HudPlace } | null = null;

  constructor(private host: EditorHost) {
    this.grid = h("div.hud-grid", { "aria-hidden": "true" });
    this.guideV = h("div.hud-guide.v", { "aria-hidden": "true" });
    this.guideH = h("div.hud-guide.h", { "aria-hidden": "true" });
    opener = () => this.toggle();
    addEventListener("keydown", (e) => this.onKey(e), true);
    host.root.addEventListener("pointerdown", (e) => this.onDown(e));
    host.root.addEventListener("pointermove", (e) => this.onMove(e));
    host.root.addEventListener("pointerup", (e) => this.onUp(e));
    host.root.addEventListener("pointercancel", (e) => this.onUp(e));
    host.root.addEventListener(
      "wheel",
      (e) => {
        if (!this.active) return;
        const el = (e.target as HTMLElement).closest<HTMLElement>(".hud-el");
        if (!el) return;
        e.preventDefault();
        this.select(el.dataset.el as HudElId);
        this.rescale(e.deltaY < 0 ? 0.05 : -0.05);
      },
      { passive: false },
    );
  }

  private get layout(): HudLayout {
    return prefs.get().hud.layout;
  }

  /** `way`: false from the element list's own switches, which must not move the list from under the pointer. */
  private commit(fn: (l: HudLayout) => void, way = true): void {
    prefs.update((p) => fn(p.hud.layout));
    this.paint();
    if (way) this.makeWay();
  }

  toggle(): void {
    if (this.active) this.close();
    else this.open();
  }

  open(): void {
    if (this.active) return;
    this.active = true;
    this.relock = !!document.pointerLockElement || takeFreeCursor();
    if (document.pointerLockElement) document.exitPointerLock();
    document.body.classList.add("hud-editing");
    this.host.root.classList.add("editing");
    this.host.root.prepend(this.grid, this.guideV, this.guideH);
    this.bar = this.buildBar();
    document.body.append(this.bar);
    this.host.setEditing(true);
    this.select(this.selected ?? "speed");
  }

  /** The box of a piece as it shows now, or null when it shows nothing (switched off and not the selected one). */
  private boxOf(id: HudElId): Box | null {
    const r = this.host.els[id].getBoundingClientRect();
    return r.width && r.height ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
  }

  /**
   * Keeps the editor out of the selected piece's way: the bar goes to the edge that is clear of `must` (the selected
   * piece; while dragging, the held box and the pointer) and covers the fewest other pieces. An open panel closes when
   * the bar moves, or when the piece sits under it.
   */
  private makeWay(must: Box[] | null = null): void {
    const bar = this.bar;
    if (!bar) return;
    const sel = this.selected ? this.boxOf(this.selected) : null;
    must ??= sel ? [sel] : [];
    const b = bar.getBoundingClientRect();
    const others = HUD_ELEMENTS.filter(({ id }) => id !== this.selected && this.layout[id].on).flatMap(({ id }) => this.boxOf(id) ?? []);
    const now = bar.classList.contains("bottom") ? "bottom" : "top";
    const side = barSide(now, { left: b.left, top: b.top, width: b.width, height: b.height }, innerHeight, must, others);
    bar.classList.toggle("bottom", side === "bottom");
    if (!this.panel) return;
    const p = this.panel.el.getBoundingClientRect();
    if (side !== now || must.some((m) => m.left < p.right && m.left + m.width > p.left && m.top < p.bottom && m.top + m.height > p.top)) this.panel.hide();
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    this.drag = null;
    document.body.classList.remove("hud-editing");
    this.host.root.classList.remove("editing");
    this.grid.remove();
    this.guideV.remove();
    this.guideH.remove();
    this.bar?.remove();
    this.bar = null;
    this.panel = null;
    for (const el of Object.values(this.host.els)) el.classList.remove("sel");
    this.host.setEditing(false);
    dispatchEvent(new CustomEvent(EDITOR_CLOSED));
    if (this.relock) {
      this.relock = false;
      const c = document.getElementById("game") as HTMLCanvasElement | null;
      // Needs the Done click / key press's user activation; if refused the pause menu shows as usual.
      void c?.requestPointerLock?.()?.catch?.(() => {});
    }
  }

  // -------------------------------------------------------------------------------------------
  // Toolbar

  private buildBar(): HTMLElement {
    this.rows.clear();
    this.presetBtns.clear();
    const presets = h("div.seg", { role: "group", "aria-label": "Layout presets" });
    for (const p of PRESETS) {
      const b = h("button", { type: "button", onclick: () => this.commit((l) => Object.assign(l, presetLayout(p.layout, l))) }, p.label);
      this.presetBtns.set(p.id, b);
      presets.append(b);
    }

    // The element list: Settings rows in two columns (all of them in view at once, with the lower HUD still showing). A
    // row's name selects the element, its switch shows or hides it.
    const list = h("div.he-panel.he-list.quick-set", { role: "group", "aria-label": "HUD elements", hidden: true });
    list.style.setProperty("--he-rows", String(Math.ceil(HUD_ELEMENTS.length / 2)));
    for (const { id, label: l } of HUD_ELEMENTS) {
      const sw = h("input.switch.sm", { type: "checkbox", role: "switch", "aria-label": `Show ${l}` });
      sw.addEventListener("change", () => {
        this.selected = id;
        this.commit((l) => (l[id].on = sw.checked), false);
        sw.blur(); // the editor's keys (arrows, H) work again at once
      });
      const r = h("div.set-row.compact", null, h("button.he-name", { type: "button", onclick: () => this.select(id) }, l), h("div.set-control", null, sw));
      this.rows.set(id, { row: r, sw });
      list.append(r);
    }

    const bar = h("div#hud-edit-bar", { role: "dialog", "aria-label": "HUD layout editor" });
    const more = h("div.he-panel.he-more.quick-set", { hidden: true }, ...this.moreRows());
    const opener = (text: string, cls: string, panel: HTMLElement) => {
      const b = h(`button.btn.btn-sm.${cls}`, { type: "button", "aria-expanded": "false" }, text, icon("chevronRight", { size: "0.9em" }));
      const hide = () => {
        panel.hidden = true;
        b.setAttribute("aria-expanded", "false");
        if (this.panel?.hide === hide) this.panel = null;
      };
      b.addEventListener("click", () => {
        const open = panel.hidden;
        this.panel?.hide();
        if (!open) return;
        panel.hidden = false;
        b.setAttribute("aria-expanded", "true");
        this.panel = { el: panel, hide };
        if (panel === list && this.selected) this.rows.get(this.selected)?.row.scrollIntoView({ block: "nearest" });
      });
      return b;
    };
    const bind = prefs.get().binds.hudEditor[0];
    bar.append(
      h(
        "div.he-main",
        null,
        presets,
        opener("Elements", "he-open-list", list),
        opener("More", "he-open-more", more),
        h("button.btn.btn-sm.primary.he-done", { type: "button", onclick: () => this.close() }, `Done${bind ? ` (${keyLabel(bind)})` : ""}`),
      ),
      h("p.he-hint", null, "Drag a piece to move it, or its corner to resize it. The arrow keys nudge the selected piece and H hides it."),
      list,
      more,
    );
    return bar;
  }

  /** The More panel: the settings that go with the layout, then the keys the bar's two sentences leave out. */
  private moreRows(): HTMLElement[] {
    const code = h("input.text-input.share-code", { type: "text", placeholder: "bhl1.…", "aria-label": "Layout code", spellcheck: "false" });
    const flash = (b: HTMLElement, t: string) => {
      const was = b.textContent;
      b.textContent = t;
      setTimeout(() => (b.textContent = was), 1500);
    };
    const exportBtn = h("button.btn.btn-sm", { type: "button" }, "Export");
    exportBtn.addEventListener("click", () => {
      const p = prefs.get().hud;
      code.value = encodeLayout(p.layout, p.keys);
      code.select();
      void navigator.clipboard?.writeText(code.value).then(
        () => flash(exportBtn, "Copied"),
        () => flash(exportBtn, "Select + copy"),
      );
    });
    const importBtn = h("button.btn.btn-sm", { type: "button" }, "Import");
    importBtn.addEventListener("click", () => {
      const r = decodeLayout(code.value);
      if (!r) return flash(importBtn, "Not a code");
      prefs.update((p) => {
        p.hud.layout = r.layout;
        p.hud.keys = r.keys;
      });
      this.paint();
      this.makeWay();
    });
    return [
      range("HUD scale", () => prefs.get().hud.scale, (v) => prefs.update((p) => (p.hud.scale = v)), { ...HUD_SCALE, scale: 100, unit: "%" }),
      toggle("Snap to the grid", () => this.snap, (v) => (this.snap = v)),
      row("Layout code", h("div.share-row", null, code, exportBtn, importBtn)),
      h("table.keys-table", null, h("tbody", null, ...KEYS.map(([what, key]) => h("tr", null, h("th", null, what), h("td", null, key))))),
    ];
  }

  private paint(): void {
    const l = this.layout;
    for (const [id, { row: r, sw }] of this.rows) {
      sw.checked = l[id].on;
      r.classList.toggle("sel", id === this.selected);
      r.title = placeReadout(l[id]);
    }
    for (const p of PRESETS) {
      const on = sameLayout(l, p.layout);
      const b = this.presetBtns.get(p.id);
      b?.classList.toggle("on", on);
      b?.setAttribute("aria-pressed", String(on));
    }
    for (const [id, el] of Object.entries(this.host.els) as [HudElId, HTMLElement][]) el.classList.toggle("sel", id === this.selected);
  }

  private select(id: HudElId): void {
    this.selected = id;
    this.paint();
    this.makeWay();
    const r = this.rows.get(id)?.row;
    if (r && r.offsetParent) r.scrollIntoView({ block: "nearest" });
  }

  private setOn(id: HudElId, on: boolean): void {
    this.commit((l) => (l[id].on = on));
  }

  private rescale(d: number): void {
    const id = this.selected;
    if (id) this.commit((l) => (l[id].s = clampScale(l[id].s + d)));
  }

  private nudge(dx: number, dy: number): void {
    const id = this.selected;
    if (!id) return;
    const r = this.host.els[id].getBoundingClientRect();
    const b = dragBox({ left: r.left + dx, top: r.top + dy, width: r.width, height: r.height }, innerWidth, innerHeight, false);
    const p = this.fromRect(id, { left: b.left, top: b.top, width: r.width, height: r.height }, this.layout[id]);
    this.commit((l) => (l[id] = p));
  }

  /** The stored place for an element shown at `r` (CSS px) at the current HUD scale. */
  private fromRect(id: HudElId, r: { left: number; top: number; width: number; height: number }, prev: HudPlace): HudPlace {
    return unzoomPlace(this.layout, id, placeFromRect(r, innerWidth, innerHeight, prev), prefs.get().hud.scale, remFraction(innerWidth, innerHeight));
  }

  // -------------------------------------------------------------------------------------------
  // Pointer + keys

  private onDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return;
    const t = e.target as HTMLElement;
    const el = t.closest<HTMLElement>(".hud-el");
    if (!el) return;
    e.preventDefault();
    const id = el.dataset.el as HudElId;
    this.panel?.hide(); // arranging now: the list would only be in the way
    this.select(id);
    el.setPointerCapture(e.pointerId);
    const p0 = { ...this.layout[id] };
    this.drag = { id, mode: t.classList.contains("hud-handle") ? "resize" : "move", x0: e.clientX, y0: e.clientY, r0: el.getBoundingClientRect(), p0, pid: e.pointerId, cur: p0 };
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pid) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    const vw = innerWidth;
    const vh = innerHeight;
    if (d.mode === "resize") {
      // Grow/shrink with the handle's distance from the element's anchor point.
      const ax = d.r0.left + anchorX(d.p0.a) * d.r0.width;
      const ay = d.r0.top + anchorY(d.p0.a) * d.r0.height;
      const d0 = Math.hypot(d.x0 - ax, d.y0 - ay) || 1;
      const s = clampScale(d.p0.s * (Math.hypot(e.clientX - ax, e.clientY - ay) / d0));
      d.cur = { ...d.p0, s };
      this.host.preview(d.id, d.cur);
      return;
    }
    const w = d.r0.width;
    const hh = d.r0.height;
    const at = dragBox({ left: d.r0.left + dx, top: d.r0.top + dy, width: w, height: hh }, vw, vh, this.snap && !e.altKey);
    this.guideV.classList.toggle("show", at.centreV);
    this.guideH.classList.toggle("show", at.centreH);
    const box = { left: at.left, top: at.top, width: w, height: hh };
    d.cur = this.fromRect(d.id, box, d.p0);
    this.host.preview(d.id, d.cur, at);
    this.makeWay([box, { left: e.clientX, top: e.clientY, width: 0, height: 0 }]);
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pid) return;
    this.drag = null;
    this.guideV.classList.remove("show");
    this.guideH.classList.remove("show");
    const cur = d.cur;
    this.commit((l) => (l[d.id] = cur));
  }

  private onKey(e: KeyboardEvent): void {
    const bind = prefs.get().binds.hudEditor;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    if (!this.active) {
      // Open from anywhere a HUD exists (in game, paused, watching). Not while typing or rebinding.
      // Not under a modal dialog (feedback form, account panel) either.
      if (bind.includes(e.code) && !typing && !e.repeat && document.body.classList.contains("in-game") && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.open();
      }
      return;
    }
    if (typing && e.key !== "Escape") return;
    const step = e.shiftKey ? 10 : 1;
    const ids = HUD_ELEMENTS.map((x) => x.id);
    switch (e.key) {
      case "Escape":
      case "Enter":
        if (typing) (t as HTMLElement).blur();
        else if (e.key === "Escape" && this.panel) this.panel.hide();
        else this.close();
        break;
      case "ArrowLeft":
        this.nudge(-step, 0);
        break;
      case "ArrowRight":
        this.nudge(step, 0);
        break;
      case "ArrowUp":
        this.nudge(0, -step);
        break;
      case "ArrowDown":
        this.nudge(0, step);
        break;
      case "+":
      case "=":
        this.rescale(0.05);
        break;
      case "-":
      case "_":
        this.rescale(-0.05);
        break;
      case "h":
      case "H":
      case "Delete":
        if (this.selected) this.setOn(this.selected, !this.layout[this.selected].on);
        break;
      case "Tab": {
        const i = this.selected ? ids.indexOf(this.selected) : -1;
        this.select(ids[(i + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
        break;
      }
      default:
        if (bind.includes(e.code)) this.close();
        else return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}
