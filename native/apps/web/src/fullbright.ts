// Bypass baked world lighting while preserving base texture, transparency, fog and Potato grid colours.
import * as THREE from "three";

export class Fullbright {
  private enabled = { value: 0 };
  private patched = new WeakSet<THREE.Material>();

  set(on: boolean): void { this.enabled.value = on ? 1 : 0; }

  apply(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Prop lighting is baked into vertex colours; Potato retains this attribute alongside its colour average.
      const prop = !!mesh.geometry.getAttribute("fullbrightShade");
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!(m instanceof THREE.MeshBasicMaterial) || (!m.lightMap && !prop) || !m.colorWrite || this.patched.has(m)) continue;
        this.patched.add(m);
        const before = m.onBeforeCompile;
        const key = m.customProgramCacheKey;
        m.onBeforeCompile = (shader, renderer) => {
          before.call(m, shader, renderer);
          shader.uniforms.uFullbright = this.enabled;
          if (prop) {
            shader.vertexShader = shader.vertexShader
              .replace("#include <common>", "#include <common>\nattribute float fullbrightShade;\nvarying float vFullbrightShade;")
              .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFullbrightShade = fullbrightShade;");
          }
          shader.fragmentShader = shader.fragmentShader
            .replace("#include <common>", `#include <common>\nuniform float uFullbright;${prop ? "\nvarying float vFullbrightShade;" : ""}`)
            .replace("#include <opaque_fragment>", `
              if (uFullbright > 0.5) outgoingLight = diffuseColor.rgb${prop ? " / max(vFullbrightShade, 0.001)" : ""};
              #include <opaque_fragment>`);
        };
        m.customProgramCacheKey = () => `${key.call(m)}+fullbright-v1${prop ? "-prop" : ""}`;
        m.needsUpdate = true;
      }
    });
  }
}
