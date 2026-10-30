import { test, expect } from "bun:test";
import { COSMETICS, cosmeticsProblem, isUnlocked } from "../../web/src/progression";
import {
  AVATAR_PX,
  BACKDROPS,
  avatarCosmetics,
  cleanAvatar,
  defaultAvatar,
  defaultBg,
  GUN_IDS,
} from "../../web/src/avatar/spec";
import { GUNS } from "../../web/src/viewmodel/guns/index";
import { choicesOf, GUN_NAMES, hairOptions, options, ownedOnly, pickPatch, type Slot } from "./avatar-choices";
import { backdropOf, closeAvatarRenderer, renderAvatar, renderSpec, type AvatarHostMessage } from "./avatar-host";

const HEX = /^#[0-9a-f]{6}$/;
const SLOTS: Slot[] = ["outfit", "hat", "knife", "finish", "glove"];

test("every choice the editor offers passes the server's cosmetics check for that account", () => {
  for (const [level, achievements] of [
    [1, []],
    [12, []],
    [40, ["supporter"]],
  ] as const) {
    const unlocked = new Set(COSMETICS.filter((c) => isUnlocked(c, level, achievements)).map((c) => c.id));
    const o = options(unlocked);
    for (const slot of SLOTS)
      for (const choice of choicesOf(slot, o)) {
        const base = defaultAvatar("player-1", null);
        const spec = cleanAvatar({ ...base, ...pickPatch(base, slot, choice.id) });
        expect(cleanAvatar(spec)).toEqual(spec);
        expect(cosmeticsProblem(avatarCosmetics(spec), level, [...achievements])).toBeNull();
      }
  }
});

test("without an account the choices are the free items, and a saved spec loses what isn't owned", () => {
  const free = new Set<string>();
  const outfits = choicesOf("outfit", options(free)).map((c) => c.id);
  expect(outfits).toEqual(COSMETICS.filter((c) => c.slot === "outfit" && c.unlock.kind === "free").map((c) => c.id));
  const locked = COSMETICS.find((c) => c.slot === "outfit" && c.unlock.kind !== "free")!;
  const lockedHat = COSMETICS.find((c) => c.slot === "hat" && c.unlock.kind !== "free")!;
  const spec = ownedOnly(
    cleanAvatar({ ...defaultAvatar("p", locked.id), hat: lockedHat.id, bg: defaultBg(locked.id) }),
    free,
  );
  expect(spec.outfit).toBe(defaultAvatar("", null).outfit);
  expect(spec.hat).toBeNull();
  expect(spec.bg).toBe(defaultBg(spec.outfit));
});

test("gun names match the game's guns", () => {
  expect(GUN_IDS.map((id) => GUN_NAMES[id])).toEqual(GUN_IDS.map((id) => GUNS.find((g) => g.id === id)!.name));
});

test("backdrops reach the host as colours it reads", () => {
  for (const b of BACKDROPS)
    expect(backdropOf(b.id)).toEqual({ kind: "studio", top: b.top, bottom: b.bottom, glow: null });
  for (const c of COSMETICS.filter((c) => c.slot === "outfit")) {
    const backdrop = backdropOf(defaultBg(c.id));
    expect(backdrop.kind === "studio" && HEX.test(backdrop.glow ?? "")).toBe(true);
  }
  expect(backdropOf("clear")).toEqual({ kind: "clear" });
  expect(backdropOf("#A1B2C3")).toEqual({ kind: "solid", top: "#a1b2c3" });
  expect(backdropOf("map:bhop_eazy")).toEqual({ kind: "solid", top: "#1c1c22" });
});

test("the host gets the spec in its ranges with the look packed like the game's loadout", () => {
  const spec = cleanAvatar({ ...defaultAvatar("p", null), hat: "hat-halo", body: "body-b", zoom: 9, turn: -999 });
  const sent = renderSpec(spec);
  expect(sent.loadout).toBe("2;knife-carrot;fin-garden;glove-knit;;hat-halo;body-b");
  expect(sent.zoom).toBe(1.6);
  expect(sent.turn).toBe(-180);
  // Wig hair arrives with the v0.0.29 web code; until then the editor has no hair controls.
  const hair = hairOptions();
  if (hair) expect(hair.presets.every((p) => HEX.test(p.hex))).toBe(true);
});

test("pictures go to the host as typed messages and come back by id", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const sent: AvatarHostMessage[] = [];
  const fake: { webkit: unknown; dispatchEvent: () => boolean; bunnyhopNativeAvatar?: (reply: unknown) => void } = {
    webkit: { messageHandlers: { bunnyhop: { postMessage: (raw: string) => sent.push(JSON.parse(raw)) } } },
    dispatchEvent: () => true,
  };
  Object.defineProperty(globalThis, "window", { value: fake, configurable: true });
  try {
    const spec = renderSpec(defaultAvatar("p", null));
    const saved = renderAvatar({ output: "webp", size: AVATAR_PX, spec, backdrop: { kind: "clear" } });
    const preview = renderAvatar({ output: "preview", size: 512, live: true, spec, backdrop: { kind: "clear" } });
    expect(sent[0]).toEqual({
      type: "avatarRender",
      id: expect.any(Number),
      output: "webp",
      size: 256,
      spec,
      backdrop: { kind: "clear" },
    });
    const [first, second] = sent as { id: number }[];
    fake.bunnyhopNativeAvatar?.({ id: first.id, webp: "UklGRg==" });
    fake.bunnyhopNativeAvatar?.({ id: 999, png: "data:image/png;base64,AA" });
    expect(await saved).toEqual({ webp: "UklGRg==" });
    closeAvatarRenderer();
    expect(await preview).toEqual({ error: "closed" });
    expect(sent.at(-1)).toEqual({ type: "avatarClose" });
    expect(second.id).toBeGreaterThan(first.id);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete (globalThis as { window?: unknown }).window;
  }
});
