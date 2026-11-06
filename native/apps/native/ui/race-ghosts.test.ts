import { expect, test } from "bun:test";
import { NativeRaceGhosts, type RaceGhostRequest } from "./race-ghosts";
import { DEFAULT_PREFS } from "../../web/src/ui/settings";

const context = { map: "bhop_test", style: "autohop", track: 0, generation: 1 };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture() {
  const sent: RaceGhostRequest[] = [];
  const reads: string[] = [];
  const prefs = structuredClone(DEFAULT_PREFS);
  const service = new NativeRaceGhosts({
    pb: async () => {
      reads.push("pb");
      return new Uint8Array([1]);
    },
    wr: async () => {
      reads.push("wr");
      return new Uint8Array([2]);
    },
    base64: (bytes) => String(bytes[0]),
    send: (request) => sent.push(request),
  });
  return { sent, reads, prefs, service };
}

test("PB and WR load without opening Replays, including route only, and retain their source", async () => {
  const { service, prefs, sent, reads } = fixture();
  prefs.ghost.route = prefs.ghost.routeOnly = true;
  service.update(context, prefs, [], []);
  await flush();
  expect(reads).toEqual(["pb", "wr"]);
  expect(sent).toEqual([
    { type: "raceGhost", ...context, source: "pb", ghostSlot: 0, replayBase64: "1" },
    { type: "raceGhost", ...context, source: "wr", ghostSlot: 1, replayBase64: "2" },
  ]);
  service.update(context, prefs, [], []);
  await flush();
  expect(sent).toHaveLength(2);
});

test("live toggles fetch only enabled ghosts and never overwrite custom slots", async () => {
  const { service, prefs, sent, reads } = fixture();
  prefs.showGhost = false;
  service.update(context, prefs, [], []);
  await flush();
  expect(reads).toEqual([]);
  prefs.showGhost = true;
  prefs.ghost.pb = false;
  service.update(context, prefs, [{ slot: 0, id: "custom", name: "Custom", source: "custom", enabled: true }], []);
  await flush();
  expect(sent).toMatchObject([{ source: "wr", ghostSlot: 1 }]);
});

test("map changes, leaving a map and toggling ghosts cancel stale async replies", async () => {
  for (const next of [null, { ...context, map: "next" }, { ...context, generation: 2 }]) {
    let finish!: (bytes: Uint8Array) => void;
    const sent: RaceGhostRequest[] = [];
    const p = structuredClone(DEFAULT_PREFS);
    p.ghost.wr = false;
    const service = new NativeRaceGhosts({
      pb: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      wr: async () => null,
      base64: () => "data",
      send: (request) => sent.push(request),
    });
    service.update(context, p, [], []);
    const old = finish;
    service.update(next, p, [], []);
    old(new Uint8Array([1]));
    await flush();
    expect(sent).toEqual([]);
  }
});

test("an already loaded explicit source does not fetch again", async () => {
  const { service, prefs, sent, reads } = fixture();
  prefs.ghost.pb = false;
  service.update(
    context,
    prefs,
    [{ slot: 2, id: "wr", name: "WR", source: "wr", enabled: false, map: context.map, style: "autohop", track: 0 }],
    [],
  );
  await flush();
  expect(reads).toEqual([]);
  expect(sent).toEqual([]);
});

test("a track change replaces the previous WR in its own slot", async () => {
  const { service, prefs, sent } = fixture();
  prefs.ghost.pb = false;
  service.update(
    { ...context, track: 1 },
    prefs,
    [{ slot: 1, id: "wr", name: "WR", source: "wr", enabled: true, map: context.map, style: "autohop", track: 0 }],
    [],
  );
  await flush();
  expect(sent).toMatchObject([{ source: "wr", ghostSlot: 1, track: 1 }]);
});

test("offline PB fallback uses an eligible local run", async () => {
  const sent: RaceGhostRequest[] = [];
  const prefs = structuredClone(DEFAULT_PREFS);
  prefs.ghost.wr = false;
  const service = new NativeRaceGhosts({
    pb: async () => null,
    wr: async () => null,
    base64: () => "",
    send: (request) => sent.push(request),
  });
  const run = (id: string, seconds: number, eligible: boolean) => ({
    id,
    name: id,
    map: context.map,
    style: "autohop" as const,
    track: 0,
    seconds,
    recordedAt: 1,
    bytes: 100,
    localSummary: {
      schema: 1 as const,
      map: context.map,
      style: "autohop",
      track: 0,
      time: seconds,
      jumps: 0,
      strafes: 0,
      sync: 0,
      finishedAt: 1,
      client: "native",
      localPb: true,
      eligible,
    },
  });
  service.update(context, prefs, [], [run("practice.bhr", 1, false), run("pb.bhr", 2, true)]);
  await flush();
  expect(sent).toMatchObject([{ source: "pb", id: "pb.bhr" }]);
});
