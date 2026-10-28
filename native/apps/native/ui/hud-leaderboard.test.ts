import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Leaderboard, LeaderboardEntry } from "../../web/src/api";
import { send } from "./bridge";
import { mockHostBridge, type HostBridge } from "./host-bridge-fixture";
import { NativeHudLeaderboard, type BoardContext } from "./hud-leaderboard";

const eazy: BoardContext = { map: "bhop_eazy", style: "autohop", track: 0, generation: 4 };

function board(context: BoardContext, rank: number | null, total: number): Leaderboard {
  const me = rank === null ? null : ({ rank, time: 12.5, player: { id: "me" } } as unknown as LeaderboardEntry);
  return { map: context.map, style: context.style, track: context.track, total, entries: [], me };
}

interface PendingRead {
  args: [string, string, number];
  resolve(value: Leaderboard): void;
  reject(error: Error): void;
}

/** Board reads that answer only when a test says so, so replies can arrive late and out of order. */
function controlledReads() {
  const pending: PendingRead[] = [];
  const read = (map: string, style: string, track: number) =>
    new Promise<Leaderboard>((resolve, reject) => pending.push({ args: [map, style, track], resolve, reject }));
  return { pending, read };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let host: HostBridge;
beforeEach(() => {
  host = mockHostBridge();
});
afterEach(() => host.restore());

describe("HUD leaderboard place forwarding", () => {
  test("sends the player's place and top percent for the board being run", async () => {
    const reads = controlledReads();
    const place = new NativeHudLeaderboard(reads.read, send);
    place.update(eazy);
    expect(reads.pending[0].args).toEqual(["bhop_eazy", "autohop", 0]);
    reads.pending[0].resolve(board(eazy, 4, 150));
    await settle();
    expect(host.received).toEqual([
      { type: "hudLeaderboard", map: "bhop_eazy", style: "autohop", track: 0, generation: 4, place: 4, topPercent: 3 },
    ]);
  });

  test("first place and an unknown board size send the place without a percent", async () => {
    const reads = controlledReads();
    const place = new NativeHudLeaderboard(reads.read, send);
    place.update(eazy);
    reads.pending[0].resolve(board(eazy, 1, 150));
    await settle();
    place.update({ ...eazy, generation: 5 });
    reads.pending[1].resolve({ ...board(eazy, 7, 0), total: Number.NaN });
    await settle();
    expect(host.received.map((message) => [message.place, message.topPercent])).toEqual([
      [1, undefined],
      [7, undefined],
    ]);
  });

  test("an unranked player clears the line with place 0", async () => {
    const reads = controlledReads();
    const place = new NativeHudLeaderboard(reads.read, send);
    place.update(eazy);
    reads.pending[0].resolve(board(eazy, null, 150));
    await settle();
    expect(host.received).toEqual([{ type: "hudLeaderboard", ...eazy, place: 0 }]);
  });

  test("a failed board read sends nothing", async () => {
    const reads = controlledReads();
    const place = new NativeHudLeaderboard(reads.read, send);
    place.update(eazy);
    reads.pending[0].reject(new Error("offline"));
    await settle();
    expect(host.received).toEqual([]);
  });

  test("a reply for a map the player has left is dropped", async () => {
    const reads = controlledReads();
    const place = new NativeHudLeaderboard(reads.read, send);
    const next = { ...eazy, map: "bhop_arcane", generation: 5 };
    place.update(eazy);
    place.update(next);
    reads.pending[1].resolve(board(next, 9, 40));
    reads.pending[0].resolve(board(eazy, 2, 150));
    await settle();
    expect(host.received).toEqual([{ type: "hudLeaderboard", ...next, place: 9, topPercent: 23 }]);
  });

  test("a reply for an earlier attempt is dropped and the new attempt gets its own", async () => {
    const reads = controlledReads();
    const place = new NativeHudLeaderboard(reads.read, send);
    place.update(eazy);
    place.update({ ...eazy, generation: 5 });
    reads.pending[0].resolve(board(eazy, 4, 150));
    await settle();
    expect(host.received).toEqual([]);
    reads.pending[1].resolve(board(eazy, 4, 150));
    await settle();
    expect(host.received.map((message) => message.generation)).toEqual([5]);
  });

  test("leaving the map drops a pending reply", async () => {
    const reads = controlledReads();
    const place = new NativeHudLeaderboard(reads.read, send);
    place.update(eazy);
    place.update(null);
    reads.pending[0].resolve(board(eazy, 4, 150));
    await settle();
    expect(host.received).toEqual([]);
  });

  test("the same attempt reads once; refresh reads again after a verified run", async () => {
    const reads = controlledReads();
    const place = new NativeHudLeaderboard(reads.read, send);
    place.update(eazy);
    place.update({ ...eazy });
    expect(reads.pending).toHaveLength(1);
    reads.pending[0].resolve(board(eazy, 4, 150));
    await settle();
    place.refresh();
    expect(reads.pending).toHaveLength(2);
    reads.pending[1].resolve(board(eazy, 2, 151));
    await settle();
    expect(host.received.map((message) => message.place)).toEqual([4, 2]);
  });

  test("refresh with no map on screen reads nothing", () => {
    const reads = controlledReads();
    const place = new NativeHudLeaderboard(reads.read, send);
    place.refresh();
    place.update(null);
    place.refresh();
    expect(reads.pending).toHaveLength(0);
  });
});
