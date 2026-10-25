import { expect, test } from "bun:test";
import { NativeRunService, type RunApi, type RunServiceStatus, type VersionPolicy } from "./run-service";

// A gauntlet candidate's upload that fails for the connection is sent again (web gauntlet/mode.ts "held"): same bytes,
// beats and attempt; only while the gauntlet still holds it; bounded; never after a definite refusal. Mocked network.
const identity = { map: "bhop_a", track: 0, style: "autohop" as const, build: "bunnyhop-native/123456789abc", wasm: "bunnyhop-web/abcdef012345" };
const allowed: VersionPolicy = { wasm: identity.wasm, native: [{ build: identity.build, wasm: identity.wasm, until: Date.now() + 60_000 }] };
const ID = "AbCdEfGhIjKlMnOp";
const finish = (generation: number) => ({ type: "finish", generation, ...identity, replayBase64: btoa("bhr-mock-transport-bytes") });

function fixture(failures: unknown[], o: { hold?: (attempt: string, generation: number) => boolean; retries?: number; gauntlet?: string | null } = {}) {
  const statuses: RunServiceStatus[] = [], uploads: { gauntlet?: string | null; bytes: string }[] = [], sleeps: number[] = [];
  const api: RunApi = {
    runBeat: async () => ({ sid: "s", token: "t" }),
    submitRun: async (bytes, options) => {
      uploads.push({ gauntlet: options.gauntlet, bytes: new TextDecoder().decode(bytes) });
      const failure = failures.shift();
      if (failure) throw failure;
      return { id: "run", status: "queued", gauntlet: { attemptId: ID, split: 0, state: "open" } };
    },
    submission: async () => ({ id: "run", status: "verified" }),
  };
  const service = new NativeRunService({
    api, version: async () => allowed, origin: () => "https://bunnyhop.lol", send: (s) => statuses.push(s),
    context: () => ({ gauntlet: o.gauntlet === undefined ? ID : o.gauntlet }), holdGauntlet: o.hold ?? (() => true),
    sleep: async (ms) => void sleeps.push(ms), pollLimitMs: 1, gauntletRetries: o.retries,
  });
  return { service, statuses, uploads, sleeps };
}
const offline = () => new TypeError("Failed to fetch");

test("a held candidate is sent again, the same bytes and attempt, every 10 s, until the server has it", async () => {
  const f = fixture([offline(), offline()]);
  await f.service.receive({ type: "reset", generation: 1 });
  await f.service.receive(finish(1));
  expect(f.uploads).toHaveLength(3);
  expect(new Set(f.uploads.map((u) => `${u.gauntlet}:${u.bytes}`))).toEqual(new Set([`${ID}:bhr-mock-transport-bytes`]));
  expect(f.sleeps.filter((ms) => ms === 10_000)).toHaveLength(2);
  const held = f.statuses.filter((s) => s.held);
  expect(held).toHaveLength(2);
  expect(held[0]).toMatchObject({ status: "uploading", generation: 1, message: "No connection. This run counts once it uploads." });
  expect(f.statuses.find((s) => s.gauntlet)).toMatchObject({ gauntlet: { attemptId: ID, split: 0 } });
});

test("the gauntlet letting go, the retry cap, a 4xx or an untagged run each stop it", async () => {
  // Let go between tries (the player left the attempt): kept, no more uploads.
  let holding = true;
  const left = fixture([offline(), offline(), offline()], { hold: () => { const now = holding; holding = false; return now; } });
  await left.service.receive({ type: "reset", generation: 1 });
  await left.service.receive(finish(1));
  expect(left.uploads).toHaveLength(1);
  expect(left.statuses.at(-1)).toMatchObject({ status: "kept", message: "The gauntlet moved on before this run could upload. Replay remains in your local native archive." });
  // The cap (the grace period).
  const capped = fixture(Array(10).fill(0).map(offline), { retries: 3 });
  await capped.service.receive({ type: "reset", generation: 1 });
  await capped.service.receive(finish(1));
  expect(capped.uploads).toHaveLength(4);
  expect(capped.statuses.at(-1)?.status).toBe("kept");
  // A definite refusal is never resent.
  const refused = fixture([Object.assign(new Error("bad"), { status: 400, code: "bad_replay" })]);
  await refused.service.receive({ type: "reset", generation: 1 });
  await refused.service.receive(finish(1));
  expect(refused.uploads).toHaveLength(1);
  expect(refused.statuses.some((s) => s.held)).toBe(false);
  // Not a gauntlet candidate: as before, kept at once.
  const plain = fixture([offline()], { gauntlet: null });
  await plain.service.receive({ type: "reset", generation: 1 });
  await plain.service.receive(finish(1));
  expect(plain.uploads).toHaveLength(1);
  expect(plain.statuses.at(-1)).toMatchObject({ status: "kept", message: "The replay could not reach the server. Replay remains in your local native archive." });
});

test("a newer attempt (reset) doesn't stop a completed run's resends, but a stale generation is never what's held", async () => {
  const seen: number[] = [];
  const f = fixture([offline()], { hold: (_a, generation) => (seen.push(generation), generation === 1) });
  await f.service.receive({ type: "reset", generation: 1 });
  const done = f.service.receive(finish(1));
  await f.service.receive({ type: "reset", generation: 2 });
  await done;
  expect(seen.every((g) => g === 1)).toBe(true);
  expect(f.uploads).toHaveLength(2);
});
