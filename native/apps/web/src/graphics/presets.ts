import type { LightingProfileId } from "./profiles";
/**
 * Shared gameplay, viewer and offline-export appearance. Potato always bypasses effects.
 * - source: how CS:S draws the map (water reflections; auto exposure and bloom on maps with HDR lighting). Default.
 * - classic: the plain direct render, fastest.
 * - enhanced / cinematic: the post-processing composer (graphics/pipeline.ts).
 */
export const GRAPHICS_PRESETS = ["source", "classic", "enhanced", "cinematic"] as const;
export type GraphicsPreset = typeof GRAPHICS_PRESETS[number];
export interface GraphicsOptions { preset: GraphicsPreset; potato: boolean; waterReflections?: boolean; contactShading?: boolean; atmosphere?: boolean; sunShafts?: boolean; depthOfField?: boolean; focusDistance?: number; bloom?: boolean; mapProfiles?: boolean; ambienceShowcase?: boolean; lightingProfile?: LightingProfileId; skyMode?: "map" | "procedural" | "pack"; skyPackId?: string | null; skyRotation?: number; skyExposure?: number; lightingSource?: "map" | "pack"; directContribution?: number; ambientContribution?: number; clouds?: boolean; cloudQuality?: "low" | "medium" | "high"; cloudCoverage?: number; cloudDensity?: number; materialResponse?: boolean; volumetric?: boolean; spatialAA?: boolean; temporalSamples?: 1 | 2 | 4 | 8; localLights?: boolean; localQuality?: "low" | "medium" | "high"; localBudget?: number; localStrength?: number; dynamicGI?: boolean; tracedGI?: boolean; giQuality?: "low" | "medium"; giStrength?: number; giRange?: number; dynamicShadows?: boolean; shadowQuality?: "low" | "medium" | "high"; shadowDistance?: number; shadowStrength?: number }
export function graphicsPreset(value: unknown): GraphicsPreset {
  return GRAPHICS_PRESETS.includes(value as GraphicsPreset) ? value as GraphicsPreset : "source";
}
export function presetConfig(options: GraphicsOptions) {
  const preset = options.potato ? "classic" : graphicsPreset(options.preset);
  return {
    preset, postprocessing: preset === "enhanced" || preset === "cinematic",
    bloom: preset === "cinematic" ? 0.16 : 0.08,
    saturation: preset === "cinematic" ? 1.035 : 1.015,
    // Lightmaps carry Source's own contrast now (lightmap.rs); the grade only nudges Cinematic.
    contrast: preset === "cinematic" ? 1.01 : 1,
    reflectionScale: preset === "cinematic" ? 0.75 : 0.5,
    refractionScale: preset === "cinematic" ? 0.75 : 0.5,
    maxReflectionPlanes: preset === "cinematic" ? 2 : 1,
  };
}
export function exportRenderSize(width: number, height: number, supersample: number, maxTextureSize: number) {
  const scale = Math.max(1, Math.min(supersample === 2 ? 2 : 1, maxTextureSize / width, maxTextureSize / height));
  return { width: Math.floor(width * scale), height: Math.floor(height * scale), scale };
}
/** Picking a sky pack or clouds needs the composer: the plain looks switch to Enhanced. */
export function composerPreset(preset: GraphicsPreset): GraphicsPreset {
  return preset === "source" || preset === "classic" ? "enhanced" : preset;
}
