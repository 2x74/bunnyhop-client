import "./country.css";
import "flag-icons/css/flag-icons.min.css";
import { COUNTRIES, countryCode } from "../countries";
import { h } from "./dom";

export function countryFlag(value: string | null | undefined): HTMLElement | null {
  const code = countryCode(value);
  return code ? h(`span.fi.fi-${code.toLowerCase()}.country-flag`, { role: "img", "aria-label": COUNTRIES[code], title: COUNTRIES[code] }) : null;
}
