import * as THREE from "three";
/** Captures preserve the caller's render target, HiDPI viewport and clear/output state even on failure. */
export function preserveHybridState(renderer: THREE.WebGLRenderer): () => void {
  const target = renderer.getRenderTarget(), viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4());
  const scissorTest = renderer.getScissorTest(), clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
  const auto = renderer.autoClear, tone = renderer.toneMapping, color = renderer.outputColorSpace, xr = renderer.xr.enabled;
  return () => { renderer.setRenderTarget(target); renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest); renderer.setClearColor(clear, alpha); renderer.autoClear = auto; renderer.toneMapping = tone; renderer.outputColorSpace = color; renderer.xr.enabled = xr; };
}
