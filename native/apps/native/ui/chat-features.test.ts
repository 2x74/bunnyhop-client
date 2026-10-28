import { afterAll, expect, test } from "bun:test";
import type { ChatContext } from "../../web/src/chat-commands";

// bridge.ts sends through window: a bare EventTarget stands in for it.
const host = new EventTarget();
Object.assign(globalThis, { window: host });
const sent: Record<string, unknown>[] = [];
host.addEventListener("bunnyhop:native-message", (event) => sent.push((event as CustomEvent).detail));
// The command registry is shared with the other test files: leave it as it was found.
const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
  Reflect.deleteProperty(globalThis, "window");
});

const { applyChatFeatures, registerStrafeTrainerCommand } = await import("./chat-features");
const { findChatCommand, runChatLine } = await import("../../web/src/chat-commands");

const replies: string[] = [];
const context = { where: "solo", reply: (text: string) => replies.push(text) } as unknown as ChatContext;

test("feature commands appear with the host's capability and go to the host", () => {
  expect(findChatCommand("paint")).toBeUndefined();
  cleanups.push(() => applyChatFeatures({ capabilities: [] }));
  applyChatFeatures({ capabilities: ["paint", "movementStats"] });
  expect(findChatCommand("paintcolor")?.name).toBe("paintoptions");
  expect(findChatCommand("measure")).toBeUndefined();

  runChatLine("!paint", context);
  runChatLine("!fjt on", context);
  runChatLine("!jt", context);
  expect(sent.slice(-3)).toEqual([
    { type: "chatAction", action: "paint" },
    { type: "chatAction", action: "movementStat", stat: "fjt", on: true },
    { type: "chatAction", action: "movementStat", stat: "fjt" },
  ]);
  runChatLine("!lj maybe", context);
  expect(replies.at(-1)).toBe("Usage: !lj [on|off]");

  // A state without the list keeps them; a list without the feature takes its commands away.
  applyChatFeatures({ map: "bhop_arcane" });
  expect(findChatCommand("paint")?.name).toBe("paint");
  applyChatFeatures({ capabilities: ["measure"] });
  expect(findChatCommand("paint")).toBeUndefined();
  expect(findChatCommand("distance")?.name).toBe("measure");
  runChatLine("!measure clear", context);
  expect(sent.at(-1)).toEqual({ type: "chatAction", action: "clearMeasure" });
});

test("!strafetrainer flips the native trainer setting", () => {
  cleanups.push(registerStrafeTrainerCommand());
  runChatLine("!st", context);
  expect(sent.at(-1)).toEqual({ type: "settings", patch: { strafeTrainer: true } });
  runChatLine("!strafetrainer off", context);
  expect(sent.at(-1)).toEqual({ type: "settings", patch: { strafeTrainer: false } });
});
