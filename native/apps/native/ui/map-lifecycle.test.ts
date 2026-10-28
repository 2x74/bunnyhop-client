import { test, expect } from "bun:test";
import { leaveMapTeardown } from "./map-lifecycle";
import { NativeRoomService, type RoomTransport } from "./room-service";
import { NativeGauntlet } from "./gauntlet-native";
import type { RoomHandlers } from "../../web/src/net/room";
import type { ServerMsg } from "../../web/src/net/protocol";
import type { GauntletAttempt } from "../../web/src/api";
import type { MenuMessage } from "./bridge";

// onLeaveMap (host leave_map, every one): nothing the menu ran for the old map may act afterwards.
const welcome = (id: string, map = "bhop_eazy"): ServerMsg => ({
  t: "welcome",
  v: 1,
  you: 0,
  youId: "me",
  admin: false,
  room: { id, name: "Test room", region: "test", maxPlayers: 32, tiers: [1, 6] },
  now: Date.now(),
  map: { name: map, tier: 1, startedAt: 0, endsAt: Date.now() + 100000 },
  nextMap: null,
  change: null,
  vote: null,
  myVote: null,
  rtv: { count: 0, needed: 1 },
  nominations: [],
  pool: [{ name: map, tier: 1 }],
  players: [{ slot: 0, id: "me", name: "Player", style: "autohop" } as never],
  metas: {},
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ID = "AbCdEfGhIjKlMnOp";

function room() {
  const handlers: RoomHandlers[] = [],
    sent: MenuMessage[] = [],
    closed: number[] = [];
  const transport: RoomTransport = {
    send: () => {},
    pushSample: () => {},
    flushSamples: () => {},
    close: (code) => closed.push(code ?? 4000),
    toLocal: (v) => v,
    serverNow: () => Date.now(),
  };
  const service = new NativeRoomService({
    ensureAccount: async () => true,
    connect: (_id, h) => {
      handlers.push(h);
      return transport;
    },
    send: (m) => sent.push(m),
  });
  return { service, handlers, sent, closed };
}
function gauntlet(sent: MenuMessage[]) {
  const timers = new Map<number, () => void>();
  let next = 1;
  const a: GauntletAttempt = {
    id: ID,
    gauntlet: { slug: "w", title: "W", maxMs: 3600_000 },
    state: "open",
    step: 0,
    startedAt: Date.now(),
    lastPingAt: Date.now(),
    expiresAt: null,
    finishedAt: null,
    realMs: null,
    totalTicks: null,
    maps: [{ idx: 0, map: "bhop_a", track: 0 }],
    next: { idx: 0, map: "bhop_a" },
    splits: [],
  };
  const g = new NativeGauntlet({
    api: {
      gauntletAttempt: async () => structuredClone(a),
      pingGauntlet: async () => ({ id: ID, state: "open", step: 0, expiresAt: null }),
      gauntlet: async () => ({ me: null }),
    },
    send: (m) => sent.push(m),
    map: () => "bhop_a",
    loading: () => false,
    notice: () => {},
    result: () => {},
    line: () => {},
    setTimeout: (fn) => {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
  });
  return { g, timers };
}

test("a pending room map change can't send nativeMap or reconnect after onLeaveMap", async () => {
  const r = room(),
    sent: MenuMessage[] = [];
  const { g } = gauntlet(sent);
  const teardown = leaveMapTeardown({ room: r.service, gauntlet: g, clear: () => {} });
  await r.service.join("test");
  const old = r.handlers[0];
  old.message(welcome("test"));
  // The server schedules a map change 30 ms out; the host leaves the map before it's due.
  old.message({ t: "change", change: { map: "bhop_other", tier: 2, at: Date.now() + 30 } } as ServerMsg);
  const generation = r.service.view.generation;
  teardown();
  expect(r.sent.at(-1)).toEqual({ type: "roomEvent", id: "test", generation, event: { t: "nativeLeave" } });
  expect(r.service.view.generation).toBe(generation + 1); // the fence: older generations are stale
  const after = r.sent.length;
  await wait(80);
  // No nativeMap, no reconnect, nothing from the old transport's late callbacks.
  old.message(welcome("test", "bhop_other"));
  old.snapshot({ serverTime: 1, blocks: [] }, 0);
  r.service.hostMap("bhop_other");
  expect(r.sent.slice(after)).toEqual([]);
  expect(r.handlers).toHaveLength(1);
  expect(r.service.view).toMatchObject({ id: null, status: "closed", map: "" });
  // Idempotent: the host's own onLeaveMap after the menu's Main menu.
  teardown();
  expect(r.sent.slice(after)).toEqual([]);
});

test("a map change that already fired can't reconnect when the host later reports that map", async () => {
  const r = room();
  const teardown = leaveMapTeardown({ room: r.service, gauntlet: { leave() {} }, clear: () => {} });
  await r.service.join("test");
  r.handlers[0].message(welcome("test"));
  r.handlers[0].message({ t: "change", change: { map: "bhop_other", tier: 2, at: Date.now() - 1000 } } as ServerMsg);
  await wait(5);
  expect(r.sent.some((m) => m.type === "roomEvent" && m.event.t === "nativeMap")).toBe(true);
  teardown();
  const after = r.sent.length;
  r.service.hostMap("bhop_other"); // a late load of the old room's map
  expect(r.handlers).toHaveLength(1);
  expect(r.sent.slice(after)).toEqual([]);
});

test("onLeaveMap lets the gauntlet attempt go and stops its timers; one failing step doesn't stop the rest", async () => {
  const sent: MenuMessage[] = [];
  const { g, timers } = gauntlet(sent);
  await g.start(ID);
  expect(timers.size).toBeGreaterThan(0);
  const cleared: string[] = [];
  const teardown = leaveMapTeardown({
    room: {
      leave() {
        throw new Error("boom");
      },
      view: { id: "x" },
    },
    gauntlet: g,
    clear: () => cleared.push("clear"),
  });
  const errors = console.error;
  console.error = () => {};
  try {
    teardown();
  } finally {
    console.error = errors;
  }
  expect(sent.at(-1)).toEqual({ type: "gauntlet", id: null });
  expect(g.id).toBeNull();
  expect(timers.size).toBe(0);
  expect(cleared).toEqual(["clear"]);
  const n = sent.length;
  teardown();
  expect(sent.length).toBe(n);
});
