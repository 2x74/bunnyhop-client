import { test, expect } from "bun:test";
import { NativeActivityService, type ActivitySample, type ActivityDeps } from "./activity-service";
const sample = (seconds: number, jumps = 0, active = true): ActivitySample => ({
  seconds,
  jumps,
  active,
  maps: [{ map: "bhop_test", seconds, jumps, attempts: jumps ? 1 : 0 }],
});
function setup() {
  let now = 0,
    generation = 0,
    user: string | null | undefined = "alice";
  const reports: number[] = [],
    local: unknown[] = [];
  const deps: ActivityDeps = {
    now: () => now,
    generation: () => generation,
    account: async () => user,
    report: async (seconds, dispatch) => {
      await dispatch(async () => {
        reports.push(seconds);
        return new Response("{}");
      });
    },
    local: (d) => local.push(d),
  };
  const service = new NativeActivityService(deps);
  return {
    deps,
    service,
    reports,
    local,
    time: (v: number) => (now = v),
    account: (v: string | null | undefined) => {
      user = v;
      generation++;
    },
  };
}
test("native activity deduplicates samples and shares map/jump/attempt counters", async () => {
  const h = setup();
  await h.service.refreshAccount();
  h.service.receive(sample(0));
  h.service.receive(sample(12, 3));
  h.service.receive(sample(12, 3));
  expect(h.local).toEqual([
    { map: "bhop_test", seconds: 0, jumps: 0, attempts: 0, loaded: true },
    { map: "bhop_test", seconds: 12, jumps: 3, attempts: 1, loaded: false },
    { map: "bhop_test", seconds: 0, jumps: 0, attempts: 0, loaded: false },
  ]);
  expect(h.reports).toEqual([]);
  await h.service.flush();
  expect(h.reports).toEqual([12]);
  h.time(5000);
  h.service.receive(sample(18, 4));
  await h.service.flush();
  expect(h.reports).toEqual([12]);
  h.time(10000);
  await h.service.flush();
  expect(h.reports).toEqual([12, 6]);
});
test("account switch drops old unsent time while device history continues", async () => {
  const h = setup();
  await h.service.refreshAccount();
  h.service.receive(sample(0));
  h.service.receive(sample(10));
  h.account("bob");
  await h.service.refreshAccount();
  h.service.receive(sample(13));
  await h.service.flush();
  expect(h.reports).toEqual([]);
  h.service.receive(sample(16));
  await h.service.flush();
  expect(h.reports).toEqual([3]);
  h.account(null);
  await h.service.refreshAccount();
  h.service.receive(sample(20));
  h.time(70000);
  await h.service.flush();
  expect(h.reports).toEqual([3]);
});
test("account switch while report headers wait cannot dispatch old time", async () => {
  const h = setup();
  let release!: () => void;
  h.deps.report = async (_seconds, dispatch) => {
    await new Promise<void>((r) => (release = r));
    await dispatch(async () => {
      h.reports.push(99);
      return new Response("{}");
    });
  };
  await h.service.refreshAccount();
  h.service.receive(sample(0));
  h.service.receive(sample(10));
  const request = h.service.flush();
  await Promise.resolve();
  h.account("bob");
  await h.service.refreshAccount();
  release();
  await request;
  expect(h.reports).toEqual([]);
});
test("transient failures retry only within the same account; permanent rejection drops batch", async () => {
  const h = setup();
  let fail = 503;
  h.deps.report = async (seconds, dispatch) => {
    await dispatch(async () => {
      h.reports.push(seconds);
      return new Response("{}");
    });
    if (fail) throw { status: fail };
  };
  await h.service.refreshAccount();
  h.service.receive(sample(0));
  h.service.receive(sample(8));
  await h.service.flush();
  h.time(10000);
  fail = 400;
  await h.service.flush();
  h.time(20000);
  fail = 0;
  await h.service.flush();
  expect(h.reports).toEqual([8, 8]);
});
test("unknown account and malformed counters never produce reports", async () => {
  const h = setup();
  h.account(undefined);
  await h.service.refreshAccount();
  h.service.receive(sample(0));
  h.service.receive(sample(60));
  h.service.receive({ ...sample(90), seconds: NaN });
  h.service.receive({ ...sample(90), maps: [{ map: "bad name", seconds: 90, jumps: 0, attempts: 0 }] });
  await h.service.flush();
  expect(h.reports).toEqual([]);
  expect(h.local).toHaveLength(2);
});
test("counter restart starts a fresh baseline without replaying prior local totals", async () => {
  const h = setup();
  await h.service.refreshAccount();
  h.service.receive(sample(0));
  h.service.receive(sample(12));
  h.service.receive(sample(1));
  h.service.receive(sample(4));
  await h.service.flush();
  expect(h.reports).toEqual([3]);
  expect(h.local.at(-2)).toMatchObject({ seconds: 0, loaded: true });
});

test("new map totals after stream baseline credit their first interval", async () => {
  const h = setup();
  await h.service.refreshAccount();
  h.service.receive(sample(0));
  h.service.receive({
    ...sample(2),
    maps: [...sample(1).maps, { map: "bhop_next", seconds: 1, jumps: 2, attempts: 1 }],
  });
  expect(h.local.at(-1)).toEqual({ map: "bhop_next", seconds: 1, jumps: 2, attempts: 1, loaded: true });
});

test("A to B to A cannot restore a previous account epoch's failed report", async () => {
  const h = setup();
  let reject!: (reason: unknown) => void;
  h.deps.report = async (_seconds, dispatch) => {
    await dispatch(async () => new Response("{}"));
    await new Promise<void>((_r, j) => (reject = j));
  };
  await h.service.refreshAccount();
  h.service.receive(sample(0));
  h.service.receive(sample(10));
  const request = h.service.flush();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  h.account("bob");
  await h.service.refreshAccount();
  h.account("alice");
  await h.service.refreshAccount();
  reject({ status: 503 });
  await request;
  h.deps.report = async (seconds, dispatch) => {
    await dispatch(async () => {
      h.reports.push(seconds);
      return new Response("{}");
    });
  };
  h.service.receive(sample(12));
  h.service.receive(sample(14));
  await h.service.flush();
  expect(h.reports).toEqual([2]);
});

test("unsent playtime survives restart only for the same confirmed account", async () => {
  let stored: unknown = null;
  const a = setup();
  a.deps.store = { read: () => stored, write: (value) => (stored = value) };
  await a.service.refreshAccount();
  a.service.receive(sample(0));
  a.service.receive(sample(9));
  expect(stored).toEqual({ owner: "alice", seconds: 9 });
  const b = setup();
  b.deps.store = a.deps.store;
  await b.service.refreshAccount();
  b.service.receive(sample(0));
  await b.service.flush();
  expect(b.reports).toEqual([9]);
  expect(stored).toBeNull();
  stored = { owner: "alice", seconds: 17 };
  const c = setup();
  c.account("bob");
  c.deps.store = a.deps.store;
  await c.service.refreshAccount();
  c.service.receive(sample(0));
  await c.service.flush();
  expect(c.reports).toEqual([]);
  expect(stored).toBeNull();
});

test("unconfirmed account lookup preserves pending time until identity is known", async () => {
  let stored: unknown = null;
  const h = setup();
  h.deps.store = { read: () => stored, write: (value) => (stored = value) };
  await h.service.refreshAccount();
  h.service.receive(sample(0));
  h.service.receive(sample(9));
  h.account(undefined);
  await h.service.refreshAccount();
  h.service.receive(sample(15));
  await h.service.flush();
  expect(h.reports).toEqual([]);
  expect(stored).toEqual({ owner: "alice", seconds: 9 });
  h.account("alice");
  await h.service.refreshAccount();
  h.service.receive(sample(20));
  await h.service.flush();
  expect(h.reports).toEqual([9]);
  expect(stored).toBeNull();
  h.service.receive(sample(24));
  h.account(undefined);
  await h.service.refreshAccount();
  expect(stored).toEqual({ owner: "alice", seconds: 4 });
  h.account("bob");
  await h.service.refreshAccount();
  h.time(20000);
  await h.service.flush();
  expect(h.reports).toEqual([9]);
  expect(stored).toBeNull();
});
