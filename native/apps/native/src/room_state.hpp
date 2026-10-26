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
    struct Sample {BhGhostFrame frame;bool teleport;unsigned wire_flags=0;bool silenced=false;};
    struct Peer {native_render::Actor actor;std::deque<Sample> samples;double arrived=0,offset=0,batch=.1,jitter=0,meta_at=0;bool clock=false,spectator=false;uint32_t rendered=0;double rendered_at=-1; nlohmann::json info,meta;};
    std::unordered_map<unsigned,Peer> peers;
    bool closed_=false;
    void player(const nlohmann::json &p,bool patch=false) {
        const unsigned slot=p.at("slot").get<unsigned>();if(slot>=256)return;
        auto &peer=peers[slot];
        if(!patch||!peer.info.is_object())peer.info=p;else for(auto it=p.begin();it!=p.end();++it)peer.info[it.key()]=it.value();
        if(p.contains("name"))peer.actor.name=p.at("name").get<std::string>().substr(0,128);
        peer.actor.id=std::to_string(slot);peer.actor.opacity=1;
        if(!patch||p.contains("playerGlow"))peer.actor.playerGlow=p.contains("playerGlow")?native_render::parse_glow(p["playerGlow"]):std::nullopt;
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
    std::string id,map,notice,status;
    nlohmann::json vote=nullptr,change=nullptr,nominations=nlohmann::json::array(),room_info;
    double clock_offset_ms=0;
    unsigned self=256;
    std::optional<unsigned> spectator_target;
    void clear(){vote=nullptr;change=nullptr;nominations=nlohmann::json::array();room_info=nullptr;status.clear();peers.clear();id.clear();map.clear();notice.clear();self=256;spectator_target.reset();}
    // End the current room lifecycle without rewinding its stale-event fence.
    // A deliberate join uses a newer UI generation; queued callbacks from the
    // closed generation must never resurrect a room or request another map.
    void close(){clear();closed_=true;}
    // Returns a map name only when the room has actually switched, not on a future vote announcement.
    std::string event(const nlohmann::json &message) {
        const auto next=message.at("generation").get<uint64_t>();
        if(next<generation||(next==generation&&closed_))return "";
        const auto next_id=message.at("id").get<std::string>();
        if(next==generation&&!id.empty()&&next_id!=id)return "";
        if(next>generation){clear();generation=next;closed_=false;}
        id=next_id;
        const auto &e=message.at("event");const auto type=e.at("t").get<std::string>();
        if(type=="nativeLeave"){close();return "";}
        if(e.contains("nativeClockOffsetMs")&&e["nativeClockOffsetMs"].is_number())clock_offset_ms=e["nativeClockOffsetMs"].get<double>();
        if(type=="nativeStatus"){status=e.value("status",std::string());if(status=="closed"){peers.clear();spectator_target.reset();vote=nullptr;change=nullptr;}return "";}
        if(type=="kicked"){notice=e.value("reason",std::string("Removed from room"));peers.clear();spectator_target.reset();status="closed";return "";}
        if(type=="vote")vote=e.at("vote");else if(type=="voteEnd")vote=nullptr;else if(type=="change")change=e.at("change");else if(type=="nominations")nominations=e.at("list");
        if(type=="welcome") {
            status="open";room_info=e.value("room",nlohmann::json::object());vote=e.value("vote",nlohmann::json(nullptr));change=e.value("change",nlohmann::json(nullptr));nominations=e.value("nominations",nlohmann::json::array());
            peers.clear();spectator_target.reset();self=e.at("you").get<unsigned>();for(const auto &p:e.at("players"))player(p);
            if(e.contains("metas")&&e["metas"].is_object())for(auto it=e["metas"].begin();it!=e["metas"].end();++it){try{const unsigned slot=unsigned(std::stoul(it.key()));if(slot<256)peers[slot].meta=it.value();}catch(const std::exception &) {}}
            map=e.at("map").at("name").get<std::string>();return map;
        }
        if(type=="join")player(e.at("player"));
        else if(type=="leave"){const auto slot=e.at("slot").get<unsigned>();peers.erase(slot);if(spectator_target==slot)spectator_target.reset();}
        else if(type=="player") {auto p=e.at("patch");p["slot"]=e.at("slot");player(p,true);}
        else if(type=="map"||type=="nativeMap") {
            const auto &m=e.at("map");map=m.is_string()?m.get<std::string>():m.at("name").get<std::string>();
            change=nullptr;vote=nullptr;for(auto &[slot,p]:peers){p.samples.clear();p.clock=false;}return map;
        } else if(type=="chat")notice=e.value("name",std::string("Server"))+": "+e.value("text",std::string());
        return "";
    }
    void snapshot(const nlohmann::json &message,double now) {
        if(closed_||message.at("generation")!=generation||message.at("id")!=id)return;
        const auto &blocks=message.at("snapshot").at("blocks");
        if(!blocks.is_array()||blocks.size()>64)throw std::runtime_error("Invalid room snapshot");
        for(const auto &block:blocks) {
            const unsigned slot=block.at("slot").get<unsigned>();if(slot==self||slot>=256)continue;
            auto &p=peers[slot];if(block.contains("meta")&&block["meta"].is_object()){p.meta=block["meta"];p.meta_at=now;}p.actor.id=std::to_string(slot);p.actor.opacity=1;
            const auto &samples=block.at("samples");if(!samples.is_array()||samples.size()>8)continue;
            bool appended=false;
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
                if(flags&8){p.samples.clear();p.clock=false;p.rendered=0;p.rendered_at=-1;}
                appended=true;p.samples.push_back({f,bool(flags&8),flags,block.value("silenced",false)});while(p.samples.size()>96)p.samples.pop_front();
            }
            if(appended&&!p.samples.empty()&&now>p.arrived){
                const double offset=now-p.samples.back().frame.tick*.01;
                if(!p.clock){p.offset=offset;p.clock=true;}else {const double late=std::max(0.,offset-p.offset);p.jitter=.9*p.jitter+.1*std::min(late,.12);p.offset=std::min(offset,p.offset+.0002);if(p.arrived>0)p.batch=.8*p.batch+.2*std::clamp(now-p.arrived,.02,.4);}
                p.arrived=now;
            }
        }
    }
    std::vector<native_render::Actor> actors(double now) {
        std::vector<native_render::Actor> out;
        for(auto &[slot,p]:peers) {
            if(slot==self||p.spectator||p.samples.empty()||now-p.arrived>10)continue;
            const double delay=std::clamp(p.batch+p.jitter,.1,.52);
            const double target=(now-p.offset-delay)*100+1e-7;
            auto frame=p.samples.front().frame;
            for(size_t i=1;i<p.samples.size();i++) {
                const auto &a=p.samples[i-1].frame,&b=p.samples[i].frame;
                if(target>=b.tick){frame=b;continue;}
                if(target<a.tick)break;
                const float t=float(std::clamp((target-a.tick)/double(b.tick-a.tick),0.,1.));
                frame=b;const float dt=float(b.tick-a.tick)*.01f;bool smooth=dt>0&&dt<=.12f;
                for(int k=0;k<3;k++){const float avg=(b.position[k]-a.position[k])/dt,mean=(a.velocity[k]+b.velocity[k])*.5f;if(std::abs(avg-mean)>std::abs(avg)*.15f+60)smooth=false;}
                for(int k=0;k<3;k++){const float linear=a.position[k]+(b.position[k]-a.position[k])*t;
                    frame.position[k]=smooth&&!(k==2&&(a.flags&2)&&(b.flags&2))?(2*t*t*t-3*t*t+1)*a.position[k]+(t*t*t-2*t*t+t)*dt*a.velocity[k]+(-2*t*t*t+3*t*t)*b.position[k]+(t*t*t-t*t)*dt*b.velocity[k]:linear;
                    frame.velocity[k]=a.velocity[k]+(b.velocity[k]-a.velocity[k])*t;}
                const float dy=std::remainder(b.yaw-a.yaw,360.f);frame.yaw=a.yaw+dy*t;frame.pitch=a.pitch+(b.pitch-a.pitch)*t;break;
            }
            if(target>p.samples.back().frame.tick){const float extra=float(std::clamp((target-p.samples.back().frame.tick)*.01,0.,.1));for(int k=0;k<3;k++)frame.position[k]+=frame.velocity[k]*extra;}
            if(p.rendered_at!=now){
                p.actor.jumped=false;p.actor.attack=0;p.actor.inspect=0;p.actor.snapped=false;
                for(const auto &sample:p.samples)if(sample.frame.tick<=target||(sample.teleport&&p.rendered==0)){
                    if(sample.frame.tick>p.rendered){p.actor.jumped|=bool(sample.wire_flags&4);p.actor.attack=sample.wire_flags&32?2:sample.wire_flags&16?1:p.actor.attack;const auto inspect=(sample.wire_flags>>6)&3;if(inspect==1||inspect==2)p.actor.inspect=inspect;p.actor.snapped|=sample.teleport;}
                    p.actor.silenced=sample.silenced;if(((sample.wire_flags>>6)&3)==0)p.actor.inspectHeld=false;else if(((sample.wire_flags>>6)&3)==3)p.actor.inspectHeld=true;
                }
                p.rendered=std::max(p.rendered,uint32_t(std::max(0.,std::min(target,double(p.samples.back().frame.tick)))));p.rendered_at=now;
            }
            p.actor.frame=frame;out.push_back(p.actor);
        }
        return out;
    }
    std::optional<std::pair<unsigned,double>> timer(unsigned slot,double now)const {
        const auto it=peers.find(slot);if(it==peers.end()||!it->second.meta.is_object())return std::nullopt;
        const auto &p=it->second;const unsigned state=p.meta.value("timer",0u);const double seconds=p.meta.value("timerTicks",0.)*.01+(state==2&&p.meta_at>0?std::max(0.,now-p.meta_at):0.);return std::pair<unsigned,double>{state,seconds};
    }
    nlohmann::json scoreboard(double now)const {
        auto rows=nlohmann::json::array();for(const auto &[slot,p]:peers){auto row=p.info.is_object()?p.info:nlohmann::json::object();row["slot"]=slot;row["name"]=p.actor.name;row["meta"]=p.meta;if(p.meta.is_object()){row["track"]=p.meta.value("track",0);row["ping"]=p.meta.value("ping",0);}const auto time=timer(slot,now);if(time){row["timer"]=time->first;row["seconds"]=time->second;}rows.push_back(row);}return rows;
    }
    std::string change_notice(double epoch_ms)const {
        if(!change.is_object()||!change.contains("at")||!change["at"].is_number())return {};const auto left=std::max(0.,std::ceil((change["at"].get<double>()-clock_offset_ms-epoch_ms)/1000));return "Changing to "+change.value("map",std::string())+" in "+std::to_string(int(std::min(left,999.)))+"s";
    }
    std::optional<native_render::Actor> spectated(double now){
        if(!spectator_target)return std::nullopt;
        for(auto &actor:actors(now))if(actor.id==std::to_string(*spectator_target))return actor;
        return std::nullopt;
    }
};
}
