import * as THREE from "three";
import { DEFAULT_PATTERNS } from "../lightstyles";
import { PROP_TRANSFORM_KEY, type BrushTransform } from "../core";
export interface AuthoredLocalLight {
  id: number; kind: "point" | "spot"; position: THREE.Vector3; direction: THREE.Vector3;
  color: THREE.Color; intensity: number; range: number; innerCos: number; outerCos: number;
  getBaseline?: () => AuthoredLocalLight;
  bakedStyle?: boolean;
  enabled: boolean; sourceClass: string; worldEnabled: boolean; modelsEnabled: boolean;
}
const number = (raw: string | undefined, fallback: number) => raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : fallback;
const vector = (raw: string | undefined): THREE.Vector3 | null => { const v = (raw ?? "").trim().split(/\s+/).map(Number); return v.length === 3 && v.every(Number.isFinite) ? new THREE.Vector3(...v as [number,number,number]) : null; };
const world = (source: THREE.Vector3) => new THREE.Vector3(source.x, source.z, -source.y);
const matrix = (position: THREE.Vector3, angles: THREE.Vector3) => new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(new THREE.Euler(angles.z*Math.PI/180,angles.x*Math.PI/180,angles.y*Math.PI/180,"ZYX")), new THREE.Vector3(1,1,1));
/** Authored Source entity lights, distinct from invented map-independent illumination. */
export function authoredLocalLights(entities: readonly Record<string,string>[]) {
  const lights: AuthoredLocalLight[] = [];
  const updates: ((transforms: Map<number,BrushTransform>, states?: Map<number,boolean>, time?: number) => void)[] = [];
  entities.forEach((entity, id) => {
    const sourceClass = entity.classname?.toLowerCase(); if (!sourceClass || !["light","light_spot","light_dynamic"].includes(sourceClass)) return;
    const origin = vector(entity.origin); if (!origin) return;
    const flags = number(entity.spawnflags,0), dynamic = sourceClass === "light_dynamic";
    const raw = (entity._light ?? entity.rendercolor ?? "255 255 255 200").trim().split(/\s+/).map(Number);
    if (!raw.slice(0,3).every(Number.isFinite)) return;
    const color = new THREE.Color().setRGB(THREE.MathUtils.clamp(raw[0]??255,0,255)/255,THREE.MathUtils.clamp(raw[1]??255,0,255)/255,THREE.MathUtils.clamp(raw[2]??255,0,255)/255,THREE.SRGBColorSpace);
    const intensity = dynamic ? Math.min(4,2**THREE.MathUtils.clamp(number(entity.brightness,0),-4,6)/4) : THREE.MathUtils.clamp((raw[3]??200)/200,0,4);
    const explicitRange = number(entity._zero_percent_distance,number(entity.distance,number(entity._distance,number(entity._fifty_percent_distance,0)*2)));
    const range = THREE.MathUtils.clamp(explicitRange > 0 ? explicitRange : Math.sqrt(Math.max(1,raw[3]??200))*32,64,2048);
    const angles = vector(entity.angles) ?? new THREE.Vector3();
    const pitch = (entity.pitch === undefined ? angles.x : -number(entity.pitch,0))*Math.PI/180, yaw=number(entity.angle,angles.y)*Math.PI/180;
    const sourceDirection = new THREE.Vector3(Math.cos(pitch)*Math.cos(yaw),Math.cos(pitch)*Math.sin(yaw),-Math.sin(pitch));
    const outer = number(entity._cone,sourceClass === "light_spot" ? 45 : 0);
    const kind = sourceClass === "light_spot" || (dynamic && outer > 0 && outer < 90) ? "spot" : "point";
    const outerAngle = THREE.MathUtils.clamp(outer || 45,2,85), innerAngle=THREE.MathUtils.clamp(number(entity._inner_cone,outerAngle*.7),0,outerAngle-.01);
    const light: AuthoredLocalLight = { id,sourceClass,kind,position:world(origin),direction:world(sourceDirection).normalize(),color,intensity,range,innerCos:Math.cos(innerAngle*Math.PI/180),outerCos:Math.cos(outerAngle*Math.PI/180),enabled:dynamic || !(flags&1),worldEnabled:!dynamic || !(flags&1),modelsEnabled:!dynamic || !(flags&2) };
    light.bakedStyle = !dynamic && (number(entity.style,number(entity.defaultstyle,0)) > 0 || !!entity.pattern);
    const target = entities.find(e => e.targetname && e.targetname === entity.target);
    const authoredTarget = vector(target?.origin);
    const baselineDirection = authoredTarget && authoredTarget.distanceToSquared(origin)>1e-5 ? authoredTarget.clone().sub(origin).normalize() : sourceDirection.clone();
    // Lazy spawn metadata for optional render-only delta lighting. No snapshot allocations while unused.
    light.getBaseline = () => ({ id,sourceClass,kind,position:world(origin),direction:world(baselineDirection).normalize(),color:new THREE.Color().setRGB((raw[0]??255)/255,(raw[1]??255)/255,(raw[2]??255)/255,THREE.SRGBColorSpace),intensity:dynamic?0:intensity,range,innerCos:light.innerCos,outerCos:light.outerCos,enabled:!dynamic && !(flags&1),worldEnabled:!dynamic || !(flags&1),modelsEnabled:!dynamic || !(flags&2),bakedStyle:light.bakedStyle });
    lights.push(light);
    const parentIndex = entities.findIndex(e => e.targetname && e.targetname === entity.parentname?.split(",")[0]);
    const parent = entities[parentIndex], parentModel = parent?.model?.startsWith("*") ? Number(parent.model.slice(1)) : parent?.classname?.startsWith("prop_") ? PROP_TRANSFORM_KEY+parentIndex : null;
    const parentInverse = parent ? matrix(vector(parent.origin)??new THREE.Vector3(),vector(parent.angles)??new THREE.Vector3()).invert() : null;
    const pattern=(entity.pattern ?? DEFAULT_PATTERNS[number(entity.style,number(entity.defaultstyle,0))] ?? "m").toLowerCase().replace(/[^a-z]/g,"") || "m";
    updates.push((transforms,states,time=0) => {
      light.intensity=intensity*(pattern.charCodeAt(Math.floor(Math.max(0,time)*10)%pattern.length)-97)/12;
      light.enabled = states?.get(id) ?? (dynamic || !(flags&1));
      let pos=origin.clone(),dir=sourceDirection.clone(); const transform=parentModel===null ? null : transforms.get(parentModel);
      if(transform && parentInverse){const delta=matrix(new THREE.Vector3(transform[0],transform[1],transform[2]),new THREE.Vector3(transform[3],transform[4],transform[5])).multiply(parentInverse);pos.applyMatrix4(delta);dir.transformDirection(delta);}
      if(target){let targetPos=vector(target.origin);const model=target.model?.startsWith("*") ? Number(target.model.slice(1)) : null;const moved=model===null?null:transforms.get(model);if(moved)targetPos=new THREE.Vector3(moved[0],moved[1],moved[2]);if(targetPos && targetPos.distanceToSquared(pos)>1e-5)dir.copy(targetPos).sub(pos).normalize();}
      light.position.copy(world(pos)); light.direction.copy(world(dir).normalize());
    });
  });
  return { lights, update(transforms: Map<number,BrushTransform>,states?:Map<number,boolean>,time=0) { for(const update of updates) update(transforms,states,time); } };
}
