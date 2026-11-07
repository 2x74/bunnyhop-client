#pragma once
#include "room_mode_action.hpp"
#include "hud_scoreboard.hpp"
#include "room_styles.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>
#include <optional>
#include <string>

namespace native {
struct RoomRaceRow {
    HudLabel<16> place;
    HudLabel<128> name;
    HudLabel<48> time;
    bool top = false, me = false;
};

// What a racer sees (web net/race.ts, research/ROOM-RACE.md "What racers see"). Observers see nothing: they read chat.
struct RoomRaceDisplay {
    bool visible = false, countdown = false, entered = false, joining = false, live = false, over = false;
    double go_at = 0, join_until = 0, until = 0, go_until = 0, finish_until = 0, over_at = 0;
    unsigned place = 0;
    size_t racers = 0, finished = 0;
    // Settling, or no GO time yet: the clock reads "checking".
    bool checking = false;
    // The countdown banner's second line: "2 racers, Bonus 1".
    HudLabel<96> board;
    // Your place as it came in ("2nd") and your race time under it; the live line says them too.
    HudLabel<16> place_label;
    HudLabel<48> place_time;
    // The live line's own part when you have no place: "forfeited", "left", "time limit" or "checking".
    HudLabel<32> mine;
    // The standings: place order, DNFs last, four rows and yours.
    std::array<RoomRaceRow, 5> rows;
    size_t row_count = 0;
    HudLabel<64> verdict;
    bool won = false;
};

inline void race_ordinal(HudLabel<16> &out, unsigned n) {
    const unsigned tens = n % 100, ones = n % 10;
    const char *suffix = tens >= 11 && tens <= 13 ? "th"
                         : ones == 1              ? "st"
                         : ones == 2              ? "nd"
                         : ones == 3              ? "rd"
                                                  : "th";
    out.format("%u%s", n, suffix);
}

inline std::string_view race_dnf_text(std::string_view dnf) {
    return dnf == "forfeit" ? "forfeited" : dnf == "left" ? "left" : "time limit";
}

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
        const auto *mine = me();
        if (!race_ || !mine) return;
        const auto state = race_->at("state").get<std::string>();
        if (state == "over" && now > result_until_) return;
        const auto &racers = race_->at("racers");
        display_.visible = display_.entered = true;
        display_.joining = state == "joining";
        display_.live = state == "live" || state == "settling";
        display_.over = state == "over";
        display_.checking = state == "settling" || race_->at("goAt").is_null();
        display_.join_until = race_->at("joinUntil").get<double>() - offset_;
        display_.go_until = go_until_;
        display_.finish_until = finish_until_;
        display_.countdown = state == "countdown" && eligible();
        display_.until = display_.over ? result_until_ : INFINITY;
        display_.over_at = display_.over ? result_until_ - result_ms : 0;
        display_.go_at = race_->at("goAt").is_null() ? now : race_->at("goAt").get<double>() - offset_;
        display_.racers = racers.size();
        display_.finished = size_t(std::count_if(racers.begin(), racers.end(), [](const J &p) {
            return !p.at("place").is_null();
        }));
        const auto track = race_->at("track").get<unsigned>();
        HudLabel<48> what;
        if (track)
            what.format("Bonus %u", track);
        else
            what.assign(wire_style_name(race_->at("style").get<std::string>()));
        display_.board.format(
                "%zu %s, %s", display_.racers, display_.racers == 1 ? "racer" : "racers", what.bytes.data()
        );
        if (!mine->at("place").is_null()) {
            display_.place = mine->at("place").get<unsigned>();
            race_ordinal(display_.place_label, display_.place);
            if (!mine->at("finish").is_null())
                format_hud_time(display_.place_time, mine->at("finish").at("real").get<double>());
        } else if (!mine->at("dnf").is_null())
            display_.mine.assign(race_dnf_text(mine->at("dnf").get<std::string>()));
        else if (mine->at("checking").get<bool>())
            display_.mine.assign("checking");
        if (display_.over) standings();
    }

    void standings() {
        const auto &racers = race_->at("racers");
        const size_t you = race_->at("you").get<size_t>();
        std::vector<size_t> order(racers.size());
        for (size_t i = 0; i < order.size(); ++i)
            order[i] = i;
        const auto place = [&](size_t i) {
            const auto &p = racers[i].at("place");
            return p.is_null() ? std::numeric_limits<unsigned>::max() : p.get<unsigned>();
        };
        std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return place(a) < place(b); });
        constexpr size_t shown_rows = 4;
        std::vector<size_t> shown(order.begin(), order.begin() + std::min(shown_rows, order.size()));
        if (std::find(shown.begin(), shown.end(), you) == shown.end()) shown.push_back(you);
        for (size_t k = 0; k < shown.size(); ++k) {
            const auto &p = racers[shown[k]];
            auto &row = display_.rows[display_.row_count++];
            row.me = shown[k] == you;
            row.top = k == 0 && !p.at("place").is_null();
            if (!p.at("place").is_null())
                race_ordinal(row.place, p.at("place").get<unsigned>());
            else
                row.place.assign(p.at("dnf").is_null() ? "\xE2\x80\x94" : "DNF");
            row.name.assign(row.me ? "you" : p.at("name").get_ref<const std::string &>());
            if (!p.at("finish").is_null())
                format_hud_time(row.time, p.at("finish").at("real").get<double>());
            else
                row.time.assign(p.at("dnf").is_null() ? "no finish" : race_dnf_text(p.at("dnf").get<std::string>()));
        }
        display_.won = display_.place == 1;
        if (display_.place) {
            if (display_.won)
                display_.verdict.assign("You won");
            else
                display_.verdict.format("%s of %zu", display_.place_label.bytes.data(), display_.racers);
        } else if (race_->value("outcome", std::string()) == "cancelled")
            display_.verdict.assign("Race cancelled");
        else if (!display_.finished)
            display_.verdict.assign("Nobody finished");
        else
            display_.verdict.assign("You didn't finish");
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
        if (action.room_race_finish && state != "over") finish_until_ = now + result_ms;
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

// What the room race's drawing shares the screen with (hud_frame.cpp).
struct RoomRaceStack {
    bool reduced_motion = false;
    // The countdown banner takes the map-change line's place; it stays away while the map is changing.
    bool banner = true;
    // The run's end card's bottom edge while it's up (HUD units, 0: none): your place goes under it.
    float endcard_bottom = 0;
};

namespace room_race_look {
inline constexpr NameColor cream = {.94f, .91f, .87f, 1};
inline constexpr NameColor dim = {.72f, .69f, .64f, 1};
inline constexpr NameColor white = {1, 1, 1, 1};
inline constexpr NameColor quiet = {1, 1, 1, .7f};
inline constexpr NameColor amber = {1, .71f, .24f, 1};
inline constexpr NameColor gain = {.3f, 1, .53f, 1};
// The HUD font's baseline and cap height, per unit of text size (hud.hpp atlas metrics, JetBrains Mono).
inline constexpr float baseline = 1.3f * 42 / 52;
inline constexpr float cap = .73f;
// Line: top of the screen, as web's #mp-race. Standings: just under it.
inline constexpr float line_top = .032f, result_top = .04f;
inline constexpr float line_size = 16, clock_size = 20, row_size = 16, time_size = 24, top_time_size = 36;
inline constexpr float verdict_size = 19, numeral_size = 88, place_size = 68, place_time_size = 19;
inline constexpr double stamp_ms = 300, go_ms = 650, calm_go_ms = 500, place_ms = 2400, place_out_ms = 400;
inline constexpr double row_step_ms = 120, verdict_ms = 460;

inline NameColor alpha(NameColor color, float a) {
    color[3] *= std::clamp(a, 0.f, 1.f);
    return color;
}

inline float ease_out(float p, float power = 3) {
    return 1 - std::pow(1 - std::clamp(p, 0.f, 1.f), power);
}

struct Pose {
    float scale = 1, alpha = 1;
};

// Countdown numerals and your place stamp in: 1.6x to .96x to 1, opaque from 60% (web showCount / showPlace).
inline Pose stamp_in(double age_ms, bool calm) {
    if (age_ms < 0) return {1, 0};
    if (calm) return {};
    const float e = ease_out(float(age_ms / stamp_ms), 4);
    if (e < .6f) return {1.6f + (.96f - 1.6f) * e / .6f, e / .6f};
    return {.96f + .04f * (e - .6f) / .4f, 1};
}

// GO: 1.5x in to 1x at 30%, then out to 1.4x while it fades. Reduced motion: it only fades in and out.
inline Pose go_out(double age_ms, bool calm) {
    const float p = float(age_ms / (calm ? calm_go_ms : go_ms));
    if (p < 0 || p >= 1) return {1, 0};
    const float e = ease_out(p, 2);
    const float a = e < .3f ? e / .3f : 1 - (e - .3f) / .7f;
    if (calm) return {1, a};
    return {e < .3f ? 1.5f - .5f * e / .3f : 1 + .4f * (e - .3f) / .7f, a};
}

// Text scaled about its cap middle, which sits at `middle`.
template <class Hud>
void posed_text(Hud &hud, float x, float middle, std::string_view text, float size, NameColor color, Pose pose) {
    if (pose.alpha <= 0) return;
    const float shown = size * pose.scale;
    hud.overlay_fade(pose.alpha);
    hud.overlay_text(x, middle + shown * (cap / 2 - baseline), text, shown, alpha(color, pose.alpha), true);
    hud.overlay_fade(1);
}

struct Piece {
    std::string_view text;
    float size;
    NameColor color;
    // Space before it, in HUD units.
    float gap = 0;
};

// One line of pieces on a shared baseline, centred on x.
template <class Hud, size_t N>
void pieces(Hud &hud, float x, float base, const std::array<Piece, N> &line, size_t count) {
    float width = 0;
    for (size_t i = 0; i < count; ++i)
        width += line[i].gap + hud.overlay_text_width(line[i].text, line[i].size);
    float left = x - width / 2;
    for (size_t i = 0; i < count; ++i) {
        left += line[i].gap;
        hud.overlay_text(left, base - line[i].size * baseline, line[i].text, line[i].size, line[i].color);
        left += hud.overlay_text_width(line[i].text, line[i].size);
    }
}

// The standings' rows: each row's height is its time's size (the winner's is bigger).
inline float row_size_of(const RoomRaceRow &row) {
    return row.top ? top_time_size : time_size;
}
}  // namespace room_race_look

// Where the standings end (HUD units), so the end card and notices can sit under them. 0 while they're not up.
inline float room_race_result_bottom(const RoomRaceDisplay &race, float screen_height, double now) {
    using namespace room_race_look;
    if (!race.visible || !race.over || now > race.until || !race.row_count) return 0;
    float base = screen_height * result_top;
    for (size_t k = 0; k < race.row_count; ++k)
        base += (k ? 1.1f : cap) * row_size_of(race.rows[k]);
    return base + 4 + verdict_size * 1.2f + verdict_size * (1.3f - baseline) + 6;
}

template <class Hud>
void draw_room_race(
        Hud &hud,
        int width,
        int height,
        float percent,
        const RoomRaceDisplay &race,
        double now,
        const RoomRaceStack &stack = {}
) {
    using namespace room_race_look;
    if (!race.visible || now > race.until) return;
    const HudGeometry geometry(width, height, percent);
    const float x = geometry.width / 2, middle = geometry.height / 2;
    const bool calm = stack.reduced_motion;
    hud.overlay_begin(width, height, percent);
    HudLabel<48> clock, left;
    std::array<Piece, 7> line{};
    size_t count = 0;
    const float gap = line_size * 1.2f;
    const float line_base = geometry.height * line_top + clock_size * baseline;
    if (race.joining) {
        const int seconds = int(std::clamp(std::ceil((race.join_until - now) / 1000), 0., 999.));
        left.format("%d s", seconds);
        clock.format("%zu %s", race.racers, race.racers == 1 ? "racer" : "racers");
        line[count++] = {"Room race", line_size, cream};
        line[count++] = {clock.view(), line_size, cream, gap};
        line[count++] = {"starts in ", line_size, dim, gap};
        line[count++] = {left.view(), line_size, cream};
        pieces(hud, x, line_base, line, count);
    } else if (race.live) {
        if (race.checking)
            clock.assign("checking");
        else {
            // Tenths, as the website's race clock.
            format_hud_time(clock, std::max(0., (now - race.go_at) / 1000));
            clock.bytes[std::max<size_t>(clock.view().size(), 2) - 2] = '\0';
        }
        left.format("%zu of %zu finished", race.finished, race.racers);
        line[count++] = {"Room race", line_size, cream};
        line[count++] = {clock.view(), clock_size, cream, gap};
        if (race.place) {
            line[count++] = {"you ", line_size, dim, gap};
            line[count++] = {race.place_label.view(), line_size, cream};
            if (!race.place_time.empty()) line[count++] = {race.place_time.view(), line_size, cream, line_size * .6f};
        } else if (!race.mine.empty()) {
            line[count++] = {"you ", line_size, dim, gap};
            line[count++] = {race.mine.view(), line_size, cream};
        }
        line[count++] = {left.view(), line_size, dim, gap};
        pieces(hud, x, line_base, line, count);
    }
    // The numerals at crosshair height: 3, 2, 1 stamp in; "1" holds until the room's GO.
    const float numeral_middle = middle - 30 - numeral_size * cap / 2;
    if (race.countdown) {
        if (stack.banner) {
            hud.overlay_text(x, 58, "Room race", 16, amber, true);
            hud.overlay_text(x, 80, race.board.view(), 13, dim, true);
        }
        const int seconds = int(std::clamp(std::ceil((race.go_at - now) / 1000), 1., 99.));
        HudLabel<8> numeral;
        numeral.format("%d", seconds);
        const double since = now - (race.go_at - seconds * 1000.);
        posed_text(hud, x, numeral_middle, numeral.view(), numeral_size, white, stamp_in(since, calm));
    } else if (race.go_until > 0 && now < race.go_until) {
        posed_text(hud, x, numeral_middle, "GO", numeral_size, amber, go_out(now - (race.go_until - go_ms), calm));
    }
    // Your place, just above the crosshair (or under your run's end card), for 2.4 s; the standings take over.
    if (race.place && race.finish_until > 0) {
        const double age = now - (race.finish_until - 8000);
        Pose pose = calm ? Pose{1, float(std::clamp(age / 160, 0., 1.))} : stamp_in(age, false);
        float lift = 0;
        if (age > place_ms) {
            const float out = float((age - place_ms) / place_out_ms);
            pose.alpha *= 1 - std::clamp(out, 0.f, 1.f);
            if (!calm) lift = 12 * ease_out(out, 2);
        }
        if (race.over) pose.alpha *= 1 - std::clamp(float((now - race.over_at) / 150), 0.f, 1.f);
        if (pose.alpha > 0) {
            const float top = std::max(middle - 136, stack.endcard_bottom > 0 ? stack.endcard_bottom + 16 : 0.f) - lift;
            const float place_middle = top + place_size * cap / 2;
            posed_text(hud, x, place_middle, race.place_label.view(), place_size, race.place == 1 ? gain : white, pose);
            if (!race.place_time.empty()) {
                const float time_top = top + place_size * cap + 14;
                posed_text(
                        hud,
                        x,
                        time_top + place_time_size * cap / 2,
                        race.place_time.view(),
                        place_time_size,
                        white,
                        {pose.scale, pose.alpha}
                );
            }
        }
    }
    // The standings: place, name and time columns, the winner's time big on top, yours in white; one line under.
    if (race.over && race.row_count) {
        float place_width = 0, name_width = 0, time_width = 0;
        for (size_t k = 0; k < race.row_count; ++k) {
            const auto &row = race.rows[k];
            place_width = std::max(place_width, hud.overlay_text_width(row.place.view(), row_size));
            name_width = std::max(name_width, hud.overlay_text_width(row.name.view(), row_size));
            time_width = std::max(time_width, hud.overlay_text_width(row.time.view(), row_size_of(row)));
        }
        const float column_gap = row_size * .7f;
        const float total = place_width + name_width + time_width + 2 * column_gap;
        const float left_edge = x - total / 2;
        const double age = now - race.over_at;
        float base = geometry.height * result_top;
        for (size_t k = 0; k < race.row_count; ++k) {
            const auto &row = race.rows[k];
            const float size = row_size_of(row);
            base += (k ? 1.1f : cap) * size;
            const double since = age - double(k) * row_step_ms;
            const float a = calm ? 1 : float(std::clamp(since / 160, 0., 1.));
            if (a <= 0) continue;
            const float drop = calm ? 0 : -10 * (1 - ease_out(float(since / 350), 3));
            hud.overlay_fade(a);
            const NameColor ink = row.top || row.me ? white : quiet;
            const NameColor time_ink = row.top && race.won ? gain : ink;
            const float y = base + drop;
            hud.overlay_text(
                    left_edge + place_width - hud.overlay_text_width(row.place.view(), row_size),
                    y - row_size * baseline,
                    row.place.view(),
                    row_size,
                    alpha(ink, a)
            );
            hud.overlay_text(
                    left_edge + place_width + column_gap,
                    y - row_size * baseline,
                    row.name.view(),
                    row_size,
                    alpha(ink, a)
            );
            hud.overlay_text(
                    left_edge + total - hud.overlay_text_width(row.time.view(), size),
                    y - size * baseline,
                    row.time.view(),
                    size,
                    alpha(time_ink, a)
            );
            hud.overlay_fade(1);
        }
        const double verdict_age = age - double(race.row_count) * row_step_ms - 160;
        Pose pose{1, 1};
        if (!calm) {
            // web notify stamp(): 1.7x to .94x at 40%, 1.02x at 70%, then 1.
            const float e = ease_out(float(verdict_age / verdict_ms), 4);
            pose = verdict_age < 0 ? Pose{1, 0}
                   : e < .4f       ? Pose{1.7f - .76f * e / .4f, e / .4f}
                   : e < .7f       ? Pose{.94f + .08f * (e - .4f) / .3f, 1}
                                   : Pose{1.02f - .02f * (e - .7f) / .3f, 1};
        }
        const float verdict_base = base + 4 + verdict_size * 1.2f;
        posed_text(
                hud,
                x,
                verdict_base - verdict_size * cap / 2,
                race.verdict.view(),
                verdict_size,
                race.won ? gain : white,
                pose
        );
    }
    hud.overlay_end(width, height);
}
}  // namespace native
