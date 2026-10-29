import { test, expect } from "bun:test";
import { rankedLine, rankedState, readUpdateStatus } from "./update-status";

test("update state only accepts known phases and bounded values", () => {
  expect(readUpdateStatus(null)).toBeNull();
  expect(readUpdateStatus({ status: "installed" })).toBeNull();
  expect(readUpdateStatus({ status: "available", version: "1.2.0", received: NaN, bytes: -4 })).toEqual({
    status: "available",
    message: "",
    currentVersion: "local",
    version: "1.2.0",
    notes: "",
    build: undefined,
    wasm: undefined,
    received: 0,
    bytes: undefined,
    inPlace: false,
    inPlaceReason: "",
    packageSaved: false,
    automatic: true,
  });
  expect(readUpdateStatus({ status: "error", message: "x".repeat(2000) })?.message).toHaveLength(1000);
  expect(readUpdateStatus({ status: "staged", inPlace: true, automatic: false })).toMatchObject({
    inPlace: true,
    automatic: false,
  });
  expect(readUpdateStatus({ status: "available", notes: "n".repeat(20_000) })?.notes).toHaveLength(8192);
});

test("the ranked line says whether the server lists the new build", () => {
  const build = "bunnyhop-native/" + "a".repeat(24);
  const wasm = "bunnyhop-web/3cd68ab1a59f";
  const now = 1_800_000_000_000;
  const listed = { wasm, native: [{ build, wasm, until: now + 1000 }] };
  expect(rankedState(listed, build, wasm, now)).toBe("allowed");
  expect(rankedState({ wasm, native: [] }, build, wasm, now)).toBe("waiting");
  expect(rankedState({ wasm, native: [{ build, wasm, until: now - 1 }] }, build, wasm, now)).toBe("waiting");
  expect(rankedState(null, build, wasm, now)).toBe("unknown");
  expect(rankedState(listed, build, undefined, now)).toBe("unknown");
  expect(rankedLine("waiting")).toContain("not ranked");
});
