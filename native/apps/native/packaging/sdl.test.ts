import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSdlPin, sdlRevision, verifyBundledSdl } from "./sdl";

const pin = readSdlPin();
const pinned = sdlRevision(pin);
// What a build at the right commit without the explicit revision embeds, and a different SDL.
const described = `SDL-3.4.19-release-3.4.18-67-g${pin.commit.slice(0, 9)}`;
const other = "SDL-3.4.18-release-3.4.18";

const layouts = [
  { platform: "darwin", dir: "Contents/Frameworks", name: "libSDL3.0.dylib" },
  { platform: "linux", dir: "lib", name: "libSDL3.so.0" },
  { platform: "win32", dir: ".", name: "SDL3.dll" },
];

function stage(layout: (typeof layouts)[number], revision: string): string {
  const root = mkdtempSync(join(tmpdir(), "sdl-pin-"));
  mkdirSync(join(root, layout.dir), { recursive: true });
  writeFileSync(join(root, layout.dir, layout.name), `\0\0binary\0${revision}\0more\0`);
  return root;
}

for (const layout of layouts) {
  test(`${layout.platform}: accepts SDL built from the pinned commit, rejects any other`, () => {
    const good = stage(layout, pinned);
    const bad = [stage(layout, other), stage(layout, described)];
    try {
      expect(verifyBundledSdl(good, layout.platform)).toBe(pinned);
      for (const dir of bad) expect(() => verifyBundledSdl(dir, layout.platform)).toThrow("expected SDL-");
    } finally {
      for (const dir of [good, ...bad]) rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a package without SDL is rejected", () => {
  const empty = mkdtempSync(join(tmpdir(), "sdl-pin-"));
  try {
    expect(() => verifyBundledSdl(empty, "linux")).toThrow("No bundled SDL3 library");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
