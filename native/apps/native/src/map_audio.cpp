#include "map_audio.hpp"
#include "map_audio_scene.hpp"
#include <iostream>

namespace native {
MapAudio::MapAudio() = default;
MapAudio::~MapAudio() = default;

void MapAudio::stop() {
    loading.cancel();
    pending.reset();
    std::lock_guard lock(mixer.mutex);
    mixer.clear();
    scene.reset();
}

void MapAudio::start(BhContext *core, const std::filesystem::path &bsp, const std::filesystem::path &content_root) {
    stop();
    if (!core) return;
    try {
        size_t count = 0;
        const char *data = bh_entities_json(core, &count);
        const std::string entities(data ? data : "[]", data ? count : 2);
        data = bh_models_json(core, &count);
        const std::string models(data ? data : "[]", data ? count : 2);
        pending = std::make_shared<MapAudioLoad>();
        loading.start([bsp, content_root, entities, models, publication = pending](const std::atomic_bool &cancel) {
            load_map_audio(bsp, content_root, entities, models, cancel, publication.get());
        });
    } catch (const std::exception &error) {
        std::cerr << "Map sounds: " << error.what() << '\n';
    }
}

void MapAudio::preferences(float slider, bool mute) {
    const float next = slider <= 0 ? 0 : std::pow(std::min(1.f, slider), map_slider_exponent);
    if (gain == next && muted == mute) return;
    gain = next;
    muted = mute;
    std::lock_guard lock(mixer.mutex);
    if (scene) scene->last_assign = -1;
    if (muted || gain <= 0) mixer.clear();
}

void MapAudio::frame(
        BhContext *core, const float listener[3], double yaw, double pitch, double now, bool live, bool audible
) {
    loading.poll();
    if (loading.valid() && loading.wait_for(std::chrono::seconds(0)) == std::future_status::ready) loading.get();
    if (!scene && pending && pending->published.load(std::memory_order_acquire)) {
        std::lock_guard lock(mixer.mutex);
        scene = pending->scene;
        if (scene) {
            for (auto &sound : scene->sounds) {
                if (sound.used) sound.started = now;
            }
        }
    }
    if (!scene) return;
    std::lock_guard lock(mixer.mutex);
    const MapPoint position{listener[0], listener[1], listener[2]};
    scene->frame(core, mixer, position, yaw, now, live, audible && !muted ? gain : 0, pitch);
}
}  // namespace native
