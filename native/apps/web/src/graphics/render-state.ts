import * as THREE from "three";
import type { GraphicsPipeline } from "./pipeline";
/** Snapshot once before offline rendering. Restoration is safe after cancellation or partial setup. */
export function restoreRenderState(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, pipeline?: GraphicsPipeline): () => void {
  const options = pipeline?.getOptions();
  const size = renderer.getSize(new THREE.Vector2());
  const ratio = renderer.getPixelRatio();
  const aspect = camera.aspect;
  const fov = camera.fov;
  const target = renderer.getRenderTarget?.() ?? null;
  const viewport = renderer.getViewport?.(new THREE.Vector4());
  const scissor = renderer.getScissor?.(new THREE.Vector4());
  const scissorTest = renderer.getScissorTest?.();
  const clear = renderer.getClearColor?.(new THREE.Color());
  const clearAlpha = renderer.getClearAlpha?.();
  const autoClear = renderer.autoClear;
  const toneMapping = renderer.toneMapping, exposure = renderer.toneMappingExposure, output = renderer.outputColorSpace;
  const xr = renderer.xr?.enabled;
  return () => {
    renderer.setPixelRatio(ratio); renderer.setSize(size.x, size.y, false);
    if (options) {if(pipeline?.finishExport)pipeline.finishExport(options);else pipeline?.setOptions(options);}
    pipeline?.setSize(size.x, size.y);
    camera.aspect = aspect; camera.fov = fov; camera.updateProjectionMatrix();
    renderer.setRenderTarget?.(target);
    if (viewport) renderer.setViewport(viewport);
    if (scissor) renderer.setScissor(scissor);
    if (scissorTest !== undefined) renderer.setScissorTest(scissorTest);
    if (clear) renderer.setClearColor(clear, clearAlpha);
    renderer.autoClear = autoClear; renderer.toneMapping = toneMapping; renderer.toneMappingExposure = exposure; renderer.outputColorSpace = output;
    if (xr !== undefined) renderer.xr.enabled = xr;
  };
}
