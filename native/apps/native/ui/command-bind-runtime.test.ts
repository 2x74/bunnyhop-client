import { expect, test } from "bun:test";
import { commandBindPlan } from "./command-bind-runtime";

test("wait expands into native command boundaries, preserving empty stages and key ownership", () => {
  const result = commandBindPlan("KeyF", true, "+jump; wait; wait; -jump; +duck; wait; -duck", {});
  expect(result.ops.map((op) => [op.kind, op.action, op.step, op.own])).toEqual([
    ["hold", "jump", 0, true],
    ["unhold", "jump", 2, true],
    ["hold", "duck", 2, true],
    ["unhold", "duck", 3, true],
  ]);
});
test("alias releases carry Source ownership and once commands keep their scheduled stage", () => {
  const aliases = { "+hop": "+jump; +duck", "-hop": "-jump; wait; -duck; say gg" };
  const result = commandBindPlan("KeyF", false, "+hop", aliases);
  expect(result.ops.map((op) => [op.kind, op.action ?? op.command, op.step, op.own])).toEqual([
    ["unhold", "jump", 0, false],
    ["unhold", "duck", 1, false],
    ["once", "say gg", 1, undefined],
  ]);
});
test("a nested move plus turn plan contains no executable operations", () => {
  expect(commandBindPlan("KeyG", true, "a", { a: "+forward; b", b: "+left" })).toEqual({
    ops: [],
    error: "Moving and turning on one key isn't allowed.",
  });
});
