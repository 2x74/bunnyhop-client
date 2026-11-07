import { expect, test } from "bun:test";
import type { RoomRaceView } from "../../web/src/net/protocol";
import { validRoomRace, roomRaceTag } from "./room-race";
import { resolveRaceCommand } from "./chat-input";

import { roomRace } from "./fixtures/room-race";

test("room races reserve all; numbered players and duel controls keep working", () => {
  const people = [{ slot: 1, name: "All" }];
  expect(resolveRaceCommand("all hsw", people, 0, "legit")).toEqual({ text: "/race all hsw 0" });
  expect(resolveRaceCommand("ALL", people, 0, "legit")).toEqual({ text: "/race all legit 0" });
  expect(resolveRaceCommand("all bonus2", [], 0, "legit", [1, 2])).toEqual({ text: "/race all autohop 2" });
  expect(resolveRaceCommand("all b3", [], 0, "legit", [1, 2])).toHaveProperty("error");
  expect(resolveRaceCommand("all segmented", [], 0, "legit")).toHaveProperty("error");
  expect(resolveRaceCommand("#1", people, 0, "legit")).toEqual({ text: "/race #1 legit 0" });
  expect(resolveRaceCommand("cancel", people, 0, "legit")).toEqual({ text: "/race cancel" });
});

test("room-race tags follow current membership, board and awarded places", () => {
  const board = { map: "bhop_eazy", style: "autohop", track: 0 };
  const r = roomRace("live");
  expect(roomRaceTag(r, board)).toBe(r.id);
  for (const patch of [{ map: "other" }, { style: "hsw" }, { track: 1 }])
    expect(roomRaceTag(r, { ...board, ...patch })).toBeNull();
  expect(roomRaceTag({ ...r, state: "countdown" }, board)).toBeNull();
  expect(roomRaceTag({ ...r, you: -1 }, board)).toBeNull();
  r.racers[0].place = 1;
  expect(roomRaceTag(r, board)).toBeNull();
  r.racers[0].place = null;
  r.racers[0].dnf = "forfeit";
  expect(roomRaceTag(r, board)).toBeNull();
  r.you = 1;
  expect(roomRaceTag(r, board)).toBe(r.id);
});

test("room-race socket views are bounded before reaching the host", () => {
  const r = roomRace();
  expect(validRoomRace(r)).toBe(true);
  expect(validRoomRace(null)).toBe(true);
  for (const patch of [
    { you: 2 },
    { you: -2 },
    { racers: null },
    { goAt: NaN },
    { id: "no" },
    { track: 65 },
    { racers: Array(65).fill(r.racers[0]) },
    { racers: [{ ...r.racers[0], place: 0 }] },
  ])
    expect(validRoomRace({ ...r, ...patch } as RoomRaceView)).toBe(false);
});
