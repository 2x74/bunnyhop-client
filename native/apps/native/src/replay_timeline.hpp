#pragma once
#include "bunnyhop_native.h"
#include "latest_worker.hpp"
#include "data_location.hpp"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace native {
struct ReplayTimelineData {
    struct Split {
        uint32_t tick = 0, index = 0;
        bool checkpoint = false;
    };
    uint32_t step = 1, start = 0, end = 0;
    std::vector<float> speeds;
    std::vector<uint32_t> jumps;
    std::vector<Split> splits;
    std::optional<uint32_t> desync;
    void sample(uint32_t tick, const BhState &state) {
        const size_t bin = tick / step;
        if (bin >= speeds.size())
            speeds.resize(bin + 1);
        const float speed = std::hypot(state.velocity[0], state.velocity[1]);
        if (std::isfinite(speed))
            speeds[bin] = std::max(speeds[bin], speed);
        constexpr uint32_t jumped = 1u << 1;
        if (state.events & jumped)
            jumps.push_back(tick);
    }
    nlohmann::json json(const std::string &id) const {
        auto marks = nlohmann::json::array();
        for (const auto &split : splits) {
            marks.push_back(
                {{"tick", split.tick}, {"kind", split.checkpoint ? "checkpoint" : "stage"}, {"index", split.index}});
        }
        return {{"id", id},
                {"firstTick", 0},
                {"step", step},
                {"speed", speeds},
                {"jumps", jumps},
                {"splits", std::move(marks)},
                {"startTick", start},
                {"endTick", end},
                {"desyncTick", desync ? nlohmann::json(*desync) : nlohmann::json(nullptr)}};
    }
};
inline std::vector<BhZone> timeline_zones(const nlohmann::json &info) {
    std::vector<BhZone> zones;
    for (const auto &raw : info.at("zones")) {
        const auto kind = raw.value("kind", std::string());
        if (kind != "stage" && kind != "checkpoint")
            continue;
        BhZone zone{};
        zone.kind = kind == "stage" ? 2 : 3;
        zone.index = raw.value("index", 0u);
        zone.track = raw.value("track", 0u);
        for (size_t axis = 0; axis < 3; ++axis) {
            zone.mins[axis] = raw.at("mins").at(axis);
            zone.maxs[axis] = raw.at("maxs").at(axis);
        }
        zones.push_back(zone);
    }
    return zones;
}
inline void timeline_split(ReplayTimelineData &timeline, const BhState &state, const BhRunState &run,
                           const std::vector<BhZone> &zones, int64_t &last_index) {
    // The core decides that a split occurred; bounds only identify its display label.
    constexpr uint32_t split_update = 16;
    if (!run.split_count)
        last_index = -1;
    if (!(run.update_flags & split_update))
        return;
    constexpr float radius = 16, standing_height = 62, crouched_height = 45;
    for (const auto &zone : zones) {
        if (zone.track != run.track || int64_t(zone.index) <= last_index)
            continue;
        const float height = state.crouched ? crouched_height : standing_height;
        if (state.position[0] - radius > zone.maxs[0] || state.position[0] + radius < zone.mins[0] ||
            state.position[1] - radius > zone.maxs[1] || state.position[1] + radius < zone.mins[1] ||
            state.position[2] > zone.maxs[2] || state.position[2] + height < zone.mins[2])
            continue;
        timeline.splits.push_back({state.tick, zone.index, zone.kind == 3});
        last_index = zone.index;
        break;
    }
}
inline ReplayTimelineData build_replay_timeline(const std::filesystem::path &map, const std::filesystem::path &content,
                                                const std::filesystem::path &replay, const std::atomic_bool &cancel) {
    std::unique_ptr<BhContext, decltype(&bh_destroy)> core(bh_create(), &bh_destroy);
    if (!core ||
        !bh_load_map_cancellable(core.get(), data_location::utf8(map).c_str(),
                     content.empty() ? nullptr : data_location::utf8(content).c_str(),
                     replay_cancelled, const_cast<std::atomic_bool *>(&cancel)) ||
        cancel.load(std::memory_order_relaxed) ||
        !bh_replay_load(core.get(), data_location::utf8(replay).c_str())) {
        throw std::runtime_error(core ? bh_last_error(core.get()) : "No timeline context");
    }
    size_t bytes = 0;
    const auto *raw = bh_replay_info(core.get(), &bytes);
    if (!raw)
        throw std::runtime_error("Missing timeline replay metadata");
    const auto info = nlohmann::json::parse(raw, raw + bytes);
    const uint32_t total = info.at("totalTicks");
    constexpr uint32_t maximum_ticks = 1000000, maximum_bins = 4096;
    if (total > maximum_ticks)
        throw std::runtime_error("Timeline exceeds replay tick limit");
    ReplayTimelineData timeline;
    timeline.step = std::max(1u, (total + maximum_bins) / maximum_bins);
    timeline.start = info.value("startTick", 0u);
    timeline.end = info.value("endTick", 0u);
    timeline.speeds.reserve(total / timeline.step + 1);
    const auto zones = timeline_zones(info);
    BhSnapshot state{};
    if (!bh_snapshot(core.get(), &state))
        throw std::runtime_error(bh_last_error(core.get()));
    timeline.sample(0, state.player);
    int64_t last_split = -1;
    for (uint32_t tick = 1; tick <= total && !cancel.load(std::memory_order_relaxed); ++tick) {
        if (!bh_replay_step(core.get(), &state)) {
            timeline.desync = tick;
            break;
        }
        timeline.sample(tick, state.player);
        BhRunState run{};
        if (bh_run_state(core.get(), &run))
            timeline_split(timeline, state.player, run, zones, last_split);
    }
    return timeline;
}
class ReplayTimelineService {
    struct Result {
        std::string id, script, error;
    };
    std::filesystem::path map_, content_;
    LatestWorker<Result> worker_;
    std::optional<Result> ready_;

  public:
    void reset() {
        worker_.cancel();
        ready_.reset();
    }
    void map(const std::filesystem::path &map, const std::filesystem::path &content) {
        reset();
        map_ = map;
        content_ = content;
    }
    void request(const std::filesystem::path &replay, const std::string &id) {
        ready_.reset();
        worker_.submit([map = map_, content = content_, replay, id](const std::atomic_bool &cancelled) {
            Result result;
            result.id = id;
            try {
                const auto data = build_replay_timeline(map, content, replay, cancelled);
                if (!cancelled)
                    result.script = "window.bunnyhopNativeMenu?.onReplayTimeline?.(" + data.json(id).dump() + ")";
            } catch (const std::exception &error) {
                result.error = error.what();
            }
            return result;
        });
    }
    template <class Menu> void poll(Menu *menu, bool menu_ready, const std::string &id, bool playback) {
        if (!playback) {
            reset();
            return;
        }
        if (auto result = worker_.take()) {
            ready_ = std::move(*result);
            if (!ready_->error.empty())
                std::cerr << "Replay timeline: " << ready_->error << '\n';
        }
        if (ready_ && menu && menu_ready && playback && ready_->id == id) {
            if (!ready_->script.empty())
                menu->evaluate_js(ready_->script);
            ready_.reset();
        }
    }
};
} // namespace native
