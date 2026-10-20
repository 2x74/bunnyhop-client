#pragma once
#include "bunnyhop_native.h"
#include <algorithm>
#include <cmath>
#include <string>

namespace native {
// The same thresholds and gains as web/audio/movement.ts, independent of audio devices.
class MovementAudio {
    BhState previous{};
    bool first=true,in_water=false;
    double step_timer=.15,swim_timer=0,boost_cool=0;
public:
    void reset(){first=true;step_timer=.15;swim_timer=boost_cool=0;}
    template<class Sink> void tick(const BhState &p,double dt,double depth,const std::string &surface,Sink play){
        const double speed=std::hypot(double(p.velocity[0]),double(p.velocity[1]));
        const bool water=depth>6,swimming=water&&depth>34;
        const bool landed=p.events&4,jumped=p.events&2;
        if(first){first=false;previous=p;in_water=water;return;}
        if(p.events&1){play("teleport",.8,1.);previous=p;in_water=water;step_timer=.2;return;}
        boost_cool-=dt;
        if(water&&!in_water)play("water_enter",std::clamp(.35+std::max(0.,-double(previous.velocity[2]))/800,.35,1.),1.);
        else if(!water&&in_water&&!(depth>0))play("water_exit",.7,1.);
        in_water=water;
        const auto step="step_"+std::string(water?"water":surface);
        if(landed&&!swimming){
            const auto fall=std::max(0.,-double(previous.velocity[2]));
            if(fall>560){play("land_hard",std::clamp(.55+(fall-560)/900,.55,1.),1.);play(step,.5,1.);}
            else{play("land_soft",std::clamp(.22+fall/700,.2,.75)*(jumped?.7:1),1.);if(!jumped)play(step,.25,1.);}
            step_timer=.28;
        }
        if(jumped&&!swimming)play("jump",landed?.55:.8,1.);
        const auto dvz=p.velocity[2]-double(previous.velocity[2]),dh=speed-std::hypot(double(previous.velocity[0]),double(previous.velocity[1]));
        if(!jumped&&!landed&&boost_cool<=0&&(dvz>160||dh>180)&&!swimming){
            play("boost",std::clamp(std::max(dvz,dh)/700,.45,1.),1.);boost_cool=.4;
        }
        if(p.grounded&&!jumped&&!swimming&&speed>80){
            step_timer-=dt;if(step_timer<=0){play(step,(speed>=150?.55:.22)*(p.crouched?.55:1),1.);step_timer=speed>=200&&!p.crouched?.3:.4;}
        }else if(p.on_ladder&&std::abs(p.velocity[2])>40){
            step_timer-=dt;if(step_timer<=0){play("step_metal",.4,.92);step_timer=.4;}
        }else if(p.grounded&&speed<=80)step_timer=std::min(step_timer,.12);
        if(swimming&&std::sqrt(speed*speed+double(p.velocity[2])*p.velocity[2])>60){
            swim_timer-=dt;if(swim_timer<=0){play("swim",.6,1.);swim_timer=.85;}
        }else swim_timer=std::min(swim_timer,.2);
        previous=p;
    }
};
}
