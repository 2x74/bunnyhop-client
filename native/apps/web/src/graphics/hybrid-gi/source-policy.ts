import * as THREE from "three";
export function sourceIsVisible(object: THREE.Object3D): boolean { for(let p:THREE.Object3D|null=object;p;p=p.parent)if(!p.visible)return false;return true; }
export function sourceIsDynamic(object: THREE.Mesh): boolean {
  if(object instanceof THREE.SkinnedMesh||/^prop-\d+$/.test(object.name))return true;
  for(let p:THREE.Object3D|null=object;p;p=p.parent)if(p instanceof THREE.Bone||p.userData.giDynamic||p.userData.sunShadowOnly)return true;
  return false;
}
export function sourceIsSky(object: THREE.Object3D): boolean { for(let p:THREE.Object3D|null=object;p;p=p.parent)if(p.renderOrder<=-1000||p.name==='sky3d'||p.name==='sky3d-pass')return true;return false; }
export function sourceIsShadowOnly(object: THREE.Object3D): boolean {for(let p:THREE.Object3D|null=object;p;p=p.parent)if(p.userData.sunShadowOnly)return true;return false;}
/** Core world buffers share positions between brush models; default boundingBox would include the whole map. */
export function selectedGeometryBounds(mesh:THREE.Mesh):THREE.Box3 {
  const g=mesh.geometry,p=g.getAttribute('position'),index=g.index,box=new THREE.Box3(),point=new THREE.Vector3(),base=new THREE.Vector3(),skinMatrix=new THREE.Matrix4();if(mesh instanceof THREE.SkinnedMesh)mesh.skeleton.update();
  const total=index?.count??p.count,groups=g.groups.length?g.groups:[{start:0,count:total}];
  for(const group of groups)for(let i=group.start;i<Math.min(total,group.start+group.count);i++){const vertex=index?index.getX(i):i;if(mesh instanceof THREE.SkinnedMesh&&mesh.skeleton.boneMatrices){THREE.Mesh.prototype.getVertexPosition.call(mesh,vertex,base);base.applyMatrix4(mesh.bindMatrix);point.set(0,0,0);const joints=g.getAttribute('skinIndex'),weights=g.getAttribute('skinWeight');for(let k=0;k<4;k++){const weight=weights.getComponent(vertex,k);if(weight===0)continue;skinMatrix.fromArray(mesh.skeleton.boneMatrices,joints.getComponent(vertex,k)*16);point.addScaledVector(new THREE.Vector3().copy(base).applyMatrix4(skinMatrix),weight);}point.applyMatrix4(mesh.bindMatrixInverse);}else point.fromBufferAttribute(p,vertex);box.expandByPoint(point);}return box;
}

export function sourceIsDisabled(object:THREE.Object3D):boolean {for(let p:THREE.Object3D|null=object;p;p=p.parent)if(p.userData.giDisabled)return true;return false;}
const skinBoundsCache=new WeakMap<THREE.BufferGeometry,{version:string;position:object;joints:object;weights:object;boxes:THREE.Box3[];normalized:boolean}>();
/** Conservative convex union of per-bone influenced vertex bounds; avoids posing every vertex per frame. */
export function posedGeometryBounds(mesh:THREE.Mesh):THREE.Box3 {
 if(!(mesh instanceof THREE.SkinnedMesh)||mesh.morphTargetInfluences?.some(x=>x!==0))return selectedGeometryBounds(mesh);
 const g=mesh.geometry,p=g.getAttribute('position'),j=g.getAttribute('skinIndex'),w=g.getAttribute('skinWeight');if(!j||!w)return selectedGeometryBounds(mesh);
 const version=JSON.stringify([p instanceof THREE.InterleavedBufferAttribute?p.data.version:p.version,j instanceof THREE.InterleavedBufferAttribute?j.data.version:j.version,w instanceof THREE.InterleavedBufferAttribute?w.data.version:w.version,g.index?.version,g.groups]);let cached=skinBoundsCache.get(g);
 if(!cached||cached.version!==version||cached.position!==p||cached.joints!==j||cached.weights!==w){let normalized=true;const boxes:THREE.Box3[]=[],point=new THREE.Vector3(),seen=new Set<number>();const index=g.index,total=index?.count??p.count,groups=g.groups.length?g.groups:[{start:0,count:total}];for(const group of groups)for(let n=group.start;n<Math.min(total,group.start+group.count);n++){const v=index?index.getX(n):n;if(seen.has(v))continue;seen.add(v);point.fromBufferAttribute(p,v);let sum=0;for(let k=0;k<4;k++){const weight=w.getComponent(v,k);sum+=weight;if(weight<0)normalized=false;}if(Math.abs(sum-1)>1.e-4)normalized=false;for(let k=0;k<4;k++){const weight=w.getComponent(v,k);if(weight<=0)continue;const bone=j.getComponent(v,k);(boxes[bone]??=new THREE.Box3()).expandByPoint(point);}}cached={version,position:p,joints:j,weights:w,boxes,normalized};skinBoundsCache.set(g,cached);}
 if(!cached.normalized)return selectedGeometryBounds(mesh);
 mesh.skeleton.update();if(!mesh.skeleton.boneMatrices)return selectedGeometryBounds(mesh);const bounds=new THREE.Box3(),matrix=new THREE.Matrix4(),boneMatrix=new THREE.Matrix4();for(let i=0;i<cached.boxes.length;i++){const box=cached.boxes[i],bone=mesh.skeleton.bones[i];if(!box||!bone)continue;boneMatrix.fromArray(mesh.skeleton.boneMatrices,i*16);matrix.copy(mesh.bindMatrixInverse).multiply(boneMatrix).multiply(mesh.bindMatrix);bounds.union(box.clone().applyMatrix4(matrix));}return bounds;
}
