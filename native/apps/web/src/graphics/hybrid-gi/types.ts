import type * as THREE from "three";
export interface HybridSnapshot {
  geometry: THREE.BufferGeometry;
  materialTexture: THREE.DataTexture;
  albedoMaps: THREE.DataArrayTexture;
  materialCount: number;
  mapIdentity: string;
  revision: string;
  validate: () => boolean;
  dynamicBounds: (reset?: boolean) => THREE.Box3[];
  dispose: () => void;
  report: Record<string, unknown>;
}
export interface HybridSun { direction: THREE.Vector3; color: THREE.Color; enabled: boolean }
export interface HybridLocalLight {
  id: string;
  position: THREE.Vector3;
  direction: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  range: number;
  kind: "point" | "spot";
  innerCos: number;
  outerCos: number;
  enabled: boolean;
}
export interface HybridLighting {
  currentSun?: HybridSun;
  baselineSun?: HybridSun;
  currentLocal: HybridLocalLight[];
  baselineLocal: HybridLocalLight[];
}
export interface HybridReceiver {
  depth: THREE.Texture;
  normal: THREE.Texture; // RGB world normal encoded .5*n+.5; A validity.
}
export interface HybridTraceOptions {
  width?: number; height?: number; range?: number;
  /** Absolute deterministic sample index; zero for paused/stateless export. */
  sampleIndex?: number;
}
