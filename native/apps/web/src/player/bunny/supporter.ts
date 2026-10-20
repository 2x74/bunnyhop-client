// Supporter model prototypes. Authored in the game's bind pose and skinned with
// the same builder as the standard bunny; no changes to movement or collision.
import { cr, Builder, add, scale, norm, sub, ring, frame, lerp3, type Paint, type Wt } from "./builder";
import { rig, type V3 } from "./rig";
const X: V3 = [1,0,0], Y: V3 = [0,1,0], Z: V3 = [0,0,1];
const cream: Paint = {code:3}, trim: Paint = {code:4}, black: Paint = {code:8};
const gold: Paint = {code:1}, light: Paint = {code:2};
const thread: Paint = {code:0, color:0xb48a54};

function ellipsoid(b: Builder, c: V3, radii: V3, paint: Paint, w: Wt) {
  b.surface(b.ellipsoidRows(c,radii,Z,X,28,18), {paint:()=>paint, weight:()=>w});
}
function circle(b: Builder, c: V3, axis: V3, radius: number, thickness: number, paint: Paint, w: Wt) {
  const [,u,v] = frame(axis, Z);
  const path = Array.from({length:33},(_,i)=>add(c,add(scale(u,Math.cos(i/32*Math.PI*2)*radius),scale(v,Math.sin(i/32*Math.PI*2)*radius))));
  b.tube(path,thickness,8,axis,()=>paint,()=>w,false);
}
function stitches(b: Builder, path: V3[], w: (p:V3)=>Wt, paint=thread) {
  for(let i=0;i+1<path.length;i+=2) b.tube([path[i],path[i+1]],0.075,5,Y,()=>paint,w);
}

export function supporterHead(b: Builder, kind: "plush"|"bune") {
  const firstVertex = b.vertexCount;
  const r=rig(), head=r.bone("Head1");
  const w: Wt=[[head,1]], plush=kind==="plush";
  const c: V3=[0,-0.1,70.2];
  const rx=plush?6.0:7.2, ry=plush?6.1:6.5, rz=plush?6.5:7.8;
  // A round stuffed hood / hard helmet, with a broad dark face inset.
  ellipsoid(b,c,[rx,ry,rz],cream,w);
  const f: V3=[0,-5.9,70];
  ellipsoid(b,f,[rx*0.79,2.3,rz*0.77],black,w);
  const rim=Array.from({length:49},(_,i):V3=>{const t=i/48*Math.PI*2;return [Math.cos(t)*rx*.81,-6.78,70+Math.sin(t)*rz*.80];});
  b.tube(rim,plush?.54:.31,8,Y,()=>plush?trim:cream,()=>w,false);
  // Curved gold eye band follows the black faceplate.
  const band=[70.35,71.85].map(z=>Array.from({length:25},(_,i):V3=>{const x=-rx*.71+i/24*rx*1.42;return [x,-6.08-2.48*Math.sqrt(Math.max(.05,1-(x/(rx*.79))**2-((z-70)/(rz*.77))**2)),z];}));
  b.surface(band,{closed:false,paint:()=>gold,weight:()=>w,out:()=>[0,-1,0]});
  for(const side of [-1,1]) {
    if (plush) {
      ellipsoid(b,[side*2.8,-8.36,71.12],[.82,.24,.82],{code:0,color:0xffe5a5},w);
      for (const z of [-.25,.25]) b.tube([[side*2.8-.25,-8.62,71.12+z],[side*2.8+.25,-8.62,71.12-z]],.07,5,Y,()=>thread,()=>w);
    } else {
      // Friendly crescent eyes, like the bot avatar: lifted corners, no eyeballs.
      const eye=Array.from({length:13},(_,i):V3=>{const t=i/12;return [side*2.65+(t-.5)*2.0,-8.35,70.95+Math.sin(t*Math.PI)*.65];});
      b.tube(eye,.22,8,Y,()=>light,()=>w);
    }
    if(!plush) {
      // Paired little cheek ticks and a smile retain Bun-E's friendly avatar.
      for(let k=0;k<2;k++) b.tube([[side*(2.5+k*.43),-7.96,68.7],[side*(2.7+k*.43),-7.94,69.12]],.09,5,Y,()=>gold,()=>w);
    }
  }
  ellipsoid(b,[0,-8.3,68.9],[.48,.2,.32],gold,w);
  if(!plush) b.tube([[-.9,-8.03,68.05],[-.45,-8.15,67.78],[0,-8.18,67.7],[.45,-8.15,67.78],[.9,-8.03,68.05]],.10,6,Y,()=>gold,()=>w);
  if(plush) {
    const seam=Array.from({length:33},(_,i):V3=>{const a=.3+i/32*2.7;return [0,.1-Math.cos(a)*6.18,70.2+Math.sin(a)*6.58];});
    stitches(b,seam,()=>w);
    // Visible stitches follow the rolled hood opening.
    stitches(b,rim.map(p=>[p[0]*1.035,p[1]-.44,70+(p[2]-70)*1.035]),()=>w);
  }
  for(const side of [-1,1]) {
    const name=side===1?"L":"R";
    const e=r.index(`bunny.Ear${name}`), e2=r.index(`bunny.Ear${name}2`);
    const ew=(i:number):Wt=>i<3?[[e,1]]:[[e,.35],[e2,.65]];
    const centers:V3[]=plush&&side===-1
      ? [[-3.8,1,75],[-4.7,1,78],[-5.8,.6,81],[-7.5,.0,83],[-9.5,-1,82],[-10.2,-1.8,80],[-10.4,-2.1,78.8]]
      : [[side*3.8,1,76],[side*4.7,1.3,79],[side*5.6,1.6,82],[side*6.5,1.8,85],[side*7.1,2,88],[side*7.3,2,90],[side*7.2,2,91]];
    const widths=plush?[1.4,2.05,2.5,2.55,2.1,1.3,.3]:[1.35,2.05,2.5,2.55,2.1,1.3,.15];
    const sample=(t:number):V3=>[0,1,2].map(k=>cr(centers.map(c=>c[k]),t)) as V3;
    const across=(t:number):V3=> { const d=norm(sub(sample(Math.min(6,t+.03)),sample(Math.max(0,t-.03)))); return norm([d[2],0,-d[0]]); };
    const samples = Array.from({length:31},(_,i)=>i/5);
    const rows=samples.map(t=>ring(sample(t),across(t),Y,cr(widths,t),plush?1.2:.65,20));
    b.surface(rows,{paint:()=>cream,weight:(_,i)=>ew(i/5),capStart:cream,capEnd:cream});
    // Smooth front inset follows the whole fold without twisting at its apex.
    const panel=Array.from({length:21},(_,j)=>{
      const t=1+j/5, p=sample(t), u=across(t), width=cr(widths,t)*.62;
      return [add(add(p,scale(u,-width)),[0,plush?-1.37:-.85,0]),add(add(p,scale(u,width)),[0,plush?-1.37:-.85,0])];
    });
    b.surface(panel,{closed:false,paint:()=>gold,weight:(_,i)=>ew(1+i/5),out:()=>[0,-1,0]});
    if(plush) {
      for(const edge of [0,1]) stitches(b,panel.map(row=>add(row[edge],[0,-.12,0])),()=>[[e,.5],[e2,.5]]);
    } else {
      // Ear hinge and headset with gold annular inserts.
      ellipsoid(b,[side*7.05,-.4,70.5],[1.55,3.15,3.55],trim,w);
      circle(b,[side*8.35,-.4,70.5],X,2.55,.30,gold,w);
      ellipsoid(b,[side*8.4,-.4,70.5],[.3,1.85,1.85],black,w);
      circle(b,[side*4.2,-.05,76.6],Y,.92,.21,gold,[[e,1]]);
      b.tube([[side*3.2,-2.8,76.3],[side*3.2,-3.8,74.5],[side*4.5,-4.5,72.8]],.14,6,Y,()=>trim,()=>w);
    }
  }
  if (!plush) b.scaleSection(firstVertex, [0, 1, 64], .9);
}

export function plushStitches(b:Builder, surface:(x:number,z:number,side:number,off:number)=>[V3,V3], weights:(p:V3)=>Wt) {
  // Pocket perimeter and both shoulder seams, kept just above the actual hoodie.
  for(const side of [-1,1]) {
    const path=Array.from({length:15},(_,i)=>surface(side*(5.7-i/14*.9),39.4+i/14*5.1,-1,.6)[0]);
    stitches(b,path,weights);
    const seam=Array.from({length:23},(_,i)=>surface(side*6.8,47+i/22*13,-1,.14)[0]);
    stitches(b,seam,weights);
  }
  stitches(b,Array.from({length:29},(_,i)=>surface(-5.6+i/28*11.2,39.5,-1,.59)[0]),weights);
}

export function plushMittens(b:Builder, side:"L"|"R") {
  const r=rig(), wr=r.at(`${side}_Hand`), kn=r.at(`${side}_Finger2`);
  const center=lerp3(wr,kn,.78), w:Wt=[[r.bone(`${side}_Hand`),1]];
  ellipsoid(b,center,[1.85,1.55,2.3],{code:9},w);
  ellipsoid(b,lerp3(r.at(`${side}_Finger0`),r.at(`${side}_Finger01`),.5),[1.0,1.15,1.4],{code:9},w);
}

/** Bun-E's own chassis: rigid shells separated by dark articulated joints. */
export function robotBody(b:Builder) {
  const r=rig(), bone=(s:string)=>r.bone(s), at=(s:string)=>r.at(s);
  const dark:Paint={code:0,color:0x222631};
  const w=(n:string):Wt=>[[bone(n),1]];
  const torsoW=(p:V3):Wt=>{
    const stations:[number,string][]=[[34,"Pelvis"],[43,"Spine"],[49,"Spine1"],[55,"Spine2"],[61,"Spine4"]];
    for(let i=0;i<stations.length-1;i++) if(p[2]<stations[i+1][0]) {
      const t=Math.max(0,Math.min(1,(p[2]-stations[i][0])/(stations[i+1][0]-stations[i][0])));
      return [[bone(stations[i][1]),1-t],[bone(stations[i+1][1]),t]];
    }
    return w("Spine4");
  };
  // Smooth chest carapace: broad at the upper chest, tapered at the waist.
  const shell=(spec:number[][],paint:Paint)=>b.surface(spec.map(([z,a,depth,y])=>ring([0,y,z],X,Y,a,depth,32)),{paint:()=>paint,weight:p=>torsoW(p),capStart:paint,capEnd:paint});
  shell([[37,6.9,4.1,1],[40,7.5,4.5,1],[43,5.7,3.6,1.2],[46,4.65,3.05,1.4],[49,5.15,3.5,1.6],[52,6.0,3.7,1.6],[57,7.3,3.9,1.8],[61,6.2,3.6,2.2],[64,3.1,2.5,2.2]],dark);
  shell([[49.5,5.7,3.9,1.4],[51.5,6.4,4.5,1.3],[54.5,7.6,5.0,1.5],[57.5,8.0,4.9,1.8],[60,7.3,4.6,1.9],[62,5.6,3.3,2],[63,3.0,2.5,2]],cream);
  // Gold perimeter under the chest plate and central illuminated power inset.
  const chestEdge=Array.from({length:33},(_,i)=>{const a=i/32*Math.PI*2;return [Math.cos(a)*5.75,1.4+Math.sin(a)*3.96,49.6] as V3;});
  b.tube(chestEdge,.12,6,Z,()=>gold,p=>torsoW(p),false);
  // Small collar core on the smooth white chest shell.
  ellipsoid(b,[0,-3.18,60],[.78,.2,.92],dark,w("Spine4"));
  circle(b,[0,-3.42,60],Y,.48,.10,gold,w("Spine4"));
  b.tube([[0,-3.44,60.5],[0,-3.45,59.95]],.075,6,X,()=>light,()=>w("Spine4"));
  // Smooth pelvis shell with a modest increase confined to the rear (+Y).
  const hipProfile=[[32.4,5.8,3.7,.8],[34,8.0,4.9,.8],[37,8.5,5.1,.8],[39.2,7.6,4.6,1],[40,6.4,3.9,1]];
  const hipRows=Array.from({length:25},(_,i)=>{
    const f=i/6,z=cr(hipProfile.map(p=>p[0]),f),a=cr(hipProfile.map(p=>p[1]),f),depth=cr(hipProfile.map(p=>p[2]),f),cy=cr(hipProfile.map(p=>p[3]),f);
    return ring([0,cy,z],X,Y,a,depth,48).map(p=>{
      const rear=Math.max(0,(p[1]-cy)/depth);
      p[1]+=.95*Math.sin(Math.PI*i/24)*Math.pow(rear,1.4);
      return p;
    });
  });
  b.surface(hipRows,{paint:()=>cream,weight:()=>w("Pelvis"),capStart:cream,capEnd:cream});
  for(const sx of [-1,1]) {
    const side=sx===1?"L":"R";
    // The same bone frames as the standard bunny keep all existing animations.
    const limb=(a:string,c:string,radius:number,paint:Paint,start=.12,end=.85)=>{
      const p=at(`${side}_${a}`),q=at(`${side}_${c}`),axis=norm(sub(q,p));
      const [,u,v]=frame(axis,X);
      // Continuous dark actuator under each shell keeps the joints connected in every pose.
      b.tube([p,q],radius*.43,16,X,()=>dark,()=>w(`${side}_${a}`));
      const profile=[[start,radius*.70],[start+.06,radius*.94],[start+(end-start)*.30,radius],[start+(end-start)*.62,radius*.88],[end-.04,radius*.63],[end,radius*.55]];
      b.surface(Array.from({length:21},(_,i)=>{const f=i/4;const t=cr(profile.map(s=>s[0]),f),rad=cr(profile.map(s=>s[1]),f);return ring(lerp3(p,q,t),u,v,rad,rad*.88,24);}),{paint:()=>paint,weight:()=>w(`${side}_${a}`),capStart:paint,capEnd:paint});
    };
    for(const joint of ["UpperArm","Forearm","Hand","Thigh","Calf","Foot"]) {
      const radius=joint==="Thigh"?2.9:joint==="Calf"?2.4:joint==="UpperArm"?2.25:1.65;
      ellipsoid(b,at(`${side}_${joint}`),[radius,radius,radius],dark,w(`${side}_${joint}`));
    }
    limb("UpperArm","Forearm",2.35,cream,.07,.82);
    limb("Forearm","Hand",2.5,cream,.16,.9);
    limb("Thigh","Calf",3.95,cream,.04,.92);
    limb("Calf","Foot",2.65,cream,.10,.96);
    // Flush gold strips make the shin and thigh shell read as manufactured panels.
    for(const [a,c,offset] of [["Thigh","Calf",3.0],["Calf","Foot",2.1]] as const) {
      const p=at(`${side}_${a}`),q=at(`${side}_${c}`);
      b.tube([add(lerp3(p,q,.25),[sx*offset,0,0]),add(lerp3(p,q,.70),[sx*offset*.78,0,0])],.10,6,Y,()=>gold,()=>w(`${side}_${a}`));
    }
    const sh=at(`${side}_UpperArm`),el=at(`${side}_Forearm`),kn=at(`${side}_Calf`);
    ellipsoid(b,add(sh,[sx*.35,0,.5]),[3,3.1,3],cream,w(`${side}_UpperArm`));
    circle(b,add(el,[sx*1.5,0,0]),X,1.05,.18,gold,w(`${side}_Forearm`));
    // Knee shield, side hip actuator and gold ankle trim.
    ellipsoid(b,add(kn,[0,-1.8,0]),[2.15,.85,2.4],cream,w(`${side}_Calf`));
    circle(b,add(at(`${side}_Thigh`),[sx*2.8,0,-1]),X,1.3,.2,gold,w(`${side}_Thigh`));
    const ankle=at(`${side}_Foot`);
    circle(b,add(ankle,[0,0,1.2]),Z,1.8,.17,gold,w(`${side}_Foot`));
    const fx=ankle[0];
    const footRows=[[5,1.3,3.6],[3.5,2,5.5],[1,2.4,6],[-2,2.5,4.5],[-5,2.45,3.1],[-7.5,1.5,2.1],[-8,.3,1.8]];
    b.surface(footRows.map(([y,hw,h])=>ring([fx,y,(h+1)/2],X,Z,hw,(h-1)/2,24,2.5)),{paint:()=>cream,weight:()=>w(`${side}_Foot`),capStart:cream,capEnd:cream});
    b.surface(footRows.map(([y,hw])=>ring([fx,y,.6],X,Z,hw+.12,.6,24,2.5)),{paint:()=>gold,weight:()=>w(`${side}_Foot`),capStart:gold,capEnd:gold});
    // Dorsal hand plates sit over the existing articulated finger rig.
    const hand=at(`${side}_Hand`), fingers=at(`${side}_Finger2`);
    ellipsoid(b,lerp3(hand,fingers,.48),[1.3,1.15,1.7],cream,w(`${side}_Hand`));
    for(const digit of [0,1,2]) {
      const names=[`${side}_Finger${digit}`,`${side}_Finger${digit}1`,`${side}_Finger${digit}2`];
      for(let i=0;i<2;i++) {
        const p=at(names[i]),q=at(names[i+1]);
        b.tube([lerp3(p,q,.12),lerp3(p,q,.8)],digit===0?.4:.34,8,Y,()=>cream,()=>w(names[i]));
        ellipsoid(b,q,[.38,.38,.38],dark,w(names[i+1]));
      }
      const end=at(names[2]),d=norm(sub(end,at(names[1])));
      b.tube([end,add(end,scale(d,.8))],.32,8,Y,()=>cream,()=>w(names[2]));
    }
    const fore=at(`${side}_Forearm`),wr=at(`${side}_Hand`);
    const rail=[lerp3(fore,wr,.27),lerp3(fore,wr,.78)].map(p=>add(p,[0,-2.25,0]));
    b.tube(rail,.10,6,X,()=>gold,()=>w(`${side}_Forearm`));
  }
  // Collar actuator links helmet and shoulder chassis.
  b.tube([[0,2,62],[0,2,66]],2,20,X,()=>dark,()=>w("Neck1"));
  circle(b,[0,2,63.5],Z,2.25,.18,gold,w("Neck1"));
}
