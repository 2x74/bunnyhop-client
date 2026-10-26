// The profile's social parts (ui/profile.ts): the numbers under the card ("12 followers  8 following  5 friends", each
// opens the lists: social/people.ts), where a friend is, and the follow control in the action row:
//   Follow / Follow back   amber, the row's one primary action while you don't follow them
//   Following ▾            quiet; its menu: Unfollow
//   Friends ▾              quiet; its menu: Message, Join / Ask to join / Invite, Unfollow
// Two follows make friends (research/FRIENDS.md), so the button's words carry the rule: "Follow back" when they follow
// you, "Friends" once you both do. The numbers follow your own follows at once (no refetch).

import { ApiError, type FollowList, type Profile } from "../api";
import { toast, whisper } from "../notify";
import { friendActs, whereText } from "../social/dock";
import { withMenu, type MenuItem } from "../social/menu";
import { countLabel, openPeople } from "../social/people";
import { followBusy, followState, followsYou, friendById, friendsView, knowRelation, onFriends, setBlock, setFollow } from "../social/state";
import { landFailed, landFollow, type Landing } from "../social/land";
import { h } from "./dom";
import { confirmDialog } from "./settings-transfer";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.body.classList.contains("potato");

function fail(e: unknown): void {
  toast(e instanceof ApiError ? (e.status === 401 ? "Sign in to follow players." : e.message) : "Couldn't reach the server.", { tone: "bad" });
}

export function profileSocial(p: Profile) {
  const id = p.player.id;
  const who = p.player.name;
  const n: Record<FollowList, number> = { followers: p.social?.followers ?? 0, following: p.social?.following ?? 0, friends: p.social?.friends ?? 0 };
  const you = p.social?.you;
  if (you) knowRelation(id, you);
  let blocked = !!you?.blocked;
  let rel = p.mine ? null : followState(id);
  let theyFollow = !p.mine && followsYou(id);
  const listeners = new Set<() => void>();
  const counts = h("div.pf-social");
  let bumped: FollowList | null = null;

  const drawCounts = () => {
    const f = p.mine ? null : friendById(id);
    counts.replaceChildren(
      ...(["followers", "following", "friends"] as FollowList[]).map((k) => {
        const body = [h("b", null, n[k].toLocaleString("en-US")), ` ${countLabel(k, n[k])}`];
        const el = n[k]
          ? h("button.pf-count", { type: "button", "data-list": k, title: `See ${p.mine ? "your" : `${who}'s`} ${countLabel(k, 2)}`, onclick: () => openPeople(counts, { id, name: who }, k, () => n, p.mine) }, ...body)
          : h("span.pf-count.zero", null, ...body);
        if (k === bumped && !reduced()) el.classList.add("bump");
        return el;
      }),
      // A friend's place (only friends see it): the dot and one line.
      f ? h(`span.pf-where${f.where ? ".on" : ""}`, null, h("i", { "aria-hidden": "true" }), whereText(f.where, f.lastSeen)) : "",
    );
    bumped = null;
  };

  // Live: your follow changes move their numbers (your own: the list's sizes).
  let shown = false;
  const off = onFriends(() => {
    // The screen went away: stop listening.
    if (counts.isConnected) shown = true;
    else if (shown) return off();
    if (p.mine) {
      const v = friendsView();
      if (v) {
        n.friends = v.friends.length;
        n.following = v.friends.length + v.following.length;
        // (The followers list stops at 200; past that keep the server's number.)
        if (v.followers.length < 200) n.followers = v.friends.length + v.followers.length;
      }
    } else {
      const next = followState(id);
      const nowFollows = followsYou(id);
      if (next !== rel) {
        n.followers += Number(!!next) - Number(!!rel);
        n.friends += Number(next === "friends") - Number(rel === "friends");
        bumped = next === "friends" && rel !== "friends" ? "friends" : "followers";
        rel = next;
      }
      if (nowFollows !== theyFollow) {
        n.following += Number(nowFollows) - Number(theyFollow);
        theyFollow = nowFollows;
      }
    }
    drawCounts();
    for (const l of [...listeners]) l();
  });
  drawCounts();

  /** The follow control on screen, and how the last press landed (the redraw that follows a press puts it on the new one). */
  let followEl: HTMLElement | null = null;
  let landing: Landing | null = null;
  const landOn = (el: HTMLElement) => {
    followEl = el;
    if (!landing) return el;
    const kind = landing;
    landing = null;
    requestAnimationFrame(() => landFollow(el, kind));
    return el;
  };
  const at = () => (followEl?.isConnected ? followEl : null);

  /** The follow control for someone else's profile. */
  function followControl(): HTMLElement {
    // Blocked: no Follow (the server would refuse it); the way back is right here.
    if (blocked) return landOn(h("button.btn.pf-follow.pf-quiet", { type: "button", "data-act": "follow", onclick: () => void setBlocked(false) }, "Unblock"));
    const s = followState(id);
    if (!s) {
      const back = followsYou(id);
      const b = h(
        "button.btn.primary.pf-follow",
        { type: "button", "data-act": "follow", title: back ? `${who} follows you. Follow back to be friends.` : undefined },
        back ? "Follow back" : "Follow",
      ) as HTMLButtonElement;
      b.dataset.sound = "none";
      b.onclick = () => {
        if (followBusy(id)) return;
        landing = back ? "friends" : "following";
        void setFollow(id, true, { who: p.player, at }).then((r) => {
          if (!r.ok) {
            landing = null;
            const el = at();
            if (el) landFailed(el);
          }
        });
        // (No redraw: nothing changed, e.g. signed out.)
        if (followEl === b) landing = null;
      };
      return landOn(b);
    }
    const b = h("button.btn.pf-follow.pf-quiet", { type: "button", "data-act": "follow" }, s === "friends" ? "Friends" : "Following", h("span.pf-caret", { "aria-hidden": "true" }));
    const unfollow: MenuItem = { label: "Unfollow", tone: "bad", run: () => void setFollow(id, false, { who: p.player, at }) };
    return landOn(withMenu(
      b,
      () => {
        const f = friendById(id);
        if (followState(id) !== "friends" || !f) return [{ note: `${who} hasn't followed you back yet.` }, unfollow];
        const { main, more } = friendActs(f);
        const acts = [main, ...more].filter((x): x is NonNullable<typeof x> => !!x && x.label !== "Profile" && x.label !== "Race");
        const canMessage = !!friendsView()?.canMessage;
        // (Where they are is on the line above.)
        return [
          ...(canMessage || acts.some((x) => x.label === "Message") ? [] : [{ label: "Message", hint: "Sign in first", disabled: true, run: () => {} } as MenuItem]),
          ...acts.map((x) => ({ label: x.label === "Invite" ? (x.title?.endsWith("lobby") ? "Invite to your lobby" : "Invite to your server") : x.label, run: x.run })),
          unfollow,
        ];
      },
      { label: s === "friends" ? `You and ${who} are friends` : `You follow ${who}` },
    ));
  }

  async function setBlocked(on: boolean): Promise<void> {
    if (on) {
      const ok = await confirmDialog({ title: `Block ${who}?`, body: "You stop following each other. They can't follow you, message you or invite you.", confirm: "Block", danger: true });
      if (!ok) return;
    }
    try {
      await setBlock(id, on);
      blocked = on;
      whisper(on ? `Blocked ${who}` : `Unblocked ${who}`);
      for (const l of [...listeners]) l();
    } catch (e) {
      fail(e);
    }
  }

  return {
    counts,
    rel: () => followState(id),
    followControl,
    signedIn: () => !!you || !!friendsView(),
    blocked: () => blocked,
    setBlocked: (on: boolean) => void setBlocked(on),
    onChange: (l: () => void) => void listeners.add(l),
  };
}
