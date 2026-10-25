#pragma once
#include "renderer.hpp"
#include <array>
#include <cstdio>
#include <map>
#include <optional>
#include "strafe_trainer.hpp"
#include "practice.hpp"
#include "hud_geometry.hpp"

namespace {
class NativeHud {
    Gl &gl;
    GLuint program=0,vao=0,vbo=0,atlas=0;
    std::vector<float> vertices;
    float scale=1;
    using Color=std::array<float,4>;
    const Color cream{.94f,.91f,.86f,1},amber{1,.71f,.24f,1},dim{.75f,.75f,.77f,1};
    void quad(float x,float y,float w,float h,float u,float v,float uw,float vh,Color c) {
        const float points[6][4]={{x,y,u,v},{x+w,y,u+uw,v},{x+w,y+h,u+uw,v+vh},
            {x,y,u,v},{x+w,y+h,u+uw,v+vh},{x,y+h,u,v+vh}};
        for(const auto &p:points)vertices.insert(vertices.end(),{p[0]*scale,p[1]*scale,p[2],p[3],c[0],c[1],c[2],c[3]});
    }
    void rect(float x,float y,float w,float h,Color c) {quad(x,y,w,h,-2,-2,0,0,c);}
    void text(float x,float y,const std::string &value,float size,Color color,bool center=false) {
        // The small atlas is ASCII. Fold common UI punctuation and emit one
        // fallback per unsupported code point, not one per UTF-8 byte.
        std::string glyphs;
        for(size_t i=0;i<value.size();){
            const auto c=uint8_t(value[i]);
            if(c<128){glyphs+=c>=32?char(c):' ';++i;continue;}
            if(value.compare(i,2,"\xC2\xB7")==0){glyphs+='|';i+=2;continue;}
            if(value.compare(i,3,"\xE2\x80\x94")==0||value.compare(i,3,"\xE2\x80\x93")==0){glyphs+='-';i+=3;continue;}
            glyphs+='?';++i;while(i<value.size()&&(uint8_t(value[i])&0xc0)==0x80)++i;
        }
        const float advance=size*.6f;
        if(center)x-=glyphs.size()*advance*.5f;
        for(unsigned char ch:glyphs) {
            if(ch<32||ch>126)ch='?';
            const int index=ch-32;
            quad(x+1,y+1,size,size*1.3f,(index%16)*40.f/640,(index/16)*52.f/312,40.f/640,52.f/312,{0,0,0,.85f});
            quad(x,y,size,size*1.3f,(index%16)*40.f/640,(index/16)*52.f/312,40.f/640,52.f/312,color);
            x+=advance;
        }
    }
public:
    NativeHud(Gl &g,const std::filesystem::path &assets):gl(g) {
        std::ifstream f(assets/"hud.rgba",std::ios::binary);
        std::vector<uint8_t> data{std::istreambuf_iterator<char>(f),{}};
        if(data.size()!=640*312*4)throw std::runtime_error("Native HUD atlas is absent; build presentation assets");
        program=link_program(gl,R"(#version 330 core
layout(location=0)in vec2 pos;layout(location=1)in vec2 coord;layout(location=2)in vec4 tint;
uniform vec3 viewport;out vec2 uv;out vec4 ink;
void main(){uv=coord;ink=tint;gl_Position=vec4(pos.x/viewport.x*2.-1.,1.-pos.y/viewport.y*2.,0,1);})",
R"(#version 330 core
in vec2 uv;in vec4 ink;uniform sampler2D font;out vec4 color;
void main(){color=vec4(ink.rgb,ink.a*(uv.x<0.?1.:texture(font,uv).a));})");
        gl.GenVertexArrays(1,&vao);gl.BindVertexArray(vao);gl.GenBuffers(1,&vbo);gl.BindBuffer(GL_ARRAY_BUFFER,vbo);
        gl.EnableVertexAttribArray(0);gl.VertexAttribPointer(0,2,GL_FLOAT,GL_FALSE,8*sizeof(float),nullptr);
        gl.EnableVertexAttribArray(1);gl.VertexAttribPointer(1,2,GL_FLOAT,GL_FALSE,8*sizeof(float),reinterpret_cast<void*>(2*sizeof(float)));
        gl.EnableVertexAttribArray(2);gl.VertexAttribPointer(2,4,GL_FLOAT,GL_FALSE,8*sizeof(float),reinterpret_cast<void*>(4*sizeof(float)));
        gl.GenTextures(1,&atlas);gl.BindTexture(GL_TEXTURE_2D,atlas);
        gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_LINEAR);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_LINEAR);
        gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_EDGE);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);
        gl.TexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,640,312,0,GL_RGBA,GL_UNSIGNED_BYTE,data.data());
    }
    ~NativeHud(){gl.DeleteTextures(1,&atlas);gl.DeleteBuffers(1,&vbo);gl.DeleteVertexArrays(1,&vao);gl.DeleteProgram(program);}
    // Where each element goes: element id -> {x, y} in percent of the screen.
    // An element that isn't listed stays at its built-in place (see draw()).
    // ui/hud-layout.ts mirrors the ids and built-in places for the settings
    // screen; keep the two in step.
    using Layout=std::map<std::string,std::array<float,2>>;
    void draw(int width,int height,const BhSnapshot &s,const BhRunState &run,const BhCmd &cmd,
              const std::string &map,const std::string &style,const std::string &notice,
              double fps,bool visible,bool crosshair,bool playback,const BhWeaponReport &weapon,
              const std::string &jump_stats="",bool jump_stats_good=false,
              std::optional<native::StrafeReading> strafe=std::nullopt,bool strafe_hints=true,
              const Layout *layout=nullptr,float hud_percent=100,const native::Practice *practice=nullptr,bool keep_velocity=false,
              const std::string &gauntlet_line="",const std::string &gauntlet_delta="",bool gauntlet_good=false,float leave_progress=-1) {
        if(width<=0||height<=0||(!visible&&!crosshair))return;
        vertices.clear();const native::HudGeometry geometry(width,height,hud_percent);scale=geometry.scale;
        const float w=geometry.width,h=geometry.height;
        // HUD units are 1/900 of the screen height (above 540 px), so the
        // built-in places below are the same fraction of the screen at any size.
        auto at=[&](const char *id,float x,float y)->std::array<float,2>{
            if(layout){const auto it=layout->find(id);if(it!=layout->end())return {it->second[0]/100.f*w,it->second[1]/100.f*h};}
            return {x,y};
        };
        if(crosshair) {
            const auto [x,y]=at("crosshair",w/2,h/2);
            rect(x-9,y-1,6,2,cream);rect(x+3,y-1,6,2,cream);
            rect(x-1,y-9,2,6,cream);rect(x-1,y+3,2,6,cream);
        }
        if(leave_progress>=0){const auto [x,y]=at("crosshair",w/2,h/2);for(int i=0;i<48;++i){const float a=float(i)/48*6.2831853f-1.5707963f;rect(x+std::cos(a)*26-2,y+std::sin(a)*26-2,4,4,float(i)/48<=leave_progress?amber:dim);}}
        if(visible) {
            {const auto [x,y]=at("map",26,18);
                text(x,y,map,17,cream);text(x,y+24,style+(run.track?" / BONUS "+std::to_string(run.track):""),14,amber);}
            char buf[160];
            {const auto [x,y]=at("fps",w-135,20);std::snprintf(buf,sizeof(buf),"%.0f FPS",fps);text(x,y,buf,14,dim);}
            {const auto [x,y]=at("timer",w/2,h-154);const double t=run.seconds;
                std::snprintf(buf,sizeof(buf),"%02u:%06.3f",unsigned(t)/60,std::fmod(t,60));
                text(x,y,buf,34,(run.status==2||(practice&&practice->active))?amber:cream,true);}
            {const auto [x,y]=at("speed",w/2,h-105);
                std::snprintf(buf,sizeof(buf),"%.0f u/s",std::hypot(s.player.velocity[0],s.player.velocity[1]));
                text(x,y,buf,25,cream,true);}
            {const auto [x,y]=at("runStats",w/2,h-68);
                std::snprintf(buf,sizeof(buf),"%u jumps  %u strafes  %.1f%% sync",run.jumps,run.strafes,run.sync_percent);
                text(x,y,buf,13,dim,true);}
            // Jump stats sit above the run status, clear of the timer and speed.
            // The accent marks a gain the plugin would call good.
            if(!jump_stats.empty()){const auto [x,y]=at("jumpStats",w/2,h-222);text(x,y,jump_stats,14,jump_stats_good?amber:dim,true);}
            // Strafe trainer above that: the percentage, a bar whose centre line
            // is 100% (either end being 0% and 200%), and a hint under the bar.
            if(strafe) {
                static const Color bands[3]={{.47f,.9f,.47f,1},amber,{1,.42f,.36f,1}};
                const Color tone=bands[native::strafe_band(strafe->percent)];
                const auto [x,y]=at("strafeTrainer",w/2,h-276);
                std::snprintf(buf,sizeof(buf),"Strafe %.0f%%",strafe->percent);
                text(x,y,buf,14,tone,true);
                const float bar=240,left=x-bar/2,by=y+24;
                rect(left,by,bar,6,{.05f,.05f,.07f,.6f});
                rect(x-1,by-3,2,12,cream);
                const float pos=std::clamp(strafe->percent/200.f,0.f,1.f);
                rect(left+pos*bar-3,by-2,6,10,tone);
                if(strafe_hints&&strafe->hint)text(x,by+12,native::strafe_hint_text(*strafe->hint),12,bands[2],true);
            }
            {const auto [x,y]=at("status",w/2,h-186);
                if(run.status==0)text(x,y,run.in_start?"IN START":"READY",13,amber,true);
                if(run.status==2)text(x,y,"FINISHED",15,amber,true);}
            const std::array<std::pair<const char*,uint32_t>,6> keys={{{"W",native::forward},{"A",native::left},{"S",native::back},{"D",native::right},{"JUMP",native::jump},{"DUCK",native::duck}}};
            {const auto [x0,y]=at("keys",26,h-65);float x=x0;
                for(const auto &[label,bit]:keys){float size=std::string(label).size()>1?54:28;
                rect(x,y,size,27,(cmd.buttons&bit)?Color{1,.71f,.24f,.85f}:Color{.05f,.05f,.07f,.6f});
                text(x+5,y+2,label,14,(cmd.buttons&bit)?Color{.08f,.07f,.06f,1}:dim);x+=size+4;}}
            {const auto [x,y]=at("health",w-275,h-62);
                std::snprintf(buf,sizeof(buf),"HP %.0f  AMMO %u/%u",s.health,weapon.clip,weapon.clip_size);
                text(x,y,buf,14,cream);}
            if(!notice.empty()){const auto [x,y]=at("notice",w/2,70);text(x,y,notice.substr(0,100),15,amber,true);}
            if(practice&&practice->active)text(w/2,h/2+28,practice->noclip?"Practice | noclip":"Practice",14,amber,true);
            if(practice&&practice->menu_open) {
                const float x=26,y=h*.30f;rect(x-10,y-8,320,220,{.03f,.03f,.05f,.8f});
                text(x,y,"Checkpoints",19,cream);
                const std::string lines[]={"1. Save checkpoint ("+std::to_string(std::min(size_t(100),practice->checkpoints.size()+1))+"/100)",
                    "2. Teleport to checkpoint ("+std::to_string(std::max(size_t(1),practice->number()))+")",
                    "3. Previous", "4. Next", std::string("5. Noclip: ")+(practice->noclip?"on":"off"),
                    std::string("6. Keep speed: ")+(keep_velocity?"on":"off"),"0. Close"};
                for(size_t i=0;i<7;++i){const bool disabled=(i==1&&practice->checkpoints.empty())||(i==2&&practice->number()<=1)||(i==3&&practice->number()>=practice->checkpoints.size());text(x,y+34+float(i)*22,lines[i],14,disabled?dim:cream);}
                text(x,y+196,"Teleport / noclip makes a run practice.",11,amber);
            }
            if(!gauntlet_line.empty()){text(w/2,h-32,gauntlet_line,13,cream,true);if(!gauntlet_delta.empty())text(w/2,h-15,gauntlet_delta,12,gauntlet_good?Color{.47f,.9f,.47f,1}:amber,true);}
            if(playback){const auto [x,y]=at("replay",w/2,22);text(x,y,"REPLAY - ESC FOR PLAYBACK CONTROLS",14,amber,true);}
        }
        gl.Disable(GL_DEPTH_TEST);gl.DepthMask(GL_FALSE);gl.Disable(GL_CULL_FACE);gl.Enable(GL_BLEND);gl.BlendFunc(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);
        gl.UseProgram(program);const float viewport[3]={float(width),float(height),0};
        gl.Uniform3fv(gl.GetUniformLocation(program,"viewport"),1,viewport);gl.Uniform1i(gl.GetUniformLocation(program,"font"),0);
        gl.ActiveTexture(GL_TEXTURE0);gl.BindTexture(GL_TEXTURE_2D,atlas);gl.BindVertexArray(vao);gl.BindBuffer(GL_ARRAY_BUFFER,vbo);
        gl.BufferData(GL_ARRAY_BUFFER,vertices.size()*sizeof(float),vertices.data(),GL_STREAM_DRAW);gl.DrawArrays(GL_TRIANGLES,0,GLsizei(vertices.size()/8));
        gl.DepthMask(GL_TRUE);gl.Enable(GL_DEPTH_TEST);
    }
};
}
