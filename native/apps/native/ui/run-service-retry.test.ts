import { describe, expect, test } from "bun:test";
import { RETRY_ATTEMPTS, parsePendingUpload, retryDelayMs, type PendingUpload } from "./pending-uploads";
import { NativeRunService, type RunApi, type RunServiceStatus, type VersionPolicy } from "./run-service";

const identity = {
  map: "bhop_eazy",
  track: 0,
  style: "autohop" as const,
  build: "bunnyhop-native/123456789abc",
  wasm: "bunnyhop-web/abcdef012345",
};
const allowed: VersionPolicy = {
  wasm: identity.wasm,
  native: [{ build: identity.build, wasm: identity.wasm, until: Date.now() + 60_000 }],
};
const replayId = "bhop_eazy-1763500000000000000.bhr";
const bytes = "bhr-mock-transport-bytes";

/** The host's store, in memory: records by replay id and the archive's replays. */
class MemoryStore {
  records = new Map<string, PendingUpload>();
  replays = new Map<string, string>([[replayId, btoa(bytes)]]);
  async list() {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
  async save(record: PendingUpload) {
    this.records.set(record.id, structuredClone(record));
  }
  async remove(id: string) {
    this.records.delete(id);
  }
  async replay(id: string) {
    return this.replays.get(id) ?? null;
  }
}

type Answer = () => Promise<{ id?: string; status: string; code?: string }>;
const httpError = (status: number, code = "server_error", message = "failed") =>
  Object.assign(new Error(message), { status, code });

function fixture(
  answers: Answer[],
  store = new MemoryStore(),
  account = "user-1",
  sleep: (ms: number) => Promise<void> = async () => {},
) {
  const statuses: RunServiceStatus[] = [];
  const uploads: { bytes: string; beats: string[] }[] = [];
  const uploaded: string[] = [];
  let me = account;
  const api: RunApi = {
    runBeat: async () => ({ sid: "session", token: `t${uploads.length}` }),
    submitRun: async (sent, options) => {
      uploads.push({ bytes: new TextDecoder().decode(sent), beats: options.beats });
      const answer = answers.shift() ?? (async () => ({ id: "stored", status: "verified" }));
      return answer() as ReturnType<RunApi["submitRun"]>;
    },
    submission: async () => ({ id: "stored", status: "verified" }),
  };
  const service = new NativeRunService({
    api,
    version: async () => allowed,
    origin: () => "https://bunnyhop.lol",
    send: (status) => statuses.push(status),
    account: async () => me,
    uploads: store,
    sleep,
    retryDelayMs: () => 0,
    savedRunUploaded: (map) => uploaded.push(map),
  });
  return {
    service,
    store,
    statuses,
    uploads,
    uploaded,
    signIn: (id: string) => {
      me = id;
      service.refreshAccount();
    },
  };
}

/** Lets the service's background retries run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function finishedRun(f: ReturnType<typeof fixture>) {
  await f.service.receive({ type: "reset", generation: 1 });
  await f.service.receive({ type: "beat", generation: 1, ...identity, tick: 0, hash: "1234abcd", paused: false });
  await f.service.receive({ type: "beat", generation: 1, ...identity, tick: 400, hash: "1234abcd", paused: false });
  await f.service.receive({ type: "finish", generation: 1, ...identity, replayId, replayBase64: btoa(bytes) });
  await settle();
}

describe("failed native uploads are sent again", () => {
  for (const [name, failure] of [
    ["a 500", () => Promise.reject(httpError(500))],
    ["a 503", () => Promise.reject(httpError(503))],
    ["no connection", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a 408", () => Promise.reject(httpError(408, "timeout"))],
    ["a 429", () => Promise.reject(httpError(429, "too_many_requests"))],
  ] as const) {
    test(`after ${name}, with the same bytes and beats, and the stored record is dropped`, async () => {
      const f = fixture([failure, failure]);
      await finishedRun(f);
      expect(f.uploads.length).toBe(3);
      expect(new Set(f.uploads.map((u) => u.bytes))).toEqual(new Set([bytes]));
      expect(f.uploads.every((u) => u.beats.join() === "t0,t0")).toBe(true);
      expect(f.store.records.size).toBe(0);
      expect(f.uploaded).toEqual([identity.map]);
      const kept = f.statuses.find((s) => s.status === "kept");
      expect(kept?.message).toContain("uploads by itself");
    });
  }

  for (const [name, refusal] of [
    ["a 400", httpError(400, "bad_replay", "replay longer than 2880000 ticks (8 hours)")],
    ["a 403", httpError(403, "forbidden", "not yours")],
    ["a 413", httpError(413, "too_large", "replay is larger than the 16 MB limit")],
  ] as const) {
    test(`never after ${name}`, async () => {
      const f = fixture([() => Promise.reject(refusal)]);
      await finishedRun(f);
      expect(f.uploads.length).toBe(1);
      expect(f.store.records.size).toBe(0);
      expect(f.statuses.at(-1)?.message).toContain(`The server refused this run: ${refusal.message}.`);
    });
  }

  test("a resend the server refuses is dropped, not reported as uploaded", async () => {
    const f = fixture([() => Promise.reject(httpError(502)), () => Promise.reject(httpError(400, "bad_replay"))]);
    await finishedRun(f);
    expect(f.uploads.length).toBe(2);
    expect(f.store.records.size).toBe(0);
    expect(f.uploaded).toEqual([]);
  });

  test("stops after its attempts, and keeps the replay in the archive", async () => {
    const down = () => Promise.reject(httpError(500));
    const f = fixture(Array.from({ length: RETRY_ATTEMPTS + 5 }, () => down));
    await finishedRun(f);
    expect(f.uploads.length).toBe(1 + RETRY_ATTEMPTS);
    expect(f.store.records.size).toBe(0);
    expect(f.store.replays.has(replayId)).toBe(true);
    expect(f.statuses.at(-1)?.message).toContain("Stopped trying to upload this run.");
  });
});

describe("a failed upload survives a restart", () => {
  /** A run whose upload fails, and the game closes while it waits to send it again. */
  async function storedRun(): Promise<MemoryStore> {
    const f = fixture([() => Promise.reject(httpError(500))], new MemoryStore(), "user-1", () => new Promise(() => {}));
    await finishedRun(f);
    expect(f.uploads.length).toBe(1);
    return f.store;
  }

  test("the record holds the beats, the account and the archive's replay id", async () => {
    const store = await storedRun();
    const [record] = await store.list();
    expect(record).toMatchObject({
      id: replayId,
      account: "user-1",
      ...identity,
      beats: ["t0", "t0"],
      gaps: 0,
      attempts: 0,
    });
    expect(parsePendingUpload(replayId, JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  test("the next start sends it under the same account, from the archived replay", async () => {
    const store = await storedRun();
    const f = fixture([], store, "user-1");
    await settle();
    expect(f.uploads).toEqual([{ bytes, beats: ["t0", "t0"] }]);
    expect(store.records.size).toBe(0);
    expect(f.uploaded).toEqual([identity.map]);
    // A resent run says nothing on the HUD of whatever run is on screen now.
    expect(f.statuses).toEqual([]);
  });

  test("another account never sends it, and it waits for its own", async () => {
    const store = await storedRun();
    const f = fixture([], store, "user-2");
    await settle();
    expect(f.uploads).toEqual([]);
    expect(store.records.size).toBe(1);
    f.signIn("user-1");
    await settle();
    expect(f.uploads.length).toBe(1);
    expect(store.records.size).toBe(0);
  });

  test("a replay deleted from the archive drops its record without sending", async () => {
    const store = await storedRun();
    store.replays.clear();
    const f = fixture([], store, "user-1");
    await settle();
    expect(f.uploads).toEqual([]);
    expect(store.records.size).toBe(0);
  });

  test("a record that isn't one this client wrote is ignored", () => {
    expect(parsePendingUpload(replayId, { id: replayId })).toBeNull();
    expect(parsePendingUpload("../x.bhr", { id: "../x.bhr" })).toBeNull();
  });
});

test("the backoff doubles from 30 s to half an hour", () => {
  expect([0, 1, 2, 5, 6, 12].map((round) => retryDelayMs(round, 0.5))).toEqual([
    30_000, 60_000, 120_000, 960_000, 1_800_000, 1_800_000,
  ]);
});
