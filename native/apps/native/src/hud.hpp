#pragma once
#include "renderer.hpp"
#include <array>
#include <cstdio>
#include <map>
#include <optional>
#include <deque>
#include "settings.hpp"
#include "strafe_trainer.hpp"
#include "practice.hpp"
#include "hud_geometry.hpp"
#include "text_raster.hpp"
#include "hud_text.hpp"
#include "native_chat.hpp"

namespace {
class NativeHud {
    Gl &gl;
    GLuint program=0,vao=0,vbo=0,atlas=0;
    std::vector<float> vertices;
    struct Batch{GLuint texture;size_t first,count;};std::vector<Batch> batches;
    struct Raster{GLuint texture;int width,height;};std::map<std::string,Raster> raster_cache;
    std::map<std::string,std::vector<native::TextCaret>> caret_cache;
    std::map<std::string,std::vector<native::TextRangeBox>> range_cache;
    GLuint current_texture=0;size_t raster_bytes=0;bool raster_full=false;
    void begin_batch(){
        vertices.clear();batches.clear();current_texture=atlas;
        if(caret_cache.size()>512)caret_cache.clear();if(range_cache.size()>1024)range_cache.clear();
        if(raster_cache.size()>=256||raster_full){for(const auto &[key,raster]:raster_cache)gl.DeleteTextures(1,&raster.texture);raster_cache.clear();raster_bytes=0;raster_full=false;}
    }
    const Raster *raster(const std::string &value,float size){
        const int pixels=std::max(1,int(std::round(size*1.3f*scale*element_scale)));
        const auto key=std::to_string(pixels)+":"+value;const auto old=raster_cache.find(key);if(old!=raster_cache.end())return &old->second;
        if(raster_cache.size()>=256)return nullptr;
        const auto bitmap=native::raster_text(value,float(pixels));
        if(bitmap.width<=0||bitmap.height<=0||bitmap.rgba.size()!=size_t(bitmap.width)*bitmap.height*4)return nullptr;
        if(raster_bytes+bitmap.rgba.size()>16u*1024*1024){raster_full=true;return nullptr;}raster_bytes+=bitmap.rgba.size();
        Raster result{0,bitmap.width,bitmap.height};gl.GenTextures(1,&result.texture);gl.BindTexture(GL_TEXTURE_2D,result.texture);
        gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_LINEAR);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_LINEAR);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_EDGE);gl.TexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);
        gl.PixelStorei(GL_UNPACK_ALIGNMENT,1);gl.TexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,bitmap.width,bitmap.height,0,GL_RGBA,GL_UNSIGNED_BYTE,bitmap.rgba.data());
        return &raster_cache.emplace(key,result).first->second;
    }
    const std::vector<native::TextCaret>& carets(const std::string& value,float pixels){const auto key=std::to_string(int(pixels))+":"+value;auto it=caret_cache.find(key);if(it==caret_cache.end())it=caret_cache.emplace(key,native::text_carets(value,pixels)).first;return it->second;}
    const std::vector<native::TextRangeBox>& ranges(const std::string& value,float pixels,size_t begin,size_t end){const auto key=std::to_string(int(pixels))+":"+std::to_string(begin)+":"+std::to_string(end)+":"+value;auto it=range_cache.find(key);if(it==range_cache.end())it=range_cache.emplace(key,native::text_range_boxes(value,pixels,begin,end)).first;return it->second;}
    native::ChatLinkHits chat_hits_;
    std::vector<native::TextCaret> chat_input_carets_;
    std::string chat_input_identity_;
    float chat_input_left_=0,chat_input_top_=0,chat_input_width_=0,chat_input_height_=0;
    void shaped(float x,float y,const std::string& value,float size,std::array<float,4> color,float from=0,float until=1e9f){
        if(const auto glyphs=raster(value,size)){const float ratio=scale*element_scale,w=glyphs->width/ratio,h=glyphs->height/ratio;const float a=std::clamp(from,0.f,w),b=std::clamp(until,0.f,w);if(b<=a)return;current_texture=glyphs->texture;quad(x+a,y,b-a,h,a/w,0,(b-a)/w,1,color);current_texture=atlas;}else text(x,y,value,size,color);
    }
    float scale=1;
    native::Json prefs=native::default_settings();
    bool element_visible=true;float element_scale=1,pivot_x=0,pivot_y=0;
    std::deque<std::pair<uint32_t,float>> speed_history;
    float jump_speed=0,gain_delta=0;uint32_t gain_tick=0;bool have_jump=false;
    std::string split_line,delta_line;bool delta_good=false;
    void element(const std::string &id,float x,float y){
        element_visible=true;element_scale=1;pivot_x=x;pivot_y=y;
        const auto &layout=prefs.at("hudLayout");
        if(layout.contains(id)){element_visible=layout[id].value("visible",true);element_scale=layout[id].value("scale",1.f);}
    }
    using Color=std::array<float,4>;
    const Color cream{.94f,.91f,.86f,1},amber{1,.71f,.24f,1},dim{.75f,.75f,.77f,1};
    Color jump_stats_color(std::optional<float> gain) const {
        if(!gain)return dim;
        if(!prefs.value("jumpStatsColors",true))return *gain>=native::good_gain?amber:dim;
        switch(native::gain_band(*gain)){
            case native::GainBand::red:return {1,0,0,1};       // #FF0000
            case native::GainBand::orange:return {1,.5f,0,1};  // #FF8000
            case native::GainBand::green:return {0,1,0,1};     // #00FF00
            case native::GainBand::blue:return {0,1,1,1};      // #00FFFF
            case native::GainBand::white:return {1,1,1,1};     // #FFFFFF
        }
        return dim;
    }
    void quad(float x,float y,float w,float h,float u,float v,float uw,float vh,Color c) {
        if(!element_visible)return;
        x=pivot_x+(x-pivot_x)*element_scale;y=pivot_y+(y-pivot_y)*element_scale;w*=element_scale;h*=element_scale;
        const float points[6][4]={{x,y,u,v},{x+w,y,u+uw,v},{x+w,y+h,u+uw,v+vh},
            {x,y,u,v},{x+w,y+h,u+uw,v+vh},{x,y+h,u,v+vh}};
        if(batches.empty()||batches.back().texture!=current_texture)batches.push_back({current_texture,vertices.size()/8,0});
        batches.back().count+=6;
        for(const auto &p:points)vertices.insert(vertices.end(),{p[0]*scale,p[1]*scale,p[2],p[3],c[0],c[1],c[2],c[3]});
    }
    void rect(float x,float y,float w,float h,Color c) {quad(x,y,w,h,-2,-2,0,0,c);}
    void text(float x,float y,const std::string &value,float size,Color color,bool center=false) {
        if(!element_visible)return;
        if(std::any_of(value.begin(),value.end(),[](unsigned char c){return c>=128;}))if(const auto glyphs=raster(value,size)){
            const float ratio=scale*element_scale,w=glyphs->width/ratio,h=glyphs->height/ratio;if(center)x-=w*.5f;
            current_texture=glyphs->texture;quad(x+1,y+1,w,h,0,0,1,1,{0,0,0,.85f});quad(x,y,w,h,0,0,1,1,color);current_texture=atlas;return;
        }
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
    void preferences(const native::Json &value){prefs=value;}
    void reset_history(){speed_history.clear();have_jump=false;gain_tick=0;split_line.clear();delta_line.clear();}
    void set_run_comparison(const std::string &split,const std::string &delta,bool good=false){split_line=split;delta_line=delta;delta_good=good;}
    void tick(const BhState &s){
        if(!speed_history.empty()&&(s.tick<speed_history.back().first||s.tick>speed_history.back().first+100))speed_history.clear();
        if(s.events&native::teleported){have_jump=false;gain_tick=0;}
        if((s.events&native::jump)&& (speed_history.empty()||s.tick!=speed_history.back().first)){const float speed=std::hypot(s.velocity[0],s.velocity[1]);if(have_jump){gain_delta=speed-jump_speed;gain_tick=s.tick;}jump_speed=speed;have_jump=true;}
        if(speed_history.empty()||s.tick!=speed_history.back().first)speed_history.emplace_back(s.tick,std::hypot(s.velocity[0],s.velocity[1]));
        while(speed_history.size()>250)speed_history.pop_front();
    }
    // Shared SDL overlays use atlas ASCII and system-shaped Unicode line textures.
    // Failed or unavailable platform fonts retain one fallback per code point.
    void overlay_begin(int width,int height,float percent=100){begin_batch();scale=native::HudGeometry(width,height,percent).scale;element_visible=true;element_scale=1;pivot_x=pivot_y=0;}
    void overlay_text(float x,float y,const std::string &value,float size,std::array<float,4> color,bool center=false){text(x,y,value,size,color,center);}
    void overlay_rect(float x,float y,float w,float h,std::array<float,4> color){rect(x,y,w,h,color);}
    void overlay_end(int width,int height){flush(width,height);}
    void draw_overlay(int width,int height,const std::vector<std::string>& lines,const std::string& input,const std::string& composition,const std::vector<std::string>& suggestions,bool typing,float percent=100){
        overlay_begin(width,height,percent);const float h=height/scale,w=width/scale;const float box=std::min(680.f,w-40);
        const unsigned columns=unsigned(std::max(4.f,(box-25)/8.4f));std::vector<std::string> wrapped;
        for(const auto &line:lines){auto parts=native::wrap_text(line,columns);wrapped.insert(wrapped.end(),parts.begin(),parts.end());}
        const size_t max_lines=size_t(std::max(1.f,std::min(14.f,(h-230)/21)));if(wrapped.size()>max_lines)wrapped.erase(wrapped.begin(),wrapped.end()-max_lines);
        const float bottom=h-110,top=bottom-float(wrapped.size())*21-(typing?60.f:0.f);
        if(!wrapped.empty()||typing)rect(16,top-10,box,float(wrapped.size())*21+(typing?60.f:0.f)+18,{.02f,.02f,.035f,typing?.9f:.65f});
        float y=top;for(const auto &line:wrapped){text(25,y,line,14,cream);y+=21;}
        if(typing){
            const unsigned input_columns=unsigned(std::max(4.f,(box-25)/9.f));
            const auto cursor=input.find('|');std::string display;
            if(cursor==std::string::npos)display=native::text_tail(input+composition,input_columns-2);
            else{const auto before=native::text_tail(input.substr(0,cursor),input_columns/2);const auto pre=native::text_tail(before+composition,input_columns-3);const auto used=native::text_columns(pre);display=pre+"|"+native::text_prefix(input.substr(cursor+1),unsigned(std::max(0,int(input_columns)-int(used)-3)));}
            text(25,y+5,"> "+display,15,amber);if(!suggestions.empty()){std::string list;for(size_t i=0;i<std::min(size_t(4),suggestions.size());++i)list+=(i?"   ":"")+suggestions[i];text(25,y+29,native::text_prefix(list,columns),12,dim);}
        }
        flush(width,height);
    }
    std::optional<native::ChatTarget> chat_hit(float xPixels,float yPixels,uint64_t viewportHash)const{return chat_hits_.hit(xPixels,yPixels,viewportHash);}
    void chat_invalidate_hits(){chat_hits_.clear();chat_input_carets_.clear();}
    bool chat_input_contains(float xPixels,float yPixels)const{return !chat_input_carets_.empty()&&xPixels>=chat_input_left_&&xPixels<chat_input_left_+chat_input_width_&&yPixels>=chat_input_top_&&yPixels<chat_input_top_+chat_input_height_;}
    std::optional<native::TextCaret> chat_input_byte(float xPixels,float yPixels,std::string_view current)const{if(!chat_input_contains(xPixels,yPixels)||current!=chat_input_identity_)return std::nullopt;const auto at=std::min_element(chat_input_carets_.begin(),chat_input_carets_.end(),[&](const auto&a,const auto&b){return std::abs(a.x-xPixels)<std::abs(b.x-xPixels);});return *at;}
    std::vector<native::TextCaret> chat_carets()const{return chat_input_carets_;}
    std::vector<native::TextCaret> chat_carets(std::string_view current)const{return current==chat_input_identity_?chat_input_carets_:std::vector<native::TextCaret>{};}
    void draw_chat_overlay(int width,int height,const std::vector<native::ChatLine> &lines,const std::string &input,const std::string &composition,const std::vector<std::string> &suggestions,bool typing,size_t scroll_offset=0,float percent=100,const native::Chat *editor=nullptr,uint64_t viewportHash=0){
        overlay_begin(width,height,percent);chat_hits_.clear();chat_input_carets_.clear();
        const float h=height/scale,w=width/scale,box=std::min(680.f,w-40),font=14,step=30;
        const float pixels=float(std::max(1,int(std::round(font*1.3f*scale))));
        struct Span{size_t begin,end;std::optional<native::ChatTarget> target;Color color;};
        struct Row{std::string text;size_t begin;uint64_t sequence;std::vector<Span> spans;Color body;};std::vector<Row> rows;
        for(const auto &line:lines){
            Color name=amber,body=line.kind=="error"?Color{1,.45f,.4f,1}:line.kind=="private"?Color{.8f,.7f,1,1}:line.kind=="system"||line.kind=="announcement"?amber:cream;
            const auto &d=line.decoration;if(d.color.size()==7){try{const auto rgb=std::stoul(d.color.substr(1),nullptr,16);name={float((rgb>>16)&255)/255,float((rgb>>8)&255)/255,float(rgb&255)/255,1};}catch(...){}}
            std::string prefix;if(!d.badge.empty())prefix+="["+d.badge+"] ";if(!d.rank.empty())prefix+=d.rank+" ";if(!d.country.empty())prefix+=d.country+" ";const size_t nameBegin=prefix.size();if(!line.name.empty())prefix+=line.name+": ";
            const std::string full=prefix+line.text;std::vector<Span> spans;
            if(!prefix.empty())spans.push_back({0,prefix.size(),std::nullopt,name});
            if(!line.name.empty())if(const auto target=native::chat_profile_target(d.profile))spans.push_back({nameBegin,nameBegin+line.name.size(),target,name});
            for(const auto &link:native::chat_links(line.text))spans.push_back({prefix.size()+link.begin,prefix.size()+link.end,link.target,{.45f,.75f,1,1}});
            size_t offset=0;for(const auto &part:native::wrap_text(full,unsigned(std::max(4.f,(box-28)/10.f)))){
                // Split unusually wide shaped text at an actual grapheme boundary.
                size_t used=0;while(used<part.size()){std::string section=part.substr(used);const auto bounds=native::grapheme_boundaries(section);size_t take=section.size();
                    if(const auto r=raster(section,font);r&&r->width/scale>box-28){size_t lo=1,hi=bounds.size()-1;while(lo<hi){const auto mid=(lo+hi+1)/2;const auto probe=raster(section.substr(0,bounds[mid]),font);if(probe&&probe->width/scale<=box-28)lo=mid;else hi=mid-1;}take=bounds[lo];}
                    rows.push_back({section.substr(0,take),offset+used,line.sequence,spans,body});used+=take;
                }offset+=part.size();
            }
        }
        const size_t maximum=size_t(std::max(1.f,std::min(14.f,(h-230)/step)));if(rows.size()>maximum)rows.erase(rows.begin(),rows.end()-maximum);
        const float top=h-110-float(rows.size())*step-(typing?70.f:0.f);
        if(!rows.empty()||typing)rect(16,top-10,box,float(rows.size())*step+(typing?75.f:0.f)+18,{.02f,.02f,.035f,typing?.94f:.7f});
        float y=top;std::vector<native::ChatHitBox> hitboxes;
        if(typing&&scroll_offset)text(25,y-23,"SCROLLBACK +"+std::to_string(scroll_offset)+" | End: latest",12,amber);
        for(const auto &row:rows){shaped(25,y,row.text,font,row.body);for(const auto &span:row.spans){const auto begin=std::max(span.begin,row.begin),end=std::min(span.end,row.begin+row.text.size());if(begin>=end)continue;
                for(const auto &range:ranges(row.text,pixels,begin-row.begin,end-row.begin)){const float x=25+range.x/scale,rw=range.width/scale;shaped(25,y,row.text,font,span.color,range.x/scale,(range.x+range.width)/scale);if(span.target){rect(x,y+step-4,rw,1,span.color);if(typing)hitboxes.push_back({x*scale,y*scale,rw*scale,step*scale,*span.target,row.sequence});}}
            }y+=step;}
        if(typing){
            const std::string value=editor?editor->input:input;const size_t cursor=editor?editor->cursor:value.size();const float inputFont=15,inputPixels=float(std::max(1,int(std::round(inputFont*1.3f*scale))));auto inputCarets=carets(value,inputPixels);float caretX=4;for(const auto&c:inputCarets)if(c.byte==cursor&&c.secondary==(editor&&editor->cursor_secondary)){caretX=c.x;break;}
            const float available=(box-45)*scale,shift=std::max(0.f,caretX-available+12*scale);const float origin=40-shift/scale;
            text(25,y+5,">",15,amber);rect(37,y+2,box-32,32,{.015f,.015f,.025f,1});
            if(editor&&editor->selected){const auto [a,b]=editor->selection();for(const auto &range:ranges(value,inputPixels,a,b)){const float left=std::max(40.f,origin+range.x/scale),right=std::min(16+box-10,origin+(range.x+range.width)/scale);if(right>left)rect(left,y+3,right-left,29,{.25f,.38f,.65f,.75f});}}
            shaped(origin,y+3,value,inputFont,amber,(40-origin),16+box-10-origin);rect(std::clamp(origin+caretX/scale,40.f,16+box-11),y+5,1,24,cream);
            if(!composition.empty())shaped(std::clamp(origin+caretX/scale,40.f,16+box-11),y+3,composition,inputFont,cream,0,box/2);
            chat_input_identity_=value;chat_input_left_=40*scale;chat_input_top_=(y+2)*scale;chat_input_width_=(box-45)*scale;chat_input_height_=32*scale;
            for(auto c:inputCarets){c.x+=origin*scale;chat_input_carets_.push_back(c);}
            if(!suggestions.empty()){std::string list;for(size_t i=0;i<std::min(size_t(4),suggestions.size());++i)list+=(i?"   ":"")+suggestions[i];text(25,y+40,native::text_prefix(list,unsigned(std::max(4.f,(box-25)/8.f))),12,dim);}
        }
        chat_hits_.set(std::move(hitboxes),viewportHash);flush(width,height);
    }
    void draw_panel(int width,int height,const std::string &title,const std::vector<std::string> &lines,float percent=100){
        overlay_begin(width,height,percent);const float w=width/scale,h=height/scale,bw=std::min(950.f,w-40),bh=std::min(h-60,70.f+lines.size()*23);
        const float x=(w-bw)/2,y=(h-bh)/2;rect(x,y,bw,bh,{.02f,.02f,.035f,.92f});text(x+20,y+14,title,22,amber);
        for(size_t i=0;i<lines.size()&&i*23+62<bh;++i)text(x+20,y+55+i*23,lines[i],14,cream);flush(width,height);
    }
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
    ~NativeHud(){for(const auto &[key,raster]:raster_cache)gl.DeleteTextures(1,&raster.texture);gl.DeleteTextures(1,&atlas);gl.DeleteBuffers(1,&vbo);gl.DeleteVertexArrays(1,&vao);gl.DeleteProgram(program);}
    // Where each element goes: element id -> {x, y} in percent of the screen.
    // An element that isn't listed stays at its built-in place (see draw()).
    // ui/hud-layout.ts mirrors the ids and built-in places for the settings
    // screen; keep the two in step.
    using Layout=std::map<std::string,std::array<float,2>>;
    void draw(int width,int height,const BhSnapshot &s,const BhRunState &run,const BhCmd &cmd,
              const std::string &map,const std::string &style,const std::string &notice,
              double fps,bool visible,bool crosshair,bool playback,const BhWeaponReport &weapon,
              const std::string &jump_stats="",std::optional<float> jump_stats_gain=std::nullopt,
              std::optional<native::StrafeReading> strafe=std::nullopt,bool strafe_hints=true,
              const Layout *layout=nullptr,float hud_percent=100,const native::Practice *practice=nullptr,bool keep_velocity=false,
              const std::string &gauntlet_line="",const std::string &gauntlet_delta="",bool gauntlet_good=false,float leave_progress=-1) {
        if(width<=0||height<=0||(!visible&&!crosshair))return;
        begin_batch();const native::HudGeometry geometry(width,height,hud_percent);scale=geometry.scale;
        const float w=geometry.width,h=geometry.height;
        // HUD units are 1/900 of the screen height (above 540 px), so the
        // built-in places below are the same fraction of the screen at any size.
        auto at=[&](const char *id,float x,float y)->std::array<float,2>{
            if(layout){const auto it=layout->find(id);if(it!=layout->end()){x=it->second[0]/100.f*w;y=it->second[1]/100.f*h;}}
            element(id,x,y);return {x,y};
        };
        if(crosshair&&prefs.at("crosshairStyle")!="none") {
            const auto [x,y]=at("crosshair",w/2,h/2);
            const auto hex=prefs.at("crosshairColor").get<std::string>();
            const unsigned rgb=unsigned(std::stoul(hex.substr(1),nullptr,16));
            Color color={float((rgb>>16)&255)/255,float((rgb>>8)&255)/255,float(rgb&255)/255,prefs.at("crosshairAlpha").get<float>()};
            const auto style=prefs.at("crosshairStyle").get<std::string>();
            const float n=prefs.at("crosshairSize"),gap=prefs.at("crosshairGap"),t=prefs.at("crosshairThickness");
            auto stroke=[&](float a,float b,float c,float d){if(prefs.at("crosshairOutline").get<bool>())rect(a-1,b-1,c+2,d+2,{0,0,0,color[3]});rect(a,b,c,d,color);};
            if(style=="circle"){for(int i=0;i<64;++i){const double a=i*6.283185307/64;stroke(x+float(std::cos(a))*(gap+n)-t/2,y+float(std::sin(a))*(gap+n)-t/2,t,t);}}
            else if(style!="dot"){stroke(x-gap-n,y-t/2,n,t);stroke(x+gap,y-t/2,n,t);if(style!="t")stroke(x-t/2,y-gap-n,t,n);stroke(x-t/2,y+gap,t,n);}
            if(style=="dot"||style=="cross-dot")stroke(x-t/2,y-t/2,t,t);
        }
        if(leave_progress>=0){const auto [x,y]=at("crosshair",w/2,h/2);for(int i=0;i<48;++i){const float a=float(i)/48*6.2831853f-1.5707963f;rect(x+std::cos(a)*26-2,y+std::sin(a)*26-2,4,4,float(i)/48<=leave_progress?amber:dim);}}
        if(visible) {
            const auto palette=native::semantic_palette(prefs.value("colorBlind",std::string("off")));
            {const auto [x,y]=at("map",26,18);
                text(x,y,map,17,cream);text(x,y+24,style+(run.track?" / BONUS "+std::to_string(run.track):""),14,amber);}
            char buf[160];
            {const auto [x,y]=at("fps",w-135,20);std::snprintf(buf,sizeof(buf),"%.0f FPS",fps);text(x,y,buf,14,dim);}
            {const auto [x,y]=at("timer",w/2,h-154);const double t=run.seconds;
                std::snprintf(buf,sizeof(buf),"%02u:%06.3f",unsigned(t)/60,std::fmod(t,60));
                text(x,y,buf,34,(run.status==2||(practice&&practice->active))?amber:cream,true);}
            {const auto [x,y]=at("speed",w/2,h-105);
                std::snprintf(buf,sizeof(buf),"%.0f u/s",std::hypot(s.player.velocity[0],s.player.velocity[1]));
                const double speed=std::hypot(s.player.velocity[0],s.player.velocity[1]);const Color speedColor=!prefs.at("speedColors").get<bool>()?cream:speed>800?palette.loss:speed>500?palette.sync:speed>270?palette.gain:cream;
                text(x,y,buf,25,speedColor,true);
                if(prefs.at("gainTicks").get<bool>()&&gain_tick&&s.player.tick>=gain_tick&&s.player.tick-gain_tick<70){char gain[32];std::snprintf(gain,sizeof(gain),"%+.0f",gain_delta);text(x+100,y-10-float(s.player.tick-gain_tick)*.25f,gain,16,gain_delta>=0?palette.gain:palette.loss);}
                if(native::scroll_style(style)&&prefs.at("perfectIndicator").get<bool>()&&run.last_perfect_tick>=0&&s.player.tick>=uint32_t(run.last_perfect_tick)&&s.player.tick-uint32_t(run.last_perfect_tick)<35)text(x-160,y+5,"PERFECT",12,amber);
            }
            {const auto [x,y]=at("runStats",w/2,h-68);
                if(native::scroll_style(style))std::snprintf(buf,sizeof(buf),"%u jumps  %u strafes  %.1f%% sync  %.1f%% perf",run.jumps,run.strafes,run.sync_percent,run.perf_percent);
                else std::snprintf(buf,sizeof(buf),"%u jumps  %u strafes  %.1f%% sync",run.jumps,run.strafes,run.sync_percent);
                text(x,y,buf,13,dim,true);}
            // Jump stats sit above the run status, clear of the timer and speed.
            // The accent marks a gain the plugin would call good.
            if(!jump_stats.empty()){const auto [x,y]=at("jumpStats",w/2,h-222);text(x,y,jump_stats,14,jump_stats_color(jump_stats_gain),true);}
            // Strafe trainer above that: the percentage, a bar whose centre line
            // is 100% (either end being 0% and 200%), and a hint under the bar.
            if(strafe) {
                const auto &bands=palette.trainer;
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
            const std::array<std::pair<const char*,uint32_t>,6> keys={{{"forward",native::forward},{"left",native::left},{"back",native::back},{"right",native::right},{"jump",native::jump},{"duck",native::duck}}};
            if(prefs.at("keysOverlay").get<bool>()){const auto [x0,y]=at("keys",26,h-65);float x=x0;
                for(const auto &[action,bit]:keys){std::string label="-";const auto &codes=prefs.at("binds").at(action);if(!codes.empty())label=codes[0].get<std::string>();if(label.starts_with("Key"))label.erase(0,3);else if(label.starts_with("Digit"))label.erase(0,5);else if(label=="ControlLeft"||label=="ControlRight")label="CTRL";else if(label=="Space")label="SPACE";
                const bool minimal=prefs.at("keysStyle")=="minimal",keycaps=prefs.at("keysStyle")=="keycaps";float size=std::max(28.f,float(label.size())*8.4f+10);
                if(!minimal)rect(x,y,size,27,(cmd.buttons&bit)?Color{1,.71f,.24f,.85f}:Color{.05f,.05f,.07f,.6f});
                if(keycaps)rect(x+2,y+24,size-4,2,(cmd.buttons&bit)?Color{.6f,.4f,.1f,1}:Color{.4f,.4f,.43f,1});
                text(x+5,y+2,label,14,(cmd.buttons&bit)?Color{.08f,.07f,.06f,1}:dim);x+=size+4;}}
            {const auto [x,y]=at("health",w-275,h-62);
                std::snprintf(buf,sizeof(buf),"HP %.0f  AMMO %u/%u",s.health,weapon.clip,weapon.clip_size);
                text(x,y,buf,14,cream);}
            if(!notice.empty()){const auto [x,y]=at("notice",w/2,70);text(x,y,notice.substr(0,100),15,amber,true);}
            if(!split_line.empty()||!delta_line.empty()){const auto [x,y]=at("splits",w/2,h-330);if(!split_line.empty())text(x,y,split_line,14,cream,true);if(!delta_line.empty())text(x,y+22,delta_line,13,delta_good?palette.gain:palette.loss,true);}
            if(prefs.at("speedGraph").get<bool>()&&!speed_history.empty()){
                const auto [x,y]=at("speedGraph",w-300,h-180);rect(x,y,260,80,{.03f,.03f,.05f,.6f});
                float peak=500;for(const auto &[tick,v]:speed_history)peak=std::max(peak,v);
                for(size_t i=0;i<speed_history.size();++i){const float bar=speed_history[i].second/peak*65;rect(x+float(i)*260/250,y+75-bar,1.2f,bar,amber);}
            }
            element_visible=true;element_scale=1;
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
        flush(width,height);
    }
private:
    void flush(int width,int height){
        gl.Disable(GL_DEPTH_TEST);gl.DepthMask(GL_FALSE);gl.Disable(GL_CULL_FACE);gl.Enable(GL_BLEND);gl.BlendFunc(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);
        gl.UseProgram(program);const float viewport[3]={float(width),float(height),0};
        gl.Uniform3fv(gl.GetUniformLocation(program,"viewport"),1,viewport);gl.Uniform1i(gl.GetUniformLocation(program,"font"),0);
        gl.ActiveTexture(GL_TEXTURE0);gl.BindTexture(GL_TEXTURE_2D,atlas);gl.BindVertexArray(vao);gl.BindBuffer(GL_ARRAY_BUFFER,vbo);
        gl.BufferData(GL_ARRAY_BUFFER,vertices.size()*sizeof(float),vertices.data(),GL_STREAM_DRAW);for(const auto &batch:batches){gl.BindTexture(GL_TEXTURE_2D,batch.texture);gl.DrawArrays(GL_TRIANGLES,GLint(batch.first),GLsizei(batch.count));}
        gl.DepthMask(GL_TRUE);gl.Enable(GL_DEPTH_TEST);
    }
};
}
