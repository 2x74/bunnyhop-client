#pragma once
#include "bunnyhop_native.h"
#include "map_audio_mix.hpp"
#include "map_jobs.hpp"
#include <filesystem>
#include <memory>
#include <string>

namespace native {
class MapAudioScene;
struct MapAudioLoad;

// Map data is prepared on a worker; frame() only reads typed simulation observations and reuses fixed slots.
class MapAudio {
public:
    MapAudio();
    ~MapAudio();
    MapAudio(const MapAudio &) = delete;
    MapAudio &operator=(const MapAudio &) = delete;
    void start(BhContext *core, const std::filesystem::path &bsp, const std::filesystem::path &content_root);
    void stop();
    void frame(BhContext *core, const float listener[3], double yaw, double pitch, double now, bool live, bool audible);
    void preferences(float slider, bool muted);
    MapAudioMixer mixer;

private:
    MapJobs<void> loading;
    std::shared_ptr<MapAudioLoad> pending;
    std::shared_ptr<MapAudioScene> scene;
    float gain = 0;
    bool muted = false;
};
}  // namespace native
