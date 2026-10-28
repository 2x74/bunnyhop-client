// Controller navigation for the menus: while a menu is open (and the pointer isn't locked) a connected gamepad's
// d-pad / left stick act as the arrow keys, A as Enter / click, B as Esc, LB / RB as Q / E (previous / next tab).
// Menus already handle those keys, so this only translates; nothing polls until a gamepad connects.

const REPEAT_DELAY = 380;
const REPEAT_RATE = 110;
const STICK = 0.55;

type Btn = "up" | "down" | "left" | "right" | "a" | "b" | "lb" | "rb";
const KEY: Record<Btn, string> = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", a: "Enter", b: "Escape", lb: "q", rb: "e" };

function key(k: string): void {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const ev = new KeyboardEvent("keydown", { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, bubbles: true, cancelable: true });
  const notCancelled = target.dispatchEvent(ev);
  if (!notCancelled) return;
  // Default actions synthetic events don't get: activate buttons, nudge sliders.
  if (k === "Enter" && target instanceof HTMLElement && target.matches("button, a, input[type=checkbox], label")) target.click();
  if ((k === "ArrowLeft" || k === "ArrowRight") && target instanceof HTMLInputElement && target.type === "range") {
    if (k === "ArrowRight") target.stepUp();
    else target.stepDown();
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/** Starts translating gamepad input while `active()` is true (menu open, pointer not locked). */
export function initGamepadNav(active: () => boolean): void {
  if (!("getGamepads" in navigator)) return;
  const held = new Map<Btn, number>();
  let raf = 0;
  const poll = (now: number) => {
    const pads = [...navigator.getGamepads()].filter((p): p is Gamepad => !!p);
    if (!pads.length) {
      raf = 0;
      held.clear();
      return;
    }
    raf = requestAnimationFrame(poll);
    if (!active() || document.hidden) return held.clear();
    const down = new Set<Btn>();
    for (const p of pads) {
      const b = (i: number) => !!p.buttons[i]?.pressed;
      const [x = 0, y = 0] = p.axes;
      if (b(12) || y < -STICK) down.add("up");
      if (b(13) || y > STICK) down.add("down");
      if (b(14) || x < -STICK) down.add("left");
      if (b(15) || x > STICK) down.add("right");
      if (b(0)) down.add("a");
      if (b(1)) down.add("b");
      if (b(4)) down.add("lb");
      if (b(5)) down.add("rb");
    }
    for (const btn of Object.keys(KEY) as Btn[]) {
      if (!down.has(btn)) {
        held.delete(btn);
        continue;
      }
      const since = held.get(btn);
      const repeats = btn === "up" || btn === "down" || btn === "left" || btn === "right";
      if (since === undefined) {
        held.set(btn, now);
        key(KEY[btn]);
      } else if (repeats && now - since > REPEAT_DELAY) {
        held.set(btn, now - REPEAT_DELAY + REPEAT_RATE);
        key(KEY[btn]);
      }
    }
  };
  addEventListener("gamepadconnected", () => {
    if (!raf) raf = requestAnimationFrame(poll);
  });
}
