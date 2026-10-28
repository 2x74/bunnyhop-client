// The !cp menu on screen (controller.ts PracticeMenuView): the game's CS:S-style numbered menu (net/hud.ts NumberMenu,
// the one !nominate, !guns and !triggers use), left middle. It stays up while you play, like a Source menu, until 0 or
// !cp closes it; the pause menu hides it meanwhile (net.css). Its size follows the HUD scale (#mp-menu is em-sized off
// --hs). While it's open its digits pick instead of switching weapons, except in a text field (chat) or when the
// guns menu, opened later, has them.

import { isTextField } from "../input";
import type { MenuSpec, NumberMenu } from "../net/hud";
import { closeGunPicker, gunPickerOpen } from "../weapon-commands";
import type { PracticeMenuView } from "./controller";

export function practiceMenuView(): PracticeMenuView {
  let menu: NumberMenu | null = null;
  /** Shown before the menu's module loaded: shown once it has (null: closed meanwhile). */
  let pending: MenuSpec | null = null;
  let loading = false;
  const onKey = (e: KeyboardEvent) => {
    if (!menu?.open || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTextField(e.target) || document.body.classList.contains("menu-open") || gunPickerOpen()) return;
    const d = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
    if (!d) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    menu.key(Number(d[1]));
  };
  return {
    get open() {
      return !!menu?.open || pending !== null;
    },
    show(spec) {
      if (!menu?.open && pending === null) closeGunPicker(); // one numbered menu at a time (a re-draw leaves it)
      if (menu) return menu.show("checkpoints", spec);
      pending = spec;
      if (loading) return;
      loading = true;
      void import("../net/hud").then(({ NumberMenu }) => {
        menu = new NumberMenu(document.getElementById("hud") ?? document.body);
        menu.el.classList.add("cp-menu");
        // Capture phase, ahead of the game's keys (weapon slots).
        window.addEventListener("keydown", onKey, true);
        if (pending) menu.show("checkpoints", pending);
        pending = null;
      });
    },
    hide() {
      pending = null;
      menu?.hide();
    },
  };
}
