#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <map>
#include <string>
#include <nlohmann/json.hpp>
namespace native {
// Real active time, independent of simulation speed. Public replay/score stats
// remain server-owned; these counters feed the web's playtime and device stats.
class ActivityCounter {
    struct Map {double seconds=0;uint64_t jumps=0,attempts=0;};
    std::map<std::string,Map> maps;
    double seconds_=0,last_input=0;uint64_t jumps_=0;
    Map *entry(const std::string &map){if(map.empty())return nullptr;auto it=maps.find(map);if(it!=maps.end())return &it->second;if(maps.size()>=256)return nullptr;return &maps[map];}
public:
    void input(double now){if(std::isfinite(now))last_input=now;}
    void loaded(const std::string &map){entry(map);}
    void frame(const std::string &map,double dt,double now,bool playing){
        if(!playing||map.empty()||!std::isfinite(dt)||!std::isfinite(now)||dt<=0||now<last_input||now-last_input>=30)return;
        const double counted=std::min(dt,2.);seconds_+=counted;if(auto *m=entry(map))m->seconds+=counted;
    }
    void jump(const std::string &map){++jumps_;if(auto *m=entry(map))++m->jumps;}
    void attempt(const std::string &map){if(auto *m=entry(map))++m->attempts;}
    nlohmann::json sample(bool active)const{auto rows=nlohmann::json::array();for(const auto &[map,c]:maps)rows.push_back({{"map",map},{"seconds",c.seconds},{"jumps",c.jumps},{"attempts",c.attempts}});return {{"seconds",seconds_},{"jumps",jumps_},{"maps",rows},{"active",active}};}
};
}
