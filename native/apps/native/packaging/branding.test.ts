import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_NAME,
  APP_ID,
  MAC_APP,
  ICON_HASHES,
  ICON_SOURCE,
  LINUX_DESKTOP,
  packageBranding,
  verifyIcon,
  verifyPackageBranding,
} from "./branding";
import { treeHash } from "../package";

test("standalone native subtree contains the pinned official PNG, ICO and ICNS", () => {
  for (const name of Object.keys(ICON_HASHES) as (keyof typeof ICON_HASHES)[])
    verifyIcon(join(ICON_SOURCE, name), name);
  const png = readFileSync(join(ICON_SOURCE, "icon-512.png"));
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
  const ico = readFileSync(join(ICON_SOURCE, "icon.ico"));
  expect(ico.readUInt16LE(2)).toBe(1);
  const sizes = [];
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const entry = 6 + i * 16,
      offset = ico.readUInt32LE(entry + 12),
      length = ico.readUInt32LE(entry + 8);
    expect(offset + length).toBeLessThanOrEqual(ico.length);
    const image = ico.subarray(offset, offset + length),
      width = ico[entry] || 256,
      height = ico[entry + 1] || 256;
    expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([width, height]);
    sizes.push(width);
  }
  expect(sizes).toEqual([16, 32, 48, 64, 128, 256]);
  const icns = readFileSync(join(ICON_SOURCE, "icon.icns"));
  expect(icns.toString("ascii", 0, 4)).toBe("icns");
  expect(icns.readUInt32BE(4)).toBe(icns.length);
  expect(MAC_APP).toBe("bunnyhop.lol - Native.app");
  expect(APP_NAME).toBe("bunnyhop.lol - Native");
});

for (const platform of ["darwin", "win32", "linux"]) {
  test(`${platform} packaging preserves official icons, hashes them as assets and rejects replacement or omission`, () => {
    const dir = mkdtempSync(join(tmpdir(), "bunnyhop-branding-")),
      resources = join(dir, "resources");
    mkdirSync(resources);
    try {
      packageBranding(resources, dir, platform);
      verifyPackageBranding(resources, dir, platform);
      const assets = join(resources, "native-assets"),
        valid = treeHash(assets);
      for (const name of Object.keys(ICON_HASHES) as (keyof typeof ICON_HASHES)[]) {
        const file = join(assets, "branding", name),
          original = readFileSync(file);
        writeFileSync(file, "replacement");
        expect(treeHash(assets)).not.toBe(valid);
        expect(() => verifyPackageBranding(resources, dir, platform)).toThrow("Official app icon mismatch");
        writeFileSync(file, original);
        rmSync(file);
        expect(() => verifyPackageBranding(resources, dir, platform)).toThrow();
        writeFileSync(file, original);
      }
      if (platform === "darwin") {
        const file = join(resources, "icon.icns");
        writeFileSync(file, "replacement");
        expect(() => verifyPackageBranding(resources, dir, platform)).toThrow("Official app icon mismatch");
      } else if (platform === "linux") {
        const desktop = join(dir, `share/applications/${APP_ID}.desktop`);
        expect(readFileSync(desktop, "utf8")).toBe(LINUX_DESKTOP);
        expect(LINUX_DESKTOP).toContain(`Name=${APP_NAME}\n`);
        expect(LINUX_DESKTOP).toContain(`Icon=${APP_ID}\n`);
        expect(LINUX_DESKTOP).toContain(`StartupWMClass=${APP_ID}\n`);
        writeFileSync(desktop, LINUX_DESKTOP.replace(APP_NAME, "Bunnyhop"));
        expect(() => verifyPackageBranding(resources, dir, platform)).toThrow("Linux desktop app identity mismatch");
        writeFileSync(desktop, LINUX_DESKTOP);
        writeFileSync(join(dir, `share/icons/hicolor/512x512/apps/${APP_ID}.png`), "replacement");
        expect(() => verifyPackageBranding(resources, dir, platform)).toThrow("Official app icon mismatch");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
