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
    // Nothing in the right hand (an avatar gesture): no knife or gun drawn.
    bool emptyHand = false;
    // Since the last frame. With the knife 1 is a slash and 2 a stab; with a gun 1 is a shot and 2 a reload.
    unsigned attack = 0, inspect = 0;
    std::optional<Glow> playerGlow;
    GhostSource source = GhostSource::none;
    int ghost_slot = -1;
    // Ghosts fade out as the camera reaches them (Settings -> Ghost -> Near fade).
    bool near_fade = false;
    // A ghost's colour (sRGB) for its name tag.
    std::array<float, 3> tint{.55f, .85f, 1};
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
// clipHeight only takes effect while GL_CLIP_DISTANCE0 is on: the water reflection keeps what is above its plane.
inline const char *depth_vertex = R"(#version 330 core
layout(location=0)in vec3 position;uniform mat4 viewProjection,model;uniform float clipHeight;
void main(){vec4 w=model*vec4(position,1);gl_ClipDistance[0]=w.z-clipHeight;gl_Position=viewProjection*w;}
)";
inline const char *depth_fragment = R"(#version 330 core
void main(){}
)";
// Cut-out surfaces (leaves, fences) in the sun's depth map: depth only where the texture is solid.
inline const char *cutout_depth_vertex = R"(#version 330 core
layout(location=0)in vec3 position;layout(location=2)in vec2 baseUV;uniform mat4 viewProjection,model;out vec2 uv;
void main(){uv=baseUV;gl_Position=viewProjection*model*vec4(position,1);}
)";
inline const char *cutout_depth_fragment = R"(#version 330 core
in vec2 uv;uniform sampler2D baseTexture;uniform float cutoff;
void main(){if(texture(baseTexture,uv).a<cutoff)discard;}
)";
inline const char *world_vertex = R"(#version 330 core
layout(location=0) in vec3 position;layout(location=1) in vec3 normal;
layout(location=2) in vec2 baseUV;layout(location=3) in vec2 lightUV;layout(location=4) in float blendAlpha;
uniform mat4 viewProjection,model;uniform float clipHeight;
out vec2 uv,lm;out vec3 world,normalWorld;out float blend,depth;
void main(){
 vec4 w=model*vec4(position,1);world=w.xyz;normalWorld=mat3(model)*normal;uv=baseUV;lm=lightUV;blend=blendAlpha;
 gl_ClipDistance[0]=w.z-clipHeight;gl_Position=viewProjection*w;depth=gl_Position.w;
}
)";

// The website's water.ts surfaces, in Source space (its xz is our (x, -y)). Like the website these return display
// (gamma) values: the tint and sky constants are its linear colours shown as they are. Water from above blends the
// refracted scene and the planar reflection when this frame captured them (water_capture.hpp), otherwise the plain
// translucent tint; from below it shows Snell's window.
inline const std::string water_surface_shader = R"(
vec3 waterSky(){return linearize(vec3(.663,.757,.827));}
vec3 waterTint(){return mix(linearize(vec3(.239,.435,.549)),tint,.45)+vec3(.06);}
float viewDepth(float z){return cameraNearFar.x*cameraNearFar.y/(cameraNearFar.y-z*(cameraNearFar.y-cameraNearFar.x));}
vec2 rippleWave(vec2 p,vec2 direction,float frequency,float speed,float amplitude){
 return direction*cos(dot(p,direction)*frequency+timeSeconds*speed)*amplitude;
}
vec3 ripple(vec3 n){
 vec2 p=vec2(world.x,-world.y);
 vec2 g=rippleWave(p,vec2(.8,.6),.045,1.3,.5)+rippleWave(p,vec2(-.5,.86),.071,1.7,.35);
 g+=rippleWave(p,vec2(.2,-.98),.113,2.3,.2);
 if(captureReady){
  // Short waves fade over the pixel footprint instead of aliasing into distant glints.
  float footprint=max(length(dFdx(p)),length(dFdy(p)));
  g+=rippleWave(p,vec2(.91,-.41),.21,-1.1,.11*exp(-.5*pow(footprint*.21,2.)));
  g+=rippleWave(p,vec2(-.72,-.69),.36,2.8,.06*exp(-.5*pow(footprint*.36,2.)));
 }
 return normalize(n+vec3(g.x,-g.y,0)*.08);
}
vec3 refracted(vec3 n,vec3 tintColor){
 vec2 screen=gl_FragCoord.xy/viewportSize;
 vec2 at=clamp(screen+vec2(n.x,-n.y)*.012,vec2(.001),vec2(.999));
 float surface=viewDepth(gl_FragCoord.z);
 // Offsets that land on geometry in front of the surface fall back to the straight view.
 if(viewDepth(texture(sceneDepth,at).r)<surface)at=screen;
 float thickness=max(0.,viewDepth(texture(sceneDepth,at).r)-surface);
 return mix(texture(sceneColor,at).rgb,tintColor,.12+.7*(1.-exp(-thickness/waterFogEnd)));
}
vec3 reflected(vec3 n){
 if(!reflectionReady||abs(world.z-reflectionHeight)>=.2)return waterSky();
 vec2 at=gl_FragCoord.xy/viewportSize+vec2(n.x,-n.y)*.009;
 if(any(lessThanEqual(at,vec2(0)))||any(greaterThanEqual(at,vec2(1))))return waterSky();
 return texture(reflectionTexture,at).rgb;
}
vec4 waterSurface(vec3 n,vec3 v){
 bool above=aboveWater&&gl_FrontFacing;
 if(!gl_FrontFacing)n=-n;
 n=ripple(n);
 float c=clamp(abs(dot(n,v)),0.,1.),fres=.02+.98*pow(1.-c,5.);
 vec3 t=waterTint(),sky=waterSky();
 if(!above){float window=smoothstep(.55,.85,c);return vec4(mix(tint*1.6+t*.3,sky*.9+t*.2,window),mix(.92,.35,window));}
 if(!captureReady){
  vec3 col=mix(t,sky,clamp(fres*.85,0.,1.))+vec3(.05)*smoothstep(.985,1.,dot(n,normalize(v+vec3(.3,-.2,.8))));
  return vec4(col,mix(.38,.9,fres));
 }
 // Fresnel weights radiance, so the blend happens in linear light.
 vec3 col=mix(linearize(refracted(n,t)),linearize(reflected(n)),clamp(fres*.95,0.,1.));
 return vec4(encode(col),1);
}
vec4 glassSurface(vec3 n,vec3 v){
 float f=pow(1.-clamp(abs(dot(n,v)),0.,1.),3.);
 vec3 t=all(greaterThan(tint,vec3(.97)))?linearize(vec3(.847,.91,.941)):tint;
 return vec4(mix(t,vec3(1),f*.35),mix(.28,.6,f));
}
)";

// The Enhanced and Cinematic looks' sun over the baked lighting (web graphics/shadows.ts): shadows of the sun's depth
// map darken it, and a lighting profile adds sky fill and direct sun. Off in every other look (sunActive false).
inline const std::string sun_light_shader = R"(
uniform bool sunActive,sunShadowActive;uniform sampler2DShadow sunShadowMap;uniform mat4 sunShadowMatrix;
uniform float sunShadowStrength,sunDirectStrength,sunBakedScale,sunSkyFill,sunShadowTexel,sunShadowBias,sunShadowRadius;
uniform vec3 sunLightDirection,sunLightColor,sunAmbientColor;
float sunVisibility(vec3 p){
 float sum=0.;
 for(int y=0;y<2;y++)for(int x=0;x<2;x++){
  vec2 o=(vec2(x,y)-.5)*sunShadowTexel*sunShadowRadius;sum+=texture(sunShadowMap,vec3(p.xy+o,p.z-sunShadowBias));
 }
 return sum*.25;
}
vec3 sunLight(vec3 lit,vec3 albedo,vec3 n){
 if(!sunShadowActive)return lit*sunBakedScale+albedo*sunAmbientColor*sunSkyFill;
 vec4 q=sunShadowMatrix*vec4(world,1);vec3 p=q.xyz/q.w*.5+.5;
 float border=min(min(p.x,1.-p.x),min(p.y,1.-p.y));
 if(border<=0.||p.z<=0.||p.z>=1.)return lit;
 float fade=smoothstep(0.,.06,border),visible=sunVisibility(p),baked=dot(lit,vec3(.2126,.7152,.0722));
 lit*=mix(1.,sunBakedScale,fade)*(1.-(1.-visible)*sunShadowStrength*fade*smoothstep(.005,.08,baked));
 lit+=albedo*sunAmbientColor*sunSkyFill*fade;
 return lit+albedo*sunLightColor*max(0.,dot(n,sunLightDirection))*visible*sunDirectStrength*fade;
}
)";

inline std::string world_fragment() {
    return std::string("#version 330 core\n") + water + R"(
in vec2 uv,lm;in vec3 world,normalWorld;in float blend,depth;
uniform sampler2D baseTexture,lightTexture,secondaryTexture,detailTexture,normalTexture;uniform bool hasNormal,fullbright,potato;uniform vec3 sunDirection;
uniform sampler2D sceneColor,sceneDepth,reflectionTexture;uniform bool captureReady,reflectionReady;
uniform float reflectionHeight,waterFogEnd;uniform vec2 cameraNearFar;
uniform vec3 tint,flatColor;uniform float opacity,cutoff,lightmapScale,detailScale,detailBlend,timeSeconds;
uniform int kind;uniform bool unlit,props,hasSecondary,hasDetail,aboveWater,skyPass,additive;
uniform bool flashlight;uniform vec3 flashDirection;
uniform vec3 skyFogColor;uniform vec3 skyFogRange;
out vec4 color;
)" + sun_light_shader
           + water_surface_shader + R"(
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
 vec3 lit=base.rgb*lighting;
 if(sunActive&&!unlit&&!potato&&!fullbright&&!skyPass&&kind<2&&base.a>.99)lit=sunLight(lit,base.rgb,n*(gl_FrontFacing?1.:-1.));
 vec3 col=encode(lit);float alpha=base.a;
 if(kind==2&&!potato){vec4 surface=waterSurface(n,v);col=surface.rgb;alpha=surface.a;}
 else if(kind==3&&!potato){vec4 surface=glassSurface(n,v);col=surface.rgb;alpha=surface.a;}
 if(!potato)col=waterFog(col,world);
 if(skyPass){float f=clamp(min(skyFogRange.z,(depth-skyFogRange.x)/max(skyFogRange.y-skyFogRange.x,.001)),0.,1.);col=mix(col,additive?vec3(0):skyFogColor,f);}
 color=vec4(col,alpha);
}
)";
}

inline const char *sky_vertex = R"(#version 330 core
out vec2 ndc;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);ndc=p*2.-1.;gl_Position=vec4(ndc,1,1);}
)";

// Face (s, t) is (dot(sAxis, ray), dot(tAxis, ray)) / dot(faceAxis, ray). Texture gradients come from the view ray,
// which is smooth across the cube's edges: screen derivatives of (s, t) jump there and picked the smallest mip, which
// drew every face edge as a seam line.
inline std::string sky_fragment() {
    return std::string("#version 330 core\n") + water + R"(
in vec2 ndc;uniform vec3 forward,right,up;uniform float aspect,cot,skyExposure;
uniform sampler2D sky0,sky1,sky2,sky3,sky4,sky5,panorama;
uniform int skyPresent[6],skyHalf[6];uniform bool panoramaShown;uniform float panoramaYaw,panoramaExposure;
uniform vec3 proceduralSun;out vec4 color;
vec3 skyTexture(int f,vec2 uv,vec2 dx,vec2 dy){
 if(f==0)return textureGrad(sky0,uv,dx,dy).rgb;
 if(f==1)return textureGrad(sky1,uv,dx,dy).rgb;
 if(f==2)return textureGrad(sky2,uv,dx,dy).rgb;
 if(f==3)return textureGrad(sky3,uv,dx,dy).rgb;
 if(f==4)return textureGrad(sky4,uv,dx,dy).rgb;
 return textureGrad(sky5,uv,dx,dy).rgb;
}
vec2 faceGradient(vec3 sAxis,vec3 tAxis,vec3 faceAxis,vec3 ray,vec3 step,vec2 st){
 return (vec2(dot(sAxis,step),dot(tAxis,step))-st*dot(faceAxis,step))/dot(faceAxis,ray);
}
vec3 faceColor(vec3 ray){
 vec3 a=abs(ray),sAxis,tAxis,faceAxis;int f;
 if(a.x>=a.y&&a.x>=a.z){f=ray.x>0.?0:1;faceAxis=vec3(sign(ray.x),0,0);sAxis=vec3(0,-faceAxis.x,0);tAxis=vec3(0,0,1);}
 else if(a.y>=a.z){f=ray.y>0.?2:3;faceAxis=vec3(0,sign(ray.y),0);sAxis=vec3(faceAxis.y,0,0);tAxis=vec3(0,0,1);}
 else{f=ray.z>0.?4:5;faceAxis=vec3(0,0,sign(ray.z));sAxis=vec3(0,-1,0);tAxis=vec3(-faceAxis.z,0,0);}
 vec2 st=vec2(dot(sAxis,ray),dot(tAxis,ray))/dot(faceAxis,ray);
 vec2 dx=faceGradient(sAxis,tAxis,faceAxis,ray,dFdx(ray),st),dy=faceGradient(sAxis,tAxis,faceAxis,ray,dFdy(ray),st);
 vec2 scale=vec2(.5,skyHalf[f]!=0?-1.:-.5);
 vec2 uv=vec2((st.x+1.)*.5,skyHalf[f]!=0?1.-st.y:(1.-st.y)*.5);
 if(skyPresent[f]!=0)return skyTexture(f,uv,dx*scale,dy*scale);
 vec3 d=normalize(ray);
 vec3 c=d.z>0.?mix(linearize(vec3(.788,.863,.925)),linearize(vec3(.247,.435,.710)),pow(d.z,.55)):mix(linearize(vec3(.788,.863,.925)),linearize(vec3(.49,.541,.588)),pow(min(-d.z*3.,1.),.7));
 float sun=max(dot(d,proceduralSun),0.);
 return c+vec3(1,.92,.75)*(pow(sun,600.)*1.5+pow(sun,12.)*.18);
}
// A sky pack's equirect panorama (web graphics/sky-background.ts), in its three.js frame: Source (x,y,z) is (x,z,-y).
vec3 panoramaColor(vec3 ray){
 vec3 t=normalize(vec3(ray.x,ray.z,-ray.y));float c=cos(panoramaYaw),s=sin(panoramaYaw);
 vec3 p=vec3(c*t.x-s*t.z,t.y,s*t.x+c*t.z);
 vec2 uv=vec2(atan(p.z,p.x)*.159154943+.5,.5-asin(clamp(p.y,-1.,1.))*.318309886);
 return textureLod(panorama,uv,0.).rgb*panoramaExposure;
}
void main(){vec3 ray=forward+right*ndc.x*aspect/cot+up*ndc.y/cot;vec3 c=panoramaShown?panoramaColor(ray):faceColor(ray);
 color=vec4(waterFog(encode(c*exp2(skyExposure)),cameraPosition+normalize(ray)*1e5),1);
}
)";
}
}  // namespace native_render
