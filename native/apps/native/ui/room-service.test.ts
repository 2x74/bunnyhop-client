import { test, expect } from "bun:test";
import { NativeRoomService, validSnapshot, validRoomEvent, type RoomTransport } from "./room-service";
import type { RoomHandlers } from "../../web/src/net/room";
import type { ServerMsg, NetSample, Snapshot } from "../../web/src/net/protocol";
import type { MenuMessage } from "./bridge";
const sample: NetSample = { tick: 1, x: 0, y: 0, z: 0, vx: 1, vy: 0, vz: 0, yaw: 0, pitch: 0, flags: 0 };
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
function fixture(ensureAccount: () => Promise<boolean> = async () => true) {
  let now = 0;
  const handlers: RoomHandlers[] = [],
    sent: MenuMessage[] = [],
    commands: unknown[] = [],
    poses: NetSample[] = [],
    batches: unknown[] = [],
    closed: number[] = [];
  const transport: RoomTransport = {
    send: (value) => commands.push(value),
    pushSample: (value) => poses.push(value),
    flushSamples: (...value) => batches.push(value),
    close: (code) => closed.push(code ?? 4000),
    toLocal: (value) => value,
    serverNow: () => Date.now() + 5000,
  };
  const service = new NativeRoomService({
    ensureAccount,
    connect: (_id, h) => {
      handlers.push(h);
      return transport;
    },
    send: (value) => sent.push(value),
    now: () => now,
  });
  return {
    service,
    handlers,
    sent,
    commands,
    poses,
    batches,
    closed,
    advance: () => {
      now += 50;
    },
  };
}
function pose(f: ReturnType<typeof fixture>, tick = 1) {
  return {
    generation: f.service.view.generation,
    id: f.service.view.id,
    map: "bhop_eazy",
    sample: { ...sample, tick },
    meta: { style: "sideways", track: 0, timer: 2, timerTicks: 100 },
    weapon: 2,
    silenced: true,
  };
}
test("room service validates native pose identity, caps it at20Hz and batches existing wire metadata", async () => {
  const f = fixture();
  try {
    await f.service.join("test");
    f.handlers[0].message(welcome("test"));
    expect(f.service.pose({ ...pose(f), generation: -1 })).toBe(false);
    expect(f.service.pose(pose(f))).toBe(true);
    expect(f.service.pose(pose(f, 2))).toBe(false);
    f.advance();
    expect(f.service.pose(pose(f, 2))).toBe(true);
    f.service.flush();
    expect(f.poses).toHaveLength(2);
    expect(f.batches[0]).toEqual([{ style: 3, track: 0, timer: 2, timerTicks: 100 }, 2, true]);
    expect(f.service.command({ t: "chat", text: "hello" })).toBe(true);
    expect(f.service.command({ t: "spec", target: 999 })).toBe(false);
  } finally {
    f.service.leave();
  }
});
test("room reset and delayed account replies cannot open stale transports", async () => {
  let done!: (value: boolean) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const join = f.service.join("old");
  f.service.leave();
  done(true);
  await join;
  expect(f.handlers).toHaveLength(0);
});
test("stale room callbacks cannot affect another room or forward snapshots", async () => {
  const f = fixture();
  try {
    await f.service.join("old");
    const old = f.handlers[0];
    old.message(welcome("old"));
    await f.service.join("new");
    old.message(welcome("old"));
    expect(f.service.view.id).toBe("new");
    expect(f.service.view.room).toBeNull();
    f.handlers[1].message(welcome("new"));
    old.snapshot({ serverTime: 1, blocks: [{ slot: 1, meta: null, samples: [sample] }] }, 0);
    expect(f.sent.filter((m) => m.type === "roomSnapshot")).toHaveLength(0);
  } finally {
    f.service.leave();
  }
});
test("snapshot and server event guards reject malformed or oversized data", () => {
  const valid: Snapshot = { serverTime: 1, blocks: [{ slot: 1, meta: null, samples: [sample] }] };
  expect(validSnapshot(valid)).toBe(true);
  expect(validSnapshot({ ...valid, serverTime: -1 })).toBe(false);
  expect(validSnapshot({ ...valid, blocks: Array(65).fill(valid.blocks[0]) })).toBe(false);
  expect(validSnapshot({ ...valid, blocks: [{ slot: 1, meta: null, samples: [{ ...sample, x: Infinity }] }] })).toBe(
    false,
  );
  expect(validRoomEvent({ ...welcome("test"), players: Array(65).fill({}) } as never)).toBe(false);
  expect(validRoomEvent({ t: "vote", vote: { options: [null] } } as never)).toBe(false);
});
test("room snapshots stay bounded and cannot send more than20Hz", async () => {
  const f = fixture();
  try {
    await f.service.join("test");
    f.handlers[0].message(welcome("test"));
    for (let i = 0; i < 10; i++)
      f.handlers[0].snapshot(
        { serverTime: i, blocks: [{ slot: 1, meta: null, samples: [{ ...sample, tick: i }] }] },
        0,
      );
    expect(f.sent.filter((m) => m.type === "roomSnapshot")).toHaveLength(1);
    f.advance();
    f.service.flush();
    const snapshots = f.sent.filter((m) => m.type === "roomSnapshot");
    expect(snapshots).toHaveLength(2);
    expect((snapshots[1] as { snapshot: Snapshot }).snapshot.blocks[0].samples.at(-1)?.tick).toBe(9);
  } finally {
    f.service.leave();
  }
});
test("due map change closes4001, tells native to load, then reconnects after native acknowledgment", async () => {
  const f = fixture();
  try {
    await f.service.join("test");
    f.handlers[0].message(welcome("test"));
    f.handlers[0].message({ t: "change", change: { map: "bhop_other", tier: 2, at: Date.now() - 1000 } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(f.closed).toContain(4001);
    expect(f.sent.find((m) => m.type === "roomEvent" && m.event.t === "nativeMap")).toMatchObject({
      event: { t: "nativeMap", map: "bhop_other" },
    });
    f.service.hostMap("bhop_other");
    expect(f.handlers).toHaveLength(2);
    f.handlers[1].message(welcome("test", "bhop_other"));
    expect(f.service.view.map).toBe("bhop_other");
  } finally {
    f.service.leave();
  }
});

test("room race deadlines carry transport clock offset to the native state machine", async () => {
  const f = fixture();
  try {
    await f.service.join("test");
    f.handlers[0].message(welcome("test"));
    const event = f.sent.find((message) => message.type === "roomEvent" && message.event.t === "welcome");
    expect(event?.type).toBe("roomEvent");
    if (event?.type === "roomEvent") expect(Math.abs(Number(event.event.nativeClockOffsetMs) - 5000)).toBeLessThan(10);
  } finally {
    f.service.leave();
  }
});

test("chat retains private kind and player marks for native display; nominations and timer metadata survive", async () => {
  const f = fixture();
  try {
    await f.service.join("test");
    f.handlers[0].message(welcome("test"));
    f.handlers[0].message({
      t: "chat",
      text: "Only you",
      kind: "private",
      name: "Mod",
      staff: "admin",
      verified: true,
      at: 1,
    } as never);
    expect(f.service.view.chat[0]).toMatchObject({ kind: "private", verified: true });
    expect(f.sent.find((m) => m.type === "chatLine")).toMatchObject({
      text: "Only you",
      kind: "private",
      verified: true,
    });
    f.handlers[0].message({ t: "nominations", list: [{ map: "bhop_eazy", name: "Mod" }] });
    expect(f.service.view.nominations).toHaveLength(1);
    f.handlers[0].snapshot(
      {
        serverTime: 1,
        blocks: [{ slot: 2, meta: { timer: 2, timerTicks: 100, style: 1, track: 0, ping: 30 }, samples: [sample] }],
      },
      0,
    );
    expect(f.service.view.metas["2"]).toMatchObject({ ping: 30, timerTicks: 100 });
  } finally {
    f.service.leave();
  }
});
test("latest native timer metadata is sent with its sample batch and kick stops native commands", async () => {
  const f = fixture();
  try {
    await f.service.join("test");
    f.handlers[0].message(welcome("test"));
    f.service.pose(pose(f));
    f.advance();
    f.service.pose({ ...pose(f, 2), meta: { style: "sideways", track: 0, timer: 3, timerTicks: 200 } });
    f.service.flush();
    expect(f.batches[0]).toEqual([{ style: 3, track: 0, timer: 3, timerTicks: 200 }, 2, true]);
    f.handlers[0].message({ t: "kicked", reason: "Removed" });
    expect(f.service.view.status).toBe("closed");
    expect(f.service.command({ t: "chat", text: "late" })).toBe(false);
  } finally {
    f.service.leave();
  }
});
test("room audio fences duplicate gifts, vote refreshes, verified announcer identities and stale rooms", async () => {
  const f = fixture();
  try {
    await f.service.join("test");
    const old = f.handlers[0];
    old.message(welcome("test"));
    const gift = {
      t: "gift",
      batchId: "gift1",
      count: 1,
      names: ["A"],
      sender: { id: "b", name: "B" },
      recipients: [{ id: "a", name: "A" }],
    } as const;
    old.message(gift as never);
    old.message(gift as never);
    const vote = { id: 1, kind: "rtv", endsAt: Date.now() + 10000, options: [{ map: "bhop_eazy" }], counts: [0] };
    old.message({ t: "vote", vote } as never);
    old.message({ t: "vote", vote } as never);
    old.message({ t: "vote", vote: { ...vote, counts: [1] } } as never);
    const a = {
      runId: "run1",
      kind: "wr",
      slot: 2,
      name: "A",
      map: "bhop_eazy",
      style: "autohop",
      track: 0,
      time: 10,
      rank: 1,
    };
    old.message({ t: "announce", a } as never);
    old.message({ t: "announce", a } as never);
    const cues = f.sent.filter((m) => m.type === "audioCue");
    expect(cues.filter((m) => m.type === "audioCue" && m.id === "supporter_gift")).toHaveLength(1);
    expect(cues.filter((m) => m.type === "audioCue" && m.id === "vote_open")).toHaveLength(1);
    expect(cues.filter((m) => m.type === "audioCue" && m.id === "vote_tick")).toHaveLength(1);
    expect(f.sent.filter((m) => m.type === "announce")).toEqual([
      { type: "announce", event: "wr", id: "run1", remote: true },
    ]);
    await f.service.join("new");
    const before = f.sent.length;
    old.message(gift as never);
    expect(f.sent.length).toBe(before);
  } finally {
    f.service.leave();
  }
});

test("kick cancels scheduled map work and rejects delayed native map acknowledgments", async () => {
  const f = fixture();
  try {
    await f.service.join("test");
    const h = f.handlers[0];
    h.message(welcome("test"));
    h.message({ t: "change", change: { map: "bhop_other", tier: 2, at: Date.now() - 1000 } });
    h.message({ t: "kicked", reason: "Removed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    f.service.hostMap("bhop_other");
    expect(f.service.view.status).toBe("closed");
    expect(f.service.view.change).toBeNull();
    expect(f.handlers).toHaveLength(1);
    expect(f.sent.filter((m) => m.type === "roomEvent" && m.event.t === "nativeMap")).toHaveLength(0);
    await f.service.join("test");
    expect(f.handlers).toHaveLength(2);
  } finally {
    f.service.leave();
  }
});
