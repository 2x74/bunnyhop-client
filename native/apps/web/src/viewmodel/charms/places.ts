// Where a charm is tied on each knife (v0.0.43), picked per knife by looking (the owner, 11-17: tie it to the knife's
// own hardware as that knife allows; one place where only one looks right). A leaf module: the Loadout reads which
// places a knife offers without the meshes; anchors.ts turns a tie into the cord's wrap on the real mesh.

/**
 * A tie: what the cord is wrapped round.
 *   how     "neck": across the knife's length at a height (a collar, a round guard's rim, a handle's end, a butt);
 *           "arm": across a part that sticks out, a little in from its tip (a quillon, a tsuba's edge, a ring's rim)
 *   role    which tagged part of the knife (knives/types.ts HiltRole code: 1 grip, 2 guard, 3 pommel; default the guard)
 *   z       neck: the height (knife-local z); default: the part's widest toward the charm's side
 *   along   arm: the direction the part sticks out along: "side" (screen-left at rest, default), "up", "out" (left and down)
 *   inset   arm: how far in from the tip the wrap sits (default 0.16)
 *   drop    how far below level the knot faces (0 = straight out to the side, 1 = 45 degrees down; default 0.35)
 *   turn    the knot's side turned toward the eye (degrees round the knife's length; 0 = screen-left)
 *   max     the longest wrap taken (units round; default 9): a slab that cuts more than one part is not a tie
 *   bone    the bone the tied part rides on (default: the one most of the part is on)
 */
export interface TieSpec {
  how: "neck" | "arm";
  role?: 1 | 2 | 3;
  z?: number;
  along?: "side" | "up" | "out";
  inset?: number;
  drop?: number;
  turn?: number;
  max?: number;
  bone?: string;
}

/**
 * Per knife: the guard's tie, the pommel's (default: round the butt), and which of the two the knife offers. Measured
 * on the real meshes with every charm (test/charms-fit.test.ts; the QA report's table): a place is offered where a
 * charm tied there rests without entering the hand, the knife or the hilt.
 */
const TIES: Readonly<Record<string, { guard: TieSpec; pommel?: TieSpec; guardOff?: true; pommelOff?: true }>> = {
  // Held in reverse: its ring end is up in the fist and its blade leaves the hand below it, in view. The cord is tied
  // round the collar at the blade's root, the knot on the side away from the claw's curve: the charm hangs free under
  // the hand, beside the blade, never across it. (Tied to the finger ring it lay on the fist: every charm leaned 53 to
  // 82 degrees there.) Its other end is that ring: no second place.
  karrotbit: { guard: { how: "neck", role: 2, turn: 160 }, pommelOff: true },
  // The owner's reference: tied round the bite handle's end by the pivot, the charm beside the handles above the fist.
  bunnyfly: { guard: { how: "neck", z: 2.3, bone: "Bfly_Bite", max: 3 } },
  // A quillon, a tsuba's edge, a leaf of the guard: tied round the part that sticks out.
  parsnip: { guard: { how: "arm" } },
  daikon: { guard: { how: "arm", inset: 0.2 }, pommelOff: true },
  leek: { guard: { how: "arm" } },
  thistle: { guard: { how: "arm" } },
  // A leaf tuft under the butt: a charm there hangs in the leaves.
  carrot: { guard: { how: "neck" }, pommelOff: true },
  golden: { guard: { how: "neck" }, pommelOff: true },
  cleaver: { guard: { how: "neck" }, pommelOff: true },
  // A collar too narrow to hang anything clear of the index finger: the cord cut across the finger at the guard
  // (every charm leaned over 50 degrees). The butt is the place.
  radish: { guard: { how: "neck" }, guardOff: true },
  whirligig: { guard: { how: "neck" }, guardOff: true },
};
const DEFAULT_TIE: TieSpec = { how: "neck" };

const idOf = (knifeId: string | null | undefined): string => (knifeId ?? "carrot").replace(/^knife-/, "");

/** Dev (the charm lab's ?tie=): fields laid over every knife's guard tie. */
export const tieOverride: { guard: Partial<TieSpec> | null } = { guard: null };

/** A knife's ties (anchors.ts). */
export function tieOf(knifeId: string | null | undefined): { guard: TieSpec; pommel?: TieSpec } {
  const t = TIES[idOf(knifeId)];
  return { guard: { ...(t?.guard ?? DEFAULT_TIE), ...(tieOverride.guard ?? {}) }, pommel: t?.pommel };
}

/** The places a knife offers (the Loadout's "Hangs from" row shows only with both; with one, the rig hangs it there). */
export function charmPlaces(knifeId: string | null | undefined): { guard: boolean; pommel: boolean } {
  const t = TIES[idOf(knifeId)];
  return { guard: !t?.guardOff, pommel: !t?.pommelOff };
}
