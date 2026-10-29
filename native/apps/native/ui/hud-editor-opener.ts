// Settings → HUD → Edit layout, and the hudEditor key while the menu is open: the website's editor (web
// hud/editor.ts) drags the page's HUD, but here the HUD is the host's, drawn over the game, so the host runs the
// editor (hud_editor.cpp). This stands in as the website's editor, so its row and key ask the host instead.

import { HudEditor } from "../../web/src/hud/editor";
import { h } from "../../web/src/ui/dom";
import { send } from "./bridge";

class HostHudEditor extends HudEditor {
  constructor() {
    super({ root: h("div"), els: {} as never, preview: () => {}, setEditing: () => {} });
  }

  override toggle(): void {
    send({ type: "hudEditor" });
  }

  override open(): void {
    send({ type: "hudEditor" });
  }
}

let installed: HostHudEditor | null = null;

/** Makes the website's "Edit layout" row and key open the host's editor (call once). */
export function installHostHudEditor(): void {
  installed ??= new HostHudEditor();
}
