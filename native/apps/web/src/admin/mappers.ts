// Boards → Mappers (apps/api src/admin-mappers.ts, src/mappers.ts; migrations/0076): every author name on the maps, how
// many maps carry it and which player it is linked to. Linking a name gives that player the Mapper badge (and the Discord
// role that follows it), the author link on the maps screen, "Maps by <name>" on their profile and the Beat the Mapper
// achievement; unlinking their last name takes the badge back. Every change is logged by the API.

import { act, api, ask, emptyLine, fill, h, plural, playerLink, reroute, table, type View } from "./core";

interface Row {
  key: string;
  author: string;
  maps: number;
  sample: string[];
  user: { id: string; name: string } | null;
}

const list = async () => (await api<{ authors: Row[] }>("/admin/mappers")).authors;

async function link(r: Row): Promise<boolean> {
  const v = await ask({
    title: r.user ? `Move ${r.author}?` : `Link ${r.author}?`,
    text: r.user ? `${r.author} is linked to ${r.user.name}. Linking it again moves it, and the badge with it.` : `Gives the player the Mapper badge and links ${plural(r.maps, "map")} to their profile.`,
    fields: [{ name: "user", label: "Player (name or id)", kind: "text", required: true }],
    confirm: "Link",
  });
  return !!v && !!(await act("/admin/mappers", { action: "link", author: r.author, user: v.user }, `${r.author} linked`));
}

async function unlink(r: Row): Promise<boolean> {
  const ok = await ask({ title: `Unlink ${r.author}?`, text: `${r.user?.name ?? "The player"} loses the Mapper badge if this was their last name.`, confirm: "Unlink", danger: true });
  return !!ok && !!(await act("/admin/mappers", { action: "unlink", author: r.author }, `${r.author} unlinked`));
}

export const mappersView: View = async (root) => {
  const all = await list();
  const q = h("input", { type: "search", placeholder: "Search author names", "aria-label": "Search author names", autocomplete: "off" });
  const rows = h("div");
  const paint = () => {
    const needle = q.value.trim().toLowerCase();
    const shown = all.filter((r) => !needle || r.key.includes(needle) || r.user?.name.toLowerCase().includes(needle));
    fill(
      rows,
      table(
        ["Author", ["Maps", "num"], "Linked to", ""],
        shown.slice(0, 200).map((r) =>
          h(
            "tr",
            null,
            h("td", null, r.author, r.sample.length ? h("div", { class: "faint" }, r.sample.join(", ")) : null),
            h("td", { class: "num" }, String(r.maps)),
            h("td", null, r.user ? playerLink(r.user.id, r.user.name) : h("span", { class: "faint" }, "Nobody")),
            h(
              "td",
              { class: "acts" },
              h("button", { class: "small ghost", onclick: async () => (await link(r)) && reroute() }, r.user ? "Move…" : "Link…"),
              r.user ? h("button", { class: "small ghost danger-text", onclick: async () => (await unlink(r)) && reroute() }, "Unlink…") : null,
            ),
          ),
        ),
        "No author matches.",
      ),
      shown.length > 200 ? h("p", { class: "faint" }, `Showing 200 of ${shown.length}; search to narrow it.`) : null,
    );
  };
  q.addEventListener("input", paint);
  if (!all.length) return void fill(root, emptyLine("No maps carry an author name."));
  fill(root, h("div", { class: "view-bar" }, h("span", { class: "sub" }, `${plural(all.length, "author")}, ${all.filter((r) => r.user).length} linked`), h("div", { class: "tools" }, q)), rows);
  paint();
};
