import * as THREE from "three";

/** Explicit showcase art direction: analytic daylight, using the map's authored sun orientation. */
export class ShowcaseSky {
  private material: THREE.ShaderMaterial | null = null;
  run<T>(scene: THREE.Scene, sun: { direction: THREE.Vector3 } | undefined, enabled: boolean, draw: () => T): T {
    if (!enabled || !sun) { this.dispose(); return draw(); }
    this.material ??= new THREE.ShaderMaterial({
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false,
      uniforms: { skySun: { value: new THREE.Vector3() } },
      vertexShader: `varying vec3 skyRay;void main(){skyRay=(modelMatrix*vec4(position,1.)).xyz-cameraPosition;vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.);gl_Position=p.xyww;}`,
      fragmentShader: `uniform vec3 skySun;varying vec3 skyRay;void main(){
        vec3 ray=normalize(skyRay);float elevation=clamp(ray.y,0.,1.);
        // Linear daylight radiance, pale air near the horizon and blue zenith.
        vec3 color=mix(vec3(.54,.70,.82),vec3(.065,.25,.59),pow(elevation,.42));
        float mu=clamp(dot(ray,skySun),-1.,1.);
        color+=vec3(1.,.79,.49)*pow(max(mu,0.),24.)*.15;
        // Finite 0.53 degree solar disk; this direction is shared with world shadow maps.
        float disk=smoothstep(cos(.0052),cos(.0043),mu);
        color+=vec3(3.6,3.25,2.65)*disk;
        gl_FragColor=vec4(color,1.);
        #include <colorspace_fragment>
      }`,
    });
    this.material.uniforms.skySun.value.copy(sun.direction).normalize();
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    scene.traverse(object => {
      if (!(object instanceof THREE.Mesh) || object.renderOrder !== -1000) return;
      swapped.push([object, object.material]);
      object.material = Array.isArray(object.material) ? object.material.map(() => this.material!) : this.material!;
    });
    try { return draw(); } finally { for (const [mesh, material] of swapped) mesh.material = material; }
  }
  dispose(): void { this.material?.dispose(); this.material = null; }
}
