import "./country.css";
import { countryCode, flagName, isPrideFlag } from "../countries";
import { h } from "./dom";
import { prideFlagCss } from "./pride-flags";

let prideCss = false;
let flags: Promise<unknown> | null = null;

/**
 * The flags' stylesheet (flag-icons, its flag images inside: 424 KB), loaded with the first screen that shows flags
 * rather than with every page. main.ts starts it ahead of the home screen and the in-game menu's boards.
 */
export function loadFlags(): Promise<unknown> {
  return (flags ??= import("flag-icons/css/flag-icons.min.css").catch(() => void (flags = null)));
}

/** The profile flag before a name (a country, region or pride flag), or null for none or a code this build doesn't know. */
export function countryFlag(value: string | null | undefined): HTMLElement | null {
  const code = countryCode(value);
  if (!code) return null;
  void loadFlags();
  if (isPrideFlag(code) && !prideCss) {
    prideCss = true;
    document.head.append(h("style#pride-flags", null, prideFlagCss()));
  }
  return h(`span.fi.fi-${code.toLowerCase()}.country-flag`, { role: "img", "aria-label": flagName(code), title: flagName(code) });
}
