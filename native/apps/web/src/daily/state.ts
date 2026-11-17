// The Daily Challenge on the client (apps/api src/daily.ts): one map a day, 16:00 UTC to 16:00 UTC, with its own board.
// DOM-free: the shared read of GET /daily (the home block, the menu line, the daily screen and the game all ask the
// same answer), what the lines say, and the tag on runs played from the Daily entry.
//
// The server decides which runs count (the day's map in the day's style, main track, started inside the day by its own
// clock): `?daily=<day>` on a submission only says the run came from the Daily entry.

import { api, type DailyView, type Submission } from "../api";
import { isStyleId, styleDef, styleLabel, type StyleId } from "../styles";
import { formatTime } from "../timer";
import { achievement, COSMETICS, DAILY_LADDER, dailyStepId } from "../progression";

/** A day is Normal (autohop) on the main track unless staff gave it another style (the day's `style`). */
export const DAILY_STYLE = "autohop";
/** The style a day is played in, from what the server or a link says: a ranked style that shares Normal's boards, else Normal. */
export function dailyStyle(v: string | null | undefined): StyleId {
  const d = isStyleId(v) ? styleDef(v) : null;
  return d && !d.auto && !d.separate && !d.segmented ? d.id : DAILY_STYLE;
}
/** ", EZ Scroll" after a map's name on a day that isn't Normal; nothing on a Normal day. */
export const styleNote = (style: string | null | undefined): string => (dailyStyle(style) === DAILY_STYLE ? "" : `, ${styleLabel(dailyStyle(style))}`);
const TTL_MS = 30_000;
let cached: { at: number; view: Promise<DailyView> } | null = null;

/** GET /daily, shared for `maxAge` (a failed answer isn't kept). Offline (no API): no daily. */
export function dailyNow(maxAge = TTL_MS): Promise<DailyView> {
  if (!api.available()) return Promise.resolve({ enabled: false });
  const now = Date.now();
  if (cached && now - cached.at < maxAge) return cached.view;
  const view = api.daily();
  const entry = { at: now, view };
  cached = entry;
  view.catch(() => cached === entry && (cached = null));
  return view;
}
/** After a run of yours counted (or in tests): ask again next time. */
export const forgetDaily = () => void (cached = null);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (v: string | null | undefined): v is string => !!v && DAY_RE.test(v);

/** Where the Daily entry sends the player: the day's map, in the day's style, marked as the daily. */
export const dailyPlayHref = (day: string, map: string, style: string = DAILY_STYLE) =>
  `/?map=${encodeURIComponent(map)}&daily=${encodeURIComponent(day)}${dailyStyle(style) === DAILY_STYLE ? "" : `&style=${dailyStyle(style)}`}`;
export const dailyPath = (day?: string | null) => (day ? `/daily/${day}` : "/daily");

/** "5h 12m", "38m", "under a minute"; null once it has ended. */
export function timeLeft(endsAt: number, now = Date.now()): string | null {
  const left = endsAt - now;
  if (left <= 0) return null;
  const min = Math.floor(left / 60_000);
  if (min < 1) return "under a minute";
  const hh = Math.floor(min / 60);
  return hh ? `${hh}h ${min % 60}m` : `${min}m`;
}

/** 1 → "1st", 22 → "22nd", 113 → "113th". */
export function place(n: number): string {
  const t = n % 100;
  const s = t >= 11 && t <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n.toLocaleString("en-US")}${s}`;
}

/** "4th of 57", or "1st" when alone. */
export const placeOf = (rank: number, of: number | null | undefined) => (of && of > 1 ? `${place(rank)} of ${of.toLocaleString("en-US")}` : place(rank));

/** The line under a verified run's result when it counted for the day (null: it didn't, or it is a guest's: guestResultLine). */
export function resultLine(d: Submission["daily"]): string | null {
  if (!d || d.rank === undefined || d.guest) return null;
  const where = placeOf(d.rank, d.of);
  if (d.best !== false) return `Daily Challenge: ${where}`;
  return d.time !== undefined ? `Daily Challenge: your best today stays ${formatTime(d.time)}, ${where}` : `Daily Challenge: ${where}`;
}

/**
 * The HUD's line while playing the day's map. `style`: the day's; `playing`: the style the player is in. In another
 * style the line says the run won't count, instead of counting down.
 */
export const hudLine = (endsAt: number, now = Date.now(), style: string = DAILY_STYLE, playing: string = style): string => {
  const left = timeLeft(endsAt, now);
  if (!left) return "Daily Challenge ended";
  if (playing !== style) return `Daily Challenge is ${styleLabel(style)} today, ${styleLabel(playing)} runs don't count`;
  return style === DAILY_STYLE ? `Daily Challenge, ${left} left` : `Daily Challenge, ${styleLabel(style)}, ${left} left`;
};

/** Under the result of a run on the day's map in a style that isn't the day's. */
export const wrongStyleLine = (style: string, played: string): string => `Daily Challenge: today is ${styleLabel(style)}, so this ${styleLabel(played)} run doesn't count`;

// --- guests: the day's board is for accounts (apps/api src/daily.ts). A guest's time is kept, and goes on the board when
// they link or set a password before the day's podium is frozen. What they are told (ui/daily-guest.ts shows it):

/** A guest's time of the day and where it would be: `rank` of `of`, with them counted in. */
export interface GuestTime {
  day: string;
  rank: number;
  of: number;
  time: number;
}
/** Under a guest's verified daily run. `asked`: the offer stands (false: they said "Not now" today). */
export const guestResultLine = (d: { rank: number; of?: number }, asked: boolean): string =>
  `Daily Challenge: that would be ${placeOf(d.rank, d.of)} today. ${asked ? "Press Esc to put it on the board." : "The board shows accounts."}`;
/** The pause menu's sentence for the offer. */
export const guestPromptText = (t: GuestTime): string =>
  `Your ${formatTime(t.time)} would be ${placeOf(t.rank, t.of)} today. The board shows accounts: link one or set a password and your time goes on it, with medals and daily unlocks counting from then on.`;
/** The home block's and the daily screen's own line for a guest with a time. */
export const guestPlace = (rank: number, of: number): string => `Would be ${placeOf(rank, of)}`;

const GUEST_NO_KEY = "bunnyhop:daily-guest-no";
/** Also for this page when storage is blocked (private mode), so "Not now" still holds. */
let guestNo: string | null = null;
/** The guest said "Not now" to the offer for `day`. It is asked again on another day. */
export function guestSaidNo(day: string): boolean {
  if (guestNo === day) return true;
  try {
    return localStorage.getItem(GUEST_NO_KEY) === day;
  } catch {
    return false;
  }
}
export function guestSayNo(day: string): void {
  guestNo = day;
  try {
    localStorage.setItem(GUEST_NO_KEY, day);
  } catch {
    /* private mode: for this page */
  }
}

// --- the tag on runs played from the Daily entry (online.ts)

let session: { day: string; map: string; style: string; endsAt: number } | null = null;
/** The page is playing `map` from the Daily entry (daily/mode.ts); null: not (any more). */
export const setDailySession = (s: typeof session) => void (session = s);
export const dailySession = () => session;
/** The day a finished run is submitted for (POST /runs?daily=), or null. */
export function currentDaily(run: { map: string; style: string; track: number } | null | undefined): string | null {
  return run && session && run.map === session.map && run.style === session.style && run.track === 0 ? session.day : null;
}

// --- taking part: what the player is working toward (the daily screen's one line)

const SLOT_WORD: Record<string, string> = { outfit: "colourway", camo: "gun camo", finish: "knife finish", title: "title" };
const dailies = (n: number) => (n === 1 ? "1 Daily Challenge" : `${n.toLocaleString("en-US")} Daily Challenges`);

/** The next step of the taking-part ladder after `days` finished, with what it unlocks; null past the last one. */
export function nextDailyStep(days: number): { at: number; left: number; reward: string | null } | null {
  const at = DAILY_LADDER.find((n) => n > days);
  if (at === undefined) return null;
  const id = dailyStepId(at);
  // The step's item (a step with an item and a title names the item).
  const items = COSMETICS.filter((c) => c.unlock.kind === "achievement" && c.unlock.id === id);
  const item = items.find((c) => c.slot !== "title") ?? items[0];
  const title = achievement(id)?.title;
  return { at, left: at - days, reward: item ? `the ${item.name} ${SLOT_WORD[item.slot] ?? "item"}` : title ? `the ${title} title` : null };
}

/** "You've finished 12 Daily Challenges. 3 more unlock the Noon colourway." One line, whatever the count. */
export function progressLine(days: number): string {
  const next = nextDailyStep(days);
  if (days <= 0) return next?.reward ? `Finish today's map to unlock ${next.reward}.` : "Finish today's map to get on the board.";
  const done = `You've finished ${dailies(days)}.`;
  if (!next?.reward) return done;
  return `${done} ${next.left === 1 ? "One more unlocks" : `${next.left} more unlock`} ${next.reward}.`;
}
