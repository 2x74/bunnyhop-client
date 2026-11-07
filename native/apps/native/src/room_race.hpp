#pragma once
#include "room_mode_action.hpp"
#include "hud_scoreboard.hpp"
#include "room_styles.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <optional>
#include <string>

namespace native {
struct RoomRaceDisplay {
    bool visible = false, countdown = false, entered = false, joining = false, live = false;
    double go_at = 0, join_until = 0, until = 0, go_until = 0, finish_until = 0;
    unsigned place = 0;
    HudLabel<256> line;
};

// The menu transports views; the host owns the hold, reset and GO effects, even
// when its page is hidden. No local deadline can release a racer.
class RoomRaceModes {
    using J = nlohmann::json;
    std::optional<J> race_;
    std::string prepared_, went_;
    bool pending_go_ = false, frozen_ = false, participating_ = false;
    bool over_ = false;
    double offset_ = 0, result_until_ = 0, go_until_ = 0, finish_until_ = 0;
    int last_second_ = -1;
    RoomRaceDisplay display_;
    static constexpr double result_ms = 8000;
    static constexpr double go_ms = 650;

    static bool number(const J &j) { return j.is_number() && std::isfinite(j.get<double>()) && j.get<double>() >= 0; }

    static bool integer(const J &j, int low, int high) {
        return j.is_number_integer() && j.get<int64_t>() >= low && j.get<int64_t>() <= high;
    }

    static bool valid_racer(const J &p) {
        if (!p.is_object() || !p.contains("name") || !p["name"].is_string()
            || p["name"].get_ref<const std::string &>().size() > 512)
            return false;
        for (const char *key : {"slot", "place", "dnf", "finish", "checking"})
            if (!p.contains(key)) return false;
        return (p["slot"].is_null() || integer(p["slot"], 0, 255))
               && (p["place"].is_null() || integer(p["place"], 1, 64))
               && (p["dnf"].is_null() || p["dnf"] == "forfeit" || p["dnf"] == "left" || p["dnf"] == "timeout")
               && p["checking"].is_boolean()
               && (p["finish"].is_null()
                   || (p["finish"].is_object() && p["finish"].contains("time") && number(p["finish"]["time"])
                       && p["finish"].contains("real") && number(p["finish"]["real"])));
    }

    static bool valid(const J &r) {
        if (!r.is_object()) return false;
        for (const char *key : {"id", "state", "map", "style"})
            if (!r.contains(key) || !r[key].is_string()) return false;
        const auto &id = r["id"].get_ref<const std::string &>();
        const auto state = r["state"].get<std::string>();
        if (id.size() != 10 || id.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789") != std::string::npos
            || (state != "joining" && state != "countdown" && state != "live" && state != "settling" && state != "over")
            || !wire_style_playable(r["style"].get<std::string>()) || !r.contains("track")
            || !integer(r["track"], 0, 64) || !r.contains("racers") || !r["racers"].is_array()
            || r["racers"].size() > 64 || !r.contains("you") || !integer(r["you"], -1, int(r["racers"].size()) - 1))
            return false;
        for (const char *key : {"joinUntil", "goAt", "endsAt"})
            if (!r.contains(key) || (!r[key].is_null() && !number(r[key]))) return false;
        if (!number(r["joinUntil"])) return false;
        return std::all_of(r["racers"].begin(), r["racers"].end(), valid_racer);
    }

    const J *me() const {
        if (!race_ || race_->at("you").get<int>() < 0) return nullptr;
        return &race_->at("racers").at(race_->at("you").get<size_t>());
    }

    bool eligible() const {
        const auto *p = me();
        return p && p->at("place").is_null() && p->at("finish").is_null() && p->at("dnf").is_null();
    }

    RoomModeAction restart(bool spectating, bool go) const {
        RoomModeAction action;
        action.restart = action.canonical_start = true;
        action.stop_spectating = spectating;
        action.track = race_->at("track").get<uint32_t>();
        if (!action.track) action.style = race_->at("style").get<std::string>();
        action.room_race_go = go;
        return action;
    }

    RoomModeAction prepare(const std::string &map, bool spectating) {
        if (!race_ || !eligible() || race_->at("map") != map) return {};
        const auto id = race_->at("id").get<std::string>();
        if (race_->at("state") == "live" && pending_go_ && went_ != id) {
            pending_go_ = false;
            prepared_ = went_ = id;
            return restart(spectating, true);
        }
        if (race_->at("state") == "countdown" && prepared_ != id) {
            prepared_ = id;
            return restart(spectating, false);
        }
        return {};
    }

    void render(double now) {
        display_ = {};
        if (!race_) return;
        const auto state = race_->at("state").get<std::string>();
        if (state == "over" && now > result_until_) return;
        display_.visible = true;
        display_.entered = me() != nullptr;
        display_.joining = state == "joining";
        display_.live = state == "live";
        display_.join_until = race_->at("joinUntil").get<double>() - offset_;
        display_.go_until = go_until_;
        display_.finish_until = finish_until_;
        display_.countdown = state == "countdown" && eligible();
        display_.until = state == "over" ? result_until_ : INFINITY;
        display_.go_at = race_->at("goAt").is_null() ? now : race_->at("goAt").get<double>() - offset_;
        const auto count = race_->at("racers").size();
        const auto style = wire_style_name(race_->at("style").get<std::string>());
        display_.line.format("Room race · %zu racers · %.*s", count, int(style.size()), style.data());
        if (state == "over") {
            display_.line.assign(
                    race_->value("outcome", std::string()) == "cancelled" ? "Room race cancelled" : "Room race over"
            );
        } else if (state == "settling") {
            display_.line.assign("Room race · checking server results");
        }
        if (const auto *p = me()) {
            if (!p->at("place").is_null()) {
                display_.place = p->at("place").get<unsigned>();
                display_.line.format("Room race · Place %u", display_.place);
            } else if (!p->at("dnf").is_null())
                display_.line.assign("Room race · DNF");
        }
    }

public:
    void clear() { *this = {}; }

    bool participating() const { return participating_; }

    bool frozen() const { return frozen_; }

    const RoomRaceDisplay &display() const { return display_; }

    RoomModeAction
    apply(const J &next, const std::string &map, bool spectating, double now, double offset, bool welcome = false) {
        if (next.is_null()) {
            clear();
            return {};
        }
        if (!valid(next)) return {};
        const bool same = race_ && race_->at("id") == next.at("id");
        const bool from_countdown = same && race_->at("state") == "countdown";
        const bool was_over = same && race_->at("state") == "over";
        const bool had_place = same && me() && !me()->at("place").is_null();
        if (!same) clear();
        race_ = next;
        offset_ = offset;
        RoomModeAction effects;
        effects.room_race_finish = me() && !me()->at("place").is_null() && !had_place;
        const auto state = next.at("state").get<std::string>();
        if (state == "over") {
            if (!was_over) result_until_ = now + result_ms;
            effects.room_race_over = me() && !was_over;
            pending_go_ = false;
        } else if (!eligible() || state != "live")
            pending_go_ = false;
        else if (state == "live") {
            // A welcome restores an attempt already in progress, even after a lost countdown socket.
            if (welcome) {
                pending_go_ = false;
                went_ = next.at("id").get<std::string>();
            } else if (from_countdown && went_ != next.at("id").get<std::string>())
                pending_go_ = true;
        }
        auto action = prepare(map, spectating);
        action.room_race_finish = effects.room_race_finish;
        action.room_race_over = effects.room_race_over;
        if (action.room_race_go) go_until_ = now + go_ms;
        if (action.room_race_finish) finish_until_ = now + result_ms;
        participating_ = race_ && eligible() && race_->at("state") != "over";
        frozen_ = participating_ && (race_->at("state") == "countdown" || pending_go_);
        over_ = race_ && race_->at("state") == "over";
        render(now);
        return action;
    }

    RoomModeAction map_loaded(const std::string &map, bool spectating, double now) {
        auto action = prepare(map, spectating);
        if (action.room_race_go) go_until_ = now + go_ms;
        participating_ = race_ && eligible() && race_->at("state") != "over";
        frozen_ = participating_ && (race_->at("state") == "countdown" || pending_go_);
        over_ = race_ && race_->at("state") == "over";
        render(now);
        return action;
    }

    // Returns a countdown cue only once per nonzero numeral. Runs on the host frame clock.
    bool refresh(double now) {
        if (over_ && now > result_until_) clear();
        if (!display_.countdown) return false;
        const int seconds = int(std::clamp(std::ceil((display_.go_at - now) / 1000), 0., 999.));
        if (seconds == last_second_) return false;
        last_second_ = seconds;
        return seconds > 0 && seconds <= 3;
    }
};

template <class Hud>
void draw_room_race(Hud &hud, int width, int height, float percent, const RoomRaceDisplay &race, double now) {
    if (!race.visible || now > race.until) return;
    const HudGeometry geometry(width, height, percent);
    const float x = geometry.width / 2;
    constexpr NameColor gold = {1, .71f, .24f, 1};
    hud.overlay_begin(width, height, percent);
    HudLabel<320> line;
    line.assign(race.line.view());
    if (race.joining) {
        const int seconds = int(std::clamp(std::ceil((race.join_until - now) / 1000), 0., 999.));
        line.format(
                "%.*s · %s · %d s",
                int(race.line.view().size()),
                race.line.view().data(),
                race.entered ? "Joined" : "!join",
                seconds
        );
    } else if (race.live && !race.place) {
        line.format(
                "%.*s · %s %.1fs",
                int(race.line.view().size()),
                race.line.view().data(),
                now < race.go_until ? "GO" : "Race clock",
                std::max(0., (now - race.go_at) / 1000)
        );
    }
    hud.overlay_text(x, geometry.height * .09f, line.view(), 17, gold, true);
    if (race.countdown) {
        HudLabel<64> label;
        const int seconds = int(std::clamp(std::ceil((race.go_at - now) / 1000), 0., 99.));
        if (seconds)
            label.format("%d", seconds);
        else
            label.assign("Waiting for GO");
        hud.overlay_text(x, geometry.height * .4f, label.view(), 55, gold, true);
    }
    hud.overlay_end(width, height);
}
}  // namespace native
