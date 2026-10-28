import { test, expect } from "bun:test";
import { NativeCosmetics, type CosmeticApi } from "./cosmetics";
import { DEFAULT_COSMETICS } from "../../web/src/progression";
import { settingsPatch, nativeKeyCode } from "./bridge";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
test("cosmetic picks use server unlocks, serialize account saves, and reject locked IDs", async () => {
  const first = deferred<typeof DEFAULT_COSMETICS>();
  const calls: unknown[] = [];
  const api: CosmeticApi = {
    myCosmetics: async () => ({
      choice: { ...DEFAULT_COSMETICS },
      unlocked: ["knife-carrot", "fin-garden", "outfit-classic"],
    }),
    saveCosmetics: (patch) => {
      calls.push(patch);
      return first.promise;
    },
  };
  const service = new NativeCosmetics(api);
  await service.refresh();
  await service.equip("knife", "locked-unknown");
  expect(calls).toEqual([]);
  const pending = service.equip("finish", "fin-garden");
  await Promise.resolve();
  expect(calls).toEqual([{ finish: "fin-garden" }]);
  first.resolve({ ...DEFAULT_COSMETICS });
  await pending;
  expect(service.status).toBe("Saved to your account.");
});
test("old cosmetic saves cannot replace a newly signed-in account", async () => {
  const first = deferred<typeof DEFAULT_COSMETICS>();
  let account = "first";
  const api: CosmeticApi = {
    myCosmetics: async () => ({
      choice: { ...DEFAULT_COSMETICS, outfit: account === "first" ? "outfit-classic" : "outfit-snow" },
      unlocked: ["fin-garden"],
    }),
    saveCosmetics: () => first.promise,
  };
  const service = new NativeCosmetics(api);
  await service.refresh();
  const save = service.equip("finish", "fin-garden");
  await Promise.resolve();
  account = "second";
  await service.refresh();
  first.resolve({ ...DEFAULT_COSMETICS, outfit: "outfit-classic" });
  await save;
  expect(service.choice.outfit).toBe("outfit-snow");
});
test("offline cosmetics never call save endpoints and only expose free choices", async () => {
  let writes = 0;
  const service = new NativeCosmetics({
    myCosmetics: async () => {
      throw Error("offline");
    },
    saveCosmetics: async () => {
      writes++;
      return { ...DEFAULT_COSMETICS };
    },
  });
  await service.refresh();
  expect(service.online).toBe(false);
  expect(service.unlocked.size).toBeGreaterThan(0);
  await service.equip("finish", "fin-garden");
  expect(writes).toBe(0);
  expect(service.status).toBe("Saved on this device.");
});
test("native settings accept only the supported ranges, keys and four bindings", () => {
  expect(settingsPatch({ fov: NaN, volume: 2, fpsLimit: 12, sensitivity: 0, muted: "yes" })).toEqual({});
  expect(settingsPatch({ fov: 110, verticalSensitivity: 1.2, separateVertical: true, fpsLimit: 0 })).toEqual({
    fov: 110,
    verticalSensitivity: 1.2,
    separateVertical: true,
    fpsLimit: 0,
  });
  expect(
    settingsPatch({
      binds: { jump: ["Space", "MWheelUp", "MWheelDown", "KeyJ"], restart: ["F10"], duck: ["Unsupported"] },
    }),
  ).toEqual({ binds: { jump: ["Space", "MWheelUp", "MWheelDown", "KeyJ"] } });
  expect(settingsPatch({ binds: { jump: ["Space", "MWheelUp", "MWheelDown", "KeyJ", "KeyK"] } })).toEqual({
    binds: {},
  });
  expect(nativeKeyCode("Escape")).toBe(false);
  expect(nativeKeyCode("MetaLeft")).toBe(false);
  expect(nativeKeyCode("F12")).toBe(true);
});

test("shared web loadout changes cannot be overwritten by an older native cosmetics refresh", async () => {
  const original = (globalThis as { localStorage?: Storage }).localStorage,
    store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  };
  const { setOutfit } = await import("../../web/src/player/cosmetics");
  const result = deferred<{ choice: typeof DEFAULT_COSMETICS; unlocked: string[] }>();
  const service = new NativeCosmetics({
    myCosmetics: () => result.promise,
    saveCosmetics: async () => ({ ...DEFAULT_COSMETICS }),
  });
  try {
    const pending = service.refresh();
    setOutfit("outfit-midnight");
    service.observeLocal();
    result.resolve({ choice: { ...DEFAULT_COSMETICS }, unlocked: ["outfit-cream"] });
    await pending;
    expect(service.choice.outfit).toBe("outfit-midnight");
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = original;
  }
});
