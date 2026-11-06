// Settings → Keys → Import a CS:S config: paste a config.cfg / autoexec.cfg, see what it would bind and set and which
// lines don't apply here (console/exec.ts importConfig), then Import. Nothing changes before the button.

import { h } from "../ui/dom";
import { prefs } from "../ui/settings";
import { importConfig, type ImportReport } from "./exec";
import "../ui/account.css";
import "./console.css";

let current: HTMLDialogElement | null = null;

const STATUS: Record<string, string> = { bound: "bound", unbound: "unbound", set: "set", kept: "kept", skipped: "not used", error: "error" };

/** Opens the import card. `done` runs after an import (the Keys page re-renders). */
export function openConfigImport(done?: () => void): void {
  if (current) return;
  const d = h("dialog.acct-dialog.cfg-dialog", { "aria-label": "Import a CS:S config" }) as HTMLDialogElement;
  current = d;
  d.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" && !e.defaultPrevented) (e.preventDefault(), d.close());
  });
  d.addEventListener("close", () => {
    d.remove();
    current = null;
  });
  const text = h("textarea.cfg-text", { spellcheck: "false", "aria-label": "Config text", placeholder: 'bind "mwheeldown" "+jump"\nsensitivity "1.8"' }) as HTMLTextAreaElement;
  const keep = h("input.switch.sm", { type: "checkbox", id: "cfg-keep", role: "switch", checked: true }) as HTMLInputElement;
  const sum = h("p.cfg-sum", { "aria-live": "polite" });
  const list = h("ul.cfg-list");
  const go = h("button.btn.btn-sm.primary", { type: "button", disabled: true }, "Import") as HTMLButtonElement;
  const cancel = h("button.btn.btn-sm", { type: "button", onclick: () => d.close() }, "Cancel");
  let report: ImportReport | null = null;
  const paint = () => {
    const t = text.value;
    report = t.trim() ? importConfig(t, prefs.get(), { keepOwn: keep.checked }) : null;
    list.replaceChildren();
    if (!report) {
      sum.textContent = "Paste the text of your config.cfg or autoexec.cfg.";
      go.disabled = true;
      return;
    }
    const unused = report.lines.filter((l) => l.status === "skipped" || l.status === "error" || l.status === "kept").length;
    sum.textContent = `${report.binds} bind${report.binds === 1 ? "" : "s"} and ${report.settings} setting${report.settings === 1 ? "" : "s"} to import. ${unused ? `${unused} line${unused === 1 ? "" : "s"} won't be used.` : "Every line applies."}`;
    for (const l of report.lines) list.append(h(`li.${l.status}`, null, h("span.cfg-cmd", { title: l.command }, l.command), h("span.cfg-note", null, l.note || STATUS[l.status])));
    go.disabled = !report.changed;
  };
  let timer = 0;
  text.addEventListener("input", () => (clearTimeout(timer), (timer = window.setTimeout(paint, 120))));
  keep.addEventListener("change", paint);
  go.addEventListener("click", () => {
    if (!report?.changed) return;
    const next = report.prefs;
    prefs.update((p) => Object.assign(p, next));
    d.close();
    done?.();
  });
  d.append(
    h("div.acct-head", null, h("h2", null, "Import a CS:S config"), h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => d.close() }, "×")),
    h(
      "div.acct-body",
      null,
      text,
      h("label.cfg-keep", { for: "cfg-keep" }, keep, "Keep the keys of this game's own actions (restart, checkpoints, start point)"),
      sum,
      list,
      h("div.cfg-foot", null, cancel, go),
    ),
  );
  document.body.append(d);
  d.showModal();
  paint();
  text.focus();
}
