// The player drawer: a click on a player's name anywhere opens them in a 420 px panel on the right instead of leaving
// the list (a modified click, a middle click or "Open full page" still opens the page). States, flags, the last runs,
// chat and moderation, and the quick actions. Esc closes it. It slides in 24 px with a fade; nothing behind it moves or
// dims (no backdrop, no blur).

import { api, ago, glyph, h, may, mayShadow, me, reroute, showAuth, NotAdmin, type Child, fill } from "./core";
import { altRows, activeBan, chatLines, flagRows, listSection, modRows, nameWithShield, roleOf, runRows, standing, stateWords, type PlayerDetail } from "./context";
import { banDialog, kickDialog, quickMute, shadowDialog } from "./dialogs";
import { outranks } from "../moderation/staff";

let host: HTMLElement | null = null;
let current: string | null = null;
let seq = 0;

function shell(): HTMLElement {
  if (host) return host;
  host = h("aside", { class: "drawer", id: "drawer", role: "dialog", "aria-label": "Player", hidden: true, tabindex: "-1" });
  document.body.append(host);
  host.addEventListener("keydown", (e) => e.key === "Escape" && (e.stopPropagation(), closeDrawer()));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && host && !host.hidden && !document.querySelector("dialog[open]")) closeDrawer();
  });
  return host;
}

export function drawerOpen(): boolean {
  return !!host && !host.hidden;
}

export function closeDrawer(): void {
  if (!host || host.hidden) return;
  current = null;
  host.classList.remove("in");
  const el = host;
  const done = () => (el.hidden = true);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) done();
  else setTimeout(done, 160);
  document.querySelectorAll(".pl.on").forEach((a) => a.classList.remove("on"));
}

/** Opens (or refreshes) the drawer on a player. */
export async function openDrawer(id: string, from?: HTMLElement | null): Promise<void> {
  const el = shell();
  const my = ++seq;
  current = id;
  document.querySelectorAll(".pl.on").forEach((a) => a.classList.remove("on"));
  from?.classList.add("on");
  if (el.hidden) {
    fill(el, h("div", { class: "drawer-load" }, h("i", { class: "sk-title" }), h("i", { class: "sk-block sm" })));
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add("in");
  }
  try {
    const d = await api<PlayerDetail>(`/admin/players/${encodeURIComponent(id)}?lite=1`);
    if (my !== seq) return;
    paint(el, d);
  } catch (e) {
    if (e instanceof NotAdmin) return showAuth();
    if (my !== seq) return;
    fill(el, head(null, id), h("p", { class: "err" }, `Couldn't load this player: ${(e as Error).message}`));
  }
}

function head(d: PlayerDetail | null, id: string): HTMLElement {
  return h(
    "div",
    { class: "drawer-head" },
    h("button", { type: "button", class: "ghost icon", "aria-label": "Close", onclick: () => closeDrawer() }, glyph("close")),
    h("a", { class: "go-link", href: `#/player/${encodeURIComponent(id)}`, onclick: () => closeDrawer() }, "Open full page", glyph("arrow")),
    d ? null : h("span", null),
  );
}

function paint(el: HTMLElement, d: PlayerDetail): void {
  const u = d.user;
  const target = { id: u.id, name: u.name };
  const canAct = outranks(me?.role, roleOf(d));
  const refresh = () => (current === u.id ? void openDrawer(u.id) : undefined);
  const after = (p: Promise<boolean>) => void p.then((ok) => ok && (refresh(), reroute()));
  const actions: Child[] = canAct
    ? [
        may("player.mute") ? h("button", { type: "button", onclick: () => after(quickMute(target, 30)) }, glyph("mute"), "Mute 30m") : null,
        may("player.kick") ? h("button", { type: "button", onclick: () => after(kickDialog(target)) }, glyph("kick"), "Kick") : null,
        may("player.ban.temp") && !activeBan(d) ? h("button", { type: "button", class: "danger", onclick: () => after(banDialog(target, { actions: d.actions })) }, glyph("ban"), "Ban…") : null,
        mayShadow(!!u.shadow_at, u.shadow_source) ? h("button", { type: "button", class: u.shadow_at ? "" : "danger", onclick: () => after(shadowDialog({ ...target, shadow_at: u.shadow_at })) }, u.shadow_at ? "Lift shadowban" : "Shadowban…") : null,
      ]
    : [h("span", { class: "faint" }, "Staff of your rank or higher.")];
  const flags = d.flags ?? [];
  fill(el, 
    head(d, u.id),
    h(
      "div",
      { class: "drawer-id" },
      u.avatar_url ? h("img", { class: "av av-lg", src: u.avatar_url, alt: "", width: 44, height: 44, referrerpolicy: "no-referrer" }) : h("span", { class: "av av-lg", "aria-hidden": "true" }, (u.name[0] ?? "?").toUpperCase()),
      h("div", null, h("h2", null, ...nameWithShield(d)), h("div", { class: "ph-state" }, stateWords(d))),
    ),
    h("p", { class: "drawer-standing" }, standing(d)),
    h("div", { class: "actions drawer-acts" }, actions),
    listSection("Flags", flagRows(flags, 5), "No flags."),
    listSection("Runs", runRows(d.runs, 5), "No runs."),
    listSection("Chat", chatLines(d.chat, 10), "No chat."),
    listSection("Other accounts", altRows(d), "None seen."),
    listSection("Moderation", modRows(d.actions, 5), "Nothing on record."),
    d.reports?.length ? listSection("Reported by players", d.reports.slice(0, 3).map((t) => h("a", { class: "ctx-row", href: `#/feedback/${encodeURIComponent(t.id)}` }, h("span", { class: "ctx-msg" }, `${t.user_name ?? "someone"}: ${t.message.replace(/^Reported: .* for /, "").replace(/\s*\n+\s*/g, " · ")}`), h("span", { class: "faint ctx-when" }, ago(t.created_at)))), "") : null,
    d.tickets?.length ? listSection("Feedback", d.tickets.slice(0, 3).map((t) => h("a", { class: "ctx-row", href: `#/feedback/${encodeURIComponent(t.id)}` }, h("span", { class: "ctx-msg" }, t.message), h("span", { class: "faint ctx-when" }, ago(t.created_at)))), "") : null,
  );
}

/**
 * Player names open the drawer (core.ts playerLink: a.pl[data-player]). Not on the player's own page, and not for a
 * modified or middle click, which keep the link's normal behaviour.
 */
export function installDrawer(): void {
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest?.("a.pl[data-player]") as HTMLAnchorElement | null;
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.closest(".drawer") && a.dataset.player === current) return;
    e.preventDefault();
    if (current === a.dataset.player && drawerOpen()) return closeDrawer();
    void openDrawer(a.dataset.player!, a);
  });
  addEventListener("hashchange", () => {
    // Leaving for another page closes it; the drawer's own links (a flag, a ticket) do too.
    closeDrawer();
  });
}
