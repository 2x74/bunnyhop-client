import * as THREE from "three";
import { materialDetailState } from "../../material-detail";
import { preserveHybridState } from "./pass-state";
import { sourceIsVisible, sourceIsDynamic, sourceIsSky, sourceIsShadowOnly } from "./source-policy";
import type { DenoiseBuffers } from "./temporal-denoise";
const VERTEX_INSERT = `#include <project_vertex>
vec4 giPosition=vec4(transformed,1.);vec3 giObjectNormal=normal;
#ifdef USE_BATCHING
giPosition=batchingMatrix*giPosition;giObjectNormal=transpose(inverse(mat3(batchingMatrix)))*giObjectNormal;
#endif
#ifdef USE_INSTANCING
giPosition=instanceMatrix*giPosition;giObjectNormal=transpose(inverse(mat3(instanceMatrix)))*giObjectNormal;
#endif
vGIWorld=(modelMatrix*giPosition).xyz;
#ifdef USE_SKINNING
vGINormal=inverseTransformDirection(normalize(transformedNormal),viewMatrix);
#else
#ifdef FLIP_SIDED
giObjectNormal=-giObjectNormal;
#endif
vGINormal=inverseTransformDirection(normalize(normalMatrix*giObjectNormal),viewMatrix);
#endif`;
const DECL = `varying vec3 vGIWorld,vGINormal;uniform sampler2D giNormalMap;uniform vec2 giTexel;uniform float giNormalStrength,giNormalY,giHasNormal,giNormalEnabled,giShowcase,giRelief,giStable,giAlbedoKind;
vec3 giPerturb(vec3 n,vec2 uv,vec3 sampled){vec3 dx=dFdx(vGIWorld),dy=dFdy(vGIWorld);vec2 du=dFdx(uv),dv=dFdy(uv);vec3 t=cross(dy,n)*du.x+cross(n,dx)*dv.x,b=cross(dy,n)*du.y+cross(n,dx)*dv.y;float scale=max(dot(t,t),dot(b,b));if(scale<1.e-12)return n;return normalize(mat3(t*inversesqrt(scale),b*inversesqrt(scale),n)*normalize(sampled));}`;
/** Two small original-albedo/normal raster passes. Never samples beauty or baked lightmaps. */
export class HybridGBuffer {
  private normalTarget: THREE.WebGLRenderTarget|null=null;private albedoTarget:THREE.WebGLRenderTarget|null=null;private width=0;private height=0;
  private scene=new THREE.Scene();private sources=new Map<THREE.Mesh,THREE.Mesh>();
  private materials=new Map<string,{source:THREE.Material;normal:THREE.MeshBasicMaterial;albedo:THREE.MeshBasicMaterial;uniforms:Record<string,THREE.IUniform>}>();
  private disposed=false;private stats={draws:0,allocations:0,meshes:0,unreliableMeshes:0,width:0,height:0,bytes:0};
  constructor(private renderer:THREE.WebGLRenderer){}
  setSize(width:number,height:number){width=Math.max(1,Math.floor(width));height=Math.max(1,Math.floor(height));if(this.width===width&&this.height===height)return;
    this.normalTarget?.dispose();this.albedoTarget?.dispose();this.width=width;this.height=height;
    this.normalTarget=new THREE.WebGLRenderTarget(width,height,{type:THREE.HalfFloatType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:true});this.normalTarget.depthTexture=new THREE.DepthTexture(width,height,THREE.UnsignedIntType);
    this.albedoTarget=new THREE.WebGLRenderTarget(width,height,{type:THREE.HalfFloatType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:true});this.stats.allocations+=2;this.stats.width=width;this.stats.height=height;this.stats.bytes=width*height*24;
  }
  private captureMaterial(source:THREE.Material,stable:boolean){const key=source.uuid+':'+stable;const cached=this.materials.get(key);if(cached)return cached;
    const m=source as THREE.MeshBasicMaterial&{surfaceNormalMap?:THREE.Texture};const response=m.userData.surfaceResponse,channels=m.userData.materialChannels??{};
    const uniforms:Record<string,THREE.IUniform>={giNormalMap:{value:m.surfaceNormalMap??null},giNormalStrength:{value:channels.normalStrength??.65},giNormalY:{value:channels.normalConvention==='directx'?-1:1},giHasNormal:{value:m.surfaceNormalMap?1:0},giTexel:{value:new THREE.Vector2()},giNormalEnabled:{value:0},giShowcase:{value:0},giRelief:{value:response?.relief??0},giStable:{value:stable?1:0},giAlbedoKind:{value:m.userData.showcaseAlbedo??0}};
    const make=(normal:boolean)=>{const material=new THREE.MeshBasicMaterial({map:m.map??null,color:m.color?.clone()??new THREE.Color(1,1,1),alphaMap:m.alphaMap??null,alphaTest:m.alphaTest,opacity:m.opacity,side:m.side,depthWrite:true,depthTest:true,transparent:false,vertexColors:false,fog:false,toneMapped:false});
      material.onBeforeCompile=(shader,renderer)=>{
        m.userData.giDiffuseHook?.call(material,shader,renderer);Object.assign(shader.uniforms,uniforms);
        shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vGIWorld,vGINormal;').replace('#include <project_vertex>',VERTEX_INSERT);
        shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\n'+DECL);
        const albedo=`if(giShowcase>.5&&giAlbedoKind>.5){if(giAlbedoKind<1.5){float l=dot(diffuseColor.rgb,vec3(.2126,.7152,.0722));diffuseColor.rgb=mix(diffuseColor.rgb,vec3(l),.38)*vec3(1.,.98,.88);}else diffuseColor.rgb*=vec3(.72,.92,1.14);}`;
        const normalCode=`vec3 n=normalize(vGINormal)*(gl_FrontFacing?1.:-1.);
#ifdef USE_MAP
if(giNormalEnabled>.5){if(giHasNormal>.5){vec3 sampleN=texture2D(giNormalMap,vMapUv).rgb*2.-1.;sampleN.xy*=giNormalStrength;sampleN.y*=giNormalY;n=giPerturb(n,vMapUv,dot(sampleN,sampleN)>1.e-8?sampleN:vec3(0.,0.,1.));}
else if(giShowcase>.5&&giRelief>0.){vec3 l=vec3(.2126,.7152,.0722);float hx=dot(texture2D(map,vMapUv+vec2(giTexel.x,0.)).rgb-texture2D(map,vMapUv-vec2(giTexel.x,0.)).rgb,l),hy=dot(texture2D(map,vMapUv+vec2(0.,giTexel.y)).rgb-texture2D(map,vMapUv-vec2(0.,giTexel.y)).rgb,l);float footprint=max(length(dFdx(vMapUv)/giTexel),length(dFdy(vMapUv)/giTexel));float fade=1.-smoothstep(1.,4.,footprint);n=giPerturb(n,vMapUv,vec3(-hx*giRelief*fade,-hy*giRelief*fade,1.));}}
#endif
 gl_FragColor=vec4(n*.5+.5,giStable);`;
        shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',normal?normalCode:albedo+'gl_FragColor=vec4(clamp(diffuseColor.rgb,vec3(0.),vec3(1.)),giStable);').replace('#include <tonemapping_fragment>','').replace('#include <colorspace_fragment>','').replace('#include <fog_fragment>','');
      };material.customProgramCacheKey=()=>`hybrid-gbuffer-v1-${normal}-${stable}-${m.userData.giDiffuseHook?.toString()??''}`;return material;
    };
    const pair={source,normal:make(true),albedo:make(false),uniforms};this.materials.set(key,pair);return pair;
  }
  update(source:THREE.Scene,camera:THREE.Camera):DenoiseBuffers{
    if(this.disposed)throw Error('GBuffer disposed');if(!this.normalTarget)this.setSize(320,180);source.updateMatrixWorld(true);const seen=new Set<THREE.Mesh>();const usedMaterials=new Set<THREE.Material>();const state=materialDetailState();this.stats.unreliableMeshes=0;
    source.traverse(object=>{if(!(object instanceof THREE.Mesh)||!sourceIsVisible(object)||sourceIsSky(object)||sourceIsShadowOnly(object)||object.renderOrder===-999||object.geometry.getAttribute('center'))return;
      const originals=Array.isArray(object.material)?object.material:[object.material];for(const m of originals)usedMaterials.add(m);if(!originals.some(m=>m.visible&&m.depthTest&&m.colorWrite))return;
      seen.add(object);let clone=this.sources.get(object);if(!clone){clone=object.clone(false);clone.matrixAutoUpdate=false;clone.frustumCulled=false;this.sources.set(object,clone);this.scene.add(clone);}clone.geometry=object.geometry;clone.matrix.copy(object.matrixWorld);clone.layers.mask=object.layers.mask;
      const unstable=sourceIsDynamic(object);if(unstable)this.stats.unreliableMeshes++;
      const captured=originals.map(m=>{const stable=!unstable&&m instanceof THREE.MeshBasicMaterial&&!m.transparent&&m.depthWrite&&m.colorWrite&&!m.userData.sourceUnlit;const pair=this.captureMaterial(m,stable);for(const mat of [pair.normal,pair.albedo]){const original=m as THREE.MeshBasicMaterial;const before=!!mat.map;mat.map=original.map??null;mat.alphaMap=original.alphaMap??null;mat.alphaTest=original.alphaTest;mat.opacity=original.opacity;mat.visible=m.visible&&m.colorWrite;mat.side=m.side;if(original.color)mat.color.copy(original.color);if(before!==!!mat.map)mat.needsUpdate=true;}
        const channel=m.userData.materialChannels??{};const surface=m as THREE.MeshBasicMaterial&{surfaceNormalMap?:THREE.Texture};pair.uniforms.giNormalMap.value=surface.surfaceNormalMap??null;pair.uniforms.giHasNormal.value=surface.surfaceNormalMap?1:0;pair.uniforms.giNormalStrength.value=channel.normalStrength??.65;pair.uniforms.giNormalY.value=channel.normalConvention==='directx'?-1:1;
        const image=(m as THREE.MeshBasicMaterial).map?.image as {width?:number;height?:number}|undefined;pair.uniforms.giTexel.value.set(1/Math.max(1,image?.width??1),1/Math.max(1,image?.height??1));pair.uniforms.giNormalEnabled.value=state.enabled?1:0;pair.uniforms.giShowcase.value=state.showcase?1:0;return pair.normal;});
      clone.material=Array.isArray(object.material)?captured:captured[0];
      if(object instanceof THREE.SkinnedMesh&&(clone instanceof THREE.SkinnedMesh)){clone.skeleton=object.skeleton;clone.bindMatrix.copy(object.bindMatrix);clone.bindMatrixInverse.copy(object.bindMatrixInverse);}if(object.morphTargetInfluences)clone.morphTargetInfluences=object.morphTargetInfluences.slice();
    });
    for(const [original,clone]of this.sources)if(!seen.has(original)){this.scene.remove(clone);this.sources.delete(original);}for(const [key,pair]of this.materials)if(!usedMaterials.has(pair.source)){pair.normal.dispose();pair.albedo.dispose();this.materials.delete(key);}this.scene.updateMatrixWorld(true);this.stats.meshes=seen.size;this.stats.draws=0;
    const restore=preserveHybridState(this.renderer);try{this.renderer.xr.enabled=false;this.renderer.setScissorTest(false);this.renderer.autoClear=false;this.renderer.toneMapping=THREE.NoToneMapping;this.renderer.setClearColor(0,0);
      this.renderer.setRenderTarget(this.normalTarget);this.renderer.clear(true,true,false);this.renderer.render(this.scene,camera);this.stats.draws+=this.renderer.info.render.calls;
      for(const [original,clone]of this.sources){const originals=Array.isArray(original.material)?original.material:[original.material];const captured=originals.map(m=>this.captureMaterial(m,!sourceIsDynamic(original)&&m instanceof THREE.MeshBasicMaterial&&!m.transparent&&m.depthWrite&&m.colorWrite&&!m.userData.sourceUnlit).albedo);clone.material=Array.isArray(original.material)?captured:captured[0];}
      this.renderer.setRenderTarget(this.albedoTarget);this.renderer.clear(true,true,false);this.renderer.render(this.scene,camera);this.stats.draws+=this.renderer.info.render.calls;
      return{normalDepth:this.normalTarget!.texture,albedo:this.albedoTarget!.texture,depthTexture:this.normalTarget!.depthTexture!,width:this.width,height:this.height};
    }finally{restore();}
  }
  getStats(){return{...this.stats};}
  dispose(){if(this.disposed)return;this.disposed=true;this.normalTarget?.dispose();this.albedoTarget?.dispose();for(const m of this.materials.values()){m.normal.dispose();m.albedo.dispose();}this.materials.clear();this.sources.clear();this.scene.clear();this.stats.bytes=0;}
}
