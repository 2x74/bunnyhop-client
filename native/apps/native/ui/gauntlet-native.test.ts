import { test, expect } from "bun:test";
import { ApiError, type GauntletAttempt } from "../../web/src/api";
import { NativeGauntlet, statusOutcome, type GauntletHost } from "./gauntlet-native";
import type { MenuMessage } from "./bridge";
import type { RunServiceStatus } from "./run-service";

// The web's gauntlet mode (gauntlet/mode.ts) over the native host: messages out, split decisions in. No network.
const ID = "AbCdEfGhIjKlMnOp";
function attempt(over: Partial<GauntletAttempt> = {}): GauntletAttempt {
  return {
    id: ID, gauntlet: { slug: "weekly-test", title: "Weekly", maxMs: 5 * 3600_000 }, state: "open", step: 0, startedAt: Date.now(), lastPingAt: Date.now(),
    expiresAt: null, finishedAt: null, realMs: null, totalTicks: null,
    maps: [{ idx: 0, map: "bhop_a", track: 0 }, { idx: 1, map: "bhop_b", track: 0 }], next: { idx: 0, map: "bhop_a" }, splits: [], ...over,
  };
}
function harness(a: GauntletAttempt | Error = attempt(), pb: { splits: { idx: number; time: number }[] } | null = null) {
  const sent: MenuMessage[] = [], notices: string[] = [], results: string[] = [], lines: (string | null)[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1, map: string | null = null, loading = false, go: (() => void) | null = null;
  const host: GauntletHost = {
    api: {
      gauntletAttempt: async () => { if (a instanceof Error) throw a; return structuredClone(a); },
      pingGauntlet: async () => ({ id: ID, state: "open", step: 0, expiresAt: null }),
      gauntlet: async () => ({ me: pb as never }),
    },
    send: (m) => sent.push(m), map: () => map, loading: () => loading, notice: (t) => notices.push(t),
    result: (slug, id) => results.push(`${slug}/${id}`), line: (t) => lines.push(t),
    listenGo: (fn) => { go = fn; return () => { go = null; }; },
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => void timers.delete(id),
  };
  const run = (ms: number) => { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); } };
  return { g: new NativeGauntlet(host), sent, notices, results, lines, timers, run, setMap: (m: string | null, l = false) => ((map = m), (loading = l)), go: () => go?.() };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const status = (generation: number, s: Partial<RunServiceStatus>): RunServiceStatus => ({ type: "runService", generation, status: "pending", ...s });

test("start locks the host to Normal on the attempt's map, then loads it", async () => {
  const t = harness(attempt(), { splits: [{ idx: 0, time: 10 }] });
  await t.g.start(ID, "bhop_a");
  await settle();
  expect(t.sent[0]).toEqual({ type: "gauntlet", id: ID, map: "bhop_a", progress: { idx: 0, maps: 2, before: 0, pbSplit: null } });
  expect(t.sent[1]).toEqual({ type: "selectMap", id: "bhop_a", style: "autohop", track: 0 });
  // Your PB's split arrives: the HUD line gets its delta.
  expect(t.sent.at(-1)).toEqual({ type: "gauntlet", id: ID, map: "bhop_a", progress: { idx: 0, maps: 2, before: 0, pbSplit: 10 } });
  expect(t.g.modeLock).toBe("Gauntlets are Normal style on the main track.");
  expect([...t.timers.values()].some((x) => x.ms === 60_000)).toBe(true); // the minute ping
});

test("only the first Normal main-track finish on this map is tagged; a split goes on to the next map", async () => {
  const t = harness();
  await t.g.start(ID);
  expect(t.g.tag({ map: "bhop_a", style: "sideways", track: 0 }, 1)).toBeNull();
  expect(t.g.tag({ map: "bhop_a", style: "autohop", track: 1 }, 1)).toBeNull();
  expect(t.g.tag({ map: "bhop_a", style: "autohop", track: 0 }, 2, 12.5)).toBe(ID);
  expect(t.g.tag({ map: "bhop_a", style: "autohop", track: 0 }, 3)).toBeNull(); // the candidate is out
  t.g.onRunStatus(status(2, { status: "uploading" }), null); // no answer yet
  t.g.onRunStatus(status(9, { gauntlet: { attemptId: ID, split: 0 } }), null); // another run
  expect(t.lines).toEqual([null]);
  t.g.onRunStatus(status(2, { status: "pending", time: 12.5, gauntlet: { attemptId: ID, split: 0, state: "open" } }), null);
  expect(t.lines.at(-1)).toBe("Map 1 of 2 done in 12.500. bhop_b is next.");
  expect(t.sent).toContainEqual({ type: "hudToast", key: "gauntlet", text: "Map 1 of 2 done in 12.500. bhop_b is next.", ms: 3000, tone: "good" });
  expect(t.sent.at(-1)).toEqual({ type: "gauntlet", id: ID, map: "bhop_a", progress: { idx: 0, maps: 2, before: 12.5, pbSplit: null } });
  // Enter / a click goes at once (else after NEXT_MAP_MS).
  t.go();
  expect(t.sent.at(-1)).toEqual({ type: "selectMap", id: "bhop_b", style: "autohop", track: 0 });
  expect(t.sent.at(-2)).toEqual({ type: "gauntlet", id: ID, map: "bhop_b", progress: { idx: 1, maps: 2, before: 12.5, pbSplit: null } });
});

test("a refused run opens the map again; the last split ends on the result screen", async () => {
  const t = harness();
  await t.g.start(ID);
  t.g.tag({ map: "bhop_a", style: "autohop", track: 0 }, 1);
  t.g.onRunStatus(status(1, { status: "kept", local: true, message: "This native build is not enabled for ranked submissions." }), 9);
  expect(t.lines.at(-1)).toBe("Not a split: the run didn't upload. Go again on this map.");
  expect(t.g.tag({ map: "bhop_a", style: "autohop", track: 0 }, 2)).toBe(ID);
  t.g.onRunStatus(status(2, { time: 8, gauntlet: { attemptId: ID, split: 0 } }), null);
  t.run(2000);
  t.setMap("bhop_b");
  t.g.onHostState();
  t.g.tag({ map: "bhop_b", style: "autohop", track: 0 }, 3);
  t.g.onRunStatus(status(3, { time: 7, gauntlet: { attemptId: ID, split: 1, state: "finished_pending" } }), null);
  expect(t.lines.at(-1)).toBe("Map 2 of 2 done in 7.000. That's the whole gauntlet.");
  t.run(2000);
  expect(t.sent.slice(-2)).toEqual([{ type: "gauntlet", id: null }, { type: "leaveMap" }]);
  expect(t.results).toEqual([`weekly-test/${ID}`]);
  expect(t.g.id).toBeNull();
});

test("an ended attempt unlocks; leaving the map lets the attempt go without ending it", async () => {
  const t = harness();
  await t.g.start(ID);
  t.g.tag({ map: "bhop_a", style: "autohop", track: 0 }, 1);
  t.g.onRunStatus(status(1, { gauntlet: { attemptId: ID, split: null, state: "expired" } }), 5);
  expect(t.lines.at(-1)).toBe("Not a split: the attempt expired.");
  expect(t.sent.at(-1)).toEqual({ type: "gauntlet", id: null });
  expect(t.g.id).toBeNull();

  const u = harness();
  await u.g.start(ID);
  u.setMap("bhop_a", true); u.g.onHostState(); // still loading
  u.setMap("bhop_a"); u.g.onHostState(); // arrived
  expect(u.g.id).toBe(ID);
  u.setMap(null); u.g.onHostState(); // Main menu
  expect(u.sent.at(-1)).toEqual({ type: "gauntlet", id: null });
  expect(u.g.id).toBeNull();
  expect(u.timers.size).toBe(0); // no more pings
});

test("finished and foreign attempts don't start; statuses map like the web's submissionOutcome", async () => {
  const done = harness(attempt({ state: "finished_pending", next: null }));
  await done.g.start(ID);
  expect(done.results).toEqual([`weekly-test/${ID}`]);
  expect(done.sent).toEqual([]);
  const gone = harness(new ApiError(404, "unknown_attempt", "unknown attempt"));
  await gone.g.start(ID);
  expect(gone.notices).toEqual(["That gauntlet attempt isn't yours."]);
  expect(gone.sent).toEqual([]);
  expect(statusOutcome(status(1, { status: "checking" }), 3)).toBeNull();
  expect(statusOutcome(status(1, { status: "rejected", message: "bad hash" }), 3)).toEqual({ kind: "refused", reason: "the run was refused (bad hash)" });
  expect(statusOutcome(status(1, { status: "pending", gauntlet: { attemptId: ID, split: 2 } }), 3)).toEqual({ kind: "split", idx: 2, last: true });
});

test("a held candidate stays the candidate: one line, no later finish tagged, then its answer decides", async () => {
  const t = harness();
  await t.g.start(ID);
  t.g.tag({ map: "bhop_a", style: "autohop", track: 0 }, 4, 11);
  expect(t.g.holds(ID, 4)).toBe(true);
  expect(t.g.holds(ID, 5)).toBe(false);
  t.g.onRunStatus(status(4, { status: "uploading", held: true }), null);
  t.g.onRunStatus(status(4, { status: "uploading", held: true }), null); // the second resend says nothing new
  expect(t.lines.filter((l) => l === "No connection. This run counts once it uploads.")).toHaveLength(1);
  expect(t.g.tag({ map: "bhop_a", style: "autohop", track: 0 }, 5)).toBeNull();
  expect(t.g.holds(ID, 4)).toBe(true);
  t.g.onRunStatus(status(4, { time: 11, gauntlet: { attemptId: ID, split: 0 } }), null);
  expect(t.lines.at(-1)).toBe("Map 1 of 2 done in 11.000. bhop_b is next.");
  expect(t.g.holds(ID, 4)).toBe(false);
});

// Leaving (or starting again) while the attempt is still being looked up: the late reply must do nothing.
function deferredHarness() {
  const replies: { resolve: (a: GauntletAttempt) => void; reject: (e: Error) => void }[] = [];
  const sent: MenuMessage[] = [], timers = new Map<number, () => void>();
  let next = 1, account: string | null = "u1";
  const g = new NativeGauntlet({
    api: {
      gauntletAttempt: () => new Promise((resolve, reject) => replies.push({ resolve, reject })),
      pingGauntlet: async () => ({ id: ID, state: "open", step: 0, expiresAt: null }),
      gauntlet: async () => ({ me: null }),
    },
    send: (m) => sent.push(m), map: () => null, loading: () => false, notice: () => {}, result: () => {}, line: () => {},
    account: async () => account,
    setTimeout: (fn) => { const id = next++; timers.set(id, fn); return id; }, clearTimeout: (id) => void timers.delete(id),
  });
  return { g, replies, sent, timers, setAccount: (id: string | null) => (account = id) };
}

test("leave during the attempt lookup: the late reply sends nothing and starts no ping", async () => {
  const t = deferredHarness();
  const pending = t.g.start(ID);
  await settle();
  expect(t.replies).toHaveLength(1);
  t.g.leave(); // Main menu / onLeaveMap while the lookup is out
  t.replies[0].resolve(attempt());
  await pending;
  expect(t.sent).toEqual([]);
  expect(t.timers.size).toBe(0);
  expect(t.g.id).toBeNull();
  // The same for end() (an expired attempt elsewhere) and for a lookup that fails late.
  const u = deferredHarness();
  const p2 = u.g.start(ID);
  await settle();
  u.g.end(null);
  u.replies[0].reject(new Error("offline"));
  await p2;
  expect(u.sent).toEqual([]);
});

test("a second start supersedes the first: only the newer attempt's reply counts", async () => {
  const t = deferredHarness();
  const first = t.g.start(ID);
  await settle();
  const second = t.g.start("ZyXwVuTsRqPoNmLk");
  await settle();
  t.replies[1].resolve(attempt({ id: "ZyXwVuTsRqPoNmLk", next: { idx: 0, map: "bhop_b" }, maps: [{ idx: 0, map: "bhop_b", track: 0 }] }));
  await second;
  t.replies[0].resolve(attempt());
  await first;
  expect(t.sent.filter((m) => m.type === "selectMap")).toEqual([{ type: "selectMap", id: "bhop_b", style: "autohop", track: 0 }]);
  expect(t.g.id).toBe("ZyXwVuTsRqPoNmLk");
  expect(t.timers.size).toBe(1); // one ping, the newer attempt's
});

test("another account lets the attempt go; the same account (a profile refresh) keeps it", async () => {
  const t = deferredHarness();
  const p = t.g.start(ID);
  await settle();
  t.replies[0].resolve(attempt());
  await p;
  t.g.onAccount("u1");
  expect(t.g.id).toBe(ID);
  t.g.onAccount("u2");
  expect(t.g.id).toBeNull();
  expect(t.sent.at(-1)).toEqual({ type: "gauntlet", id: null });
  expect(t.timers.size).toBe(0);
});

// A ping during the 2 s next-map countdown sees the server already on the next step: only one map change.
function countdownHarness() {
  let server = attempt({ maps: [{ idx: 0, map: "bhop_a", track: 0 }, { idx: 1, map: "bhop_b", track: 0 }, { idx: 2, map: "bhop_c", track: 0 }] });
  const sent: MenuMessage[] = [], timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1, map: string | null = null, pingReply: ((r: { id: string; state: "open"; step: number; expiresAt: null }) => void) | null = null;
  const g = new NativeGauntlet({
    api: {
      gauntletAttempt: async () => structuredClone(server),
      pingGauntlet: () => new Promise((resolve) => (pingReply = resolve)),
      gauntlet: async () => ({ me: null }),
    },
    send: (m) => sent.push(m), map: () => map, loading: () => false, notice: () => {}, result: () => {}, line: () => {}, listenGo: () => () => {},
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => void timers.delete(id),
  });
  const run = (ms: number) => { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); } };
  const split = () => {
    g.tag({ map: "bhop_a", style: "autohop", track: 0 }, 1, 10);
    g.onRunStatus({ type: "runService", generation: 1, status: "pending", time: 10, gauntlet: { attemptId: ID, split: 0, state: "open" } }, null);
    server = attempt({ ...server, step: 1, next: { idx: 1, map: "bhop_b" } });
  };
  const changes = () => sent.filter((m) => m.type === "selectMap" || m.type === "restart");
  return { g, run, split, changes, setMap: (m: string | null) => (map = m), answerPing: () => pingReply?.({ id: ID, state: "open", step: 1, expiresAt: null }) };
}

test("a ping answered during the countdown leaves the next map to the countdown (sent before or during it)", async () => {
  for (const order of ["ping-in-countdown", "ping-before-split"] as const) {
    const t = countdownHarness();
    await t.g.start(ID);
    t.setMap("bhop_a"); t.g.onHostState();
    if (order === "ping-before-split") { t.run(60_000); t.split(); }
    else { t.split(); t.run(60_000); }
    const before = t.changes().length;
    t.answerPing(); await settle(); await settle();
    expect(t.changes().length).toBe(before); // the ping didn't begin bhop_b
    t.run(2000); // the countdown ends
    t.setMap("bhop_b"); t.g.onHostState();
    expect(t.changes().slice(before)).toEqual([{ type: "selectMap", id: "bhop_b", style: "autohop", track: 0 }]);
    t.run(2000); // nothing left to fire
    expect(t.changes().slice(before)).toHaveLength(1);
  }
});

function ownerHarness(server: () => GauntletAttempt | Error, account: () => string | null | undefined) {
  const sent: MenuMessage[] = [];
  const g = new NativeGauntlet({
    api: {
      gauntletAttempt: async () => { const s = server(); if (s instanceof Error) throw s; return structuredClone(s); },
      pingGauntlet: async () => ({ id: ID, state: "open", step: 0, expiresAt: null }), gauntlet: async () => ({ me: null }),
    },
    send: (m) => sent.push(m), map: () => null, loading: () => false, notice: () => {}, result: () => {}, line: () => {},
    account: async () => account(), setTimeout: () => 1, clearTimeout: () => {},
  });
  return { g, sent };
}

test("an attempt started with the account unknown (stale) is confirmed by the server, never adopted blindly", async () => {
  // Same user: the server still answers for the attempt under this account, so it's theirs and stays.
  let reply: GauntletAttempt | Error = attempt();
  const same = ownerHarness(() => reply, () => undefined);
  await same.g.start(ID);
  same.g.onAccount("u1");
  await settle();
  expect(same.g.id).toBe(ID);
  // Now known as u1's: another account lets it go at once.
  same.g.onAccount("u2");
  expect(same.g.id).toBeNull();
  // Changed user while unknown: the server says it isn't theirs, and it ends.
  reply = attempt();
  const other = ownerHarness(() => reply, () => undefined);
  await other.g.start(ID);
  reply = new ApiError(404, "unknown_attempt", "unknown attempt");
  other.g.onAccount("u2");
  await settle();
  expect(other.g.id).toBeNull();
  expect(other.sent.at(-1)).toEqual({ type: "gauntlet", id: null });
  // No answer (offline): still unknown, kept; a sign-out lets it go.
  reply = attempt();
  const offline = ownerHarness(() => reply, () => undefined);
  await offline.g.start(ID);
  reply = new TypeError("Failed to fetch") as unknown as Error;
  offline.g.onAccount("u1");
  await settle();
  expect(offline.g.id).toBe(ID);
  offline.g.onAccount(null);
  expect(offline.g.id).toBeNull();
});

test("an attempt started under a confirmed account keeps it through same-account refreshes", async () => {
  const t = ownerHarness(() => attempt(), () => "u1");
  await t.g.start(ID);
  t.g.onAccount("u1");
  t.g.onAccount("u1");
  expect(t.g.id).toBe(ID);
  t.g.onAccount(null);
  expect(t.g.id).toBeNull();
});

test("only the latest account check's answer binds or ends an unknown-owner attempt, in either reply order", async () => {
  type Reply = { resolve: (a: GauntletAttempt) => void; reject: (e: Error) => void };
  const setup = async () => {
    const replies: Reply[] = [];
    let first = true;
    const g = new NativeGauntlet({
      api: {
        gauntletAttempt: () => first ? ((first = false), Promise.resolve(attempt())) : new Promise((resolve, reject) => replies.push({ resolve, reject })),
        pingGauntlet: async () => ({ id: ID, state: "open", step: 0, expiresAt: null }), gauntlet: async () => ({ me: null }),
      },
      send: () => {}, map: () => null, loading: () => false, notice: () => {}, result: () => {}, line: () => {},
      account: async () => { throw new Error("offline"); }, // unknown, not signed out
      setTimeout: () => 1, clearTimeout: () => {},
    });
    await g.start(ID);
    g.onAccount("u1");
    g.onAccount("u2");
    return { g, u1: replies[0], u2: replies[1] };
  };
  const ok = () => attempt(), offline = () => new TypeError("Failed to fetch") as unknown as Error, gone = () => new ApiError(404, "unknown_attempt", "unknown attempt");
  const owner = (g: NativeGauntlet) => (g as unknown as { owner: string | null | undefined }).owner;
  // u2's check fails for the network, u1's stale success arrives (before or after): still unknown, never u1.
  for (const order of ["u1-first", "u2-first"] as const) {
    const t = await setup();
    if (order === "u1-first") { t.u1.resolve(ok()); t.u2.reject(offline()); } else { t.u2.reject(offline()); t.u1.resolve(ok()); }
    await settle();
    expect(t.g.id).toBe(ID);
    expect(owner(t.g)).toBeUndefined();
  }
  // u1's stale 404 (before or after u2's success): doesn't end it; u2 is the owner.
  for (const order of ["u1-first", "u2-first"] as const) {
    const t = await setup();
    if (order === "u1-first") { t.u1.reject(gone()); t.u2.resolve(ok()); } else { t.u2.resolve(ok()); t.u1.reject(gone()); }
    await settle();
    expect(t.g.id).toBe(ID);
    expect(owner(t.g)).toBe("u2");
  }
  // A leave in between: neither answer does anything afterwards.
  const t = await setup();
  t.g.leave();
  t.u2.resolve(ok()); t.u1.reject(gone());
  await settle();
  expect(t.g.id).toBeNull();
});
