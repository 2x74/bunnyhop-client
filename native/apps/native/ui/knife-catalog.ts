// Menu metadata for exactly the shipped web knife registry. Geometry belongs to
// C++ rendering; importing authored builders would pull Three into the WebView.
export const KNIFE_IDS = [
  "carrot",
  "bayonet",
  "parsnip",
  "karrotbit",
  "radish",
  "cleaver",
  "bunnyfly",
  "daikon",
  "candycane",
  "golden",
  "whirligig",
  "thornback",
  "thistle",
  "leek",
  "sprouts",
] as const;
export function knifeById(value: string): { id: string; cosmeticId: string } | undefined {
  const id = value.replace(/^knife-/, "");
  return (KNIFE_IDS as readonly string[]).includes(id) ? { id, cosmeticId: `knife-${id}` } : undefined;
}
