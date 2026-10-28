// The admin's command palette and keyboard shortcuts.
//   /  or  Cmd/Ctrl+K   open the palette: sections and their tabs, saved views (Player replied, Verify errors, ...),
//                       players by name or id (GET /admin/players), maps (GET /maps, opens their runs). Up / down,
//                       Enter, Esc.
//   g then a letter      go to a section: q l a p i b u s (the letters show in the rail while g is held: body.goto)
//   ?                    the palette, which lists the shortcuts in its foot
// Only sections and views the viewer may open are offered (the caller filters by the staff matrix). Plain DOM; user
// text (player names) only through textContent.

import { glyph } from "./glyphs";

export interface PaletteDeps {
  /** The sections and their tabs the viewer may open, in rail order: label, glyph, where it goes, its g-key. */
  tabs: () => { id: string; label: string; icon: string; href: string; key?: string }[];
  api: <T>(path: string) => Promise<T>;
  /** The API base, for the public map list. */
  base: string;
  /** Whether the viewer may open a view id. */
  canOpen: (tab: string) => boolean;
  /** g + key: where the key goes for this viewer (null: nothing). */
  goto: (key: string) => string | null;
}

/** g + key: the section each key opens (main.ts SECTIONS carries the same letters). */
export const GOTO_KEYS = ["q", "l", "a", "p", "i", "b", "u", "s"];

/** Saved views: [view it belongs to, label, hash]. */
const VIEWS: [string, string, string][] = [
  ["feedback", "Feedback the player replied to", "#/feedback?reply=player"],
  ["feedback", "New feedback", "#/feedback?status=new"],
  ["feedback", "Feedback awaiting a reply", "#/feedback?reply=awaiting"],
  ["runs", "Runs that failed to verify", "#/runs?status=error"],
  ["runs", "Runs in the verify queue", "#/runs?status=queued"],
  ["runs", "Runs with a client desync", "#/runs?selfCheck=mismatch"],
  ["runs", "Paste run ids", "#/runs?paste=1"],
  ["suspicious", "Flags nobody has reviewed", "#/suspicious"],
  ["chat", "Filtered, blocked or muted chat", "#/chat?flag=flagged"],
  ["log", "Bans in the moderation log", "#/log?action=ban"],
  ["supporters", "Give a badge to many players", "#/supporters?bulk=1"],
];

interface Item {
  group: string;
  label: string;
  sub?: string;
  icon: string;
  href: string;
  key?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_.-]+/g, "");
/** 0 = no match; higher = better (prefix > word start > anywhere). */
function score(text: string, q: string): number {
  if (!q) return 1;
  const t = norm(text);
  const k = norm(q);
  if (!k) return 1;
  if (t.startsWith(k)) return 3;
  if (text.toLowerCase().split(/[\s_.-]+/).some((w) => w.startsWith(q.toLowerCase()))) return 2;
  return t.includes(k) ? 1 : 0;
}

export function installPalette(d: PaletteDeps): { open: (q?: string) => void } {
  const dlg = document.createElement("dialog");
  dlg.className = "palette";
  dlg.setAttribute("aria-label", "Go to");
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Go to a section, a player or a map";
  input.setAttribute("aria-label", "Search");
  input.setAttribute("aria-controls", "pal-list");
  input.autocomplete = "off";
  input.spellcheck = false;
  const esc = document.createElement("kbd");
  esc.textContent = "esc";
  const top = document.createElement("div");
  top.className = "pal-top";
  top.append(glyph("search"), input, esc);
  const list = document.createElement("div");
  list.className = "pal-list";
  list.id = "pal-list";
  list.setAttribute("role", "listbox");
  const foot = document.createElement("div");
  foot.className = "pal-foot";
  const hint = (k: string[], t: string) => {
    const span = document.createElement("span");
    for (const x of k) {
      const kb = document.createElement("kbd");
      kb.textContent = x;
      span.append(kb);
    }
    span.append(t);
    return span;
  };
  foot.append(hint(["↑", "↓"], "move"), hint(["enter"], "open"), hint(["g", "q"], "and a letter: go to a section"));
  dlg.append(top, list, foot);
  document.body.append(dlg);
  dlg.addEventListener("click", (e) => e.target === dlg && dlg.close());

  let items: Item[] = [];
  let sel = 0;
  let players: Item[] = [];
  let maps: { name: string; tier: number | null }[] | null = null;
  let seq = 0;
  let timer = 0;

  const go = (href: string) => {
    dlg.close();
    if (location.hash === href) window.dispatchEvent(new HashChangeEvent("hashchange"));
    else location.hash = href;
  };

  function paint(): void {
    const q = input.value.trim();
    const tabs = q ? d.tabs() : d.tabs().filter((t) => t.key);
    const sections: Item[] = tabs
      .map((t) => ({ group: "Sections", label: t.label, icon: t.icon, href: t.href, key: t.key, s: score(t.label, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    const views: Item[] = VIEWS.filter(([tab, label]) => d.canOpen(tab) && score(label, q) > 0).map(([tab, label, href]) => ({ group: "Views", label, icon: tab, href }));
    const mapItems: Item[] =
      q.length >= 2 && maps && d.canOpen("runs")
        ? maps
            .map((m) => ({ m, s: score(m.name, q) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s || a.m.name.localeCompare(b.m.name))
            .slice(0, 5)
            .map(({ m }) => ({ group: "Maps", label: m.name, sub: `${m.tier ? `Tier ${m.tier}, ` : ""}its runs`, icon: "map", href: `#/runs?map=${encodeURIComponent(m.name)}` }))
        : [];
    items = [...sections, ...(q ? players : []), ...views.slice(0, q ? 6 : 4), ...mapItems];
    if (sel >= items.length) sel = Math.max(0, items.length - 1);
    list.replaceChildren();
    let group = "";
    items.forEach((it, i) => {
      if (it.group !== group) {
        group = it.group;
        const g = document.createElement("div");
        g.className = "pal-group";
        g.textContent = group;
        list.append(g);
      }
      const row = document.createElement("a");
      row.className = `pal-item${i === sel ? " on" : ""}`;
      row.href = it.href;
      row.id = `pal-${i}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === sel));
      const label = document.createElement("span");
      label.className = "pal-label";
      label.textContent = it.label;
      if (it.sub) {
        const sub = document.createElement("span");
        sub.className = "pal-sub";
        sub.textContent = it.sub;
        label.append(sub);
      }
      row.append(glyph(it.icon), label);
      if (it.key) {
        const k = document.createElement("span");
        k.className = "pal-keys";
        for (const x of ["g", it.key]) {
          const kb = document.createElement("kbd");
          kb.textContent = x;
          k.append(kb);
        }
        row.append(k);
      }
      row.addEventListener("click", (e) => (e.preventDefault(), go(it.href)));
      row.addEventListener("pointermove", () => {
        if (sel === i) return;
        sel = i;
        list.querySelectorAll(".pal-item").forEach((n, k) => (n.classList.toggle("on", k === i), n.setAttribute("aria-selected", String(k === i))));
      });
      list.append(row);
    });
    if (!items.length) {
      const e = document.createElement("div");
      e.className = "pal-empty";
      e.textContent = q.length < 2 ? "Type a name, an id or a map." : `Nothing matches "${q}".`;
      list.append(e);
    }
    input.setAttribute("aria-activedescendant", items.length ? `pal-${sel}` : "");
  }

  async function lookup(): Promise<void> {
    const q = input.value.trim();
    const mine = ++seq;
    if (q.length < 2 || !d.canOpen("players")) {
      players = [];
      return paint();
    }
    try {
      const r = await d.api<{ players: { id: string; name: string; provider: string; banned: number }[] }>(`/admin/players?q=${encodeURIComponent(q)}`);
      if (mine !== seq) return;
      players = r.players.slice(0, 6).map((p) => ({ group: "Players", label: p.name, sub: `${p.provider}${p.banned ? ", banned" : ""}`, icon: "players", href: `#/player/${encodeURIComponent(p.id)}` }));
    } catch {
      players = [];
    }
    paint();
  }

  input.addEventListener("input", () => {
    sel = 0;
    paint();
    clearTimeout(timer);
    timer = window.setTimeout(() => void lookup(), 160);
  });
  input.addEventListener("keydown", (e) => {
    // A search field's Escape would only clear the text; here it closes the palette.
    if (e.key === "Escape") {
      e.preventDefault();
      dlg.close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      paint();
      list.querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[sel];
      if (it) go(it.href);
    }
  });

  const open = (q = "") => {
    if (dlg.open) return;
    input.value = q;
    sel = 0;
    players = [];
    paint();
    dlg.showModal();
    input.focus();
    if (!maps)
      void fetch(`${d.base}/maps`)
        .then((r) => r.json() as Promise<{ name: string; tier: number | null }[]>)
        .then((m) => {
          maps = Array.isArray(m) ? m.map((x) => ({ name: x.name, tier: x.tier })) : [];
          if (dlg.open) paint();
        })
        .catch(() => (maps = []));
  };

  addEventListener("hashchange", () => dlg.open && dlg.close());

  // Shortcuts. Never while typing in a field, nor with a dialog open (except the palette's own keys above).
  let pending = 0;
  const clearGoto = () => {
    clearTimeout(pending);
    pending = 0;
    document.body.classList.remove("goto");
  };
  document.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    const typing = t.closest("input, textarea, select, [contenteditable=true]");
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      return dlg.open ? dlg.close() : open();
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]")) return clearGoto();
    if (pending) {
      const href = d.goto(e.key.toLowerCase());
      clearGoto();
      if (href) {
        e.preventDefault();
        location.hash = href;
      }
      return;
    }
    if (e.key === "/" || e.key === "?") {
      e.preventDefault();
      open();
    } else if (e.key === "g") {
      document.body.classList.add("goto");
      pending = window.setTimeout(clearGoto, 1500);
    }
  });
  return { open };
}
