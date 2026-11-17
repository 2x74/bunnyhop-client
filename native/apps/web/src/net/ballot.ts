// The map vote on screen (the end-of-map vote and rock the vote): the room's CS:S numbered menu (net/hud.ts
// NumberMenu, left middle), up while you play, the pointer still locked. 1 to 9 on the number row or the numpad vote
// for the option with that number, in the order shown (at most six maps and Extend: 0 is Hide, never an option); a
// second digit changes your vote, as the room allows (rooms/logic.ts castVote). While the ballot is up the digits are
// its own (main.ts input.ownsKey): no weapon slot. A digit the player bound to a move, jump or turn keeps doing that
// (weapon-commands.ts menuDigit). The message is the room's existing { t: "vote", option }.

import type { MenuSpec } from "./hud";
import { extendTally, isExtend, type VoteView } from "./protocol";
import { tierLabel } from "../tiers";

/** How many ballots have shown "Press a number to vote": the first VOTE_HINT_BALLOTS a player sees. */
export const VOTE_HINT_KEY = "bunnyhop:vote-keys-hint";
export const VOTE_HINT_BALLOTS = 3;
export const VOTE_HINT = "Press a number to vote.";

/** A new ballot came up: true while it's one of the player's first few, counting it. */
export function voteHintDue(): boolean {
  try {
    const shown = Number(localStorage.getItem(VOTE_HINT_KEY)) || 0;
    if (shown >= VOTE_HINT_BALLOTS) return false;
    localStorage.setItem(VOTE_HINT_KEY, String(shown + 1));
    return true;
  } catch {
    return false;
  }
}

export interface Ballot {
  vote: VoteView;
  /** Your vote (an option index), or null. */
  myVote: number | null;
  /** This ballot shows the number keys hint (voteHintDue when it came up); it goes once you vote. */
  hint: boolean;
  secondsLeft: number;
  players: number;
}

/** The numbered menu for a vote: one row per option, Extend with its tally, your pick marked, the time left. */
export function ballotSpec(b: Ballot, on: { vote: (option: number) => void; hide: () => void }): MenuSpec {
  const v = b.vote;
  return {
    title: v.kind === "rtv" ? "Rock the vote: next map" : "Vote for the next map",
    items: v.options.map((o, i) => ({
      label: isExtend(o) ? `Extend map (+${o.minutes} min)` : o.map,
      detail: isExtend(o) ? extendTally(o, v.counts[i] ?? 0) : `${o.tier ? `${tierLabel(o.tier)} · ` : ""}${v.counts[i] ?? 0}`,
      selected: b.myVote === i,
    })),
    // Everyone in the room may vote: spectators too, and an AFK player's vote makes them active again (rooms/room.ts).
    hint: b.hint && b.myVote === null ? VOTE_HINT : undefined,
    footer: `${Math.max(0, b.secondsLeft)} s left · ${v.counts.reduce((a, c) => a + c, 0)}/${b.players} voted`,
    exit: "Hide",
    onPick: (i) => {
      if (i !== b.myVote) on.vote(i);
    },
    onExit: on.hide,
  };
}
