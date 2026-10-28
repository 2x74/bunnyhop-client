import { expect, test } from "bun:test";
import { NativeWorldRecord } from "./world-record";
test("provisional WR read is fenced across map and attempt changes", async () => {
  const pending: Array<(value: { time: number } | null) => void> = [],
    sent: unknown[] = [];
  const read = new NativeWorldRecord(
    () => new Promise((resolve) => pending.push(resolve)),
    (context, seconds) => sent.push({ ...context, seconds }),
  );
  const a = { map: "a", style: "autohop", track: 0, generation: 1 };
  read.update(a);
  read.update(a);
  expect(pending).toHaveLength(1);
  read.update({ ...a, map: "b", generation: 2 });
  pending[0]({ time: 5 });
  await Promise.resolve();
  expect(sent).toHaveLength(2);
  pending[1]({ time: 8 });
  await Promise.resolve();
  expect(sent.at(-1)).toEqual({ ...a, map: "b", generation: 2, seconds: 8 });
  read.update({ ...a, generation: 3 });
  read.update(null);
  pending[2]({ time: 4 });
  await Promise.resolve();
  expect(sent).toHaveLength(4);
});
test("unknown and invalid record times cannot cause gold finishes", async () => {
  for (const time of [0, -1, NaN, Infinity]) {
    const sent: Array<number | null> = [];
    const read = new NativeWorldRecord(
      async () => ({ time }),
      (_, seconds) => sent.push(seconds),
    );
    read.update({ map: "a", style: "autohop", track: 0, generation: 1 });
    await Promise.resolve();
    expect(sent).toEqual([null, null]);
  }
});
