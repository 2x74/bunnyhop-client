#pragma once
#include "nlohmann/json.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <string>
namespace native_render {
struct Glow {bool enabled=false,aura=true;float intensity=.7f;std::array<float,3> color{.741f,.329f,1};};
inline std::optional<Glow> parse_glow(const nlohmann::json &value){
 if(!value.is_object())return std::nullopt;Glow glow;glow.enabled=value.contains("enabled")&&value["enabled"].is_boolean()&&value["enabled"].get<bool>();glow.aura=!value.contains("aura")||!value["aura"].is_boolean()||value["aura"].get<bool>();if(value.contains("intensity")&&value["intensity"].is_number()){const float n=value["intensity"];if(std::isfinite(n))glow.intensity=std::clamp(n,.25f,1.f);}
 const std::string color=value.contains("color")&&value["color"].is_string()?value["color"].get<std::string>():"violet";const std::pair<const char*,const char*> presets[]={{"violet","#bd54ff"},{"pink","#ff65c9"},{"cyan","#54dfff"},{"gold","#ffc654"},{"green","#65ff9b"},{"white","#eef1ff"}};std::string hex=color;for(const auto &preset:presets)if(color==preset.first)hex=preset.second;
 if(hex.size()==7&&hex[0]=='#'&&hex.find_first_not_of("0123456789abcdefABCDEF",1)==std::string::npos){const auto rgb=std::stoul(hex.substr(1),nullptr,16);for(int k=0;k<3;k++)glow.color[k]=float((rgb>>(16-8*k))&255)/255;}return glow;
}
struct AccessoryMotion {double last=-1,angle=0;float alert=0,squash=0,lean=0;bool grounded=true;};
inline void advance_accessory(AccessoryMotion &motion,double seconds,float speed,bool grounded,bool snap=false){
 speed=std::isfinite(speed)?std::max(0.f,speed):0;const float desired=1-std::exp(-speed/900.f);const double dt=motion.last<0||snap||seconds<motion.last?0:std::clamp(seconds-motion.last,0.,.1);
 if(motion.last<0||snap||seconds<motion.last){motion.alert=desired;motion.squash=0;motion.angle=0;}else{motion.alert+=(desired-motion.alert)*float(1-std::exp(-8*dt));motion.squash*=float(std::exp(-12*dt));if(grounded!=motion.grounded)motion.squash=grounded?-.12f:.08f;motion.angle=std::fmod(motion.angle+(2+speed*.012)*dt,2*3.141592653589793);}
 motion.lean=motion.alert*.09f;motion.grounded=grounded;motion.last=seconds;
}
struct HatFit {std::array<float,3> scale{1,1,1},offset{0,0,0};};
inline HatFit hat_fit(const std::string &outfit,const std::string &hat){HatFit fit;const bool plush=outfit=="outfit-plush",bune=outfit=="outfit-bune";if(!plush&&!bune)return fit;
 if(hat=="hat-halo"||hat=="hat-gem-orbit"||hat=="hat-lucky-coins"||hat=="hat-aurora"){fit.offset[2]=plush?5.5f:3.f;return fit;}
 if(hat=="hat-capybara"||hat=="hat-maxwell"){fit.offset={0,.15f,plush?.65f:.55f};return fit;}if(hat=="hat-tophat"){fit.offset[2]=plush?.7f:.6f;return fit;}
 fit.scale=plush?std::array<float,3>{6.f/5.55f,6.1f/6.05f,6.5f/6}:std::array<float,3>{6.48f/5.55f,5.85f/6.05f,7.02f/6};fit.offset={0,(plush?-.1f:.01f)-.55f*fit.scale[1],(plush?70.2f:69.58f)-69.35f*fit.scale[2]};return fit;
}

}
