import { test, expect } from "bun:test";
import { rankedLine, rankedState, readUpdateStatus, updatePromptView, type UpdateStatus } from "./update-status";

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
  expect(rankedState({ wasm: "bunnyhop-web/ffffffffffff", native: listed.native }, build, wasm, now)).toBe("allowed");
  expect(rankedState({ wasm, native: [] }, build, wasm, now)).toBe("waiting");
  expect(rankedState({ wasm, native: [{ build, wasm, until: now - 1 }] }, build, wasm, now)).toBe("waiting");
  expect(rankedState(null, build, wasm, now)).toBe("unknown");
  expect(rankedState(listed, build, undefined, now)).toBe("unknown");
  expect(rankedLine("waiting")).toContain("not ranked");
});

const status = (fields: Record<string, unknown>): UpdateStatus => readUpdateStatus(fields)!;

test("the home screen offers a found version with one press, then the restart", () => {
  expect(updatePromptView(null, null, null)).toBeNull();
  expect(updatePromptView(status({ status: "current", version: "0.7.1" }), null, null)).toBeNull();
  expect(updatePromptView(status({ status: "idle" }), null, null)).toBeNull();
  const found = updatePromptView(status({ status: "available", version: "0.7.2", inPlace: true }), null, null);
  expect(found).toEqual({ text: "Version 0.7.2 is out.", action: "download", label: "Update", dismissible: true });
  // A copy that can't replace itself downloads the package for a manual install.
  expect(updatePromptView(status({ status: "available", version: "0.7.2" }), null, null)?.label).toBe("Download");
  const downloading = status({ status: "downloading", version: "0.7.2", received: 25, bytes: 100 });
  expect(updatePromptView(downloading, null, "0.7.2")).toMatchObject({ text: "Downloading version 0.7.2… 25%" });
  expect(updatePromptView(downloading, null, "0.7.2")).toMatchObject({ action: "cancel", dismissible: false });
  expect(updatePromptView(status({ status: "staged", version: "0.7.2" }), null, null)).toMatchObject({
    text: "Version 0.7.2 is ready.",
    action: "restart",
    label: "Restart to update",
  });
  expect(updatePromptView(status({ status: "ready", version: "0.7.2" }), null, null)?.action).toBe("reveal");
});

test("Not now hides a version until a newer one", () => {
  const found = status({ status: "available", version: "0.7.2", inPlace: true });
  expect(updatePromptView(found, "0.7.2", null)).toBeNull();
  expect(updatePromptView(status({ status: "staged", version: "0.7.2" }), "0.7.2", null)).toBeNull();
  expect(updatePromptView(status({ status: "available", version: "0.7.3" }), "0.7.2", null)?.text).toBe(
    "Version 0.7.3 is out.",
  );
});

test("a download started from the home screen says when it fails", () => {
  const failed = status({ status: "error", message: "The package hash doesn't match." });
  expect(updatePromptView(failed, null, "0.7.2")).toEqual({
    text: "The update didn't finish. The package hash doesn't match.",
    action: "check",
    label: "Try again",
    dismissible: true,
  });
  expect(updatePromptView(status({ status: "cancelled" }), null, "0.7.2")?.text).toBe("The update was cancelled.");
  // A quiet automatic check that failed shows nothing.
  expect(updatePromptView(failed, null, null)).toBeNull();
});
