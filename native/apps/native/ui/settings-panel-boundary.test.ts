import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import { nativeMenuBoundary } from "../menu-boundary";

// The native menu is meant to reuse the web settings panel. It must bundle under the menu's boundary: no Three, no
// game entry, no input handling or web HUD, only the native stand-ins for them.
const root = resolve(import.meta.dir, "../../..");
const assetLoaders = {
  ".svg": "dataurl" as Bun.Loader,
  ".png": "dataurl" as Bun.Loader,
  ".webp": "dataurl" as Bun.Loader,
  ".woff2": "dataurl" as Bun.Loader,
};

test("the web settings panel bundles inside the native menu boundary", async () => {
  const modules = new Set<string>();
  const result = await Bun.build({
    entrypoints: [resolve(root, "apps/web/src/ui/settings-panel.ts")],
    target: "browser",
    throw: false,
    loader: assetLoaders,
    plugins: [await nativeMenuBoundary(modules)],
  });
  expect(result.logs.map(String)).toEqual([]);
  expect(result.success).toBe(true);
  const loaded = [...modules].map((path) => relative(root, path).replaceAll("\\", "/"));
  expect(loaded).toContain("apps/native/ui/input-bits.ts");
  expect(loaded).toContain("apps/native/ui/crosshair.ts");
  for (const gameModule of ["input", "hud", "main", "session", "render", "core"]) {
    expect(loaded).not.toContain(`apps/web/src/${gameModule}.ts`);
  }
  expect(loaded.some((path) => path.includes("node_modules/three/"))).toBe(false);
}, 60_000);
