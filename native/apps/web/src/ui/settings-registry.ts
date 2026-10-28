// Settings sections registered from outside the settings screen (e.g. audio). DOM-free apart from the render
// callback, so any module can register at import time without pulling in the settings screen:
//
//   import { registerSettingsSection } from "./ui/settings-registry";
//   registerSettingsSection("audio", (ui) => ({
//     columns: [
//       [ui.group("Volume", ui.range("Master", () => audio.master, (v) => audio.setMaster(v), { min: 0, max: 1, step: 0.01, scale: 100, unit: "%", desc: "Everything." }))],
//       [ui.group("Effects", ui.toggle("Footsteps", () => audio.steps, (v) => audio.setSteps(v)))],
//     ],
//   }), { reset: () => audio.resetDefaults(), icon: "audio" });
//
// `ui` is ui/controls.ts (row, group, range, toggle, check, select, segmented, color, actions, button, keycap). Return
// a flat list of groups or explicit `{ columns: [left, right] }`. The settings screen is one scrolling page of sections
// (a rail on the left jumps between them): groups sit in two columns where the screen is wide enough and stack in one
// below that, so keep each group short and give rows a `desc` (the ⓘ tip), a few-word `hint` where it helps, and
// `keywords` with the words players use (they feed the settings search). Most-used rows first; rows few players touch
// go in `advanced` (groups behind the section's "Advanced" disclosure, which the search opens when it finds one there).
// A hint says what the label doesn't; the ⓘ says the rest without repeating the hint.
//
// Registering an id that matches a built-in section ("mouse", "crosshair", "hud", "keys", "ghost", "graphics",
// "audio") replaces that section's content; any other id adds a new section (after the built-ins, by `order`).
// The settings screen re-renders a section when its registration changes.

import type * as Controls from "./controls";

export type SettingsContent = HTMLElement[] | { columns: HTMLElement[][]; advanced?: HTMLElement[] };
/** `ctx.refresh()` re-renders the section (e.g. after a change that shows / hides other rows). */
export type SettingsRender = (ui: typeof Controls, ctx: { refresh: () => void }) => SettingsContent;

export interface SettingsSectionOpts {
  /** Nest these controls in a parent section’s collapsed Advanced disclosure. */
  advancedUnder?: string;
  /** Section label (default: the built-in section's label, else the id). */
  label?: string;
  /** Short line under the section title. */
  blurb?: string;
  /** Glyph for the rail and the section header: a name from ui/icons.ts (default: by id, else a generic one). */
  icon?: string;
  /** Sort key for new sections (built-ins are 10..70; default 100). */
  order?: number;
  /** "Reset section": restore its defaults. Without it the section has no reset button. */
  reset?: () => void;
}

export interface RegisteredSection extends SettingsSectionOpts {
  id: string;
  render: SettingsRender;
}

const sections = new Map<string, RegisteredSection>();
const listeners = new Set<() => void>();

/** Adds (or replaces) a settings section. Returns an unregister function. */
export function registerSettingsSection(id: string, render: SettingsRender, opts: SettingsSectionOpts = {}): () => void {
  const entry: RegisteredSection = { id, render, ...opts };
  sections.set(id, entry);
  for (const l of listeners) l();
  return () => {
    if (sections.get(id) !== entry) return;
    sections.delete(id);
    for (const l of listeners) l();
  };
}

export function registeredSections(): RegisteredSection[] {
  return [...sections.values()];
}

/** Called after every (un)registration. Returns an unsubscribe function. */
export function onSettingsSections(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
