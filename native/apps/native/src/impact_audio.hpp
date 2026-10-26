#pragma once
#include "bunnyhop_native.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cctype>
#include <map>
#include <string>
#include <tuple>
#include <unordered_map>
#include <vector>
namespace native {
// Web audio/impacts.ts: material at the actual hit point, including walls and
// transformed brush models. Props without render triangles fall back to concrete.
class ImpactSurfaces {
    using V=std::array<double,3>;
    struct Triangle{V a,b,c,n;double plane;int surface;};
    struct Model{std::vector<Triangle> triangles;std::array<std::map<std::tuple<int,int,int>,std::vector<size_t>>,4> cells;};
    std::unordered_map<uint32_t,Model> models;
    static constexpr double sizes[4]={64,256,1024,4096};
    static V minus(const V&a,const V&b){return {a[0]-b[0],a[1]-b[1],a[2]-b[2]};}
    static V cross(const V&a,const V&b){return {a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]};}
    static double dot(const V&a,const V&b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
    static double length(const V&a){return std::sqrt(dot(a,a));}
    static int classify(std::string name){
        std::transform(name.begin(),name.end(),name.begin(),[](unsigned char c){return char(std::tolower(c));});
        if(name.starts_with("tools/")||name.find("nodraw")!=std::string::npos||name.find("skybox")!=std::string::npos)return -1;
        const std::vector<std::vector<std::string>> words={{"metal","grate","steel","iron","chainlink","duct","vent","pipe","tin","alum","diamond","plate","rust","catwalk"},{"wood","plank","crate","board","parquet","bamboo","barrel"},{"concrete","brick","cement","stone","rock"},{"grass","dirt","mud","sand","gravel","snow","nature","ground","leaves","soil","moss","hay","carpet","rug","fabric","cloth"},{"tile","ceramic","glass","marble","porcelain"}};
        for(size_t i=0;i<words.size();++i)for(const auto &w:words[i])if(name.find(w)!=std::string::npos)return int(i);return -1;
    }
    static V local(const BhTransform&t,const V&p,bool direction){
        const double d=3.141592653589793/180,sp=std::sin(t.angles[0]*d),cp=std::cos(t.angles[0]*d),sy=std::sin(t.angles[1]*d),cy=std::cos(t.angles[1]*d),sr=std::sin(t.angles[2]*d),cr=std::cos(t.angles[2]*d);
        const double x=p[0]-(direction?0:t.origin[0]),y=p[1]-(direction?0:t.origin[1]),z=p[2]-(direction?0:t.origin[2]);
        return {cp*cy*x+cp*sy*y-sp*z,(sr*sp*cy-cr*sy)*x+(sr*sp*sy+cr*cy)*y+sr*cp*z,(cr*sp*cy+sr*sy)*x+(cr*sp*sy-sr*cy)*y+cr*cp*z};
    }
    static int query(const Model&m,const V&p,const V&normal){
        double best=4;int found=-1;
        for(int l=0;l<4;++l){const int cx=int(std::floor(p[0]/sizes[l])),cy=int(std::floor(p[1]/sizes[l])),cz=int(std::floor(p[2]/sizes[l]));
            for(int dx=-1;dx<=1;++dx)for(int dy=-1;dy<=1;++dy)for(int dz=-1;dz<=1;++dz){const auto cell=m.cells[l].find({cx+dx,cy+dy,cz+dz});if(cell==m.cells[l].end())continue;
                for(const auto i:cell->second){const auto &t=m.triangles[i];const double distance=std::abs(dot(t.n,p)-t.plane);if(distance>3||distance>=best||(length(normal)>.5&&std::abs(dot(t.n,normal))<.7))continue;
                    bool inside=true;for(const auto &edge:std::array<std::pair<V,V>,3>{{{t.a,t.b},{t.b,t.c},{t.c,t.a}}}){const auto e=minus(edge.second,edge.first);if(dot(cross(e,minus(p,edge.first)),t.n)/std::max(1.,length(e))< -2){inside=false;break;}}
                    if(inside){best=distance;found=t.surface;}
                }
            }
        }return found;
    }
public:
    void build(BhContext *core){
        models.clear();if(!core)return;size_t nv=0,ni=0,ng=0,nm=0,bytes=0;const auto *v=bh_vertices(core,&nv);const auto *idx=bh_indices(core,&ni);const auto *groups=bh_groups(core,&ng);const auto *materials=bh_materials(core,&nm);const auto *raw=bh_material_names_json(core,&bytes);if(!v||!idx||!groups||!raw)return;const auto names=nlohmann::json::parse(raw,raw+bytes);
        for(size_t g=0;g<ng;++g){const auto &group=groups[g];if(group.sky3d||group.material>=names.size()||group.material>=nm||materials[group.material].kind==2)continue;
            const int surface=materials[group.material].kind==3?4:classify(names[group.material].get<std::string>());if(surface<0)continue;auto &model=models[group.model];
            for(size_t i=group.first_index;i+2<std::min(ni,size_t(group.first_index)+group.index_count);i+=3){if(size_t(std::max({idx[i],idx[i+1],idx[i+2]}))*10+2>=nv)continue;Triangle t{};auto at=[&](uint32_t j){return V{v[j*10],v[j*10+1],v[j*10+2]};};t.a=at(idx[i]);t.b=at(idx[i+1]);t.c=at(idx[i+2]);t.n=cross(minus(t.b,t.a),minus(t.c,t.a));const double len=length(t.n);if(len<1e-6)continue;for(auto &n:t.n)n/=len;t.plane=dot(t.n,t.a);t.surface=surface;
                V center{};for(int k=0;k<3;++k)center[k]=(t.a[k]+t.b[k]+t.c[k])/3;const double radius=std::max({length(minus(t.a,center)),length(minus(t.b,center)),length(minus(t.c,center))});int level=0;while(level<3&&radius+5>sizes[level])++level;
                model.cells[level][{int(std::floor(center[0]/sizes[level])),int(std::floor(center[1]/sizes[level])),int(std::floor(center[2]/sizes[level]))}].push_back(model.triangles.size());model.triangles.push_back(t);
            }
        }
    }
    std::string surface(BhContext *core,const BhAttackReport &attack)const{
        const V p={attack.end[0],attack.end[1],attack.end[2]},n={attack.normal[0],attack.normal[1],attack.normal[2]};int surface=-1;
        for(const auto &[id,model]:models){BhTransform t{};if(id&&(!core||!bh_model_transform(core,id,&t)))continue;const int found=query(model,id?local(t,p,false):p,id?local(t,n,true):n);if(found>=0){surface=found;break;}}
        static const char *ids[]={"metal","wood","concrete","dirt","tile"};return surface>=0?ids[surface]:"concrete";
    }
};
}
