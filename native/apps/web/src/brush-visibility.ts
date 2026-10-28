// Source trigger brushes are invisible even when authors give them custom materials.
// Their collision/touch volumes remain available to the separate Show Triggers overlay.
export function hiddenTriggerModels(entities: readonly Record<string, string>[]): Set<number> {
  const models = new Set<number>();
  for (const entity of entities) {
    if (!entity.classname?.toLowerCase().startsWith("trigger_")) continue;
    const model = /^\*([1-9]\d*)$/.exec(entity.model ?? "");
    if (model) models.add(Number(model[1]));
  }
  return models;
}
