#pragma once
#include "hud_scoreboard.hpp"
#include "hud_layout.hpp"
#include "hud_readouts.hpp"
#include "longjump.hpp"
#include "jump_hud.hpp"
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
    return {{"strafeTrainer", true},
            {"hudStrafeTrainerStyle",
             beginner ? "detailed"
             : strict ? "minimal"
                      : "classic"},
            {"hudStrafeTrainerFollow", beginner || strict},
            {"strafeTrainerSmoothing",
             beginner ? 12
             : strict ? 3
                      : 8},
            {"hudStrafeTrainerZone",
             beginner ? 20
             : strict ? 5
                      : 10},
            {"strafeTrainerHints", beginner},
            {"hudStrafeTrainerShowPace", true}};
}

inline JhudPrefs read_jhud_prefs(const Json &settings) {
    constexpr std::array<const char *, jhud_band_count> color_keys = {
            "hudJhudColorsReallyBad",
            "hudJhudColorsBad",
            "hudJhudColorsMeh",
            "hudJhudColorsGood",
            "hudJhudColorsReallyGood"
    };
    JhudPrefs prefs;
    prefs.sync = settings.at("hudJhudSync");
    prefs.jss = settings.at("hudJhudJss");
    prefs.analyzer = settings.at("hudJhudAnalyzer");
    prefs.speed_colors = settings.at("hudJhudSpeedColors");
    prefs.cutoff = settings.at("hudJhudCutoff");
    for (size_t band = 0; band < color_keys.size(); ++band)
        prefs.colors[band] = name_color(settings.at(color_keys[band]).get<std::string>());
    return prefs;
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
    std::string color_blind;
    TrainerAppearance trainer;
    JhudPrefs jhud;
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
        result.layout = read_hud_layout(settings);
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
        result.keys_rows = {
                settings.at("hudKeysRowsWasd"), settings.at("hudKeysRowsActions"), settings.at("hudKeysRowsMouse")
        };
        constexpr std::array<const char *, 6> actions = {"forward", "left", "back", "right", "duck", "jump"};
        for (size_t i = 0; i < actions.size(); ++i) {
            const auto &codes = settings.at("binds").at(actions[i]);
            result.key_labels[i] = hud_key_label(codes.empty() ? "" : codes[0].get_ref<const std::string &>());
        }
        result.color_blind = settings.at("colorBlind");
        result.palette = semantic_palette(result.color_blind);
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
        result.jhud = read_jhud_prefs(settings);
        result.first_jump_chat = settings.at("hudMovementFjtChat");
        result.long_jump = settings.at("hudMovementLj");
        result.long_jump_chat = settings.at("hudMovementLjChat");
        result.hidden_speed_keys = settings.at("hudHiddenKeeps") == "speedKeys";
        result.edge_glow = settings.at("hudEdgeGlow");
        result.tags_players = settings.at("tagsPlayers");
        result.tags_through_walls = settings.at("tagsThroughWalls");
        result.perf_hud = settings.at("audioPerfHud");
        result.trainer_sound = settings.at("hudStrafeTrainerSound");
        result.trainer_enabled = strafe_trainer_enabled(settings);
        result.null_binds = settings.at("nullBinds");
        result.triggers_visible = settings.at("triggersVisible");
        result.clips_visible = settings.at("clipsVisible");
        result.auto_restart_when = settings.at("autoRestartWhen");
        result.auto_restart_sound = settings.at("autoRestartAction") == "sound";
        result.place = settings.at("hudPlace");
        return result;
    }
};

inline std::optional<double> trainer_jump_sound(const HudPreferences &prefs, std::optional<double> pace) {
    if (!prefs.trainer_enabled || !prefs.trainer_sound || !pace) return std::nullopt;
    constexpr std::array<double, 3> pitches = {.75, 1.1, 1.5};
    return pitches[trainer_band(*pace, prefs.trainer.zone)];
}

inline bool perfect_hop_visible(
        std::string_view style, const BhRunState &run, uint32_t tick, double interval, bool practice = false
) {
    constexpr double perfect_seconds = .35;
    return (style == "scroll" || style == "legit") && !practice && run.last_perfect_tick >= 0
           && tick >= uint32_t(run.last_perfect_tick)
           && tick - uint32_t(run.last_perfect_tick) < std::ceil(perfect_seconds / interval);
}

inline HudLabel<64> perf_text(const BhRunState &run) {
    HudLabel<64> result;
    if (!run.measured_jumps)
        result.assign("perf —");
    else
        result.format("perf %.1f%%", run.perf_percent);
    return result;
}

inline void feed_strafe_trainer(
        MovementFeedback &feedback,
        const HudPreferences &prefs,
        const BhState &state,
        const SsjCmd &command,
        const BhSettings &settings,
        std::string_view style,
        double interval,
        bool interrupted
) {
    if (!prefs.trainer_enabled) {
        feedback.strafe_trainer.reset();
        feedback.strafe_reading.reset();
        return;
    }
    feedback.strafe_trainer.set_smoothing(prefs.trainer_smoothing);
    feedback.strafe_trainer.zone = prefs.trainer.zone;
    feedback.strafe_trainer.feed(
            command,
            {std::hypot(double(state.velocity[0]), double(state.velocity[1])),
             bool(state.grounded),
             bool(state.on_ladder),
             state.tick,
             interval,
             settings.max_speed,
             settings.air_accelerate,
             style,
             interrupted || bool(state.events & 9),
             bool(state.events & jump)}
    );
    feedback.strafe_reading = feedback.strafe_trainer.reading;
}

struct OffsetReport {
    int ticks = 0;
    bool overlap = false;
    bool gap = false;
};

inline HudLabel<> offset_text(const OffsetReport &reading) {
    HudLabel<32> ticks;
    if (reading.ticks < 0)
        ticks.format("−%d", -reading.ticks);
    else
        ticks.format("%s%d", reading.ticks > 0 ? "+" : "", reading.ticks);
    HudLabel<> result;
    result.format(
            "Offset %s (%s%s)",
            ticks.bytes.data(),
            reading.ticks < 0   ? "key early"
            : reading.ticks > 0 ? "key late"
                                : "same tick",
            reading.overlap ? ", overlap"
            : reading.gap   ? ", gap"
                            : ""
    );
    return result;
}

inline HudLabel<> first_jump_text(unsigned ticks, std::optional<double> interval = {}) {
    HudLabel<> result;
    result.format("FJT %u tick%s", ticks, ticks == 1 ? "" : "s");
    if (interval) {
        HudLabel<48> milliseconds;
        milliseconds.format(" (%.0f ms)", std::floor(ticks * *interval * 1000 + .5));
        result.append(milliseconds.view());
    }
    return result;
}

class OffsetTracker {
    int64_t tick_ = -1;
    float yaw_ = NAN;
    int side_ = 0;
    int turn_ = 0;
    std::optional<std::pair<int64_t, int>> key_at_;
    std::optional<std::pair<int64_t, int>> turn_at_;
    bool overlap_ = false;
    bool gap_ = false;

public:
    void reset() { *this = {}; }

    std::optional<OffsetReport> feed(const BhCmd &cmd, const BhState &state, std::string_view style) {
        const bool manual = style == "autohop" || style == "legit" || style == "scroll" || style == "hsw";
        const bool continuous = int64_t(state.tick) == tick_ + 1;
        const float previous_yaw = yaw_;
        const bool valid = continuous && manual && !state.grounded && !state.on_ladder && !(state.events & 9)
                           && std::isfinite(cmd.yaw);
        if (!valid) reset();
        tick_ = state.tick;
        yaw_ = cmd.yaw;
        if (!valid) return std::nullopt;
        const int side = (cmd.side > 0) - (cmd.side < 0);
        float delta = std::isfinite(previous_yaw) ? std::fmod(cmd.yaw - previous_yaw, 360.f) : 0;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        const int turn = (delta < 0) - (delta > 0);
        if ((cmd.buttons & (left | right)) == (left | right))
            overlap_ = true;
        else if (!side)
            gap_ = true;
        if (side && side_ && side != side_) key_at_ = {{tick_, side}};
        if (turn && turn_ && turn != turn_) turn_at_ = {{tick_, turn}};
        if (side) side_ = side;
        if (turn) turn_ = turn;
        if (key_at_ && tick_ - key_at_->first >= 20) key_at_.reset();
        if (turn_at_ && tick_ - turn_at_->first >= 20) turn_at_.reset();
        if (!key_at_ || !turn_at_ || key_at_->second != turn_at_->second) return std::nullopt;
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
    void reset() { reported_ = false; }

    std::optional<unsigned> feed(bool jumped, const BhRunState &run, uint32_t tick, bool broken) {
        if (run.jumps == 0) reset();
        if (broken) {
            reported_ = true;
            return std::nullopt;
        }
        if (reported_ || !jumped || run.jumps != 1 || (run.status != 1 && !run.in_start)) return std::nullopt;
        reported_ = true;
        return run.status == 1 ? tick - std::min(tick, run.start_tick) : 0;
    }
};

class AutoRestart {
    uint64_t fired_ = ~uint64_t(0);

public:
    bool check(uint64_t attempt, const BhRunState &run, std::optional<double> target, bool blocked) {
        if (attempt == fired_ || run.status != 1 || blocked || !target || !std::isfinite(*target) || *target <= 0
            || std::round(run.seconds * 1000) <= std::round(*target * 1000))
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
    StartPreTracker start_pre_;
    bool lj_enabled_ = false;
    JumpHud jumps_;

public:
    HudLabel<> start_pre;
    HudLabel<> offset;
    HudLabel<> first_jump;
    HudLabel<> first_jump_chat;
    HudLabel<> long_jump;
    HudLabel<> long_jump_details;
    double tick_interval = .01;
    double jump_sync = 0;
    double gain_delta = 0;
    uint32_t gain_tick = 0;
    float pre_speed = 0;
    SemanticColor long_jump_color = semantic_rgb(0xffffff);
    std::string color_blind;
    bool new_first = false;
    bool new_long_jump = false;

    void reset() { *this = {}; }

    void tick_jump(const BhCmd &command, const BhState &state) {
        constexpr double minimum_gain = 3;
        if (const auto reading = jumps_.feed(command, state); reading && std::abs(reading->gain) >= minimum_gain) {
            gain_delta = reading->gain;
            gain_tick = state.tick;
        }
        jump_sync = jumps_.sync();
    }

private:
    void clear_observation() {
        offsets_.reset();
        first_.reset();
        longjump_.reset();
        start_pre_.reset();
        start_pre.assign("");
        offset.assign("");
        first_jump.assign("");
        long_jump.assign("");
        long_jump_details.assign("");
        new_first = false;
        new_long_jump = false;
    }

    void feed_start_pre(const BhJumpObservation &observation, bool in_start_before) {
        const auto &pre = observation.pre;
        SsjTick info;
        info.jumped = observation.post.events & jump;
        info.teleported = observation.post.events & 9;
        info.in_start = in_start_before;
        const SsjState state{pre.position, pre.velocity, bool(pre.grounded), bool(pre.on_ladder)};
        const auto value = start_pre_.tick(state, info);
        if (!value) return;
        if (*value) {
            pre_speed = **value;
            start_pre.format("Start Pre %d", **value);
        } else {
            start_pre.assign("");
        }
    }

    void feed_long_jump(const BhJumpObservation &observation, double dt, const std::string &style, bool enabled) {
        if (lj_enabled_ != enabled) {
            longjump_.reset();
            long_jump.assign("");
            long_jump_details.assign("");
            lj_enabled_ = enabled;
        }
        if (!enabled) return;
        const auto report = longjump_.feed(
                observation.pre, observation.post, observation.command, observation.valid == 1, dt, style
        );
        if (!report) return;
        long_jump = lj_head(*report);
        long_jump_details = lj_details(*report);
        long_jump_color = lj_color(*report, color_blind);
        new_long_jump = !report->failed;
    }

public:
    void
    feed(const BhJumpObservation *observation,
         const BhRunState &run,
         double dt,
         const std::string &style,
         bool lj_enabled = true,
         bool in_start_before = false,
         bool noclip = false) {
        tick_interval = dt;
        if (!observation || noclip) {
            clear_observation();
            return;
        }
        const auto &state = observation->post;
        if (epoch_ != observation->epoch || (state.events & 9) || (run.update_flags & 4)) clear_observation();
        epoch_ = observation->epoch;
        feed_start_pre(*observation, in_start_before);
        if (state.grounded || (state.events & 9)) offset.assign("");
        if (run.jumps == 0) first_jump.assign("");
        if (const auto reading = offsets_.feed(observation->command, state, style)) offset = offset_text(*reading);
        if (const auto ticks = first_.feed(state.events & jump, run, state.tick, state.events & 9)) {
            first_jump = first_jump_text(*ticks);
            first_jump_chat = first_jump_text(*ticks, dt);
            new_first = true;
        }
        feed_long_jump(*observation, dt, style, lj_enabled);
    }
};
}  // namespace native

namespace native {
inline Json movement_stat_patch(const Json &settings, const Json &message) {
    const auto stat = json_text(message, "stat");
    const char *id = stat == "offsets" ? "strafeOffsets"
                     : stat == "fjt"   ? "firstJump"
                     : stat == "lj"    ? "longJump"
                     : stat == "jhud"  ? "jhud"
                                       : nullptr;
    if (!id) throw std::runtime_error("Unknown movement stat");
    auto layout = settings.at("hudLayoutWeb");
    Json place = layout.value(
            id,
            Json{{"a", 4},
                 {"x", 0},
                 {"y",
                  stat == "lj"    ? -.185
                  : stat == "fjt" ? -.104
                                  : -.13},
                 {"s", stat == "lj" ? 1.0 : .85},
                 {"on", false}}
    );
    const char *visible = place.contains("a") ? "on" : "visible";
    if (message.contains("on") && !message["on"].is_boolean())
        throw std::runtime_error("Movement stat visibility must be boolean");
    const bool on = message.value("on", !place.value(visible, false));
    place[visible] = on;
    layout[id] = std::move(place);
    Json patch = {{"hudLayoutWeb", std::move(layout)}};
    if (stat == "lj") patch["hudMovementLj"] = on;
    return patch;
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

    std::optional<double>
    ghost_target(std::string_view map, std::string_view style, unsigned track, bool enabled) const {
        return enabled && ghost_map.view() == map && ghost_style.view() == style && ghost_track == track ? ghost_seconds
                                                                                                         : std::nullopt;
    }

    HudLabel<96> ghost_delta;
    bool ghost_ahead = false;
    // Slot 0's own delta for its name tag; the split above is against the ghost Compare with picks.
    HudLabel<96> ghost_tag_delta;
    GhostSpeedReadout ghost_speed;

    void ghost_keys(const BhCmd *command) {
        have_ghost = command != nullptr;
        ghost_buttons = command ? command->buttons : 0;
    }

    void show_ghost_split(std::optional<double> seconds, std::optional<double> tag_seconds) {
        if (seconds != shown_ghost_split_) {
            shown_ghost_split_ = seconds;
            format_ghost_delta(ghost_delta, seconds);
            ghost_ahead = seconds && *seconds <= 0;
        }
        if (tag_seconds != shown_ghost_tag_) {
            shown_ghost_tag_ = tag_seconds;
            format_ghost_delta(ghost_tag_delta, tag_seconds);
        }
    }

    void leaderboard(unsigned rank, std::optional<double> top = std::nullopt) {
        if (!rank)
            place.assign("");
        else if (top && std::isfinite(*top) && *top > 0 && *top <= 100)
            place.format("#%u · top %.0f%%", rank, std::ceil(*top));
        else
            place.format("#%u", rank);
    }

    void ghost(const Json &info) {
        ghost_name.assign(info.is_object() ? json_text(info, "player") : "Ghost");
        ghost_seconds.reset();
        if (!info.is_object()) return;
        ghost_map.assign(json_text(info, "map"));
        ghost_style.assign(json_text(info, "style"));
        ghost_track = info.value("track", ~0u);
        const uint32_t ghost_start = info.value("startTick", 0u), ghost_end = info.value("endTick", 0u);
        if (info.contains("timeMs") && info["timeMs"].is_number_integer())
            ghost_seconds = info["timeMs"].get<double>() / 1000;
        else if (info.contains("time") && info["time"].is_number())
            ghost_seconds = info["time"].get<double>();
        else if (info.contains("realTime") && info["realTime"].is_number())
            ghost_seconds = info["realTime"].get<double>();
        else if (ghost_end > ghost_start && info.contains("settings"))
            ghost_seconds = score_seconds(legacy_replay_ms(info));
        if (ghost_seconds
            && (!std::isfinite(*ghost_seconds) || *ghost_seconds <= 0 || *ghost_seconds > max_score_seconds))
            ghost_seconds.reset();
    }

    void local_pb(const Json &entries, const std::string &map, const std::string &style, unsigned track) {
        if (!entries.is_array()) return;
        for (const auto &entry : entries) {
            if (!entry.is_object() || json_text(entry, "map") != map || json_text(entry, "style") != style
                || entry.value("track", ~0u) != track)
                continue;
            const auto summary = entry.find("localSummary");
            if (summary == entry.end() || !summary->is_object() || !json_flag(*summary, "eligible")) continue;
            const auto milliseconds = summary->find("timeMs");
            const auto time = summary->find("time");
            const double seconds = milliseconds != summary->end() && milliseconds->is_number()
                                           ? milliseconds->get<double>() / 1000
                                   : time != summary->end() && time->is_number() ? time->get<double>()
                                                                                 : 0;
            if (std::isfinite(seconds) && seconds > 0 && (!personal_best || seconds < *personal_best))
                personal_best = seconds;
        }
        if (personal_best) pb.format("PB %.3fs", *personal_best);
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
            show_ghost_split(message["ghostDelta"].get<double>(), shown_ghost_tag_);
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
                if (spectator_count == spectators.size()) break;
                if (name.is_string()) spectators[spectator_count++].assign(name.get<std::string>());
            }
        }
        have_ghost = message.contains("ghostButtons") && message["ghostButtons"].is_number_unsigned();
        ghost_buttons = have_ghost ? message["ghostButtons"].get<uint32_t>() : 0;
    }

private:
    static void format_ghost_delta(HudLabel<96> &label, std::optional<double> seconds) {
        if (seconds)
            label.format("%+.3fs", *seconds);
        else
            label.assign("");
    }

    std::optional<double> shown_ghost_split_, shown_ghost_tag_;
};

template <class Hud, class At>
void draw_movement_widgets(
        Hud &hud,
        At at,
        const HudPreferences &prefs,
        const MovementHud &movement,
        const HudExtras &extras,
        const BhRunState &run,
        float width,
        float height,
        bool practice,
        unsigned checkpoint,
        bool editing = false,
        std::string_view segmented = {}
) {
    constexpr NameColor cream = {.94f, .91f, .86f, 1};
    constexpr NameColor dim = {.63f, .65f, .70f, 1};
    constexpr NameColor amber = {1, .71f, .24f, 1};
    // The layout editor draws every element; the HUD fades the ones that are off.
    const auto wanted = [&](std::string_view id, bool fallback) {
        const auto &place = prefs.layout[hud_index(id)];
        return editing || (place ? place->visible : fallback);
    };
    const auto line = [&](const char *id,
                          std::string_view text,
                          float x,
                          float y,
                          bool fallback,
                          std::optional<NameColor> color = {}) {
        if (text.empty() || !wanted(id, fallback)) return;
        const auto point = at(id, x, y);
        hud.overlay_text(point[0], point[1], text, 13, color.value_or(dim), true);
    };
    // Built-in places beside the native HUD's run column (hud.hpp): stage and start speed to the left of the timer
    // and speed, the sync bar under the run stats. The board place, right of the timer, is drawn by hud.hpp.
    constexpr float beside_column = 175;
    constexpr float timer_line_from_bottom = 141;
    constexpr float speed_line_from_bottom = 100;
    constexpr float sync_bar_from_bottom = 44;
    const auto placed = [&](std::string_view id) {
        const auto &place = prefs.layout[hud_index(id)];
        return place && place->placed;
    };
    HudLabel<> label;
    // The map line already names the bonus; a separate line only where the player put one.
    if (run.track && (placed("track") || editing)) {
        label.format("Bonus %u", run.track);
        line("track", label.view(), width / 2, height / 2, true);
    }
    if (run.split_count) {
        label.format("Stage / CP %u", run.split_count);
        line("stage", label.view(), width / 2 - beside_column, height - timer_line_from_bottom, true);
    }
    if (wanted("sync", false)) {
        const auto point = at("sync", width / 2, height - sync_bar_from_bottom);
        hud.overlay_rect(point[0] - 90, point[1], 180, 4, {.08f, .08f, .10f, .7f});
        hud.overlay_rect(
                point[0] - 90,
                point[1],
                180 * float(std::floor(movement.jump_sync + .5)) / 100,
                4,
                jump_sync_color(movement.jump_sync, prefs.palette)
        );
    }
    line("startPre", movement.start_pre.view(), width / 2 - beside_column, height - speed_line_from_bottom, false);
    line("strafeOffsets", movement.offset.view(), width / 2, height * .37f, false);
    line("firstJump", movement.first_jump.view(), width / 2, height * .396f, false);
    if (prefs.long_jump) {
        line("longJump", movement.long_jump.view(), width / 2, height * .315f, false, movement.long_jump_color);
        if (wanted("longJump", false)) {
            const auto point = at("longJump", width / 2, height * .315f);
            hud.overlay_text(point[0], point[1] + 23, movement.long_jump_details.view(), 12, dim, true);
        }
    }
    if (wanted("spectators", true) && extras.spectator_count) {
        const auto point = at("spectators", 26, height * .44f);
        hud.overlay_text(point[0], point[1], "Spectators", 12, amber);
        for (size_t i = 0; i < extras.spectator_count; ++i)
            hud.overlay_text(point[0], point[1] + 20 + float(i) * 18, extras.spectators[i].view(), 12, dim);
    }
    if (!segmented.empty()) {
        line("practice", segmented, width / 2, height / 2 + 28, true, cream);
    } else if (practice) {
        label.format("Practice | checkpoint %u", checkpoint);
        line("practice", label.view(), width / 2, height / 2 + 28, true);
    }
    if (extras.have_ghost && wanted("ghostKeys", false)) {
        const auto point = at("ghostKeys", width / 2 + 140, height / 2 + 100);
        constexpr std::array<uint32_t, 6> bits = {forward, left, back, right, duck, jump};
        constexpr std::array<std::string_view, 6> names = {"W", "A", "S", "D", "DUCK", "JUMP"};
        constexpr float keys_below_label = 19;
        hud.overlay_text(point[0], point[1], "Ghost", 11, dim);
        for (size_t i = 0; i < bits.size(); ++i)
            hud.overlay_text(
                    point[0] + float(i) * 30,
                    point[1] + keys_below_label,
                    names[i],
                    10,
                    extras.ghost_buttons & bits[i] ? cream : dim
            );
    }
}

}  // namespace native
