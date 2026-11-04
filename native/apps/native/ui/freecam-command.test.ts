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

const { registerFreecamCommand } = await import("./chat-service");
const { findChatCommand, runChatLine } = await import("../../web/src/chat-commands");

const replies: string[] = [];
const contextIn = (where: "solo" | "room") =>
  ({ where, reply: (text: string) => replies.push(text) }) as unknown as ChatContext;

test("!freecam, !fc and !freelook ask the host for freecam, solo and in rooms", () => {
  const unregister = registerFreecamCommand();
  expect(unregister).not.toBeNull();
  cleanups.push(unregister!);
  expect(findChatCommand("fc")?.name).toBe("freecam");
  // Once registered (later by the website's own command), it is left alone rather than registered twice.
  expect(registerFreecamCommand()).toBeNull();

  runChatLine("!freecam", contextIn("solo"));
  runChatLine("!fc", contextIn("room"));
  runChatLine("/freelook", contextIn("solo"));
  expect(sent.slice(-3)).toEqual([
    { type: "chatAction", action: "freecam" },
    { type: "chatAction", action: "freecam" },
    { type: "chatAction", action: "freecam" },
  ]);
  expect(replies).toEqual([]);
});
