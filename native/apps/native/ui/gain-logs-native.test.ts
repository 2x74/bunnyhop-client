import { expect, test } from "bun:test";
import { DEFAULT_LOGS, GainLogs, logsCommand, type LogsPrefs } from "../../web/src/ssj/logs";
import { gameGainLog, NativeGainLogs } from "./gain-logs-native";

/** The website's own GainLogs with its line sinks captured, and a room that relays when `relays`. */
function rig(p: Partial<LogsPrefs> = {}, relays = false) {
  let prefs: LogsPrefs = { ...DEFAULT_LOGS, ...p };
  const chat: string[] = [],
    relayed: unknown[] = [];
  const lines = new GainLogs(() => prefs, { console: () => {}, chat: (text) => chat.push(text) });
  const logs = new NativeGainLogs(
    lines,
    { relayLog: (log) => (relays ? (relayed.push(log), true) : false) },
    () => prefs,
  );
  const side = logs.roomSide(() => false);
  return { logs, side, chat, relayed, setPrefs: (next: LogsPrefs) => void (prefs = next) };
}
const game = (gain: number, o: Record<string, unknown> = {}) => ({
  jump: 12,
  jumps: 6,
  gain,
  sync: 92.4,
  strafes: 25,
  ticks: 400,
  style: "autohop",
  practice: false,
  ...o,
});

test("solo: your own lines only with !logs me (off by default), in the website's words", () => {
  const r = rig();
  r.logs.own(game(91.25));
  expect(r.chat).toEqual([]);
  const me = logsCommand("me", DEFAULT_LOGS)!;
  r.setPrefs(me.next);
  r.logs.own(game(91.25));
  r.logs.own(game(70, { practice: true, style: "autostrafe" }));
  expect(r.chat).toEqual([
    "91.2% gain over 6 jumps · 4.1 strafes per jump · 92% sync",
    "70.0% gain over 6 jumps · 4.1 strafes per jump · 92% sync · Practice · Auto-strafe",
  ]);
});

test("in a room at 85%: a Normal window goes to the room and shows at the bar; practice and other styles stay home", () => {
  const r = rig({}, true);
  r.side.roomBar(85);
  r.logs.own(game(91.25));
  r.logs.own(game(80));
  r.logs.own(game(95, { practice: true }));
  r.logs.own(game(95, { style: "wonly" }));
  expect(r.relayed).toHaveLength(2);
  expect(r.chat).toEqual(["91.2% gain over 6 jumps · 4.1 strafes per jump · 92% sync"]);
  // Other players' lines at your bar, by name; !logs 90 raises it and !logs off asks the room for none.
  r.side.other(game(88), "Ana");
  expect(r.chat.at(-1)).toBe("Ana · 88.0% gain over 6 jumps · 4.1 strafes per jump · 92% sync");
  expect(r.side.wanted(85)).toBe(85);
  r.setPrefs(logsCommand("90", DEFAULT_LOGS)!.next);
  expect(r.side.wanted(85)).toBe(90);
  r.side.other(game(88), "Bo");
  expect(r.chat.at(-1)).not.toContain("Bo");
  r.setPrefs(logsCommand("off", DEFAULT_LOGS)!.next);
  expect(r.side.wanted(85)).toBeNull();
});

test("a malformed window from the game is dropped", () => {
  expect(gameGainLog(game(90))).not.toBeNull();
  for (const bad of [null, 5, game(Number.NaN), game(90, { jumps: 7 }), game(90, { style: 1 }), game(90, { jump: -6 })])
    expect(gameGainLog(bad)).toBeNull();
});
