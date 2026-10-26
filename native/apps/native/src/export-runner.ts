// Original procedural runner geometry. T(z,x,y) converts its Y-up/+Z bind frame to Source Z-up/+X.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {BONES,createBones,playerGeometry,PALETTE} from '../../web/src/player/rig';
const output=resolve(process.argv[2]??'target/native-assets'),g=playerGeometry(),p=g.getAttribute('position'),n=g.getAttribute('normal'),c=g.getAttribute('partColor'),a=g.getAttribute('accent'),ids=g.getAttribute('skinIndex'),weights=g.getAttribute('skinWeight');
const verts:number[]=[],indices=new Uint32Array(p.count),seen=new Map<string,number>();
for(let i=0;i<p.count;i++){const v=new Float32Array(22);v.set([p.getZ(i),p.getX(i),p.getY(i),n.getZ(i),n.getX(i),n.getY(i),c.getX(i),c.getY(i),c.getZ(i)]);for(let k=0;k<4;k++){v[9+k]=ids.array[i*4+k];v[13+k]=weights.array[i*4+k];}v[17]=a.getX(i);const key=Buffer.from(v.buffer).toString('base64');let at=seen.get(key);if(at===undefined){at=verts.length/22;seen.set(key,at);verts.push(...v);}indices[i]=at;}
const bytes=Buffer.from(new Float32Array(verts).buffer),bones=createBones();bones[0].updateMatrixWorld(true);
const rig={names:BONES,parent:bones.map(b=>bones.indexOf(b.parent as typeof b)),bind:bones.map(b=>[b.matrixWorld.elements[12],b.matrixWorld.elements[13],b.matrixWorld.elements[14]])};
await mkdir(output,{recursive:true});await writeFile(resolve(output,'runner.bin'),Buffer.concat([bytes,Buffer.from(indices.buffer)]));await writeFile(resolve(output,'runner.json'),JSON.stringify({version:1,stride:22,vertices:verts.length/22,indices:indices.length,indexOffset:bytes.length,bytes:bytes.length+indices.byteLength,rig,accent:PALETTE.accent}));console.log(`Original runner: ${verts.length/22} vertices, ${indices.length/3} triangles, ${BONES.length} bones`);
