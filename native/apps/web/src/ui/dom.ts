// Tiny DOM helpers for the vanilla-TS UI (no framework).

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/** h("button.primary#play", { onclick, disabled }, "Play") */
export function h<K extends keyof HTMLElementTagNameMap>(spec: K | `${K}${"." | "#"}${string}`, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(spec: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement;
export function h(spec: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const m = /^([a-z0-9]+)([.#].*)?$/i.exec(spec)!;
  const el = document.createElement(m[1]);
  for (const part of (m[2] ?? "").match(/[.#][^.#]+/g) ?? []) {
    if (part[0] === ".") el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className += (el.className ? " " : "") + v;
      else if (k === "text") el.textContent = String(v);
      else if (k === "html") el.innerHTML = String(v);
      else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "number" ? String(c) : c);
  }
}

export function clear(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

export const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
/** Two rAFs: guarantees the browser painted DOM changes before a long synchronous task. */
export const afterPaint = async () => {
  await nextFrame();
  await nextFrame();
};

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(n >= 100 << 20 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Arrow-key focus movement inside a list/grid of focusable children. */
export function arrowNav(container: HTMLElement, selector: string, opts: { grid?: boolean } = {}): void {
  container.addEventListener("keydown", (e) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const items = [...container.querySelectorAll<HTMLElement>(selector)].filter((x) => x.offsetParent !== null && !(x as HTMLButtonElement).disabled);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    let cols = 1;
    if (opts.grid && items.length > 1) {
      const top = (x: HTMLElement) => Math.round(x.getBoundingClientRect().top);
      const t0 = top(items[0]);
      cols = items.findIndex((x) => top(x) !== t0);
      if (cols <= 0) cols = items.length;
    }
    let j = i;
    if (e.key === "Home") j = 0;
    else if (e.key === "End") j = items.length - 1;
    else if (opts.grid) {
      if (e.key === "ArrowLeft") j = i - 1;
      else if (e.key === "ArrowRight") j = i + 1;
      else if (e.key === "ArrowUp") j = i - cols;
      else j = i + cols;
    } else {
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") j = i - 1;
      else j = i + 1;
    }
    if (j < 0 || j >= items.length) {
      // Leaving the top of a grid moves focus back up (e.g. to the search box).
      if (j < 0 && (e.key === "ArrowUp" || e.key === "Home")) return;
      j = Math.max(0, Math.min(items.length - 1, j));
    }
    e.preventDefault();
    items[j].focus();
    items[j].scrollIntoView({ block: "nearest" });
  });
}
