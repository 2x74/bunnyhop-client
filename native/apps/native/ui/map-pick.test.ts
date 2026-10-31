import { expect, test } from "bun:test";
import { pickMap, type MapPickHost } from "./map-pick";

function host(map: string | null = null, leaving: (() => void)[] = []) {
  const calls: string[] = [];
  const value: MapPickHost = {
    map: () => map,
    leaving,
    resume: () => calls.push("resume"),
    request: (id) => calls.push(`request ${id}`),
    refuse: (text) => calls.push(`refuse ${text}`),
    log: (text) => calls.push(`log ${text}`),
  };
  return { value, calls };
}

test("a pick asks the host for the map", () => {
  const { value, calls } = host("bhop_other");
  pickMap("bhop_sqee", value);
  expect(calls).toEqual(["request bhop_sqee"]);
});

test("the map that's already up resumes", () => {
  const { value, calls } = host("bhop_sqee");
  pickMap("bhop_sqee", value);
  expect(calls).toEqual(["resume"]);
});

test("leaving the room or attempt failing doesn't swallow Play", () => {
  const ran: string[] = [];
  const { value, calls } = host(null, [
    () => {
      throw new Error("room closed badly");
    },
    () => ran.push("gauntlet"),
  ]);
  pickMap("bhop_sqee", value);
  expect(ran).toEqual(["gauntlet"]);
  expect(calls).toEqual([
    "log map pick bhop_sqee: leaving the last map failed: Error: room closed badly",
    "request bhop_sqee",
  ]);
});

test("a name that can't be a map is refused out loud, and nothing is left", () => {
  let left = false;
  const { value, calls } = host(null, [() => (left = true)]);
  pickMap("../bad name", value);
  expect(left).toBe(false);
  expect(calls).toEqual(["refuse Can't load \"../bad name\": that isn't a map name."]);
});
