import { afterEach, expect, test } from "bun:test";
import { api, type Leaderboard, type LeaderboardEntry } from "../../web/src/api";
import { canCopyStart, requestCopyStart, setCopyStartHandler } from "../../web/src/copy-start-request";
import { parseCopyStart as webParse, copiedMessage as webMessage } from "../../web/src/copy-start";
import { parseCopyStart, copiedMessage } from "./copy-start-rules";
import { NativeCopyStart, type CopyStartContext } from "./copy-start";
import { NativeRoomService } from "./room-service";
import type { MenuMessage } from "./bridge";

const prior = { available: api.available, leaderboard: api.leaderboard };
afterEach(() => {
  Object.assign(api, prior);
  setCopyStartHandler(null);
});
const entry = (id: string, name = "Hopper", rank = 1): LeaderboardEntry =>
  ({
    runId: id,
    rank,
    player: { id: "hopper", name },
    time: 10,
  }) as LeaderboardEntry;
const board = (entries: LeaderboardEntry[]): Leaderboard => ({ entries }) as Leaderboard;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(replay: (id: string) => Promise<Uint8Array> = async () => new Uint8Array([1, 2, 3])) {
  const messages: MenuMessage[] = [],
    replies: string[] = [];
  const context: CopyStartContext = { map: "fixture", style: "legit", track: 0, loading: false };
  const room = new NativeRoomService({
    ensureAccount: async () => true,
    connect() {
      throw new Error("No network in this test");
    },
    send() {},
  });
  room.view.id = "easy";
  room.view.you = 0;
  room.view.generation = 1;
  room.view.players = [
    {
      slot: 2,
      id: "hopper",
      name: "Hopper",
      provider: "guest",
      rank: null,
      admin: false,
      style: "hsw",
      spec: null,
      pb: { hsw: 10, autohop: 11 },
      joinedAt: 0,
    },
  ];
  const service = new NativeCopyStart({
    context: () => context,
    room,
    send: (message) => messages.push(message),
    reply: (text) => replies.push(text),
    replay,
  });
  service.update();
  api.available = () => true;
  return { service, context, room, messages, replies };
}
async function drain() {
  for (let i = 0; i < 20; ++i) await Promise.resolve();
}

test("menu rules match the pinned web target parser and answer text", () => {
  for (const text of ["", "#1", "1", "#3", "123456", "#0", "0", "1000000", "Hop per", "  Hopper  "])
    expect(parseCopyStart(text)).toEqual(webParse(text));
  for (const track of [0, 1, 2])
    for (const go of [false, true]) expect(copiedMessage("Hopper", track, go)).toBe(webMessage("Hopper", track, go));
});

test("leaderboard rows offer Copy start only on the loaded map and send a replay, never playback", async () => {
  const f = fixture();
  expect(canCopyStart("fixture")).toBe(true);
  expect(canCopyStart("other")).toBe(false);
  requestCopyStart("fixture", "run", "Hopper");
  await drain();
  expect(f.messages).toEqual([
    { type: "copyStart", id: 1, map: "fixture", style: "legit", who: "Hopper", replayBase64: "AQID" },
  ]);
  f.service.receive({ id: 99, text: "Stale" });
  expect(f.replies).toEqual([]);
  f.service.receive({ id: 1, text: "Copied Hopper's start point" });
  expect(f.replies).toEqual(["Copied Hopper's start point"]);
  f.context.loading = true;
  f.service.update();
  expect(canCopyStart("fixture")).toBe(false);
});

test("rank arguments read the current track's board; room names prefer player PB styles", async () => {
  const f = fixture();
  const queries: { map: string; style: string; options: unknown }[] = [];
  api.leaderboard = async (map, style, options) => {
    queries.push({ map, style, options });
    return board(style === "hsw" ? [] : [entry("run", "Hopper", 3)]);
  };
  await f.service.command("#3");
  expect(queries[0]).toEqual({ map: "fixture", style: "legit", options: { offset: 2, limit: 1, track: 0 } });
  queries.length = 0;
  await f.service.player(2);
  expect(queries.map((query) => query.style)).toEqual(["hsw", "legit"]);
  expect(queries[0].options).toEqual({ around: "hopper", limit: 5, track: 0 });
  f.context.track = 2;
  f.service.update();
  queries.length = 0;
  await f.service.player(2);
  expect(queries.map((query) => query.style)).toEqual(["autohop"]);
  expect(f.service.roomCommand("#3")).toBe(false);
  expect(f.service.roomCommand("")).toBe(true);
  expect(f.messages.at(-1)).toEqual({ type: "chatAction", action: "copyStartMenu" });
});

test("stale downloads and room-player lookups cannot apply on a new map or track", async () => {
  const replay = deferred<Uint8Array>(),
    f = fixture(() => replay.promise);
  const pending = f.service.copy("run", "Hopper");
  f.context.map = "other";
  f.service.update();
  replay.resolve(new Uint8Array([1]));
  await pending;
  expect(f.messages).toEqual([]);
  const found = deferred<Leaderboard>();
  api.leaderboard = () => found.promise;
  const lookup = f.service.player(2);
  f.context.track = 1;
  f.service.update();
  found.resolve(board([entry("run")]));
  await lookup;
  expect(f.messages).toEqual([]);
});

test("newer commands win over an older delayed board response; errors stay local", async () => {
  const f = fixture(),
    older = deferred<Leaderboard>();
  api.leaderboard = async (_map, _style, options) => (options?.offset === 2 ? older.promise : board([entry("newer")]));
  const old = f.service.command("#3");
  await f.service.command("#1");
  older.resolve(board([entry("older", "Older", 3)]));
  await old;
  expect(f.messages.filter((message) => message.type === "copyStart")).toHaveLength(1);
  const failed = fixture(async () => {
    throw new Error("offline");
  });
  await failed.service.copy("run", "Hopper");
  expect(failed.replies).toEqual(["Couldn't download that run's replay."]);
});
