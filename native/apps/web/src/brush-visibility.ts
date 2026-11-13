// Source trigger brushes are invisible even when authors give them custom materials.
// Their collision/touch volumes remain available to the separate Show Triggers overlay.
/**
 * Brush classes CS:S never draws as brushes (SDK 2013): the dust volumes draw motes instead (C_Func_Dust::ShouldDraw is
 * false), func_precipitation spawns in the "environmental" render mode (drawn as rain only), and the physics clips
 * spawn with EF_NODRAW. None of them is solid to a player.
 */
const UNDRAWN_CLASSES = new Set(["func_dustmotes", "func_dustcloud", "func_precipitation", "func_clip_vphysics", "func_vehicleclip"]);

export function undrawnClassModels(entities: readonly Record<string, string>[]): Set<number> {
  const models = new Set<number>();
  for (const entity of entities) {
    if (!UNDRAWN_CLASSES.has(entity.classname?.toLowerCase() ?? "")) continue;
    const model = /^\*([1-9]\d*)$/.exec(entity.model ?? "");
    if (model) models.add(Number(model[1]));
  }
  return models;
}

export function hiddenTriggerModels(entities: readonly Record<string, string>[]): Set<number> {
  const models = new Set<number>();
  for (const entity of entities) {
    if (!entity.classname?.toLowerCase().startsWith("trigger_")) continue;
    const model = /^\*([1-9]\d*)$/.exec(entity.model ?? "");
    if (model) models.add(Number(model[1]));
  }
  return models;
}
