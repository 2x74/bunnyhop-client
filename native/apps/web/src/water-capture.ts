import * as THREE from "three";

export interface WaterCaptureQuality {
  reflectionScale: number;
  refractionScale: number;
  maxReflectionPlanes: number;
}
interface Surface { material: THREE.ShaderMaterial; height: number | null; bounds: THREE.Box3 }

/** Bounded, non-recursive captures. Shared coplanar surfaces use one reflection pass. */
export class WaterCapture {
  private surfaces: Surface[] = [];
  private color = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
  private reflections: THREE.WebGLRenderTarget[] = [];
  private camera = new THREE.PerspectiveCamera();
  private rendering = false;
  private captureType: THREE.TextureDataType = THREE.UnsignedByteType;
  constructor(private scene: THREE.Scene) {
    this.color.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.scene.updateMatrixWorld(true);
    const found = new Map<string, Surface>();
    scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const geometry = object.geometry as THREE.BufferGeometry;
      const positions = geometry.getAttribute("position"), normals = geometry.getAttribute("normal");
      if (!positions) return;
      const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: geometry.index?.count ?? positions.count, materialIndex: 0 }];
      const point = new THREE.Vector3(), normal = new THREE.Vector3();
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
      for (const group of groups) {
        const material = materials[group.materialIndex ?? 0];
        if (!(material instanceof THREE.ShaderMaterial) || !material.userData.waterSurface) continue;
        for (let i = group.start; i < group.start + group.count; i++) {
          const index = geometry.index?.getX(i) ?? i;
          point.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld);
          if (normals) normal.fromBufferAttribute(normals, index).applyMatrix3(normalMatrix).normalize();
          const height = normals && normal.y > 0.99 ? Math.round(point.y * 10) / 10 : null;
          const key = `${material.uuid}:${height}`;
          let surface = found.get(key);
          if (!surface) { surface = { material, height, bounds: new THREE.Box3() }; found.set(key, surface); }
          surface.bounds.expandByPoint(point);
        }
      }
    });
    this.surfaces = [...found.values()];
  }
  private resize(target: THREE.WebGLRenderTarget, size: THREE.Vector2, scale: number): void {
    const width = Math.max(1, Math.min(2048, Math.round(size.x * scale)));
    const height = Math.max(1, Math.min(2048, Math.round(size.y * scale)));
    if (target.width !== width || target.height !== height) target.setSize(width, height);
  }
  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera, quality: WaterCaptureQuality): void {
    for (const { material } of this.surfaces) {
      material.uniforms.uCaptureReady.value = 0;
      material.uniforms.uReflectionReady.value = 0;
      material.uniforms.uReflectionReadyB.value = 0;
    }
    if (this.rendering || !this.surfaces.length || !(camera instanceof THREE.PerspectiveCamera) || quality.refractionScale <= 0) return;
    const type = renderer.extensions?.has("EXT_color_buffer_float") ? THREE.HalfFloatType : THREE.UnsignedByteType;
    if (type !== this.captureType) {
      this.captureType = type;
      for (const target of [this.color, ...this.reflections]) { target.dispose(); target.texture.type = type; target.texture.needsUpdate = true; }
    }
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const visible = this.surfaces.filter(s => frustum.intersectsBox(s.bounds));
    if (!visible.length) return;
    const target = renderer.getRenderTarget(), viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest(), autoClear = renderer.autoClear, xr = renderer.xr.enabled;
    const hidden = this.surfaces.map(s => [s.material, s.material.visible] as const);
    this.rendering = true;
    try {
      hidden.forEach(([material]) => { material.visible = false; });
      renderer.xr.enabled = false;
      renderer.autoClear = true;
      renderer.setScissorTest(false);
      this.resize(this.color, size, quality.refractionScale);
      renderer.setRenderTarget(this.color);
      renderer.clear();
      renderer.render(this.scene, camera);
      for (const { material } of visible) {
        material.uniforms.uSceneColor.value = this.color.texture;
        material.uniforms.uSceneDepth.value = this.color.depthTexture;
        material.uniforms.uCameraNearFar.value.set(camera.near, camera.far);
        material.uniforms.uCaptureReady.value = 1;
      }
      const groups = new Map<number, Surface[]>();
      for (const surface of visible) {
        if (surface.height === null || !Number.isFinite(surface.height) || camera.position.y <= surface.height + 0.1) continue;
        const key = Math.round(surface.height * 10) / 10;
        const group = groups.get(key) ?? []; group.push(surface); groups.set(key, group);
      }
      const selected = [...groups].sort((a, b) => Math.abs(camera.position.y - a[0]) - Math.abs(camera.position.y - b[0])).slice(0, Math.min(2, Math.max(0, quality.maxReflectionPlanes)));
      for (let i = 0; i < selected.length && quality.reflectionScale > 0; i++) {
        const [height, surfaces] = selected[i];
        const reflection = this.reflections[i] ?? (this.reflections[i] = new THREE.WebGLRenderTarget(1, 1, { type: this.captureType }));
        this.resize(reflection, size, quality.reflectionScale);
        this.camera.copy(camera);
        const eye = camera.getWorldPosition(new THREE.Vector3()); eye.y = 2 * height - eye.y;
        const forward = camera.getWorldDirection(new THREE.Vector3()); forward.y *= -1;
        this.camera.position.copy(eye);
        this.camera.up.copy(camera.up).transformDirection(camera.matrixWorld); this.camera.up.y *= -1;
        this.camera.lookAt(eye.clone().add(forward)); this.camera.updateMatrixWorld(true);
        // Oblique near plane removes geometry beneath the reflecting plane (no scene mutations).
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -height).applyMatrix4(this.camera.matrixWorldInverse);
        const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
        const projection = this.camera.projectionMatrix.elements;
        const q = new THREE.Vector4((Math.sign(clip.x) + projection[8]) / projection[0], (Math.sign(clip.y) + projection[9]) / projection[5], -1, (1 + projection[10]) / projection[14]);
        const denominator = clip.dot(q);
        if (Math.abs(denominator) < 1e-6) continue;
        clip.multiplyScalar(2 / denominator);
        projection[2] = clip.x; projection[6] = clip.y; projection[10] = clip.z + 1; projection[14] = clip.w;
        this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
        renderer.setRenderTarget(reflection); renderer.clear(); renderer.render(this.scene, this.camera);
        const matrix = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
        for (const { material } of surfaces) {
          const suffix = i === 0 ? "" : "B";
          material.uniforms[`uReflection${suffix}`].value = reflection.texture;
          material.uniforms[`uReflectionMatrix${suffix}`].value.copy(matrix);
          material.uniforms[`uReflectionReady${suffix}`].value = 1;
          material.uniforms.uReflectionHeight.value.setComponent(i, height);
        }
      }
    } catch {
      // Failed or lost-context captures use the procedural surface until the next frame.
      for (const { material } of this.surfaces) {
        material.uniforms.uCaptureReady.value = 0;
        material.uniforms.uReflectionReady.value = 0;
        material.uniforms.uReflectionReadyB.value = 0;
      }
    } finally {
      hidden.forEach(([material, visible]) => { material.visible = visible; });
      renderer.setRenderTarget(target); renderer.setViewport(viewport); renderer.setScissor(scissor);
      renderer.setScissorTest(scissorTest); renderer.autoClear = autoClear; renderer.xr.enabled = xr;
      this.rendering = false;
    }
  }
  dispose(): void {
    this.color.dispose(); this.reflections.forEach(target => target.dispose());
    for (const { material } of this.surfaces) {
      material.uniforms.uCaptureReady.value = 0; material.uniforms.uReflectionReady.value = 0; material.uniforms.uReflectionReadyB.value = 0;
      material.uniforms.uSceneColor.value = null; material.uniforms.uSceneDepth.value = null; material.uniforms.uReflection.value = null; material.uniforms.uReflectionB.value = null;
    }
    this.surfaces = [];
  }
}
