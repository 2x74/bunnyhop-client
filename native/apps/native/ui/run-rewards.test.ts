import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LevelView, Submission } from "../../web/src/api";
import { COSMETICS, levelInfo, xpForLevel } from "../../web/src/progression";
import { send } from "./bridge";
import { mockHostBridge, type HostBridge } from "./host-bridge-fixture";
import { NativeRunService, type RunApi, type VersionPolicy } from "./run-service";
import { clipUtf8, runProgression, runRewardLines } from "./run-rewards";

const identity = {
  map: "bhop_eazy",
  track: 0,
  style: "autohop" as const,
  build: "bunnyhop-native/123456789abc",
  wasm: "bunnyhop-web/abcdef012345",
};
/** Inside level 5, far enough from both ends that 120 XP doesn't change the level. */
const steadyXp = xpForLevel(5) + 200;
const allowed: VersionPolicy = {
  wasm: identity.wasm,
  native: [{ build: identity.build, wasm: identity.wasm, until: Date.now() + 60_000 }],
};
const finish = (generation: number) => ({
  type: "finish",
  generation,
  ...identity,
  replayBase64: btoa("bhr-mock-transport-bytes"),
});

function level(xp: number): LevelView {
  const info = levelInfo(xp);
  return { level: info.level, xp, into: 0, need: 0, fraction: 0 };
}

/** A run service whose uploads answer with `results` in turn, sending through the real bridge. */
function serviceAnswering(...results: Submission[]) {
  let next = 0;
  const api: RunApi = {
    runBeat: async () => ({ sid: "session", token: "token" }),
    submitRun: async () => results[next++],
    submission: async () => results[next++],
  };
  return new NativeRunService({
    api,
    version: async () => allowed,
    origin: () => "https://bunnyhop.lol",
    send,
    sleep: async () => {},
    pollDelayMs: 0,
  });
}

let host: HostBridge;
beforeEach(() => {
  host = mockHostBridge();
});
afterEach(() => host.restore());

describe("reward lines", () => {
  test("XP, achievements and the items they unlock", () => {
    const lines = runRewardLines(120, level(steadyXp), ["first_finish"]);
    expect(lines.slice(0, 2)).toEqual([
      { title: "+120 XP", detail: "Run verified" },
      { title: "First Hop", detail: "Finish a run on any map" },
    ]);
    expect(lines).toContainEqual({ title: "Garden · Classic", detail: "Garden gloves" });
  });

  test("a level-up shows the new level and what it unlocked", () => {
    const after = xpForLevel(3) + 10;
    const lines = runRewardLines(after - 60, level(after), []);
    expect(lines[1]).toEqual({ title: "Level 3", detail: "Level up" });
    expect(lines).toContainEqual({ title: "Dusk", detail: "New background" });
  });

  test("no level line when the level didn't change", () => {
    const lines = runRewardLines(40, level(xpForLevel(5) + 100), []);
    expect(lines).toEqual([{ title: "+40 XP", detail: "Run verified" }]);
  });

  test("ids missing from this build's catalog are left out", () => {
    expect(runRewardLines(0, undefined, ["not_an_achievement"])).toEqual([]);
  });

  test("a big jump is cut to the 12 lines the host keeps", () => {
    const after = xpForLevel(30);
    const unlocked = COSMETICS.filter((item) => item.unlock.kind === "level" && item.unlock.level <= 30);
    expect(unlocked.length).toBeGreaterThan(12);
    expect(runRewardLines(after, level(after), [])).toHaveLength(12);
  });

  test("long text is cut on a character boundary under the host's byte limit", () => {
    const clipped = clipUtf8("“".repeat(40), 95);
    expect(new TextEncoder().encode(clipped).length).toBe(93);
    expect(clipped).toBe("“".repeat(31));
    expect(clipUtf8("short", 95)).toBe("short");
  });

  test("invalid progression fields are not forwarded", () => {
    const bad = { xp: -5, level: { level: 0 } as LevelView, achievements: "first_finish" as unknown as string[] };
    expect(runProgression(bad)).toEqual({});
    expect(runProgression({})).toEqual({});
  });
});

describe("verified result forwarding", () => {
  test("a verified run carries its progression and resolved rewards", async () => {
    const service = serviceAnswering({
      id: "run",
      status: "verified",
      rank: 4,
      xp: 120,
      level: level(steadyXp),
      achievements: ["first_finish", "unknown_id"],
    });
    await service.receive({ type: "reset", generation: 2 });
    await service.receive(finish(2));
    const verified = host.received.find((message) => message.status === "verified")!;
    expect(verified).toMatchObject({
      type: "runService",
      generation: 2,
      rank: 4,
      xp: 120,
      level: { level: 5, xp: steadyXp },
      achievements: ["first_finish", "unknown_id"],
    });
    const rewards = verified.rewards as { title: string }[];
    expect(rewards.map((reward) => reward.title).slice(0, 2)).toEqual(["+120 XP", "First Hop"]);
  });

  test("progression waits for the verified result, not the queued one", async () => {
    const service = serviceAnswering(
      { id: "run", status: "queued", xp: 120 },
      { id: "run", status: "verified", xp: 120 },
    );
    await service.receive({ type: "reset", generation: 1 });
    await service.receive(finish(1));
    const pending = host.received.filter((message) => message.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.some((message) => "xp" in message || "rewards" in message)).toBe(false);
    expect(host.received.at(-1)).toMatchObject({ status: "verified", xp: 120 });
  });

  test("a rejected run sends no rewards", async () => {
    const service = serviceAnswering({ id: "", status: "rejected", reason: "Desync", xp: 120 });
    await service.receive({ type: "reset", generation: 1 });
    await service.receive(finish(1));
    const rejected = host.received.find((message) => message.status === "rejected")!;
    expect("xp" in rejected || "rewards" in rejected).toBe(false);
  });

  test("a verified result without progression sends no reward fields", async () => {
    const service = serviceAnswering({ id: "run", status: "verified", rank: 2 });
    await service.receive({ type: "reset", generation: 1 });
    await service.receive(finish(1));
    const verified = host.received.find((message) => message.status === "verified")!;
    const progressionKeys = ["xp", "level", "achievements", "rewards"];
    expect(Object.keys(verified).filter((key) => progressionKeys.includes(key))).toEqual([]);
  });

  test("a result that lands after a restart keeps its own generation, so the host drops it", async () => {
    let answer!: (result: Submission) => void;
    const api: RunApi = {
      runBeat: async () => ({ sid: "session", token: "token" }),
      submitRun: () => new Promise((resolve) => (answer = resolve)),
      submission: async () => ({ id: "run", status: "verified" }),
    };
    const origin = () => "https://bunnyhop.lol";
    const service = new NativeRunService({ api, version: async () => allowed, origin, send });
    await service.receive({ type: "reset", generation: 1 });
    const upload = service.receive(finish(1));
    while (!answer) await new Promise((resolve) => setTimeout(resolve, 0));
    await service.receive({ type: "reset", generation: 2 });
    answer({ id: "run", status: "verified", xp: 120 });
    await upload;
    expect(host.received.find((message) => message.status === "verified")).toMatchObject({ generation: 1, xp: 120 });
  });
});
