import { test, expect } from "bun:test";
import { roomScoreboard } from "./room-scoreboard";
import type { RoomView } from "./room-service";
const view = (): RoomView => ({
  id: "test",
  generation: 1,
  status: "open",
  detail: "",
  room: { id: "test", name: "Test room", region: "EU", tiers: [1, 6], maxPlayers: 32, private: true, host: 2 },
  map: "bhop_test",
  mapInfo: { name: "bhop_test", tier: 3, startedAt: 0, endsAt: 90000 },
  nextMap: "bhop_next",
  you: 1,
  players: [
    {
      slot: 1,
      id: "me",
      name: "You",
      provider: "discord",
      admin: false,
      rank: null,
      style: "autohop",
      spec: null,
      pb: { autohop: 12, sideways: 20 },
      joinedAt: 0,
    },
    {
      slot: 2,
      id: "other",
      name: "Runner",
      provider: "discord",
      admin: true,
      rank: { id: "rank1", name: "Pro", color: "#abc" },
      style: "autohop",
      spec: null,
      pb: { autohop: 10 },
      joinedAt: 0,
      country: "JP",
      verified: true,
      supporter: true,
      nameColor: "mint",
      nameBadges: ["supporter"],
      giftsSent: 2,
    },
    {
      slot: 3,
      id: "watch",
      name: "Watcher",
      provider: "guest",
      admin: false,
      rank: null,
      style: "autohop",
      spec: 2,
      pb: {},
      joinedAt: 0,
    },
  ] as RoomView["players"],
  metas: {
    "1": { style: 3, track: 0, timer: 2, timerTicks: 1000, ping: 45 },
    "2": { style: 0, track: 0, timer: 3, timerTicks: 905, ping: 0 },
  },
  metaAt: { "1": 1000, "2": 1000 },
  chat: [],
  nominations: [],
  change: null,
  vote: null,
  pool: [],
  race: null,
  rtv: { count: 0, needed: 1 },
});
test("native scoreboard matches web PB sorting, wire style, marks, host, status and ping", () => {
  const board = roomScoreboard(view(), 2500, 10000, 37);
  expect(board.rows.map((row) => row.name)).toEqual(["Runner", "You", "Watcher"]);
  const [runner, you, watcher] = board.rows;
  expect(you).toMatchObject({
    you: true,
    style: "sideways",
    pb: 20,
    status: "00:11.500",
    statusKind: "running",
    ping: 37,
    color: "#4fa8ff",
  });
  expect(runner).toMatchObject({
    host: true,
    pb: 10,
    role: "admin",
    staff: "admin",
    country: "JP",
    verified: true,
    supporter: true,
    nameBadges: ["supporter"],
    giftsSent: 2,
    ping: 0,
    statusKind: "finished",
  });
  expect(watcher).toMatchObject({ status: "SPEC → Runner", statusKind: "spec", pb: null, ping: null });
  expect(board.head).toMatchObject({
    tier: 3,
    timeLeft: "1:20 left",
    nextMap: "bhop_next",
    players: 3,
    max: 32,
    spectating: false,
  });
});
test("native scoreboard uses clock offset, frozen finished time and fallback role semantics", () => {
  const v = view();
  v.players[1].role = null;
  v.players[1].staff = null;
  v.players[0].spec = 99;
  v.change = { map: "bhop_new", at: 10000 };
  const board = roomScoreboard(v, 500000, 300000, null);
  expect(board.rows[0]).toMatchObject({ role: null, staff: null, status: "00:09.050" });
  expect(board.rows[1]).toMatchObject({ status: "SPEC → ?", statusKind: "spec", ping: null });
  expect(board.head).toMatchObject({ spectating: true, timeLeft: "changing to bhop_new", nextMap: "bhop_new" });
  v.change = null;
  expect(roomScoreboard(v, 0, 90001).head.timeLeft).toBe("last round");
});
