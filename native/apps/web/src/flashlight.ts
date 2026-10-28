// Camera-mounted cosmetic flashlight for baked-lightmap materials. No lights, shadows or extra draw passes.
import * as THREE from "three";

export class Flashlight {
  private enabled = { value: 0 };
  private patched = new WeakSet<THREE.Material>();

  set(on: boolean): void { this.enabled.value = on ? 1 : 0; }

  apply(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      // Sky, water and glass retain their existing shaders. Only opaque/alpha-test world and props get the cone.
      if (!mesh.isMesh || mesh.name.startsWith("sky") || !mesh.layers.test(new THREE.Layers())) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!(m instanceof THREE.MeshBasicMaterial) || !m.depthTest || !m.colorWrite || m.transparent || m.blending === THREE.AdditiveBlending || this.patched.has(m)) continue;
        this.patched.add(m);
        const previous = m.onBeforeCompile;
        const key = m.customProgramCacheKey;
        m.onBeforeCompile = (shader, renderer) => {
          previous.call(m, shader, renderer);
          shader.uniforms.uFlashlight = this.enabled;
          shader.vertexShader = shader.vertexShader
            .replace("#include <common>", "#include <common>\nvarying vec3 vFlashlightPosition;")
            .replace("#include <project_vertex>", "#include <project_vertex>\nvFlashlightPosition = mvPosition.xyz;");
          shader.fragmentShader = shader.fragmentShader
            .replace("#include <common>", "#include <common>\nuniform float uFlashlight;\nvarying vec3 vFlashlightPosition;")
            .replace("#include <opaque_fragment>", `
              if (uFlashlight > 0.5) {
                float distanceToEye = max(length(vFlashlightPosition), 0.001);
                float cone = smoothstep(0.94, 0.99, -vFlashlightPosition.z / distanceToEye);
                float falloff = 1.0 - smoothstep(64.0, 1200.0, distanceToEye);
                outgoingLight = max(outgoingLight, diffuseColor.rgb * (0.85 * cone * falloff));
              }
              #include <opaque_fragment>`);
        };
        m.customProgramCacheKey = () => `${key.call(m)}+flashlight-v1`;
        m.needsUpdate = true;
      }
    });
  }
}
