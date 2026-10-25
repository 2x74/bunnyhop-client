#pragma once
#include "bunnyhop_native.h"
#include <algorithm>
#include <string>
#include <vector>

namespace native {
// Host-only v27 practice policy. The bridge owns snapshots; nothing here changes
// canonical movement, recorded input, replay simulation or ranked timer rules.
struct Practice {
    struct Checkpoint { uint32_t handle; std::string selected,style; uint32_t track; };
    bool mode=false,active=false,noclip=false,menu_open=false;
    std::string tool;
    BhNoclipState flight{};
    std::vector<Checkpoint> checkpoints;
    size_t current=0;
    int64_t hinted_run=-1;
    bool key_allowed(const std::string &action,bool timed) const {
        return action=="save" || !timed || active || menu_open;
    }
    void restart() { active=mode;noclip=false;tool.clear();hinted_run=-1; }
    void clear(BhContext *core) {
        if(core)for(const auto &cp:checkpoints)bh_practice_free(core,cp.handle);
        *this=Practice{};
    }
    void retain(Checkpoint cp) { checkpoints.push_back(std::move(cp));current=checkpoints.size()-1; }
    void step(int delta) {
        if(!checkpoints.empty())current=size_t(std::clamp(int(current)+delta,0,int(checkpoints.size())-1));
    }
    size_t number() const { return checkpoints.empty()?0:current+1; }
};
inline std::string practice_unavailable(bool core,bool playback,bool room,bool tutorial,bool gauntlet) {
    if(!core)return "Load a map to use practice.";
    if(playback)return "Practice isn't available in the replay viewer.";
    if(room)return "Practice is for solo play, not servers.";
    if(tutorial)return "Practice isn't available in the tutorial.";
    if(gauntlet)return "No practice during a gauntlet.";
    return {};
}
// Run reset/stop must always pass so pending service replies can be invalidated.
inline bool practice_allows_event(bool active,const std::string &type) {
    return !active || (type!="beat" && type!="finish");
}
}
