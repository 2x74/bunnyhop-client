import { expect, test } from "bun:test";
import { readTimelineData } from "./replay-timeline";
import { applyReplayHostState, applyReplayTimeline, hostSupports, replayCompare, replayTimeline } from "./replay-host";

const TIMELINE = {
  id: "bh_aztec-1.bhr",
  firstTick: 100,
  step: 2,
  speed: [0, 250.5, 300],
  jumps: [120, 160],
  splits: [{ tick: 140, kind: "stage", index: 2 }],
  startTick: 110,
  endTick: 150,
  desyncTick: null,
};

test("the host's timeline is read value by value", () => {
  expect(readTimelineData(TIMELINE)).toEqual(TIMELINE as ReturnType<typeof readTimelineData>);
  // Bad marks are dropped, not the whole timeline; a missing finish is 0, as in the web's RunData.
  const loose = readTimelineData({
    ...TIMELINE,
    jumps: [120, -1, 1.5, "x"],
    splits: [{ tick: 1, kind: "lap", index: 1 }],
    endTick: undefined,
    desyncTick: 130,
  });
  expect(loose?.jumps).toEqual([120]);
  expect(loose?.splits).toEqual([]);
  expect(loose?.endTick).toBe(0);
  expect(loose?.desyncTick).toBe(130);
  // Without a replay id, a step or a clean speed graph it isn't a timeline at all.
  for (const broken of [
    { ...TIMELINE, id: "" },
    { ...TIMELINE, step: 0 },
    { ...TIMELINE, speed: [1, Number.NaN] },
    { ...TIMELINE, speed: [-4] },
    null,
    "timeline",
  ]) {
    expect(readTimelineData(broken)).toBeNull();
  }
});

test("the viewer's host extras: features, the compare ghost, and the timeline for the replay playing", () => {
  expect(hostSupports("compare")).toBe(false);
  applyReplayHostState({
    playback: { active: true, features: ["compare", 7], compare: { kind: "wr", name: "WR · oiwa", endTick: 900 } },
  });
  expect(hostSupports("compare")).toBe(true);
  expect(replayCompare()).toEqual({ kind: "wr", name: "WR · oiwa", endTick: 900 });
  // A state without the fields keeps them; an unknown ghost kind clears the compare; leaving the replay ends it.
  applyReplayHostState({ playback: { tick: 5 } });
  expect(replayCompare()?.kind).toBe("wr");
  applyReplayHostState({ playback: { compare: { kind: "rival", name: "x" } } });
  expect(replayCompare()).toBeNull();
  applyReplayHostState({ playback: { compare: { kind: "pb", name: "Your PB", endTick: -2 } } });
  expect(replayCompare()).toEqual({ kind: "pb", name: "Your PB", endTick: null });
  applyReplayHostState({ playback: { active: false } });
  expect(replayCompare()).toBeNull();

  applyReplayTimeline(TIMELINE);
  expect(replayTimeline("bh_aztec-1.bhr")?.startTick).toBe(110);
  expect(replayTimeline("another.bhr")).toBeNull();
  applyReplayTimeline({ id: "bad" });
  expect(replayTimeline("bh_aztec-1.bhr")).not.toBeNull();
});
