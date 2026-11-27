#pragma once
// The website's precipitation shaders (map-effects/precipitation.ts) for the native renderer: the same evaluation in
// Source space with the view-projection matrix in place of three.js's model-view and projection. A clip position's w
// is the view depth, sprites face the camera along its right / up axes, and a streak's width is across the line from
// the eye. precipitation_render.hpp prepends "#version 330 core" and, for rain and streak snow, "#define STREAK 1".

namespace native_precip {

inline constexpr const char *vertex_source = R"(#define MAXV 16
layout(location = 0) in vec2 corner;
layout(location = 1) in vec4 aBase;
layout(location = 2) in vec4 aMotion;
layout(location = 3) in vec4 aShape;
uniform mat4 uViewProjection;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uCamMod;
uniform vec3 uHalf;
uniform float uProj;
uniform float uMinPx;
uniform float uLength;
uniform float uFall;
uniform vec2 uNear;
uniform int uVolCount;
uniform vec4 uVolMin[MAXV];
uniform vec4 uVolMax[MAXV];
uniform vec4 uVolGrid[MAXV];
uniform sampler2D uColumns;
out vec2 vUv;
out float vAlpha;

// Where the particle may be: x = floor (1e9: nowhere), y = how far above the end of a drop's life (streaks).
vec2 columnSpan(vec3 w) {
  for (int k = 0; k < MAXV; k++) {
    if (k >= uVolCount) break;
    if (any(lessThan(w.xy, uVolMin[k].xy)) || any(greaterThanEqual(w.xy, uVolMax[k].xy))) continue;
#ifndef STREAK
    if (w.z < uVolMin[k].z || w.z >= uVolMax[k].z) continue;
#endif
    if (aShape.z >= uVolMax[k].w) continue;
    vec4 g = uVolGrid[k];
    ivec2 c = ivec2(clamp(floor((w.xy - uVolMin[k].xy) * uVolMin[k].w), vec2(0.0), g.zw - 1.0)) + ivec2(g.xy);
    vec2 col = texelFetch(uColumns, c, 0).rg;
#ifdef STREAK
    col.y = min(col.y, uCam.z + 512.0);
    float life = col.y - (uVolMax[k].z - uVolMin[k].z) * uFall;
    col.x = max(col.x, life);
    if (w.z >= col.x && w.z <= col.y) return vec2(col.x, w.z - life);
#else
    if (w.z >= col.x && w.z <= col.y) return vec2(col.x, 1e9);
#endif
  }
  return vec2(1e9);
}

void main() {
  vec3 period = uHalf * 2.0;
  float a = aMotion.w * uTime + aBase.w;
  vec3 swirl = vec3(cos(a), sin(a), 0.0) * aShape.y;
  vec3 rel = mod(aBase.xyz + mod(aMotion.xyz * uTime, period) + swirl - uCamMod + uHalf, period) - uHalf;
  vec3 w = uCam + rel;
  vec2 span = columnSpan(w);
  float floorZ = span.x;
  // Fade towards the edges of the box around the camera, where a particle wraps to the far side, and over a drop's
  // last 32 units of life.
  float alpha = aShape.w * (1.0 - smoothstep(0.55 * uHalf.x, 0.95 * uHalf.x, length(rel.xy)))
      * (1.0 - smoothstep(0.75 * uHalf.z, 0.98 * uHalf.z, abs(rel.z))) * smoothstep(0.0, 32.0, span.y);
  if (floorZ > 1e8) alpha = 0.0;
  float depth = (uViewProjection * vec4(w, 1.0)).w;
  alpha *= smoothstep(uNear.x, uNear.y, depth);
  if (alpha < 0.004 || depth < 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vUv = vec2(0.0);
    vAlpha = 0.0;
    return;
  }
#ifdef STREAK
  // A tracer from the particle along its velocity, stopped at the column's floor.
  vec3 vel = aMotion.xyz + vec3(-sin(a), cos(a), 0.0) * aShape.y * aMotion.w;
  vec3 delta = vel * uLength;
  if (w.z + delta.z < floorZ) delta *= (w.z - floorZ) / max(1e-3, -delta.z);
  vec3 tail = w + delta;
  vec3 p = mix(w, tail, corner.y * 0.5 + 0.5);
  vec3 side = cross(delta, p - uCam);
  float sideLength = length(side);
  side = sideLength > 1e-4 ? side / sideLength : uRight;
  float width = aShape.x;
  float along = max(1.0, (uViewProjection * vec4(p, 1.0)).w);
  float px = width * uProj / along;
  if (px < uMinPx) {
    alpha *= px / uMinPx;
    width = uMinPx * along / uProj;
  }
  p += side * corner.x * width * 0.5;
  gl_Position = uViewProjection * vec4(p, 1.0);
#else
  float r = aShape.x;
  float px = r * uProj / depth;
  if (px < uMinPx) {
    alpha *= (px / uMinPx) * (px / uMinPx);
    r = uMinPx * depth / uProj;
  }
  gl_Position = uViewProjection * vec4(w + (uRight * corner.x + uUp * corner.y) * r, 1.0);
#endif
  vUv = corner;
  vAlpha = alpha;
}
)";

inline constexpr const char *fragment_source = R"(uniform vec3 uColor;
uniform float uAlpha;
in vec2 vUv;
in float vAlpha;
out vec4 fragColor;
void main() {
#ifdef STREAK
  // particle/rain: soft across, fading at both ends.
  float a = (1.0 - abs(vUv.x)) * (1.0 - smoothstep(0.6, 1.0, abs(vUv.y)));
#else
  // particle/snow: a soft round flake.
  float d = dot(vUv, vUv);
  float a = d < 1.0 ? pow(1.0 - d, 1.5) : 0.0;
#endif
  fragColor = vec4(uColor, a * vAlpha * uAlpha);
  if (fragColor.a < 0.003) discard;
}
)";

}  // namespace native_precip
