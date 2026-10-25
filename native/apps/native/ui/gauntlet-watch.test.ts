import { test, expect } from "bun:test";
import type { GauntletWatchPlan } from "../../web/src/api";
import { splitRefusal, stepSplit, stopWatchingSplit, watchGauntletSplit, watchingSplit, type GauntletWatchDeps } from "./gauntlet-watch";

// Whole-attempt watching: never a split on a map build the client doesn't have; split by split otherwise.
const A = "a".repeat(64), B = "b".repeat(64), OLD = "0".repeat(64);
const plan = (shaB = B): GauntletWatchPlan => ({
  attemptId: "AbCdEfGhIjKlMnOp", state: "complete", gauntlet: { slug: "w", title: "Weekly", kind: "weekly", maps: 2 }, player: { id: "p", name: "Runner" } as never,
  totalTicks: null, realMs: null, finishedAt: null, record: null,
  splits: [{ idx: 0, map: "bhop_a", runId: "run_a", ticks: 1, time: 10, mapSha256: A, verified: true }, { idx: 1, map: "bhop_b", runId: "run_b", ticks: 1, time: 20, mapSha256: shaB, verified: true }],
} as unknown as GauntletWatchPlan);
function deps(p: GauntletWatchPlan, index: Record<string, string | null> = { bhop_a: A, bhop_b: B }) {
  const played: string[] = [];
  const d: GauntletWatchDeps = { plan: async () => p, sha: async (map) => index[map] ?? null, play: async (runId) => void played.push(runId) };
  return { d, played };
}

test("plays a split on the current build and steps between splits with the total before it", async () => {
  stopWatchingSplit();
  const { d, played } = deps(plan());
  await watchGauntletSplit(d, "AbCdEfGhIjKlMnOp", 0);
  expect(played).toEqual(["run_a"]);
  expect(watchingSplit()).toMatchObject({ idx: 0, before: 0 });
  await stepSplit(d, 1);
  expect(played).toEqual(["run_a", "run_b"]);
  expect(watchingSplit()).toMatchObject({ idx: 1, before: 10 });
  await stepSplit(d, 1); // no split after the last
  expect(played).toHaveLength(2);
});

test("an earlier map build (or an unknown one) is refused, never played", async () => {
  stopWatchingSplit();
  const old = deps(plan(OLD));
  await expect(watchGauntletSplit(old.d, "AbCdEfGhIjKlMnOp", 1)).rejects.toThrow("Split 2 (bhop_b) was run on an earlier build of the map.");
  expect(old.played).toEqual([]);
  expect(watchingSplit()).toBeNull();
  expect(await splitRefusal(plan(), 1, async () => null)).toContain("earlier build");
  expect(await splitRefusal(plan(), 5, async () => B)).toBe("This attempt has no split 6.");
  expect(await splitRefusal(plan(), 0, async () => A.toUpperCase())).toBeNull();
});
