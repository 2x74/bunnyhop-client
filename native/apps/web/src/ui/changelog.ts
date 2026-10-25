// The version button ("v0.0.3 alpha") at the bottom of the pause menu, the home footer's "What's new" / version link,
// and the changelog card they open: the newest version's title and three plain sentences, then one line per older
// version that opens in place. The full text is the /changelog page (changelog.html, rendered at build time).
//
// THE DOT. We remember the last version whose card was OPENED (not merely shown) in localStorage; while the running
// VERSION is newer than that, every version button carries a small dot. Opening the card is the whole acknowledgement:
// no "mark as read", no per-entry state. A first visit counts as unseen too: the invitation is the point.
//
// The card is a modal <dialog> like the account panel and the feedback form: keydown stops at the dialog, so no key
// reaches the game, the menus' Esc (resume / back) or the pause menu's Q / E while it's open (the game itself only reads
// keys while pointer-locked, which it never is under a menu). Esc closes the card and nothing else.

import { h } from "./dom";
import { CHANGELOG, STAGE, VERSION, VERSION_LABEL, compareVersions, prettyDate } from "../version";
import "./changelog.css";
import { ring } from "../notify";
import { discordLink } from "./community";
import { dismissOutside } from "./dismiss";

const SEEN_KEY = "bunnyhop:seen-version";

/** The last version whose changelog was opened, or null. */
export function lastSeenVersion(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

/** True while the running build is newer than the last one whose changelog was opened. */
export function hasUnseenVersion(): boolean {
  const seen = lastSeenVersion();
  return !seen || compareVersions(VERSION, seen) > 0;
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, VERSION);
  } catch {
    /* private mode */
  }
  for (const b of document.querySelectorAll<HTMLElement>(".ver-btn.has-new")) {
    b.classList.remove("has-new");
    b.querySelector(".ver-dot")?.remove();
    b.setAttribute("aria-label", `Version ${VERSION} ${STAGE}. What's new`);
  }
}

/** "v0.0.3 alpha", with a dot while unseen; opens the changelog. */
export function versionButton(): HTMLButtonElement {
  const unseen = hasUnseenVersion();
  const b = h(
    `button.ver-btn${unseen ? ".has-new" : ""}`,
    {
      type: "button",
      title: "What's new",
      "aria-label": `Version ${VERSION} ${STAGE}. What's new${unseen ? " (new)" : ""}`,
      onclick: () => openChangelog(),
    },
    h("span.ver-label", null, VERSION_LABEL),
    unseen ? h("span.ver-dot", { "aria-hidden": "true" }) : null,
  );
  // Once per page load: two rings from the dot a moment after it appears (motion is a cue, not a loop).
  const dot = b.querySelector<HTMLElement>(".ver-dot");
  if (dot && !rang) {
    rang = true;
    for (const t of [900, 1700]) window.setTimeout(() => ring(dot), t);
  }
  return b;
}

/** Home footer: "What's new" (with the dot) while this version's notes are unread, else just the version, quiet. */
export function versionLink(): HTMLButtonElement {
  const unseen = hasUnseenVersion();
  const b = h(`button.home-link.home-ver${unseen ? ".has-new" : ""}`, { type: "button", title: "What's new", onclick: () => (openChangelog(), paint()) });
  const paint = () => b.replaceChildren(...(hasUnseenVersion() ? ["What's new", h("span.ver-dot", { "aria-hidden": "true" })] : [`v${VERSION}`]));
  paint();
  return b;
}

let current: HTMLDialogElement | null = null;
let rang = false;

/** Opens the changelog card (one at a time). */
export function openChangelog(): void {
  if (current) return;
  markSeen();
  const d = h("dialog.acct-dialog.chlog-dialog", { "aria-label": "Changelog" }) as HTMLDialogElement;
  // No key reaches the game or the menus behind it (see the header); Esc closes, also the gamepad's synthetic Esc,
  // which doesn't trigger the dialog's own cancel.
  d.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape" && !e.defaultPrevented) (e.preventDefault(), d.close());
  });
  dismissOutside(d, () => d.close());
  d.addEventListener("close", () => {
    d.remove();
    current = null;
  });
  // Newest: its title and up to three plain sentences (the first of each of its first notes). Older versions: one line
  // each (version, title, date) that opens in place. The whole text is on the /changelog page.
  const firstSentence = (n: string) => (/^.+?[.!?](?=\s|$)/.exec(n)?.[0] ?? n).trim();
  const paras = (notes: string[]) => notes.map((n) => h("p", null, n));
  const [latest, ...older] = CHANGELOG;
  const list = h("div.chlog-list");
  if (latest) {
    list.append(
      h(
        "article.chlog-latest",
        null,
        h("div.chlog-meta", null, h("span.chlog-ver", null, `v${latest.version}`), h("time.chlog-date", { datetime: latest.date }, prettyDate(latest.date))),
        h("h3.chlog-title", null, latest.title),
        h("div.chlog-notes", null, ...paras(latest.notes.slice(0, 3).map(firstSentence))),
        h("a.chlog-more", { href: "/changelog", target: "_blank", rel: "noopener" }, "All the notes ›"),
      ),
    );
  }
  for (const e of older) {
    const body = h("div.chlog-body-inner", null, h("div.chlog-notes", null, ...paras(e.notes), ...(e.links ?? []).map((link) => h("p", null, h("a", { href: link.url, target: "_blank", rel: "noopener noreferrer" }, link.label)))));
    const row = h(
      "button.chlog-row",
      { type: "button", "aria-expanded": "false" },
      h("span.chlog-ver", null, `v${e.version}`),
      h("span.chlog-row-title", null, e.title),
      h("time.chlog-date", { datetime: e.date }, prettyDate(e.date)),
    );
    const art = h("article.chlog-entry", null, row, h("div.chlog-fold", null, body));
    row.addEventListener("click", () => {
      const open = !art.classList.contains("open");
      art.classList.toggle("open", open);
      row.setAttribute("aria-expanded", String(open));
    });
    list.append(art);
  }
  const close = h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => d.close() }, "×");
  d.append(
    h("header.acct-head", null, h("h2", null, "What's new"), close),
    h(
      "div.acct-body.chlog-body",
      null,
      h("p.chlog-lead.dim", null, `You're on ${VERSION_LABEL}.`, " ", discordLink("chlog-discord")),
      list,
    ),
  );
  document.body.append(d);
  current = d;
  d.showModal();
  // Land on the newest entry with focus on the close button (Enter / Space / Esc all close).
  d.scrollTop = 0;
  close.focus({ preventScroll: true });
}
