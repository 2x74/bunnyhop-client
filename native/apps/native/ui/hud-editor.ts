import { h } from "../../web/src/ui/dom";
import { HUD_ELEMENTS, defaultPosition, type HudElementId, type HudLayout, type HudPosition } from "./hud-layout";

// The native HUD's placement canvas (Settings → HUD → Advanced → Positions): the game frame in the look of the
// website's "Show on screen" picture, with each element where the native HUD draws it, in percent of the screen.

/** `start` moved by a drag of dx × dy pixels on a width × height canvas, in tenths of a percent. */
export function dragPosition(start: HudPosition, dx: number, dy: number, width: number, height: number): HudPosition {
  const clamp = (n: number) => Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;
  const x = clamp(start.x + (dx / Math.max(1, width)) * 100);
  const y = clamp(start.y + (dy / Math.max(1, height)) * 100);
  return { ...start, x, y };
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** A canvas to drag the native HUD's elements around; `save` gets the whole layout after each move. */
export function hudEditor(read: () => HudLayout, save: (layout: HudLayout) => void): HTMLElement {
  const aspect = Math.max(1.2, Math.min(2.4, innerWidth / Math.max(1, innerHeight)));
  const frame = h("div.mn-frame", {
    "aria-label": "HUD placement canvas",
    style: `aspect-ratio:${aspect.toFixed(3)};--ar:${aspect.toFixed(3)};touch-action:none`,
  });
  const say = h("p.mn-say", { "aria-hidden": "true" }, "Drag a piece to move it.");
  const at = (id: HudElementId): HudPosition => read()[id] ?? defaultPosition(id);
  const place = (button: HTMLElement, position: HudPosition): void => {
    button.style.left = `${position.x}%`;
    button.style.top = `${position.y}%`;
    button.classList.toggle("on", position.visible !== false);
  };
  const buttons = HUD_ELEMENTS.map((item) => {
    const button = h("button.mn-el.native-place", {
      type: "button",
      "data-id": item.id,
      "aria-label": `Move ${item.label}`,
      style: "translate:-50% -50%;width:auto;height:auto;padding:0.35cqw 0.6cqw",
    }, item.label);
    button.addEventListener("pointerenter", () => (say.textContent = item.label));
    button.addEventListener("pointerdown", (event) => drag(event, button, item.id));
    button.addEventListener("keydown", (event) => nudge(event, button, item.id));
    return button;
  });
  frame.append(...buttons);

  function drag(event: PointerEvent, button: HTMLElement, id: HudElementId): void {
    if (event.button !== 0) return;
    event.preventDefault();
    button.focus();
    const start = at(id);
    const rect = frame.getBoundingClientRect();
    button.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent): void => {
      const dx = next.clientX - event.clientX;
      const dy = next.clientY - event.clientY;
      const position = dragPosition(start, dx, dy, rect.width, rect.height);
      place(button, position);
      save({ ...read(), [id]: position });
    };
    const end = (): void => {
      button.removeEventListener("pointermove", move);
      button.removeEventListener("lostpointercapture", end);
    };
    button.addEventListener("pointermove", move);
    button.addEventListener("lostpointercapture", end);
  }

  function nudge(event: KeyboardEvent, button: HTMLElement, id: HudElementId): void {
    const arrow = ARROWS[event.key];
    if (!arrow) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 0.1 : 1;
    const position = dragPosition(at(id), arrow[0] * step, arrow[1] * step, 100, 100);
    place(button, position);
    save({ ...read(), [id]: position });
  }

  const paint = (): void => {
    buttons.forEach((button, index) => place(button, at(HUD_ELEMENTS[index].id)));
  };
  paint();
  const root = h("div.mn", null, frame, say);
  (root as HTMLElement & { paint?: () => void }).paint = paint;
  return root;
}
