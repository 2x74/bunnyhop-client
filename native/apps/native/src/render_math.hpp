#pragma once
#include "native_math.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <deque>
#include <vector>

namespace native_render {
using Vec3=std::array<float,3>;
struct Bounds {Vec3 lo{},hi{};};
inline Vec3 transform_point(const native::Matrix &m,const Vec3 &p){return {m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]};}
// Conservative homogeneous clip test. Near-plane crossings keep a full-screen rectangle.
inline bool screen_rect(const Bounds &b,const native::Matrix &vp,std::array<float,4> &rect){
    rect={1e9f,1e9f,-1e9f,-1e9f};std::array<unsigned,6> outside{};bool behind=false;
    for(unsigned i=0;i<8;i++){
        const Vec3 p={i&1?b.hi[0]:b.lo[0],i&2?b.hi[1]:b.lo[1],i&4?b.hi[2]:b.lo[2]};
        float q[4]{};for(int r=0;r<4;r++)q[r]=vp[r]*p[0]+vp[4+r]*p[1]+vp[8+r]*p[2]+vp[12+r];
        for(int k=0;k<3;k++){outside[k*2]+=q[k]<-q[3];outside[k*2+1]+=q[k]>q[3];}
        if(q[3]<=2.f){behind=true;continue;}
        rect[0]=std::min(rect[0],q[0]/q[3]);rect[1]=std::min(rect[1],q[1]/q[3]);rect[2]=std::max(rect[2],q[0]/q[3]);rect[3]=std::max(rect[3],q[1]/q[3]);
    }
    for(auto n:outside)if(n==8)return false;
    if(behind)rect={-1e9f,-1e9f,1e9f,1e9f};else{rect[0]-=.002f;rect[1]-=.002f;rect[2]+=.002f;rect[3]+=.002f;}
    return true;
}
inline Bounds transformed_bounds(const Bounds &b,const native::Matrix &m){Bounds out;out.lo.fill(1e30f);out.hi.fill(-1e30f);for(unsigned i=0;i<8;i++){const auto p=transform_point(m,{i&1?b.hi[0]:b.lo[0],i&2?b.hi[1]:b.lo[1],i&4?b.hi[2]:b.lo[2]});for(int k=0;k<3;k++){out.lo[k]=std::min(out.lo[k],p[k]);out.hi[k]=std::max(out.hi[k],p[k]);}}return out;}
struct WaterSurface {Vec3 center{},color{};std::array<float,2> range{};};
inline const WaterSurface *water_surface(const Bounds &b,const std::vector<WaterSurface> &surfaces){for(const auto &s:surfaces)if(std::abs(s.center[2]-b.hi[2])<2&&s.center[0]>=b.lo[0]-1&&s.center[0]<=b.hi[0]+1&&s.center[1]>=b.lo[1]-1&&s.center[1]<=b.hi[1]+1)return &s;return surfaces.empty()?nullptr:&surfaces.front();}
inline float particle_random(uint32_t id,uint32_t salt){uint32_t h=id^((salt+1)*0x9e3779b9u);h^=h>>16;h*=0x85ebca6bu;h^=h>>13;h*=0xc2b2ae35u;h^=h>>16;return float(double(h)/4294967296.);}
struct ShotBasis {Vec3 muzzle{},right{},up{};};
// Freeze the basis from the authoritative shot ray, independently of subsequent camera motion.
inline ShotBasis shot_basis(const Vec3 &start,const Vec3 &end,bool leftHand){
    Vec3 forward{};for(int k=0;k<3;k++)forward[k]=end[k]-start[k];float length=std::hypot(std::hypot(forward[0],forward[1]),forward[2]);if(length<1e-5f)forward={1,0,0};else for(float &v:forward)v/=length;
    Vec3 right={forward[1],-forward[0],0};length=std::hypot(right[0],right[1]);if(length<1e-5f)right={0,-1,0};else for(float &v:right)v/=length;
    ShotBasis out;out.up={right[1]*forward[2]-right[2]*forward[1],right[2]*forward[0]-right[0]*forward[2],right[0]*forward[1]-right[1]*forward[0]};
    for(int k=0;k<3;k++){out.right[k]=right[k]*(leftHand?-1.f:1.f);out.muzzle[k]=start[k]+out.right[k]*5-out.up[k]*4;}return out;
}
inline float ghost_trail_alpha(float opacity,float progress){return std::clamp(opacity*1.2f,0.f,1.f)*std::clamp(progress,0.f,1.f);}
template<class T,size_t Capacity> class EventQueue {std::deque<T> values;public:void push(const T &event){if(values.size()==Capacity)values.pop_front();values.push_back(event);}std::vector<T> take(){std::vector<T> out(values.begin(),values.end());values.clear();return out;}void clear(){values.clear();}size_t size()const{return values.size();}};
using Plane=std::array<float,4>;
inline Vec3 cross(const Vec3&a,const Vec3&b){return {a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]};}
inline float dot(const Vec3&a,const Vec3&b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
// Convex brush faces from half-spaces n.p <= d; bounds include brushes omitted from the render mesh.
inline std::vector<std::array<Vec3,3>> convex_triangles(const std::vector<Plane>&planes){
    std::vector<Vec3> points;std::vector<std::array<Vec3,3>> triangles;if(planes.size()>128)return triangles;
    for(size_t i=0;i<planes.size();i++)for(size_t j=i+1;j<planes.size();j++)for(size_t k=j+1;k<planes.size();k++){
        Vec3 a={planes[i][0],planes[i][1],planes[i][2]},b={planes[j][0],planes[j][1],planes[j][2]},c={planes[k][0],planes[k][1],planes[k][2]};const auto bc=cross(b,c),ca=cross(c,a),ab=cross(a,b);const float denom=dot(a,bc);if(std::abs(denom)<1e-6f)continue;Vec3 p;for(int n=0;n<3;n++)p[n]=(bc[n]*planes[i][3]+ca[n]*planes[j][3]+ab[n]*planes[k][3])/denom;
        bool inside=true;for(const auto &q:planes)if(q[0]*p[0]+q[1]*p[1]+q[2]*p[2]-q[3]>.05f){inside=false;break;}if(!inside)continue;bool duplicate=false;for(const auto &q:points){float d=0;for(int n=0;n<3;n++)d+=(q[n]-p[n])*(q[n]-p[n]);if(d<.001f){duplicate=true;break;}}if(!duplicate)points.push_back(p);
    }
    for(const auto &plane:planes){std::vector<Vec3> face;Vec3 center{};for(const auto &p:points)if(std::abs(plane[0]*p[0]+plane[1]*p[1]+plane[2]*p[2]-plane[3])<.1f){face.push_back(p);for(int k=0;k<3;k++)center[k]+=p[k];}if(face.size()<3)continue;for(float &x:center)x/=face.size();const Vec3 normal={plane[0],plane[1],plane[2]},axis=std::abs(normal[2])<.9f?Vec3{0,0,1}:Vec3{0,1,0};const auto u=cross(normal,axis),v=cross(normal,u);std::sort(face.begin(),face.end(),[&](const Vec3&a,const Vec3&b){Vec3 da,db;for(int k=0;k<3;k++){da[k]=a[k]-center[k];db[k]=b[k]-center[k];}return std::atan2(dot(da,v),dot(da,u))<std::atan2(dot(db,v),dot(db,u));});for(size_t i=1;i+1<face.size();i++)triangles.push_back({face[0],face[i],face[i+1]});}
    return triangles;
}

}
