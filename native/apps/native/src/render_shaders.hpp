#pragma once
#include <string>
#include "native_cosmetics.hpp"
namespace native_render {
struct Actor {
    std::string id, name;
    BhGhostFrame frame{};
    std::string outfit, loadout;
    float opacity = .45f;
    bool silenced = false, jumped = false, inspectHeld = false, snapped = false;
    unsigned attack = 0, inspect = 0;
    std::optional<Glow> playerGlow;
    GhostSource source = GhostSource::none;
    int ghost_slot = -1;
};
// Source coordinates throughout: Z up. Water is the site's convex-volume fog, evaluated in gamma
// space after output conversion; planes live in a float texture to avoid fragment-uniform limits.
inline const std::string water = R"(
uniform vec3 cameraPosition;
uniform int waterCount;
uniform vec3 waterMin[24],waterMax[24],waterColor[24];
uniform vec2 waterRange[24],waterSpan[24];
uniform vec4 waterRect[24];uniform vec2 viewportSize;
uniform sampler2D waterPlanes;
vec3 encode(vec3 x){x=max(x,vec3(0));return mix(x*12.92,1.055*pow(x,vec3(1./2.4))-.055,step(vec3(.0031308),x));}
vec3 linearize(vec3 x){return mix(x/12.92,pow((x+.055)/1.055,vec3(2.4)),step(vec3(.04045),x));}
vec3 waterFog(vec3 color,vec3 p){
 vec3 d=p-cameraPosition;float len=length(d),total=0.;vec3 fog=vec3(0);vec2 range=vec2(0);
 vec3 inv=1./(d+vec3(equal(d,vec3(0)))*1e-6);
 for(int i=0;i<24;i++){if(i>=waterCount)break;
  vec2 ndc=gl_FragCoord.xy/viewportSize*2.-1.;vec4 r=waterRect[i];if(ndc.x<r.x||ndc.y<r.y||ndc.x>r.z||ndc.y>r.w)continue;
  vec3 t0=(waterMin[i]-cameraPosition)*inv,t1=(waterMax[i]-cameraPosition)*inv;
  vec3 lo=min(t0,t1),hi=max(t0,t1);float a=max(max(max(lo.x,lo.y),lo.z),0.),b=min(min(min(hi.x,hi.y),hi.z),1.);
  for(int j=0;j<int(waterSpan[i].y);j++){
   vec4 plane=texelFetch(waterPlanes,ivec2(int(waterSpan[i].x)+j,0),0);
   float denom=dot(plane.xyz,d),numer=plane.w-dot(plane.xyz,cameraPosition);
   if(abs(denom)<1e-7){if(numer<0.){b=-1.;break;}}else if(denom>0.)b=min(b,numer/denom);else a=max(a,numer/denom);
  }
  if(b>a){float n=(b-a)*len;total+=n;fog+=waterColor[i]*n;range+=waterRange[i]*n;}
 }
 if(total<=0.)return color;range/=total;return mix(color,fog/total,clamp((total-range.x)/max(range.y-range.x,1.),0.,1.));
}
)";
inline const char *depth_vertex=R"(#version 330 core
layout(location=0)in vec3 position;uniform mat4 viewProjection,model;
void main(){gl_Position=viewProjection*model*vec4(position,1);}
)";
inline const char *depth_fragment=R"(#version 330 core
void main(){}
)";
inline const char *world_vertex=R"(#version 330 core
layout(location=0) in vec3 position;layout(location=1) in vec3 normal;
layout(location=2) in vec2 baseUV;layout(location=3) in vec2 lightUV;layout(location=4) in float blendAlpha;
uniform mat4 viewProjection,model;
out vec2 uv,lm;out vec3 world,normalWorld;out float blend,depth;
void main(){vec4 w=model*vec4(position,1);world=w.xyz;normalWorld=mat3(model)*normal;uv=baseUV;lm=lightUV;blend=blendAlpha;gl_Position=viewProjection*w;depth=gl_Position.w;}
)";
inline std::string world_fragment() {
    return std::string("#version 330 core\n") + water + R"(
in vec2 uv,lm;in vec3 world,normalWorld;in float blend,depth;
uniform sampler2D baseTexture,lightTexture,secondaryTexture,detailTexture,normalTexture;uniform bool hasNormal,fullbright,potato;uniform vec3 sunDirection;
uniform sampler2D sceneColor,sceneDepth;uniform bool detailedWater;
uniform vec3 tint,flatColor;uniform float opacity,cutoff,lightmapScale,detailScale,detailBlend,timeSeconds;
uniform int kind;uniform bool unlit,props,hasSecondary,hasDetail,aboveWater,skyPass,additive;
uniform bool flashlight;uniform vec3 flashDirection;
uniform vec3 skyFogColor;uniform vec3 skyFogRange;
out vec4 color;
void main(){
 vec3 n=normalize(normalWorld);vec3 v=normalize(cameraPosition-world);vec4 base=texture(baseTexture,uv);
 if(potato&&cutoff<=0.){
  base=vec4(flatColor,1);
  vec3 an=abs(n);
  vec2 q=(an.x>an.y&&an.x>an.z?world.yz:an.y>an.z?world.xz:world.xy)/64.;
  vec2 w=fwidth(q),d=abs(fract(q-.5)-.5)/max(w,vec2(.0001));
  float line=1.-clamp(min(d.x,d.y)-.5,0.,1.);
  float fade=1.-smoothstep(.08,.3,max(w.x,w.y));
  base.rgb*=1.-.16*line*fade;
 }
 if(hasSecondary&&!potato)base=mix(base,texture(secondaryTexture,uv),clamp(blend,0.,1.));
 if(hasDetail)base.rgb*=mix(vec3(1),texture(detailTexture,uv*detailScale).rgb*2.,detailBlend);
 base*=vec4(tint,opacity);if(base.a<cutoff)discard;
 vec3 lighting=unlit?vec3(1):props?vec3(.5+.5*max(dot(n,normalize(vec3(.35,.45,.82))),0.)):texture(lightTexture,lm).rgb/lightmapScale;
 if(fullbright)lighting=vec3(1);
 if(hasNormal&&!potato&&!fullbright){vec3 flatN=n*(gl_FrontFacing?1.:-1.);vec3 q0=dFdx(world),q1=dFdy(world);vec2 st0=dFdx(uv),st1=dFdy(uv);vec3 q1p=cross(q1,flatN),q0p=cross(flatN,q0);vec3 t=q1p*st0.x+q0p*st1.x,b=q1p*st0.y+q0p*st1.y;float len=max(dot(t,t),dot(b,b));if(len>1e-12){vec3 sampled=texture(normalTexture,uv).xyz*2.-1.;vec3 mapped=normalize((t*sampled.x+b*sampled.y)*inversesqrt(len)+flatN*sampled.z);lighting*=clamp(1.+.35*(dot(mapped,sunDirection)-dot(flatN,sunDirection)),.65,1.35);}}
 if(flashlight){vec3 delta=world-cameraPosition;float dist=length(delta);float cone=smoothstep(.90,.975,dot(normalize(delta),flashDirection));lighting+=vec3(2.8,2.65,2.4)*cone*max(.12,dot(n,-normalize(delta)))/(1.+dist*dist/180000.);}
 vec3 col=encode(base.rgb*lighting);float alpha=base.a;
 if(kind==2&&!potato){
  bool above=aboveWater&&gl_FrontFacing;if(!gl_FrontFacing)n=-n;
  vec2 p=world.xy;vec2 g=vec2(.8,.6)*cos(dot(p,vec2(.8,.6))*.045+timeSeconds*1.3)*.5;
  g+=vec2(-.5,.86)*cos(dot(p,vec2(-.5,.86))*.071+timeSeconds*1.7)*.35;
  g+=vec2(.2,-.98)*cos(dot(p,vec2(.2,-.98))*.113+timeSeconds*2.3)*.2;n=normalize(n+vec3(g*.08,0));
  float c=clamp(abs(dot(n,v)),0.,1.);vec3 sky=linearize(vec3(.663,.757,.827));vec3 t=mix(linearize(vec3(.239,.435,.549)),tint,.45)+vec3(.06);
  if(above){float f=.02+.98*pow(1.-c,5.);col=mix(t,sky,clamp(f*.85,0.,1.));col+=vec3(.05)*smoothstep(.985,1.,dot(n,normalize(v+vec3(.3,-.2,.8))));alpha=mix(.38,.9,f);}
  else {float win=smoothstep(.55,.85,c);col=mix(tint*1.6+t*.3,sky*.9+t*.2,win);alpha=mix(.92,.35,win);}
  if(detailedWater){vec2 screen=gl_FragCoord.xy/viewportSize;vec2 offset=g*.006*clamp(32./max(depth,1.),.15,1.);vec2 at=clamp(screen+offset,vec2(.001),vec2(.999));float background=texture(sceneDepth,at).r;if(background<=gl_FragCoord.z+.00001)at=screen;vec3 transmitted=linearize(texture(sceneColor,at).rgb);float thickness=max(0.,texture(sceneDepth,at).r-gl_FragCoord.z);float absorb=clamp(thickness*350.,.05,.8);transmitted=mix(transmitted,t,absorb*.55);float fres=.02+.98*pow(1.-c,5.);col=mix(transmitted,col,above?clamp(fres,.06,.85):.25);alpha=above?mix(.2,.85,fres):mix(.85,.25,smoothstep(.55,.85,c));}
 } else if(kind==3&&!potato){float f=pow(1.-clamp(abs(dot(n,v)),0.,1.),3.);vec3 t=tint;if(all(greaterThan(t,vec3(.97))))t=linearize(vec3(.847,.91,.941));col=mix(t,vec3(1),f*.35);alpha=mix(.28,.6,f);}
 if(kind==2||kind==3)col=encode(col);
 if(!potato)col=waterFog(col,world);
 if(skyPass){float f=clamp(min(skyFogRange.z,(depth-skyFogRange.x)/max(skyFogRange.y-skyFogRange.x,.001)),0.,1.);col=mix(col,additive?vec3(0):skyFogColor,f);}
 color=vec4(col,alpha);
}
)";
}
inline const char *sky_vertex=R"(#version 330 core
out vec2 ndc;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);ndc=p*2.-1.;gl_Position=vec4(ndc,1,1);}
)";
inline std::string sky_fragment(){return std::string("#version 330 core\n")+water+R"(
in vec2 ndc;uniform vec3 forward,right,up;uniform float aspect,cot;
uniform sampler2D sky0,sky1,sky2,sky3,sky4,sky5;
uniform int skyPresent[6],skyHalf[6];out vec4 color;
void main(){vec3 d=normalize(forward+right*ndc.x*aspect/cot+up*ndc.y/cot),a=abs(d);int f;vec2 st;
 if(a.x>=a.y&&a.x>=a.z){if(d.x>0.){f=0;st=vec2(-d.y,d.z)/a.x;}else{f=1;st=vec2(d.y,d.z)/a.x;}}
 else if(a.y>=a.z){if(d.y>0.){f=2;st=vec2(d.x,d.z)/a.y;}else{f=3;st=vec2(-d.x,d.z)/a.y;}}
 else{if(d.z>0.){f=4;st=vec2(-d.y,-d.x)/a.z;}else{f=5;st=vec2(-d.y,d.x)/a.z;}}
 vec3 c;vec2 uv=vec2((st.x+1.)*.5,skyHalf[f]!=0?1.-st.y:(1.-st.y)*.5);
 if(skyPresent[f]!=0){if(f==0)c=texture(sky0,uv).rgb;else if(f==1)c=texture(sky1,uv).rgb;else if(f==2)c=texture(sky2,uv).rgb;else if(f==3)c=texture(sky3,uv).rgb;else if(f==4)c=texture(sky4,uv).rgb;else c=texture(sky5,uv).rgb;}
 else{c=d.z>0.?mix(linearize(vec3(.788,.863,.925)),linearize(vec3(.247,.435,.710)),pow(d.z,.55)):mix(linearize(vec3(.788,.863,.925)),linearize(vec3(.49,.541,.588)),pow(min(-d.z*3.,1.),.7));float sun=max(dot(d,normalize(vec3(.45,.6,.35))),0.);c+=vec3(1,.92,.75)*(pow(sun,600.)*1.5+pow(sun,12.)*.18);}
 color=vec4(waterFog(encode(c),cameraPosition+d*1e5),1);
}
)";}
}
