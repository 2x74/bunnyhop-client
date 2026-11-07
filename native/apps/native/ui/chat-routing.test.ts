import { afterAll, test, expect } from "bun:test";
import { ChatStyleSwitch } from "./chat-input";
import { dispatchNativeChat } from "./chat-routing";
import { state } from "./bridge";
import { chatCommands, suggestChat, type ChatContext } from "../../web/src/chat-commands";
function fixture(where: "room" | "solo" = "room") {
  const replies: string[] = [],
    actions: unknown[] = [],
    sent: unknown[] = [];
  const context: ChatContext = {
    where,
    reply: (text) => replies.push(text),
    restart: (track) => actions.push(["restart", track]),
    restartBonus: () => actions.push("bonus"),
    setStartPoint: () => actions.push("setStart"),
    clearStartPoint: () => actions.push("clearStart"),
    game: {
      key: () => null,
      practice: (cmd) => actions.push(cmd),
      style: () => "autohop",
      setStyle: (id) => actions.push(id),
      record: (kind) => actions.push(kind),
    },
    room:
      where === "room"
        ? {
            spectating: () => false,
            stopSpectating: () => actions.push("stop"),
            spectate: (name) => actions.push(["spec", name]),
            hidePlayers: () => {},
            toggleScores: () => {},
            openNominateMenu: () => actions.push("nominate"),
            invite: () => {},
            race: (arg) => actions.push(["race", arg]),
            report: (arg) => actions.push(["report", arg]),
          }
        : null,
  };
  return {
    replies,
    actions,
    sent,
    context,
    line: (text: string) =>
      dispatchNativeChat(text, context, (m) => {
        sent.push(m);
        return true;
      }),
  };
}
// Some commands registered by other files act on the host (!st switches the trainer setting and sends it): give them a
// window to send through, and put the menu state back afterwards so later files see the defaults.
const ownWindow = typeof globalThis.window === "undefined";
if (ownWindow) Object.assign(globalThis, { window: new EventTarget() });
const settingsBefore = JSON.parse(JSON.stringify(state.settings)) as typeof state.settings;
afterAll(() => {
  state.settings = settingsBefore;
  if (ownWindow) Reflect.deleteProperty(globalThis, "window");
});
test("all built-in commands and aliases resolve without accidental ordinary chat broadcast", () => {
  for (const command of chatCommands())
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      const f = fixture(command.where === "solo" ? "solo" : "room");
      f.line(`!${name}`);
      // Server-only entries broadcast; help is explicitly a local server log.
      if (command.server && !command.run) expect(f.sent).toEqual([{ t: "chat", text: `!${name}` }]);
      else if (command.name === "help" || command.group === "practice")
        expect(f.sent).toEqual([{ t: "chat", text: `!${name}`, local: true }]);
      else expect(f.sent).toEqual([]);
    }
});
test("native local restart/style/start/practice actions never reach the room", () => {
  const f = fixture();
  for (const command of [
    "!r",
    "/restart",
    "!sm_restart",
    "!m",
    "!b",
    "!setstart",
    "!clearstart",
    "!style hsw",
    "!pb",
    "!wr",
  ])
    f.line(command);
  expect(f.sent).toEqual([]);
  expect(f.actions).toContainEqual(["restart", 0]);
  expect(f.actions).toContain("hsw");
  expect(f.actions).toContain("setStart");
  expect(f.actions).toContain("clearStart");
  f.line("!noclip");
  expect(f.sent).toEqual([{ t: "chat", text: "!noclip", local: true }]);
  expect(f.actions).toContain("noclip");
});
test("plain chat and server commands send exactly once; unknown commands are private logs", () => {
  const f = fixture();
  f.line("hello");
  f.line("rtv");
  f.line("!nominate bhop_test");
  f.line("!notarealcommand");
  expect(f.sent).toEqual([
    { t: "chat", text: "hello" },
    { t: "chat", text: "rtv" },
    { t: "chat", text: "!nominate bhop_test" },
    { t: "chat", text: "!notarealcommand", local: true },
  ]);
  expect(f.replies.length).toBe(1);
});
test("solo commands reply locally, suggestions and unavailable room commands never send", () => {
  const f = fixture("solo");
  f.line("hello");
  f.line("rtv");
  f.line("!practice");
  f.line("!spec");
  expect(f.sent).toEqual([]);
  expect(f.actions).toEqual(["toggle"]);
  expect(f.replies.length).toBe(3);
  expect(suggestChat("!rest", "solo").length).toBeGreaterThan(0);
});
test("disconnected server commands answer clearly; local commands still work", () => {
  const f = fixture();
  dispatchNativeChat("rtv", f.context, () => false);
  dispatchNativeChat("!r", f.context, () => {
    throw Error("local command transmitted");
  });
  expect(f.replies).toEqual(["The room is not connected."]);
  expect(f.actions).toEqual([["restart", undefined]]);
});

test("explicit practice arguments and aliases keep their intent", () => {
  const f = fixture("solo");
  for (const text of ["!practice off", "!practice off", "!prac on", "!practice on", "!practice"]) f.line(text);
  expect(f.actions).toEqual(["off", "off", "on", "on", "toggle"]);
  f.line("!practice invalid");
  expect(f.actions).toHaveLength(5);
  expect(f.replies.at(-1)).toContain("[on|off]");
});
test("a Russian layout or a leading dot runs the command, and the room gets it in its usual form", () => {
  const f = fixture();
  f.line("!ызус");
  f.line(".rtv");
  f.line(".кем");
  f.line("!кфсу Экролин");
  expect(f.actions).toEqual([
    ["spec", ""],
    ["race", "Экролин"],
  ]);
  expect(f.sent).toEqual([
    { t: "chat", text: "/rtv" },
    { t: "chat", text: "/rtv" },
  ]);
});
test("chat that only looks like a command stays chat, as typed", () => {
  const f = fixture();
  const lines = ["...", ". ok", ".lol", ".gg", "!привет", "/спасибо", "кем"];
  for (const text of lines) f.line(text);
  expect(f.actions).toEqual([]);
  expect(f.sent).toEqual(lines.map((text) => ({ t: "chat", text })));
});
test("a style command says how to get back to Normal, only when the switch takes", () => {
  for (const taken of [true, false]) {
    const f = fixture();
    const styleSwitch = new ChatStyleSwitch(
      () => "autohop",
      () => taken,
    );
    f.context.game!.style = () => styleSwitch.style();
    f.context.game!.setStyle = (id) => styleSwitch.set(id);
    f.line("!lg");
    expect(f.replies.includes("Low Gravity. !n goes back to Normal.")).toBe(taken);
  }
  const back = fixture();
  back.line("!n");
  expect(back.replies.some((reply) => reply.includes("goes back to Normal"))).toBe(false);
});

test("room-race aliases resolve locally and membership commands reach the room", () => {
  const f = fixture();
  f.line("!roomrace hsw b2");
  expect(f.actions).toEqual([["race", "all hsw b2"]]);
  for (const command of ["!join", "!leave", "!forfeit"]) f.line(command);
  expect(f.sent).toEqual(["!join", "!leave", "!forfeit"].map((text) => ({ t: "chat", text })));
});

test("Copy start stays local and gives room picks priority over board lookups", () => {
  const f = fixture();
  f.context.game!.copyStart = (arg) => {
    f.actions.push(["copyStart", arg]);
  };
  f.context.room!.copyStart = (arg) => {
    if (arg) return false;
    f.actions.push("copyStartMenu");
    return true;
  };
  f.line("!copystart");
  f.line("!copystart #3");
  expect(f.actions).toEqual(["copyStartMenu", ["copyStart", "#3"]]);
  expect(f.sent).toEqual([]);
});
