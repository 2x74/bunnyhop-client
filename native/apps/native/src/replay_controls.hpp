#pragma once
#include "replay_range.hpp"
#include "latest_worker.hpp"
#include "bunnyhop_native.h"
#include "render_shaders.hpp"
#include "graphics_settings.hpp"
#include <filesystem>
#include <vector>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <cstdio>

namespace native {
struct ReplayControls {
    bool visible = true, dragging = false;
    std::optional<uint32_t> pending;
    uint32_t first_tick = 0;
    enum class Action { none, start, back, pause, forward, end, slower, faster, camera };

    bool toggle_from_key(bool down, bool repeat) {
        if (!down || repeat) {
            return false;
        }
        visible = !visible;
        dragging = false;
        return true;
    }

    bool action(Action action, uint32_t tick, const ReplayRange &range, bool &paused, double &playback_speed) {
        switch (action) {
            case Action::start:
                pending = range.from;
                break;
            case Action::end:
                pending = range.to;
                paused = true;
                break;
            case Action::back:
            case Action::forward: {
                const int seconds = action == Action::back ? -5 : 5;
                pending = range.clamp(offset(tick, seconds, range.tick_interval, range.to));
                break;
            }
            case Action::pause:
                paused = !paused;
                break;
            case Action::slower:
                playback_speed = speed(playback_speed, false);
                break;
            case Action::faster:
                playback_speed = std::min(4., speed(playback_speed, true));
                break;
            case Action::camera:
                return true;
            default:
                break;
        }
        return false;
    }

    static uint32_t offset(uint32_t tick, int seconds, double interval, uint32_t total) {
        if (!std::isfinite(interval) || interval <= 0) return tick;
        return uint32_t(std::clamp(std::round(double(tick) + seconds / interval), 0., double(total)));
    }

    static double speed(double current, bool faster) {
        constexpr double values[] = {.1, .25, .5, 1, 1.5, 2, 4, 8};
        if (faster) {
            for (auto v : values)
                if (v > current + .001) return v;
            return 8;
        }
        for (int i = 7; i >= 0; --i)
            if (values[i] < current - .001) return values[i];
        return .1;
    }

    struct Layout {
        float x, y, width;
    };

    static Layout layout(float width, float height) {
        return {20, std::max(0.f, height - 112), std::max(1.f, width - 40)};
    }

    static bool timeline(Layout b, float x, float y) {
        return x >= b.x && x <= b.x + b.width && y >= b.y + 29 && y <= b.y + 55;
    }

    static uint32_t tick_at(Layout b, float x, uint32_t total, uint32_t first = 0) {
        const double fraction = std::clamp(double((x - b.x) / b.width), 0., 1.);
        return first + uint32_t(std::round(fraction * (total - first)));
    }

    Action pointer(Layout bounds, float x, float y, uint32_t total, bool down) {
        if (!down) {
            dragging = false;
            return Action::none;
        }
        if (timeline(bounds, x, y)) {
            dragging = true;
            pending = tick_at(bounds, x, total, first_tick);
            return Action::none;
        }
        if (y < bounds.y + 60 || y > bounds.y + 90 || x < bounds.x || x > bounds.x + bounds.width) {
            return Action::none;
        }
        const int index = int((x - bounds.x) / (bounds.width / 8));
        return static_cast<Action>(std::clamp(index, 0, 7) + 1);
    }

    void motion(Layout bounds, float x, uint32_t total) {
        if (dragging) {
            pending = tick_at(bounds, x, total, first_tick);
        }
    }

    std::optional<uint32_t> take() {
        auto result = pending;
        pending.reset();
        return result;
    }
};

template <class Hud>
void draw_replay_controls(
        Hud &hud,
        int width,
        int height,
        float scale,
        const ReplayControls &controls,
        uint32_t tick,
        uint32_t total,
        double interval,
        bool paused,
        double speed,
        const std::string &camera
) {
    tick = std::clamp(tick, controls.first_tick, total) - controls.first_tick;
    total -= controls.first_tick;
    if (!controls.visible) return;
    const auto b = ReplayControls::layout(width / scale, height / scale);
    hud.overlay_begin(width, height, 100);  // draw below in physical pixels, independent of HUD preference
    const auto p = [](float v) {
        return v;
    };
    hud.overlay_rect(p(b.x - 8), p(b.y - 7), p(b.width + 16), p(104), {.025f, .03f, .045f, .94f});
    char label[180];
    std::snprintf(
            label,
            sizeof(label),
            "Replay  %.2fs / %.2fs   %.2gx   %s   Space pause | Tab camera control | Esc menu",
            tick * interval,
            total * interval,
            speed,
            camera.c_str()
    );
    hud.overlay_text(p(b.x), p(b.y), label, p(13), {.94f, .91f, .85f, 1});
    hud.overlay_rect(p(b.x), p(b.y + 37), p(b.width), p(7), {.23f, .24f, .29f, 1});
    const float fraction = total ? float(tick) / total : 0;
    hud.overlay_rect(p(b.x), p(b.y + 37), p(b.width * fraction), p(7), {.7f, .8f, .95f, 1});
    hud.overlay_rect(p(b.x + b.width * fraction - 3), p(b.y + 32), p(6), p(17), {1, 1, 1, 1});
    const char *labels[] = {"|<", "-5s", paused ? "Play" : "Pause", "+5s", ">|", "Slower", "Faster", "Camera"};
    for (int i = 0; i < 8; ++i) {
        const float x = b.x + i * b.width / 8;
        hud.overlay_rect(p(x + 2), p(b.y + 60), p(b.width / 8 - 4), p(29), {.15f, .17f, .22f, 1});
        hud.overlay_text(p(x + b.width / 16), p(b.y + 67), labels[i], p(13), {.94f, .91f, .85f, 1}, true);
    }
    hud.overlay_end(width, height);
}
}  // namespace native

namespace native {
inline uint32_t compare_tick(
        uint32_t playback_tick,
        uint32_t playback_start,
        double playback_interval,
        uint32_t compare_start,
        uint32_t compare_end,
        double compare_interval
) {
    if (!std::isfinite(playback_interval) || !std::isfinite(compare_interval) || playback_interval <= 0
        || compare_interval <= 0) {
        return compare_start;
    }
    const double elapsed = (double(playback_tick) - playback_start) * playback_interval;
    return uint32_t(std::clamp(std::round(compare_start + elapsed / compare_interval), 0., double(compare_end)));
}
}  // namespace native

namespace native {
// The compare handle never enters the live replay/reset pipeline; loading it preserves playback and recording state.
class ReplayCompare {
public:
    struct Prepared {
        std::vector<BhGhostFrame> frames;
        native_render::Actor actor;
        uint32_t start = 0, end = 0, playback_start = 0;
        double interval = 1. / 64;
        bool finished = false;
    };

private:
    std::vector<BhGhostFrame> frames_;
    BhContext *core_ = nullptr;
    uint32_t handle_ = 0, start_ = 0, end_ = 0, playback_start_ = 0;
    double interval_ = 1. / 64;
    bool finished_ = false;
    native_render::Actor actor_;

public:
    void clear() {
        if (core_ && handle_) {
            bh_ghost_free(core_, handle_);
        }
        core_ = nullptr;
        handle_ = 0;
        frames_.clear();
    }

    void
    load(BhContext *core,
         const std::string &path,
         native_render::GhostSource source,
         const nlohmann::json &playback,
         const std::atomic_bool *cancel = nullptr) {
        clear();
        const uint32_t handle = bh_ghost_load_cancellable(
                core, path.c_str(), cancel ? replay_cancelled : nullptr, const_cast<std::atomic_bool *>(cancel)
        );
        if (!handle) {
            throw std::runtime_error(bh_last_error(core));
        }
        try {
            size_t length = 0;
            const auto *raw = bh_ghost_info(core, handle, &length);
            if (!raw) {
                throw std::runtime_error("Missing compare ghost metadata");
            }
            const auto info = nlohmann::json::parse(raw, raw + length);
            if (info.at("map") != playback.at("map") || info.at("track") != playback.at("track")
                || info.at("style") != playback.at("style")) {
                throw std::runtime_error("Compare ghost must match replay map, track and style");
            }
            actor_ = {};
            actor_.id = "ghost-compare";
            actor_.name = info.contains("player") && info.at("player").is_string()
                                  ? info.at("player").get<std::string>()
                                  : "Compare";
            actor_.loadout = info.contains("packedLoadout") && info.at("packedLoadout").is_string()
                                     ? info.at("packedLoadout").get<std::string>()
                                     : std::string();
            actor_.outfit = "outfit-cream";
            actor_.opacity = .55f;
            actor_.source = source;
            playback_start_ = playback.value("startTick", 0u);
            start_ = info.value("startTick", 0u);
            end_ = info.value("endTick", info.value("totalTicks", 0u));
            finished_ = end_ > start_;
            if (end_ <= start_) end_ = info.value("totalTicks", 0u);
            const auto &settings = info.at("settings");
            interval_ = settings.value("tickInterval", 1. / 64);
            core_ = core;
            handle_ = handle;
        } catch (...) {
            bh_ghost_free(core, handle);
            throw;
        }
    }

    const native_render::Actor *sample(uint32_t tick, double interval) {
        if (!active()) {
            return nullptr;
        }
        const uint32_t at = compare_tick(tick, playback_start_, interval, start_, end_, interval_);
        if (!frames_.empty()) {
            actor_.frame = frames_[std::min(size_t(at), frames_.size() - 1)];
            return &actor_;
        }
        if (!bh_ghost_frame(core_, handle_, at, &actor_.frame)) {
            return nullptr;
        }
        return &actor_;
    }

    Prepared detach(const std::atomic_bool *cancel = nullptr) {
        Prepared result;
        result.actor = actor_;
        result.start = start_;
        result.end = end_;
        result.playback_start = playback_start_;
        result.interval = interval_;
        result.finished = finished_;
        result.frames.resize(size_t(end_) + 1);
        for (uint32_t tick = 0; tick <= end_; ++tick) {
            if (cancel && cancel->load(std::memory_order_relaxed)) {
                clear();
                return {};
            }
            if (!bh_ghost_frame(core_, handle_, tick, &result.frames[tick])) {
                throw std::runtime_error("Could not prepare compare path");
            }
        }
        clear();
        return result;
    }

    void adopt(Prepared result) {
        clear();
        frames_ = std::move(result.frames);
        actor_ = std::move(result.actor);
        start_ = result.start;
        end_ = result.end;
        playback_start_ = result.playback_start;
        interval_ = result.interval;
        finished_ = result.finished;
    }

    void name(const std::string &value) {
        if (value.size() > 512) throw std::runtime_error("Compare name is too long");
        actor_.name = value;
    }

    // Seconds this replay is behind (positive) or ahead of the compared run where it stands at `tick`: the compared
    // run's time at the point of its path nearest to `position`, as the website's viewer measures it (ghost.ts split).
    std::optional<double> delta(uint32_t tick, double playback_interval, const float position[3]) const {
        constexpr uint32_t search_ticks = 300;
        constexpr float match_radius_units = 128;
        if (frames_.empty() || tick < playback_start_ || playback_interval <= 0) return std::nullopt;
        const uint32_t expected = compare_tick(tick, playback_start_, playback_interval, start_, end_, interval_);
        const uint32_t low = std::max(start_, expected > search_ticks ? expected - search_ticks : 0);
        const uint32_t high = std::min(uint32_t(frames_.size() - 1), std::min(end_, expected + search_ticks));
        float best = match_radius_units * match_radius_units;
        std::optional<uint32_t> nearest;
        for (uint32_t at = low; at <= high; ++at) {
            float squared = 0;
            for (int axis = 0; axis < 3; ++axis) {
                const float offset = frames_[at].position[axis] - position[axis];
                squared += offset * offset;
            }
            if (squared < best) {
                best = squared;
                nearest = at;
            }
        }
        if (!nearest) return std::nullopt;
        return (tick - playback_start_) * playback_interval - (*nearest - start_) * interval_;
    }

    nlohmann::json menu_state(double playback_interval, uint32_t tick = 0, const float *position = nullptr) const {
        if (!active()) return nullptr;
        const auto difference = position ? delta(tick, playback_interval, position) : std::nullopt;
        const double finish =
                playback_interval > 0 ? playback_start_ + (end_ - start_) * interval_ / playback_interval : 0;
        return {{"kind",
                 actor_.source == native_render::GhostSource::pb   ? "pb"
                 : actor_.source == native_render::GhostSource::wr ? "wr"
                                                                   : "custom"},
                {"name", actor_.name},
                {"endTick",
                 finished_ ? nlohmann::json(uint32_t(std::max(0., std::round(finish)))) : nlohmann::json(nullptr)},
                {"delta", difference ? nlohmann::json(*difference) : nlohmann::json(nullptr)}};
    }

    bool active() const { return handle_ != 0 || !frames_.empty(); }

    nlohmann::json state() const {
        if (!active()) {
            return nullptr;
        }
        return {{"name", actor_.name},
                {"startTick", start_},
                {"endTick", end_},
                {"source",
                 actor_.source == native_render::GhostSource::pb   ? "pb"
                 : actor_.source == native_render::GhostSource::wr ? "wr"
                                                                   : "custom"}};
    }
};

template <class Renderer>
void update_compare_actor(
        Renderer &renderer, ReplayCompare &compare, uint32_t tick, const ReplayRange &range, bool playback
) {
    renderer.set_compare_actor(playback ? compare.sample(tick, range.tick_interval) : nullptr);
}

inline void handle_replay_compare(
        ReplayCompare &compare,
        BhContext *core,
        const std::filesystem::path &directory,
        const nlohmann::json &message,
        const nlohmann::json &playback,
        const std::atomic_bool *cancel = nullptr
) {
    const auto action = message.at("action").get<std::string>();
    if (action == "clear") {
        compare.clear();
        return;
    }
    if (action != "set") throw std::runtime_error("Unknown replay compare action");
    const auto id = message.at("id").get<std::string>();
    if (id.empty() || id.size() > 200 || std::filesystem::path(id).filename() != id
        || std::filesystem::path(id).extension() != ".bhr")
        throw std::runtime_error("Invalid compare replay id");
    const auto source = message.value("source", std::string("custom"));
    native::graphics_choice(source, {"pb", "wr", "custom"});
    compare.load(core, (directory / id).string(), native_render::ghost_source(source), playback, cancel);
}

template <class Slots>
void sync_ghost_visibility(auto &renderer, const Slots &slots) {
    for (unsigned slot = 0; slot < slots.size(); ++slot)
        renderer.ghost_enabled(slot, slots[slot].enabled);
}

inline void
set_requested_ghost_source(std::array<native_render::GhostSource, 4> &sources, const nlohmann::json &message) {
    const unsigned slot = message.value("ghostSlot", 0u);
    if (slot >= sources.size()) throw std::runtime_error("Invalid ghost slot");
    const auto source = message.value("source", std::string("custom"));
    if (source != "pb" && source != "wr" && source != "custom") throw std::runtime_error("Invalid ghost source");
    sources[slot] = native_render::ghost_source(source);
}

}  // namespace native
