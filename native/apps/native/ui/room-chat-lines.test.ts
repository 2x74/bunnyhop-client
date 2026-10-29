import { test, expect } from "bun:test";
import { roomChatLines, type RoomChatContext } from "./room-chat-lines";
import type { RosterPlayer, ServerMsg } from "../../web/src/net/protocol";

const context: RoomChatContext = { you: 0, youId: "me", room: null, host: null, changing: false };
const player = (slot: number, name: string, extra: Partial<RosterPlayer> = {}) =>
  ({ slot, id: `id-${slot}`, name, style: "autohop", spec: null, pb: {}, ...extra }) as RosterPlayer;

test("join and leave read like the website's room lines", () => {
  const rank = { id: "gold", name: "Gold", color: "#ffc53d" };
  expect(roomChatLines({ t: "join", player: player(1, "WebHopper", { rank }) }, context)).toEqual([
    { kind: "server", text: "WebHopper joined (Gold)." },
  ]);
  expect(roomChatLines({ t: "leave", slot: 1, name: "WebHopper", reason: "AFK" }, context)).toEqual([
    { kind: "server", text: "WebHopper left (AFK)." },
  ]);
  // A map change reconnects everyone quietly.
  expect(roomChatLines({ t: "join", player: player(1, "WebHopper"), quiet: true }, context)).toEqual([]);
  expect(roomChatLines({ t: "leave", slot: 1, name: "WebHopper", quiet: true }, context)).toEqual([]);
});

test("kicks, refused joins and the host handover", () => {
  expect(roomChatLines({ t: "kicked", reason: "AFK for 5 min while the server was full" }, context)).toEqual([
    { kind: "admin", text: "Disconnected: AFK for 5 min while the server was full" },
  ]);
  expect(roomChatLines({ t: "error", code: "banned", message: "You are banned from this server." }, context)).toEqual([
    { kind: "private", text: "You are banned from this server." },
  ]);
  expect(roomChatLines({ t: "host", slot: 0 }, context)[0]?.text).toStartWith("You're the host now:");
  expect(roomChatLines({ t: "host", slot: 0 }, { ...context, host: 0 })).toEqual([]);
  expect(roomChatLines({ t: "host", slot: 0 }, { ...context, changing: true })).toEqual([]);
  expect(roomChatLines({ t: "host", slot: 2 }, context)).toEqual([]);
});

test("gifts thank the recipient once", () => {
  const gift: ServerMsg = {
    t: "gift",
    batchId: "b1",
    count: 3,
    names: ["a", "b"],
    sender: { id: "s", name: "Santa" },
    recipients: [{ id: "me", name: "a" }],
  };
  expect(roomChatLines(gift, context)).toEqual([
    { kind: "server", text: "Santa gifted Supporter to 3 players: a, b and more!" },
    { kind: "server", text: "You received Supporter from Santa. Enjoy your new perks!" },
  ]);
});

test("records are announce lines with the record's tone", () => {
  const lines = roomChatLines(
    {
      t: "announce",
      a: { kind: "wr", name: "Glowy", map: "bhop_eazy", time: 16.731, style: "scroll", track: 1, prev: 17 } as never,
    },
    context,
  );
  expect(lines).toEqual([
    {
      kind: "announce",
      tone: "wr",
      text: "★ NEW WORLD RECORD by Glowy on bhop_eazy Bonus 1: 00:16.731 (Legit Scroll) (was 00:17.000)",
    },
  ]);
});

test("welcome greets once and introduces a private lobby once", () => {
  const welcome = {
    t: "welcome",
    you: 0,
    youId: "me",
    room: { id: "p-abcdefghij", name: "Lobby", region: "", maxPlayers: 8, tiers: [1, 7], private: true, host: 0 },
    map: { name: "bhop_eazy", tier: 1, startedAt: 0, endsAt: 0 },
    players: [player(0, "Me")],
  } as unknown as ServerMsg;
  const first = roomChatLines(welcome, context);
  expect(first[0].text).toBe(
    "Connected to Lobby (1/8) · bhop_eazy. Y chat · Tab scores · N spectate · type rtv / nominate / timeleft",
  );
  expect(first[1].text).toStartWith("Your private lobby.");
  expect(roomChatLines(welcome, context, true)).toHaveLength(1);
});
