import * as THREE from "three";

export interface WaterCaptureQuality {
  reflectionScale: number;
  refractionScale: number;
  maxReflectionPlanes: number;
}
interface Surface { material: THREE.ShaderMaterial; height: number | null; bounds: THREE.Box3 }

/**
 * Surfaces are kept per grid cell (Source units, xz): one material's water spread over a whole map (canals, a moat) is
 * many small boxes, so the frustum and distance tests see only the water that is really near the view.
 */
const CELL = 1024;
/**
 * Like CS:S's cheap water (r_cheapwaterend / $cheapwaterenddistance): the reflect / refract passes only run while water
 * is this close (Source units to its nearest point); farther water draws the plain surface. Each pass draws the whole
 * scene again, which more than halved the frame rate on big water maps (bhop_lost_world, 2026-10-29). The margin keeps
 * it from switching every frame at the edge.
 */
const CAPTURE_DISTANCE = 1536;
const CAPTURE_MARGIN = 256;

const isWaterSurface = (m: THREE.Material): m is THREE.ShaderMaterial => m instanceof THREE.ShaderMaterial && !!m.userData.waterSurface;
/** Whether `root` has a surface WaterCapture would capture for (cached per root). */
const waterIn = new WeakMap<THREE.Object3D, boolean>();
export function hasWaterSurfaces(root: THREE.Object3D): boolean {
  let found = waterIn.get(root);
  if (found === undefined) {
    found = false;
    root.traverse((o) => {
      if (!found && o instanceof THREE.Mesh) found = (Array.isArray(o.material) ? o.material : [o.material]).some(isWaterSurface);
    });
    waterIn.set(root, found);
  }
  return found;
}

/** Bounded, non-recursive captures. Shared coplanar surfaces use one reflection pass. */
export class WaterCapture {
  private surfaces: Surface[] = [];
  private color = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
  private reflections: THREE.WebGLRenderTarget[] = [];
  private camera = new THREE.PerspectiveCamera();
  private rendering = false;
  private captureType: THREE.TextureDataType = THREE.UnsignedByteType;
  /** Captured last frame (CAPTURE_MARGIN applies). */
  private near = false;
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
      const corner = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], centre = new THREE.Vector3(), normal = new THREE.Vector3();
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
      for (const group of groups) {
        const material = materials[group.materialIndex ?? 0];
        if (!material || !isWaterSurface(material)) continue;
        // Whole triangles, each in the cell of its centre (a big face's box spans the cells it covers).
        for (let i = group.start; i + 2 < group.start + group.count; i += 3) {
          const first = geometry.index?.getX(i) ?? i;
          for (let k = 0; k < 3; k++) corner[k].fromBufferAttribute(positions, geometry.index?.getX(i + k) ?? i + k).applyMatrix4(object.matrixWorld);
          centre.copy(corner[0]).add(corner[1]).add(corner[2]).divideScalar(3);
          if (normals) normal.fromBufferAttribute(normals, first).applyMatrix3(normalMatrix).normalize();
          const height = normals && normal.y > 0.99 ? Math.round(centre.y * 10) / 10 : null;
          const key = `${material.uuid}:${height}:${Math.floor(centre.x / CELL)}:${Math.floor(centre.z / CELL)}`;
          let surface = found.get(key);
          if (!surface) { surface = { material, height, bounds: new THREE.Box3() }; found.set(key, surface); }
          for (const p of corner) surface.bounds.expandByPoint(p);
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
    if (this.rendering || !this.surfaces.length || !(camera instanceof THREE.PerspectiveCamera) || quality.refractionScale <= 0) return void (this.near = false);
    const type = renderer.extensions?.has("EXT_color_buffer_float") ? THREE.HalfFloatType : THREE.UnsignedByteType;
    if (type !== this.captureType) {
      this.captureType = type;
      for (const target of [this.color, ...this.reflections]) { target.dispose(); target.texture.type = type; target.texture.needsUpdate = true; }
    }
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    // Water in view, close enough, and seen from above (the surface seen from below never reads the captures).
    const eye = camera.getWorldPosition(new THREE.Vector3());
    const limit = CAPTURE_DISTANCE + (this.near ? CAPTURE_MARGIN : 0);
    const visible = this.surfaces.filter(s => (s.height === null || eye.y > s.height) && s.bounds.distanceToPoint(eye) <= limit && frustum.intersectsBox(s.bounds));
    this.near = visible.length > 0;
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
        const mirrored = eye.clone(); mirrored.y = 2 * height - mirrored.y;
        const forward = camera.getWorldDirection(new THREE.Vector3()); forward.y *= -1;
        this.camera.position.copy(mirrored);
        this.camera.up.copy(camera.up).transformDirection(camera.matrixWorld); this.camera.up.y *= -1;
        this.camera.lookAt(mirrored.clone().add(forward)); this.camera.updateMatrixWorld(true);
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
