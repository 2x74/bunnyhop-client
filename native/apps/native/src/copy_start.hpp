#pragma once
#include "atomic_replace.hpp"
#include "base64.hpp"
#include "data_location.hpp"
#include "latest_worker.hpp"
#include "restart_placement.hpp"
#include "room_styles.hpp"
#include <algorithm>
#include <filesystem>
#include <memory>

namespace native {
struct CopiedStart {
    StartPoint point;
    uint32_t track = 0, tick = 0;

    bool restart_now(uint32_t timer_status, bool mode_locked, uint32_t current_track) const {
        return timer_status != 1 && (!mode_locked || track == current_track);
    }

    bool save(StartPoints &points, const std::string &map, const std::vector<BhZone> &zones) const {
        BhState state{};
        std::copy(point.position.begin(), point.position.end(), state.position);
        const auto plan = plan_start_point(state, zones, track, false);
        if (plan.practice) return false;
        points.save(map, track, plan.state, point.yaw, point.pitch);
        return true;
    }
};

inline nlohmann::json copy_start_reply(uint64_t id, const std::string &text, bool ok) {
    return {{"id", id}, {"text", text}, {"ok", ok}};
}

inline std::string copy_start_script(uint64_t id, const std::string &text, bool ok) {
    return "window.bunnyhopNativeMenu?.onCopyStartResult?.(" + copy_start_reply(id, text, ok).dump() + ")";
}

inline std::string copied_start_message(const std::string &who, uint32_t track, bool restarted) {
    const auto where = track ? " for Bonus " + std::to_string(track) : "";
    return "Copied " + who + "'s start point" + where + (restarted ? "" : ". Restart to use it");
}

inline void copy_start_check(BhContext *core, int ok) {
    if (!ok) throw std::runtime_error(core ? bh_last_error(core) : "No Copy start context.");
}

// Only the worker's private context is changed. Checkpoints past the start must
// agree before the extracted position is trusted.
inline CopiedStart run_start_point(
        BhContext *core,
        const std::filesystem::path &replay,
        const std::string &map,
        const std::vector<BhZone> &zones,
        const std::atomic_bool &cancelled
) {
    size_t size = 0;
    const auto path = data_location::utf8(replay);
    const auto *raw = bh_replay_header(core, path.c_str(), &size);
    if (!raw) throw std::runtime_error(bh_last_error(core));
    const auto info = nlohmann::json::parse(raw, raw + size);
    if (info.at("map") != map) throw std::runtime_error("That run is on another map.");
    const auto start = info.at("startTick").get<uint32_t>();
    if (!start) throw std::runtime_error("That run never left the start zone.");
    copy_start_check(core, bh_replay_load(core, path.c_str()));
    const auto track = info.at("track").get<uint32_t>();
    const auto total = info.at("totalTicks").get<uint32_t>();
    const auto recorded_interval = info.value("checkpointInterval", 100u);
    const auto interval = recorded_interval ? recorded_interval : 100u;
    const auto until = uint32_t(std::min(uint64_t(total), uint64_t(start) + interval));
    BhState initial{};
    copy_start_check(core, bh_state(core, &initial));
    std::optional<CopiedStart> found;
    if (!initial.crouched && std::hypot(std::hypot(initial.velocity[0], initial.velocity[1]), initial.velocity[2]) <= 1
        && start_point_in_zone(initial, zones, track)) {
        const auto yaw =
                info.at("spawn").is_null() ? initial.teleport_angles[1] : info.at("spawn").at("yaw").get<float>();
        found = CopiedStart{
                StartPoint{{initial.position[0], initial.position[1], initial.position[2]}, yaw, 0, false}, track, 0
        };
    }
    for (uint32_t tick = 1; tick <= until && !cancelled; ++tick) {
        BhSnapshot state{};
        if (!bh_replay_step(core, &state))
            throw std::runtime_error(
                    "That run doesn't play back exactly in this version, so its start can't be copied."
            );
        BhCmd view{};
        copy_start_check(core, bh_last_command(core, &view));
        if (tick == 1 && found) found->point.pitch = view.pitch;
        const auto &player = state.player;
        if (tick <= start && start_point_problem(player, false).empty() && start_point_in_zone(player, zones, track))
            found = CopiedStart{
                    StartPoint{
                            {player.position[0], player.position[1], player.position[2]}, view.yaw, view.pitch, false
                    },
                    track,
                    tick
            };
    }
    if (cancelled) throw std::runtime_error("Copy start cancelled.");
    if (!found)
        throw std::runtime_error("That run never stood still in the start zone, so it has no start point to copy.");
    const double yaw = found->point.yaw;
    found->point.yaw = float(std::fmod(std::fmod(yaw, 360.) + 360., 360.));
    found->point.pitch = std::clamp(found->point.pitch, -89.f, 89.f);
    return *found;
}

inline void validate_copied_start(
        BhContext *core,
        const std::string &map,
        const std::string &style,
        const std::vector<BhZone> &zones,
        const CopiedStart &copy
) {
    copy_start_check(core, bh_replay_stop(core));
    copy_start_check(core, bh_style_set(core, copy.track ? "autohop" : style.c_str()));
    copy_start_check(core, bh_reset(core));
    const auto placement = RestartPlacement::at(core, map, copy.track, copy.point);
    if (!start_point_landed(placement.state, copy.point) || !start_point_in_zone(placement.state, zones, copy.track))
        throw std::runtime_error("That run's start isn't a spot a restart can use any more.");
    BhCmd command{};
    command.yaw = copy.point.yaw;
    BhState stepped{};
    copy_start_check(core, bh_step(core, &command, &stepped));
    constexpr uint32_t teleported = 1u << 0;
    if ((!stepped.grounded || stepped.on_ladder) && !(stepped.events & teleported))
        throw std::runtime_error("That run's start isn't a spot a restart can use any more.");
}

class CopyStartImports {
public:
    struct Result {
        uint64_t id = 0;
        std::string map, style, who, error;
        std::optional<CopiedStart> start;
    };

    void reset() { worker_.cancel(); }

    void
    request(const nlohmann::json &message,
            const std::string &map,
            const std::string &style,
            const std::string &path,
            const std::string &content,
            const std::filesystem::path &cache,
            const std::vector<BhZone> &zones) {
        const auto id = message.at("id").get<uint64_t>();
        const auto who = message.at("who").get<std::string>();
        if (message.at("map") != map || message.at("style") != style)
            throw std::runtime_error("The map or style changed. Try Copy start again.");
        if (!id || who.size() > 512) throw std::runtime_error("Invalid Copy start request.");
        const auto body = message.at("replayBase64").get<std::string>();
        worker_.submit([id, who, body, map, style, path, content, cache, zones](const std::atomic_bool &cancelled) {
            Result result{id, map, style, who, {}, {}};
            try {
                const auto decoded = base64_decode(body);
                if (!decoded || decoded->empty() || decoded->size() > (8u << 20))
                    throw std::runtime_error("Invalid Copy start replay.");
                const auto &bytes = *decoded;
                char digest[65]{};
                if (!bh_sha256(reinterpret_cast<const uint8_t *>(bytes.data()), bytes.size(), digest))
                    throw std::runtime_error("Invalid Copy start replay.");
                const auto replay = cache / "copy-start" / (std::string(digest) + ".bhr");
                std::filesystem::create_directories(replay.parent_path());
                atomic_write_file(replay, std::string_view(reinterpret_cast<const char *>(bytes.data()), bytes.size()));
                std::unique_ptr<BhContext, decltype(&bh_destroy)> core(bh_create(), bh_destroy);
                copy_start_check(
                        core.get(),
                        core
                                && bh_load_map_cancellable(
                                        core.get(),
                                        path.c_str(),
                                        content.empty() ? nullptr : content.c_str(),
                                        replay_cancelled,
                                        const_cast<std::atomic_bool *>(&cancelled)
                                )
                );
                const auto copy = run_start_point(core.get(), replay, map, zones, cancelled);
                validate_copied_start(core.get(), map, style, zones, copy);
                result.start = copy;
            } catch (const std::exception &error) {
                result.error = error.what();
            }
            return result;
        });
    }

    std::optional<Result> take(const std::string &map, const std::string &style) {
        auto result = worker_.take();
        if (result && (result->map != map || result->style != style)) {
            result->start.reset();
            result->error = "The map or style changed. Try Copy start again.";
        }
        return result;
    }

private:
    LatestWorker<Result> worker_;
};
}  // namespace native
