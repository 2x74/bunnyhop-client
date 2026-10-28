#pragma once
#include "audio.hpp"
#include "video_export.hpp"
#include <memory>
#include <stdexcept>

namespace native {
// Audio advances at simulation tick boundaries, independently of render FPS.
// Pre-roll from tick zero preserves cue variants, movement history and tails
// crossing a trimmed start. Only the selected interval enters the PCM spool.
class ReplayAudioTrack {
    Audio mixer;
    BhContext *bound_core = nullptr;
    uint64_t cursor = 0, start = 0, end = 0;
    std::vector<float> pending;
    bool gameplay = true;

public:
    ReplayAudioTrack(
            const std::filesystem::path &assets,
            const std::filesystem::path &cache,
            const nlohmann::json &prefs,
            const std::string &style,
            const VideoOptions &options
    )
        : mixer(assets, cache, AudioMode::offline)
        , start(VideoTimeline::sample_frame(options.from * options.tick_interval, Audio::sample_rate))
        , end(start
              + VideoTimeline::sample_frame((options.to - options.from) * options.tick_interval, Audio::sample_rate)) {
        if (!mixer.load_error().empty())
            throw std::runtime_error("Cannot load replay export sounds: " + mixer.load_error());
        gameplay = options.audio;
        mixer.preferences(prefs);
        mixer.set_sfx_pack(prefs.value("sfxPack", std::string()) == "custom");
        mixer.set_style(style);
        mixer.reset();
        if (options.music != "none")
            mixer.export_music(
                    prefs.value("musicPack", std::string()) == "custom",
                    options.music,
                    start,
                    end,
                    options.music_offset,
                    options.music_level,
                    options.music_loop,
                    options.music_duck && gameplay
            );
    }

    void render_to(uint64_t target) {
        target = std::min(target, end);
        if (target < cursor) throw std::runtime_error("Replay export audio moved backwards.");
        while (cursor < target) {
            const auto boundary = cursor < start ? std::min(target, start) : target;
            const size_t frames = size_t(std::min(uint64_t(2048), boundary - cursor));
            auto samples = mixer.render_samples(frames, gameplay);
            if (samples.size() != frames * 2)
                throw std::runtime_error("Replay audio mixer returned incomplete samples.");
            if (cursor >= start) {
                if (pending.size() + samples.size() > Audio::sample_rate * 4)
                    throw std::runtime_error("Replay audio packet exceeded its bounded buffer.");
                pending.insert(pending.end(), samples.begin(), samples.end());
            }
            cursor += frames;
        }
    }

    void before_tick(uint32_t tick, double interval) {
        render_to(VideoTimeline::sample_frame(tick * interval, Audio::sample_rate));
    }

    void
    tick(const BhSnapshot &snapshot,
         const BhRunState &run,
         const BhWeaponReport &weapon,
         const BhAttackReport *attack,
         double interval,
         const std::string &surface,
         double water,
         const BhJumpObservation *observation = nullptr) {
        mixer.tick(snapshot, run, weapon, attack, interval, surface, water, observation);
    }

    void tick(BhContext *core, const BhSnapshot &snapshot, double interval) {
        if (!bound_core) {
            mixer.set_map(core);
            bound_core = core;
        }
        BhRunState run{};
        BhWeaponReport weapon{};
        BhAttackReport attack{};
        BhSurfaceProbe surface{};
        surface.water_z = NAN;
        if (!bh_run_state(core, &run) || !bh_weapon_report(core, &weapon))
            throw std::runtime_error("Cannot read replay export audio state.");
        const auto &p = snapshot.player;
        const bool found = bh_surface_at(core, p.position[0], p.position[1], p.position[2], &surface) != 0;
        static const std::array<const char *, 6> surfaces = {"concrete", "metal", "wood", "grass", "tile", "water"};
        BhJumpObservation observation{};
        const bool observed = bh_jump_observation(core, &observation) != 0;
        tick(snapshot,
             run,
             weapon,
             bh_attack_report(core, &attack) ? &attack : nullptr,
             interval,
             surfaces[std::clamp(surface.surface, 0, 5)],
             found ? surface.water_z - p.position[2] : NAN,
             observed ? &observation : nullptr);
    }

    void finish() { render_to(end); }

    std::vector<float> take() {
        std::vector<float> result;
        result.swap(pending);
        return result;
    }
};
}  // namespace native
