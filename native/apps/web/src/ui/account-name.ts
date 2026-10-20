// Display-name field with live validation and a dice button (bhop-themed suggestions). Used by the onboarding name step
// and the account panel. The rules are the server's (moderation/names.ts); the server still decides on save.
//
// Checking as you type (hatchdle's NameForm approach): characters that can never be in a name are flagged at once;
// everything else once typing pauses, so "Dick" on the way to "Dickens" isn't flagged halfway. Availability comes
// from GET /names/check after the pause.

import { api, ApiError, type User } from "../api";
import { cleanName, nameProblem, NAME_MAX, NAME_MESSAGES, suggestName, type NameError } from "../moderation/names";
import { h } from "./dom";
import { sfx } from "../audio";

const PAUSE_MS = 650;

export interface NameField {
  el: HTMLElement;
  input: HTMLInputElement;
  /** The cleaned value if it passes the local rules, else null. */
  valid(): string | null;
  /** Saves through the API (or locally offline). Resolves with the saved name, or null after showing an error. */
  save(): Promise<string | null>;
  /** Fills a random suggestion. */
  roll(): void;
}

export const NAME_LOCAL_KEY = "bunnyhop:name"; // also read by session.ts for replay headers

let uid = 0;

/** Server error -> message (never echoing the name). */
export function nameErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "rename_limit" || e.code === "taken") return e.message;
    if (e.code in NAME_MESSAGES) return NAME_MESSAGES[e.code as NameError];
    return e.message || "That didn't work. Try again.";
  }
  return "Couldn't reach the server. Try again.";
}

export function nameField(o: { initial?: string; label?: string; autofocus?: boolean; onSaved?: (u: User | null, name: string) => void; onInput?: () => void } = {}): NameField {
  const id = `name-field-${++uid}`;
  const input = h("input.nf-input", {
    id,
    type: "text",
    value: o.initial ?? "",
    maxlength: String(NAME_MAX + 4),
    autocomplete: "nickname",
    autocapitalize: "off",
    spellcheck: "false",
    "aria-describedby": `${id}-msg`,
    placeholder: "Your name",
  });
  const msg = h("p.nf-msg", { id: `${id}-msg`, "aria-live": "polite" });
  const count = h("span.nf-count", { "aria-hidden": "true" });
  const dice = h(
    "button.btn.nf-dice",
    { type: "button", title: "Random bhop name", "aria-label": "Random name" },
    h("span", { "aria-hidden": "true", html: DICE_SVG }),
  );
  let timer = 0;
  let seq = 0;
  let serverNote: { text: string; kind: "ok" | "warn" | "err" } | null = null;

  const set = (text: string, kind: "" | "ok" | "warn" | "err") => {
    msg.textContent = text;
    msg.dataset.kind = kind;
    input.setAttribute("aria-invalid", kind === "err" ? "true" : "false");
  };

  const charProblem = (raw: string) => /[^A-Za-z0-9 _.\-]/.test(cleanName(raw));
  const full = (raw: string): string => {
    const name = cleanName(raw);
    const p = nameProblem(name);
    return p ? NAME_MESSAGES[p] : "";
  };

  const paint = (paused: boolean) => {
    const raw = input.value;
    const name = cleanName(raw);
    count.textContent = `${name.length}/${NAME_MAX}`;
    count.classList.toggle("over", name.length > NAME_MAX);
    if (!name) return set("", "");
    if (charProblem(raw)) return set(NAME_MESSAGES.charset, "err");
    if (name.length > NAME_MAX) return set(NAME_MESSAGES.too_long, "err");
    if (!paused) return set(serverNote?.text ?? "", serverNote?.kind ?? "");
    const p = full(raw);
    if (p) return set(p, "err");
    if (name !== raw.trim()) set(`Saved as ${name}`, "ok");
    else set(serverNote?.text ?? "", serverNote?.kind ?? "");
  };

  const check = async () => {
    const name = cleanName(input.value);
    if (!name || full(input.value) || !api.available()) return;
    const my = ++seq;
    try {
      const r = await api.checkName(name);
      if (my !== seq) return;
      if (!r.ok) serverNote = { text: r.message ?? NAME_MESSAGES.bad_name, kind: "err" };
      else if (r.available) serverNote = { text: name === o.initial ? "" : "Available", kind: "ok" };
      else if (r.adjusts && r.suggestion) serverNote = { text: `Taken. You'd be ${r.suggestion}.`, kind: "warn" };
      else serverNote = { text: r.suggestion ? `Taken. Try ${r.suggestion}?` : NAME_MESSAGES.taken, kind: "err" };
      paint(true);
    } catch {
      /* offline: local rules only */
    }
  };

  input.addEventListener("input", () => {
    serverNote = null;
    paint(false);
    clearTimeout(timer);
    timer = window.setTimeout(() => (paint(true), void check()), PAUSE_MS);
    o.onInput?.();
  });
  input.addEventListener("blur", () => (clearTimeout(timer), paint(true), void check()));

  const field: NameField = {
    el: h(
      "div.name-field",
      null,
      o.label ? h("label.nf-label", { for: id }, o.label) : null,
      h("div.nf-row", null, h("div.nf-box", null, input, count), dice),
      msg,
    ),
    input,
    valid() {
      const name = cleanName(input.value);
      return name && !nameProblem(name) ? name : null;
    },
    roll() {
      input.value = suggestName();
      input.dispatchEvent(new Event("input"));
      clearTimeout(timer);
      paint(true);
      void check();
    },
    async save() {
      clearTimeout(timer);
      paint(true);
      const name = field.valid();
      if (!name) {
        if (!cleanName(input.value)) set(NAME_MESSAGES.too_short, "err");
        input.focus();
        return null;
      }
      if (!api.available()) {
        localStorage.setItem(NAME_LOCAL_KEY, name);
        o.onSaved?.(null, name);
        return name;
      }
      try {
        const u = await api.setDisplayName(name);
        localStorage.setItem(NAME_LOCAL_KEY, u.name);
        input.value = u.name;
        set(u.nameAdjusted ? `That one was taken. You're ${u.name}.` : "Saved.", u.nameAdjusted ? "warn" : "ok");
        o.onSaved?.(u, u.name);
        return u.name;
      } catch (e) {
        if (e instanceof ApiError && e.code === "taken" && typeof e.body.suggestion === "string") set(`Taken. Try ${e.body.suggestion}?`, "err");
        else set(nameErrorMessage(e), "err");
        sfx("ui_error", 0.6);
        input.focus();
        return null;
      }
    },
  };
  dice.addEventListener("click", () => (sfx("ui_click", 0.7), field.roll()));
  if (o.autofocus) requestAnimationFrame(() => input.focus());
  paint(false);
  return field;
}

const DICE_SVG = `<svg viewBox="0 0 24 24" width="1.2em" height="1.2em" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="3.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="8.5" r="1.6" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.6" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.6" fill="currentColor"/></svg>`;
