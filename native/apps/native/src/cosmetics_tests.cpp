#include "native_cosmetics.hpp"
#include <cassert>
#include <limits>
int main(){using namespace native_render;
 assert(!parse_glow(nullptr));assert(!parse_glow("violet"));auto a=parse_glow({{"enabled",true},{"aura",false},{"color","#12AB34"},{"intensity",4}});assert(a&&a->enabled&&!a->aura&&a->intensity==1);assert(std::abs(a->color[0]-18.f/255)<.001);
 auto b=parse_glow({{"enabled","yes"},{"aura",7},{"color",nullptr},{"intensity",-.5}});assert(b&&!b->enabled&&b->aura&&b->intensity==.25f);assert(parse_glow({{"color","cyan"}})->color[2]>.9f);
 AccessoryMotion motion;advance_accessory(motion,0,0,true);advance_accessory(motion,.1,1000,false);assert(motion.angle>1&&motion.squash>0&&motion.alert>0);const auto before=motion.angle;advance_accessory(motion,.11,1000,false);assert(motion.angle>before);advance_accessory(motion,.12,1000,true);assert(motion.squash<0);advance_accessory(motion,0,0,true,true);assert(motion.angle==0&&motion.squash==0);advance_accessory(motion,.1,std::numeric_limits<float>::quiet_NaN(),true);assert(std::isfinite(motion.angle));
 auto standard=hat_fit("outfit-cream","hat-propeller");assert(standard.scale[0]==1&&standard.offset[2]==0);auto plush=hat_fit("outfit-plush","hat-halo");assert(plush.offset[2]==5.5f);auto bune=hat_fit("outfit-bune","hat-maxwell");assert(bune.scale[0]==1&&bune.offset[2]==.55f);
 for (const auto *hat : {"hat-halo", "hat-aurora", "hat-gem-orbit", "hat-lucky-coins"}) {
     const auto fit = hat_fit("outfit-cream", hat);
     assert((fit.scale == std::array<float, 3>{1, 1, 1}));
     assert((fit.offset == std::array<float, 3>{0, 0, 0}));
     assert(hat_fit("outfit-plush", hat).offset[2] == 5.5f);
     assert(hat_fit("outfit-bune", hat).offset[2] == 3.f);
 }
}
