// The ? sheet: every key in the panel in one place, the view's own first (core.ts setKeys carries them in words), then
// the ones that work everywhere. A plain dialog; Esc or ? again closes it.

import { fill, h, viewKeyHelp } from "./core";

const GLOBAL: [string, string][] = [
  ["/ or Ctrl K", "Search: players, maps, sections, saved views"],
  ["g then ~a letter", "Go to a section (the letters show in the rail while g is held)"],
  ["?", "This list"],
  ["Esc", "Close a menu, the drawer, the thread pane or a dialog"],
];

let dlg: HTMLDialogElement | null = null;

/** "j / k", "/ or Ctrl K", "g then ~a letter": keys in kbd, the joining words faint, ~words plain. */
const keyEls = (k: string) => k.split(/ (\/|or|then) /).map((p, i) => (i % 2 ? h("span", { class: "faint" }, ` ${p} `) : p.startsWith("~") ? h("span", { class: "muted" }, p.slice(1)) : h("kbd", null, p)));

const rows = (list: [string, string][]) => h("dl", { class: "keys-list" }, list.flatMap(([k, what]) => [h("dt", null, ...keyEls(k)), h("dd", null, what)]));

export function showShortcuts(): void {
  if (dlg?.open) return dlg.close();
  dlg ??= document.body.appendChild(h("dialog", { class: "keys-sheet", "aria-label": "Keyboard shortcuts" }));
  const view = viewKeyHelp();
  fill(
    dlg,
    h("h2", null, "Keys"),
    view.length ? [h("h3", null, "On this page"), rows(view)] : null,
    h("h3", null, "Everywhere"),
    rows(GLOBAL),
    h("form", { method: "dialog", class: "actions" }, h("button", { type: "submit", class: "small" }, "Close")),
  );
  dlg.onkeydown = (e) => e.key === "?" && (e.preventDefault(), dlg!.close());
  dlg.showModal();
}
