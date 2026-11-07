import { afterEach, expect, test } from "bun:test";
import { ConsoleRunner } from "../../web/src/console/exec";
import { prefs } from "../../web/src/ui/settings";
import { NativeChatService } from "./chat-service";
import { NativeRoomService } from "./room-service";

const before = structuredClone(prefs.get());
afterEach(() => prefs.update((p) => Object.assign(p, structuredClone(before))));

test("native console say binds toggle landfix privately in solo and rooms", () => {
  const ownWindow = typeof window === "undefined";
  if (ownWindow) Object.assign(globalThis, { window: new EventTarget() });
  const messages: { type: string; text?: string }[] = [];
  const listener = (event: Event) => messages.push((event as CustomEvent).detail);
  window.addEventListener("bunnyhop:native-message", listener);
  const room = new NativeRoomService({
    ensureAccount: async () => true,
    connect: () => {
      throw Error("offline");
    },
    send() {},
  });
  const posted: unknown[] = [];
  room.command = (message) => {
    posted.push(message);
    return true;
  };
  const chat = new NativeChatService(room, () => {});
  const console = new ConsoleRunner({
    get: () => prefs.get(),
    update: (fn) => prefs.update(fn),
    print() {},
    clear() {},
    chat: (line) => {
      chat.submit(line);
      return true;
    },
  });
  try {
    for (const id of [null, "easy"]) {
      room.view.id = id;
      prefs.update((p) => (p.landfix = true));
      console.run('bind k "say !landfix"');
      expect(prefs.get().cmdBinds.KeyK).toBe("say !landfix");
      console.run(prefs.get().cmdBinds.KeyK);
      expect(prefs.get().landfix).toBe(false);
      expect(messages.at(-1)).toMatchObject({ type: "chatLine", kind: "local", text: "Landfix off" });
      console.run("say !landfix on");
      expect(prefs.get().landfix).toBe(true);
      expect(messages.at(-1)?.text).toBe("Landfix on");
      console.run("say !landfix invalid");
      expect(prefs.get().landfix).toBe(true);
      expect(messages.at(-1)?.text).toBe("Use !landfix [on|off]");
      console.run("cl_landfix 0");
      expect(prefs.get().landfix).toBe(false);
      console.run("cl_landfix 1");
      expect(prefs.get().landfix).toBe(true);
    }
    expect(posted).toEqual([]);
    expect(messages.filter((message) => message.type !== "chatLine")).toEqual([]);
  } finally {
    window.removeEventListener("bunnyhop:native-message", listener);
    if (ownWindow) Reflect.deleteProperty(globalThis, "window");
  }
});
