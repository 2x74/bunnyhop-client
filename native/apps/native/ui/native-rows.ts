// Settings rows for what only the native client has (window, Discord, sound packs...), built from the website's
// controls so they look like every other row. They read the host's settings and write through prefs-bridge.ts.

import type * as Controls from "../../web/src/ui/controls";
import type { RowOpts } from "../../web/src/ui/controls";
import { state, type NativeSettings } from "./bridge";
import { onNativeSettings, sendNativeSettings } from "./prefs-bridge";

export type Ui = typeof Controls;
type BooleanKey = { [K in keyof NativeSettings]: NativeSettings[K] extends boolean ? K : never }[keyof NativeSettings];
type ChoiceKey = { [K in keyof NativeSettings]: NativeSettings[K] extends string ? K : never }[keyof NativeSettings];

/** A switch for a native boolean setting. */
export function nativeToggle(ui: Ui, label: string, key: BooleanKey, o: RowOpts = {}): HTMLElement {
  return ui.toggle(
    label,
    () => state.settings[key],
    (value) => sendNativeSettings({ [key]: value }),
    o,
  );
}

/** A segmented choice for a native text setting. */
export function nativeChoice<K extends ChoiceKey>(
  ui: Ui,
  label: string,
  key: K,
  options: [NativeSettings[K] & string, string][],
  o: RowOpts = {},
): HTMLElement {
  const read = () => state.settings[key] as NativeSettings[K] & string;
  return ui.segmented(label, read, (value) => sendNativeSettings({ [key]: value }), options, o);
}

/**
 * Keeps the native rows under `root` in step with the host (Alt+Enter changes the window mode, a key flips a
 * switch), and runs `paint` for anything else they show. Stops once `root` leaves the page.
 */
export function followHost(root: HTMLElement, ui: Ui, paint: () => void = () => {}): void {
  let seen = false;
  const sync = (): void => {
    if (root.isConnected) seen = true;
    else if (seen) return void stop();
    ui.syncSwitches(root);
    for (const row of root.querySelectorAll<HTMLElement & { repaint?: () => void }>(".is-seg")) row.repaint?.();
    paint();
  };
  const stop = onNativeSettings(sync);
  queueMicrotask(sync);
}
