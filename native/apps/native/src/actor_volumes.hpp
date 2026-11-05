#pragma once
// Swimming and climbing for the bunnies of players whose data lacks it (web ghost.ts sample, net/players.ts), from
// the loaded map's volumes (map_volumes.hpp): a ghost's water level, and another player's ladder and water level.
// Your own bunny and the replay viewer's carry the simulation's own state and are left alone. The volumes are read
// on a worker when a map loads; until they arrive nobody swims or climbs from them.
#include "map_jobs.hpp"
#include "map_volumes.hpp"
#include "render_shaders.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <span>
#include <string>
#include <unordered_map>

namespace native {

class ActorVolumes {
public:
    static constexpr uint32_t crouched_flag = 1, grounded_flag = 2, ladder_flag = 4;

    // Starts reading `bsp`'s volumes on a worker.
    void load(const std::filesystem::path &bsp) {
        loading_.cancel();
        volumes_.reset();
        guesses_.clear();
        loading_.start([bsp](const std::atomic_bool &) { return read(bsp); });
    }

    // Takes the worker's result once it's there (never waits).
    void poll() {
        loading_.poll();
        if (!loading_.valid() || loading_.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return;
        try {
            volumes_ = loading_.get();
        } catch (const std::exception &error) {
            std::cerr << "Map water and ladders: " << error.what() << '\n';
        }
    }

    void use(std::shared_ptr<const MapVolumes> volumes) { volumes_ = std::move(volumes); }

    const MapVolumes *volumes() const { return volumes_.get(); }

    // This frame's room: ghosts get their water level, other players their ladder and water level. `seconds` is the
    // frame's clock, which the ladder guess measures accelerations on.
    void annotate(std::span<native_render::Actor> actors, double seconds) {
        if (!volumes_) return;
        frame_++;
        for (auto &actor : actors) {
            if (actor.ghost_slot >= 0)
                annotate_recorded(actor);
            else if (actor.id != native_render::own_actor_id)
                annotate_remote(actor, seconds);
        }
        std::erase_if(guesses_, [this](const auto &entry) { return entry.second.seen != frame_; });
    }

    // A recorded frame (a ghost, the replay's compare ghost): its own ladder bit, the water from the map.
    void annotate_recorded(native_render::Actor &actor) const {
        if (!volumes_) return;
        const bool crouched = actor.frame.flags & crouched_flag;
        actor.waterLevel = uint32_t(volumes_->recorded_water_level(actor.frame.position, crouched));
    }

private:
    struct Guess {
        LadderGuess ladder;
        uint64_t seen = 0;
    };

    MapJobs<std::shared_ptr<const MapVolumes>> loading_;
    std::shared_ptr<const MapVolumes> volumes_;
    std::unordered_map<std::string, Guess> guesses_;
    uint64_t frame_ = 0;

    static std::shared_ptr<const MapVolumes> read(const std::filesystem::path &bsp) {
        std::ifstream file(bsp, std::ios::binary);
        const auto lumps = BspVolumeLumps::read(file);
        return lumps ? std::make_shared<const MapVolumes>(*lumps) : std::make_shared<const MapVolumes>();
    }

    void annotate_remote(native_render::Actor &actor, double seconds) {
        auto &guess = guesses_[actor.id];
        guess.seen = frame_;
        const bool crouched = actor.frame.flags & crouched_flag, grounded = actor.frame.flags & grounded_flag;
        const auto &frame = actor.frame;
        const bool climbing =
                guess.ladder.update(frame.position, frame.velocity, crouched, grounded, seconds, *volumes_);
        actor.frame.flags = climbing ? actor.frame.flags | ladder_flag : actor.frame.flags & ~ladder_flag;
        actor.waterLevel = uint32_t(volumes_->recorded_water_level(frame.position, crouched));
    }
};

}  // namespace native
