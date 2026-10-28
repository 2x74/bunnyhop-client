#pragma once
#include "hud_scoreboard.hpp"
#include "longjump.hpp"
#include "native_input.hpp"
#include "settings.hpp"
#include "run_timing.hpp"
#include <span>
#include "ssj.hpp"
#include "strafe_trainer.hpp"
#include <array>

namespace native {
struct TrainerAppearance {
    std::string style = "classic";
    NameColor color = {1, 1, 1, 1};
    bool follow = false;
    bool show_pace = true;
    float zone = 10;
    float height = 1;
    float dim_below = 0;
};
inline Json trainer_preset(std::string_view preset) {
    const bool beginner = preset == "beginner";
    const bool strict = preset == "strict";
    return {{"hudStrafeTrainerStyle", beginner ? "detailed"
                                      : strict ? "minimal"
                                               : "classic"},
            {"hudStrafeTrainerFollow", beginner || strict},
            {"strafeTrainerSmoothing", beginner ? 12
                                       : strict ? 3
                                                : 8},
            {"hudStrafeTrainerZone", beginner ? 20
                                     : strict ? 5
                                              : 10},
            {"strafeTrainerHints", beginner},
            {"hudStrafeTrainerShowPace", true}};
}

struct HudPreferences {
    std::array<std::optional<HudPlace>, hud_ids.size()> layout;
    std::string crosshair_style;
    NameColor crosshair_color;
    float crosshair_size = 6;
    float crosshair_gap = 4;
    float crosshair_thickness = 2;
    bool crosshair_outline = true;
    bool jump_stats_colors = true;
    bool speed_colors = true;
    bool gain_ticks = true;
    bool perfect_indicator = true;
    bool speed_graph = false;
    bool keys_overlay = true;
    std::string keys_style;
    float keys_opacity = 1;
    NameColor keys_pressed;
    NameColor keys_idle;
    std::array<bool, 3> keys_rows = {true, true, true};
    std::array<std::string, 6> key_labels;
    SemanticPalette palette;
    TrainerAppearance trainer;
    SsjFields ssj_fields;
    SsjMode ssj_mode = SsjMode::sixth;
    unsigned ssj_interval = 6;
    unsigned trainer_smoothing = 8;
    bool ssj_chat = false;
    bool first_jump_chat = false;
    bool long_jump = false;
    bool long_jump_chat = true;
    bool hidden_speed_keys = true;
    bool edge_glow = false;
    bool tags_players = true;
    bool tags_through_walls = false;
    bool perf_hud = true;
    bool trainer_sound = false;
    bool trainer_enabled = false;
    bool null_binds = false;
    bool triggers_visible = false;
    bool clips_visible = false;
    std::string auto_restart_when;
    bool auto_restart_sound = false;
    std::string place;

    static HudPreferences from(const Json &settings) {
        HudPreferences result;
        for (const char *key : {"hudLayoutWeb", "hudLayout"}) {
            for (const auto &[id, value] : settings.at(key).items()) {
                const size_t index = hud_index(id);
                HudPlace place = result.layout[index].value_or(HudPlace{});
                const bool anchored = value.contains("a");
                if (value.contains("x") && value.contains("y")) {
                    place.anchored = anchored;
                    place.anchor = value.value("a", 0u);
                    place.x = value.at("x");
                    place.y = value.at("y");
                }
                place.visible = value.value(anchored ? "on" : "visible", place.visible);
                place.scale = value.value(anchored ? "s" : "scale", place.scale);
                result.layout[index] = place;
            }
        }
        result.crosshair_style = settings.at("crosshairStyle");
        result.crosshair_color = name_color(settings.at("crosshairColor").get<std::string>());
        result.crosshair_color[3] = settings.at("crosshairAlpha");
        result.crosshair_size = settings.at("crosshairSize");
        result.crosshair_gap = settings.at("crosshairGap");
        result.crosshair_thickness = settings.at("crosshairThickness");
        result.crosshair_outline = settings.at("crosshairOutline");
        result.jump_stats_colors = settings.at("jumpStatsColors");
        result.speed_colors = settings.at("speedColors");
        result.gain_ticks = settings.at("gainTicks");
        result.perfect_indicator = settings.at("perfectIndicator");
        result.speed_graph = settings.at("speedGraph");
        result.keys_overlay = settings.at("keysOverlay");
        result.keys_style = settings.at("keysStyle");
        result.keys_opacity = settings.at("hudKeysOpacity");
        result.keys_pressed = name_color(settings.at("hudKeysPressed").get<std::string>());
        result.keys_idle = name_color(settings.at("hudKeysIdle").get<std::string>());
        result.keys_rows = {settings.at("hudKeysRowsWasd"), settings.at("hudKeysRowsActions"),
                            settings.at("hudKeysRowsMouse")};
        constexpr std::array<const char *, 6> actions = {"forward", "left", "back", "right", "duck", "jump"};
        for (size_t i = 0; i < actions.size(); ++i) {
            const auto &codes = settings.at("binds").at(actions[i]);
            auto &label = result.key_labels[i];
            label = codes.empty() ? "-" : codes[0].get<std::string>();
            if (label.starts_with("Key"))
                label.erase(0, 3);
            else if (label.starts_with("Digit"))
                label.erase(0, 5);
            else if (label.starts_with("Control"))
                label = "DUCK";
            else if (label == "Space")
                label = "JUMP";
        }
        result.palette = semantic_palette(settings.at("colorBlind").get<std::string>());
        result.trainer.style = settings.at("hudStrafeTrainerStyle");
        result.trainer.color = name_color(settings.at("hudStrafeTrainerColor").get<std::string>());
        result.trainer.follow = settings.at("hudStrafeTrainerFollow");
        result.trainer.show_pace = settings.at("hudStrafeTrainerShowPace");
        result.trainer.zone = settings.at("hudStrafeTrainerZone");
        result.trainer.height = settings.at("hudStrafeTrainerHeight");
        result.trainer.dim_below = settings.at("hudStrafeTrainerDimBelow");
        auto &fields = result.ssj_fields;
        fields.speed = settings.at("hudSsjFieldsSpeed");
        fields.diff = settings.at("hudSsjFieldsDiff");
        fields.gain = settings.at("hudSsjFieldsGain");
        fields.sync = settings.at("hudSsjFieldsSync");
        fields.strafes = settings.at("hudSsjFieldsStrafes");
        fields.eff = settings.at("hudSsjFieldsEff");
        fields.height = settings.at("hudSsjFieldsHeight");
        fields.time = settings.at("hudSsjFieldsTime");
        fields.start_pre = false;
        const auto mode = settings.at("jumpStatsMode");
        result.ssj_mode = mode == "every" ? SsjMode::every : mode == "interval" ? SsjMode::every_nth : SsjMode::sixth;
        result.ssj_interval = settings.at("jumpStatsInterval");
        result.trainer_smoothing = settings.at("strafeTrainerSmoothing");
        result.ssj_chat = settings.at("hudSsjChat");
        result.first_jump_chat = settings.at("hudMovementFjtChat");
        result.long_jump = settings.at("hudMovementLj");
        result.long_jump_chat = settings.at("hudMovementLjChat");
        result.hidden_speed_keys = settings.at("hudHiddenKeeps") == "speedKeys";
        result.edge_glow = settings.at("hudEdgeGlow");
        result.tags_players = settings.at("tagsPlayers");
        result.tags_through_walls = settings.at("tagsThroughWalls");
        result.perf_hud = settings.at("audioPerfHud");
        result.trainer_sound = settings.at("hudStrafeTrainerSound");
        result.trainer_enabled = settings.at("strafeTrainer");
        result.null_binds = settings.at("nullBinds");
        result.triggers_visible = settings.at("triggersVisible");
        result.clips_visible = settings.at("clipsVisible");
        result.auto_restart_when = settings.at("autoRestartWhen");
        result.auto_restart_sound = settings.at("autoRestartAction") == "sound";
        result.place = settings.at("hudPlace");
        return result;
    }
};

inline std::optional<double> trainer_jump_sound(const HudPreferences &prefs, const BhState &state,
                                                const std::optional<StrafeReading> &reading) {
    if (!prefs.trainer_enabled || !prefs.trainer_sound || !(state.events & jump) || !reading)
        return std::nullopt;
    const float error = std::abs(reading->percent - 100);
    constexpr double on_pace_pitch = 1.25;
    constexpr double near_pace_pitch = 1;
    constexpr double off_pace_pitch = .8;
    return error <= prefs.trainer.zone       ? on_pace_pitch
           : error <= prefs.trainer.zone * 3 ? near_pace_pitch
                                             : off_pace_pitch;
}

struct OffsetReport {
    int ticks = 0;
    bool overlap = false;
    bool gap = false;
};
class OffsetTracker {
    int64_t tick_ = -1;
    float yaw_ = 0;
    int side_ = 0;
    int turn_ = 0;
    std::optional<std::pair<int64_t, int>> key_at_;
    std::optional<std::pair<int64_t, int>> turn_at_;
    bool overlap_ = false;
    bool gap_ = false;

  public:
    void reset() {
        *this = {};
    }
    std::optional<OffsetReport> feed(const BhCmd &cmd, const BhState &state, std::string_view style) {
        const bool manual = style == "autohop" || style == "legit" || style == "scroll" || style == "hsw";
        const bool continuous = int64_t(state.tick) == tick_ + 1;
        const float previous_yaw = yaw_;
        const bool valid = continuous && manual && !state.grounded && !state.on_ladder && !(state.events & 9) &&
                           std::isfinite(cmd.yaw);
        if (!valid)
            reset();
        tick_ = state.tick;
        yaw_ = cmd.yaw;
        if (!valid)
            return std::nullopt;
        const int side = (cmd.side > 0) - (cmd.side < 0);
        const float delta = std::remainder(cmd.yaw - previous_yaw, 360.f);
        const int turn = (delta < 0) - (delta > 0);
        if ((cmd.buttons & (left | right)) == (left | right))
            overlap_ = true;
        else if (!side)
            gap_ = true;
        if (side && side_ && side != side_)
            key_at_ = {{tick_, side}};
        if (turn && turn_ && turn != turn_)
            turn_at_ = {{tick_, turn}};
        if (side)
            side_ = side;
        if (turn)
            turn_ = turn;
        if (key_at_ && tick_ - key_at_->first >= 20)
            key_at_.reset();
        if (turn_at_ && tick_ - turn_at_->first >= 20)
            turn_at_.reset();
        if (!key_at_ || !turn_at_ || key_at_->second != turn_at_->second)
            return std::nullopt;
        OffsetReport result{int(key_at_->first - turn_at_->first), overlap_, gap_};
        key_at_.reset();
        turn_at_.reset();
        overlap_ = false;
        gap_ = false;
        return result;
    }
};

class FirstJumpTracker {
    bool reported_ = false;

  public:
    void reset() {
        reported_ = false;
    }
    std::optional<unsigned> feed(bool jumped, const BhRunState &run, uint32_t tick, bool broken) {
        if (run.jumps == 0)
            reset();
        if (broken) {
            reported_ = true;
            return std::nullopt;
        }
        if (reported_ || !jumped || run.jumps != 1 || (run.status != 1 && !run.in_start))
            return std::nullopt;
        reported_ = true;
        return run.status == 1 ? tick - std::min(tick, run.start_tick) : 0;
    }
};

class AutoRestart {
    uint64_t fired_ = ~uint64_t(0);

  public:
    bool check(uint64_t attempt, const BhRunState &run, std::optional<double> target, bool blocked) {
        if (attempt == fired_ || run.status != 1 || blocked || !target || !std::isfinite(*target) || *target <= 0 ||
            std::round(run.seconds * 1000) <= std::round(*target * 1000))
            return false;
        fired_ = attempt;
        return true;
    }
};

class MovementHud {
    OffsetTracker offsets_;
    FirstJumpTracker first_;
    LjTracker longjump_;
    uint32_t epoch_ = ~uint32_t(0);
    bool was_in_start_ = false;

  public:
    HudLabel<> start_pre;
    HudLabel<> offset;
    HudLabel<> first_jump;
    HudLabel<> long_jump;
    HudLabel<> long_jump_details;
    float pre_speed = 0;
    bool new_first = false;
    bool new_long_jump = false;

    void reset() {
        *this = {};
    }
    void feed(const BhJumpObservation *observation, const BhRunState &run, double dt, const std::string &style) {
        if (!observation) {
            offsets_.reset();
            longjump_.reset();
            return;
        }
        const auto &state = observation->post;
        if (epoch_ != observation->epoch || (state.events & 9) || (run.update_flags & 4)) {
            offsets_.reset();
            first_.reset();
            longjump_.reset();
            offset.assign("");
            first_jump.assign("");
        }
        epoch_ = observation->epoch;
        if (run.in_start || (was_in_start_ && !run.in_start)) {
            pre_speed = std::hypot(state.velocity[0], state.velocity[1]);
            start_pre.format("Start Pre %.0f", pre_speed);
        }
        was_in_start_ = run.in_start;
        if (const auto reading = offsets_.feed(observation->command, state, style)) {
            offset.format("Offset %+d (%s%s)", reading->ticks,
                          reading->ticks < 0   ? "key early"
                          : reading->ticks > 0 ? "key late"
                                               : "same tick",
                          reading->overlap ? ", overlap"
                          : reading->gap   ? ", gap"
                                           : "");
        }
        if (const auto ticks = first_.feed(state.events & jump, run, state.tick, state.events & 9)) {
            first_jump.format("FJT %u tick%s (%.0f ms)", *ticks, *ticks == 1 ? "" : "s", *ticks * dt * 1000);
            new_first = true;
        }
        const auto report =
            longjump_.feed(observation->pre, state, observation->command, observation->valid == 1, dt, style);
        if (report) {
            long_jump.format("%s %.2f%s", report->standing ? "LJ" : "BH", report->distance,
                             report->failed ? " fail" : "");
            long_jump_details.format("%.0f pre | %.0f max | %zu str | %.0f%% sync", report->pre, report->max,
                                     report->strafes.size(), report->sync);
            new_long_jump = true;
        }
    }
};
} // namespace native

namespace native {
inline Json movement_stat_patch(const Json &settings, const Json &message) {
    const auto stat = json_text(message, "stat");
    const char *id = stat == "offsets" ? "strafeOffsets"
                     : stat == "fjt"   ? "firstJump"
                     : stat == "lj"    ? "longJump"
                                       : nullptr;
    if (!id)
        throw std::runtime_error("Unknown movement stat");
    auto layout = settings.at("hudLayoutWeb");
    Json place = layout.value(id, Json{{"a", 4},
                                       {"x", 0},
                                       {"y", stat == "lj"    ? -.185
                                             : stat == "fjt" ? -.104
                                                             : -.13},
                                       {"s", stat == "lj" ? 1.0 : .85},
                                       {"on", false}});
    const char *visible = place.contains("a") ? "on" : "visible";
    if (message.contains("on") && !message["on"].is_boolean())
        throw std::runtime_error("Movement stat visibility must be boolean");
    const bool on = message.value("on", !place.value(visible, false));
    place[visible] = on;
    layout[id] = std::move(place);
    Json patch = {{"hudLayoutWeb", std::move(layout)}};
    if (stat == "lj")
        patch["hudMovementLj"] = on;
    return patch;
}

inline float ghost_segment_fraction(const float *position, const BhGhostFrame &from, const BhGhostFrame &to) {
    float dot = 0, length = 0;
    for (unsigned axis = 0; axis < 3; ++axis) {
        const float segment = to.position[axis] - from.position[axis];
        dot += (position[axis] - from.position[axis]) * segment;
        length += segment * segment;
    }
    constexpr float minimum_segment_squared = 1e-6f;
    return length > minimum_segment_squared ? std::clamp(dot / length, 0.f, 1.f) : 0.f;
}

struct HudExtras {
    HudLabel<96> pb;
    HudLabel<64> place;
    std::array<HudLabel<128>, 12> spectators;
    size_t spectator_count = 0;
    uint32_t ghost_buttons = 0;
    bool have_ghost = false;
    std::optional<double> personal_best;
    std::optional<double> ghost_seconds;
    HudLabel<128> ghost_name;
    HudLabel<128> ghost_map;
    HudLabel<32> ghost_style;
    unsigned ghost_track = ~0u;
    std::optional<double> ghost_target(std::string_view map, std::string_view style, unsigned track,
                                       bool enabled) const {
        return enabled && ghost_map.view() == map && ghost_style.view() == style && ghost_track == track ? ghost_seconds
                                                                                                         : std::nullopt;
    }
    HudLabel<96> ghost_delta;
    uint32_t ghost_start = 0, ghost_end = 0, ghost_match = 0, ghost_sample_tick = ~0u;
    double ghost_interval = legacy_tick_seconds;
    void ghost_progress(std::span<const BhGhostFrame> frames, const BhState &state, const BhRunState &run,
                        const BhCmd *command) {
        have_ghost = command != nullptr;
        ghost_buttons = command ? command->buttons : 0;
        if (!command || !run.status || frames.empty()) {
            ghost_delta.assign("");
            ghost_match = ghost_start;
            ghost_sample_tick = ~0u;
            return;
        }
        if (state.tick == ghost_sample_tick)
            return;
        if (run.status == 2 && ghost_seconds) {
            ghost_delta.format("%+.3fs", run.seconds - *ghost_seconds);
            ghost_sample_tick = state.tick;
            return;
        }
        constexpr uint32_t sample_interval_ticks = 4;
        if (ghost_sample_tick != ~0u && state.tick >= ghost_sample_tick &&
            state.tick - ghost_sample_tick < sample_interval_ticks)
            return;
        if (state.tick < ghost_sample_tick)
            ghost_match = ghost_start;
        ghost_sample_tick = state.tick;
        const uint32_t end = std::min(ghost_end, uint32_t(frames.size() - 1));
        constexpr uint32_t search_back_ticks = 300, search_forward_ticks = 600;
        constexpr float match_radius_units = 128;
        const uint32_t low = std::max(ghost_start, ghost_match > search_back_ticks ? ghost_match - search_back_ticks : 0);
        const uint32_t high = std::min(end, ghost_match + search_forward_ticks);
        float distance = match_radius_units * match_radius_units;
        std::optional<uint32_t> nearest;
        for (uint32_t tick = low; tick <= high; ++tick) {
            float squared = 0;
            for (unsigned axis = 0; axis < 3; ++axis) {
                const float offset = frames[tick].position[axis] - state.position[axis];
                squared += offset * offset;
            }
            if (squared < distance) {
                distance = squared;
                nearest = tick;
            }
        }
        if (!nearest) {
            ghost_delta.assign("");
            return;
        }
        ghost_match = *nearest;
        float fraction = *nearest < end
                             ? ghost_segment_fraction(state.position, frames[*nearest], frames[*nearest + 1]) : 0;
        if (!fraction && *nearest > ghost_start)
            fraction = -ghost_segment_fraction(state.position, frames[*nearest], frames[*nearest - 1]);
        const double ghost_elapsed = (*nearest + double(fraction) - ghost_start) * ghost_interval;
        ghost_delta.format("%+.3fs", run.seconds - ghost_elapsed);
    }
    void leaderboard(unsigned rank, std::optional<double> top = std::nullopt) {
        if (!rank)
            place.assign("");
        else if (top && std::isfinite(*top) && *top > 0 && *top <= 100)
            place.format("#%u | top %.1f%%", rank, *top);
        else
            place.format("#%u", rank);
    }
    void ghost(const Json &info) {
        ghost_name.assign(info.is_object() ? json_text(info, "player") : "Ghost");
        ghost_seconds.reset();
        if (!info.is_object())
            return;
        ghost_map.assign(json_text(info, "map"));
        ghost_style.assign(json_text(info, "style"));
        ghost_track = info.value("track", ~0u);
        ghost_start = info.value("startTick", 0u);
        ghost_end = info.value("endTick", 0u);
        ghost_match = ghost_start;
        ghost_sample_tick = ~0u;
        ghost_interval = info.value("settings", Json::object()).value("tickInterval", .01);
        if (!std::isfinite(ghost_interval) || ghost_interval <= 0)
            ghost_interval = .01;
        if (info.contains("timeMs") && info["timeMs"].is_number_integer())
            ghost_seconds = info["timeMs"].get<double>() / 1000;
        else if (info.contains("time") && info["time"].is_number())
            ghost_seconds = info["time"].get<double>();
        else if (info.contains("realTime") && info["realTime"].is_number())
            ghost_seconds = info["realTime"].get<double>();
        else if (ghost_end > ghost_start && info.contains("settings"))
            ghost_seconds = score_seconds(legacy_replay_ms(info));
        if (ghost_seconds && (!std::isfinite(*ghost_seconds) || *ghost_seconds <= 0 ||
                              *ghost_seconds > max_score_seconds))
            ghost_seconds.reset();
    }

    void local_pb(const Json &entries, const std::string &map, const std::string &style, unsigned track) {
        if (!entries.is_array())
            return;
        for (const auto &entry : entries) {
            if (!entry.is_object() || json_text(entry, "map") != map || json_text(entry, "style") != style ||
                entry.value("track", ~0u) != track)
                continue;
            const auto summary = entry.find("localSummary");
            if (summary == entry.end() || !summary->is_object() || !json_flag(*summary, "eligible"))
                continue;
            const auto milliseconds = summary->find("timeMs");
            const auto time = summary->find("time");
            const double seconds = milliseconds != summary->end() && milliseconds->is_number()
                                       ? milliseconds->get<double>() / 1000
                                   : time != summary->end() && time->is_number() ? time->get<double>()
                                                                                 : 0;
            if (std::isfinite(seconds) && seconds > 0 && (!personal_best || seconds < *personal_best))
                personal_best = seconds;
        }
        if (personal_best)
            pb.format("PB %.3fs", *personal_best);
    }
    void contract(const Json &message) {
        const auto time = message.find("pb");
        if (time != message.end() && time->is_number()) {
            const double seconds = time->get<double>();
            if (std::isfinite(seconds) && seconds > 0) {
                personal_best = seconds;
                pb.format("PB %.3fs", seconds);
            }
        } else if (time != message.end()) {
            personal_best.reset();
            pb.assign("");
        }
        if (message.contains("pbTimeMs") && message["pbTimeMs"].is_number_integer()) {
            const double seconds = message["pbTimeMs"].get<double>() / 1000;
            if (std::isfinite(seconds) && seconds > 0) {
                personal_best = seconds;
                pb.format("PB %.3fs", seconds);
            }
        }
        if (message.contains("ghostDelta") && message["ghostDelta"].is_number())
            ghost_delta.format("%+.3fs", message["ghostDelta"].get<double>());
        const auto position = message.find("place");
        if (position != message.end() && position->is_number_unsigned()) {
            leaderboard(position->get<unsigned>(), message.value("topPercent", 0.));
        } else {
            place.assign("");
        }
        spectator_count = 0;
        const auto names = message.find("spectators");
        if (names != message.end() && names->is_array()) {
            for (const auto &name : *names) {
                if (spectator_count == spectators.size())
                    break;
                if (name.is_string())
                    spectators[spectator_count++].assign(name.get<std::string>());
            }
        }
        have_ghost = message.contains("ghostButtons") && message["ghostButtons"].is_number_unsigned();
        ghost_buttons = have_ghost ? message["ghostButtons"].get<uint32_t>() : 0;
    }
};

template <class Hud, class At>
void draw_movement_widgets(Hud &hud, At at, const HudPreferences &prefs, const MovementHud &movement,
                           const HudExtras &extras, const BhRunState &run, float width, float height, bool practice,
                           unsigned checkpoint) {
    constexpr NameColor cream = {.94f, .91f, .86f, 1};
    constexpr NameColor dim = {.63f, .65f, .70f, 1};
    constexpr NameColor amber = {1, .71f, .24f, 1};
    const auto wanted = [&](std::string_view id, bool fallback) {
        const auto &place = prefs.layout[hud_index(id)];
        return place ? place->visible : fallback;
    };
    const auto line = [&](const char *id, std::string_view text, float x, float y, bool fallback) {
        if (text.empty() || !wanted(id, fallback))
            return;
        const auto point = at(id, x, y);
        hud.overlay_text(point[0], point[1], text, 13, dim, true);
    };
    HudLabel<> label;
    if (run.track) {
        label.format("Bonus %u", run.track);
        line("track", label.view(), width / 2, height - 298, true);
    }
    if (run.split_count) {
        label.format("Stage / CP %u", run.split_count);
        line("stage", label.view(), width / 2, height - 43, true);
    }
    if (wanted("sync", false)) {
        const auto point = at("sync", width / 2, height - 32);
        hud.overlay_rect(point[0] - 90, point[1], 180, 4, {.08f, .08f, .10f, .7f});
        hud.overlay_rect(point[0] - 90, point[1], 180 * float(std::clamp(run.sync_percent, 0., 100.)) / 100, 4,
                         prefs.palette.sync);
    }
    line("startPre", movement.start_pre.view(), width / 2 - 160, height - 105, false);
    line("strafeOffsets", movement.offset.view(), width / 2, height * .37f, false);
    line("firstJump", movement.first_jump.view(), width / 2, height * .396f, false);
    if (prefs.long_jump) {
        line("longJump", movement.long_jump.view(), width / 2, height * .315f, false);
        if (wanted("longJump", false)) {
            const auto point = at("longJump", width / 2, height * .315f);
            hud.overlay_text(point[0], point[1] + 23, movement.long_jump_details.view(), 12, dim, true);
        }
    }
    line("pb", extras.pb.view(), width - 130, 18, true);
    if (prefs.place != "off")
        line("splits",
             prefs.place == "place" ? extras.place.view().substr(0, extras.place.view().find(" |"))
                                    : extras.place.view(),
             width / 2 + 160, height - 154, true);
    if (wanted("spectators", true) && extras.spectator_count) {
        const auto point = at("spectators", 26, height * .44f);
        hud.overlay_text(point[0], point[1], "Spectators", 12, amber);
        for (size_t i = 0; i < extras.spectator_count; ++i)
            hud.overlay_text(point[0], point[1] + 20 + float(i) * 18, extras.spectators[i].view(), 12, dim);
    }
    if (practice) {
        label.format("Practice | checkpoint %u", checkpoint);
        line("practice", label.view(), width / 2, height / 2 + 28, true);
    }
    if (extras.have_ghost && wanted("ghostKeys", false)) {
        const auto point = at("ghostKeys", width / 2 + 140, height / 2 + 100);
        constexpr std::array<uint32_t, 6> bits = {forward, left, back, right, duck, jump};
        constexpr std::array<std::string_view, 6> names = {"W", "A", "S", "D", "DUCK", "JUMP"};
        hud.overlay_text(point[0], point[1] - 19, "Ghost", 11, dim);
        for (size_t i = 0; i < bits.size(); ++i)
            hud.overlay_text(point[0] + float(i) * 30, point[1], names[i], 10,
                             extras.ghost_buttons & bits[i] ? cream : dim);
    }
}

template <class Hud>
void draw_trainer(Hud &hud, float x, float y, const StrafeReading &reading, const TrainerAppearance &look, bool hints,
                  const SemanticPalette &palette, int turn_direction) {
    const float error = std::abs(reading.percent - 100);
    const unsigned band = error <= look.zone ? 2 : error <= look.zone * 3 ? 1 : 0;
    auto tone = palette.trainer[band];
    tone[3] *= reading.percent < look.dim_below ? .25f : 1;
    auto ink = look.color;
    ink[3] = tone[3];
    if (look.show_pace) {
        HudLabel<64> label;
        label.format("%.0f%%", reading.percent);
        hud.overlay_text(x, y, label.view(), 14, ink, true);
    }
    const bool minimal = look.style == "minimal";
    const float bar = minimal ? 150 : 240;
    const float thickness = (minimal ? 3 : look.style == "detailed" ? 12 : 6) * look.height;
    const float top = y + (look.show_pace ? 24 : 0);
    const float left = x - bar / 2;
    hud.overlay_rect(left, top, bar, thickness, {.05f, .05f, .07f, .6f * tone[3]});
    hud.overlay_rect(x - look.zone / 200 * bar, top, look.zone / 100 * bar, thickness,
                     {tone[0], tone[1], tone[2], .2f * tone[3]});
    hud.overlay_rect(x - 1, top - 3, 2, thickness + 6, ink);
    const float direction = look.follow && turn_direction < 0 ? -1 : 1;
    const float position = std::clamp((reading.percent - 100) / 200 * direction, -.5f, .5f);
    hud.overlay_rect(x + position * bar - 2, top - 2, 4, thickness + 4, tone);
    if (look.style == "detailed") {
        hud.overlay_text(left, top + thickness + 5, "0", 10, ink);
        hud.overlay_text(x, top + thickness + 5, "100", 10, ink, true);
        hud.overlay_text(left + bar - 18, top + thickness + 5, "200", 10, ink);
    }
    if (hints && reading.hint)
        hud.overlay_text(x, top + thickness + 23, strafe_hint_text(*reading.hint), 12, ink, true);
}
} // namespace native
