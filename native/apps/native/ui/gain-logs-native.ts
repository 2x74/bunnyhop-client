// Gain logs in the desktop client. The game counts the six-jump windows (gain_logs.hpp) and hands each to the menu;
// everything else is the website's: the line and its bar (ssj/logs.ts GainLogs through ssj/index.ts gainLogs, with
// !logs and cl_logs / cl_logs_mine on the website's settings), the room relay (Normal style, never practice:
// net/protocol.ts GAIN_LOG_STYLES) and other players' lines.
import { GAIN_LOG_STYLES, type GainLogReport } from "../../web/src/net/protocol";
import { logsWanted, type LogsPrefs, type LogTags } from "../../web/src/ssj/logs";
import type { RoomGainLogs } from "./room-service";

/** The website's GainLogs (ssj/logs.ts) as the menu uses it. */
export interface GainLogLines {
  roomBar: number | null;
  own(r: GainLogReport, t?: Omit<LogTags, "name">, toRoom?: boolean): void;
  other(r: GainLogReport, name: string): void;
}

export interface GainLogRoom {
  /** Sends your window with the next state batch; false when the room doesn't relay gain logs. */
  relayLog(log: GainLogReport): boolean;
}

/** A window from the game (window.bunnyhopNativeMenu.onGainLog), with its run's style and practice flag. */
export interface GameGainLog {
  report: GainLogReport;
  style: string;
  practice: boolean;
}

const count = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
const percent = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The game's message, checked: anything malformed is dropped. */
export function gameGainLog(value: unknown): GameGainLog | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!count(v.jump, 0xffff) || !count(v.jumps, 6) || !count(v.strafes, 0xffff) || !count(v.ticks, 0xffff)) return null;
  if (!percent(v.gain) || !percent(v.sync) || typeof v.style !== "string" || typeof v.practice !== "boolean")
    return null;
  const report = { jump: v.jump, jumps: v.jumps, gain: v.gain, sync: v.sync, strafes: v.strafes, ticks: v.ticks };
  return { report, style: v.style, practice: v.practice };
}

export class NativeGainLogs {
  constructor(
    private readonly lines: GainLogLines,
    private readonly room: GainLogRoom,
    private readonly prefs: () => LogsPrefs,
  ) {}

  /** Your window (web session.ts gainLog): your own line, and the room's copy for Normal runs that aren't practice. */
  own(value: unknown): void {
    const log = gameGainLog(value);
    if (!log) return;
    const toRoom = !log.practice && GAIN_LOG_STYLES.has(log.style) && this.room.relayLog(log.report);
    this.lines.own(log.report, { practice: log.practice, autostrafe: log.style === "autostrafe" }, toRoom);
  }

  /** The room service's side (room-service.ts RoomGainLogs). */
  roomSide(hidden: (id: string) => boolean): RoomGainLogs {
    return {
      roomBar: (bar) => void (this.lines.roomBar = bar),
      wanted: (bar) => logsWanted(this.prefs(), bar),
      other: (log, name) => this.lines.other(log, name),
      hidden,
    };
  }
}
