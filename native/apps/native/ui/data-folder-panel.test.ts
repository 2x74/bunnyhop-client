import { expect, test } from "bun:test";
import { readDataFolderStatus } from "./data-folder-panel";

const base = {
  path: "D:\\Bunnyhop Data",
  defaultPath: "C:\\Users\\a\\AppData\\Roaming\\bunnyhop.lol\\Bunnyhop Native",
  isDefault: false,
  configured: "D:\\Bunnyhop Data",
  unavailable: false,
  pending: null,
  picking: false,
  notice: "",
  choice: null,
};

test("data folder: reads the host's status", () => {
  expect(readDataFolderStatus(base)).toEqual(base);
  expect(
    readDataFolderStatus({ ...base, pending: "E:\\Games", choice: { path: "E:\\Games", problem: "" } })?.choice,
  ).toEqual({ path: "E:\\Games", problem: "" });
  expect(readDataFolderStatus({ ...base, unavailable: true })?.unavailable).toBe(true);
});

test("data folder: rejects malformed status", () => {
  expect(readDataFolderStatus(null)).toBeNull();
  expect(readDataFolderStatus({ ...base, path: 1 })).toBeNull();
  expect(readDataFolderStatus({ ...base, isDefault: "no" })).toBeNull();
  // A malformed choice is dropped rather than shown.
  expect(readDataFolderStatus({ ...base, choice: { path: 3 } })?.choice).toBeNull();
  // Oversized strings are clipped.
  expect(readDataFolderStatus({ ...base, notice: "x".repeat(5000) })?.notice.length).toBe(1000);
});
