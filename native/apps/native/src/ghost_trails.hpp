#pragma once
#include "render_math.hpp"
#include <string>
#include <unordered_map>
#include <unordered_set>
namespace native_render {
class GhostTrails {
public:
    using Points=std::deque<std::pair<double,Vec3>>;
private:
    std::unordered_map<std::string,Points> histories;Points empty;
public:
    const Points &sample(const std::string &id,double time,const Vec3 &point,bool snapped=false){
        if(!std::isfinite(time)||!std::all_of(point.begin(),point.end(),[](float v){return std::isfinite(v);}))return empty;
        if(!histories.contains(id)&&histories.size()>=4)return empty;
        auto &history=histories[id];if(!history.empty()){float distance=0;for(int k=0;k<3;++k)distance+=(point[k]-history.back().second[k])*(point[k]-history.back().second[k]);if(snapped||time<history.back().first||distance>256*256)history.clear();}
        if(history.empty()||time-history.back().first>=1./90)history.emplace_back(time,point);
        while(!history.empty()&&(time-history.front().first>1||history.size()>128))history.pop_front();return history;
    }
    void retain(const std::unordered_set<std::string> &ids){std::erase_if(histories,[&](const auto &item){return !ids.contains(item.first);});}
    void clear(){histories.clear();}
    size_t size()const{return histories.size();}
};
}
