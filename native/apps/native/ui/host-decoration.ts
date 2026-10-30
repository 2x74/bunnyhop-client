// How a player's name looks, for the host to draw in game the way the web does (net/hud.ts chat, net/scoreboard.ts
// Tab board, ui/marks.ts): the supporter colour, its effect and second colour, the marks after the name in the web's
// order (creators.ts equippedNameBadges), the rank tag and the flag. The menu works these out from the web's own rules
// so the host only draws.
//
// Host contract:
//   - Chat lines (chat-decoration.ts) carry `nativeName: HostNameLook` and `nativeMarks: HostMark[]` beside the older
//     text fields.
//   - The Tab board arrives as {type:"scoreboard", head, rows: HostScoreRow[]} (sendScoreboard) whenever it changes,
//     and {type:"scoreboard", head:null, rows:[]} when you leave the room. A running time is `running.seconds` at
//     `running.at` (Unix ms): the host advances it with its own clock.

import {
  BOOSTER_LABEL,
  CREATOR_COLOR,
  CREATOR_LABEL,
  equippedNameBadges,
  GIFTER_TIERS,
  isCreatorKind,
  isGifterColor,
  isNameColor,
  isStaffBadge,
  nameColorHex,
  nameEffectOf,
  SPECIAL_BADGES,
  STAFF_LABEL,
  type NameEffect,
  type PlayerMarks,
} from "../../web/src/creators";
import type { ScoreHead, ScoreRow } from "../../web/src/net/scoreboard";
import { roomScoreboard, runningSeconds } from "./room-scoreboard";
import type { RoomView } from "./room-service";

/** Name colour and effect (web marks.ts nameAttrs). Null colour: the default white. */
export interface HostNameLook {
  color: string | null;
  /** The "paint" gradient's second colour; null: a paler shade of the first. */
  color2: string | null;
  effect: NameEffect | null;
}

/**
 * One mark after a name. `id`: "staff", "contributor", "verified", "creator", "booster", "supporter", a Gifter tier
 * ("gifter-gold") or a special badge id. `kind`: the staff badge or creator platform. `colors`: the mark's colours
 * (a Gifter tier's, a Prism Gifter's own three, a creator's platform colour).
 */
export interface HostMark {
  id: string;
  name: string;
  kind?: string;
  colors?: string[];
  animated?: boolean;
}

export interface HostScoreRow {
  slot: number;
  you: boolean;
  name: string;
  look: HostNameLook;
  marks: HostMark[];
  rank: { name: string; color: string } | null;
  /** Lower-case ISO 3166 code for the flag, or null. */
  country: string | null;
  style: string;
  status: string;
  statusKind: ScoreRow["statusKind"];
  /** The run's time while it runs, and when it was read (Unix ms). */
  running: { seconds: number; at: number } | null;
  pb: number | null;
  ping: number | null;
  host: boolean;
  /** Idle past the room's limit (the roster's `afk`): shown as AFK in the Time column. */
  afk: boolean;
}

const MAX_BADGES = 16;
const PRISM_COLORS = ["#b98cff", "#7fcfff", "#ffb9db"];

const textList = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.slice(0, MAX_BADGES).filter((item): item is string => typeof item === "string")
    : undefined;

/** The marks part of an untrusted player record (a chat line, a roster entry), keeping only well-formed values. */
export function readMarks(value: Record<string, unknown>): PlayerMarks {
  const gifts =
    Number.isSafeInteger(value.giftsSent) && Number(value.giftsSent) >= 0 ? Number(value.giftsSent) : undefined;
  return {
    nameBadges: textList(value.nameBadges),
    giftsSent: gifts,
    gifterColors: textList(value.gifterColors)?.filter(isGifterColor),
    gifterAnimated: typeof value.gifterAnimated === "boolean" ? value.gifterAnimated : undefined,
    verified: value.verified === true,
    creator: isCreatorKind(value.creator) ? value.creator : null,
    booster: value.booster === true,
    staff: isStaffBadge(value.staff) ? value.staff : null,
    supporter: value.supporter === true,
    nameColor: isNameColor(value.nameColor) ? value.nameColor : null,
    nameEffect: nameEffectOf(value.nameEffect),
    nameColor2: isNameColor(value.nameColor2) ? value.nameColor2 : null,
    special: textList(value.special),
  };
}

export function hostNameLook(marks: PlayerMarks): HostNameLook {
  return {
    color: nameColorHex(marks.nameColor),
    color2: nameColorHex(marks.nameColor2),
    effect: nameEffectOf(marks.nameEffect),
  };
}

function hostMark(id: string, marks: PlayerMarks): HostMark | null {
  if (id === "staff" && marks.staff) return { id, name: STAFF_LABEL[marks.staff], kind: marks.staff };
  if (id === "creator" && marks.creator) {
    return { id, name: CREATOR_LABEL[marks.creator], kind: marks.creator, colors: [CREATOR_COLOR[marks.creator]] };
  }
  if (id === "verified") return { id, name: "Verified" };
  if (id === "booster") return { id, name: BOOSTER_LABEL };
  if (id === "supporter") return { id, name: "Supporter" };
  if (id === "contributor") return { id, name: "Contributor" };
  const tier = GIFTER_TIERS.find((gifter) => gifter.id === id);
  if (tier) {
    const own = marks.gifterColors?.length ? marks.gifterColors : PRISM_COLORS;
    const colors = tier.goal === 100 ? own : [tier.color];
    return { id, name: tier.name, colors, animated: marks.gifterAnimated !== false && colors.length > 1 };
  }
  const special = SPECIAL_BADGES[id];
  return special ? { id, name: special.name } : null;
}

/** The marks after a name, in the order the web shows them. */
export function hostMarks(marks: PlayerMarks): HostMark[] {
  return equippedNameBadges(marks)
    .map((id) => hostMark(id, marks))
    .filter((mark): mark is HostMark => mark !== null);
}

/** `seconds`: the run time while it runs; `at`: when that was (Unix ms). */
export function hostScoreRow(row: ScoreRow, seconds: number | null, at: number, afk = false): HostScoreRow {
  return {
    slot: row.slot,
    you: row.you,
    name: row.name,
    look: hostNameLook(row),
    marks: hostMarks(row),
    rank: row.rank ? { name: row.rank.name, color: row.rank.color } : null,
    country: typeof row.country === "string" && /^[a-z]{2}$/i.test(row.country) ? row.country.toLowerCase() : null,
    style: row.style,
    status: row.status,
    statusKind: row.statusKind,
    running: seconds === null ? null : { seconds, at },
    pb: row.pb,
    ping: row.ping,
    host: !!row.host,
    afk,
  };
}

export interface HostScoreboard {
  type: "scoreboard";
  /** `chatKey`: the chat bind's first key for the footer hint ("Y"), or null while it has none. */
  head: (ScoreHead & { chatKey: string | null }) | null;
  rows: HostScoreRow[];
}

/**
 * The Tab board for the room you're in (room-scoreboard.ts, the menu's own room screen), or an empty one outside a
 * room. `clockNow` / `serverNow`: the room service's clocks; `at`: Unix ms for the running times.
 */
export function hostScoreboard(
  view: RoomView | null,
  clock: { now: number; server: number; ping: number | null; at: number },
  chatKey: string | null = null,
): HostScoreboard {
  if (!view?.id) return { type: "scoreboard", head: null, rows: [] };
  const board = roomScoreboard(view, clock.now, clock.server, clock.ping);
  const idle = new Set(view.players.filter((player) => player.afk === true).map((player) => player.slot));
  const rows = board.rows.map((row) =>
    hostScoreRow(row, runningSeconds(view, row.slot, clock.now), clock.at, idle.has(row.slot)),
  );
  return { type: "scoreboard", head: { ...board.head, chatKey }, rows };
}

/** Sends the board when it changes; a running time ticking on its own isn't a change (the host advances it). */
export class ScoreboardFeed {
  /** Starts at the empty board: nothing is sent until there's a room, then the empty board once you leave it. */
  private last = JSON.stringify([null, []]);

  constructor(private readonly post: (board: HostScoreboard) => void) {}

  update(board: HostScoreboard): void {
    const steady = board.rows.map((row) => (row.running ? { ...row, status: "", running: null } : row));
    const key = JSON.stringify([board.head, steady]);
    if (key === this.last) return;
    this.last = key;
    this.post(board);
  }
}
