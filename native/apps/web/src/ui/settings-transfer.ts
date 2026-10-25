// Settings → Export / Import, and the "Reset all settings" confirmation (ported from Aimperion's settings transfer
// card). The format and the validation are settings-io.ts; this is the card.
//
// TEXT FIRST, THE FILE IS THE CONVENIENCE. What this is for is someone in a Discord thread asking for your settings: the
// first thing on the export side is a selected, copyable code; saving a .json is the second button. Import takes both,
// and a chosen file only fills the same box (it is NOT applied on its own): what gets imported is always what's on
// screen, and applying stays one explicit press. The result is reported in full (what changed, what was wrong, what
// this build didn't know), with Undo.
//
// The card is a modal <dialog> like the account panel and the changelog: keydown stops at the dialog, so no key reaches
// the game or the menus behind it; Esc closes the card and nothing else.

import { h } from "./dom";
import { icon } from "./icons";
import { prefs, type Prefs } from "./settings";
import { buildSettingsDoc, encodeSettingsCode, parseSettingsText, planSettingsImport, settingsFilename, stringifySettings } from "./settings-io";
import { VERSION } from "../version";
import "./account.css";
import { dismissOutside } from "./dismiss";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function modal(cls: string, label: string): HTMLDialogElement {
  const d = h(`dialog.acct-dialog.${cls}`, { "aria-label": label }) as HTMLDialogElement;
  d.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" && !e.defaultPrevented) (e.preventDefault(), d.close());
  });
  dismissOutside(d, () => d.close());
  // A key pressed while focus has fallen out of the card (a clicked button that re-rendered) still belongs to it: Esc
  // must close the card, not also go Back in the menu behind.
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !d.open || d.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    d.close();
  };
  addEventListener("keydown", esc, true);
  d.addEventListener("close", () => (removeEventListener("keydown", esc, true), d.remove()));
  return d;
}

function head(title: string, d: HTMLDialogElement): HTMLElement {
  return h("header.acct-head", null, h("h2", null, title), h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => d.close() }, icon("close")));
}

async function copyText(text: string, fallback: HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    fallback.focus();
    fallback.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }
}

export interface TransferOpts {
  /** After an import or its undo (re-render the settings screen). */
  onApplied?: () => void;
}

/** Opens the export / import card. */
export function openSettingsTransfer(mode: "export" | "import", o: TransferOpts = {}): void {
  document.querySelector<HTMLDialogElement>("dialog.xfer-dialog")?.close();
  const d = modal("xfer-dialog", "Export or import settings");
  const title = h("h2");
  const text = h("textarea.xfer-text", { spellcheck: "false", autocomplete: "off", autocorrect: "off", autocapitalize: "off", rows: "6", "aria-label": "Settings code" });
  const lead = h("p.xfer-lead.dim");
  const status = h("div.xfer-status", { role: "status", "aria-live": "polite" });
  const file = h("input", { type: "file", accept: ".json,application/json,text/plain", hidden: true, tabindex: "-1" });
  const primary = h("button.btn.primary", { type: "button" });
  const secondary = h("button.btn", { type: "button" });
  const tabs = h("div.seg.xfer-tabs", { role: "tablist", "aria-label": "Export or import" });
  const tabBtn = (m: "export" | "import", label: string) =>
    h("button", { type: "button", role: "tab", "data-m": m, onclick: () => show(m) }, icon(m), label);
  tabs.append(tabBtn("export", "Export"), tabBtn("import", "Import"));
  let current: "export" | "import" = mode;
  let codeText = "";
  let fileText = "";

  const say = (msg: string | Node, tone: "ok" | "bad" | "" = "") => {
    status.replaceChildren(msg);
    status.dataset.tone = tone;
  };

  async function show(m: "export" | "import"): Promise<void> {
    current = m;
    for (const b of tabs.children) {
      const on = (b as HTMLElement).dataset.m === m;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
      (b as HTMLElement).tabIndex = on ? 0 : -1;
    }
    say("");
    if (m === "export") {
      title.textContent = "Export settings";
      lead.textContent = "Your whole setup as one code: sensitivity, FOV, crosshair, HUD layout, keys, ghosts, graphics, viewmodel and sound. Paste it anywhere, or save it as a file. Your bunny's colourway stays with your account.";
      text.readOnly = true;
      text.placeholder = "";
      const doc = buildSettingsDoc(prefs.get(), { app: VERSION });
      fileText = stringifySettings(doc);
      codeText = await encodeSettingsCode(doc);
      if (current !== "export") return;
      text.value = codeText;
      primary.replaceChildren(icon("copy"), "Copy code");
      secondary.replaceChildren(icon("file"), "Save .json file");
      text.focus({ preventScroll: true });
      text.select();
    } else {
      title.textContent = "Import settings";
      lead.textContent = "Paste a settings code (it starts with bhs1.) or choose a .json file. Everything in it replaces your current settings; anything it doesn't mention stays as it is.";
      text.readOnly = false;
      text.value = "";
      text.placeholder = "bhs1.…  or  { \"format\": \"bunnyhop.lol/settings\", … }";
      primary.replaceChildren(icon("import"), "Import");
      secondary.replaceChildren(icon("file"), "Choose file…");
      text.focus({ preventScroll: true });
    }
  }

  primary.addEventListener("click", async () => {
    if (current === "export") {
      const ok = await copyText(codeText, text);
      say(ok ? "Copied. Paste it wherever you like." : "Couldn't reach the clipboard: the code is selected, copy it with Ctrl+C.", ok ? "ok" : "bad");
      return;
    }
    const parsed = await parseSettingsText(text.value);
    if (!parsed.ok) return say(parsed.error, "bad");
    const before = clone(prefs.get());
    const plan = planSettingsImport(parsed.doc, before);
    if (!plan.applied.length) return say("That has nothing this version can use.", "bad");
    prefs.update((p) => Object.assign(p, plan.next));
    o.onApplied?.();
    let msg = plan.changed.length ? `Imported: ${n(plan.changed.length, "setting")} changed.` : "Imported: your settings already matched.";
    if (plan.invalid.length) msg += ` ${n(plan.invalid.length, "value")} looked wrong and ${plan.invalid.length === 1 ? "was" : "were"} left alone (${plan.invalid.slice(0, 3).join(", ")}${plan.invalid.length > 3 ? ", …" : ""}).`;
    if (plan.skipped.length) msg += ` ${n(plan.skipped.length, "unknown key")} ignored.`;
    const undo = h("button.link-btn.xfer-undo", { type: "button" }, icon("undo"), "Undo");
    undo.addEventListener("click", () => {
      prefs.update((p) => Object.assign(p, before as Prefs));
      o.onApplied?.();
      say("Undone: your previous settings are back.", "ok");
      primary.focus({ preventScroll: true });
    });
    say(h("span", null, msg, " ", plan.changed.length ? undo : null), plan.invalid.length ? "bad" : "ok");
  });

  secondary.addEventListener("click", () => {
    if (current === "import") return file.click();
    const name = settingsFilename();
    const url = URL.createObjectURL(new Blob([fileText], { type: "application/json" }));
    const a = h("a", { href: url, download: name, hidden: true });
    d.append(a);
    a.click();
    a.remove();
    // Revoked later: a synchronous revoke can race the browser's read of the blob.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say(`Saved ${name}.`, "ok");
  });

  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    file.value = ""; // choosing the same file twice fires again
    if (!f) return;
    if (f.size > 500_000) return say("That file is far too large to be a settings file.", "bad");
    try {
      text.value = await f.text();
      // Deliberately NOT applied here (see the header).
      say(`Loaded ${f.name}. Press Import to apply it.`);
    } catch {
      say("That file couldn't be read.", "bad");
    }
  });

  d.append(
    h("header.acct-head", null, title, h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => d.close() }, icon("close"))),
    h("div.acct-body.xfer-body", null, tabs, lead, text, status, h("div.acct-actions", null, primary, secondary, file)),
  );
  document.body.append(d);
  d.showModal();
  void show(mode);
}

export interface ConfirmOpts {
  title: string;
  body: string;
  confirm: string;
  /** Destructive styling on the confirm button. */
  danger?: boolean;
}

/** A small modal yes / no. Resolves true on confirm; Esc, the backdrop and Cancel resolve false. */
export function confirmDialog(o: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const d = modal("confirm-dialog", o.title);
    let result = false;
    const yes = h(`button.btn${o.danger ? ".danger" : ".primary"}`, { type: "button", onclick: () => ((result = true), d.close()) }, o.confirm);
    const no = h("button.btn", { type: "button", "data-autofocus": "", onclick: () => d.close() }, "Cancel");
    d.addEventListener("close", () => resolve(result));
    d.append(head(o.title, d), h("div.acct-body", null, h("p.confirm-text", null, o.body), h("div.acct-actions.confirm-actions", null, no, yes)));
    document.body.append(d);
    d.showModal();
    no.focus();
  });
}

export interface TextOpts {
  title: string;
  /** The field's accessible name. */
  label: string;
  confirm: string;
  value?: string;
  maxLength: number;
  /** What's wrong with the text, said under the field; null when it's fine. */
  problem: (text: string) => string | null;
}

/** A small modal with one text field (a name). Resolves the text on confirm; Esc, the backdrop and Cancel resolve null. */
export function textDialog(o: TextOpts): Promise<string | null> {
  return new Promise((resolve) => {
    const d = modal("confirm-dialog", o.title);
    let result: string | null = null;
    const input = h("input.es-input", { type: "text", value: o.value ?? "", maxlength: String(o.maxLength + 8), autocomplete: "off", spellcheck: "false", "aria-label": o.label }) as HTMLInputElement;
    const msg = h("p.es-msg", { "aria-live": "polite" });
    const submit = () => {
      const why = o.problem(input.value);
      msg.textContent = why ?? "";
      msg.dataset.kind = why ? "err" : "";
      input.setAttribute("aria-invalid", String(!!why));
      if (why) return input.focus();
      result = input.value;
      d.close();
    };
    input.addEventListener("input", () => ((msg.textContent = ""), input.removeAttribute("aria-invalid")));
    input.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), submit()));
    const yes = h("button.btn.primary", { type: "button", onclick: submit }, o.confirm);
    const no = h("button.btn", { type: "button", onclick: () => d.close() }, "Cancel");
    d.addEventListener("close", () => resolve(result));
    d.append(head(o.title, d), h("div.acct-body", null, input, msg, h("div.acct-actions.confirm-actions", null, no, yes)));
    document.body.append(d);
    d.showModal();
    input.focus();
    input.select();
  });
}
