#pragma once
#include "bunnyhop_native.h"
#include "native_input.hpp"
#include "native_math.hpp"
#include "render_shaders.hpp"
#include "nlohmann/json.hpp"
#include <filesystem>
#include <sstream>
#include <regex>
#include <zlib.h>
#include <memory>
#include <optional>
#include <array>
#include <SDL3/SDL.h>
#include <SDL3/SDL_opengl.h>
#include <algorithm>
#include <cmath>
#include <deque>
#include <fstream>
#include <iostream>
#include <limits>
#include <numeric>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
// All GL entry points come from the active SDL context, including on Linux.
#define GL_FUNCTIONS(X) \
 X(void,Viewport,(GLint,GLint,GLsizei,GLsizei)) \
 X(void,ClearColor,(GLfloat,GLfloat,GLfloat,GLfloat)) \
 X(void,Clear,(GLbitfield)) X(void,Enable,(GLenum)) X(void,Disable,(GLenum)) \
 X(void,ColorMask,(GLboolean,GLboolean,GLboolean,GLboolean)) X(void,PolygonOffset,(GLfloat,GLfloat)) \
 X(void,DepthMask,(GLboolean)) X(void,DepthFunc,(GLenum)) \
 X(void,CullFace,(GLenum)) X(void,FrontFace,(GLenum)) X(void,BlendFunc,(GLenum,GLenum)) \
 X(void,GenVertexArrays,(GLsizei,GLuint*)) X(void,BindVertexArray,(GLuint)) \
 X(void,DeleteVertexArrays,(GLsizei,const GLuint*)) \
 X(void,GenBuffers,(GLsizei,GLuint*)) X(void,BindBuffer,(GLenum,GLuint)) \
 X(void,BufferData,(GLenum,GLsizeiptr,const void*,GLenum)) X(void,DeleteBuffers,(GLsizei,const GLuint*)) \
 X(void,EnableVertexAttribArray,(GLuint)) \
 X(void,VertexAttribPointer,(GLuint,GLint,GLenum,GLboolean,GLsizei,const void*)) \
 X(GLuint,CreateShader,(GLenum)) X(void,ShaderSource,(GLuint,GLsizei,const GLchar* const*,const GLint*)) \
 X(void,CompileShader,(GLuint)) X(void,GetShaderiv,(GLuint,GLenum,GLint*)) \
 X(void,GetShaderInfoLog,(GLuint,GLsizei,GLsizei*,GLchar*)) X(void,DeleteShader,(GLuint)) \
 X(GLuint,CreateProgram,(void)) X(void,AttachShader,(GLuint,GLuint)) X(void,LinkProgram,(GLuint)) \
 X(void,GetProgramiv,(GLuint,GLenum,GLint*)) X(void,GetProgramInfoLog,(GLuint,GLsizei,GLsizei*,GLchar*)) \
 X(void,DeleteProgram,(GLuint)) X(void,UseProgram,(GLuint)) \
 X(GLint,GetUniformLocation,(GLuint,const GLchar*)) \
 X(void,UniformMatrix4fv,(GLint,GLsizei,GLboolean,const GLfloat*)) \
 X(void,Uniform1i,(GLint,GLint)) X(void,Uniform1f,(GLint,GLfloat)) \
 X(void,Uniform3fv,(GLint,GLsizei,const GLfloat*)) X(void,Uniform2fv,(GLint,GLsizei,const GLfloat*)) \
 X(void,Uniform1iv,(GLint,GLsizei,const GLint*)) X(void,Uniform3f,(GLint,GLfloat,GLfloat,GLfloat)) \
 X(void,GenTextures,(GLsizei,GLuint*)) X(void,BindTexture,(GLenum,GLuint)) \
 X(void,ActiveTexture,(GLenum)) X(void,TexParameteri,(GLenum,GLenum,GLint)) \
 X(void,TexImage2D,(GLenum,GLint,GLint,GLsizei,GLsizei,GLint,GLenum,GLenum,const void*)) \
 X(void,GenerateMipmap,(GLenum)) X(void,DeleteTextures,(GLsizei,const GLuint*)) \
 X(void,DrawElements,(GLenum,GLsizei,GLenum,const void*)) \
 X(void,DrawArrays,(GLenum,GLint,GLsizei)) X(void,PixelStorei,(GLenum,GLint)) \
 X(void,ReadPixels,(GLint,GLint,GLsizei,GLsizei,GLenum,GLenum,void*)) \
 X(void,GetIntegerv,(GLenum,GLint*)) X(const GLubyte*,GetString,(GLenum)) \
 X(GLenum,GetError,(void)) X(void,Uniform2f,(GLint,GLfloat,GLfloat)) \
 X(void,GenFramebuffers,(GLsizei,GLuint*)) X(void,BindFramebuffer,(GLenum,GLuint)) X(void,DeleteFramebuffers,(GLsizei,const GLuint*)) \
 X(void,FramebufferTexture2D,(GLenum,GLenum,GLenum,GLuint,GLint)) X(GLenum,CheckFramebufferStatus,(GLenum)) \
 X(void,GenRenderbuffers,(GLsizei,GLuint*)) X(void,BindRenderbuffer,(GLenum,GLuint)) X(void,DeleteRenderbuffers,(GLsizei,const GLuint*)) \
 X(void,RenderbufferStorage,(GLenum,GLenum,GLsizei,GLsizei)) X(void,FramebufferRenderbuffer,(GLenum,GLenum,GLenum,GLuint)) \
 X(void*,MapBufferRange,(GLenum,GLintptr,GLsizeiptr,GLbitfield)) X(GLboolean,UnmapBuffer,(GLenum)) \
 X(GLsync,FenceSync,(GLenum,GLbitfield)) X(GLenum,ClientWaitSync,(GLsync,GLbitfield,GLuint64)) X(void,DeleteSync,(GLsync))
struct Gl {
#define DECLARE(ret,name,args) ret (APIENTRY *name) args = nullptr;
    GL_FUNCTIONS(DECLARE)
#undef DECLARE
    void load() {
#define LOAD(ret,name,args) name = reinterpret_cast<decltype(name)>(SDL_GL_GetProcAddress("gl" #name)); if (!name) throw std::runtime_error("Missing OpenGL function gl" #name);
        GL_FUNCTIONS(LOAD)
#undef LOAD
    }
};

GLuint shader(Gl &gl, GLenum kind, const char *source) {
    GLuint id = gl.CreateShader(kind);
    gl.ShaderSource(id, 1, &source, nullptr); gl.CompileShader(id);
    GLint ok = 0; gl.GetShaderiv(id, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[4096]{}; gl.GetShaderInfoLog(id, sizeof(log), nullptr, log); gl.DeleteShader(id);
        throw std::runtime_error(std::string("Shader compilation failed: ") + log);
    }
    return id;
}

GLuint link_program(Gl &gl,const char *vertex_source,const char *fragment_source) {
    const GLuint vertex=shader(gl,GL_VERTEX_SHADER,vertex_source);GLuint fragment=0,program=0;
    try {fragment=shader(gl,GL_FRAGMENT_SHADER,fragment_source);program=gl.CreateProgram();gl.AttachShader(program,vertex);gl.AttachShader(program,fragment);gl.LinkProgram(program);GLint ok=0;gl.GetProgramiv(program,GL_LINK_STATUS,&ok);if(!ok){char log[4096]{};gl.GetProgramInfoLog(program,sizeof(log),nullptr,log);throw std::runtime_error(std::string("Shader link failed: ")+log);}}
    catch(...){gl.DeleteShader(vertex);if(fragment)gl.DeleteShader(fragment);if(program)gl.DeleteProgram(program);throw;}
    gl.DeleteShader(vertex);gl.DeleteShader(fragment);return program;
}
#include "native_viewmodel.hpp"
// Inside this file's anonymous namespace: its standard headers are included above, at file scope, so they are never
// first seen in here (MSVC's <deque> was).
#include "source_hdr.hpp"

class Renderer {
    struct Geometry {GLuint vao=0,vbo=0,ebo=0,blend=0;size_t indices=0;};
    struct Volume {std::array<float,3> lo{},hi{},color{.2f,.3f,.35f};std::array<float,2> range{0,400},span{};};
    Gl &gl;BhContext *core;
    Geometry worldMesh,propMesh,skyMesh;
    float fieldOfView=90;std::vector<native_render::Actor> roomActors;std::optional<native_render::Actor> replayActor;std::string outfit,packedLoadout;
    GLuint program=0,skyProgram=0,emptyVao=0,lightmap=0,white=0,checker=0,planesTexture=0;
    std::vector<GLuint> ownedTextures;
    std::unordered_map<uint64_t,GLuint> textures;
    std::unordered_map<int32_t,std::pair<uint32_t,uint32_t>> textureSizes;
    std::vector<BhGroup> groups,skyGroups;std::vector<BhPropGroup> propGroups;
    std::vector<GLuint> normals;std::array<float,3> sunDirection{.35f,.45f,.82f};bool hasSun=false;
    std::vector<BhMaterial> materials;std::vector<BhMaterialExtra> extras;
    std::vector<Volume> volumes;std::array<int32_t,6> skyMaterials{-1,-1,-1,-1,-1,-1};BhSkyInfo skyInfo{};bool hasSky=false;
    std::unique_ptr<NativeViewmodel> viewmodel;bool viewmodelVisible=true;std::optional<uint32_t> viewmodelWeapon;
    // Source look (source_hdr.hpp): CS:S's exposure and bloom on maps whose lightmap came from HDR lighting.
    BhLightmapInfo lightmapInfo{1,0};bool sourceLook=true,hdrUnavailable=false;std::unique_ptr<SourceHdr> hdr;double lastSeconds=-1;
    SourceHdr *hdr_pass(){
        if(!sourceLook||!lightmapInfo.hdr||hdrUnavailable)return nullptr;
        if(!hdr)try{hdr=std::make_unique<SourceHdr>(gl,emptyVao);}catch(const std::exception &e){hdrUnavailable=true;std::cerr<<"Native HDR unavailable, drawing straight: "<<e.what()<<'\n';return nullptr;}
        return hdr.get();
    }
    uint32_t queuedWeaponFlags=0,queuedAttackMode=0;bool queuedAttack=false;
    std::unordered_map<GLuint,std::unordered_map<std::string,GLint>> uniformLocations;
    GLint loc(GLuint p,const char *name){auto &locations=uniformLocations[p];const auto found=locations.find(name);if(found!=locations.end())return found->second;const GLint value=gl.GetUniformLocation(p,name);locations.emplace(name,value);return value;}
    GLuint upload(const BhImage &image,bool repeat,bool mipmap,bool srgb=true){
        if(!image.rgba||!image.width||!image.height||uint64_t(image.width)*image.height*4>image.byte_count)throw std::runtime_error("Invalid native texture");
        GLint limit=0;gl.GetIntegerv(GL_MAX_TEXTURE_SIZE,&limit);if(image.width>uint32_t(limit)||image.height>uint32_t(limit))throw std::runtime_error("Native texture exceeds GPU limit");
        GLuint id=0;gl.GenTextures(1,&id);ownedTextures.push_back(id);gl.BindTexture(GL_TEXTURE_2D,id);
        gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,mipmap?GL_LINEAR_MIPMAP_LINEAR:GL_LINEAR);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_LINEAR);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,repeat?GL_REPEAT:GL_CLAMP_TO_EDGE);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,repeat?GL_REPEAT:GL_CLAMP_TO_EDGE);gl.PixelStorei(GL_UNPACK_ALIGNMENT,1);
        gl.TexImage2D(GL_TEXTURE_2D,0,srgb?GL_SRGB8_ALPHA8:GL_RGBA8,image.width,image.height,0,GL_RGBA,GL_UNSIGNED_BYTE,image.rgba);if(mipmap)gl.GenerateMipmap(GL_TEXTURE_2D);return id;
    }
    GLuint texture(int32_t index,bool raw=false){if(index<0)return white;const uint64_t key=uint32_t(index)|(uint64_t(raw)<<32);const auto found=textures.find(key);return found==textures.end()?checker:found->second;}
    void cache_texture(int32_t index,bool raw=false){if(index<0)return;const uint64_t key=uint32_t(index)|(uint64_t(raw)<<32);if(textures.count(key))return;BhImage image{};GLuint id=checker;if(bh_texture(core,index,&image)){textureSizes[index]={image.width,image.height};id=upload(image,true,true,!raw);}textures.emplace(key,id);}
    std::string normal_path(std::string name,int depth=0){
        if(depth>6)return {};std::transform(name.begin(),name.end(),name.begin(),[](unsigned char c){return char(std::tolower(c));});std::replace(name.begin(),name.end(),'\\','/');if(name.rfind("materials/",0)==0)name.erase(0,10);if(name.ends_with(".vmt"))name.resize(name.size()-4);
        const std::string path="materials/"+name+".vmt";size_t count=0;const auto *raw=bh_content_read(core,path.c_str(),&count);if(!raw||!count)return {};std::string text(reinterpret_cast<const char*>(raw),count);text=std::regex_replace(text,std::regex(R"(//[^\r\n]*)"),"");
        if(std::regex_search(text,std::regex(R"("?\$ssbump"?\s+"?1\b)",std::regex::icase))||std::regex_search(text,std::regex(R"("?\$bumptransform"?\s+)",std::regex::icase)))return {};
        std::smatch match;if(std::regex_search(text,match,std::regex(R"rx("?\$bumpmap"?\s+"([^"\r\n]+)")rx",std::regex::icase))){std::string bump=match[1];std::transform(bump.begin(),bump.end(),bump.begin(),[](unsigned char c){return char(std::tolower(c));});std::replace(bump.begin(),bump.end(),'\\','/');if(bump.rfind("materials/",0)==0)bump.erase(0,10);if(bump.ends_with(".vtf"))bump.resize(bump.size()-4);return "materials/"+bump+".vtf";}
        if(std::regex_search(text,match,std::regex(R"rx("?include"?\s+"([^"\r\n]+)")rx",std::regex::icase)))return normal_path(match[1],depth+1);return {};
    }
    void load_normals(){
        size_t count=0;const char *raw=bh_entities_json(core,&count);if(raw&&count){const auto entities=nlohmann::json::parse(raw,raw+count);for(const auto &e:entities){if(e.value("classname","")!="light_environment")continue;float pitch=0,yaw=0,roll=0;std::stringstream angles(e.value("angles","0 0 0"));angles>>pitch>>yaw>>roll;if(e.contains("pitch"))try{pitch=std::stof(e.at("pitch").get<std::string>());}catch(...){break;}if(std::isfinite(pitch)&&std::isfinite(yaw)){pitch*=native::radians;yaw*=native::radians;sunDirection={-std::cos(pitch)*std::cos(yaw),-std::cos(pitch)*std::sin(yaw),-std::sin(pitch)};hasSun=true;}break;}}
        normals.resize(materials.size());if(!hasSun)return;raw=bh_material_names_json(core,&count);if(!raw||!count)return;const auto names=nlohmann::json::parse(raw,raw+count);std::unordered_map<std::string,GLuint> cached;
        for(size_t i=0;i<normals.size()&&i<names.size();i++){const auto path=normal_path(names[i]);if(path.empty())continue;if(cached.count(path)){normals[i]=cached.at(path);continue;}size_t bytes=0;const auto *vtf=bh_content_read(core,path.c_str(),&bytes);if(!vtf||bytes<64||vtf[0]!='V'||vtf[1]!='T'||vtf[2]!='F'||vtf[3]!=0)continue;const uint32_t f=uint32_t(vtf[52])|(uint32_t(vtf[53])<<8)|(uint32_t(vtf[54])<<16)|(uint32_t(vtf[55])<<24);if(f!=0&&f!=1&&f!=2&&f!=3&&f!=11&&f!=12&&f!=13&&f!=14&&f!=15&&f!=16&&f!=20)continue;BhImage image{};if(bh_texture_path(core,path.c_str(),&image)){normals[i]=upload(image,true,true,false);cached.emplace(path,normals[i]);}}
        std::cout<<"Native embedded normal textures: "<<cached.size()<<"\n";
    }
    Geometry geometry(const float *vertices,size_t floats,int stride,const uint32_t *indices,size_t count,const float *blend=nullptr,size_t blends=0){
        Geometry out;if(!floats||!count)return out;if(!vertices||!indices||floats%stride||count>size_t(std::numeric_limits<GLsizei>::max()))throw std::runtime_error("Invalid native geometry buffer");
        for(size_t i=0;i<count;i++)if(indices[i]>=floats/stride)throw std::runtime_error("Native mesh index out of bounds");
        out.indices=count;gl.GenVertexArrays(1,&out.vao);gl.BindVertexArray(out.vao);gl.GenBuffers(1,&out.vbo);gl.BindBuffer(GL_ARRAY_BUFFER,out.vbo);gl.BufferData(GL_ARRAY_BUFFER,floats*sizeof(float),vertices,GL_STATIC_DRAW);gl.GenBuffers(1,&out.ebo);gl.BindBuffer(GL_ELEMENT_ARRAY_BUFFER,out.ebo);gl.BufferData(GL_ELEMENT_ARRAY_BUFFER,count*sizeof(uint32_t),indices,GL_STATIC_DRAW);
        gl.EnableVertexAttribArray(0);gl.VertexAttribPointer(0,3,GL_FLOAT,GL_FALSE,stride*sizeof(float),nullptr);
        if(stride>=8){for(int i=1;i<3;i++){gl.EnableVertexAttribArray(i);gl.VertexAttribPointer(i,i==1?3:2,GL_FLOAT,GL_FALSE,stride*sizeof(float),reinterpret_cast<void*>(size_t(i==1?3:6)*sizeof(float)));}}
        if(stride==10){gl.EnableVertexAttribArray(3);gl.VertexAttribPointer(3,2,GL_FLOAT,GL_FALSE,stride*sizeof(float),reinterpret_cast<void*>(8*sizeof(float)));}
        if(blend&&blends==floats/stride){gl.GenBuffers(1,&out.blend);gl.BindBuffer(GL_ARRAY_BUFFER,out.blend);gl.BufferData(GL_ARRAY_BUFFER,blends*sizeof(float),blend,GL_STATIC_DRAW);gl.EnableVertexAttribArray(4);gl.VertexAttribPointer(4,1,GL_FLOAT,GL_FALSE,sizeof(float),nullptr);}
        return out;
    }
    void destroy(Geometry &mesh){if(mesh.blend)gl.DeleteBuffers(1,&mesh.blend);if(mesh.ebo)gl.DeleteBuffers(1,&mesh.ebo);if(mesh.vbo)gl.DeleteBuffers(1,&mesh.vbo);if(mesh.vao)gl.DeleteVertexArrays(1,&mesh.vao);}
    bool transparent(const BhMaterial &m)const{return (m.flags&(1|8))||m.kind==2||m.kind==3||m.alpha<1;}
    void bind_material(uint32_t index,bool prop){
        const BhMaterial fallback={-1,1,0,1,.5f,{1,1,1}};const auto &m=index<materials.size()?materials[index]:fallback;
        const BhMaterialExtra empty={-1,-1,4,1,0,400,1};const auto &e=index<extras.size()?extras[index]:empty;
        gl.ActiveTexture(GL_TEXTURE0);gl.BindTexture(GL_TEXTURE_2D,m.texture<0?(m.kind==1?checker:white):texture(m.texture));
        gl.ActiveTexture(GL_TEXTURE2);gl.BindTexture(GL_TEXTURE_2D,texture(e.texture2));gl.ActiveTexture(GL_TEXTURE3);gl.BindTexture(GL_TEXTURE_2D,texture(e.detail,true));
        gl.ActiveTexture(GL_TEXTURE7);gl.BindTexture(GL_TEXTURE_2D,index<normals.size()&&normals[index]?normals[index]:white);gl.Uniform1i(loc(program,"hasNormal"),index<normals.size()&&normals[index]);
        gl.Uniform1i(loc(program,"hasSecondary"),e.texture2>=0);gl.Uniform1i(loc(program,"hasDetail"),e.detail>=0);gl.Uniform1f(loc(program,"detailScale"),e.detail_scale);gl.Uniform1f(loc(program,"detailBlend"),e.detail_blend);
        gl.Uniform3fv(loc(program,"tint"),1,m.color);gl.Uniform1f(loc(program,"opacity"),m.alpha);gl.Uniform1f(loc(program,"cutoff"),(m.flags&2)?m.alpha_ref:0);gl.Uniform1i(loc(program,"unlit"),(m.flags&16)!=0||(!prop&&lightmap==white));gl.Uniform1i(loc(program,"props"),prop);gl.Uniform1i(loc(program,"kind"),m.kind);gl.Uniform1i(loc(program,"aboveWater"),e.above_water);gl.Uniform1i(loc(program,"additive"),(m.flags&8)!=0);
        if((m.flags&4)||m.kind==2)gl.Disable(GL_CULL_FACE);else gl.Enable(GL_CULL_FACE);gl.BlendFunc(GL_SRC_ALPHA,(m.flags&8)?GL_ONE:GL_ONE_MINUS_SRC_ALPHA);
        if(m.kind==2){gl.Enable(GL_POLYGON_OFFSET_FILL);gl.PolygonOffset(-1,-4);}else gl.Disable(GL_POLYGON_OFFSET_FILL);
    }
    void water_uniforms(GLuint target,const float eye[3]){
        gl.Uniform3fv(loc(target,"cameraPosition"),1,eye);std::vector<size_t> order(volumes.size());for(size_t i=0;i<order.size();i++)order[i]=i;
        auto distance=[&](size_t i){float d=0;for(int k=0;k<3;k++){const float n=std::max({volumes[i].lo[k]-eye[k],0.f,eye[k]-volumes[i].hi[k]});d+=n*n;}return d;};
        std::stable_sort(order.begin(),order.end(),[&](size_t a,size_t b){return distance(a)<distance(b);});if(order.size()>24)order.resize(24);
        float lo[72]{},hi[72]{},color[72]{},range[48]{},span[48]{};for(size_t n=0;n<order.size();n++){const auto &v=volumes[order[n]];for(int k=0;k<3;k++){lo[n*3+k]=v.lo[k];hi[n*3+k]=v.hi[k];color[n*3+k]=v.color[k];}for(int k=0;k<2;k++){range[n*2+k]=v.range[k];span[n*2+k]=v.span[k];}}
        gl.Uniform1i(loc(target,"waterCount"),order.size());if(!order.empty()){gl.Uniform3fv(loc(target,"waterMin"),order.size(),lo);gl.Uniform3fv(loc(target,"waterMax"),order.size(),hi);gl.Uniform3fv(loc(target,"waterColor"),order.size(),color);gl.Uniform2fv(loc(target,"waterRange"),order.size(),range);gl.Uniform2fv(loc(target,"waterSpan"),order.size(),span);}
        gl.ActiveTexture(GL_TEXTURE6);gl.BindTexture(GL_TEXTURE_2D,planesTexture);gl.Uniform1i(loc(target,"waterPlanes"),6);
    }
    void draw_scene(const native::Matrix &vp,const float eye[3],bool sky,double time){
        gl.UseProgram(program);gl.UniformMatrix4fv(loc(program,"viewProjection"),1,GL_FALSE,vp.data());water_uniforms(program,eye);gl.Uniform1f(loc(program,"timeSeconds"),time);gl.Uniform1i(loc(program,"skyPass"),sky&&hasSky&&skyInfo.fog_enable);
        float fog[3]={skyInfo.fog_color[0]/255.f,skyInfo.fog_color[1]/255.f,skyInfo.fog_color[2]/255.f};
        if(skyInfo.fog_blend){const float dx=std::cos(lastPitch*native::radians)*std::cos(lastYaw*native::radians),dy=std::cos(lastPitch*native::radians)*std::sin(lastYaw*native::radians),dz=-std::sin(lastPitch*native::radians);const float len=std::hypot(std::hypot(skyInfo.fog_dir[0],skyInfo.fog_dir[1]),skyInfo.fog_dir[2]);const float t=len>0?std::clamp(.5f+.5f*(dx*skyInfo.fog_dir[0]+dy*skyInfo.fog_dir[1]+dz*skyInfo.fog_dir[2])/len,0.f,1.f):0;for(int k=0;k<3;k++)fog[k]=(skyInfo.fog_color[k]*(1-t)+skyInfo.fog_color2[k]*t)/255.f;}
        gl.Uniform3fv(loc(program,"skyFogColor"),1,fog);gl.Uniform3f(loc(program,"skyFogRange"),skyInfo.fog_start/std::max(skyInfo.scale,.001f),skyInfo.fog_end/std::max(skyInfo.scale,.001f),skyInfo.fog_max_density);
        gl.ActiveTexture(GL_TEXTURE1);gl.BindTexture(GL_TEXTURE_2D,lightmap);
        std::unordered_map<uint64_t,BhTransform> transforms;
        struct Draw {uint32_t material,first,count;bool prop;int32_t entity;uint32_t model;float distance;};std::vector<Draw> draws;
        for(const auto &g:groups)if(bool(g.sky3d)==sky)draws.push_back({g.material,g.first_index,g.index_count,false,-1,g.model,0});
        for(const auto &g:propGroups)if(bool(g.sky3d)==sky)draws.push_back({g.material,g.first_index,g.index_count,true,g.entity,0,0});
        // Preserve opaque grouping; transparent surfaces are sorted far-to-near by group bounds.
        for(auto &d:draws){const auto at=centers.find((uint64_t(d.prop)<<63)|d.first);if(at!=centers.end())for(int k=0;k<3;k++){const float n=at->second[k]-eye[k];d.distance+=n*n;}}
        for(int pass=0;pass<2;pass++){
            if(pass){gl.Enable(GL_BLEND);gl.DepthMask(GL_FALSE);std::stable_sort(draws.begin(),draws.end(),[](const Draw &a,const Draw &b){return a.distance>b.distance;});}else{gl.Disable(GL_BLEND);gl.DepthMask(GL_TRUE);}
            for(const auto &d:draws){const auto &m=d.material<materials.size()?materials[d.material]:materials.front();if(transparent(m)!=(pass!=0))continue;
                const uint64_t transformKey=(uint64_t(d.prop)<<63)|uint32_t(d.prop?d.entity:d.model);
                auto found=transforms.find(transformKey);if(found==transforms.end()){BhTransform t{};t.visible=1;if(d.prop&&d.entity>=0)bh_prop_transform(core,d.entity,&t);else if(!d.prop&&d.model)bh_model_transform(core,d.model,&t);found=transforms.emplace(transformKey,t).first;}if(!found->second.visible)continue;
                const auto model=native::model_matrix(found->second);gl.UniformMatrix4fv(loc(program,"model"),1,GL_FALSE,model.data());bind_material(d.material,d.prop);gl.BindVertexArray(d.prop?propMesh.vao:worldMesh.vao);gl.DrawElements(GL_TRIANGLES,d.count,GL_UNSIGNED_INT,reinterpret_cast<void*>(uintptr_t(d.first)*sizeof(uint32_t)));
            }
        }
        gl.DepthMask(GL_TRUE);gl.Disable(GL_POLYGON_OFFSET_FILL);gl.Disable(GL_BLEND);
    }
    double lastYaw=0,lastPitch=0;std::unordered_map<uint64_t,std::array<float,3>> centers;
public:
    Renderer(Gl &g,BhContext *c,const std::filesystem::path &assetRoot=BUNNYHOP_NATIVE_ASSET_ROOT):gl(g),core(c){
        program=link_program(gl,native_render::world_vertex,native_render::world_fragment().c_str());skyProgram=link_program(gl,native_render::sky_vertex,native_render::sky_fragment().c_str());gl.GenVertexArrays(1,&emptyVao);
        const uint8_t blank[4]={255,255,255,255};white=upload({blank,4,1,1},true,false);uint8_t fallback[8*8*4];for(int y=0;y<8;y++)for(int x=0;x<8;x++){const uint8_t v=((x/4+y/4)%2)?140:185;const int at=(y*8+x)*4;fallback[at]=fallback[at+1]=fallback[at+2]=v;fallback[at+3]=255;}checker=upload({fallback,sizeof(fallback),8,8},true,true);
        size_t nv=0,ni=0,ng=0,nm=0,ne=0,nb=0;const float *verts=bh_vertices(core,&nv);const uint32_t *indices=bh_indices(core,&ni);const auto *rawGroups=bh_groups(core,&ng);const auto *rawMaterials=bh_materials(core,&nm);const auto *rawExtras=bh_material_extras(core,&ne);const float *blend=bh_blend(core,&nb);
        if(!nv||!ni||!ng||!rawGroups)throw std::runtime_error("Map has no drawable native mesh");if(rawMaterials&&nm)materials.assign(rawMaterials,rawMaterials+nm);if(materials.empty())materials.push_back({-1,1,0,1,.5f,{1,1,1}});if(rawExtras&&ne)extras.assign(rawExtras,rawExtras+ne);groups.assign(rawGroups,rawGroups+ng);worldMesh=geometry(verts,nv,10,indices,ni,blend,nb);
        auto group_center=[&](uint64_t key,uint32_t first,uint32_t count,const float *v,size_t floats,int stride,const uint32_t *ix,size_t n){if(uint64_t(first)+count>n)throw std::runtime_error("Native draw range exceeds index buffer");std::array<float,3> mid{};size_t samples=0;for(size_t i=first;i<size_t(first)+count;i+=3){const size_t at=size_t(ix[i])*stride;if(at+2>=floats)throw std::runtime_error("Native group vertex invalid");for(int k=0;k<3;k++)mid[k]+=v[at+k];samples++;}if(samples)for(float &x:mid)x/=samples;centers[key]=mid;};
        for(const auto &item:groups)group_center(item.first_index,item.first_index,item.index_count,verts,nv,10,indices,ni);
        size_t pv=0,pi=0,pg=0;const float *propVertices=bh_prop_vertices(core,&pv);const auto *propIndices=bh_prop_indices(core,&pi);const auto *rawProps=bh_prop_groups(core,&pg);propMesh=geometry(propVertices,pv,8,propIndices,pi);if(rawProps&&pg)propGroups.assign(rawProps,rawProps+pg);for(const auto &item:propGroups)group_center((uint64_t(1)<<63)|item.first_index,item.first_index,item.index_count,propVertices,pv,8,propIndices,pi);
        size_t sv=0,si=0,sg=0;const float *skyVertices=bh_sky_vertices(core,&sv);const auto *skyIndices=bh_sky_indices(core,&si);const auto *rawSky=bh_sky_groups(core,&sg);skyMesh=geometry(skyVertices,sv,3,skyIndices,si);if(rawSky&&sg)skyGroups.assign(rawSky,rawSky+sg);hasSky=bh_sky_info(core,&skyInfo)!=0;
        size_t skyCount=0;const auto *sky=bh_sky_materials(core,&skyCount);if(sky&&skyCount==6)std::copy(sky,sky+6,skyMaterials.begin());
        // The atlas is sRGB-encoded linear light times its scale (bunnyhop_core::lightmap): decode, then divide.
        BhImage image{};lightmap=bh_lightmap(core,&image)?upload(image,false,false,true):white;if(lightmap==white||!bh_lightmap_info(core,&lightmapInfo))lightmapInfo={1,0};
        for(const auto &m:materials)cache_texture(m.texture);for(const auto &e:extras){cache_texture(e.texture2);cache_texture(e.detail,true);}
        std::vector<float> planes;size_t waterBytes=0;const auto *water=bh_water_json(core,&waterBytes);if(water&&waterBytes){const auto json=nlohmann::json::parse(water,water+waterBytes);const auto boxes=json.value("volumes",nlohmann::json::array()),allPlanes=json.value("planes",nlohmann::json::array());for(size_t i=0;i<boxes.size();i++){if(boxes[i].size()!=6)continue;Volume volume;for(int k=0;k<3;k++){volume.lo[k]=boxes[i][k];volume.hi[k]=boxes[i][k+3];}volume.span[0]=planes.size()/4;if(i<allPlanes.size())for(const auto &p:allPlanes[i])if(p.size()==4)for(int k=0;k<4;k++)planes.push_back(p[k].get<float>());volume.span[1]=planes.size()/4-volume.span[0];
            for(const auto &item:groups){if(item.material>=materials.size()||materials[item.material].kind!=2)continue;const auto &center=centers[item.first_index];if(std::abs(center[2]-volume.hi[2])<3&&center[0]>=volume.lo[0]-1&&center[0]<=volume.hi[0]+1&&center[1]>=volume.lo[1]-1&&center[1]<=volume.hi[1]+1){for(int k=0;k<3;k++)volume.color[k]=materials[item.material].color[k];if(item.material<extras.size()&&extras[item.material].fog_end>extras[item.material].fog_start)volume.range={extras[item.material].fog_start,extras[item.material].fog_end};break;}}
            volumes.push_back(volume);}}
        if(planes.empty())planes.resize(4);GLint limit=0;gl.GetIntegerv(GL_MAX_TEXTURE_SIZE,&limit);if(planes.size()/4>size_t(limit))throw std::runtime_error("Native water plane texture exceeds GPU size");gl.GenTextures(1,&planesTexture);gl.BindTexture(GL_TEXTURE_2D,planesTexture);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);gl.TexImage2D(GL_TEXTURE_2D,0,GL_RGBA32F,planes.size()/4,1,0,GL_RGBA,GL_FLOAT,planes.data());
        gl.UseProgram(program);gl.Uniform1i(loc(program,"baseTexture"),0);gl.Uniform1i(loc(program,"lightTexture"),1);gl.Uniform1i(loc(program,"secondaryTexture"),2);gl.Uniform1i(loc(program,"detailTexture"),3);gl.Uniform1f(loc(program,"lightmapScale"),lightmapInfo.scale);
        load_normals();gl.UseProgram(program);gl.Uniform1i(loc(program,"normalTexture"),7);gl.Uniform3fv(loc(program,"sunDirection"),1,sunDirection.data());
        viewmodel=std::make_unique<NativeViewmodel>(gl,assetRoot);gl.Enable(GL_DEPTH_TEST);gl.DepthFunc(GL_LEQUAL);gl.CullFace(GL_BACK);gl.FrontFace(GL_CCW);
        std::cout<<"Native renderer: "<<nv/10<<" BSP vertices, "<<pv/8<<" prop vertices, "<<sv/3<<" sky vertices, "<<volumes.size()<<" water volumes, 3D sky="<<hasSky<<"\n";
    }
    ~Renderer(){hdr.reset();viewmodel.reset();destroy(worldMesh);destroy(propMesh);destroy(skyMesh);if(!ownedTextures.empty())gl.DeleteTextures(ownedTextures.size(),ownedTextures.data());if(planesTexture)gl.DeleteTextures(1,&planesTexture);if(emptyVao)gl.DeleteVertexArrays(1,&emptyVao);if(program)gl.DeleteProgram(program);if(skyProgram)gl.DeleteProgram(skyProgram);}
    void set_source_look(bool value){sourceLook=value;}
    // Current Source-look exposure (1 off maps with HDR lighting or with the look off).
    float exposure()const{return hdr&&sourceLook&&lightmapInfo.hdr?hdr->current_exposure():1;}
    void set_fov(float value){if(std::isfinite(value))fieldOfView=std::clamp(value,60.f,130.f);}
    void set_viewmodel(float fov=54,float x=.6f,float y=1.5f,float z=-.9f,bool left=false,bool visible=true){viewmodelVisible=visible;if(viewmodel)viewmodel->settings(fov,x,y,z,left);}
    void reset_presentation(){queuedWeaponFlags=queuedAttackMode=0;queuedAttack=false;if(viewmodel)viewmodel->reset_presentation();}
    void inspect_press(){if(viewmodel)viewmodel->inspect_press();}
    void inspect_held(bool value){if(viewmodel)viewmodel->inspect_held(value);}
    void set_cosmetics(const std::string &value,const std::string &loadout){outfit=value;packedLoadout=loadout;if(viewmodel)viewmodel->cosmetics(value,loadout);}
    void set_replay_actor(const BhSnapshot *snapshot,float yaw,float pitch,float opacity=.45f){if(!snapshot){replayActor.reset();return;}native_render::Actor actor;actor.id="replay";actor.name="Replay";actor.opacity=std::clamp(opacity,0.f,1.f);for(int i=0;i<3;i++){actor.frame.position[i]=snapshot->player.position[i];actor.frame.velocity[i]=snapshot->player.velocity[i];}actor.frame.yaw=yaw;actor.frame.pitch=pitch;actor.frame.tick=snapshot->player.tick;actor.frame.flags=(snapshot->player.crouched?1:0)|(snapshot->player.grounded?2:0);actor.frame.weapon=1;actor.outfit=outfit;actor.loadout=packedLoadout;replayActor=actor;}
    void set_replay_actor(const BhGhostFrame &frame,const std::string &actorOutfit,const std::string &loadout,float opacity=.45f){native_render::Actor actor;actor.id="replay";actor.name="Replay";actor.frame=frame;actor.outfit=actorOutfit;actor.loadout=loadout;actor.opacity=opacity;replayActor=std::move(actor);}
    void set_room_actors(const std::vector<native_render::Actor> &actors){roomActors=actors;if(roomActors.size()>64)roomActors.resize(64);}
    native::Matrix camera(const float eye[3],double yaw,double pitch,float aspect){auto vp=native::camera_matrix(eye,yaw,pitch,aspect);const float scale=1/std::tan(float(fieldOfView*native::radians*.5));for(int c=0;c<4;c++){vp[c*4]*=scale;vp[c*4+1]*=scale;}return vp;}
    void set_viewmodel_weapon(std::optional<uint32_t> value){viewmodelWeapon=value;}
    void set_viewmodel_visible(bool value){viewmodelVisible=value;}
    void simulation_tick(){BhWeaponReport weapon{};BhAttackReport attack{};if(bh_weapon_report(core,&weapon))queuedWeaponFlags|=weapon.flags;if(bh_attack_report(core,&attack)){queuedAttack=true;queuedAttackMode=attack.mode;}}
    // Geometry/materials remain tied to the loaded map; playback may supply another context of that map.
    void set_simulation_context(BhContext *context){if(!context)throw std::runtime_error("Null renderer simulation context");core=context;reset_presentation();}
    void draw(int width,int height,const float eye[3],const native::Input &input,const BhSnapshot *state=nullptr,double seconds=-1){
        if(width<=0||height<=0)return;if(seconds<0)seconds=SDL_GetTicks()/1000.;lastYaw=input.yaw();lastPitch=input.pitch;
        const double dt=lastSeconds<0?0:std::max(0.,seconds-lastSeconds);lastSeconds=seconds;
        GLint frameTarget=0;gl.GetIntegerv(GL_FRAMEBUFFER_BINDING,&frameTarget);SourceHdr *pass=hdr_pass();if(pass)pass->begin(width,height);
        gl.Viewport(0,0,width,height);gl.ColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);gl.DepthMask(GL_TRUE);gl.ClearColor(.24,.34,.45,1);gl.Clear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);gl.Disable(GL_BLEND);gl.Disable(GL_CULL_FACE);gl.Disable(GL_DEPTH_TEST);gl.DepthMask(GL_FALSE);gl.UseProgram(skyProgram);gl.BindVertexArray(emptyVao);water_uniforms(skyProgram,eye);
        const float cy=std::cos(lastYaw*native::radians),sy=std::sin(lastYaw*native::radians),cp=std::cos(lastPitch*native::radians),sp=std::sin(lastPitch*native::radians);gl.Uniform3f(loc(skyProgram,"forward"),cp*cy,cp*sy,-sp);gl.Uniform3f(loc(skyProgram,"right"),sy,-cy,0);gl.Uniform3f(loc(skyProgram,"up"),sp*cy,sp*sy,cp);gl.Uniform1f(loc(skyProgram,"aspect"),float(width)/height);gl.Uniform1f(loc(skyProgram,"cot"),(4.f/3.f)/std::tan(float(fieldOfView*native::radians*.5)));
        GLint present[6]{},half[6]{};for(int i=0;i<6;i++){GLuint id=white;const int32_t m=skyMaterials[i];if(m>=0&&size_t(m)<materials.size()){const auto t=materials[m].texture;if(t>=0&&texture(t)!=checker){id=texture(t);present[i]=1;const auto wh=textureSizes[t];half[i]=i<4&&wh.first==wh.second*2;}}gl.ActiveTexture(GL_TEXTURE0+i);gl.BindTexture(GL_TEXTURE_2D,id);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_EDGE);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);const auto name="sky"+std::to_string(i);gl.Uniform1i(loc(skyProgram,name.c_str()),i);}gl.Uniform1iv(loc(skyProgram,"skyPresent"),6,present);gl.Uniform1iv(loc(skyProgram,"skyHalf"),6,half);gl.DrawArrays(GL_TRIANGLES,0,3);
        gl.Enable(GL_DEPTH_TEST);gl.DepthMask(GL_TRUE);gl.DepthFunc(GL_LEQUAL);
        if(hasSky&&skyInfo.scale>0){float skyEye[3];for(int k=0;k<3;k++)skyEye[k]=skyInfo.origin[k]+eye[k]/skyInfo.scale;const auto vp=camera(skyEye,lastYaw,lastPitch,float(width)/height);draw_scene(vp,skyEye,true,seconds);gl.Clear(GL_DEPTH_BUFFER_BIT);}
        const auto vp=camera(eye,lastYaw,lastPitch,float(width)/height);
        gl.ActiveTexture(GL_TEXTURE7);gl.BindTexture(GL_TEXTURE_2D,white);
        if(skyMesh.vao){gl.UseProgram(program);gl.UniformMatrix4fv(loc(program,"viewProjection"),1,GL_FALSE,vp.data());gl.ColorMask(GL_FALSE,GL_FALSE,GL_FALSE,GL_FALSE);gl.Disable(GL_CULL_FACE);gl.Enable(GL_POLYGON_OFFSET_FILL);gl.PolygonOffset(1,2);gl.BindVertexArray(skyMesh.vao);for(const auto &item:skyGroups){if(item.sky3d)continue;BhTransform t{};t.visible=1;if(item.model)bh_model_transform(core,item.model,&t);if(!t.visible)continue;const auto model=native::model_matrix(t);gl.UniformMatrix4fv(loc(program,"model"),1,GL_FALSE,model.data());gl.DrawElements(GL_TRIANGLES,item.index_count,GL_UNSIGNED_INT,reinterpret_cast<void*>(uintptr_t(item.first_index)*4));}gl.ColorMask(GL_TRUE,GL_TRUE,GL_TRUE,GL_TRUE);gl.Disable(GL_POLYGON_OFFSET_FILL);}
        draw_scene(vp,eye,false,seconds);
        if(viewmodel){size_t floorCount=0;const auto *floor=bh_floor_weapons(core,&floorCount);for(size_t i=0;floor&&i<floorCount;i++)viewmodel->draw_floor(floor[i],vp,eye,seconds);if(replayActor)viewmodel->draw_actor(*replayActor,vp,eye,seconds);for(const auto &actor:roomActors)viewmodel->draw_actor(actor,vp,eye,seconds);}
        if(pass)pass->finish(GLuint(frameTarget),width,height,dt);
        BhSnapshot snapshot{};if(state)snapshot=*state;else bh_snapshot(core,&snapshot);
        BhWeaponReport weapon{};BhAttackReport attack{};bh_weapon_report(core,&weapon);bh_attack_report(core,&attack);
        if(viewmodel&&viewmodelVisible)viewmodel->draw(width,height,snapshot,viewmodelWeapon.value_or(weapon.active),viewmodelWeapon?0:weapon.flags|queuedWeaponFlags,viewmodelWeapon?false:queuedAttack||attack.weapon!=0,viewmodelWeapon?0:queuedAttack?queuedAttackMode:attack.mode,seconds);
        queuedWeaponFlags=queuedAttackMode=0;queuedAttack=false;
        gl.DepthMask(GL_TRUE);gl.Enable(GL_DEPTH_TEST);gl.Disable(GL_BLEND);gl.Disable(GL_POLYGON_OFFSET_FILL);
    }
    void screenshot(const std::string &path,int width,int height){
        if(width<=0||height<=0)throw std::runtime_error("Cannot capture empty framebuffer");std::vector<uint8_t> pixels(size_t(width)*height*3);gl.PixelStorei(GL_PACK_ALIGNMENT,1);gl.ReadPixels(0,0,width,height,GL_RGB,GL_UNSIGNED_BYTE,pixels.data());std::ofstream file(path,std::ios::binary);if(!file)throw std::runtime_error("Cannot write screenshot: "+path);file<<"P6\n"<<width<<' '<<height<<"\n255\n";for(int y=height-1;y>=0;y--)file.write(reinterpret_cast<const char*>(pixels.data()+size_t(y)*width*3),width*3);if(!file)throw std::runtime_error("Screenshot write failed: "+path);std::cout<<"Screenshot: "<<path<<'\n';
    }
};
}
