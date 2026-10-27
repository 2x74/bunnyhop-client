#pragma once
#include "bunnyhop_native.h"
#include "settings.hpp"
#include <array>
#include <optional>
#include <vector>
namespace native {
struct StartPoint {std::array<float,3> position{};float yaw=0,pitch=0;};
inline bool start_zone_holds(const BhZone &z,const float p[3],uint32_t track){
    return z.kind==0&&z.track==track&&p[0]-16>=z.mins[0]&&p[0]+16<=z.maxs[0]&&p[1]-16>=z.mins[1]&&p[1]+16<=z.maxs[1]&&p[2]<=z.maxs[2]&&p[2]+62>=z.mins[2];
}
// Practice runs may set a start point too (web keeps one start point per map and
// track for main and practice alike). The point is still validated here and again
// at every restart, and the verifier checks the replay header's spawn, so what
// practice tools did earlier in the run cannot leak into it. Noclip is refused:
// the flight state is not the player's resting state.
inline std::string start_point_problem(const BhState &s,const std::vector<BhZone> &zones,uint32_t track,bool noclip){
    if(noclip)return "Turn off noclip first";
    if(!s.grounded||s.on_ladder)return "Stand on the ground";
    if(s.crouched)return "Stand up";
    if(std::hypot(std::hypot(s.velocity[0],s.velocity[1]),s.velocity[2])>1)return "Stand still";
    for(const auto &z:zones)if(start_zone_holds(z,s.position,track))return {};
    return "Move fully inside the start zone";
}
struct StartPoints {
    Json points=Json::object();
    static std::string key(const std::string &map,uint32_t track){return map+":"+std::to_string(track);}
    bool load(const Json &value){if(!value.is_object()||value.size()>4096)return false;for(auto it=value.begin();it!=value.end();++it){if(!decode(it.value()))return false;}points=value;return true;}
    static std::optional<StartPoint> decode(const Json &v){
        try{if(!v.is_object()||!v.contains("position")||!v["position"].is_array()||v["position"].size()!=3)return {};StartPoint out;for(int i=0;i<3;++i){out.position[i]=v["position"][i].get<float>();if(!std::isfinite(out.position[i])||std::abs(out.position[i])>32768)return {};}out.yaw=v.at("yaw").get<float>();out.pitch=v.at("pitch").get<float>();if(!std::isfinite(out.yaw)||!std::isfinite(out.pitch)||out.pitch< -89||out.pitch>89)return {};return out;}catch(...){return {};}
    }
    void save(const std::string &map,uint32_t track,const BhState &s,double yaw,double pitch){points[key(map,track)]={{"position",{s.position[0],s.position[1],s.position[2]}},{"yaw",yaw},{"pitch",pitch}};}
    bool clear(const std::string &map,uint32_t track){return points.erase(key(map,track))!=0;}
    std::optional<StartPoint> get(const std::string &map,uint32_t track)const{const auto it=points.find(key(map,track));return it==points.end()?std::nullopt:decode(*it);}
};
// Hold-to-restart ignores autorepeat, cancels on release/focus transitions and
// fires only once. Wheel bindings cannot be held and act immediately, as on web.
struct RestartGuard {
    double started=-1;std::string action;
    void cancel(){started=-1;action.clear();}
    bool press(const std::string &next,double now,bool enabled,bool /*timed*/,bool wheel){
        if(!enabled||wheel){cancel();return true;}
        if(started<0||action!=next){action=next;started=now;}return false;
    }
    float progress(double now)const{return started<0?-1.f:float(std::clamp((now-started)/500.,0.,1.));}
    std::optional<std::string> frame(double now,bool held,bool suspended){if(started<0)return {};if(suspended){cancel();return {};}if(now-started>=500){const auto result=action;cancel();return result;}if(!held)cancel();return {};}
};
}
