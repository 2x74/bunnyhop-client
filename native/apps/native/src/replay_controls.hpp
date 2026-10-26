#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <cstdio>
namespace native {
struct ReplayControls {
 bool visible=true,dragging=false;std::optional<uint32_t> pending;
 enum class Action {none,start,back,pause,forward,end,slower,faster,camera};
 static uint32_t offset(uint32_t tick,int seconds,double interval,uint32_t total){if(!std::isfinite(interval)||interval<=0)return tick;return uint32_t(std::clamp(std::round(double(tick)+seconds/interval),0.,double(total)));}
 static double speed(double current,bool faster){constexpr double values[]={.1,.25,.5,1,1.5,2,4,8};if(faster){for(auto v:values)if(v>current+.001)return v;return 8;}for(int i=7;i>=0;--i)if(values[i]<current-.001)return values[i];return .1;}
 struct Layout{float x,y,width;};
 static Layout layout(float width,float height){return {20,std::max(0.f,height-112),std::max(1.f,width-40)};}
 static bool timeline(Layout b,float x,float y){return x>=b.x&&x<=b.x+b.width&&y>=b.y+29&&y<=b.y+55;}
 static uint32_t tick_at(Layout b,float x,uint32_t total){return uint32_t(std::round(std::clamp(double((x-b.x)/b.width),0.,1.)*total));}
 Action pointer(Layout b,float x,float y,uint32_t total,bool down){if(!down){dragging=false;return Action::none;}if(timeline(b,x,y)){dragging=true;pending=tick_at(b,x,total);return Action::none;}if(y<b.y+60||y>b.y+90||x<b.x||x>b.x+b.width)return Action::none;const int index=int((x-b.x)/(b.width/8));return static_cast<Action>(std::clamp(index,0,7)+1);}
 void motion(Layout b,float x,uint32_t total){if(dragging)pending=tick_at(b,x,total);}
 std::optional<uint32_t> take(){auto result=pending;pending.reset();return result;}
};
template<class Hud>void draw_replay_controls(Hud&hud,int width,int height,float scale,const ReplayControls& controls,uint32_t tick,uint32_t total,double interval,bool paused,double speed,const std::string& camera){
 if(!controls.visible)return;const auto b=ReplayControls::layout(width/scale,height/scale);hud.overlay_begin(width,height,100); // draw below in physical pixels, independent of HUD preference
 const auto p=[](float v){return v;};
 hud.overlay_rect(p(b.x-8),p(b.y-7),p(b.width+16),p(104),{.025f,.03f,.045f,.94f});char label[180];std::snprintf(label,sizeof(label),"Replay  %.2fs / %.2fs   %.2gx   %s   Space pause | Tab camera control | Esc menu",tick*interval,total*interval,speed,camera.c_str());hud.overlay_text(p(b.x),p(b.y),label,p(13),{.94f,.91f,.85f,1});
 hud.overlay_rect(p(b.x),p(b.y+37),p(b.width),p(7),{.23f,.24f,.29f,1});const float fraction=total?float(tick)/total:0;hud.overlay_rect(p(b.x),p(b.y+37),p(b.width*fraction),p(7),{.7f,.8f,.95f,1});hud.overlay_rect(p(b.x+b.width*fraction-3),p(b.y+32),p(6),p(17),{1,1,1,1});
 const char* labels[]={"|<","-5s",paused?"Play":"Pause","+5s",">|","Slower","Faster","Camera"};for(int i=0;i<8;++i){const float x=b.x+i*b.width/8;hud.overlay_rect(p(x+2),p(b.y+60),p(b.width/8-4),p(29),{.15f,.17f,.22f,1});hud.overlay_text(p(x+b.width/16),p(b.y+67),labels[i],p(13),{.94f,.91f,.85f,1},true);}hud.overlay_end(width,height);
}
}
