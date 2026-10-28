#pragma once
#include <nlohmann/json.hpp>
#include "hud_scoreboard.hpp"
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
struct RaceDisplay {
    enum class State { none, challenge, countdown, live, settling, over };
    State state = State::none;
    HudLabel<128> opponent;
    HudLabel<96> board;
    HudLabel<128> result;
    HudLabel<128> first_time;
    HudLabel<128> second_time;
    double deadline = 0;
    double go_at = 0;
    double result_until = 0;
    bool recipient = false;
};

template <class Hud>
void draw_race(Hud &hud, int width, int height, float percent, const RaceDisplay &race, double now) {
    using State = RaceDisplay::State;
    if (race.state == State::none || (race.state == State::over && now > race.result_until))
        return;
    const HudGeometry geometry(width, height, percent);
    const float x = geometry.width / 2;
    float y = geometry.height * .09f;
    const NameColor cream = {.94f, .91f, .86f, 1};
    const NameColor gold = {1, .71f, .24f, 1};
    hud.overlay_begin(width, height, percent);
    HudLabel<256> label;
    if (race.state == State::countdown) {
        const int left = int(std::clamp(std::ceil((race.go_at - now) / 1000), 0., 99.));
        label.format(left > 0 ? "%d" : "Waiting for GO", left);
        hud.overlay_text(x, geometry.height * .4f, label.view(), 55, gold, true);
    }
    hud.overlay_rect(x - 250, y - 10, 500, race.state == State::over ? 146 : 87, {.025f, .027f, .04f, .92f});
    label.format("Race vs %.*s", int(race.opponent.view().size()), race.opponent.view().data());
    hud.overlay_text(x, y, label.view(), 17, cream, true);
    hud.overlay_text(x, y + 27, race.board.view(), 13, gold, true);
    if (race.state == State::challenge) {
        const int left = int(std::clamp(std::ceil((race.deadline - now) / 1000), 0., 999.));
        label.format(race.recipient ? "1 Accept   2 Decline | %ds" : "Challenge sent | %ds", left);
    } else if (race.state == State::over) {
        hud.overlay_text(x, y + 51, race.first_time.view(), 13, cream, true);
        hud.overlay_text(x, y + 77, race.second_time.view(), 13, cream, true);
        label.assign(race.result.view());
        y += 52;
    } else if (race.state == State::settling) {
        label.assign("Checking server results");
    } else {
        const double elapsed = std::max(0., (now - race.go_at) / 1000);
        label.format("%s %.1fs", now < race.go_at + 650 && race.state == State::live ? "GO" : "Race clock", elapsed);
    }
    hud.overlay_text(x, y + 53, label.view(), 13, gold, true);
    hud.overlay_end(width, height);
}

inline bool race_menu_command(std::string_view text) {
    return text == "!race" || text == "/race";
}

class RacePicker {
  public:
    enum class Step { closed, player, track, style };
    Step step = Step::closed;
    std::array<unsigned, 256> slots{};
    std::array<HudLabel<128>, 256> names;
    size_t count = 0;
    size_t page = 0;
    unsigned opponent = 256;
    std::array<unsigned, 65> tracks{};
    size_t track_count = 0;
    unsigned track = 0;
    HudLabel<128> command;

    template <class Zones> void open(const HudScoreboard &board, const Zones &zones) {
        *this = {};
        for (size_t i = 0; i < board.count; ++i) {
            const auto &row = board.rows[i];
            if (row.you || row.spectator)
                continue;
            slots[count] = row.slot;
            names[count++].assign(row.name);
        }
        tracks[track_count++] = 0;
        for (const auto &zone : zones) {
            if (zone.kind != 0 || !zone.track || track_count == tracks.size())
                continue;
            if (std::find(tracks.begin(), tracks.begin() + track_count, zone.track) == tracks.begin() + track_count)
                tracks[track_count++] = zone.track;
        }
        step = count ? Step::player : Step::closed;
    }
    bool key(std::string_view code, bool down, bool repeat) {
        if (step == Step::closed || !down || repeat || code.size() != 6 || !code.starts_with("Digit"))
            return false;
        const unsigned pick = unsigned(code.back() - '0');
        if (!pick) {
            step = Step::closed;
            return true;
        }
        const size_t available = step == Step::player ? count : step == Step::track ? track_count : 8;
        if (pick == 9 && available > 8) {
            page = (page + 1) % ((available + 7) / 8);
            return true;
        }
        const size_t index = page * 8 + pick - 1;
        if (index >= available || pick > 8)
            return true;
        if (step == Step::player) {
            opponent = slots[index];
            step = track_count > 1 ? Step::track : Step::style;
            page = 0;
        } else if (step == Step::track) {
            track = tracks[index];
            step = Step::style;
            page = 0;
            if (track) {
                command.format("/race #%u autohop %u", opponent, track);
                step = Step::closed;
            }
        } else {
            constexpr std::array<const char *, 8> styles = {"autohop", "legit",      "wonly",  "sideways",
                                                            "hsw",     "autostrafe", "scroll", "lowgrav"};
            command.format("/race #%u %s %u", opponent, styles[index], track);
            step = Step::closed;
        }
        return true;
    }
};

template <class Hud> void draw_race_picker(Hud &hud, int width, int height, float percent, const RacePicker &picker) {
    using Step = RacePicker::Step;
    if (picker.step == Step::closed)
        return;
    const HudGeometry geometry(width, height, percent);
    const float x = geometry.width / 2 - 220;
    const float y = geometry.height / 2 - 190;
    hud.overlay_begin(width, height, percent);
    hud.overlay_rect(x, y, 440, 380, {.025f, .027f, .04f, .96f});
    hud.overlay_text(x + 18, y + 16,
                     picker.step == Step::player  ? "Race a player"
                     : picker.step == Step::track ? "Choose a track"
                                                  : "Choose a style",
                     20, {1, .71f, .24f, 1});
    const size_t count = picker.step == Step::player  ? picker.count
                         : picker.step == Step::track ? picker.track_count
                                                      : 8;
    constexpr std::array<std::string_view, 8> styles = {"Autohop",       "EZ Scroll",   "W-only",       "Sideways",
                                                        "Half-sideways", "Auto-strafe", "Legit Scroll", "Low gravity"};
    HudLabel<160> label;
    for (size_t i = picker.page * 8; i < std::min(count, picker.page * 8 + 8); ++i) {
        if (picker.step == Step::player)
            label.format("%zu. %.*s", i % 8 + 1, int(picker.names[i].view().size()), picker.names[i].view().data());
        else if (picker.step == Step::track)
            label.format(picker.tracks[i] ? "%zu. Bonus %u" : "%zu. Main track", i % 8 + 1, picker.tracks[i]);
        else
            label.format("%zu. %.*s", i + 1, int(styles[i].size()), styles[i].data());
        hud.overlay_text(x + 18, y + 62 + float(i % 8) * 30, label.view(), 14, {.94f, .91f, .86f, 1});
    }
    hud.overlay_text(x + 18, y + 337, count > 8 ? "9. Next page   0. Cancel" : "0. Cancel", 12, {.64f, .66f, .7f, 1});
    hud.overlay_end(width, height);
}

class RoomModes {
    using J=nlohmann::json;
    uint64_t generation_=0;
    std::string room_,prepared_,went_;
    std::optional<J> race_;
    bool closed_=false,pending_go_=false;
    RaceDisplay display_;
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
        refresh_display(now);
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
    void refresh_display(double now) {
        const auto state = race_->at("state").get<std::string>();
        using State = RaceDisplay::State;
        display_.state = state == "challenge"   ? State::challenge
                         : state == "countdown" ? State::countdown
                         : state == "live"      ? State::live
                         : state == "settling"  ? State::settling
                                                : State::over;
        display_.opponent.assign(opponent().at("name").get<std::string>());
        display_.board.assign(race_->at("style").get<std::string>());
        if (race_->at("track").get<unsigned>())
            display_.board.format("Bonus %u", race_->at("track").get<unsigned>());
        display_.recipient = race_->at("you") == "b";
        display_.deadline = local("expiresAt", now);
        display_.go_at = local("goAt", now);
        display_.result_until = now + 8000;
        if (display_.state == State::over) {
            const auto &me = race_->at(race_->at("you") == "a" ? "a" : "b");
            display_.first_time.assign("You | " + side_time(me));
            display_.second_time.assign(opponent().at("name").get<std::string>() + " | " + side_time(opponent()));
            const auto winner = race_->value("winner", J(nullptr));
            display_.result.assign(winner == race_->at("you")                         ? "You won"
                                   : winner.is_string()                               ? "Opponent won"
                                   : race_->value("outcome", std::string()) == "draw" ? "Draw"
                                                                                      : "Race over");
        }
    }
    void reset_race() {
        display_ = {};
        race_.reset();
        prepared_.clear();
        went_.clear();
        pending_go_ = false;
        result_until_ = go_until_ = 0;
    }

public:
  const RaceDisplay &display() const {
      return display_;
  }
  bool challenge_key(std::string_view code, bool down, bool repeat) const {
      return down && !repeat && display_.state == RaceDisplay::State::challenge && display_.recipient &&
             (code == "Digit1" || code == "Digit2");
  }
    // Preserve the highest observed room generation when the host leaves a map.
    void close(uint64_t generation){generation_=std::max(generation_,generation);reset_race();room_.clear();closed_=true;clock_offset_=0;}
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
template <class Script, class Menu>
bool handle_race_key(std::string_view code, bool down, bool repeat, const RoomModes &modes, RacePicker &picker,
                     Script &script, Menu *menu, bool ready) {
    if (modes.challenge_key(code, down, repeat)) {
        script.open(menu, ready,
                    code == "Digit1" ? "window.bunnyhopNativeMenu?.onRoomCommand?.({t:'chat',text:'/accept'})"
                                     : "window.bunnyhopNativeMenu?.onRoomCommand?.({t:'chat',text:'/decline'})");
        return true;
    }
    if (!picker.key(code, down, repeat))
        return false;
    if (!picker.command.empty()) {
        script.open(menu, ready,
                    "window.bunnyhopNativeMenu?.onRoomCommand?.(" +
                        nlohmann::json({{"t", "chat"}, {"text", std::string(picker.command.view())}}).dump() + ")");
        picker.command.assign("");
    }
    return true;
}
}
