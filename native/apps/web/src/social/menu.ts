// A small drop-down menu for a button (profile actions: Friends ▾, Following ▾, the ⋯ overflow; the dock's friend rows).
// A real menu: role=menu / menuitem, opens on click or ↓, arrows and Home / End move, Esc or Tab closes and Esc returns
// focus to the button (before the menu screen takes Esc as Back). A line of text (where a friend is) can head it. An
// item with `checked` is a checkbox item (the map panel's Groups: a check by each group the map is in).
// Styles: social/dock.css (.sm-*). Enters with the drop (opacity + a short fall), nothing under reduced motion.

import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { uiClose, uiOpen } from "../audio/ui";

export type MenuItem =
  | { label: string; run: () => void | Promise<void>; tone?: "bad"; hint?: string; disabled?: boolean; checked?: boolean }
  | { note: string | Node }
  | null
  | false;

let current: { close: (focus?: boolean) => void } | null = null;

/** Closes whichever menu is open (screen changes, the dock closing). */
export function closeMenus(): void {
  current?.close(false);
}

/**
 * Makes `btn` open a menu of `items()` (read on every open, so it follows the live state). `align` the menu's edge with
 * the button's left or right edge. Returns the button.
 */
export function withMenu<T extends HTMLElement>(btn: T, items: () => MenuItem[], o: { align?: "left" | "right"; label?: string } = {}): T {
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  const open = (focusFirst: boolean) => {
    if (current) {
      const was = btn.getAttribute("aria-expanded") === "true";
      current.close(false);
      if (was) return;
    }
    const list = items().filter((x): x is Exclude<MenuItem, null | false> => !!x);
    if (!list.length) return;
    const menu = h("div.sm-menu", { role: "menu", "aria-label": o.label ?? btn.textContent ?? "Menu" });
    const buttons: HTMLButtonElement[] = [];
    for (const it of list) {
      if ("note" in it) {
        menu.append(h("p.sm-note", null, it.note));
        continue;
      }
      const b = h(
        `button.sm-item${it.tone === "bad" ? ".bad" : ""}`,
        {
          type: "button",
          role: it.checked === undefined ? "menuitem" : "menuitemcheckbox",
          "aria-checked": it.checked === undefined ? null : String(it.checked),
          tabindex: "-1",
          disabled: it.disabled,
          onclick: () => (close(true), void Promise.resolve(it.run())),
        },
        h("span", null, it.label),
        it.hint ? h("small", null, it.hint) : null,
        it.checked ? icon("check", { cls: "sm-check" }) : null,
      ) as HTMLButtonElement;
      buttons.push(b);
      menu.append(b);
    }
    // Under the button, inside the viewport; above it when there isn't room below.
    document.body.append(menu);
    const r = btn.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const left = o.align === "right" ? r.right - m.width : r.left;
    const below = r.bottom + 6 + m.height <= innerHeight - 8;
    menu.style.left = `${Math.max(8, Math.min(innerWidth - m.width - 8, left))}px`;
    menu.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - m.height)}px`;
    menu.classList.toggle("up", !below);
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("menu-on");
    uiOpen();

    const enabled = () => buttons.filter((b) => !b.disabled);
    const move = (to: number) => {
      const e = enabled();
      if (!e.length) return;
      e[(to + e.length) % e.length]!.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      const e2 = enabled();
      const i = e2.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key === "ArrowDown") (e.preventDefault(), e.stopPropagation(), move(i + 1));
      else if (e.key === "ArrowUp") (e.preventDefault(), e.stopPropagation(), move(i < 0 ? -1 : i - 1));
      else if (e.key === "Home") (e.preventDefault(), move(0));
      else if (e.key === "End") (e.preventDefault(), move(-1));
      else if (e.key === "Tab") close(false);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.contains(t) && !btn.contains(t)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!menu.contains(e.target as Node)) close(false);
    };
    addEventListener("keydown", onKey, true);
    addEventListener("pointerdown", onDown, true);
    addEventListener("scroll", onScroll, true);
    addEventListener("resize", onScroll);
    function close(focus = false): void {
      if (current !== handle) return;
      current = null;
      removeEventListener("keydown", onKey, true);
      removeEventListener("pointerdown", onDown, true);
      removeEventListener("scroll", onScroll, true);
      removeEventListener("resize", onScroll);
      menu.remove();
      btn.setAttribute("aria-expanded", "false");
      btn.classList.remove("menu-on");
      uiClose();
      if (focus && btn.isConnected) btn.focus({ preventScroll: true });
    }
    const handle = { close };
    current = handle;
    if (focusFirst) move(0);
    else menu.focus?.();
  };
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    // Keyboard clicks (Enter / Space: detail 0) put focus on the first item.
    open(e.detail === 0);
  });
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" || btn.getAttribute("aria-expanded") === "true") return;
    e.preventDefault();
    e.stopPropagation();
    open(true);
  });
  return btn;
}
