#pragma once
#include "bunnyhop_native.h"
#include "render_shaders.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <deque>
#include <optional>
#include <unordered_map>
#include <vector>

namespace native {
class RoomState {
    struct Sample {BhGhostFrame frame;bool teleport;};
    struct Peer {native_render::Actor actor;std::deque<Sample> samples;double arrived=0;bool spectator=false;};
    std::unordered_map<unsigned,Peer> peers;
    void player(const nlohmann::json &p,bool patch=false) {
        const unsigned slot=p.at("slot").get<unsigned>();if(slot>=256)return;
        auto &peer=peers[slot];
        if(p.contains("name"))peer.actor.name=p.at("name").get<std::string>().substr(0,128);
        peer.actor.id=std::to_string(slot);peer.actor.opacity=1;
        if(p.contains("outfit"))peer.actor.outfit=p.value("outfit",nlohmann::json()).is_string()?p.at("outfit").get<std::string>():"";
        if(p.contains("loadout")) {
            if(p["loadout"].is_object()) {
                const auto &l=p["loadout"];
                peer.actor.loadout="2;"+l.value("knife",std::string("knife-carrot"))+";"+l.value("finish",std::string("finish-default"))+";"+l.value("glove",std::string("glove-default"))+";";
                if(l.contains("crown")&&l["crown"].is_number_integer())peer.actor.loadout+=std::to_string(l["crown"].get<int>());
                peer.actor.loadout+=";"+(l.contains("hat")&&l["hat"].is_string()?l["hat"].get<std::string>():"")+";"+l.value("body",std::string("body-a"));
                if(peer.actor.loadout.size()>200)peer.actor.loadout.clear();
            }
            else peer.actor.loadout.clear();
        }
        if(!patch||p.contains("spec")){
            peer.spectator=p.contains("spec")&&!p["spec"].is_null();
            if(slot==self){
                spectator_target.reset();
                if(peer.spectator&&p["spec"].is_number_unsigned()){
                    const auto target=p["spec"].get<unsigned>();if(target<256&&target!=self)spectator_target=target;
                }else if(peer.spectator&&p["spec"].is_number_integer()){
                    const auto target=p["spec"].get<int>();if(target>=0&&target<256&&unsigned(target)!=self)spectator_target=unsigned(target);
                }
            }
        }
    }
public:
    uint64_t generation=0;
    std::string id,map,notice;
    unsigned self=256;
    std::optional<unsigned> spectator_target;
    void clear(){peers.clear();id.clear();map.clear();notice.clear();self=256;spectator_target.reset();}
    // Returns a map name only when the room has actually switched, not on a future vote announcement.
    std::string event(const nlohmann::json &message) {
        const auto next=message.at("generation").get<uint64_t>();
        if(next<generation)return "";
        const auto next_id=message.at("id").get<std::string>();
        if(next==generation&&!id.empty()&&next_id!=id)return "";
        if(next>generation){clear();generation=next;}
        id=next_id;
        const auto &e=message.at("event");const auto type=e.at("t").get<std::string>();
        if(type=="nativeLeave"){clear();return "";}
        if(type=="welcome") {
            peers.clear();spectator_target.reset();self=e.at("you").get<unsigned>();for(const auto &p:e.at("players"))player(p);
            map=e.at("map").at("name").get<std::string>();return map;
        }
        if(type=="join")player(e.at("player"));
        else if(type=="leave"){const auto slot=e.at("slot").get<unsigned>();peers.erase(slot);if(spectator_target==slot)spectator_target.reset();}
        else if(type=="player") {auto p=e.at("patch");p["slot"]=e.at("slot");player(p,true);}
        else if(type=="map"||type=="nativeMap") {
            const auto &m=e.at("map");map=m.is_string()?m.get<std::string>():m.at("name").get<std::string>();
            for(auto &[slot,p]:peers)p.samples.clear();return map;
        } else if(type=="chat")notice=e.value("name",std::string("Server"))+": "+e.value("text",std::string());
        return "";
    }
    void snapshot(const nlohmann::json &message,double now) {
        if(message.at("generation")!=generation||message.at("id")!=id)return;
        const auto &blocks=message.at("snapshot").at("blocks");
        if(!blocks.is_array()||blocks.size()>64)throw std::runtime_error("Invalid room snapshot");
        for(const auto &block:blocks) {
            const unsigned slot=block.at("slot").get<unsigned>();if(slot==self||slot>=256)continue;
            auto &p=peers[slot];p.actor.id=std::to_string(slot);p.actor.opacity=1;
            const auto &samples=block.at("samples");if(!samples.is_array()||samples.size()>8)continue;
            for(const auto &raw:samples) {
                BhGhostFrame f{};f.tick=raw.at("tick").get<uint32_t>();bool valid=true;
                for(int i=0;i<3;i++){const char *pos[]={"x","y","z"},*vel[]={"vx","vy","vz"};
                    f.position[i]=raw.at(pos[i]).get<float>();f.velocity[i]=raw.at(vel[i]).get<float>();
                    valid&=std::isfinite(f.position[i])&&std::abs(f.position[i])<=16896&&std::isfinite(f.velocity[i])&&std::abs(f.velocity[i])<=32768;}
                f.yaw=raw.at("yaw").get<float>();f.pitch=raw.at("pitch").get<float>();
                valid&=std::isfinite(f.yaw)&&std::isfinite(f.pitch);if(!valid)continue;
                const unsigned flags=raw.at("flags").get<unsigned>();
                f.flags=(flags&2?1:0)|(flags&1?2:0);f.view_offset_z=f.flags&1?46:64;
                const auto previous_weapon=p.samples.empty()?p.actor.frame.weapon:p.samples.back().frame.weapon;
                f.weapon=block.value("weapon",previous_weapon?previous_weapon:1u);
                if(f.weapon>31)f.weapon=1;
                if(!p.samples.empty()&&f.tick<=p.samples.back().frame.tick)continue;
                if(flags&8)p.samples.clear();
                p.samples.push_back({f,bool(flags&8)});while(p.samples.size()>32)p.samples.pop_front();p.arrived=now;
            }
        }
    }
    std::vector<native_render::Actor> actors(double now) {
        std::vector<native_render::Actor> out;
        for(auto &[slot,p]:peers) {
            if(slot==self||p.spectator||p.samples.empty()||now-p.arrived>10)continue;
            const double target=p.samples.back().frame.tick+std::clamp(now-p.arrived,0.,.15)*100-10;
            auto frame=p.samples.front().frame;
            for(size_t i=1;i<p.samples.size();i++) {
                const auto &a=p.samples[i-1].frame,&b=p.samples[i].frame;
                if(target>=b.tick){frame=b;continue;}
                if(target<a.tick)break;
                const float t=float(std::clamp((target-a.tick)/double(b.tick-a.tick),0.,1.));
                frame=b;for(int k=0;k<3;k++){frame.position[k]=a.position[k]+(b.position[k]-a.position[k])*t;frame.velocity[k]=a.velocity[k]+(b.velocity[k]-a.velocity[k])*t;}
                const float dy=std::remainder(b.yaw-a.yaw,360.f);frame.yaw=a.yaw+dy*t;frame.pitch=a.pitch+(b.pitch-a.pitch)*t;break;
            }
            p.actor.frame=frame;out.push_back(p.actor);
        }
        return out;
    }
    std::optional<native_render::Actor> spectated(double now){
        if(!spectator_target)return std::nullopt;
        for(auto &actor:actors(now))if(actor.id==std::to_string(*spectator_target))return actor;
        return std::nullopt;
    }
};
}
