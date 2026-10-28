import * as THREE from "three";

/** Shadow-only avatar visibility and per-material cutout depth, independent of beauty/depth effects. */
export class ShadowCasters {
  private depths = new Map<THREE.Material, THREE.MeshDepthMaterial>();
  private cleanup = new Map<THREE.Material, () => void>();
  private invisible = new THREE.MeshDepthMaterial({ visible: false });
  run<T>(scene: THREE.Scene, draw: () => T, transparent = false): T {
    const visibility: [THREE.Object3D, boolean][] = [], materials: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    const override = scene.overrideMaterial;
    scene.traverse(object => {
      if (object.userData.sunShadowOnly && object.userData.sunShadowEnabled && !object.visible) { visibility.push([object, false]); object.visible = true; }
    });
    scene.traverse(object => {
      const primitive = object as THREE.Line & THREE.Points & THREE.Sprite;
      if ((primitive.isLine || primitive.isPoints || primitive.isSprite) && object.visible) { visibility.push([object, true]); object.visible = false; return; }
      if (!(object instanceof THREE.Mesh) || !object.visible) return;
      const source = Array.isArray(object.material) ? object.material : [object.material];
      const mapped = source.map(material => {
        if (!material.visible || !material.colorWrite || !material.depthTest || object.renderOrder < -900 || object.geometry.getAttribute("center") || material.userData.waterSurface || material.blending === THREE.AdditiveBlending || material.alphaHash || (material as THREE.ShaderMaterial).defines?.DITHER || !!material.transparent !== transparent) return this.invisible;
        if (transparent) return material;
        let depth = this.depths.get(material);
        if (!depth) { depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, blending: THREE.NoBlending }); this.depths.set(material, depth);
          const release = () => { depth!.dispose(); this.depths.delete(material); this.cleanup.delete(material); material.removeEventListener("dispose", release); };
          material.addEventListener("dispose", release); this.cleanup.set(material, release);
        }
        const m = material as THREE.MeshBasicMaterial;
        const map = m.map ?? (material as THREE.ShaderMaterial).uniforms?.map?.value ?? null;
        const alphaMap = m.alphaMap ?? null;
        const alphaTest = material.alphaTest || (material as THREE.ShaderMaterial).uniforms?.uAlphaTest?.value || 0;
        if (depth.map !== map || depth.alphaMap !== alphaMap || depth.alphaTest !== alphaTest || depth.side !== material.side) depth.needsUpdate = true;
        depth.map = map; depth.alphaMap = alphaMap; depth.alphaTest = alphaTest;
        depth.side = material.side; depth.opacity = material.opacity; depth.clippingPlanes = material.clippingPlanes;
        return depth;
      });
      materials.push([object, object.material]); object.material = Array.isArray(object.material) ? mapped : mapped[0];
    });
    scene.overrideMaterial = null;
    try { return draw(); } finally { scene.overrideMaterial = override; for (const [mesh, material] of materials) mesh.material = material; for (const [root, visible] of visibility) root.visible = visible; }
  }
  dispose(): void { for (const [material, release] of this.cleanup) material.removeEventListener("dispose", release); this.cleanup.clear(); for (const depth of this.depths.values()) depth.dispose(); this.depths.clear(); this.invisible.dispose(); }
}

/** Nearest two transparent intersections, depth peeled. Opacity/tint attenuate light, never opaque depth. */
export class ShadowTransmission {
  readonly targets = [0, 1].map(() => { const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }); target.depthTexture = new THREE.DepthTexture(1, 1); return target; });
  private materials = new Map<THREE.Material, THREE.MeshBasicMaterial>();
  private cleanup = new Map<THREE.Material, () => void>();
  private uniforms = { uPeelDepth: { value: null as THREE.Texture | null }, uPeel: { value: 0 }, uPeelSize: { value: new THREE.Vector2(1, 1) } };
  private casters = new ShadowCasters();
  private invisible = new THREE.MeshBasicMaterial({ visible: false });
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, size: number, atlas?: { viewport: THREE.Vector4; width: number; height: number }): void {
    const swaps: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [], hidden: THREE.Object3D[] = [];
    const viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
    const target = renderer.getRenderTarget(), clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha(), background = scene.background;
    try {
      scene.background = null;
      scene.traverse(object => {
        const primitive = object as THREE.Line & THREE.Points & THREE.Sprite;
        if ((primitive.isLine || primitive.isPoints || primitive.isSprite) && object.visible) { hidden.push(object); object.visible = false; return; }
        if (!(object instanceof THREE.Mesh)) return;
        const source = Array.isArray(object.material) ? object.material : [object.material];
        const mapped = source.map(material => {
          if (!material.transparent || !material.visible || material.userData.waterSurface || material.blending === THREE.AdditiveBlending || object.geometry.getAttribute("center") || object.renderOrder < -900) return this.invisible;
          let transmission = this.materials.get(material);
          if (!transmission) {
            transmission = new THREE.MeshBasicMaterial({ depthWrite: true, transparent: false, blending: THREE.NoBlending, fog: false });
            transmission.onBeforeCompile = shader => {
              Object.assign(shader.uniforms, this.uniforms);
              shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nuniform sampler2D uPeelDepth;uniform float uPeel;uniform vec2 uPeelSize;")
                .replace("#include <opaque_fragment>", `if(uPeel>0.5&&gl_FragCoord.z<=texture2D(uPeelDepth,gl_FragCoord.xy/uPeelSize).r+0.00001)discard;
                if(diffuseColor.a<0.001)discard;
                gl_FragColor=vec4(mix(vec3(1.0),clamp(diffuseColor.rgb,0.0,1.0),clamp(diffuseColor.a,0.0,1.0))*(1.0-clamp(diffuseColor.a,0.0,1.0)),gl_FragCoord.z);`)
                .replace("#include <tonemapping_fragment>", "").replace("#include <colorspace_fragment>", "");
            };
            transmission.customProgramCacheKey = () => "shadow-transmission-v1"; this.materials.set(material, transmission);
            const release = () => { transmission!.dispose(); this.materials.delete(material); this.cleanup.delete(material); material.removeEventListener("dispose", release); };
            material.addEventListener("dispose", release); this.cleanup.set(material, release);
          }
          const m = material as THREE.MeshBasicMaterial;
          const tint: any = m.color ?? (material as THREE.ShaderMaterial).uniforms?.uTint?.value;
          if (tint) transmission.color.setRGB(tint.r ?? tint.x, tint.g ?? tint.y, tint.b ?? tint.z); else transmission.color.setRGB(0.75, 0.75, 0.75);
          const opacity = (material as THREE.ShaderMaterial).isShaderMaterial ? .35 : material.opacity;
          transmission.opacity = opacity; transmission.side = material.side; transmission.alphaTest = material.alphaTest;
          if (transmission.map !== (m.map ?? null) || transmission.alphaMap !== (m.alphaMap ?? null)) transmission.needsUpdate = true;
          transmission.map = m.map ?? null; transmission.alphaMap = m.alphaMap ?? null;
          return transmission;
        });
        swaps.push([object, object.material]); object.material = Array.isArray(object.material) ? mapped : mapped[0];
      });
      for (let layer = 0; layer < 2; layer++) {
        const capture = this.targets[layer], width = atlas?.width ?? size, height = atlas?.height ?? size; if (capture.width !== width || capture.height !== height) capture.setSize(width, height);
        this.uniforms.uPeel.value = layer; this.uniforms.uPeelDepth.value = layer ? this.targets[0].depthTexture : null; this.uniforms.uPeelSize.value.set(width, height);
        renderer.setRenderTarget(capture); if (atlas) { const rect = atlas.viewport.clone().multiplyScalar(1 / renderer.getPixelRatio()); renderer.setViewport(rect); renderer.setScissor(rect); renderer.setScissorTest(true); } else { renderer.setScissorTest(false); } renderer.setClearColor(0xffffff, 1); renderer.clear(); renderer.render(scene, camera);
      }
    } finally { for (const object of hidden) object.visible = true; for (const [mesh, material] of swaps) mesh.material = material; scene.background = background; renderer.setRenderTarget(target); renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest); renderer.setClearColor(clear, alpha); }
  }
  dispose(): void { for (const [material, release] of this.cleanup) material.removeEventListener("dispose", release); this.cleanup.clear(); this.targets.forEach(target => target.dispose()); this.materials.forEach(material => material.dispose()); this.invisible.dispose(); this.casters.dispose(); }
}
