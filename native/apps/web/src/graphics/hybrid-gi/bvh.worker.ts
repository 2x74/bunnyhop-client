import * as THREE from "three";
import { MeshBVH, SAH } from "three-mesh-bvh";
self.onmessage = (event: MessageEvent<{position:Float32Array;index:Uint32Array}>) => {
  const {position,index}=event.data;
  try {
    const geometry=new THREE.BufferGeometry();geometry.setAttribute("position",new THREE.BufferAttribute(position,3));geometry.setIndex(new THREE.BufferAttribute(index,1));
    const bvh=new MeshBVH(geometry,{strategy:SAH,maxDepth:28,maxLeafSize:8,indirect:true});
    const serialized=MeshBVH.serialize(bvh,{cloneBuffers:false});
    const indirect=(serialized as typeof serialized&{indirectBuffer?:Uint32Array}).indirectBuffer;
    const buffers=[position.buffer,index.buffer,...serialized.roots,indirect?.buffer].filter(Boolean) as ArrayBuffer[];
    (self as unknown as {postMessage:(value:unknown,transfer:ArrayBuffer[])=>void}).postMessage({serialized,position,index},Array.from(new Set(buffers)));
  }catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}
};
