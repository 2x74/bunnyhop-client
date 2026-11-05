import "./country.css";
import "flag-icons/css/flag-icons.min.css";
import { countryCode, flagName, isPrideFlag } from "../countries";
import { h } from "./dom";
import { prideFlagCss } from "./pride-flags";

let prideCss = false;

/** The profile flag before a name (a country, region or pride flag), or null for none or a code this build doesn't know. */
export function countryFlag(value: string | null | undefined): HTMLElement | null {
  const code = countryCode(value);
  if (!code) return null;
  if (isPrideFlag(code) && !prideCss) {
    prideCss = true;
    document.head.append(h("style#pride-flags", null, prideFlagCss()));
  }
  return h(`span.fi.fi-${code.toLowerCase()}.country-flag`, { role: "img", "aria-label": flagName(code), title: flagName(code) });
}
