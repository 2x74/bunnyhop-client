// Default viewmodel framing (viewmodel_fov + viewmodel_offset_x / _y / _z). A leaf module (no imports) so ui/settings.ts
// (DEFAULT_PREFS, the prefs migration) and viewmodel/settings.ts (the Classic preset) can both read it whatever order
// the modules load in.

/**
 * CS:S's FOV, the hands a little out, back and down, so the bunny's bigger paws and longer blades sit low on the right
 * and cover about what CS:S's own knife does (1920x1080: ~6% of the screen vs v_knife_t's ~7%, the carrot's tip at 18%
 * from the top vs 13%; v0.0.5's 54 / 0 / 0 / 0 covered ~8.5% with the tip at 8%).
 */
export const VIEWMODEL_POS = { fov: 54, x: 0.6, y: 1.5, z: -0.9 } as const;
/** Revision of the default framing (Prefs.viewmodel.rev); framings before v0.0.6 (54 / 0 / 0 / 0) were revision 1. */
export const VIEWMODEL_REV = 2;
/** v0.0.5's default framing (revision 1). */
export const VIEWMODEL_POS_V1 = { fov: 54, x: 0, y: 0, z: 0 } as const;
