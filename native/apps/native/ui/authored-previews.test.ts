import { test, expect } from "bun:test";
import catalog from "./authored-previews.json";
import { KNIVES } from "../../web/src/viewmodel/knives/index";
import { COSMETICS } from "../../web/src/progression";
test("embedded authored previews cover every shipped knife, finish, glove, outfit, headwear and ghost without network or placeholder geometry", () => {
  expect(catalog.version).toBe(1);
  expect(catalog.source).toBe("native original meshes/poses/cosmetic shaders");
  expect(catalog.pngBytes).toBeLessThan(4 * 1024 * 1024);
  const images = catalog.images as Record<string, string>;
  for (const knife of KNIVES) expect(images[knife.cosmeticId]).toStartWith("data:image/png;base64,");
  for (const c of COSMETICS.filter((c) => ["finish", "glove", "outfit", "hat", "body", "ghost"].includes(c.slot)))
    expect(images[c.id], c.id).toStartWith("data:image/png;base64,");
  expect(new Set(KNIVES.map((k) => images[k.cosmeticId])).size).toBe(KNIVES.length);
  for (const source of Object.values(images)) {
    const data = Buffer.from(source.split(",")[1], "base64");
    expect([...data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(data.length).toBeGreaterThan(100);
  }
});

test("character stage samples retain the doubled native capture resolution", () => {
  expect(catalog.width).toBe(1024);
  expect(catalog.height).toBe(768);
  for (const id of ["body-a", "body-b", "outfit-cream"]) {
    const png = Buffer.from((catalog.images as Record<string, string>)[id].split(",")[1], "base64");
    expect(png.readUInt32BE(16), id).toBeGreaterThan(120);
    expect(png.readUInt32BE(20), id).toBeGreaterThan(200);
  }
});
