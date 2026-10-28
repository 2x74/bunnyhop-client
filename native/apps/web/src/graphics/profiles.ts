/** Versioned appearance controls over Source's baked lighting; all stronger profiles are explicit opt-ins. */
export const LIGHTING_PROFILES = ["map", "auto", "balanced", "daylight", "indoor", "ambience"] as const;
export type LightingProfileId = typeof LIGHTING_PROFILES[number];
export interface VisualProfile { id: string; bloomScale: number; hazeDistance: number; sunDirect?: number; skyFill?: number; bakedScale?: number; exposure?: number; highlightShoulder?: number; saturation?: number; contrast?: number; haze?: number; scatteringDensity?: number; scatteringStrength?: number }
const DEFAULT_PROFILE: VisualProfile = { id: "source-default-v1", bloomScale: 1, hazeDistance: 9000 };
const AMBIENCE_SHOWCASE: VisualProfile = { id: "ambience-showcase-v1", bloomScale: 1.8, hazeDistance: 4800, sunDirect: 1.1, skyFill: .16, bakedScale: .62, exposure: 1.0, highlightShoulder: 1, saturation: 1.045, contrast: 1.02, haze: .10, scatteringDensity: 1/16000, scatteringStrength: .8 };
const GENERIC: Record<string, VisualProfile> = {
  balanced: { id: "balanced-lighting-v2", bloomScale: 1, hazeDistance: 7000, sunDirect: .35, skyFill: .07, bakedScale: .88, exposure: 1, highlightShoulder: .45, saturation: 1.01, contrast: 1, haze: .045, scatteringDensity: 1/24000, scatteringStrength: .65 },
  daylight: { id: "cinematic-daylight-v2", bloomScale: 1.4, hazeDistance: 6000, sunDirect: .7, skyFill: .12, bakedScale: .75, exposure: 1, highlightShoulder: 1, saturation: 1.025, contrast: 1.01, haze: .065, scatteringDensity: 1/18000, scatteringStrength: .8 },
  indoor: { id: "indoor-night-v2", bloomScale: .7, hazeDistance: 10000, sunDirect: 0, skyFill: .035, bakedScale: 1, exposure: 1, highlightShoulder: .2, saturation: 1, contrast: 1, haze: .02, scatteringDensity: 1/40000, scatteringStrength: .3 },
};
const PROFILES: Record<string, VisualProfile> = {
  bhop_arcane_v1: { id: "arcane-v1", bloomScale: .85, hazeDistance: 12000 },
  bhop_arcane_v2: { id: "arcane-v2", bloomScale: .85, hazeDistance: 12000 },
  bhop_arcane: { id: "arcane-v1", bloomScale: .85, hazeDistance: 12000 },
};
export function lightingProfile(value: unknown): LightingProfileId { return LIGHTING_PROFILES.includes(value as LightingProfileId) ? value as LightingProfileId : "map"; }
export function visualProfile(map: string, hash = "", enabled = false, showcase = false): VisualProfile {
  if (enabled && showcase && (hash === "f21bafcf44f184067d6fb690d4fbba102e28dc87490bf2d363473c4cbbb96260" || (!hash && map.toLowerCase().replace(/\.bsp$/, "") === "bhop_ambience"))) return { ...AMBIENCE_SHOWCASE };
  if (!enabled) return { ...DEFAULT_PROFILE };
  return { ...(PROFILES[hash] ?? PROFILES[map.toLowerCase().replace(/\.bsp$/, "")] ?? DEFAULT_PROFILE) };
}
export function resolveVisualProfile(map: string, hash: string, options: { lightingProfile?: LightingProfileId; mapProfiles?: boolean; ambienceShowcase?: boolean }, hasSun = false): VisualProfile {
  let selected = lightingProfile(options.lightingProfile);
  if (selected === "map" && options.ambienceShowcase) selected = "ambience"; // Existing saved showcase preferences.
  if (selected === "ambience") return visualProfile(map, hash, true, true);
  if (selected === "auto") {
    if(options.ambienceShowcase){const scoped=visualProfile(map,hash,true,true);if(scoped.id==="ambience-showcase-v1")return scoped;}
    selected = hasSun ? "balanced" : "indoor";
  }
  return { ...(GENERIC[selected] ?? visualProfile(map, hash, !!options.mapProfiles)) };
}
