import { afterAll, expect, test } from "bun:test";

// bridge.ts sends through window: a bare EventTarget stands in for it.
const host = new EventTarget();
Object.assign(globalThis, { window: host });
const sent: Record<string, unknown>[] = [];
host.addEventListener("bunnyhop:native-message", (event) => sent.push((event as CustomEvent).detail));
afterAll(() => {
  Reflect.deleteProperty(globalThis, "window");
});

const { NativeChatService } = await import("./chat-service");
const { findChatCommand } = await import("../../web/src/chat-commands");
type Room = ConstructorParameters<typeof NativeChatService>[0];

const roomWith = (id: string) => ({ view: { id, you: 0, players: [] } }) as unknown as Room;

test("the website's !freecam, !fc and !freelook ask the host for freecam, solo and in rooms", () => {
  expect(findChatCommand("fc")?.name).toBe("freecam");
  expect(findChatCommand("freelook")?.name).toBe("freecam");
  const solo = new NativeChatService(roomWith(""), () => undefined);
  const room = new NativeChatService(roomWith("room-1"), () => undefined);
  const before = sent.length;
  solo.submit("!freecam");
  room.submit("!fc");
  solo.submit("/freelook");
  expect(sent.slice(before).filter((message) => message.type === "chatAction")).toEqual([
    { type: "chatAction", action: "freecam" },
    { type: "chatAction", action: "freecam" },
    { type: "chatAction", action: "freecam" },
  ]);
});
