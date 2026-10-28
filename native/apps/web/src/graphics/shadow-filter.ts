/** Continuous tent weights anchored to shadow texel centers, without frame jitter. */
export function shadowFilterTaps(coordinate: number, radius: 1 | 2): { center: number; weight: number }[] {
  const base = Math.floor(coordinate - .5), phase = coordinate - .5 - base;
  const taps = [];
  for (let i = -1; i <= 2; i++) {
    const weight = Math.max(0, radius - Math.abs(i - phase));
    if (weight > 0) taps.push({ center: base + i + .5, weight: weight / (radius * radius) });
  }
  return taps;
}
export const SHADOW_FILTER_GLSL = /* glsl */`
#ifndef STABLE_SHADOW_FILTER
#define STABLE_SHADOW_FILTER
// Return exact texel-center UV and separable tent weight. Packed depths must
// remain nearest-filtered: interpolate visibility comparisons, never depths.
vec3 stableShadowTap(vec2 uv,vec2 texel,ivec2 offset,float radius){
 vec2 p=uv/texel-.5,base=floor(p),phase=p-base,d=vec2(offset)-phase;
 vec2 w=max(vec2(0.),vec2(radius)-abs(d));
 return vec3((base+vec2(offset)+.5)*texel,w.x*w.y);
}
// Receiver-plane correction evaluates the receiver depth at each filter tap.
// A screen-pixel slope bias alone cannot cover a wider kernel and changes with
// viewport/camera distance; correcting UV-space depth avoids that dependency.
vec2 stableShadowDepthGradient(vec3 p){
 vec3 dx=dFdx(p),dy=dFdy(p);float determinant=dx.x*dy.y-dx.y*dy.x;
 if(abs(determinant)<1e-10)return vec2(0.);
 return clamp(vec2(dx.z*dy.y-dy.z*dx.y,dy.z*dx.x-dx.z*dy.x)/determinant,vec2(-8.),vec2(8.));
}
#endif
`;
