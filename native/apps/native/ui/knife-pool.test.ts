import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { NativeRoomService, type RoomTransport } from "./room-service";
import { KNIFE_PICK_KEY, NativeCosmetics, setKnifePick, storedKnifePick, type CosmeticApi } from "./cosmetics";
import { DEFAULT_COSMETICS } from "../../web/src/progression";
import { getHeldLoadout, getKnifePool, setKnifePool } from "../../web/src/player/cosmetics";
import type { RoomHandlers } from "../../web/src/net/room";
import type { ServerMsg } from "../../web/src/net/protocol";

// The website keeps the pool and its pick in localStorage; the test runner has none.
const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;
beforeAll(() => {
  const items = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
});
afterAll(() => {
  (globalThis as { localStorage?: unknown }).localStorage = originalStorage;
});

const pool = {
  items: [
    { knife: "knife-karrotbit", finish: "fin-garden" },
    { knife: "knife-whirligig", finish: "fin-garden" },
  ],
  swap: "restart" as const,
  order: "order" as const,
};

function welcome(knife: string): ServerMsg {
  return {
    t: "welcome",
    v: 1,
    you: 0,
    youId: "me",
    admin: false,
    room: { id: "pool", name: "Pool", region: "test", maxPlayers: 32, tiers: [1, 6] },
    now: Date.now(),
    map: { name: "bhop_eazy", tier: 1, startedAt: 0, endsAt: Date.now() + 100000 },
    nextMap: null,
    change: null,
    vote: null,
    myVote: null,
    rtv: { count: 0, needed: 1 },
    nominations: [],
    pool: [{ name: "bhop_eazy", tier: 1 }],
    players: [
      { slot: 0, id: "me", name: "Player", style: "autohop", loadout: { knife, finish: "fin-garden" } } as never,
    ],
    metas: {},
  };
}

function room(held: () => { knife: string; finish: string }) {
  const handlers: RoomHandlers[] = [],
    commands: unknown[] = [];
  const transport: RoomTransport = {
    send: (value) => commands.push(value),
    pushSample: () => {},
    flushSamples: () => {},
    close: () => {},
  };
  const service = new NativeRoomService({
    ensureAccount: async () => true,
    connect: (_id, h) => {
      handlers.push(h);
      return transport;
    },
    send: () => {},
    heldKnife: held,
  });
  return { service, handlers, commands };
}

test("the pick key is the website's, so the held knife reads the game's pick", () => {
  const source = readFileSync(new URL("../../web/src/player/cosmetics.ts", import.meta.url), "utf8");
  expect(source).toContain(`const PICK_KEY = "${KNIFE_PICK_KEY}";`);
  setKnifePool(pool);
  setKnifePick(1);
  expect(storedKnifePick()).toBe(1);
  expect(getHeldLoadout().knife).toBe("knife-whirligig");
  setKnifePick(0);
  expect(getHeldLoadout().knife).toBe("knife-karrotbit");
  setKnifePick(9);
  setKnifePick("2");
  expect(storedKnifePick()).toBe(0);
  setKnifePool(null);
});

test("the account's saved pool becomes the game's pool", async () => {
  const api: CosmeticApi = {
    myCosmetics: async () => ({ choice: { ...DEFAULT_COSMETICS, knifePool: pool }, unlocked: [] }),
    saveCosmetics: async () => ({ ...DEFAULT_COSMETICS }),
  };
  await new NativeCosmetics(api).refresh();
  expect(getKnifePool()).toEqual(pool);
  setKnifePool(null);
});

test("rooms see the held knife on welcome and once restarts stop", async () => {
  let held = { knife: "knife-whirligig", finish: "fin-garden" };
  const f = room(() => held);
  try {
    await f.service.join("pool");
    f.handlers[0].message(welcome("knife-karrotbit"));
    expect(f.commands).toEqual([{ t: "knife", knife: "knife-whirligig", finish: "fin-garden" }]);
    f.handlers[0].message({ t: "player", slot: 0, patch: { loadout: held } } as never);
    held = { knife: "knife-karrotbit", finish: "fin-garden" };
    f.service.heldKnifeChanged();
    f.service.heldKnifeChanged();
    expect(f.commands).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(f.commands).toEqual([
      { t: "knife", knife: "knife-whirligig", finish: "fin-garden" },
      { t: "knife", knife: "knife-karrotbit", finish: "fin-garden" },
    ]);
  } finally {
    f.service.leave();
  }
});

test("a room already showing the held knife gets nothing", async () => {
  const f = room(() => ({ knife: "knife-karrotbit", finish: "fin-garden" }));
  try {
    await f.service.join("pool");
    f.handlers[0].message(welcome("knife-karrotbit"));
    expect(f.commands).toEqual([]);
  } finally {
    f.service.leave();
  }
});
