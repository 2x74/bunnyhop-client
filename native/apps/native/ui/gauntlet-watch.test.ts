import { test, expect } from "bun:test";
import type { GauntletWatchPlan } from "../../web/src/api";
import { splitRefusal, stepSplit, stopWatchingSplit, watchGauntletSplit, watchingSplit,updateWatchingPlayback,setAutoAdvance, type GauntletWatchDeps } from "./gauntlet-watch";

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

test("auto advance only responds to the loaded playback and runs once",async()=>{
  stopWatchingSplit();const {d,played}=deps(plan());let fetched=0;d.prefetch=async()=>{fetched++;};d.play=async id=>{played.push(id);return id;};
  await watchGauntletSplit(d,"AbCdEfGhIjKlMnOp",0);await Promise.resolve();await Promise.resolve();expect(fetched).toBe(1);
  const host={active:true,id:"other",map:"bhop_a",tick:10,totalTicks:10,paused:true};
  await updateWatchingPlayback(d,host);expect(played).toEqual(["run_a"]);
  setAutoAdvance(false);await updateWatchingPlayback(d,{...host,id:"run_a"});expect(played).toEqual(["run_a"]);
  setAutoAdvance(true);await updateWatchingPlayback(d,{...host,id:"run_a"});expect(played).toEqual(["run_a","run_b"]);
  await updateWatchingPlayback(d,{...host,id:"run_a"});expect(played).toHaveLength(2);
  await updateWatchingPlayback(d,{...host,id:"run_b",map:"bhop_b"});expect(played).toHaveLength(2);
});
test("stopping while a plan is fetched prevents late playback",async()=>{
  stopWatchingSplit();let resolve!:(value:GauntletWatchPlan)=>void;const {d,played}=deps(plan());d.plan=()=>new Promise(r=>resolve=r);
  const request=watchGauntletSplit(d,"AbCdEfGhIjKlMnOp",0);stopWatchingSplit();resolve(plan());await request;expect(played).toEqual([]);expect(watchingSplit()).toBeNull();
});

test("prefetch carries the next split's verified map digest and cancels on stop",async()=>{
  stopWatchingSplit();const {d}=deps(plan());const fetched:unknown[]=[];let cancelled=0;
  d.prefetch=async(...args)=>{fetched.push(args);};d.cancelPrefetch=()=>{cancelled++;};
  await watchGauntletSplit(d,"AbCdEfGhIjKlMnOp",0);await Promise.resolve();await Promise.resolve();
  expect(fetched).toEqual([["run_b","bhop_b",B]]);stopWatchingSplit();expect(cancelled).toBe(1);
});
test("stopping during the next map lookup prevents a late prefetch",async()=>{
  stopWatchingSplit();const {d}=deps(plan());let resolve!:(sha:string)=>void;let fetched=0;
  d.sha=map=>map==="bhop_a"?Promise.resolve(A):new Promise(r=>resolve=r);d.prefetch=async()=>{fetched++;};
  await watchGauntletSplit(d,"AbCdEfGhIjKlMnOp",0);stopWatchingSplit();resolve(B);await Promise.resolve();await Promise.resolve();
  expect(fetched).toBe(0);
});
