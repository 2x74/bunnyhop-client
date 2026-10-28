import { SITE_ORIGIN, WAVEDASH } from "../platform/env";
import { h } from "./dom";
import "./legal.css";

/** Static documents live on the website, including when the game is in Wavedash's frame. */
export const legalHref = (path: "/privacy" | "/terms" | "/terms#refunds" | "/credits"): string => WAVEDASH ? SITE_ORIGIN + path : path;

export function legalLinks(): HTMLElement {
  return h("nav.menu-legal", { "aria-label": "Legal" },
    h("a", { href: legalHref("/privacy"), target: "_blank", rel: "noopener" }, "Privacy"),
    h("a", { href: legalHref("/terms"), target: "_blank", rel: "noopener" }, "Terms"),
    h("a", { href: legalHref("/credits"), target: "_blank", rel: "noopener" }, "Credits"),
  );
}
