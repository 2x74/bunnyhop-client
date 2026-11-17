import {profileWriteGuard} from "./profile-write";
import { api,lastKnownMe } from "../api";
import { COUNTRIES, countryCode, flagName, PRIDE_FLAGS } from "../countries";
import { countryFlag } from "./country-flag";
import { arrowNav, h } from "./dom";
import { dismissOutside } from "./dismiss";

export interface FlagListOpts {
  selected: string | null;
  /** A flag was clicked (null: "No flag"). */
  choose(code: string | null): void;
  /** Edit card: the flag under the pointer or focused, to show on the card (undefined: none is). */
  preview?(code: string | null | undefined): void;
  /** The search field's id (the dialog's `#profile-country-search`). */
  searchId?: string;
  /** Edit card: the flags as its picker's rows (ui/profile.css .ce-item) rather than the dialog's boxes. */
  rows?: boolean;
}

export interface FlagList {
  /** "No flag" and the detected country, the search field, the flags. */
  el: HTMLFieldSetElement;
  search: HTMLInputElement;
  /** Marks `code` as the chosen flag. */
  mark(code: string | null): void;
  /** Scrolls the chosen flag into view (Edit card opens on it; it is one of 250 rows). */
  reveal(): void;
}

/**
 * The flag list both pickers share: "No flag", the country your connection suggests, a search field, every country
 * and region, then the pride flags (owner 11-07: Rainbow and Transgender only, after the countries, and not named in
 * the search field; searching "pride" still finds them). The dialog below saves on "Save flag"; Edit card → Flag
 * (ui/card-editor.ts) saves the flag you click, like the card's other parts.
 */
export function flagList(o: FlagListOpts): FlagList {
  let selected = o.selected;
  const countries = Object.entries(COUNTRIES).sort((a, b) => a[1].localeCompare(b[1]));
  const pride = Object.entries(PRIDE_FLAGS);
  const search = h<"input">(`input.nf-input.country-search${o.searchId ? `#${o.searchId}` : ""}`, { type: "search", placeholder: "Search countries and regions…", "aria-label": "Search flags", autocomplete: "off" });
  const grid = h("div.country-grid", { role: "group", "aria-label": "Country, region and pride flags" });
  const suggestion = h("div.country-suggestion");
  const none = h("button.btn.country-none", { type: "button", onclick: () => o.choose(null) }, "No flag");
  const el = h<"fieldset">("fieldset.country-controls");
  const mark = (code: string | null) => {
    selected = code;
    none.setAttribute("aria-pressed", String(selected === null));
    for (const b of grid.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String(b.dataset.country === selected));
  };
  const normalize = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const watch = (button: HTMLElement, code: string | null) => {
    if (!o.preview) return;
    button.addEventListener("pointerenter", () => o.preview!(code));
    button.addEventListener("focus", () => o.preview!(code));
  };
  const option = ([code, name]: [string, string]) => {
    const button = h(`button.country-option${o.rows ? ".ce-item" : ""}`, { type: "button", "aria-pressed": String(code === selected), onclick: () => o.choose(code) }, countryFlag(code), h("span.country-name", null, name), h("span.country-check", { "aria-hidden": "true" }, "✓"));
    button.dataset.country = code;
    watch(button, code);
    return button;
  };
  const draw = () => {
    const query = normalize(search.value.trim());
    const prideMatches = pride.filter(([, name]) => normalize(`${name} pride lgbt lgbtq queer`).includes(query));
    const matches = countries.filter(([code, name]) => normalize(`${name} ${code} ${code.startsWith("GB") ? "UK United Kingdom Britain" : ""}`).includes(query));
    grid.replaceChildren(
      ...(matches.length && prideMatches.length ? [h("p.country-group.dim", null, "Countries and regions")] : []),
      ...matches.map(option),
      ...(prideMatches.length ? [h("p.country-group.dim", null, "Pride flags"), ...prideMatches.map(option)] : []),
    );
    if (!matches.length && !prideMatches.length) grid.append(h("p.country-no-results.dim", null, "No flags found. Try another name or country code."));
    grid.scrollTop = 0;
  };
  search.addEventListener("input", draw);
  // Enter in search moves into the results instead of accidentally saving the current flag.
  search.addEventListener("keydown", (e) => {
    e.stopPropagation(); // typing is not game input
    if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); grid.querySelector<HTMLButtonElement>("button")?.focus(); }
  });
  arrowNav(grid, "button", { grid: true });
  watch(none, null);
  if (o.preview) {
    const end = () => o.preview!(undefined);
    el.addEventListener("pointerleave", end);
    el.addEventListener("focusout", (e) => !el.contains(e.relatedTarget as Node | null) && end());
  }
  el.append(h("div.country-tools", null, none, suggestion), search, grid);
  draw();
  mark(selected);
  void api.countrySettings().then(({ detected }) => {
    if (!el.isConnected || !detected || !COUNTRIES[detected]) return;
    const use = h("button.btn.country-detected", { type: "button", title: o.rows ? "Based on your connection; it may be wrong." : "Based on your connection; it may be wrong. Save to apply.", onclick: () => o.choose(detected) }, countryFlag(detected), h("span", null, h("small", null, "Use detected country"), h("span", null, COUNTRIES[detected])));
    watch(use, detected);
    suggestion.append(use);
  }).catch(() => {});
  // (The list's own scroll only: scrollIntoView would move the page too where the page scrolls.)
  const reveal = () => {
    const on = grid.querySelector<HTMLElement>('button[aria-pressed="true"]');
    if (on) grid.scrollTop += on.getBoundingClientRect().top - grid.getBoundingClientRect().top - (grid.clientHeight - on.offsetHeight) / 2;
  };
  return { el, search, mark, reveal };
}

/** Detection is a shortcut only; nothing is published until Save. A pride flag is picked instead of a country. */
export function countryPicker(current: string | null | undefined, saved: (code: string | null) => void): void {
  const writes=profileWriteGuard(lastKnownMe()?.id??"");
  let selected = countryCode(current);
  let busy = false;
  const dialog = h("dialog.acct-dialog.country-dialog", { "aria-labelledby": "country-title" });
  const close = () => { if (!busy) dialog.close(); };
  const preview = h("div.country-selected", { "aria-live": "polite" });
  const status = h("p.dim.country-status", { role: "status" });
  const save = h("button.btn.primary", { type: "submit" }, "Save flag");
  const mark = () => {
    preview.replaceChildren(countryFlag(selected) ?? h("span.country-empty", { "aria-hidden": "true" }, "∅"), h("span", null, selected ? flagName(selected) : "No flag"));
    list.mark(selected);
  };
  function choose(code: string | null) {
    if (busy) return;
    selected = code;
    status.textContent = "";
    mark();
  }
  const list = flagList({ selected, choose, searchId: "profile-country-search" });
  const controls = list.el;
  const form = h("form.acct-body", { onsubmit: async (event: Event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    controls.disabled = save.disabled = true;
    status.textContent = "Saving…";
    try {
      const result = await api.setCountry(selected,writes);
      dialog.close();
      if(!writes.current())return;
      saved(result.country);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Couldn't save your flag. Try again.";
    } finally {
      busy = false;
      controls.disabled = save.disabled = false;
    }
  } }, h("p.dim.country-intro", null, "Shown before your name on leaderboards, your player card and the server scoreboard. Pick a country or a pride flag, or leave it off."), controls, status,
  h("div.country-footer", null, preview, h("div.country-actions", null, h("button.btn", { type: "button", onclick: close }, "Cancel"), save)));
  dialog.append(h("header.acct-head", null, h("h2#country-title", null, "Profile flag"), h("button.acct-close", { type: "button", "aria-label": "Close", onclick: close }, "×")), form);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
  dismissOutside(dialog, close);
  dialog.addEventListener("keydown", (e) => e.stopPropagation());
  mark();
  document.body.append(dialog);
  dialog.showModal();
  list.search.focus();
}
