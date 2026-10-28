// The website's settings controls (web ui/controls.ts), with one change for the native client: a group leaves out
// the rows the host can't honour (settings-gates.ts). The settings screen renders each section inside
// renderingSection, so a row is known by its section, group and label.

import * as web from "../../web/src/ui/controls";
import { gateFor, NATIVE_GATES, type Gate } from "./settings-gates";
import { hostCan } from "./prefs-bridge";

export * from "../../web/src/ui/controls";

/** The note on a row whose setting the native renderer does its own way. */
export const UNAVAILABLE_HINT = "Not available in the native client";

export interface SeenRow {
  section: string;
  group: string;
  label: string;
  /** "shown", "unavailable", "hidden" (the host lacks a key), "excluded", or "unlisted" (not in the table). */
  outcome: "shown" | "unavailable" | "hidden" | "excluded" | "unlisted";
  native: boolean;
}

let section = "";
/** Every row the settings screen built since the last reset (the coverage test reads it). */
export const seenRows = new Map<string, SeenRow>();
const decorators = new Map<string, (row: HTMLElement) => void>();

/** Renders a settings section's content with `id` as the section its rows belong to. */
export function renderingSection<T>(id: string, render: () => T): T {
  const outer = section;
  section = id;
  try {
    return render();
  } finally {
    section = outer;
  }
}

/** Adjusts a row once it's built, e.g. an option the native client can't offer ("section/group/label"). */
export function decorateRow(key: string, decorate: (row: HTMLElement) => void): void {
  decorators.set(key, decorate);
}

function passes(gate: Gate): boolean {
  if ("excluded" in gate) return false;
  return gate.needs.every((need) => need.split("|").some(hostCan));
}

function outcomeOf(gate: Gate | null): SeenRow["outcome"] {
  if (!gate) return "unlisted";
  if ("excluded" in gate) return "excluded";
  if (passes(gate)) return "shown";
  return gate.unavailable ? "unavailable" : "hidden";
}

/**
 * Notes under graphics rows about the website's renderer (Cinematic packs, traced lighting). The rows they explain
 * aren't in the native client.
 */
const WEB_RENDERER_NOTES = ".set-note, .setting-note";

/** Shows a row without its control, saying the native client does it another way. */
function markUnavailable(row: HTMLElement, note: string): void {
  row.classList.add("native-unavailable");
  for (const control of row.querySelectorAll<HTMLInputElement>("input, select, button, textarea")) {
    control.disabled = true;
  }
  const label = row.querySelector(".set-label");
  const hint = row.querySelector(".set-hint") ?? label?.appendChild(document.createElement("small"));
  if (hint) {
    hint.className = "set-hint";
    hint.textContent = UNAVAILABLE_HINT;
  }
  (row as HTMLElement & { descFn?: () => string }).descFn = () => note;
}

/** Applies the gates to the rows under `parent`; returns whether any row is left. */
function gateRows(parent: HTMLElement, title: string): boolean {
  let left = 0;
  for (const row of parent.querySelectorAll<HTMLElement>(".set-row")) {
    const label = row.dataset.label ?? "";
    const key = `${section}/${title}/${label}`;
    const nativeGate = NATIVE_GATES[key];
    const gate = nativeGate ?? gateFor(section, title, label);
    const outcome = outcomeOf(gate);
    seenRows.set(key, { section, group: title, label, outcome, native: !!nativeGate });
    if (outcome === "excluded" || outcome === "hidden") {
      row.remove();
      continue;
    }
    if (outcome === "unavailable" && gate && "needs" in gate) markUnavailable(row, gate.unavailable ?? "");
    decorators.get(key)?.(row);
    left++;
  }
  return left > 0;
}

/** A titled block of rows (web controls.ts group), without the rows the native client leaves out. */
export function group(title: string | null, ...children: (HTMLElement | null | false | undefined)[]): HTMLElement {
  const element = web.group(title, ...children);
  if (!section) return element;
  if (section === "graphics") for (const note of element.querySelectorAll(WEB_RENDERER_NOTES)) note.remove();
  if (!gateRows(element, title ?? "")) element.hidden = true;
  return element;
}

if (typeof window !== "undefined") {
  // For settings-coverage.browser.test.ts: what the screen did with each row.
  (window as Window & { __nativeSettingsRows?: () => SeenRow[] }).__nativeSettingsRows = () => [...seenRows.values()];
}
