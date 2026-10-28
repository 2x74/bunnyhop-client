import { test, expect } from "bun:test";
import { protocolChatText, ChatSuggestionFence, cycleSpectator, resolveRaceCommand } from "./chat-input";
test("protocol cap respects UTF16 units without emitting partial surrogate pairs", () => {
  expect(protocolChatText("a".repeat(127) + "🐰")).toBe("a".repeat(127));
  expect(protocolChatText("a".repeat(126) + "🐰x")).toBe("a".repeat(126) + "🐰");
  expect(protocolChatText("🐰".repeat(100)).length).toBe(128);
  expect(protocolChatText("a\ud800b\udc00c")).toBe("abc");
});
test("suggestions echo input/request and reject delayed older requests", () => {
  const fence = new ChatSuggestionFence();
  expect(fence.take({ text: "!r", request: 2 })).toEqual({ input: "!r", request: 2 });
  expect(fence.take({ text: "!h", request: 1 })).toBeNull();
  expect(fence.take({ text: "!help", request: 3 })).toEqual({ input: "!help", request: 3 });
  expect(fence.take({ text: "!h", request: NaN })).toBeNull();
  expect(fence.take("!style")).toEqual({ input: "!style", request: 4 });
});
const people = [
  { slot: 0, name: "Me" },
  { slot: 2, name: "Rabbit" },
  { slot: 3, name: "Rabbit King" },
  { slot: 4, name: "Rabbit Queen" },
];
test("race resolves longest names with spaces, unique prefix, slot, styles and tracks", () => {
  expect(resolveRaceCommand("Rabbit King hsw bonus2", people, 0, "legit")).toEqual({ text: "/race #3 hsw 2" });
  expect(resolveRaceCommand("Rabbit", people, 0, "legit")).toEqual({ text: "/race #2 legit 0" });
  expect(resolveRaceCommand("#4 normal main", people, 0, "legit")).toEqual({ text: "/race #4 autohop 0" });
  expect(resolveRaceCommand("Rabbit Q bonus", people, 0, "scroll")).toEqual({
    error: 'No style "Q". !style lists them.',
  });
  expect(resolveRaceCommand("Rab", people, 0, "legit")).toHaveProperty("error");
  expect(resolveRaceCommand("Nobody", people, 0, "legit")).toHaveProperty("error");
  expect(resolveRaceCommand("OFF", people, 0, "legit")).toEqual({ text: "/race off" });
  expect(resolveRaceCommand("#3 bonus3", people, 0, "legit", [1, 2])).toHaveProperty("error");
});
test("spectator cycle starts at first/last and skips self/spectators", () => {
  const players = [{ slot: 0 }, { slot: 2 }, { slot: 3, spec: 2 }, { slot: 4 }];
  expect(cycleSpectator(players, 0, null, 1)).toBe(2);
  expect(cycleSpectator(players, 0, null, -1)).toBe(4);
  expect(cycleSpectator(players, 0, 2, -1)).toBe(4);
  expect(cycleSpectator(players, 0, 4, 1)).toBe(2);
  expect(cycleSpectator([{ slot: 0 }], 0, null, 1)).toBeNull();
});
