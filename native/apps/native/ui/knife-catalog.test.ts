import { test, expect } from "bun:test";
import { KNIFE_IDS, knifeById } from "./knife-catalog";
test("menu knife catalog matches shipped registry without importing render builders", async () => {
  const source = await Bun.file(new URL("../../web/src/viewmodel/knives/index.ts", import.meta.url)).text();
  const registry = /export const KNIVES[^=]*=\s*\[([^\]]+)\]/.exec(source);
  expect(registry).not.toBeNull();
  const modules = new Map([...source.matchAll(/import \{ (\w+) \} from "\.\/(\w+)";/g)].map((m) => [m[1], m[2]]));
  const ids: string[] = [];
  for (const name of registry![1].split(",").map((id) => id.trim())) {
    const module = modules.get(name);
    expect(module, name).toBeDefined();
    const definition = await Bun.file(new URL(`../../web/src/viewmodel/knives/${module}.ts`, import.meta.url)).text();
    const id = /\bid: "([^"]+)"/.exec(definition)?.[1];
    expect(id, module).toBeDefined();
    ids.push(id!);
  }
  expect([...KNIFE_IDS] as string[]).toEqual(ids);
  expect(knifeById("knife-carrot")).toEqual({ id: "carrot", cosmeticId: "knife-carrot" });
  expect(knifeById("knife-unshipped")).toBeUndefined();
});
