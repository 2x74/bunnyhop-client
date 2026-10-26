#pragma once
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>
namespace native {
using WindowJson=nlohmann::json;
inline bool valid_window_mode(const std::string& mode){return mode=="windowed"||mode=="borderless"||mode=="fullscreen";}
inline WindowJson default_window_settings(){return {{"windowMode","windowed"},{"alwaysOnTop",false},{"rememberWindowBounds",true},{"minimizeOnFocusLoss",false}};}
inline void patch_window_settings(WindowJson& target,const WindowJson& patch){if(!patch.is_object())return;if(patch.contains("windowMode")&&patch["windowMode"].is_string()){const auto mode=patch["windowMode"].get<std::string>();if(valid_window_mode(mode))target["windowMode"]=mode;}for(const char* key:{"alwaysOnTop","rememberWindowBounds","minimizeOnFocusLoss"})if(patch.contains(key)&&patch[key].is_boolean())target[key]=patch[key];}
struct WindowBounds {int x=0,y=0,width=1280,height=720;bool maximized=false;};
struct WindowArea {int x=0,y=0,width=0,height=0;};
inline std::optional<WindowBounds> read_window_bounds(const WindowJson& value){
 if(!value.is_object())return std::nullopt;for(const char*key:{"x","y","width","height"})if(!value.contains(key)||!value[key].is_number_integer())return std::nullopt;
 auto within=[&](const char* key,int64_t low,int64_t high){const auto& n=value[key];if(n.is_number_unsigned()){const auto v=n.get<uint64_t>();return v<=uint64_t(high)&&(low<0||v>=uint64_t(low));}const auto v=n.get<int64_t>();return v>=low&&v<=high;};
 for(const char*key:{"x","y"})if(!within(key,-100000,100000))return std::nullopt;
 for(const char*key:{"width","height"})if(!within(key,240,16384))return std::nullopt;
 if(value.contains("maximized")&&!value["maximized"].is_boolean())return std::nullopt;
 return WindowBounds{value["x"].get<int>(),value["y"].get<int>(),value["width"].get<int>(),value["height"].get<int>(),value.value("maximized",false)};
}
inline WindowJson window_bounds_json(const WindowBounds& b){return {{"x",b.x},{"y",b.y},{"width",b.width},{"height",b.height},{"maximized",b.maximized}};}
inline WindowBounds clamp_window_bounds(WindowBounds b,const std::vector<WindowArea>& areas){
 if(areas.empty())return {0,0,std::clamp(b.width,640,3840),std::clamp(b.height,480,2160),b.maximized};
 const WindowArea* best=nullptr;int64_t overlap=-1;
 for(const auto&a:areas){if(a.width<=0||a.height<=0)continue;const int64_t w=std::max<int64_t>(0,std::min<int64_t>(int64_t(b.x)+b.width,int64_t(a.x)+a.width)-std::max(b.x,a.x)),h=std::max<int64_t>(0,std::min<int64_t>(int64_t(b.y)+b.height,int64_t(a.y)+a.height)-std::max(b.y,a.y));if(w*h>overlap){overlap=w*h;best=&a;}}
 if(!best)return {0,0,std::clamp(b.width,640,3840),std::clamp(b.height,480,2160),b.maximized};
 b.width=std::clamp(b.width,std::min(640,best->width),best->width);b.height=std::clamp(b.height,std::min(480,best->height),best->height);
 b.x=std::clamp(b.x,best->x,best->x+best->width-b.width);b.y=std::clamp(b.y,best->y,best->y+best->height-b.height);return b;
}
inline std::string toggled_window_mode(const std::string& current){return current=="windowed"?"borderless":"windowed";}
}
