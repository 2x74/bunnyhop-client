import { shaderStructs, shaderIntersectFunction } from "three-mesh-bvh";
// A bounded traversal must fail conservatively rather than use a partial tree result.
const intersection=shaderIntersectFunction.replace("while ( ptr > - 1 && ptr < BVH_STACK_DEPTH ) {", "int visits=0;while ( ptr > - 1 && ptr < BVH_STACK_DEPTH ) {if(++visits>256){hybridExhausted=true;return false;}");
export const HYBRID_TRACE_FRAGMENT=/* glsl */`
precision highp sampler2DArray;precision highp usampler2D;
${shaderStructs}
bool hybridExhausted=false;
${intersection}
uniform BVH bvh;
uniform sampler2D vertexNormal,vertexUVMaterial,materialTable,receiverDepth,receiverNormal;
uniform sampler2DArray albedoMaps;
uniform mat4 inverseProjection,cameraWorld;
uniform vec2 resolution;
uniform float rayRange,sampleIndex;
uniform int dynamicCount;
uniform vec3 dynamicMin[16],dynamicMax[16];
uniform vec3 sunDirection[2],sunColor[2];uniform float sunEnabled[2];
uniform vec3 lightPosition[4],lightDirection[4],lightColor[4];
uniform vec4 lightParams[4]; // intensity, range, innerCos, outerCos
uniform vec2 lightFlags[4]; // enabled, spot
in vec2 vUv;out vec4 outputColor;
struct Surface {vec3 position;vec3 normal;vec3 albedo;float type;};
bool dynamicCrossing(vec3 ro,vec3 rd,float limit){for(int i=0;i<16;i++){if(i>=dynamicCount)break;float distance; if(intersectsBounds(ro,rd,dynamicMin[i],dynamicMax[i],distance)&&distance<=limit)return true;}return false;}
bool surfaceHit(vec3 ro,vec3 rd,float limit,out Surface s,out bool unreliable){
 vec3 original=ro;float traveled=0.;unreliable=false;
 for(int layer=0;layer<4;layer++){
  uvec4 indices=uvec4(0);vec3 faceNormal=vec3(0.),bary=vec3(0.);float side=0.,distance=0.;hybridExhausted=false;
  bool found=bvhIntersectFirstHit(bvh,ro,rd,indices,faceNormal,bary,side,distance);
  if(hybridExhausted){unreliable=true;return false;}
  if(dynamicCrossing(original,rd,found?min(limit,traveled+distance):limit)){unreliable=true;return false;}
  if(!found||traveled+distance>limit)return false;
  vec3 uvMaterial=textureSampleBarycoord(vertexUVMaterial,bary,indices.xyz).xyz;int material=int(uvMaterial.z+.5);
  vec4 base=texelFetch(materialTable,ivec2(0,material),0),flags=texelFetch(materialTable,ivec2(1,material),0);
  vec4 transform0=texelFetch(materialTable,ivec2(2,material),0),transform1=texelFetch(materialTable,ivec2(3,material),0);vec3 row0=transform0.xyz,row1=transform1.xyz;
  vec2 uv=vec2(dot(row0,vec3(uvMaterial.xy,1.)),dot(row1,vec3(uvMaterial.xy,1.)));
  uv=vec2(transform0.w>.5?(transform0.w>1.5?1.-abs(mod(uv.x,2.)-1.):clamp(uv.x,0.,1.)):fract(uv.x),transform1.w>.5?(transform1.w>1.5?1.-abs(mod(uv.y,2.)-1.):clamp(uv.y,0.,1.)):fract(uv.y));vec4 texel=texture(albedoMaps,vec3(uv,max(0.,flags.x)));
  if(texel.a<flags.y){float stepDistance=distance+.15;ro+=rd*stepDistance;traveled+=stepDistance;continue;}
  s.position=ro+rd*distance;vec3 rawNormal=textureSampleBarycoord(vertexNormal,bary,indices.xyz).xyz;if(dot(rawNormal,rawNormal)<.00001){unreliable=true;return false;}s.normal=normalize(rawNormal);if(flags.z>.5&&dot(s.normal,-rd)<0.)s.normal=-s.normal;
  s.albedo=clamp(base.rgb*texel.rgb,vec3(0.),vec3(1.));s.type=side<0.&&flags.z<.5&&flags.w!=1.?3.:flags.w;return true;
 }
 unreliable=true;return false;
}
float visibility(vec3 point,vec3 normal,vec3 direction,float distance,inout bool unreliable){Surface hit;bool invalid;bool found=surfaceHit(point+normal*.35,direction,distance,hit,invalid);unreliable=unreliable||invalid;return invalid?0.:(!found||hit.type>.5&&hit.type<1.5?1.:0.);}
vec3 donorDirect(Surface s,int state,inout bool unreliable){vec3 energy=vec3(0.);vec3 direction=sunDirection[state];float cosine=max(0.,dot(s.normal,direction));if(sunEnabled[state]>.5&&cosine>0.)energy+=sunColor[state]*cosine*visibility(s.position,s.normal,direction,100000.,unreliable);
 for(int i=0;i<2;i++){int j=state*2+i;if(lightFlags[j].x<.5)continue;vec3 delta=lightPosition[j]-s.position;float distance=length(delta),range=lightParams[j].y;if(distance>=range||range<=0.)continue;vec3 d=delta/max(distance,.001);float diffuse=max(0.,dot(s.normal,d));if(diffuse<=0.)continue;
 float fade=pow(max(0.,1.-distance/range),2.),attenuation=fade/(1.+pow(distance/max(range*.15,1.),2.));float cone=lightFlags[j].y>.5?smoothstep(lightParams[j].w,lightParams[j].z,dot(-d,lightDirection[j])):1.;if(cone<=0.)continue;
 energy+=lightColor[j]*lightParams[j].x*diffuse*attenuation*cone*visibility(s.position,s.normal,d,max(0.,distance-.35),unreliable);
 }return energy;}
float randomValue(vec2 p,float shift){return fract(sin(dot(p,vec2(12.9898,78.233))+sampleIndex*37.719+shift)*43758.5453);}
void main(){float depth=texture(receiverDepth,vUv).x;vec4 encoded=texture(receiverNormal,vUv);if(depth>=.999999||encoded.a<.5){outputColor=vec4(0.);return;}
 vec3 rawReceiverNormal=encoded.xyz*2.-1.;if(dot(rawReceiverNormal,rawReceiverNormal)<.00001){outputColor=vec4(0.);return;}vec4 view=inverseProjection*vec4(vUv*2.-1.,depth*2.-1.,1.);if(abs(view.w)<.000001){outputColor=vec4(0.);return;}vec3 point=(cameraWorld*vec4(view.xyz/view.w,1.)).xyz,n=normalize(encoded.xyz*2.-1.);
 vec3 tangent=normalize(cross(n,abs(n.z)<.9?vec3(0.,0.,1.):vec3(0.,1.,0.))),bitangent=cross(n,tangent);vec2 pixel=floor(vUv*resolution);float r=sqrt(randomValue(pixel,.37)),theta=randomValue(pixel,7.13)*6.283185307;
 vec3 direction=normalize(tangent*r*cos(theta)+bitangent*r*sin(theta)+n*sqrt(max(0.,1.-r*r)));Surface donor;bool unreliable;
 bool found=surfaceHit(point+n*.35,direction,rayRange,donor,unreliable);if(unreliable){outputColor=vec4(0.);return;}if(!found||donor.type>.5){outputColor=vec4(0.,0.,0.,1.);return;}
 vec3 current=donorDirect(donor,0,unreliable),baseline=donorDirect(donor,1,unreliable);
 // Cosine-weighted sampling contributes pi*Le; donor Lambertian /pi cancels.
 vec3 irradiance=donor.albedo*(current-baseline);outputColor=unreliable||any(isnan(irradiance))||any(isinf(irradiance))?vec4(0.):vec4(clamp(irradiance,vec3(-8.),vec3(8.)),1.);
}
`;
