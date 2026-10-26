#pragma once
#include "semantic_palette.hpp"
#include <algorithm>
#include <cmath>
#include <vector>
namespace native {
// Web ZoneView's 250 ms ease-out start/reset and 400 ms linear flare.
class ZoneEffects {
    struct Zone {unsigned kind,track;float rest,level,from,to,peak=-1;double start=-1,duration=0;bool gold=false;};
    std::vector<Zone> zones;unsigned status=0,track=0;double last=-1;
    static void tween(Zone &z,double now,float to,double duration,float peak=-1,bool gold=false){z.from=z.level;z.to=to;z.start=now;z.duration=duration;z.peak=peak;z.gold=gold;}
public:
    void clear(){zones.clear();status=track=0;last=-1;}
    void add(unsigned kind,unsigned track){const float rest=kind>=2?.5f:1.f;zones.push_back({kind,track,rest,rest,rest,rest});}
    void frame(unsigned nextStatus,unsigned nextTrack,double now,bool gold=false){
        if(!std::isfinite(now))return;
        if(last>=0&&now<last){for(auto &z:zones){z.level=z.rest;z.start=-1;z.gold=false;}status=0;}
        for(auto &z:zones)if(z.start>=0){const float k=float(std::clamp((now-z.start)/z.duration,0.,1.));
            z.level=z.peak<0?z.from+(z.to-z.from)*(1-(1-k)*(1-k)):k<.3f?z.from+(z.peak-z.from)*k/.3f:z.peak+(z.to-z.peak)*(k-.3f)/.7f;
            if(k>=1){z.start=-1;z.gold=false;}}
        if(nextStatus!=status||nextTrack!=track){
            if(nextStatus==0||nextTrack!=track)for(auto &z:zones)if(z.level<z.rest)tween(z,now,z.rest,.25);
            if(nextStatus==1)for(auto &z:zones)if(z.kind==0&&z.track==nextTrack)tween(z,now,0,.25);
            if(nextStatus==2)for(auto &z:zones)if(z.kind==1&&z.track==nextTrack)tween(z,now,z.rest,.4,2.6f,gold);
            status=nextStatus;track=nextTrack;
        }last=now;
    }
    float level(size_t index)const{return zones.at(index).level;}
    SemanticColor color(size_t index,SemanticColor base,double now)const{const auto &z=zones.at(index);if(z.gold&&z.start>=0){const float t=float(std::clamp(2*(1-(now-z.start)/z.duration),0.,1.));const auto gold=semantic_rgb(0xffd45e);for(int k=0;k<3;k++)base[k]+=(gold[k]-base[k])*t;}return base;}
};
}
