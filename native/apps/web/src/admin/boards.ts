// Boards: what players see on boards and profiles. Records (current WRs and the Discord feed: records.ts), Maps and
// tiers (every map with its art, tier in the tier colour, ranked or retired, finishers, the WR, open flags and feedback;
// the owner changes a tier or retires a map, confirmed, logged, with Undo), and Supporters and badges (who supports the
// game, and badges or Supporter for many players at once by pasting their names).

import { act, api, ask, idCell, badge, emptyLine, fmtTime, glyph, h, help, may, money, n, playerLink, plural, reroute, setKeys, specialIcon, stepRows, table, timeCell, toast, undoCall, type View, fill } from "./core";
import { recordsView } from "./records";
import { mapArt, tierTag } from "./art";
import { clampTier, MAX_TIER, TIERS, tierLabel } from "../tiers";
import { SPECIAL_BADGES } from "../creators";

export const recordsView2: View = recordsView({ h, api, act, toast, badge, playerLink, timeCell, fmtTime });

// --- Maps and tiers

interface MapRow {
  name: string;
  title: string;
  tier: number | null;
  ranked: boolean;
  retired: boolean;
  zoned: boolean;
  rescoring: boolean;
  finishers: number;
  wr: { name: string; userId: string; time: number | null } | null;
  flags: number;
  feedback: number;
}

type Filter = "all" | "ranked" | "unranked" | "retired" | "flags";

export const mapsView: View = async (root, params) => {
  const r = await api<{ maps: MapRow[] }>("/admin/maps");
  const manage = may("maps.manage");
  const q = h("input", { type: "search", placeholder: "map name", value: params.get("q") ?? "", "aria-label": "Find a map" });
  let filter = (params.get("show") as Filter) || "all";
  let tierF = params.get("tier") ?? "";
  const body = h("tbody");
  const count = h("span", { class: "sub" });
  const state = (m: MapRow) =>
    m.rescoring ? badge("re-scoring", "warn") : m.retired ? badge("retired", "") : !m.zoned ? h("span", { class: "faint" }, "no zones") : m.ranked ? h("span", { class: "faint" }, "ranked") : badge("unranked");

  const setTier = async (m: MapRow, sel: HTMLSelectElement) => {
    const to = sel.value === "" ? null : Number(sel.value);
    if (to === m.tier) return;
    const ok = await ask({
      title: `${m.name}: T${m.tier ?? "?"} to T${to ?? "?"}?`,
      text: `Every board on this map is re-scored, so ${plural(m.finishers, "player")}'s points change. Logged.`,
      confirm: "Change tier",
      danger: true,
    });
    if (!ok) return void (sel.value = m.tier === null ? "" : String(m.tier));
    const from = m.tier;
    const res = await act<{ tier: number | null; rescoring: boolean }>("/admin/maps", { action: "tier", map: m.name, tier: to }, `${m.name} is T${to ?? "?"} now; re-scoring`, {
      run: async () => (await undoCall("/admin/maps", { action: "tier", map: m.name, tier: from }, `${m.name} is T${from ?? "?"} again`)) && reroute(),
    });
    if (!res) return void (sel.value = m.tier === null ? "" : String(m.tier));
    m.tier = res.tier;
    m.rescoring = res.rescoring;
    paint();
  };
  const setRetired = async (m: MapRow) => {
    const retire = !m.retired;
    const v = await ask({
      title: retire ? `Retire ${m.name}?` : `Put ${m.name} back on the ranked boards?`,
      text: retire
        ? "It leaves the ranked boards: no new ranked runs, and points from it are re-scored away. Nothing is deleted. It stays in the map list until the next content deploy drops it."
        : "It counts again for points; its boards are re-scored.",
      fields: retire ? [{ name: "reason", label: "Why", kind: "text" }] : [],
      confirm: retire ? "Retire" : "Put back",
      danger: retire,
    });
    if (!v) return;
    const res = await act<{ ranked: boolean; rescoring: boolean }>("/admin/maps", { action: "ranked", map: m.name, ranked: !retire, reason: v.reason || null }, retire ? `${m.name} retired` : `${m.name} is back`, {
      run: async () => (await undoCall("/admin/maps", { action: "ranked", map: m.name, ranked: retire }, "Undone")) && reroute(),
    });
    if (!res) return;
    m.retired = !res.ranked;
    m.ranked = res.ranked && m.zoned;
    m.rescoring = res.rescoring;
    paint();
  };

  const row = (m: MapRow) => {
    const tierCell = manage
      ? (() => {
          const sel = h("select", { class: `tier-sel t${clampTier(m.tier) ?? "x"}`, "aria-label": `Tier of ${m.name}` }, h("option", { value: "", selected: m.tier === null }, "T?"), [...TIERS, ...(m.tier && m.tier > MAX_TIER ? [m.tier] : [])].map((t) => h("option", { value: String(t), selected: m.tier === t }, t > MAX_TIER ? `T${t}` : tierLabel(t))));
          sel.onchange = () => void setTier(m, sel);
          return sel;
        })()
      : tierTag(m.tier);
    return h(
      "tr",
      { "data-map": m.name, class: m.retired ? "retired" : "" },
      h("td", null, h("span", { class: "map-line" }, mapArt(m.name), h("a", { class: "map-name", href: `/maps/${encodeURIComponent(m.name)}`, target: "_blank", rel: "noopener" }, m.name)), m.title && m.title !== m.name ? h("div", { class: "faint" }, m.title) : null),
      h("td", null, tierCell),
      h("td", null, state(m)),
      h("td", { class: "num" }, m.finishers ? n(m.finishers) : h("span", { class: "faint" }, "0")),
      h("td", null, m.wr ? [h("span", { class: "t-run" }, fmtTime(m.wr.time)), " ", playerLink(m.wr.userId, m.wr.name)] : h("span", { class: "faint" }, "—")),
      h("td", { class: "num" }, m.flags ? h("a", { class: "warn-text", href: `#/runs?map=${encodeURIComponent(m.name)}` }, String(m.flags)) : h("span", { class: "faint" }, "0")),
      h("td", { class: "num" }, m.feedback ? h("a", { href: `#/feedback?map=${encodeURIComponent(m.name)}&status=open` }, String(m.feedback)) : h("span", { class: "faint" }, "0")),
      h("td", { class: "acts" }, h("span", { class: "hover-acts" }, manage ? h("button", { class: `small ghost${m.retired ? "" : " danger-text"}`, onclick: () => void setRetired(m) }, m.retired ? "Put back…" : "Retire…") : null, h("a", { class: "btn small ghost", href: `/?map=${encodeURIComponent(m.name)}`, target: "_blank", rel: "noopener" }, glyph("play"), "Play"))),
    );
  };
  const visible = () => {
    const t = q.value.trim().toLowerCase();
    return r.maps.filter(
      (m) =>
        (!t || m.name.toLowerCase().includes(t) || m.title.toLowerCase().includes(t)) &&
        (!tierF || String(clampTier(m.tier) ?? "x") === tierF) &&
        (filter === "all" || (filter === "ranked" && m.ranked) || (filter === "unranked" && !m.ranked && !m.retired) || (filter === "retired" && m.retired) || (filter === "flags" && (m.flags > 0 || m.feedback > 0))),
    );
  };
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Show" });
  const tiers = h("div", { class: "seg tiers", role: "group", "aria-label": "Tier" });
  const paint = () => {
    const list = visible();
    fill(body, ...(list.length ? list.map(row) : [h("tr", null, h("td", { colspan: "8", class: "empty" }, "No maps match."))]));
    count.textContent = `${plural(list.length, "map")}${list.length !== r.maps.length ? ` of ${r.maps.length}` : ""}`;
    const counts: Record<Filter, number> = { all: r.maps.length, ranked: r.maps.filter((m) => m.ranked).length, unranked: r.maps.filter((m) => !m.ranked && !m.retired).length, retired: r.maps.filter((m) => m.retired).length, flags: r.maps.filter((m) => m.flags || m.feedback).length };
    fill(seg, 
      ...(["all", "ranked", "unranked", "retired", "flags"] as Filter[]).map((f) =>
        h("button", { type: "button", class: f === "flags" && counts.flags ? "hot" : "", "aria-pressed": String(filter === f), onclick: () => ((filter = f), paint()) }, { all: "All", ranked: "Ranked", unranked: "Unranked", retired: "Retired", flags: "With reports" }[f], h("b", null, n(counts[f]))),
      ),
    );
    fill(tiers, 
      ...["", ...TIERS.map(String), "x"].map((t) => h("button", { type: "button", class: t ? `t${t}` : "", "aria-pressed": String(tierF === t), onclick: () => ((tierF = tierF === t ? "" : t), paint()) }, t ? (t === "x" ? "T?" : tierLabel(Number(t))) : "Any")),
    );
  };
  q.addEventListener("input", paint);
  fill(root, 
    h("div", { class: "view-bar" }, count, h("div", { class: "tools" }, seg)),
    h(
      "div",
      { class: "filters" },
      h("label", null, "Find", q),
      tiers,
      help(manage ? "Changing a tier or retiring a map re-scores every board on it (the same path the deploy SQL used). The state reads re-scoring until it's done, usually within a minute. Retiring takes a map off the ranked boards; dropping it from the map list is still a content deploy." : "The owner changes tiers and retires maps."),
    ),
    h("div", { class: "tablewrap" }, h("table", { class: "maps-table" }, h("thead", null, h("tr", null, ["Map", "Tier", "State", "Finishers", "World record", "Flags", "Feedback", ""].map((t) => h("th", { class: t === "Finishers" || t === "Flags" || t === "Feedback" ? "num" : undefined }, t)))), body)),
  );
  paint();
  const rows = () => [...body.querySelectorAll<HTMLElement>("tr[data-map]")];
  setKeys({ j: () => void stepRows(rows(), 1), k: () => void stepRows(rows(), -1), "/": () => q.focus() });
};

// --- Supporters and badges

interface Resolved {
  q: string;
  id?: string;
  name?: string;
  merged?: boolean;
  provider?: string | null;
  special?: string[];
  supporter?: boolean;
  error?: string;
}

/** Badges and gifts for many players: paste names, check who they are, then give or take a badge (or gift Supporter). */
function bulkCard(open: boolean): HTMLElement {
  const text = h("textarea", { placeholder: "Names or player ids, one per line (or any separator)", rows: "4" });
  const out = h("div");
  const look = async () => {
    const names = [...new Set(text.value.split(/[\n,;\t]+/).map((x) => x.trim()).filter(Boolean))].slice(0, 50);
    if (!names.length) return toast("Paste some names first.", true);
    fill(out, h("p", { class: "faint" }, `Looking up ${plural(names.length, "name")}…`));
    let found: Resolved[];
    try {
      found = (await api<{ players: Resolved[] }>("/admin/bulk", { action: "resolve", names })).players;
    } catch (e) {
      return fill(out, h("p", { class: "err" }, (e as Error).message));
    }
    const ok = found.filter((p) => p.id && !p.merged);
    const options: [string, string][] = [
      ...(may("player.marks") ? Object.entries(SPECIAL_BADGES).filter(([, d]) => !d.earned).flatMap(([id, d]): [string, string][] => [[`grant:${id}`, `Give ${d.name}`], [`revoke:${id}`, `Take ${d.name} away`]]) : []),
      ...(may("player.supporter") ? ([["supporter", "Gift Supporter"]] as [string, string][]) : []),
    ];
    const what = h("select", { "aria-label": "Do" }, options.map(([v, l]) => h("option", { value: v }, l)));
    const run = async () => {
      const [kind, badgeId] = what.value.split(":");
      const label = options.find(([v]) => v === what.value)?.[1] ?? "";
      if (!(await ask({ title: `${label} for ${plural(ok.length, "player")}?`, text: "Each one is logged on its own.", confirm: label }))) return;
      const users = ok.map((p) => p.id!);
      const body = kind === "supporter" ? { action: "supporter-grant", users, reason: "gift" } : { action: kind === "grant" ? "badge-grant" : "badge-revoke", badge: badgeId, users };
      const res = await act<{ results: { id: string; ok: boolean; message?: string }[] }>("/admin/bulk", body, "", undefined);
      if (!res) return;
      const done = res.results.filter((x) => x.ok).map((x) => x.id);
      const failed = res.results.filter((x) => !x.ok);
      // Undo: the reverse for the same players (badges; a gifted Supporter is revoked one by one).
      toast(`${label}: ${done.length} of ${ok.length}${failed.length ? `. ${failed[0].message ?? "One failed"}` : ""}`, !!failed.length, {
        label: "Undo",
        hold: 10_000,
        run: async () => {
          if (kind === "supporter") {
            for (const id of done) await api(`/admin/players/${encodeURIComponent(id)}`, { action: "supporter-revoke", reason: "undo" }).catch(() => undefined);
            toast("Supporter taken back");
          } else if (await undoCall("/admin/bulk", { action: kind === "grant" ? "badge-revoke" : "badge-grant", badge: badgeId, users: done }, "Undone")) void look();
        },
      });
      void look();
    };
    fill(out, 
      table(
        ["Pasted", "Player", "Now has", ""],
        found.map((p) =>
          h(
            "tr",
            null,
            h("td", { class: "faint" }, p.q),
            h("td", null, p.id ? [playerLink(p.id, p.name ?? p.id), p.merged ? badge("merged", "warn") : null] : h("span", { class: "err" }, p.error ?? "not found")),
            h("td", null, (p.special ?? []).map((s) => h("span", { class: "has-badge", title: SPECIAL_BADGES[s]?.name ?? s }, specialIcon(s, 14), SPECIAL_BADGES[s]?.name ?? s)), p.supporter ? badge("supporter", "acc") : null),
            h("td", { class: "faint" }, p.id ? idCell(p.id) : null),
          ),
        ),
      ),
      ok.length && options.length ? h("div", { class: "filters" }, h("label", null, "Do", what), h("button", { class: "primary", onclick: () => void run() }, `For ${plural(ok.length, "player")}`)) : emptyLine("Nobody to change."),
    );
  };
  return h(
    "section",
    { class: "card bulk" },
    h("h2", null, "Badges and gifts", help("Paste a list of names (exact current names) or player ids. You see who each one is before anything changes.")),
    h("details", { open }, h("summary", null, "Give or take a badge for many players"), text, h("div", { class: "actions" }, h("button", { class: "primary", onclick: () => void look() }, "Look them up")), out),
  );
}

export const supportersView: View = async (root, params) => {
  const r = await api<{ supporters: { id: string; name: string; since: number; source: string | null; cents: number; shown: boolean }[] }>("/admin/supporters");
  const total = r.supporters.reduce((a, s) => a + s.cents, 0);
  fill(root, 
    h("div", { class: "view-bar" }, h("span", { class: "sub" }, `${plural(r.supporters.length, "supporter")}, ${money(total)} in all`), h("span", { class: "faint" }, "Payments come in through Stripe. Gifts and refunds are on a player's page.")),
    may("player.marks") || may("player.supporter") ? bulkCard(params.get("bulk") === "1") : null,
    h(
      "section",
      { class: "card" },
      h("h2", null, "Supporters", h("small", null, r.supporters.length ? String(r.supporters.length) : "")),
      table(
        ["Player", "Since", "How", ["Total", "num"], ""],
        r.supporters.map((s) => h("tr", null, h("td", null, playerLink(s.id, s.name)), timeCell(s.since), h("td", null, s.source === "admin" ? "Gift from staff" : s.source === "stripe" ? "Paid" : (s.source ?? "")), h("td", { class: "num" }, money(s.cents)), h("td", null, s.shown ? "" : h("span", { class: "faint" }, "hidden from Top supporters")))),
        "No supporters yet.",
      ),
    ),
  );
};
