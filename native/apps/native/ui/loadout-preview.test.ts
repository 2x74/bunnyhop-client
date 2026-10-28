import { test, expect } from "bun:test";
import { requestPreview, cancelPreview, nativePreviewAvailable, type PreviewRequest } from "./loadout-preview";
const request: PreviewRequest = {
  loadout: "2;knife-carrot;fin-sunset;glove-knit",
  outfit: "outfit-cream",
  ghost: "ghost-gold",
  playerGlow: null,
  view: "close",
  yaw: 20,
  pitch: 5,
  inspect: 1,
  held: true,
  width: 768,
  height: 480,
};
test("preview transport sends the combined look and ignores canceled/stale host frames", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const sent: Record<string, unknown>[] = [];
  const fake = {
    webkit: { messageHandlers: { bunnyhop: { postMessage: (raw: string) => sent.push(JSON.parse(raw)) } } },
    bunnyhopNativeLoadoutPreview: undefined as undefined | ((frame: { id: number; png: string }) => void),
  };
  Object.defineProperty(globalThis, "window", { value: fake, configurable: true });
  try {
    expect(nativePreviewAvailable()).toBe(true);
    const frames: string[] = [];
    const first = requestPreview(request, (png) => frames.push(png));
    const second = requestPreview({ ...request, yaw: 40 }, (png) => frames.push(png));
    expect(sent[0]).toEqual({ type: "loadoutPreview", id: first, ...request });
    cancelPreview(first);
    fake.bunnyhopNativeLoadoutPreview!({ id: first, png: "data:image/png;base64,old" });
    expect(frames).toEqual([]);
    fake.bunnyhopNativeLoadoutPreview!({ id: second, png: "data:image/png;base64,new" });
    fake.bunnyhopNativeLoadoutPreview!({ id: second, png: "data:image/png;base64,duplicate" });
    expect(frames).toEqual(["data:image/png;base64,new"]);
    const invalid = requestPreview(request, (png) => frames.push(png));
    fake.bunnyhopNativeLoadoutPreview!({ id: invalid, png: "https://example.com/image.png" });
    expect(frames.at(-1)).toBe("");
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete (globalThis as { window?: unknown }).window;
  }
});
