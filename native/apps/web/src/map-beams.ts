// The map's spotlight beams (point_spotlight that starts on and never switches; placed by crates/core/src/dressing.rs
// with the beam's length to what the engine's trace would hit), drawn as CS:S draws them (CPointSpotlight's CBeam,
// `DrawBeamWithHalo` / `DrawSegs`): a ribbon of `sprites/glow_test02` from the light along its angles, turned to face
// the view, `spotlightwidth` wide at the light and narrowing to width x (length / spotlightlength) where something
// stops it, tinted by rendercolor at brightness 64, fading out toward the end (FBEAM_SHADEOUT), added. As the view
// comes within four widths of the beam's line it fades away, gone at one width. The halo the engine draws at the
// light (`sprites/light_glow03`) is left out: how BeamDrawHalo sizes it isn't settled here.
//
//   const b = mapBeams(core.dressingGlows(), texture, fog); if (b) root.add(b.mesh)    one draw call

import * as THREE from "three";
import { GlowKind, type DressingGlow } from "./core";
import { withDepthFog, type DepthFogUniforms } from "./depth-fog";
import { markGammaBlend } from "./graphics/gamma-blend";

/** CPointSpotlight: `m_hSpotlight->SetBrightness( 64 )`. */
export const BEAM_BRIGHTNESS = 64 / 255;

/** DrawBeamWithHalo's fade by the view's distance to the beam's line: 1 beyond 4 widths, 0 inside one. */
export function beamViewFade(distToLine: number, width: number): number {
  const threshold = width * 4;
  if (distToLine >= threshold) return 1;
  return Math.min(1, Math.max(0, (distToLine - width) / (threshold - width)));
}

const VERTEX = /* glsl */ `
attribute vec3 dir;
attribute vec3 beam; // x = length, y = start width, z = end width
attribute vec2 along; // x = 0 at the light, 1 at the end; y = side (-1, 1)
attribute vec3 color;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vec3 s = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  vec3 d = normalize( mat3( modelMatrix ) * dir );
  vec3 p = s + d * beam.x * along.x;
  vec3 n = cross( p - cameraPosition, d );
  float nl = length( n );
  // The view's distance to the beam's line.
  vec3 toEye = cameraPosition - s;
  float line = length( toEye - d * dot( toEye, d ) );
  float threshold = beam.y * 4.0;
  float fade = line >= threshold ? 1.0 : clamp( ( line - beam.y ) / max( threshold - beam.y, 1e-3 ), 0.0, 1.0 );
  vColor = color * fade * ( 1.0 - along.x );
  if ( nl < 1e-4 || fade <= 0.0 ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    vUv = vec2( 0.0 );
    return;
  }
  float w = mix( beam.y, beam.z, along.x ) * 0.5;
  gl_Position = projectionMatrix * viewMatrix * vec4( p + n / nl * w * along.y, 1.0 );
  vUv = vec2( along.y * 0.5 + 0.5, along.x );
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vec4 t = texture2D( map, vUv );
  gl_FragColor = vec4( t.rgb * vColor, t.a );
  #include <colorspace_fragment>
}`;

export interface MapBeams {
  mesh: THREE.Mesh;
  count: number;
}

/** The spotlights of `glows` as one mesh (Source space, under the world's root); null without any or without `map`. */
export function mapBeams(glows: readonly DressingGlow[], map: THREE.Texture | null, fog: DepthFogUniforms | null): MapBeams | null {
  const spots = glows.filter((g) => g.kind === GlowKind.Spotlight && g.size > 0 && g.size2 > 0);
  if (!spots.length || !map) return null;
  const n = spots.length;
  const pos = new Float32Array(n * 12);
  const dir = new Float32Array(n * 12);
  const beam = new Float32Array(n * 12);
  const along = new Float32Array(n * 8);
  const color = new Float32Array(n * 12);
  const index = new Uint32Array(n * 6);
  const c = new THREE.Color();
  spots.forEach((g, i) => {
    const maxLength = g.dist[0] > 0 ? g.dist[0] : g.size2;
    const endWidth = Math.min(102.3, g.size * (g.size2 / maxLength));
    c.setRGB(g.color[0] / 255, g.color[1] / 255, g.color[2] / 255, THREE.SRGBColorSpace).multiplyScalar(BEAM_BRIGHTNESS);
    const corners = [[0, -1], [0, 1], [1, 1], [1, -1]];
    for (let k = 0; k < 4; k++) {
      const o = i * 4 + k;
      pos.set(g.origin, o * 3);
      dir.set(g.dir, o * 3);
      beam.set([g.size2, g.size, endWidth], o * 3);
      along.set(corners[k], o * 2);
      color.set([c.r, c.g, c.b], o * 3);
    }
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("dir", new THREE.BufferAttribute(dir, 3));
  geo.setAttribute("beam", new THREE.BufferAttribute(beam, 3));
  geo.setAttribute("along", new THREE.BufferAttribute(along, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(color, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  const material = markGammaBlend(
    new THREE.ShaderMaterial({
      uniforms: { map: { value: map } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  material.name = "map-beams";
  const mesh = new THREE.Mesh(geo, fog ? withDepthFog(material, fog) : material);
  mesh.name = "map-beams";
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.userData.giDisabled = true;
  return { mesh, count: n };
}
