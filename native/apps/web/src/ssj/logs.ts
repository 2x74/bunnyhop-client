// Gain logs (!logs): every 6 jumps, one chat line with the gain, strafes per jump and sync over those jumps, as CS:S
// strafers know them from their servers' gain logs. In a server (0.0.43, owner: "show it in server chat too, 85 or
// higher") everyone's line at the room's bar (85%, the welcome's room.logs) shows in everyone's chat unless they turn
// them off; your own every line, solo too, is opt-in (!logs me). The numbers are what each player's game reports: the
// room checks their ranges and passes them on (net/protocol.ts EXT_LOG), staff never act on them (the anticheat reads
// the replay). DOM-free (test/ssj-logs.test.ts).
//
// How the window works (the CS:S plugin's gain log, research in the v0.0.43 rooms report): the jump count and its
// "too long on the ground" reset are SSJ's (stats.ts); every 6th jump closes a window of the six jumps' air ticks, and
// its gain is the SSJ gain over them. Unlike the plugin, a jump with any air tick turned by a turn bind (+left /
// +right) is left out of the window, and a window with fewer than LOG_MIN_JUMPS clean jumps makes no line. Like it,
// a window needs more than LOG_AIR_TICKS_PER_JUMP air ticks per counted jump (its 300 over six), so short hops don't
// make lines.

import { LOG_AIR_TICKS_PER_JUMP, LOG_MIN_JUMPS, type GainLogReport } from "../net/protocol";
import { GOOD_GAIN, SSJ_SEP, SsjTracker, type SsjCmd, type SsjItem, type SsjState, type SsjTick, type SsjWindow } from "./stats";

export interface LogsPrefs {
  /** Your own line every window (solo too), whatever the gain (over minGain). */
  own: boolean;
  /** In a server, the lines at the bar from everyone there, yours included. */
  others: boolean;
  /** Only lines with at least this gain %. 0: every line of yours, and the server's bar for the others'. */
  minGain: number;
}

/** In a server you see the lines at its bar (0.0.43); your own every line is opt-in. */
export const DEFAULT_LOGS: LogsPrefs = { own: false, others: true, minGain: 0 };

/** Jumps a window covers. */
export const LOG_JUMPS = 6;
/** Other players' lines shown per LOG_WINDOW_MS at most; past that, one line says how many were left out. */
export const LOG_OTHERS_MAX = 4;
export const LOG_WINDOW_MS = 5000;

/**
 * Every-6th-jump windows of clean jumps (no turn-bind tick in the air): a GainLogReport when a window has enough of
 * them, else nothing. Fed like LiveSsj's trackers.
 */
export class GainLogTracker {
  private t = new SsjTracker("every");
  private jumps: SsjWindow[] = [];

  reset(): void {
    this.t.reset();
    this.jumps = [];
  }

  tick(pre: SsjState, cmd: SsjCmd, tick: SsjTick): GainLogReport | null {
    const before = this.t.jump;
    this.t.tick(pre, cmd, tick);
    const n = this.t.jump;
    if (n < before || n === 0) this.jumps = []; // stood still: the count started over
    if (n === before || !this.t.lastWindow) return null;
    this.jumps.push(this.t.lastWindow);
    if (n % LOG_JUMPS) return null;
    const clean = this.jumps.filter((w) => w.binds === 0);
    this.jumps = [];
    const sum = (k: keyof SsjWindow) => clean.reduce((a, w) => a + w[k], 0);
    const ticks = sum("ticks");
    if (clean.length < LOG_MIN_JUMPS || ticks <= clean.length * LOG_AIR_TICKS_PER_JUMP) return null;
    return { jump: n, jumps: clean.length, gain: Math.round((sum("rawGain") / ticks) * 10000) / 100, sync: (100 * sum("synced")) / ticks, strafes: sum("strafes"), ticks };
  }
}

export interface LogTags {
  /** The player's name (other players' lines). */
  name?: string;
  practice?: boolean;
  autostrafe?: boolean;
}

const trunc1 = (v: number) => (Math.trunc(v * 10) / 10).toFixed(1);

/**
 * A log line's items: "91.2% gain over 6 jumps", "4.2 strafes per jump", "93% sync", with the name first and
 * "Practice" / "Auto-strafe" last when given (your own lines only: the room relays neither).
 */
export function gainLogItems(r: GainLogReport, t: LogTags = {}): SsjItem[] {
  const out: SsjItem[] = [];
  if (t.name) out.push([t.name]);
  out.push(
    [{ n: `${trunc1(r.gain)}%`, good: r.gain >= GOOD_GAIN }, ` gain over ${r.jumps} jumps`],
    [{ n: trunc1(r.strafes / r.jumps) }, " strafes per jump"],
    [{ n: `${Math.trunc(r.sync)}%` }, " sync"],
  );
  if (t.practice) out.push(["Practice"]);
  if (t.autostrafe) out.push(["Auto-strafe"]);
  return out;
}

export const itemsText = (items: SsjItem[]): string =>
  items.map((it) => it.map((x) => (typeof x === "string" ? x : x.n)).join("")).join(SSJ_SEP);

/** "91.2% gain over 6 jumps · 4.2 strafes per jump · 93% sync". */
export const gainLogText = (r: GainLogReport, t: LogTags = {}): string => itemsText(gainLogItems(r, t));

/** The bar of the server lines you see: yours if you set one, else the server's (`roomBar`, the welcome's room.logs). */
export const logsBar = (p: LogsPrefs, roomBar: number): number => (p.minGain > 0 ? p.minGain : roomBar);

/** What a room is asked for ({ t: "logs" }): other players' lines at your bar, or none. */
export const logsWanted = (p: LogsPrefs, roomBar: number): number | null => (p.others ? logsBar(p, roomBar) : null);

/** Where a line goes: the console (every line while logs are on) and the chat (the ones over the gain bar). */
export interface LogSink {
  console(text: string): void;
  chat(text: string, items: SsjItem[]): void;
}

export class GainLogs {
  private shownAt: number[] = [];
  private hidden = 0;
  /** The room's bar while in a room that relays gain logs (net/mp.ts, the welcome's room.logs); null elsewhere. */
  roomBar: number | null = null;

  constructor(private prefs: () => LogsPrefs, private sink: LogSink, private now: () => number = () => performance.now()) {}

  /**
   * Your own window. `toRoom`: it is one the room passes on (net/mp.ts sends it): then with server lines on it shows
   * like everyone else's when it reaches your bar, even with your own lines off.
   */
  own(r: GainLogReport, t: Omit<LogTags, "name"> = {}, toRoom = false): void {
    const p = this.prefs();
    const text = gainLogText(r, t);
    if (p.own) {
      this.sink.console(text); // (also the ones under the gain bar, to read back)
      if (r.gain >= p.minGain) this.sink.chat(text, gainLogItems(r, t));
    } else if (toRoom && p.others && this.roomBar !== null && r.gain >= logsBar(p, this.roomBar)) {
      this.sink.console(text);
      this.sink.chat(text, gainLogItems(r, t));
    }
  }

  /**
   * Another player's window, relayed by the room. The caller leaves out muted and blocked players. At most
   * LOG_OTHERS_MAX lines per LOG_WINDOW_MS (the room has its own caps).
   */
  other(r: GainLogReport, name: string): void {
    const p = this.prefs();
    if (!p.others || this.roomBar === null || r.gain < logsBar(p, this.roomBar)) return;
    const now = this.now();
    this.shownAt = this.shownAt.filter((at) => now - at < LOG_WINDOW_MS);
    if (this.shownAt.length >= LOG_OTHERS_MAX) {
      this.hidden++;
      return;
    }
    if (this.hidden) {
      const line = `(${this.hidden} more hidden)`;
      this.sink.chat(line, [[line]]);
      this.hidden = 0;
    }
    this.shownAt.push(now);
    const items = gainLogItems(r, { name });
    const text = itemsText(items);
    this.sink.console(text);
    this.sink.chat(text, items);
  }
}

/** What !logs [on|off|me|gain %] does to the prefs, and its reply; null for anything else. */
export function logsCommand(arg: string, p: LogsPrefs): { next: LogsPrefs; reply: string } | null {
  const v = arg.trim().toLowerCase().replace(/%$/, "");
  const ON = "Gain logs on: your line every 6 jumps, and in servers everyone's good ones. !logs off turns them off.";
  const OFF = "Gain logs off, other players' too. !logs on brings them back.";
  if (!v) return p.own || p.others ? { next: { ...p, own: false, others: false }, reply: OFF } : { next: { ...p, own: true, others: true }, reply: ON };
  if (v === "on") return { next: { ...p, own: true, others: true }, reply: ON };
  if (v === "off") return { next: { ...p, own: false, others: false }, reply: OFF };
  if (v === "me") return { next: { ...p, own: true, others: false }, reply: "Gain logs on, your own only." };
  const n = Number(v);
  if (!/^\d+(\.\d+)?$/.test(v) || !(n >= 0 && n <= 100)) return null;
  const minGain = Math.round(n);
  const next = { own: p.own, others: true, minGain };
  return { next, reply: minGain > 0 ? `Gain logs: only lines with ${minGain}% gain or more.` : "Gain logs: every line of yours (if on), and the server's usual bar for everyone's." };
}
