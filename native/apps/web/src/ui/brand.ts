// bunnyhop.lol wordmark: a "gaining speed" hop trajectory (three arcs, each higher) + the name.

export const LOGO_SVG = `<svg class="logo-mark" viewBox="0 0 64 64" aria-hidden="true"><path d="M8 47 Q14.5 33 21 47 Q29 25 37 47 Q46.5 15 56 47" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="56" cy="47" r="4.5" fill="#fff"/></svg>`;

export function wordmark(size: "xl" | "lg" | "sm" = "lg"): HTMLElement {
  const el = document.createElement("div");
  el.className = `wordmark wordmark-${size}`;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", "bunnyhop.lol");
  el.innerHTML = `${LOGO_SVG}<span class="wm-text"><span class="wm-name">bunnyhop</span><span class="wm-tld">.lol</span></span>`;
  return el;
}
