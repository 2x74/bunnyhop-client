import { test, expect } from "bun:test";
import { dragPosition } from "./hud-editor";

test("HUD dragging scales deltas to viewport percent, clamps and preserves visibility/scale", () => {
  const at = { x: 50, y: 20, visible: false, scale: 1.5 };
  expect(dragPosition(at, 100, 50, 1000, 500)).toEqual({ x: 60, y: 30, visible: false, scale: 1.5 });
  expect(dragPosition(at, -10000, 10000, 1000, 500)).toEqual({ x: 0, y: 100, visible: false, scale: 1.5 });
  expect(dragPosition(at, 1, 1, 0, 0)).toEqual({ x: 100, y: 100, visible: false, scale: 1.5 });
  expect(at.x).toBe(50);
});
