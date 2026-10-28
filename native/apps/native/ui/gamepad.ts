/** Standard controller mapping shared by SDL's host bridge and the optional browser Gamepad API. */
export interface MenuGamepad {
  buttons: readonly number[];
  axes: readonly number[];
}
export type MenuAction = "up" | "down" | "left" | "right" | "accept" | "back" | "previous" | "next";
export function gamepadActions(value: unknown): Set<MenuAction> {
  const out = new Set<MenuAction>();
  if (!value || typeof value !== "object") return out;
  const p = value as Partial<MenuGamepad>;
  if (!Array.isArray(p.buttons) || !Array.isArray(p.axes)) return out;
  const b = (i: number) => typeof p.buttons![i] === "number" && p.buttons![i]! > 0.5;
  const x = Number.isFinite(p.axes[0]) ? p.axes[0]! : 0,
    y = Number.isFinite(p.axes[1]) ? p.axes[1]! : 0;
  if (b(12) || y < -0.55) out.add("up");
  if (b(13) || y > 0.55) out.add("down");
  if (b(14) || x < -0.55) out.add("left");
  if (b(15) || x > 0.55) out.add("right");
  if (b(0)) out.add("accept");
  if (b(1)) out.add("back");
  if (b(4)) out.add("previous");
  if (b(5)) out.add("next");
  return out;
}
const keys: Record<MenuAction, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  accept: "Enter",
  back: "Escape",
  previous: "q",
  next: "e",
};
function activate(action: MenuAction): void {
  const root = document.querySelector("dialog[open]") ?? document.getElementById("menu") ?? document.body;
  const controls = () =>
    [
      ...root.querySelectorAll<HTMLElement>(
        'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]',
      ),
    ].filter((el) => el.getClientRects().length && !el.closest("[inert], [hidden]"));
  let target = document.activeElement as HTMLElement | null;
  if (!target || !root.contains(target)) {
    target = controls()[0] ?? null;
    target?.focus();
    if (action !== "back") return;
  }
  if (!target) return;
  const selectedTab = () => root.querySelector('[role="tab"][aria-selected="true"],[role="tab"].on,.lo-tab.on');
  const beforeTab = selectedTab();
  const key = keys[action];
  if (
    !target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        bubbles: true,
        cancelable: true,
      }),
    )
  )
    return;
  if ((action === "previous" || action === "next") && selectedTab() !== beforeTab) return;
  if (action === "back") {
    const dialog = root instanceof HTMLDialogElement ? root : null;
    if (dialog) {
      const event = new Event("cancel", { cancelable: true });
      if (dialog.dispatchEvent(event)) dialog.close();
    }
    return;
  }
  if (action === "accept") {
    if (target.matches('button,a,input[type="checkbox"],input[type="radio"]')) target.click();
    return;
  }
  if ((action === "left" || action === "right") && target instanceof HTMLInputElement && target.type === "range") {
    action === "right" ? target.stepUp() : target.stepDown();
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (action === "previous" || action === "next") {
    const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"],.pause-tab,.lo-tab')].filter(
      (el) => el.getClientRects().length,
    );
    if (tabs.length) {
      const current = tabs.findIndex(
        (el) => el.getAttribute("aria-selected") === "true" || el.classList.contains("on"),
      );
      const tab = tabs[(current + (action === "next" ? 1 : -1) + tabs.length) % tabs.length]!;
      tab.focus();
      tab.click();
    }
    return;
  }
  if (target.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]),textarea,select')) return;
  const all = controls(),
    index = all.indexOf(target),
    dir = action === "up" || action === "left" ? -1 : 1;
  const next = all[(index + dir + all.length) % all.length];
  next?.focus();
  next?.scrollIntoView({ block: "nearest" });
}
/** Host calls receive every visible-menu frame, including empty releases. */
export function installGamepadNavigation(active: () => boolean): (value: unknown) => void {
  const held = new Map<MenuAction, number>();
  let nativeAt = -Infinity;
  const receive = (value: unknown, now = performance.now()) => {
    if (!active() || document.hidden) {
      held.clear();
      return;
    }
    const down = gamepadActions(value);
    for (const action of Object.keys(keys) as MenuAction[]) {
      if (!down.has(action)) {
        held.delete(action);
        continue;
      }
      const next = held.get(action);
      if (next === undefined) {
        activate(action);
        held.set(action, now + 380);
      } else if (["up", "down", "left", "right"].includes(action) && now >= next) {
        activate(action);
        held.set(action, now + 110);
      }
    }
  };
  window.addEventListener("blur", () => held.clear());
  document.addEventListener("visibilitychange", () => held.clear());
  let polling = false;
  const poll = () => {
    let pads: (Gamepad | null)[] = [];
    try {
      pads = Array.from(navigator.getGamepads?.() ?? []);
    } catch {
      /* WebView can deny this API. */
    }
    const pad = pads.find(Boolean);
    if (!pad) {
      polling = false;
      return;
    }
    if (performance.now() - nativeAt > 1000) receive({ buttons: pad.buttons.map((b) => b.value), axes: pad.axes });
    requestAnimationFrame(poll);
  };
  const start = () => {
    if (!polling) {
      polling = true;
      requestAnimationFrame(poll);
    }
  };
  window.addEventListener("gamepadconnected", start);
  start();
  return (value) => {
    nativeAt = performance.now();
    receive(value);
  };
}
