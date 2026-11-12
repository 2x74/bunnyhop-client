#pragma once
#include <nlohmann/json.hpp>
#include "hud_scoreboard.hpp"
#include "menu_rows.hpp"
#include "room_styles.hpp"
#include "room_mode_action.hpp"
#include "room_race.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <optional>
#include <set>
#include <sstream>
#include <string>

namespace native {
// Native counterpart of web net/race.ts. All outcomes and transitions come from
// the existing room protocol. Deadlines are display-only: local time never
// starts a race, chooses a winner, or releases the countdown's movement hold.
struct RaceDisplay {
    enum class State { none, challenge, countdown, live, settling, over };
    State state = State::none;
    HudLabel<128> opponent;
    HudLabel<128> map;
    HudLabel<96> board;
    // The verdict under the result: "You won", "keyuu won", "Draw", "Nobody finished", "Race over".
    HudLabel<128> result;
    // The live line's finishes: yours ("00:05.402 (checking)") and theirs (a finish, "forfeited" or "left"). Empty
    // while running; theirs is then the opponent's live timer (hud_frame.cpp).
    HudLabel<64> mine, theirs;
    std::optional<unsigned> opponent_slot;
    // The result: both times stacked, the leader's on top.
    HudLabel<128> top_name, second_name;
    HudLabel<48> top_time, second_time;
    bool won = false;
    double deadline = 0;
    double go_at = 0;
    double result_until = 0;
    bool recipient = false;
    // The race's style is one this build only shows (room_styles.hpp): it can be declined, not accepted.
    bool playable = true;
};

namespace race_look {
inline constexpr double result_ms = 8000, second_row_ms = 200, verdict_delay_ms = 360;
inline constexpr float row_size = 16, top_time_size = 36, time_size = 24, verdict_size = 19;

inline float row_size_of(bool top) {
    return top ? top_time_size : time_size;
}
}  // namespace race_look

// Where a duel's result ends (HUD units), so the end card and notices sit under it. 0 while it's not up.
inline float race_result_bottom(const RaceDisplay &race, float screen_height, double now) {
    using namespace room_race_look;
    if (race.state != RaceDisplay::State::over || now > race.result_until) return 0;
    const float base = screen_height * result_top + cap * race_look::top_time_size + 1.1f * race_look::time_size;
    return base + 4 + race_look::verdict_size * 1.2f + race_look::verdict_size * (1.3f - baseline) + 6;
}

// The opponent's running timer for the race line (tenths, as the website's), "start zone" before they leave it, or
// nothing once their finish (or exit) is in the race itself. `now`: the room's sample clock (steady seconds).
// (`Run` is BhRunState; this header stays free of the core's C API.)
template <class Run, class Room>
HudLabel<48> race_opponent_live(const Room &room, const RaceDisplay &race, double now, double epoch_ms) {
    HudLabel<48> out;
    if (race.state != RaceDisplay::State::live || !race.theirs.empty() || !race.opponent_slot) return out;
    Run run{};
    std::string style;
    room.spectator_run(run, style, *race.opponent_slot, now, epoch_ms);
    if (run.status == 1 || run.status == 2) {
        format_hud_time(out, run.seconds);
        out.bytes[std::max<size_t>(out.view().size(), 2) - 2] = '\0';
    } else if (run.in_start)
        out.assign("start zone");
    return out;
}

// The challenge to you: a numbered menu like Spectate's (1 Accept, 2 Decline; the keys are RoomModes::challenge_key).
template <class Hud>
void draw_race_challenge(Hud &hud, const HudGeometry &geometry, const RaceDisplay &race, double now) {
    constexpr NameColor cream = {.94f, .91f, .86f, 1}, dim = {.63f, .65f, .70f, 1}, amber = {1, .71f, .24f, 1};
    constexpr float panel_width = 440, first_row = 52, row_height = 28, footer_height = 30, inset = 18;
    const float height = first_row + 2 * row_height + footer_height;
    const float left = geometry.width / 2 - panel_width / 2, top = geometry.height / 2 - height / 2;
    hud.overlay_rect(left, top, panel_width, height, {.025f, .027f, .04f, .96f});
    HudLabel<192> label;
    label.format("Race challenge from %.*s", int(race.opponent.view().size()), race.opponent.view().data());
    hud.overlay_text(left + inset, top + 16, label.view(), 20, amber);
    const float accept = top + first_row, decline = accept + row_height;
    hud.overlay_text(left + inset, accept + 6, "1. Accept", 14, race.playable ? cream : dim);
    if (race.playable)
        label.format(
                "%.*s \xC2\xB7 %.*s",
                int(race.map.view().size()),
                race.map.view().data(),
                int(race.board.view().size()),
                race.board.view().data()
        );
    else
        label.assign("Not in this version yet");
    hud.overlay_text(left + inset + hud.overlay_text_width("1. Accept  ", 14), accept + 7, label.view(), 12, dim);
    hud.overlay_text(left + inset, decline + 6, "2. Decline", 14, cream);
    const int seconds = int(std::clamp(std::ceil((race.deadline - now) / 1000), 0., 999.));
    label.format("%d s", seconds);
    hud.overlay_text(left + inset, top + height - footer_height + 8, label.view(), 12, dim);
}

// Native counterpart of web net/race.ts's duel HUD, with the room race's pieces (room_race.hpp): the countdown banner
// and numerals, GO in the accent, the race line at the top, then both times stacked with one line under them. The
// challenger sees nothing until the countdown (chat says it), as on the website. `opponent_live`: their running timer.
template <class Hud>
void draw_race(
        Hud &hud,
        int width,
        int height,
        float percent,
        const RaceDisplay &race,
        double now,
        const RoomRaceStack &stack = {},
        std::string_view opponent_live = {}
) {
    using namespace room_race_look;
    using State = RaceDisplay::State;
    if (race.state == State::none || (race.state == State::over && now > race.result_until)) return;
    if (race.state == State::challenge && !race.recipient) return;
    const HudGeometry geometry(width, height, percent);
    const float x = geometry.width / 2, middle = geometry.height / 2;
    const bool calm = stack.reduced_motion;
    const NameColor text = stack.colors.text, dim = stack.colors.dim, accent = stack.colors.accent;
    const NameColor gain = stack.colors.gain, quiet = alpha(text, .7f);
    hud.overlay_begin(width, height, percent);
    const float numeral_middle = middle - 30 - numeral_size * cap / 2;
    if (race.state == State::challenge) {
        draw_race_challenge(hud, geometry, race, now);
    } else if (race.state == State::countdown) {
        if (stack.banner) {
            HudLabel<192> label;
            label.format("Race vs %.*s", int(race.opponent.view().size()), race.opponent.view().data());
            hud.overlay_text(x, 58, label.view(), 16, accent, true);
            label.format(
                    "%.*s, %.*s",
                    int(race.map.view().size()),
                    race.map.view().data(),
                    int(race.board.view().size()),
                    race.board.view().data()
            );
            hud.overlay_text(x, 80, label.view(), 13, dim, true);
        }
        // 3, 2, 1 stamp in; "1" holds until the room's GO.
        const int seconds = int(std::clamp(std::ceil((race.go_at - now) / 1000), 1., 99.));
        HudLabel<8> numeral;
        numeral.format("%d", seconds);
        const double since = now - (race.go_at - seconds * 1000.);
        posed_text(hud, x, numeral_middle, numeral.view(), numeral_size, text, stamp_in(since, calm));
    } else if (race.state == State::live || race.state == State::settling) {
        if (race.state == State::live && now >= race.go_at && now < race.go_at + go_ms)
            posed_text(hud, x, numeral_middle, "GO", numeral_size, accent, go_out(now - race.go_at, calm));
        HudLabel<48> clock;
        if (race.state == State::settling)
            clock.assign("checking");
        else {
            // Tenths, as the website's race clock.
            format_hud_time(clock, std::max(0., (now - race.go_at) / 1000));
            clock.bytes[std::max<size_t>(clock.view().size(), 2) - 2] = '\0';
        }
        HudLabel<160> them;
        them.format("%.*s ", int(race.opponent.view().size()), race.opponent.view().data());
        const std::string_view theirs = race.theirs.empty() ? opponent_live : race.theirs.view();
        const float gap = line_size * 1.2f;
        std::array<Piece, 7> line{};
        size_t count = 0;
        line[count++] = {"Race vs ", line_size, text};
        line[count++] = {race.opponent.view(), line_size, text};
        line[count++] = {clock.view(), clock_size, text, gap};
        if (!race.mine.empty()) {
            line[count++] = {"you ", line_size, dim, gap};
            line[count++] = {race.mine.view(), line_size, text};
        }
        if (!theirs.empty()) {
            line[count++] = {them.view(), line_size, dim, gap};
            line[count++] = {theirs, line_size, text};
        }
        pieces(hud, x, geometry.height * line_top + clock_size * baseline, line, count);
    } else {
        // Both times stacked, the leader's on top (bigger; green when it's yours), one line under them.
        const double age = now - (race.result_until - race_look::result_ms);
        float base = geometry.height * result_top;
        for (int k = 0; k < 2; ++k) {
            const bool top = k == 0;
            const auto name = top ? race.top_name.view() : race.second_name.view();
            const auto time = top ? race.top_time.view() : race.second_time.view();
            const float size = race_look::row_size_of(top);
            base += (top ? cap : 1.1f) * size;
            const double since = age - k * race_look::second_row_ms;
            const float a = calm ? 1 : float(std::clamp(since / 160, 0., 1.));
            if (a <= 0) continue;
            const float drop = calm ? 0 : -10 * (1 - ease_out(float(since / 350), 3));
            const NameColor ink = top ? text : quiet;
            const float gap = race_look::row_size * .7f;
            const float name_width = hud.overlay_text_width(name, race_look::row_size);
            const float left = x - (name_width + gap + hud.overlay_text_width(time, size)) / 2;
            hud.overlay_fade(a);
            hud.overlay_text(
                    left, base + drop - race_look::row_size * baseline, name, race_look::row_size, alpha(ink, a)
            );
            hud.overlay_text(
                    left + name_width + gap,
                    base + drop - size * baseline,
                    time,
                    size,
                    alpha(top && race.won ? gain : ink, a)
            );
            hud.overlay_fade(1);
        }
        const double verdict_age = age - race_look::verdict_delay_ms;
        Pose pose{1, 1};
        if (!calm) {
            const float e = ease_out(float(verdict_age / verdict_ms), 4);
            pose = verdict_age < 0 ? Pose{1, 0}
                   : e < .4f       ? Pose{1.7f - .76f * e / .4f, e / .4f}
                   : e < .7f       ? Pose{.94f + .08f * (e - .4f) / .3f, 1}
                                   : Pose{1.02f - .02f * (e - .7f) / .3f, 1};
        }
        const float verdict_base = base + 4 + race_look::verdict_size * 1.2f;
        posed_text(
                hud,
                x,
                verdict_base - race_look::verdict_size * cap / 2,
                race.result.view(),
                race_look::verdict_size,
                race.won ? gain : text,
                pose
        );
    }
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

    template <class Zones>
    void open(const HudScoreboard &board, const Zones &zones) {
        *this = {};
        for (size_t i = 0; i < board.count; ++i) {
            const auto &row = board.rows[i];
            if (row.you || row.spectator) continue;
            slots[count] = row.slot;
            names[count++].assign(row.name);
        }
        tracks[track_count++] = 0;
        for (const auto &zone : zones) {
            if (zone.kind != 0 || !zone.track || track_count == tracks.size()) continue;
            if (std::find(tracks.begin(), tracks.begin() + track_count, zone.track) == tracks.begin() + track_count)
                tracks[track_count++] = zone.track;
        }
        step = count ? Step::player : Step::closed;
    }

    // How many choices the current step has.
    size_t available() const {
        return step == Step::player ? count : step == Step::track ? track_count : race_styles.size();
    }

    // The panel and its rows: this page's choices, the next page when there is one, and Cancel.
    MenuRows rows(int width, int height, float percent) const {
        constexpr float panel_width = 440, panel_height = 380, first_row = 56, row_height = 30;
        constexpr float next_page_top = 305, cancel_top = 331, footer_height = 26;
        constexpr size_t page_size = 8;
        const HudGeometry geometry(width, height, percent);
        MenuRows out;
        out.width = panel_width;
        out.height = panel_height;
        out.left = geometry.width / 2 - panel_width / 2;
        out.top = geometry.height / 2 - panel_height / 2;
        const size_t shown = std::min(available(), (page + 1) * page_size) - std::min(available(), page * page_size);
        for (size_t i = 0; i < shown; ++i)
            out.add(unsigned(i + 1), out.top + first_row + float(i) * row_height, row_height);
        if (available() > page_size) out.add(9, out.top + next_page_top, footer_height);
        out.add(0, out.top + cancel_top, footer_height);
        return out;
    }

    bool key(std::string_view code, bool down, bool repeat) {
        if (step == Step::closed || !down || repeat || code.size() != 6 || !code.starts_with("Digit")) return false;
        const unsigned pick = unsigned(code.back() - '0');
        if (!pick) {
            step = Step::closed;
            return true;
        }
        const size_t available = this->available();
        if (pick == 9 && available > 8) {
            page = (page + 1) % ((available + 7) / 8);
            return true;
        }
        const size_t index = page * 8 + pick - 1;
        if (index >= available || pick > 8) return true;
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
            const auto style = race_styles[index];
            command.format("/race #%u %.*s %u", opponent, int(style.size()), style.data(), track);
            step = Step::closed;
        }
        return true;
    }
};

// `pointer`: the cursor in HUD units while a chat line holds it out, for the row it is on.
template <class Hud>
void draw_race_picker(
        Hud &hud,
        int width,
        int height,
        float percent,
        const RacePicker &picker,
        std::optional<std::array<float, 2>> pointer = std::nullopt
) {
    using Step = RacePicker::Step;
    constexpr float text_inset = 6;
    constexpr NameColor cream = {.94f, .91f, .86f, 1};
    constexpr NameColor dim = {.64f, .66f, .7f, 1};
    if (picker.step == Step::closed) return;
    const auto layout = picker.rows(width, height, percent);
    const float x = layout.left, y = layout.top;
    hud.overlay_begin(width, height, percent);
    hud.overlay_rect(x, y, layout.width, layout.height, {.025f, .027f, .04f, .96f});
    draw_menu_hover(hud, layout, layout.hovered(pointer));
    hud.overlay_text(
            x + 18,
            y + 16,
            picker.step == Step::player  ? "Race a player"
            : picker.step == Step::track ? "Choose a track"
                                         : "Choose a style",
            20,
            {1, .71f, .24f, 1}
    );
    HudLabel<160> label;
    for (size_t row = 0; row < layout.count; ++row) {
        const auto &place = layout.rows[row];
        const size_t i = picker.page * 8 + place.digit - 1;
        if (place.digit == 0 || place.digit == 9) {
            hud.overlay_text(x + 18, place.top + text_inset, place.digit ? "9. Next page" : "0. Cancel", 12, dim);
            continue;
        }
        if (picker.step == Step::player)
            label.format("%u. %.*s", place.digit, int(picker.names[i].view().size()), picker.names[i].view().data());
        else if (picker.step == Step::track)
            label.format(picker.tracks[i] ? "%u. Bonus %u" : "%u. Main track", place.digit, picker.tracks[i]);
        else {
            const auto name = wire_style_name(race_styles[i]);
            label.format("%u. %.*s", place.digit, int(name.size()), name.data());
        }
        hud.overlay_text(x + 18, place.top + text_inset, label.view(), 14, cream);
    }
    hud.overlay_end(width, height);
}

class RoomModes {
    using J = nlohmann::json;
    uint64_t generation_ = 0;
    std::string room_, prepared_, went_;
    std::optional<J> race_;
    bool closed_ = false, pending_go_ = false;
    RaceDisplay display_;
    RoomRaceModes room_race_;
    double clock_offset_ = 0, result_until_ = 0, go_until_ = 0;

    static bool number(const J &j) { return j.is_number() && std::isfinite(j.get<double>()); }

    static bool valid(const J &r) {
        if (!r.is_object() || !r.contains("id") || !r["id"].is_string()
            || r["id"].get_ref<const std::string &>().size() > 128 || !r.contains("state") || !r["state"].is_string())
            return false;
        static const std::set<std::string> states = {"challenge", "countdown", "live", "settling", "over"};
        if (!states.contains(r["state"].get<std::string>()) || !r.contains("map") || !r["map"].is_string()
            || !r.contains("style") || !r["style"].is_string() || !wire_style(r["style"].get<std::string>())
            || !r.contains("track")
            || (!r["track"].is_number_unsigned() && !(r["track"].is_number_integer() && r["track"].get<int64_t>() >= 0))
            || r["track"].get<uint64_t>() > 64)
            return false;
        for (const char *key : {"a", "b"})
            if (!r.contains(key) || !r[key].is_object() || !r[key].contains("name") || !r[key]["name"].is_string())
                return false;
        if (!r.contains("you") || !r["you"].is_string() || (r["you"] != "a" && r["you"] != "b")) return false;
        for (const char *key : {"expiresAt", "goAt", "endsAt"})
            if (!r.contains(key) || (!r[key].is_null() && !number(r[key]))) return false;
        return true;
    }

    static std::string time(double seconds) {
        if (!std::isfinite(seconds) || seconds < 0) return "—";
        const auto ms = uint64_t(std::min(seconds, 1e9) * 1000 + .5);
        std::ostringstream out;
        out << std::setfill('0') << std::setw(2) << ms / 60000 << ':' << std::setw(2) << (ms / 1000) % 60 << '.'
            << std::setw(3) << ms % 1000;
        return out.str();
    }

    double local(const char *key, double fallback) const {
        const auto &value = race_->at(key);
        return value.is_null() ? fallback : value.get<double>() - clock_offset_;
    }

    const J &opponent() const { return race_->at(race_->at("you") == "a" ? "b" : "a"); }

    static std::string side_time(const J &side) {
        if (side.contains("finish") && side["finish"].is_object()) {
            const auto &finish = side["finish"];
            if (finish.contains("real") && number(finish["real"])) {
                std::string text = time(finish["real"].get<double>());
                const auto status = json_value(finish, "status", std::string());
                if (status == "verifying")
                    text += " (checking)";
                else if (status == "rejected")
                    text += " (rejected)";
                return text;
            }
        }
        if (side.contains("out") && side["out"].is_string()) return side["out"] == "forfeit" ? "forfeited" : "left";
        return "no finish";
    }

    RoomModeAction restart(bool spectating) {
        RoomModeAction action;
        action.restart = true;
        action.stop_spectating = spectating;
        action.track = race_->at("track").get<uint32_t>();
        // A style this build can't play keeps your own; the room won't count that run for the race.
        const auto style = race_->at("style").get<std::string>();
        if (!action.track && wire_style_playable(style)) action.style = style;
        return action;
    }

    RoomModeAction prepare(const std::string &map, bool spectating) {
        if (!race_ || race_->at("map") != map) return {};
        const auto id = race_->at("id").get<std::string>(), state = race_->at("state").get<std::string>();
        if (state == "countdown" && prepared_ != id) {
            prepared_ = id;
            return restart(spectating);
        }
        return {};
    }

    RoomModeAction apply(const J &next, const std::string &map, bool spectating, double now) {
        if (next.is_null()) {
            reset_race();
            return {};
        }
        if (!valid(next)) return {};
        const auto id = next.at("id").get<std::string>(), state = next.at("state").get<std::string>();
        const bool from_countdown = race_ && race_->at("id") == id && race_->at("state") == "countdown";
        if (!race_ || race_->at("id") != id) {
            prepared_.clear();
            went_.clear();
            pending_go_ = false;
            go_until_ = 0;
        }
        race_ = next;
        refresh_display(now);
        if (state == "over") {
            pending_go_ = false;
            go_until_ = 0;
            // Declined/expired challenges never started and have no race result.
            if (next.at("goAt").is_null())
                reset_race();
            else
                result_until_ = now + 8000;
            return {};
        }
        if (state == "countdown") return prepare(map, spectating);
        if (state == "live" && went_ != id) {
            if (from_countdown || pending_go_) {
                if (next.at("map") != map) {
                    pending_go_ = true;
                    return {};
                }
                pending_go_ = false;
                went_ = id;
                go_until_ = now + 650;
                return restart(spectating);
            }
            // A mid-race reconnect gets the live state, not another GO/reset.
            went_ = id;
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
        const auto style = race_->at("style").get<std::string>();
        display_.board.assign(wire_style_name(style));
        display_.playable = race_->at("track").get<unsigned>() || wire_style_playable(style);
        if (race_->at("track").get<unsigned>()) display_.board.format("Bonus %u", race_->at("track").get<unsigned>());
        display_.recipient = race_->at("you") == "b";
        display_.deadline = local("expiresAt", now);
        display_.go_at = local("goAt", now);
        display_.result_until = now + 8000;
        display_.map.assign(race_->at("map").get<std::string>());
        const auto &me = race_->at(race_->at("you") == "a" ? "a" : "b");
        const auto &them = opponent();
        const auto finished = [](const J &side) {
            return side.contains("finish") && side["finish"].is_object() && side["finish"].contains("real")
                   && number(side["finish"]["real"]);
        };
        const auto out = [](const J &side) {
            return side.contains("out") && side["out"].is_string();
        };
        display_.mine.assign(finished(me) ? side_time(me) : "");
        display_.theirs.assign(finished(them) || out(them) ? side_time(them) : "");
        display_.opponent_slot.reset();
        if (them.contains("slot") && them["slot"].is_number_unsigned() && them["slot"].get<uint64_t>() < 256)
            display_.opponent_slot = them["slot"].get<unsigned>();
        if (display_.state == State::over) {
            const auto winner = json_value(*race_, "winner", J(nullptr));
            const auto outcome = json_value(*race_, "outcome", std::string());
            const auto name = them.at("name").get<std::string>();
            const auto real = [&](const J &side) {
                return finished(side) ? side["finish"]["real"].get<double>() : INFINITY;
            };
            const auto result_time = [&](const J &side) {
                return finished(side)                          ? time(side["finish"]["real"].get<double>())
                       : out(side) && side["out"] == "forfeit" ? std::string("forfeited")
                       : out(side)                             ? std::string("left")
                                                               : std::string("no finish");
            };
            display_.won = winner == race_->at("you");
            const bool me_first = display_.won || (!winner.is_string() && real(me) <= real(them));
            display_.top_name.assign(me_first ? std::string("you") : name);
            display_.top_time.assign(result_time(me_first ? me : them));
            display_.second_name.assign(me_first ? name : std::string("you"));
            display_.second_time.assign(result_time(me_first ? them : me));
            display_.result.assign(
                    display_.won           ? "You won"
                    : winner.is_string()   ? name + " won"
                    : outcome == "draw"    ? "Draw"
                    : outcome == "timeout" ? "Nobody finished"
                                           : "Race over"
            );
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
    const RaceDisplay &display() const { return display_; }

    const RoomRaceDisplay &room_race_display() const { return room_race_.display(); }

    bool room_race_tick(double now) { return room_race_.refresh(now); }

    bool challenge_key(std::string_view code, bool down, bool repeat) const {
        return down && !repeat && display_.state == RaceDisplay::State::challenge && display_.recipient
               && ((code == "Digit1" && display_.playable) || code == "Digit2");
    }

    // Preserve the highest observed room generation when the host leaves a map.
    void close(uint64_t generation) {
        generation_ = std::max(generation_, generation);
        reset_race();
        room_race_.clear();
        room_.clear();
        closed_ = true;
        clock_offset_ = 0;
    }

    RoomModeAction event(const J &envelope, const std::string &map, bool spectating, double now_epoch_ms) {
        if (!envelope.is_object() || !envelope.contains("generation")
            || (!envelope["generation"].is_number_unsigned()
                && !(envelope["generation"].is_number_integer() && envelope["generation"].get<int64_t>() >= 0))
            || !envelope.contains("id") || !envelope["id"].is_string() || !envelope.contains("event")
            || !envelope["event"].is_object())
            return {};
        const auto generation = envelope["generation"].get<uint64_t>();
        const auto id = envelope["id"].get<std::string>();
        if (generation < generation_ || (generation == generation_ && ((closed_) || (!room_.empty() && room_ != id))))
            return {};
        if (generation > generation_) {
            reset_race();
            room_race_.clear();
            room_.clear();
            closed_ = false;
            clock_offset_ = 0;
            generation_ = generation;
        }
        room_ = id;
        const auto &e = envelope["event"];
        const auto type = json_value(e, "t", std::string());
        if (e.contains("nativeClockOffsetMs") && number(e["nativeClockOffsetMs"]))
            clock_offset_ = e["nativeClockOffsetMs"].get<double>();
        if (type == "nativeLeave") {
            reset_race();
            room_race_.clear();
            room_.clear();
            closed_ = true;
            return {};
        }
        if (type == "nativeStatus" && json_value(e, "status", std::string()) == "closed") {
            reset_race();
            room_race_.clear();
            return {};
        }
        if (type == "nativeMap" || type == "map") {
            reset_race();
            room_race_.clear();
            return {};
        }
        if (type == "welcome") {
            auto action = apply(json_value(e, "race", J(nullptr)), map, spectating, now_epoch_ms);
            auto room_action = room_race_.apply(
                    json_value(e, "roomRace", J(nullptr)), map, spectating, now_epoch_ms, clock_offset_, true
            );
            if (room_action.restart || room_action.room_race_finish || room_action.room_race_over) return room_action;
            return action;
        }
        if (type == "roomRace" && e.contains("race"))
            return room_race_.apply(e.at("race"), map, spectating, now_epoch_ms, clock_offset_);
        if (type == "race" && e.contains("race")) return apply(e.at("race"), map, spectating, now_epoch_ms);
        return {};
    }

    RoomModeAction map_loaded(const std::string &map, bool spectating, double now_epoch_ms) {
        const auto action = room_race_.map_loaded(map, spectating, now_epoch_ms);
        if (action.restart) return action;
        if (race_ && pending_go_ && race_->at("state") == "live" && race_->at("map") == map) {
            pending_go_ = false;
            went_ = race_->at("id").get<std::string>();
            go_until_ = now_epoch_ms + 650;
            return restart(spectating);
        }
        return prepare(map, spectating);
    }

    bool frozen() const {
        return room_race_.frozen() || (race_ && race_->at("state") == "countdown" && race_->at("id") == prepared_);
    }

    bool has_race() const { return race_.has_value() || room_race_.participating(); }

    std::string notice(double now_epoch_ms) const {
        if (!race_) return {};
        const auto state = race_->at("state").get<std::string>(),
                   opponent_name = opponent().at("name").get<std::string>();
        if (state == "challenge")
            return race_->at("you") == "b"
                           ? "Race challenge from " + opponent_name + " — open Room to accept or decline"
                           : "Challenge sent to " + opponent_name;
        if (state == "countdown") {
            const auto left = std::max(0., std::ceil((local("goAt", now_epoch_ms) - now_epoch_ms) / 1000));
            return "Race vs " + opponent_name + " · "
                   + (left > 0 ? std::to_string(int(std::min(left, 999.))) : "Waiting for GO");
        }
        if (state == "over") {
            if (now_epoch_ms > result_until_) return {};
            const auto winner = json_value(*race_, "winner", J(nullptr));
            const auto outcome = json_value(*race_, "outcome", std::string());
            const auto verdict = winner == race_->at("you") ? "You won"
                                 : winner.is_string()       ? opponent_name + " won"
                                 : outcome == "draw"        ? "Draw"
                                 : outcome == "timeout"     ? "Nobody finished"
                                                            : "Race over";
            const auto &me = race_->at(race_->at("you") == "a" ? "a" : "b");
            return verdict + " · you " + side_time(me) + " · " + opponent_name + " " + side_time(opponent());
        }
        if (now_epoch_ms < go_until_) return "GO — race vs " + opponent_name;
        if (state == "settling") return "Race vs " + opponent_name + " · checking server results";
        const double deadline = local("endsAt", INFINITY);
        if (now_epoch_ms >= deadline) return "Race vs " + opponent_name + " · waiting for server result";
        return "Race vs " + opponent_name + " · "
               + time(std::max(0., (now_epoch_ms - local("goAt", now_epoch_ms)) / 1000));
    }
};

template <class Script, class Menu>
bool handle_race_key(
        std::string_view code,
        bool down,
        bool repeat,
        const RoomModes &modes,
        RacePicker &picker,
        Script &script,
        Menu *menu,
        bool ready
) {
    if (modes.challenge_key(code, down, repeat)) {
        script.open(
                menu,
                ready,
                code == "Digit1" ? "window.bunnyhopNativeMenu?.onRoomCommand?.({t:'chat',text:'/accept'})"
                                 : "window.bunnyhopNativeMenu?.onRoomCommand?.({t:'chat',text:'/decline'})"
        );
        return true;
    }
    if (!picker.key(code, down, repeat)) return false;
    if (!picker.command.empty()) {
        script.open(
                menu,
                ready,
                "window.bunnyhopNativeMenu?.onRoomCommand?.("
                        + nlohmann::json({{"t", "chat"}, {"text", std::string(picker.command.view())}}).dump() + ")"
        );
        picker.command.assign("");
    }
    return true;
}
}  // namespace native
