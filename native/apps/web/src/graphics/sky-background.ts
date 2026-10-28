import { withShaderSkyWaterFog } from "../water";
import * as THREE from "three";
import type { LoadedSky } from "../sky-packs/runtime";
import { CLOUD_COMPOSITE_GLSL } from "./clouds";
import type { ResolvedSun } from "./lighting-state";
export interface SkyDrawOptions { mode: "map" | "procedural" | "pack"; yaw: number; exposure: number; sun?: ResolvedSun; clouds?: { uniforms: Record<string, THREE.IUniform>; prepare: (camera: THREE.Camera) => void } }
/** Changes only the existing sky background. Source portal masks and 3D miniatures remain untouched. */
export class SkyBackground {
  private materials = new Map<THREE.Material, THREE.ShaderMaterial>();
  private listeners=new Map<THREE.Material,()=>void>();
  private release(original:THREE.Material):void{const listener=this.listeners.get(original);if(listener)original.removeEventListener("dispose",listener);this.listeners.delete(original);this.materials.get(original)?.dispose();this.materials.delete(original);}
  private options: SkyDrawOptions | null = null;
  private create(original: THREE.Material): THREE.ShaderMaterial {
    const basic = original as THREE.MeshBasicMaterial;
    const source = original as THREE.ShaderMaterial;
    const material = new THREE.ShaderMaterial({ side: THREE.DoubleSide, depthWrite: false, depthTest: false, fog: false, uniforms: {
      uSkyCube:{value:null},uSkyPanorama:{value:null},uSkyFace:{value:basic.map??null},uSkyColor:{value:basic.color?.clone()??new THREE.Color()},
      uSkyRadianceLimit:{value:1e20},uSkyHasFace:{value:basic.map?1:0},uSkyMode:{value:0},uSkyYaw:{value:0},uSkyExposure:{value:1},uSkySun:{value:new THREE.Vector3()},uSkyHasSun:{value:0},uSkyViewport:{value:new THREE.Vector4()},
      uSkyZenith:{value:source.uniforms?.zenith?.value?.clone()??new THREE.Color(.065,.25,.59)},uSkyHorizon:{value:source.uniforms?.horizon?.value?.clone()??new THREE.Color(.54,.7,.82)},uSkyGround:{value:source.uniforms?.ground?.value?.clone()??new THREE.Color(.25,.3,.35)},
      uCloudTexture:{value:null},uCloudResolution:{value:new THREE.Vector2(1,1)},uCloudCompositeActive:{value:0},
    }, vertexShader:`varying vec3 skyRay;varying vec2 skyUV;void main(){skyUV=uv;skyRay=(modelMatrix*vec4(position,1.)).xyz-cameraPosition;vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.);gl_Position=p.xyww;}`,
    fragmentShader:`uniform samplerCube uSkyCube;uniform sampler2D uSkyPanorama,uSkyFace;uniform float uSkyHasFace,uSkyMode,uSkyYaw,uSkyExposure,uSkyHasSun,uSkyRadianceLimit;uniform vec3 uSkyColor,uSkySun,uSkyZenith,uSkyHorizon,uSkyGround;uniform vec4 uSkyViewport;varying vec3 skyRay;varying vec2 skyUV;
      ${CLOUD_COMPOSITE_GLSL}
      void main(){vec3 ray=normalize(skyRay);float c=cos(uSkyYaw),s=sin(uSkyYaw);vec3 sampleRay=vec3(c*ray.x-s*ray.z,ray.y,s*ray.x+c*ray.z);vec3 color;
      if(uSkyMode>3.5){vec2 uv=vec2(atan(sampleRay.z,sampleRay.x)*.159154943+.5,asin(clamp(sampleRay.y,-1.,1.))*.318309886+.5);color=texture2D(uSkyPanorama,uv).rgb;}
      else if(uSkyMode>2.5){color=textureCube(uSkyCube,sampleRay).rgb;}
      else if(uSkyMode>.5){color=ray.y>0.?mix(uSkyHorizon,uSkyZenith,pow(ray.y,uSkyMode>1.5?.42:.55)):mix(uSkyHorizon,uSkyGround,pow(min(-ray.y*3.,1.),.7));float mu=max(0.,dot(ray,uSkySun));color+=uSkyHasSun*(vec3(1.,.79,.49)*pow(mu,24.)*.15+vec3(3.6,3.25,2.65)*smoothstep(cos(.0052),cos(.0043),mu));}
      else{color=uSkyColor;if(uSkyHasFace>.5)color*=texture2D(uSkyFace,skyUV).rgb;}
      color*=uSkyExposure;color=cloudOverSky(color,(gl_FragCoord.xy-uSkyViewport.xy)/uSkyViewport.zw);float peak=max(color.r,max(color.g,color.b));color*=min(1.,uSkyRadianceLimit/max(peak,1e-6));gl_FragColor=vec4(color,1.);
      #include <colorspace_fragment>
      }`,
    });
    if(original.userData.waterFog)withShaderSkyWaterFog(material);
    material.onBeforeRender=(renderer,_scene,camera)=>{
      this.options?.clouds?.prepare(camera);
      renderer.getCurrentViewport(material.uniforms.uSkyViewport.value);
      // Exposure can push a bright HDR sun beyond half-float attachment range. Preserve hue and finite values.
      material.uniforms.uSkyRadianceLimit.value=renderer.getRenderTarget()?.texture.type===THREE.HalfFloatType?60000:1e20;
    };
    return material;
  }
  run<T>(scene: THREE.Scene, asset: LoadedSky | null, options: SkyDrawOptions, draw: () => T): T {
    this.options=options;
    if(options.mode==='map'&&!options.clouds){this.dispose();return draw();}
    const used=new Set<THREE.Material>();
    const swapped:[THREE.Mesh,THREE.Material|THREE.Material[]][]=[];
    scene.traverse(object=>{if(!(object instanceof THREE.Mesh)||object.renderOrder!==-1000)return;
      const originals=Array.isArray(object.material)?object.material:[object.material];
      const replacements=originals.map(original=>{used.add(original);
        let material=this.materials.get(original);if(!material){material=this.create(original);this.materials.set(original,material);const release=()=>this.release(original);this.listeners.set(original,release);original.addEventListener("dispose",release);}
        const basic=original as THREE.MeshBasicMaterial,source=original as THREE.ShaderMaterial;
        material.uniforms.uSkyMode.value=options.mode==='pack'&&asset?(asset.format==='cube'?3:4):options.mode==='procedural'?2:source.uniforms?.zenith?1:0;
        material.uniforms.uSkyCube.value=asset?.format==='cube'?asset.texture:null;material.uniforms.uSkyPanorama.value=asset?.format==='equirect'?asset.texture:null;
        material.uniforms.uSkyFace.value=basic.map??null;material.uniforms.uSkyHasFace.value=basic.map?1:0;material.uniforms.uSkyYaw.value=options.yaw;material.uniforms.uSkyExposure.value=options.mode==='pack'&&asset?options.exposure:1;
        material.uniforms.uSkyHasSun.value=options.sun?1:0;if(options.sun)material.uniforms.uSkySun.value.copy(options.sun.direction);
        if(options.mode==='procedural'){material.uniforms.uSkyZenith.value.setRGB(.065,.25,.59);material.uniforms.uSkyHorizon.value.setRGB(.54,.7,.82);}
        if(options.clouds)Object.assign(material.uniforms,options.clouds.uniforms);else material.uniforms.uCloudCompositeActive.value=0;
        return material;
      });
      swapped.push([object,object.material]);object.material=Array.isArray(object.material)?replacements:replacements[0]!;
    });
    try{return draw();}finally{for(const[object,material]of swapped)object.material=material;for(const original of this.materials.keys())if(!used.has(original))this.release(original);}
  }
  dispose():void{for(const original of [...this.materials.keys()])this.release(original);this.options=null;}
}
