import { expect, test } from "bun:test";
import { decodeInput, decodeSnapshot, encodeInput } from "../../web/src/net/protocol";
import { poseInput, snapshotInputsValid } from "./room-input";
import { validSnapshot } from "./room-service";

// The website's spectate vectors ($V42/spectate/vectors.txt, scripts/vectors.ts): an input block with two records,
// an every-jump report and a cleared start prespeed; one record with a turn yaw; a snapshot carrying V1 for slot 2.
const V1 =
  "020f020040e201007b14ae47e17a843f00007a4300007a441844040080ae4200201944000023c22529110000ad4200001644000024c201002dff" +
  "0600670200003300000000000000d7a39e42ec51c542f6a88c420200295c8fc2f5280e4011363cbd5296ef3f030104ffffffff";
const V2 = "01130000050000007b14ae47e17a843f00007a4300007a440008200000c03f000096430000000000001040";
const V3 = "0201e803000002010040e2010000040000803f00000040000040406402d8ff00000b3e0000036e0002" + V1;
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));
const hex = (u8: Uint8Array) => Buffer.from(u8).toString("hex");

test("a block that crossed from the game as JSON is written to the vectors' bytes", () => {
  for (const vector of [V1, V2]) {
    const decoded = decodeInput(bytes(vector))!;
    // The game's JSON (spectate_input.hpp to_json writes V1's JSON exactly; spectate_input_tests.cpp checks it).
    const fromGame = poseInput(JSON.parse(JSON.stringify(decoded)));
    expect(fromGame).not.toBeNull();
    expect(hex(encodeInput(fromGame!))).toBe(vector);
  }
});

test("a snapshot's input block reaches the game as the website decodes it", () => {
  const snapshot = decodeSnapshot(bytes(V3))!;
  expect(validSnapshot(snapshot)).toBe(true);
  expect(snapshot.inputs).toEqual([{ slot: 2, input: decodeInput(bytes(V1))! }]);
});

test("blocks the encoder can't write whole are refused", () => {
  const v1 = decodeInput(bytes(V1))!;
  expect(poseInput({ ...v1, ticks: [] })).toBeNull();
  expect(poseInput({ ...v1, ticks: [v1.ticks[1], v1.ticks[0]] })).toBeNull();
  expect(poseInput({ ...v1, ticks: Array.from({ length: 41 }, (_, i) => ({ ...v1.ticks[0], tick: i })) })).toBeNull();
  expect(poseInput({ ...v1, tickInterval: 0 })).toBeNull();
  expect(poseInput({ ...v1, reports: [{ tick: 1, kind: 7 }] })).toBeNull();
  expect(snapshotInputsValid([{ slot: 300, input: v1 }])).toBe(false);
  expect(snapshotInputsValid(undefined)).toBe(true);
});
