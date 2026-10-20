/** Outfit-driven character models; unknown outfits retain the standard bunny. */
export const TEK_OUTFIT = "outfit-tek";
export type BunnyLook = "bunny" | "tek" | "plush" | "bune";
export const lookOf = (outfit: string | null | undefined): BunnyLook =>
  outfit === TEK_OUTFIT ? "tek" : outfit === "outfit-plush" ? "plush" : outfit === "outfit-bune" ? "bune" : "bunny";
/** These characters have one authored shape, independent of the saved A/B preference. */
export const fixedModel = (outfit: string | null | undefined): boolean => lookOf(outfit) !== "bunny";
