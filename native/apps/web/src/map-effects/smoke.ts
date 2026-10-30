import * as THREE from "three";
import type { BrushTransform } from "../core";

export type EffectEntity = Record<string, string>;
export const value = (e: EffectEntity, k: string) => Object.entries(e).find(([n]) => n.toLowerCase() === k.toLowerCase())?.[1];
const number = (e: EffectEntity, k: string, fallback: number) => { const s = value(e, k); const n = s === undefined ? NaN : Number(s); return Number.isFinite(n) ? n : fallback; };
const vector = (s?: string): [number, number, number] => (s ?? "0 0 0").split(/\s+/).map(Number).slice(0, 3) as [number, number, number];
export const materialName = (s: string) => s.replace(/^materials\//i, "").replace(/\.vmt$/i, "").toLowerCase();
export function effectMaterialNames(entities: EffectEntity[]): string[] {
  return [...new Set(entities.flatMap(e => {
    const c = value(e, "classname")?.toLowerCase();
    const name = c === "env_smokestack" ? value(e, "SmokeMaterial") : c === "func_smokevolume" ? value(e, "material") : c === "env_spritetrail" ? value(e, "spritename") : undefined;
    return name ? [materialName(name)] : [];
  }))];
}
/** BSP dmodel bounds include nodraw brushes, which the render mesh deliberately omits. */
export function brushBounds(bsp?: Uint8Array): Map<number, THREE.Box3> {
  const out = new Map<number, THREE.Box3>();
  if (!bsp || bsp.length < 1036) return out;
  const d = new DataView(bsp.buffer, bsp.byteOffset, bsp.byteLength);
  const o = d.getInt32(8 + 14 * 16, true), n = d.getInt32(12 + 14 * 16, true);
  if (o < 0 || n < 0 || o + n > bsp.length || d.getInt32(20 + 14 * 16, true)) return out;
  for (let i = 0; i * 48 + 48 <= n; i++) {
    const p = o + i * 48;
    out.set(i, new THREE.Box3(new THREE.Vector3(...[0, 4, 8].map(k => d.getFloat32(p + k, true)) as [number, number, number]), new THREE.Vector3(...[12, 16, 20].map(k => d.getFloat32(p + k, true)) as [number, number, number])));
  }
  return out;
}
export function particleRandom(id: number, channel: number): number {
  let h = Math.imul(id ^ Math.imul(channel + 1, 0x9e3779b9), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/**
 * Coherent turbulent opacity, used only when the map's particle material is unavailable (smokestacks.ts too, denser:
 * a stack's puffs must still read as solid clouds where a map uses them as platforms).
 */
export function wispySmokeTexture(density = 1): THREE.DataTexture {
  const n = 128, pixels = new Uint8Array(n * n * 4);
  const smooth = (v: number) => v * v * (3 - 2 * v);
  const noise = (x: number, y: number, seed: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
    const at = (a: number, b: number) => particleRandom(a + b * 4099 + seed, 5);
    const lo = at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx;
    const hi = at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx;
    return lo * (1 - fy) + hi * fy;
  };
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = (x + .5) / n, v = (y + .5) / n;
    const warp = noise(u * 5, v * 5, 11);
    const r = Math.hypot((u - .5) * 2 + (warp - .5) * .45, (v - .5) * 2);
    const turbulence = noise(u * 6, v * 6, 23) * .55 + noise(u * 13, v * 13, 31) * .3 + noise(u * 27, v * 27, 47) * .15;
    const edge = Math.max(0, 1 - r);
    const opacity = Math.max(0, turbulence - .24) * edge ** 1.3 * .5;
    const i = (y * n + x) * 4;
    pixels[i] = pixels[i+1] = pixels[i+2] = 210 + turbulence * 35;
    pixels[i+3] = Math.min(1, opacity * density) * 255;
  }
  const t = new THREE.DataTexture(pixels, n, n); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; t.magFilter = THREE.LinearFilter; return t;
}
const vertex = `attribute vec3 center; attribute float size; attribute float opacity; attribute float spin; attribute vec3 tint; varying vec2 vUv; varying float vOpacity; varying vec3 vTint;
void main(){ vec4 p=modelViewMatrix*vec4(center,1.); float c=cos(spin),s=sin(spin); p.xy+=mat2(c,-s,s,c)*position.xy*size*2.; gl_Position=projectionMatrix*p; vUv=uv; vOpacity=opacity; vTint=tint; }`;
const fragment = `uniform sampler2D map; varying vec2 vUv; varying float vOpacity; varying vec3 vTint;
void main(){ vec4 t=texture2D(map,vUv); gl_FragColor=vec4(t.rgb*vTint,t.a*vOpacity); if(gl_FragColor.a<.005) discard; #include <tonemapping_fragment>\n #include <colorspace_fragment>\n }`.replace("; #include", ";\n #include");
interface Emitter { entity: number; model: number; origin: THREE.Vector3; volume?: THREE.Box3; mesh: THREE.Mesh; count: number; life: number; e: EffectEntity; }
export interface MapSmoke { root: THREE.Group; count: number; particles: number; update(time: number, transforms: Map<number, BrushTransform>, states?: Map<number, boolean>): void; }
/** Stateless particle evaluation: rendering a seek directly produces the same cloud as playing to that time. */
export function mapSmoke(entities: EffectEntity[], bounds: Map<number, THREE.Box3>, texture: (name: string) => THREE.Texture | null): MapSmoke | null {
  const root = new THREE.Group(); root.name = "map-smoke";
  const emitters: Emitter[] = []; let budget = 2048; const fallback = wispySmokeTexture();
  entities.forEach((e, entity) => {
    const classname = value(e,"classname")?.toLowerCase(); if (classname !== "env_smokestack" && classname !== "func_smokevolume") return;
    const volume = classname === "func_smokevolume" ? bounds.get(Number((value(e,"model")??"").slice(1)))?.clone() : undefined;
    if (classname === "func_smokevolume" && !volume) return;
    const origin = new THREE.Vector3(...vector(value(e,"origin")));
    const speed = Math.max(.1,number(e,"speed",30)), life = Math.min(60,Math.max(.1,number(e,"JetLength",200)/speed));
    const extent = volume?.getSize(new THREE.Vector3());
    const spacing = Math.max(16,number(e,"ParticleSpacingDistance",64));
    const desired = extent ? Math.ceil(extent.x/spacing)*Math.ceil(extent.y/spacing)*Math.ceil(extent.z/spacing) : Math.ceil(Math.max(0,number(e,"Rate",20))*life);
    const count = Math.min(budget,384,Math.max(1,desired)); if (budget<=0) return; budget-=count;
    const g = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1,1) as unknown as THREE.InstancedBufferGeometry); g.instanceCount=count;
    for(const [name,components] of [["center",3],["size",1],["opacity",1],["spin",1],["tint",3]] as const) g.setAttribute(name,new THREE.InstancedBufferAttribute(new Float32Array(count*components),components).setUsage(THREE.DynamicDrawUsage));
    const map=texture(materialName(value(e,volume?"material":"SmokeMaterial")??""))??fallback;
    const m=new THREE.ShaderMaterial({uniforms:{map:{value:map}},vertexShader:vertex,fragmentShader:fragment,transparent:true,depthWrite:false,side:THREE.DoubleSide});
    m.addEventListener("dispose", () => { if (map === fallback) fallback.dispose(); });
    const mesh=new THREE.Mesh(g,m); mesh.name=classname; mesh.renderOrder=3;
    const box=volume?.clone()??new THREE.Box3(origin.clone().addScalar(-number(e,"BaseSpread",20)),origin.clone().add(new THREE.Vector3(number(e,"BaseSpread",20),number(e,"BaseSpread",20),number(e,"JetLength",200))));
    box.expandByScalar(Math.max(number(e,"ParticleDrawWidth",192),number(e,"EndSize",30))+life*(number(e,"SpreadSpeed",15)+number(e,"WindSpeed",0))); g.boundingSphere=box.getBoundingSphere(new THREE.Sphere());
    root.add(mesh); emitters.push({entity,model:Number((value(e,"model")??"*-1").slice(1)),origin,volume,mesh,count,life,e});
  });
  if(!emitters.length){fallback.dispose();return null;}
  const mat=new THREE.Matrix4(), pos=new THREE.Vector3(), ext=new THREE.Vector3(), shift=new THREE.Vector3(), euler=new THREE.Euler(), c1=new THREE.Color(), c2=new THREE.Color();
  // Keyvalues read once per emitter: value() scans every key of the entity, and this used to run about a dozen times per
  // particle per frame. Same numbers, same expressions below, so the same cloud.
  const kv=emitters.map(a=>{const e=a.e;return{
    on:a.volume?number(e,"StartDisabled",0)===0:number(e,"InitialState",0)!==0,
    color1:vector(value(e,a.volume?"Color1":"rendercolor")??"255 255 255").map(v=>v/255) as [number,number,number],
    color2:vector(value(e,"Color2")??"255 255 255").map(v=>v/255) as [number,number,number],
    rate:Math.max(.01,number(e,"Rate",20)),movement:number(e,"MovementSpeed",10),drawWidth:number(e,"ParticleDrawWidth",128),density:number(e,"Density",.5),
    twist:number(e,"twist",0),baseSpread:number(e,"BaseSpread",20),spreadSpeed:number(e,"SpreadSpeed",15),windAngle:number(e,"WindAngle",0),windSpeed:number(e,"WindSpeed",0),
    speed:number(e,"speed",30),startSize:number(e,"StartSize",20),endSize:number(e,"EndSize",30),renderamt:number(e,"renderamt",255),rotation:number(e,a.volume?"RotationSpeed":"roll",0),
  };});
  const wrap=(v:number)=>v-Math.floor(v);
  return {root,count:emitters.length,particles:2048-budget,update(time,transforms,states){
    time=Math.max(0,Number.isFinite(time)?time:0);
    for(let ai=0;ai<emitters.length;ai++){ const a=emitters[ai], k=kv[ai], g=a.mesh.geometry; const tf=transforms.get(a.model);
      a.mesh.visible=states?.get(a.entity)??k.on; if(!a.mesh.visible)continue;
      const p=g.getAttribute("center") as THREE.InstancedBufferAttribute,s=g.getAttribute("size"),alpha=g.getAttribute("opacity"),spin=g.getAttribute("spin"),tint=g.getAttribute("tint");
      c1.setRGB(k.color1[0],k.color1[1],k.color1[2],THREE.SRGBColorSpace); c2.setRGB(k.color2[0],k.color2[1],k.color2[2],THREE.SRGBColorSpace);
      if(tf){mat.makeRotationFromEuler(euler.set(tf[5]*Math.PI/180,tf[3]*Math.PI/180,tf[4]*Math.PI/180,"ZYX"));shift.set(tf[0],tf[1],tf[2]);}
      const rate=k.rate, newest=Math.floor(time*rate), seed=a.entity*100003;
      if(a.volume)a.volume.getSize(ext);
      for(let j=0;j<a.count;j++){const id=a.volume?j:newest-j; const age=a.volume?0:time-id/rate; let size:number,fade:number;
        if(a.volume){const b=a.volume, velocity=k.movement; pos.set(b.min.x+wrap(particleRandom(id+seed,0)+time*velocity/Math.max(1,ext.x))*ext.x,b.min.y+wrap(particleRandom(id+seed,1)+time*velocity*.61/Math.max(1,ext.y))*ext.y,b.min.z+wrap(particleRandom(id+seed,2)+time*velocity*.37/Math.max(1,ext.z))*ext.z); size=k.drawWidth*.5;fade=Math.min(1,Math.max(0,k.density)); }
        else{const f=age/a.life, theta=particleRandom(id+seed,0)*Math.PI*2+age*k.twist*Math.PI/180, radius=Math.sqrt(particleRandom(id+seed,1))*k.baseSpread+age*k.spreadSpeed*particleRandom(id+seed,2); const wind=k.windAngle*Math.PI/180;pos.set(a.origin.x+Math.cos(theta)*radius+Math.cos(wind)*age*k.windSpeed,a.origin.y+Math.sin(theta)*radius+Math.sin(wind)*age*k.windSpeed,a.origin.z+age*k.speed);size=k.startSize+(k.endSize-k.startSize)*f;fade=id>=0&&age<a.life?(.5-.5*Math.cos(Math.min(1,Math.max(0,f))*Math.PI*2))**(f>.5?2:1)*Math.min(1,Math.max(0,k.renderamt/255)):0;}
        if(tf&&a.volume)pos.sub(a.origin).applyMatrix4(mat).add(shift); p.setXYZ(j,pos.x,pos.y,pos.z);s.setX(j,size);alpha.setX(j,fade);spin.setX(j,particleRandom(id+seed,3)*Math.PI*2+time*k.rotation*Math.PI/180);const mix=a.volume?particleRandom(id+seed,4):0;tint.setXYZ(j,c1.r+(c2.r-c1.r)*mix,c1.g+(c2.g-c1.g)*mix,c1.b+(c2.b-c1.b)*mix);
      }
      p.needsUpdate=s.needsUpdate=alpha.needsUpdate=spin.needsUpdate=tint.needsUpdate=true;
    }
  }};
}
