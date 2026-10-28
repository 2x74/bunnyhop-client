import * as THREE from "three";
/** Shared world-space light inputs consumed by world lighting, GI, clouds and atmosphere. */
export interface ResolvedSun { direction: THREE.Vector3; color: THREE.Color; irradianceColor?: THREE.Color; ambientColor?: THREE.Color }
export interface SkyLighting { sun?: { direction: [number,number,number]; color: [number,number,number]; intensity: number }; ambient?: { color: [number,number,number]; intensity: number } }
export interface LightingState { sun?: ResolvedSun; ambient?: THREE.Color; source: "map" | "pack" | "map-fallback"; packLighting: boolean; radianceLimited: boolean }
/** The map's own sun (render.ts: env_sun / light_environment), if it has one. */
export function authoredSun(scene: THREE.Scene): ResolvedSun | undefined {
  let authored: ResolvedSun | undefined;
  scene.traverse((object) => { authored ??= object.userData.authoredSun; });
  return authored;
}

/**
 * Which sun the composer looks light with: the map's own (its baked shadows agree with it) unless the player picked
 * the sky's declared lighting, or on the Ambience showcase, art-directed around its sky pack.
 */
export function effectiveLightingSource(picked: "map" | "pack" | undefined, profileId: string, packSky: boolean): "map" | "pack" {
  return picked === "pack" || (packSky && profileId === "ambience-showcase-v1") ? "pack" : "map";
}

/** Sky yaw that puts a sky pack's sun at the map sun's compass direction (both point toward the sun, three.js Y up). */
export function alignedSkyYaw(mapSun: THREE.Vector3, packSun: readonly [number, number, number]): number {
  return Math.atan2(mapSun.x, mapSun.z) - Math.atan2(packSun[0], packSun[2]);
}

export function resolveLighting(scene: THREE.Scene, source: "map" | "pack", lighting: SkyLighting | undefined, yaw: number, exposure: number): LightingState {
  const authored = authoredSun(scene);
  if (source === "pack" && lighting) {
    let radianceLimited=false;const bounded=(color:THREE.Color)=>{const peak=Math.max(color.r,color.g,color.b);if(peak>2048){color.multiplyScalar(2048/peak);radianceLimited=true;}return color;};
    const sun=lighting.sun ? { direction: new THREE.Vector3(...lighting.sun.direction).applyAxisAngle(new THREE.Vector3(0,1,0),yaw).normalize(), color: bounded(new THREE.Color(...lighting.sun.color).multiplyScalar(lighting.sun.intensity*exposure)), ambientColor: lighting.ambient ? bounded(new THREE.Color(...lighting.ambient.color).multiplyScalar(lighting.ambient.intensity*exposure)) : new THREE.Color(0,0,0) } : undefined;
    return { sun, ambient: lighting.ambient ? bounded(new THREE.Color(...lighting.ambient.color).multiplyScalar(lighting.ambient.intensity*exposure)) : undefined, source: "pack", packLighting: true, radianceLimited };
  }
  return { sun: authored, ambient: authored?.ambientColor, source: source === "pack" ? "map-fallback" : "map", packLighting: false, radianceLimited:false };
}
