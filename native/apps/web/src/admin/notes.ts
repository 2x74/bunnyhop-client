// Player notes (apps/api src/admin-cases.ts, GET / POST /admin/notes): what staff already know about a player, so a
// flag that is explained ("snap-tap keyboard: key sync flags are expected") isn't reviewed again. A short thread on the
// player page, newest first, with one pinned note that board cards, the case and the ticket show. Every staff role
// reads and writes them; you edit and delete your own (admins tidy anyone's). Players never see them.

import { act, ago, avatar, emptyLine, glyph, h, may, me, toast, when, type Person } from "./core";

export interface Note {
  id: number;
  body: string;
  pinned: boolean;
  source: string | null;
  created_at: number;
  edited_at: number | null;
  author: Person;
}

/** A pinned note as board cards and case heads show it: the note mark, the text (clamped by the host), who wrote it. */
export function pinnedLine(pin: { body: string; author?: Person | null } | null | undefined, cls = "pin-line"): HTMLElement | null {
  if (!pin) return null;
  return h("div", { class: cls, title: pin.body }, glyph("pin"), h("span", { class: "pin-text" }, pin.body), pin.author ? h("span", { class: "pin-by" }, pin.author.name) : null);
}

const canTouch = (n: Note) => !!me && (n.author.id === me.id || me.role === "owner" || me.role === "admin" || (me.token && n.author.id === "token"));

/** Where a note came from, as words: "from the case", "from a ticket". */
function sourceWord(s: string | null): string | null {
  if (!s) return null;
  if (s.startsWith("ac:")) return "from the anticheat case";
  if (s.startsWith("report:")) return "from a ticket";
  if (s.startsWith("asked:")) return `for ${s.slice(6)}`;
  return null;
}

/**
 * The notes block for a player. `onChange` runs with the new list after a write (the host can repaint a pin elsewhere).
 * Compact: no composer until "Add a note" is pressed (the drawer, a case).
 */
export function notesBlock(userId: string, initial: Note[], o: { compact?: boolean; onChange?: (notes: Note[]) => void } = {}): HTMLElement {
  let notes = initial.slice();
  const root = h("div", { class: `notes${o.compact ? " compact" : ""}` });
  const write = may("player.notes");
  const post = async (body: Record<string, unknown>, done: string) => {
    const r = await act<{ notes: Note[] }>("/admin/notes", { user: userId, ...body }, done);
    if (r) {
      notes = r.notes;
      paint();
      o.onChange?.(notes);
    }
    return !!r;
  };

  const text = h("textarea", { class: "note-input", rows: 2, maxlength: "2000", placeholder: "What should the next person know?" });
  const composer = h(
    "form",
    {
      class: "note-new",
      hidden: !!o.compact,
      onsubmit: (e: Event) => {
        e.preventDefault();
        void add(false);
      },
    },
    text,
    h(
      "div",
      { class: "note-new-acts" },
      h("span", { class: "faint" }, "Staff only"),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "small ghost", onclick: () => void add(true) }, glyph("pin"), "Add and pin"),
      h("button", { type: "submit", class: "small" }, "Add note"),
    ),
  );
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), void add(false));
  });
  const add = async (pin: boolean) => {
    const body = text.value.trim();
    if (!body) return toast("Write the note first.", true), text.focus();
    if (await post({ action: "add", body, pin }, pin ? "Note pinned" : "Note added")) text.value = "";
  };

  const edit = (n: Note, row: HTMLElement) => {
    const area = h("textarea", { class: "note-input", rows: 2, maxlength: "2000", value: n.body });
    const save = async () => {
      const body = area.value.trim();
      if (!body) return toast("A note can't be empty. Delete it instead.", true);
      await post({ action: "edit", id: n.id, body }, "Note saved");
    };
    area.addEventListener("keydown", (e) => {
      if (e.key === "Escape") (e.stopPropagation(), paint());
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), void save());
    });
    row.querySelector(".note-body")?.replaceWith(
      h("div", { class: "note-edit" }, area, h("div", { class: "note-new-acts" }, h("span", { class: "spacer" }), h("button", { type: "button", class: "small ghost", onclick: () => paint() }, "Cancel"), h("button", { type: "button", class: "small", onclick: () => void save() }, "Save"))),
    );
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  };

  const noteEl = (n: Note) => {
    const row = h(
      "article",
      { class: `note${n.pinned ? " pinned" : ""}` },
      avatar(n.author, { size: 22, staff: true }),
      h(
        "div",
        { class: "note-main" },
        h(
          "div",
          { class: "note-head" },
          h("b", null, n.author.name),
          h("span", { class: "faint", title: when(n.created_at) }, ago(n.created_at)),
          n.edited_at ? h("span", { class: "faint", title: when(n.edited_at) }, "edited") : null,
          sourceWord(n.source) ? h("span", { class: "faint" }, sourceWord(n.source)) : null,
          n.pinned ? h("span", { class: "note-pinned" }, glyph("pin"), "Pinned") : null,
          write
            ? h(
                "span",
                { class: "note-acts" },
                h("button", { type: "button", class: "small ghost", title: n.pinned ? "Unpin" : "Pin: shows on cards, cases and tickets", onclick: () => void post({ action: n.pinned ? "unpin" : "pin", id: n.id }, n.pinned ? "Unpinned" : "Pinned") }, n.pinned ? "Unpin" : "Pin"),
                canTouch(n) ? h("button", { type: "button", class: "small ghost", onclick: () => edit(n, row) }, "Edit") : null,
                canTouch(n) ? h("button", { type: "button", class: "small ghost danger-text", onclick: () => void post({ action: "delete", id: n.id }, "Note deleted") }, "Delete") : null,
              )
            : null,
        ),
        h("div", { class: "note-body" }, n.body),
      ),
    );
    return row;
  };

  const paint = () => {
    const opener = o.compact && write ? h("button", { type: "button", class: "small ghost note-open", onclick: () => ((composer.hidden = false), opener?.remove(), text.focus()) }, glyph("plus"), "Add a note") : null;
    root.replaceChildren(...(notes.length ? notes.map(noteEl) : [emptyLine(o.compact ? "No notes yet." : "No notes yet. Anything the next person should know goes here.")]), ...(write ? [composer.hidden ? opener! : composer] : []));
  };
  paint();
  return root;
}
