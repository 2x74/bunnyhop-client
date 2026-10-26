import {profileWriteGuard} from "./profile-write";
import { api,lastKnownMe } from "../api";
import { COUNTRIES, countryCode } from "../countries";
import { countryFlag } from "./country-flag";
import { arrowNav, h } from "./dom";
import { dismissOutside } from "./dismiss";

/** Detection is a shortcut only; nothing is published until Save. */
export function countryPicker(current: string | null | undefined, saved: (code: string | null) => void): void {
  const writes=profileWriteGuard(lastKnownMe()?.id??"");
  let selected = countryCode(current);
  let busy = false;
  const countries = Object.entries(COUNTRIES).sort((a, b) => a[1].localeCompare(b[1]));
  const dialog = h("dialog.acct-dialog.country-dialog", { "aria-labelledby": "country-title" });
  const close = () => { if (!busy) dialog.close(); };
  const search = h<"input">("input.nf-input.country-search#profile-country-search", { type: "search", placeholder: "Search countries and regions…", "aria-label": "Search flags", autocomplete: "off" });
  const grid = h("div.country-grid", { role: "group", "aria-label": "Country and region flags" });
  const preview = h("div.country-selected", { "aria-live": "polite" });
  const status = h("p.dim.country-status", { role: "status" });
  const suggestion = h("div.country-suggestion");
  const save = h("button.btn.primary", { type: "submit" }, "Save flag");
  const none = h("button.btn.country-none", { type: "button", onclick: () => choose(null) }, "No flag");
  const controls = h("fieldset.country-controls");
  const mark = () => {
    preview.replaceChildren(countryFlag(selected) ?? h("span.country-empty", { "aria-hidden": "true" }, "∅"), h("span", null, selected ? COUNTRIES[selected] : "No flag"));
    none.setAttribute("aria-pressed", String(selected === null));
    for (const b of grid.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-pressed", String(b.dataset.country === selected));
  };
  function choose(code: string | null) {
    if (busy) return;
    selected = code;
    status.textContent = "";
    mark();
  }
  const normalize = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const draw = () => {
    const query = normalize(search.value.trim());
    const matches = countries.filter(([code, name]) => normalize(`${name} ${code} ${code.startsWith("GB") ? "UK United Kingdom Britain" : ""}`).includes(query));
    grid.replaceChildren(...matches.map(([code, name]) => {
      const button = h("button.country-option", { type: "button", "aria-pressed": String(code === selected), onclick: () => choose(code) }, countryFlag(code), h("span.country-name", null, name), h("span.country-check", { "aria-hidden": "true" }, "✓"));
      button.dataset.country = code;
      return button;
    }));
    if (!matches.length) grid.append(h("p.country-no-results.dim", null, "No flags found. Try another name or country code."));
    grid.scrollTop = 0;
  };
  search.addEventListener("input", draw);
  // Enter in search moves into the results instead of accidentally saving the current flag.
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); grid.querySelector<HTMLButtonElement>("button")?.focus(); }
  });
  arrowNav(grid, "button", { grid: true });
  controls.append(h("div.country-tools", null, none, suggestion), search, grid);
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
  } }, h("p.dim.country-intro", null, "Shown before your name on leaderboards, your player card and the server scoreboard. Pick any flag, or leave it off."), controls, status,
  h("div.country-footer", null, preview, h("div.country-actions", null, h("button.btn", { type: "button", onclick: close }, "Cancel"), save)));
  dialog.append(h("header.acct-head", null, h("h2#country-title", null, "Profile flag"), h("button.acct-close", { type: "button", "aria-label": "Close", onclick: close }, "×")), form);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
  dismissOutside(dialog, close);
  dialog.addEventListener("keydown", (e) => e.stopPropagation());
  draw();
  mark();
  document.body.append(dialog);
  dialog.showModal();
  search.focus();
  void api.countrySettings().then(({ detected }) => {
    if (!dialog.isConnected || !detected || !COUNTRIES[detected]) return;
    suggestion.append(h("button.btn.country-detected", { type: "button", title: "Based on your connection; it may be wrong. Save to apply.", onclick: () => choose(detected) }, countryFlag(detected), h("span", null, h("small", null, "Use detected country"), h("span", null, COUNTRIES[detected]))));
  }).catch(() => {});
}
