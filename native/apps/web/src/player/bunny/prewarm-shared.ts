import * as THREE from "three";
import { DEFAULT_LOADOUT } from "../../loadout";
import { DEFAULT_COSMETICS } from "../../progression";
import { PlayerModel } from "../model";
import { NameTag } from "../tag";
import { warmModelPrograms, prebuildBunny, prebuildGun, stageModelTextures } from "./prebuild";

const prepared = new WeakMap<THREE.WebGLRenderer, Promise<void>>();

/** Only no-KHR room clients: pay for the shared body/glow/tag programs behind the existing map loading screen. */
export function prewarmSharedPlayers(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Promise<void> {
  if (renderer.extensions.has("KHR_parallel_shader_compile")) return Promise.resolve();
  const previous = prepared.get(renderer);
  if (previous) return previous;
  const work = (async () => {
    // Include headwear so both body and headwear vertex layouts of the shared glow programs are ready.
    const loadout = { ...DEFAULT_LOADOUT, crown: 1 as const };
    await Promise.all([
      prebuildBunny(DEFAULT_COSMETICS.outfit, loadout, true),
      prebuildGun("p90"),
    ]);
    const model = new PlayerModel({
      style: "solid", outfit: DEFAULT_COSMETICS.outfit!, loadout, previewGlow: true,
      playerGlow: { enabled: true, aura: true, color: "violet", intensity: 0.7 },
    });
    const tag = new NameTag("#4fa8ff");
    const root = new THREE.Group();
    root.add(model.root, tag.sprite);
    const camera = new THREE.PerspectiveCamera(60, 1, 1, 1000);
    camera.position.set(100, 55, 115);
    camera.lookAt(0, 34, 0);
    camera.updateMatrixWorld(true);
    try {
      // Holding a gun also creates the shared two-sided flash material; its links must not land on the first gun join.
      model.setGun("p90");
      model.setState({ position: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, crouched: false });
      model.update(0);
      tag.set("player", "", null, false);
      tag.place(new THREE.Vector3(0, 76, 0), camera.position, 1);
      await stageModelTextures(renderer, root);
      // Includes tiny, separate draws: shader completion does not cover SwiftShader's first raster pipeline.
      await warmModelPrograms(renderer, root, camera, scene);
    } finally {
      model.dispose();
      tag.dispose();
    }
  })();
  prepared.set(renderer, work);
  return work;
}
