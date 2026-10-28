// Boards → Gauntlets (research/GAUNTLETS.md; API: apps/api src/gauntlets.ts /admin/gauntlets, admins and the owner).
// The list of every gauntlet (drafts and hidden ones too) and the editor: slug, title, the maps in order (added by name
// with the map index as suggestions, moved up and down, removed), official, visibility and the start / end dates. A
// draft's maps can change; publishing checks them again (2-20 ranked maps with pinned zones) and pins their version
// and zones, after which only the title, visibility, dates and official can: Duplicate makes a draft to change maps.
// Every write is logged by the API.

import { act, api, ask, badge, emptyLine, fill, glyph, h, n, plural, reroute, table, timeCell, toast, type View } from "./core";
import { loadMapIndex, mapLine } from "./art";

interface AdminGauntlet {
  id: number;
  slug: string;
  title: string;
  official: boolean;
  style: string;
  visibility: "public" | "unlisted" | "hidden";
  startsAt: number | null;
  endsAt: number | null;
  publishedAt: number | null;
  maxMs: number;
  kind: "permanent" | "weekly" | "event";
  week: string | null;
  sort: number;
  creatorId: string;
  createdAt: number;
  finishers: number;
  maps: { idx: number; map: string; mapVersionId: number | null; zonesId: number | null; track: number }[];
}

const KINDS: [AdminGauntlet["kind"], string][] = [
  ["permanent", "Permanent"],
  ["weekly", "Weekly"],
  ["event", "Event"],
];

const VISIBILITY: [AdminGauntlet["visibility"], string][] = [
  ["public", "Public"],
  ["unlisted", "Unlisted (link only)"],
  ["hidden", "Hidden"],
];

/** ms → the value of a datetime-local input (local time), and back (null: empty). */
const toLocal = (ms: number | null) => {
  if (ms === null) return "";
  const d = new Date(ms);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (v: string): number | null => (v ? new Date(v).getTime() : null);
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function windowText(g: AdminGauntlet): string {
  if (g.startsAt === null && g.endsAt === null) return "Always";
  return `${g.startsAt !== null ? day(g.startsAt) : "now"} to ${g.endsAt !== null ? day(g.endsAt) : "no end"}`;
}

function stateBadge(g: AdminGauntlet): HTMLElement {
  if (g.publishedAt === null) return badge("draft", "warn");
  if (g.visibility === "hidden") return badge("hidden");
  if (g.endsAt !== null && g.endsAt < Date.now()) return badge("ended");
  return badge(g.visibility === "unlisted" ? "unlisted" : "live", "ok");
}

async function list(): Promise<AdminGauntlet[]> {
  return (await api<{ gauntlets: AdminGauntlet[] }>("/admin/gauntlets")).gauntlets;
}

async function duplicate(g: AdminGauntlet): Promise<void> {
  const v = await ask({
    title: `Duplicate ${g.title}?`,
    text: "A new draft with the same maps, to change them before it's published.",
    fields: [
      { name: "slug", label: "Slug", kind: "text", value: `${g.slug}-2`, required: true },
      { name: "title", label: "Title", kind: "text", value: g.title, required: true },
    ],
    confirm: "Duplicate",
  });
  if (!v) return;
  const r = await act<{ gauntlet: AdminGauntlet }>("/admin/gauntlets", { action: "duplicate", id: g.id, slug: v.slug, title: v.title }, `Draft ${v.slug} made`);
  if (r) location.hash = `#/gauntlets/${r.gauntlet.id}`;
}

async function hide(g: AdminGauntlet): Promise<boolean> {
  const ok = await ask({ title: `Hide ${g.title}?`, text: "It leaves the list and its page. Its board and PBs are kept; set it public again to bring it back.", confirm: "Hide", danger: true });
  return !!ok && !!(await act("/admin/gauntlets", { action: "hide", id: g.id }, `${g.title} hidden`));
}

// ---------------------------------------------------------------------------------------------
// The list

function listView(root: HTMLElement, all: AdminGauntlet[]): void {
  const row = (g: AdminGauntlet) =>
    h(
      "tr",
      { class: `go${g.visibility === "hidden" ? " retired" : ""}`, "data-href": `#/gauntlets/${g.id}` },
      h("td", null, h("a", { href: `#/gauntlets/${g.id}` }, g.title), h("div", { class: "faint" }, g.slug)),
      h("td", null, stateBadge(g)),
      h("td", null, g.kind === "weekly" ? `Weekly ${g.week ?? ""}` : g.kind === "event" ? "Event" : "Permanent"),
      h("td", null, windowText(g)),
      h("td", { class: "num" }, String(g.maps.length)),
      h("td", { class: "num" }, g.finishers ? n(g.finishers) : h("span", { class: "faint" }, "0")),
      timeCell(g.createdAt),
      h(
        "td",
        { class: "acts" },
        h(
          "span",
          { class: "hover-acts" },
          h("button", { class: "small ghost", onclick: () => void duplicate(g) }, "Duplicate…"),
          g.visibility !== "hidden" ? h("button", { class: "small ghost danger-text", onclick: async () => (await hide(g)) && reroute() }, "Hide…") : null,
          g.publishedAt !== null ? h("a", { class: "btn small ghost", href: `/g/${encodeURIComponent(g.slug)}`, target: "_blank", rel: "noopener" }, glyph("ext"), "Page") : null,
        ),
      ),
    );
  fill(
    root,
    h("div", { class: "view-bar" }, h("span", { class: "sub" }, plural(all.length, "gauntlet")), h("div", { class: "tools" }, h("a", { class: "btn primary", href: "#/gauntlets/new" }, glyph("plus"), "New gauntlet"))),
    table(["Gauntlet", "State", "Kind", "Open", ["Maps", "num"], ["Finishers", "num"], "Made", ""], all.map(row), "No gauntlets yet."),
  );
}

// ---------------------------------------------------------------------------------------------
// The editor (a new draft, a draft, or a published gauntlet)

function editor(root: HTMLElement, g: AdminGauntlet | null, names: string[]): void {
  const published = !!g?.publishedAt;
  const slug = h("input", { type: "text", value: g?.slug ?? "", placeholder: "october-2026", required: true, readonly: !!g, pattern: "[a-z0-9][a-z0-9-]{1,47}", autocomplete: "off" });
  const title = h("input", { type: "text", value: g?.title ?? "", placeholder: "October gauntlet", maxlength: "80", required: true });
  const official = h("input", { type: "checkbox", checked: g?.official ?? true });
  const visibility = h("select", null, VISIBILITY.map(([v, l]) => h("option", { value: v, selected: v === (g?.visibility ?? "public") }, l)));
  const starts = h("input", { type: "datetime-local", value: toLocal(g?.startsAt ?? null) });
  const ends = h("input", { type: "datetime-local", value: toLocal(g?.endsAt ?? null) });
  // A weekly runs its week (Monday 00:00 UTC to the next; the server sets the dates). Kind is fixed once made.
  const kind = h("select", { disabled: !!g }, KINDS.map(([v, l]) => h("option", { value: v, selected: v === (g?.kind ?? "permanent") }, l)));
  const week = h("input", { type: "date", value: g?.week ?? "", step: "7", min: "2026-10-19", disabled: !!g });
  const sort = h("input", { type: "number", value: String(g?.sort ?? 0), step: "1", style: "width:5rem" });
  const weekField = h("label", null, "Week (Monday)", week);
  const syncKind = () => {
    weekField.hidden = kind.value !== "weekly";
    starts.disabled = ends.disabled = kind.value === "weekly" && !g;
  };
  kind.addEventListener("change", syncKind);
  syncKind();

  // --- the maps, in order
  let maps = (g?.maps ?? []).map((m) => m.map);
  const known = new Set(names);
  const listId = "gauntlet-maps";
  const add = h("input", { type: "search", list: listId, placeholder: "map name", "aria-label": "Add a map", autocomplete: "off" });
  const addBtn = h("button", { type: "button", class: "small" }, glyph("plus"), "Add");
  const rows = h("tbody");
  const count = h("span", { class: "faint" });
  const paint = () => {
    count.textContent = plural(maps.length, "map");
    const move = (i: number, d: number) => {
      const j = i + d;
      if (j < 0 || j >= maps.length) return;
      [maps[i], maps[j]] = [maps[j], maps[i]];
      paint();
      rows.querySelectorAll<HTMLButtonElement>(`button[data-move="${d}"]`)[j]?.focus();
    };
    fill(
      rows,
      ...(maps.length
        ? maps.map((m, i) =>
            h(
              "tr",
              null,
              h("td", { class: "num faint" }, String(i + 1)),
              h("td", null, mapLine(m)),
              h(
                "td",
                { class: "acts" },
                published
                  ? null
                  : [
                      h("button", { type: "button", class: "small ghost", "data-move": "-1", disabled: i === 0, "aria-label": `Move ${m} up`, onclick: () => move(i, -1) }, glyph("up")),
                      h("button", { type: "button", class: "small ghost", "data-move": "1", disabled: i === maps.length - 1, "aria-label": `Move ${m} down`, onclick: () => move(i, 1) }, glyph("down")),
                      h("button", { type: "button", class: "small ghost danger-text", "aria-label": `Remove ${m}`, onclick: () => ((maps = maps.filter((_, k) => k !== i)), paint()) }, glyph("close")),
                    ],
              ),
            ),
          )
        : [h("tr", null, h("td", { colspan: "3", class: "empty" }, "No maps yet."))]),
    );
  };
  const addMap = () => {
    const name = add.value.trim();
    if (!name) return;
    if (!known.has(name)) return toast(`${name} isn't in the map index.`, true);
    if (maps.length >= 20) return toast("A gauntlet has at most 20 maps.", true);
    maps = [...maps, name];
    add.value = "";
    paint();
    add.focus();
  };
  addBtn.onclick = addMap;
  add.addEventListener("keydown", (e) => {
    if (e.key === "Enter") (e.preventDefault(), addMap());
  });
  paint();

  // --- saving
  const fields = () => ({ title: title.value.trim(), visibility: visibility.value, startsAt: fromLocal(starts.value), endsAt: fromLocal(ends.value), official: official.checked, sort: Number.parseInt(sort.value, 10) || 0 });
  const save = async (publish: boolean) => {
    if (!title.value.trim()) return toast("A title, please.", true);
    if (!g && !slug.value.trim()) return toast("A slug, please.", true);
    if (publish) {
      const ok = await ask({
        title: `Publish ${title.value.trim()}?`,
        text: `Its ${plural(maps.length, "map")}, their order and each map's current version and zones are fixed from then on.`,
        confirm: "Publish",
      });
      if (!ok) return;
    }
    if (!g) {
      const r = await act<{ gauntlet: AdminGauntlet }>("/admin/gauntlets", { action: "create", slug: slug.value.trim(), maps, publish, ...fields(), kind: kind.value, ...(kind.value === "weekly" ? { week: week.value } : {}) }, publish ? "Published" : "Draft saved");
      if (r) location.hash = `#/gauntlets/${r.gauntlet.id}`;
      return;
    }
    if (!published && !(await act("/admin/gauntlets", { action: "maps", id: g.id, maps }, ""))) return;
    if (!(await act("/admin/gauntlets", { action: "edit", id: g.id, ...fields() }, publish ? "" : "Saved"))) return;
    if (publish && !(await act("/admin/gauntlets", { action: "publish", id: g.id }, "Published"))) return;
    reroute();
  };

  const field = (label: string, input: HTMLElement) => h("label", { class: "field" }, label, input);
  fill(
    root,
    h(
      "div",
      { class: "view-bar" },
      h("a", { class: "btn small ghost", href: "#/gauntlets" }, glyph("back"), "All gauntlets"),
      g ? stateBadge(g) : badge("new draft", "warn"),
      g?.publishedAt ? h("span", { class: "sub" }, `published ${day(g.publishedAt)}, ${plural(g.finishers, "finisher")}`) : null,
      g?.publishedAt ? h("div", { class: "tools" }, h("a", { class: "btn small ghost", href: `/g/${encodeURIComponent(g.slug)}`, target: "_blank", rel: "noopener" }, glyph("ext"), "Page")) : null,
    ),
    h(
      "section",
      { class: "card gauntlet-edit" },
      h(
        "form",
        { class: "fb-note", onsubmit: (e: Event) => (e.preventDefault(), void save(false)) },
        h("div", { class: "g-cols" }, field("Slug", slug), field("Title", title)),
        h("div", { class: "filters" }, h("label", null, "Kind", kind), weekField, h("label", null, "Visibility", visibility), h("label", null, "Starts", starts), h("label", null, "Ends", ends), h("label", null, "Order", sort), h("label", { class: "field inline check" }, official, "Official")),
        h("h2", null, "Maps ", count),
        h("div", { class: "tablewrap" }, h("table", { class: "gauntlet-maps" }, rows)),
        published
          ? h("p", { class: "faint" }, "A published gauntlet keeps its maps. Duplicate it to change them.")
          : h("div", { class: "filters" }, h("label", null, "Map", add), addBtn, h("datalist", { id: listId }, names.map((m) => h("option", { value: m })))),
        h(
          "div",
          { class: "actions" },
          g ? h("button", { type: "button", class: "ghost", onclick: () => void duplicate(g) }, "Duplicate…") : null,
          g && g.visibility !== "hidden" ? h("button", { type: "button", class: "ghost danger-text", onclick: async () => (await hide(g)) && reroute() }, "Hide…") : null,
          h("span", { style: "flex:1" }),
          h("button", { type: "submit", class: published ? "primary" : "" }, published ? "Save" : g ? "Save draft" : "Save as draft"),
          published ? null : h("button", { type: "button", class: "primary", onclick: () => void save(true) }, "Publish…"),
        ),
      ),
    ),
  );
  (g ? title : slug).focus();
}

/** The map index's names (the suggestions), ranked or not: the API says which can't go in. */
async function mapNames(): Promise<string[]> {
  await loadMapIndex();
  try {
    const r = await fetch("/index.json");
    const j = (await r.json()) as { maps?: { name: string }[] };
    return (j.maps ?? []).map((m) => m.name).sort();
  } catch {
    return [];
  }
}

export const gauntletsView: View = async (root, _params, rest) => {
  const [all, names] = await Promise.all([list(), rest[0] ? mapNames() : Promise.resolve([])]);
  if (!rest[0]) return listView(root, all);
  if (rest[0] === "new") return editor(root, null, names);
  const g = all.find((x) => String(x.id) === rest[0]);
  if (!g) return void fill(root, emptyLine("No such gauntlet."));
  editor(root, g, names);
};
