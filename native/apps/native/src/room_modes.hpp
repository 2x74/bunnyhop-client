#pragma once
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <optional>
#include <set>
#include <sstream>
#include <string>

namespace native {
struct RoomModeAction {
    bool restart=false,stop_spectating=false;
    uint32_t track=0;
    // Main-track races apply their style. Bonus races preserve the user's
    // selected main-track style; reset() chooses autohop for their active track.
    std::string style;
};

// Native counterpart of web net/race.ts. All outcomes and transitions come from
// the existing room protocol. Deadlines are display-only: local time never
// starts a race, chooses a winner, or releases the countdown's movement hold.
class RoomModes {
    using J=nlohmann::json;
    uint64_t generation_=0;
    std::string room_,prepared_,went_;
    std::optional<J> race_;
    bool closed_=false,pending_go_=false;
    double clock_offset_=0,result_until_=0,go_until_=0;
    static bool number(const J &j){return j.is_number()&&std::isfinite(j.get<double>());}
    static bool valid(const J &r) {
        if(!r.is_object()||!r.contains("id")||!r["id"].is_string()||r["id"].get_ref<const std::string&>().size()>128||!r.contains("state")||!r["state"].is_string())return false;
        static const std::set<std::string> states={"challenge","countdown","live","settling","over"},styles={"autohop","legit","wonly","sideways","hsw","autostrafe","scroll","lowgrav"};
        if(!states.contains(r["state"].get<std::string>())||!r.contains("map")||!r["map"].is_string()||!r.contains("style")||!r["style"].is_string()||!styles.contains(r["style"].get<std::string>())||!r.contains("track")||(!r["track"].is_number_unsigned()&&!(r["track"].is_number_integer()&&r["track"].get<int64_t>()>=0))||r["track"].get<uint64_t>()>64)return false;
        for(const char *key:{"a","b"})if(!r.contains(key)||!r[key].is_object()||!r[key].contains("name")||!r[key]["name"].is_string())return false;
        if(!r.contains("you")||!r["you"].is_string()||(r["you"]!="a"&&r["you"]!="b"))return false;
        for(const char *key:{"expiresAt","goAt","endsAt"})if(!r.contains(key)||(!r[key].is_null()&&!number(r[key])))return false;
        return true;
    }
    static std::string time(double seconds) {
        if(!std::isfinite(seconds)||seconds<0)return "—";
        const auto ms=uint64_t(std::min(seconds,1e9)*1000+.5);
        std::ostringstream out;out<<std::setfill('0')<<std::setw(2)<<ms/60000<<':'<<std::setw(2)<<(ms/1000)%60<<'.'<<std::setw(3)<<ms%1000;return out.str();
    }
    double local(const char *key,double fallback)const {const auto &value=race_->at(key);return value.is_null()?fallback:value.get<double>()-clock_offset_;}
    const J &opponent()const{return race_->at(race_->at("you")=="a"?"b":"a");}
    static std::string side_time(const J &side) {
        if(side.contains("finish")&&side["finish"].is_object()) {
            const auto &finish=side["finish"];
            if(finish.contains("real")&&number(finish["real"])) {
                std::string text=time(finish["real"].get<double>());
                const auto status=finish.value("status",std::string());
                if(status=="verifying")text+=" (checking)";else if(status=="rejected")text+=" (rejected)";
                return text;
            }
        }
        if(side.contains("out")&&side["out"].is_string())return side["out"]=="forfeit"?"forfeited":"left";
        return "no finish";
    }
    RoomModeAction restart(bool spectating) {
        RoomModeAction action;action.restart=true;action.stop_spectating=spectating;action.track=race_->at("track").get<uint32_t>();
        if(!action.track)action.style=race_->at("style").get<std::string>();return action;
    }
    RoomModeAction prepare(const std::string &map,bool spectating) {
        if(!race_||race_->at("map")!=map)return {};
        const auto id=race_->at("id").get<std::string>(),state=race_->at("state").get<std::string>();
        if(state=="countdown"&&prepared_!=id){prepared_=id;return restart(spectating);}
        return {};
    }
    RoomModeAction apply(const J &next,const std::string &map,bool spectating,double now) {
        if(next.is_null()){reset_race();return {};}
        if(!valid(next))return {};
        const auto id=next.at("id").get<std::string>(),state=next.at("state").get<std::string>();
        const bool from_countdown=race_&&race_->at("id")==id&&race_->at("state")=="countdown";
        if(!race_||race_->at("id")!=id){prepared_.clear();went_.clear();pending_go_=false;go_until_=0;}
        race_=next;
        if(state=="over") {
            pending_go_=false;go_until_=0;
            // Declined/expired challenges never started and have no race result.
            if(next.at("goAt").is_null())reset_race();else result_until_=now+8000;
            return {};
        }
        if(state=="countdown")return prepare(map,spectating);
        if(state=="live"&&went_!=id) {
            if(from_countdown||pending_go_) {
                if(next.at("map")!=map){pending_go_=true;return {};}
                pending_go_=false;went_=id;go_until_=now+650;return restart(spectating);
            }
            // A mid-race reconnect gets the live state, not another GO/reset.
            went_=id;
        }
        return {};
    }
    void reset_race(){race_.reset();prepared_.clear();went_.clear();pending_go_=false;result_until_=go_until_=0;}
public:
    RoomModeAction event(const J &envelope,const std::string &map,bool spectating,double now_epoch_ms) {
        if(!envelope.is_object()||!envelope.contains("generation")||(!envelope["generation"].is_number_unsigned()&&!(envelope["generation"].is_number_integer()&&envelope["generation"].get<int64_t>()>=0))||!envelope.contains("id")||!envelope["id"].is_string()||!envelope.contains("event")||!envelope["event"].is_object())return {};
        const auto generation=envelope["generation"].get<uint64_t>();const auto id=envelope["id"].get<std::string>();
        if(generation<generation_||(generation==generation_&&((closed_)||(!room_.empty()&&room_!=id))))return {};
        if(generation>generation_){reset_race();room_.clear();closed_=false;clock_offset_=0;generation_=generation;}
        room_=id;const auto &e=envelope["event"];const auto type=e.value("t",std::string());
        if(e.contains("nativeClockOffsetMs")&&number(e["nativeClockOffsetMs"]))clock_offset_=e["nativeClockOffsetMs"].get<double>();
        if(type=="nativeLeave"){reset_race();room_.clear();closed_=true;return {};}
        if(type=="nativeStatus"&&e.value("status",std::string())=="closed"){reset_race();return {};}
        if(type=="nativeMap"||type=="map"){reset_race();return {};}
        if(type=="welcome")return apply(e.value("race",J(nullptr)),map,spectating,now_epoch_ms);
        if(type=="race"&&e.contains("race"))return apply(e.at("race"),map,spectating,now_epoch_ms);
        return {};
    }
    RoomModeAction map_loaded(const std::string &map,bool spectating,double now_epoch_ms) {
        if(race_&&pending_go_&&race_->at("state")=="live"&&race_->at("map")==map){pending_go_=false;went_=race_->at("id").get<std::string>();go_until_=now_epoch_ms+650;return restart(spectating);}
        return prepare(map,spectating);
    }
    bool frozen()const {return race_&&race_->at("state")=="countdown"&&race_->at("id")==prepared_;}
    bool has_race()const {return race_.has_value();}
    std::string notice(double now_epoch_ms)const {
        if(!race_)return {};
        const auto state=race_->at("state").get<std::string>(),opponent_name=opponent().at("name").get<std::string>();
        if(state=="challenge")return race_->at("you")=="b"?"Race challenge from "+opponent_name+" — open Room to accept or decline":"Challenge sent to "+opponent_name;
        if(state=="countdown") {const auto left=std::max(0.,std::ceil((local("goAt",now_epoch_ms)-now_epoch_ms)/1000));return "Race vs "+opponent_name+" · "+(left>0?std::to_string(int(std::min(left,999.))):"Waiting for GO");}
        if(state=="over") {
            if(now_epoch_ms>result_until_)return {};
            const auto winner=race_->value("winner",J(nullptr));
            const auto outcome=race_->value("outcome",std::string());
            const auto verdict=winner==race_->at("you")?"You won":winner.is_string()?opponent_name+" won":outcome=="draw"?"Draw":outcome=="timeout"?"Nobody finished":"Race over";
            const auto &me=race_->at(race_->at("you")=="a"?"a":"b");return verdict+" · you "+side_time(me)+" · "+opponent_name+" "+side_time(opponent());
        }
        if(now_epoch_ms<go_until_)return "GO — race vs "+opponent_name;
        if(state=="settling")return "Race vs "+opponent_name+" · checking server results";
        const double deadline=local("endsAt",INFINITY);
        if(now_epoch_ms>=deadline)return "Race vs "+opponent_name+" · waiting for server result";
        return "Race vs "+opponent_name+" · "+time(std::max(0.,(now_epoch_ms-local("goAt",now_epoch_ms))/1000));
    }
};
}
