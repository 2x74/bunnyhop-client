import * as THREE from "three";
/** Marks the matching avatar root for shadow passes; does not create duplicate geometry or a capsule. */
export class PlayerShadowProxy {
  root: THREE.Object3D;
  constructor(_scene: THREE.Scene, avatar?: THREE.Object3D) { this.root = avatar ?? new THREE.Group(); this.bind(this.root); }
  bind(avatar: THREE.Object3D): void {
    delete this.root.userData.sunShadowOnly; delete this.root.userData.sunShadowEnabled;
    this.root = avatar; avatar.userData.sunShadowOnly = true; avatar.userData.sunShadowEnabled = false;
  }
  update(_position: readonly number[], _crouched: boolean, enabled: boolean): void { this.setEnabled(enabled); }
  setEnabled(enabled: boolean): void { this.root.userData.sunShadowEnabled = enabled; }
  dispose(): void { delete this.root.userData.sunShadowOnly; delete this.root.userData.sunShadowEnabled; }
}
