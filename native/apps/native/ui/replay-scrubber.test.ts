import { test, expect } from "bun:test";
import { ReplayScrubber } from "./replay-scrubber";
import { replayLibrary } from "./replay-library";
import type { NativeReplay } from "./bridge";
test("scrub pauses playing replay, coalesces intermediate ticks, flushes final and restores play", async () => {
  const events: unknown[] = [];
  const scrub = new ReplayScrubber({
    pause: (paused) => events.push(["pause", paused]),
    seek: (tick) => events.push(["seek", tick]),
    delay: 10,
  });
  scrub.begin(false, 0);
  for (let tick = 1; tick <= 100; tick++) scrub.update(tick);
  expect(events).toEqual([
    ["pause", true],
    ["seek", 1],
  ]);
  await new Promise((r) => setTimeout(r, 15));
  expect(events).toEqual([
    ["pause", true],
    ["seek", 1],
    ["seek", 100],
  ]);
  scrub.finish(110);
  expect(events.slice(-2)).toEqual([
    ["seek", 110],
    ["pause", false],
  ]);
  await new Promise((r) => setTimeout(r, 15));
  expect(events).toHaveLength(5);
});
test("paused scrub stays paused and replacement cancels pending work without touching new replay", async () => {
  const events: unknown[] = [];
  const scrub = new ReplayScrubber({
    pause: (paused) => events.push(["pause", paused]),
    seek: (tick) => events.push(["seek", tick]),
    delay: 10,
  });
  scrub.begin(true, 10);
  scrub.update(15.6);
  scrub.finish(18);
  expect(events).toEqual([
    ["seek", 16],
    ["seek", 18],
  ]);
  scrub.begin(false, 18);
  scrub.update(20);
  scrub.update(30);
  scrub.cancel(false);
  await new Promise((r) => setTimeout(r, 15));
  expect(events).toEqual([
    ["seek", 16],
    ["seek", 18],
    ["pause", true],
    ["seek", 20],
  ]);
});
test("replay vault filters maps/player/style and sorts without mutating archive", () => {
  const rows: NativeReplay[] = [
    { id: "a", name: "Alice", map: "bhop_a", style: "autohop", track: 0, seconds: 20, recordedAt: 3, bytes: 100 },
    { id: "b", name: "Bob", map: "bhop_b", style: "scroll", track: 0, seconds: 10, recordedAt: 1, bytes: 200 },
  ];
  expect(replayLibrary(rows, " BOB ", "", "newest").map((r) => r.id)).toEqual(["b"]);
  expect(replayLibrary(rows, "bhop", "scroll", "newest").map((r) => r.id)).toEqual(["b"]);
  expect(replayLibrary(rows, "", "", "fastest").map((r) => r.id)).toEqual(["b", "a"]);
  expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
});
