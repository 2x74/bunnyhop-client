// A player's followers / following / friends (the profile's numbers open it): one floating list under the numbers with
// the three as tabs. Rows are the dock's (avatar, name, where they are when they're your friend, Follow / Follow back).
// Your own lists come from the friends list you already have (social/state.ts); anyone else's from
// GET /players/:id/follows. Esc, a click outside or the screen changing closes it. Styles: social/dock.css (.pp-*).

import { api, type ApiPlayer, type FollowList } from "../api";
import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { uiClose, uiOpen } from "../audio/ui";
import { personRow } from "./dock";
import { followState, friendsView, onFriends } from "./state";

const TABS: [FollowList, string, string][] = [
  ["followers", "follower", "followers"],
  ["following", "following", "following"],
  ["friends", "friend", "friends"],
];

/** "1 follower", "12 followers", "8 following". */
export const countLabel = (k: FollowList, n: number) => {
  const t = TABS.find((x) => x[0] === k)!;
  return n === 1 ? t[1] : t[2];
};

let current: (() => void) | null = null;

/** Your own lists, newest first, from the friends list. null until it has loaded. */
function ownList(k: FollowList): ApiPlayer[] | null {
  const v = friendsView();
  if (!v) return null;
  const by = (a: { since: number }, b: { since: number }) => b.since - a.since;
  if (k === "friends") return [...v.friends].sort(by);
  return [...v.friends, ...(k === "followers" ? v.followers : v.following)].sort(by);
}

/**
 * Opens the lists of `player` on tab `first`, under `anchor`. `counts()` gives the numbers for the tabs (they follow
 * your own follows live). `mine`: it's your own profile.
 */
export function openPeople(anchor: HTMLElement, player: { id: string; name: string }, first: FollowList, counts: () => Record<FollowList, number>, mine: boolean): void {
  current?.();
  let tab = first;
  const cache = new Map<FollowList, ApiPlayer[]>();
  const list = h("ul.fd-list.pp-list", { role: "tabpanel", tabindex: "-1" });
  const tabs = h("div.pp-tabs", { role: "tablist", "aria-label": `${player.name}'s follows` });
  const panel = h(
    "div.pp-panel",
    { role: "dialog", "aria-label": mine ? "Your follows" : `${player.name}'s follows` },
    h("header.pp-head", null, tabs, h("button.fd-x", { type: "button", "aria-label": "Close", onclick: () => close(true) }, icon("close", { size: "0.9rem" }))),
    list,
  );

  const drawTabs = () => {
    const n = counts();
    tabs.replaceChildren(
      ...TABS.map(([k]) =>
        h(
          `button.pp-tab${k === tab ? ".on" : ""}`,
          { type: "button", role: "tab", "aria-selected": String(k === tab), tabindex: k === tab ? "0" : "-1", onclick: () => select(k) },
          h("b", null, n[k].toLocaleString("en-US")),
          ` ${countLabel(k, n[k])}`,
        ),
      ),
    );
  };
  const empty = (k: FollowList) =>
    k === "friends"
      ? mine
        ? "No friends yet. Follow someone; when they follow you back, you're friends."
        : `${player.name} has no friends here yet.`
      : k === "followers"
        ? mine
          ? "Nobody follows you yet."
          : `Nobody follows ${player.name} yet.`
        : mine
          ? "You don't follow anyone yet."
          : `${player.name} doesn't follow anyone yet.`;
  const fill = (k: FollowList, people: ApiPlayer[] | null) => {
    if (k !== tab) return;
    if (!people) return list.replaceChildren(h("li.fd-empty", null, "Loading"));
    const more = counts()[k] - people.length;
    // Your own Following: who hasn't followed back says so (friends show where they are).
    const sub = (p: ApiPlayer) => (mine && k === "following" && followState(p.id) === "following" ? "Hasn't followed back" : null);
    list.replaceChildren(
      ...(people.length ? people.map((p) => personRow(p, { onOpen: () => close(false), sub: sub(p) })) : [h("li.fd-empty", null, empty(k))]),
      more > 0 && people.length ? h("li.fd-empty.pp-more", null, `and ${more.toLocaleString("en-US")} more`) : "",
    );
  };
  const load = (k: FollowList) => {
    if (mine) return fill(k, ownList(k));
    const got = cache.get(k);
    if (got) return fill(k, got);
    fill(k, null);
    api.followList(player.id, k).then(
      (people) => (cache.set(k, people), fill(k, people)),
      () => k === tab && list.replaceChildren(h("li.fd-empty", null, "Couldn't load this list.")),
    );
  };
  function select(k: FollowList): void {
    tab = k;
    drawTabs();
    load(k);
  }
  tabs.addEventListener("keydown", (e) => {
    const i = TABS.findIndex(([k]) => k === tab);
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : null;
    if (j === null) return;
    e.preventDefault();
    e.stopPropagation();
    select(TABS[(j + TABS.length) % TABS.length]![0]);
    tabs.querySelector<HTMLElement>(".pp-tab.on")?.focus();
  });

  document.body.append(panel);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    const below = innerHeight - r.bottom - 12;
    panel.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left))}px`;
    if (below >= 260) {
      panel.style.top = `${r.bottom + 6}px`;
      panel.style.maxHeight = `${below}px`;
    } else {
      panel.style.bottom = `${innerHeight - r.top + 6}px`;
      panel.style.maxHeight = `${r.top - 18}px`;
    }
  };
  place();
  select(tab);
  uiOpen();
  requestAnimationFrame(() => tabs.querySelector<HTMLElement>(".pp-tab.on")?.focus({ preventScroll: true }));

  // Your own lists and every follow button follow the live friends list. Rows change in place (their buttons repaint
  // themselves); the list only redraws when someone new is in it, so an unfollow leaves the row there to follow again.
  const offFriends = onFriends(() => {
    drawTabs();
    if (!mine) return;
    const next = ownList(tab);
    const shown = new Set([...list.querySelectorAll<HTMLElement>("[data-id]")].map((e) => e.dataset.id));
    if (!next || !list.querySelector("[data-id]") || next.some((p) => !shown.has(p.id))) fill(tab, next);
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // A row's open menu takes Esc first (social/menu.ts).
    if (document.querySelector(".sm-menu")) return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  };
  const onDown = (e: PointerEvent) => {
    const t = e.target as Element;
    if (!panel.contains(t) && !anchor.contains(t) && !t.closest?.(".sm-menu, dialog")) close(false);
  };
  addEventListener("keydown", onKey, true);
  addEventListener("pointerdown", onDown, true);
  addEventListener("resize", place);
  // The screen changed (menu.ts sets body[data-screen]; the profile redraws on a follow): gone with the numbers.
  const watch = new MutationObserver(() => !anchor.isConnected && close(false));
  watch.observe(document.body, { attributes: true, attributeFilter: ["class", "data-screen"] });
  if (anchor.parentElement) watch.observe(anchor.parentElement, { childList: true });
  function close(focus: boolean): void {
    if (current !== shut) return;
    current = null;
    offFriends();
    removeEventListener("keydown", onKey, true);
    removeEventListener("pointerdown", onDown, true);
    removeEventListener("resize", place);
    watch.disconnect();
    panel.remove();
    uiClose();
    if (focus && anchor.isConnected) anchor.querySelector<HTMLElement>(`[data-list="${tab}"]`)?.focus({ preventScroll: true });
  }
  const shut = () => close(false);
  current = shut;
}
