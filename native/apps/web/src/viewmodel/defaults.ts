// Default viewmodel framing (viewmodel_fov + viewmodel_offset_x / _y / _z). A leaf module (no imports) so ui/settings.ts
// (DEFAULT_PREFS, the prefs migration) and viewmodel/settings.ts (the presets) can both read it whatever order the
// modules load in.

/**
 * CS:GO's "you can see your hands" framing, in this rig's units (v0.0.29; research/viewmodel-default/): a wider
 * viewmodel FOV than CS:S's 54 (CS:GO: 60 by default, 54-68) and the hands level with the view (no longer pushed down),
 * so the whole glove round the grip, the cuff and a few inches of sleeve are in view, the knife low on the right with
 * its tip where it was (~19% from the top at 16:9) and nothing over the crosshair. The hands look a little smaller
 * (the wider FOV) and the arms come further into view (offset z 0 instead of -0.9).
 */
export const VIEWMODEL_POS = { fov: 64, x: 0.5, y: 1.5, z: 0 } as const;
/**
 * Revision of the default framing (Prefs.viewmodel.rev): 1 = v0.0.5's 54 / 0 / 0 / 0 (saved without a rev), 2 = v0.0.6's
 * 54 / 0.6 / 1.5 / -0.9, 3 = VIEWMODEL_POS.
 */
export const VIEWMODEL_REV = 3;
/** v0.0.5's default framing (revision 1). */
export const VIEWMODEL_POS_V1 = { fov: 54, x: 0, y: 0, z: 0 } as const;
/**
 * v0.0.6-v0.0.28's default framing (revision 2): CS:S's FOV 54 and its knife's footprint (~6% of a 1080p screen), low on
 * the right. Still offered as the "CS:S" preset.
 */
export const VIEWMODEL_POS_V2 = { fov: 54, x: 0.6, y: 1.5, z: -0.9 } as const;
