import { test, expect } from "bun:test";
import { StageFrames } from "./stage-frames";
test("stage pictures are kept by request, the least recently shown going first", () => {
  const frames = new StageFrames(2);
  frames.keep("sunset", "data:image/png;base64,a");
  frames.keep("ember", "data:image/png;base64,b");
  expect(frames.get("sunset")).toBe("data:image/png;base64,a");
  frames.keep("frost", "data:image/png;base64,c");
  expect(frames.get("ember")).toBeUndefined();
  expect(frames.get("sunset")).toBe("data:image/png;base64,a");
  expect(frames.get("frost")).toBe("data:image/png;base64,c");
});
