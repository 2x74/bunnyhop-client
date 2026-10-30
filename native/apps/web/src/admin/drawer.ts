// The player drawer: a click on a player's name anywhere opens them in a panel on the right instead of leaving the list
// (a modified click, a middle click or "Full page" still opens the page). The one place to judge a player quickly
// (research/ADMIN-UPLIFT.md): who they are (account, age, last seen, Discord, other accounts), what staff know (the
// pinned note, warnings, the shadowban with its source and reason, bans), how they play (rank, points, WRs, PBs and
// maps, their client, frame rate and mouse from the last runs' diagnostics), the anticheat history by outcome and rule,
// reports about and by them, and the recent runs with their replays. Every name, run, ticket and map in it is a link.
// Hovering a name fetches the player ahead of the click, so it usually opens painted. Esc closes it and the focus goes
// back to the name. It slides in 24 px with a fade; nothing behind it moves or dims (no backdrop, no blur).

import { api, ago, badge, glyph, h, may, mayShadow, me, n, plural, reroute, showAuth, NotAdmin, when, type Child, fill } from "./core";
import { activeBan, altRows, chatLines, flagEnd, listSection, modRows, nameWithShield, roleOf, runLinkRows, stateWords, type DiagRow, type FlagRow, type PlayerDetail } from "./context";
import { banDialog, kickDialog, quickMute, shadowDialog } from "./dialogs";
import { outranks } from "../moderation/staff";
import { mapArt } from "./art";
import { pinnedLine } from "./notes";
import { fbCategory } from "./inbox";

let host: HTMLElement | null = null;
let current: string | null = null;
let opener: HTMLElement | null = null;
let seq = 0;

/** Players fetched ahead of a click (hover) or just shown: reused for 20 s; an action drops the entry. */
const cache = new Map<string, { at: number; p: Promise<PlayerDetail> }>();
const FRESH_MS = 20_000;
function fetchPlayer(id: string, fresh = false): Promise<PlayerDetail> {
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < FRESH_MS) return hit.p;
  const p = api<PlayerDetail>(`/admin/players/${encodeURIComponent(id)}?lite=1`);
  cache.set(id, { at: Date.now(), p });
  p.catch(() => cache.delete(id));
  if (cache.size > 40) cache.delete(cache.keys().next().value!);
  return p;
}

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
  const hadFocus = host.contains(document.activeElement);
  host.classList.remove("in");
  const el = host;
  const done = () => (el.hidden = true);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) done();
  else setTimeout(done, 140);
  document.querySelectorAll(".pl.on").forEach((a) => a.classList.remove("on"));
  // The focus goes back to where the drawer came from (keyboard flow: Esc, then on down the list).
  if (opener?.isConnected && hadFocus) opener.focus({ preventScroll: true });
  opener = null;
}

/** Opens (or refreshes) the drawer on a player. */
export async function openDrawer(id: string, from?: HTMLElement | null, fresh = false): Promise<void> {
  const el = shell();
  const my = ++seq;
  current = id;
  if (from) opener = from;
  document.querySelectorAll(".pl.on").forEach((a) => a.classList.remove("on"));
  from?.classList.add("on");
  const p = fetchPlayer(id, fresh);
  if (el.hidden) {
    fill(el, h("div", { class: "drawer-load", role: "status", "aria-label": "Loading" }, h("i", { class: "sk-title" }), h("i", { class: "sk-figs-row" }), h("i", { class: "sk-block sm" }), h("i", { class: "sk-block" })));
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add("in");
  }
  try {
    const d = await p;
    if (my !== seq) return;
    paint(el, d);
    // From the keyboard, the drawer takes the focus (Esc, Tab through its links); from a pointer it doesn't need to.
    if (from && from === document.activeElement) el.focus({ preventScroll: true });
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
    h("button", { type: "button", class: "ghost icon", "aria-label": "Close (Esc)", title: "Close (Esc)", onclick: () => closeDrawer() }, glyph("close")),
    h("span", { class: "spacer" }),
    d ? h("a", { class: "go-link faint-link", href: `/u/${encodeURIComponent(id)}`, target: "_blank", rel: "noopener", title: "What players see" }, "Public profile", glyph("ext")) : null,
    h("a", { class: "go-link", href: `#/player/${encodeURIComponent(id)}`, onclick: () => closeDrawer() }, "Full page", glyph("arrow")),
  );
}

const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/** How they play, from the last runs' diagnostics: the client, frame rate, mouse polling and lock, frame cap, turn speed. */
function clientLine(diag: DiagRow[] | undefined): HTMLElement | null {
  if (!diag?.length) return null;
  const last = diag[0];
  const fps = median(diag.map((x) => Number(x.fps)));
  const poll = median(diag.map((x) => Number(x.poll_hz)));
  const parts: Child[] = [
    last.client ? h("b", { title: last.client.title }, last.client.label) : null,
    fps ? h("span", { title: `Median over the last ${plural(diag.length, "run")}` }, `${Math.round(fps)} fps`) : null,
    poll ? h("span", { title: "Mouse polling rate, median" }, `${poll >= 1000 ? `${Math.round(poll / 100) / 10}k` : Math.round(poll)} Hz`) : null,
    last.lock ? h("span", { title: "Pointer lock: raw input, or with OS acceleration" }, last.lock === "raw" ? "raw input" : `${last.lock} lock`) : null,
    last.cap ? h("span", null, last.vsync ? "vsync" : `cap ${last.cap}`) : null,
    last.yaw ? h("span", { title: "Turn speed (keyboard turning)" }, `turn ${last.yaw}`) : null,
  ].filter(Boolean);
  return h("div", { class: "drawer-client", title: `Last run with diagnostics ${when(last.created_at)}` }, ...parts.flatMap((p, i) => (i ? [h("span", { class: "sep", "aria-hidden": "true" }, "·"), p] : [p])));
}

/** The numbers that judge a player at a glance (tabular, one row). */
function figures(d: PlayerDetail): HTMLElement {
  const p = d.points;
  const verified = d.runStats.find((x) => x.status === "verified")?.n ?? 0;
  const fig = (label: string, value: Child, title?: string, href?: string) => h(href ? "a" : "div", { class: "dfig", title, href }, h("b", null, value), h("span", null, label));
  const id = encodeURIComponent(d.user.id);
  return h(
    "div",
    { class: "drawer-figs" },
    fig("rank", d.rank ? `#${n(d.rank)}` : "—", "All-time points board"),
    fig("points", p ? n(Math.round(p.points)) : "0"),
    fig("WRs", n(p?.wrs ?? 0), undefined, `#/runs?user=${id}`),
    fig("top 10s", n(p?.top10s ?? 0)),
    fig("PBs", n(d.boards?.pbs ?? 0), d.boards ? `PBs on ${plural(d.boards.maps, "map")}` : undefined),
    fig("maps", n(d.boards?.maps ?? 0)),
    fig("verified", n(verified), "Verified runs", `#/runs?user=${id}`),
  );
}

/** The anticheat history in one line: totals by outcome and the rules that fired most. */
function acSummary(d: PlayerDetail): HTMLElement | null {
  const t = d.flagTotals ?? [];
  const total = t.reduce((a, x) => a + x.n, 0);
  if (!total) return null;
  const sum = (f: (x: { review: string | null; auto: number }) => boolean) => t.filter(f).reduce((a, x) => a + x.n, 0);
  const open = sum((x) => x.review === null);
  const cleared = sum((x) => x.review === "cleared" || x.review === "approved");
  const actioned = sum((x) => x.review === "actioned" && !x.auto);
  const auto = sum((x) => x.review === "actioned" && !!x.auto);
  const rules = new Map<string, number>();
  for (const f of d.flags ?? []) for (const c of (f.codes ?? "").split(",").filter(Boolean)) rules.set(c, (rules.get(c) ?? 0) + 1);
  const top = [...rules].sort((a, b) => b[1] - a[1]).slice(0, 4);
  return h(
    "div",
    { class: "drawer-ac" },
    h("span", null, h("b", null, plural(total, "flag")), ": "),
    open ? badge(`${n(open)} open`, "warn") : null,
    cleared ? h("span", null, `${n(cleared)} cleared`) : null,
    actioned ? badge(`${n(actioned)} actioned`, "bad") : null,
    auto ? h("span", { class: "faint", title: "Closed on arrival: already shadowed or banned" }, `${n(auto)} closed on arrival`) : null,
    top.length ? h("span", { class: "drawer-rules", title: "Rules on the newest flags" }, top.map(([c, k]) => h("span", { class: "lbl" }, `${c}${k > 1 ? ` ×${k}` : ""}`))) : null,
  );
}

function flagLinkRows(flags: FlagRow[], max = 5): HTMLElement[] {
  return flags.slice(0, max).map((f) =>
    h(
      "a",
      { class: "ctx-row two", href: `#/suspicious?run=${encodeURIComponent(f.run_id)}` },
      h("span", { class: `score-n ${f.score >= 90 ? "hi" : f.score >= 70 ? "mid" : ""}` }, String(f.score)),
      mapArt(f.map),
      h("span", { class: "ctx-main" }, h("span", { class: "ctx-name" }, f.map, f.codes ? h("span", { class: "faint" }, ` ${f.codes.split(",").join(", ")}`) : null), h("span", { class: "ctx-sub" }, flagEnd(f), h("span", { class: "faint", title: when(f.created_at) }, ago(f.created_at)))),
    ),
  );
}

/** Ways through: their runs, chat, tickets, reports, case, Discord, and where it all is in the panel. */
function linkStrip(d: PlayerDetail): HTMLElement {
  const id = encodeURIComponent(d.user.id);
  const discord = d.identities.find((i) => i.provider === "discord");
  const l = (href: string, text: string, icon: string, ext = false, title?: string) => h("a", { class: "dlink", href, title, ...(ext ? { target: "_blank", rel: "noopener" } : {}) }, glyph(icon), text, ext ? glyph("ext") : null);
  const openFlags = (d.flagTotals ?? []).filter((x) => x.review === null).reduce((a, x) => a + x.n, 0);
  return h(
    "nav",
    { class: "drawer-links", "aria-label": "About this player" },
    l(`#/runs?user=${id}`, "Runs", "runs"),
    l(`#/chat?user=${id}`, "Chat", "chat"),
    l(`#/feedback?user=${id}`, "Their tickets", "feedback"),
    d.reports?.length ? l(`#/feedback?about=${id}`, "Reports about them", "flag") : null,
    (d.flags?.length ?? 0) || openFlags ? l(`#/suspicious?case=${id}${openFlags ? "" : "&review=all"}`, openFlags ? "Anticheat case" : "Anticheat history", "suspicious") : null,
    l(`#/log?target=${id}`, "Mod Log", "log"),
    discord?.provider_id ? l(`https://discord.com/users/${encodeURIComponent(discord.provider_id)}`, discord.username ? `@${discord.username}` : "Discord", "chat", true, "Their Discord account") : discord?.username ? h("span", { class: "dlink faint" }, `@${discord.username}`) : null,
  );
}

function paint(el: HTMLElement, d: PlayerDetail): void {
  const u = d.user;
  const target = { id: u.id, name: u.name };
  const canAct = outranks(me?.role, roleOf(d));
  const refresh = () => (current === u.id ? void openDrawer(u.id, null, true) : undefined);
  const after = (p: Promise<boolean>) => void p.then((ok) => ok && (cache.delete(u.id), refresh(), reroute()));
  const ban = activeBan(d);
  const actions: Child[] = canAct
    ? [
        may("player.mute") ? h("button", { type: "button", onclick: () => after(quickMute(target, 30)) }, glyph("mute"), "Mute 30m") : null,
        may("player.kick") ? h("button", { type: "button", onclick: () => after(kickDialog(target)) }, glyph("kick"), "Kick") : null,
        may("player.ban.temp") && !ban ? h("button", { type: "button", class: "danger", onclick: () => after(banDialog(target, { actions: d.actions })) }, glyph("ban"), "Ban…") : null,
        mayShadow(!!u.shadow_at, u.shadow_source) ? h("button", { type: "button", class: u.shadow_at ? "" : "danger", onclick: () => after(shadowDialog({ ...target, shadow_at: u.shadow_at })) }, u.shadow_at ? "Lift shadowban…" : "Shadowban…") : null,
      ]
    : [h("span", { class: "faint" }, "Staff of your rank or higher.")];
  const flags = d.flags ?? [];
  const warns = d.actions.filter((a) => a.action === "player-warn");
  const lastWarn = warns[0] ? (() => { try { return (JSON.parse(warns[0].details ?? "{}") as { reason?: string }).reason ?? null; } catch { return null; } })() : null;
  const pin = d.notes?.find((x) => x.pinned);
  const seen = d.sessions.last_seen;
  const lastRun = d.runs[0]?.created_at ?? null;
  const prevNames = [...new Set(d.names.map((x) => x.old_name).filter((x): x is string => !!x && x !== u.name))];
  const reportsBy = (d.tickets ?? []).filter((t) => t.category === "report");
  const tickets = (d.tickets ?? []).filter((t) => t.category !== "report");
  const ticketRow = (t: { id: string; status: string; message: string; created_at: number; category?: string; user_id?: string | null; user_name?: string | null }, who?: boolean) =>
    h("a", { class: "ctx-row", href: `#/feedback/${encodeURIComponent(t.id)}` }, h("span", { class: "ctx-msg" }, who ? `${t.user_name ?? "someone"}: ` : t.category ? `${fbCategory(t.category, t.message)}: ` : "", t.message.replace(/^Reported: .* for /, "").replace(/\s*\n+\s*/g, " · ")), h("span", { class: "faint ctx-when" }, t.status === "new" ? badge("new", "warn") : t.status, " ", ago(t.created_at)));
  fill(
    el,
    head(d, u.id),
    h(
      "div",
      { class: "drawer-id" },
      u.avatar_url ? h("img", { class: "av av-lg", src: u.avatar_url, alt: "", width: 44, height: 44, referrerpolicy: "no-referrer" }) : h("span", { class: "av av-lg", "aria-hidden": "true" }, (u.name[0] ?? "?").toUpperCase()),
      h("div", { class: "drawer-who" }, h("h2", null, ...nameWithShield(d)), h("div", { class: "ph-state" }, stateWords(d), seen ? h("span", { class: "faint", title: when(seen) }, `seen ${ago(seen)}`) : null)),
    ),
    // What staff know, before anything else: the shadowban (who, why), a ban, the pinned note, warnings.
    u.shadow_at
      ? h("p", { class: "drawer-flag warn" }, h("b", null, `Shadowbanned ${ago(u.shadow_at)}`), u.shadow_source ? ` by ${u.shadow_source === "admin" ? "staff" : u.shadow_source.replace(/^auto:/, "the rule ").replace(/^agent.*/, "Bun-E")}` : "", u.shadow_reason ? `: ${u.shadow_reason}` : "")
      : null,
    ban ? h("p", { class: "drawer-flag bad" }, h("b", null, ban.until ? `Banned until ${when(ban.until)}` : "Banned for good"), ban.room_id !== "*" ? ` in ${ban.room_id}` : "", ban.reason ? `: ${ban.reason}` : "") : null,
    pinnedLine(pin, "pin-line big"),
    warns.length ? h("p", { class: "drawer-flag" }, h("b", null, `Warned ${warns.length === 1 ? "once" : `${warns.length} times`}`), `, last ${ago(warns[0].created_at)}`, lastWarn ? `: ${lastWarn}` : "") : null,
    h("div", { class: "actions drawer-acts" }, actions),
    figures(d),
    clientLine(d.diag),
    h("p", { class: "drawer-activity faint" }, lastRun ? h("span", { title: when(lastRun) }, `last run ${ago(lastRun)}`) : "no runs yet", d.chat[0] ? h("span", { title: when(d.chat[0].created_at) }, `, last chat ${ago(d.chat[0].created_at)}`) : null, `, joined ${ago(u.created_at)}`, d.sessions.sessions ? `, ${plural(d.sessions.sessions, "open session")}` : ""),
    linkStrip(d),
    flags.length || acSummary(d) ? listSection("Anticheat", flagLinkRows(flags, 5), "No flags.", acSummary(d)) : null,
    listSection("Recent runs", runLinkRows(d.runs, 6), "No runs."),
    d.reports?.length ? listSection("Reported by players", d.reports.slice(0, 4).map((t) => ticketRow(t, true)), "") : null,
    reportsBy.length ? listSection("Their reports on others", reportsBy.slice(0, 3).map((t) => ticketRow(t)), "") : null,
    tickets.length ? listSection("Their tickets", tickets.slice(0, 3).map((t) => ticketRow(t)), "") : null,
    listSection("Other accounts", altRows(d), "None seen."),
    listSection("Chat", chatLines(d.chat, 6), "No chat.", h("a", { class: "go-link h-link", href: `#/chat?user=${encodeURIComponent(u.id)}` }, "All", glyph("arrow"))),
    listSection("Moderation", modRows(d.actions, 5), "Nothing on record.", d.actions.length > 5 ? h("a", { class: "go-link h-link", href: `#/log?target=${encodeURIComponent(u.id)}` }, "All", glyph("arrow")) : null),
    prevNames.length ? h("p", { class: "drawer-names faint" }, "Was ", prevNames.slice(0, 5).map((x, i) => [i ? ", " : "", h("b", null, x)]), prevNames.length > 5 ? ` and ${prevNames.length - 5} more` : "") : null,
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
  // Hovering (or tabbing to) a name for a moment fetches the player, so the drawer usually opens already painted.
  let hover = 0;
  const ahead = (e: Event) => {
    const a = (e.target as HTMLElement).closest?.("a.pl[data-player]") as HTMLAnchorElement | null;
    clearTimeout(hover);
    if (a?.dataset.player) hover = window.setTimeout(() => void fetchPlayer(a.dataset.player!).catch(() => undefined), 120);
  };
  document.addEventListener("pointerover", ahead);
  document.addEventListener("focusin", ahead);
  addEventListener("hashchange", () => {
    // Leaving for another page closes it; the drawer's own links (a flag, a ticket) do too.
    closeDrawer();
  });
}
