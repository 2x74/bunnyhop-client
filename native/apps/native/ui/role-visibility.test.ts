import { expect, test } from "bun:test";
import { COSMETICS, isUnlocked, listedFor, staffItem, cosmeticsProblem } from "../../web/src/progression";
import { loadoutFor, packLoadout, unpackLoadout } from "../../web/src/loadout";
import { LOADOUT_CATEGORIES } from "../../web/src/ui/cosmetic-slots";

test("staff items are unknown to non-holders; Contributor items remain visible goals", () => {
  const staff = COSMETICS.filter(staffItem);
  expect(staff.length).toBeGreaterThan(0);
  for (const item of staff) {
    expect(listedFor(item, null), item.id).toBe(false);
    expect(cosmeticsProblem({ [item.slot]: item.id }, 100, [], undefined, null)).toEqual({
      slot: item.slot,
      reason: "unknown item",
    });
  }
  const contributor = COSMETICS.filter((c) => c.unlock.kind === "role" && c.unlock.role === "contributor");
  expect(contributor.some((c) => c.id === "fin-ruler")).toBe(true);
  expect(contributor.some((c) => c.id === "hat-pencil")).toBe(true);
  expect(contributor.some((c) => c.id.includes("draftsman"))).toBe(true);
  for (const item of contributor) {
    expect(listedFor(item, null), item.id).toBe(true);
    expect(isUnlocked(item, 100, [], undefined, null), item.id).toBe(false);
  }
});

test("recorded and remote staff loadouts render for observers, with no holder filter in their wire decode", () => {
  const choice = {
    knife: "knife-leek",
    finish: "fin-founder",
    glove: "glove-founder",
    hilt: "hilt-founder",
    camo: "camo-founder",
  };
  const packed = packLoadout(loadoutFor(choice, null));
  expect(unpackLoadout(packed)?.hilt).toBe(choice.hilt);
  expect(unpackLoadout(packed)?.camo).toBe(choice.camo);
  expect(unpackLoadout(packed)?.finish).toBe(choice.finish);
  expect(LOADOUT_CATEGORIES.map((c) => c.label)).toEqual([
    "Knife",
    "Finish",
    "Hilt",
    "Gloves",
    "Gun camo",
    "Colourway",
    "Hat",
    "Ghost",
    "Trail",
    "Trail shape",
  ]);
});
