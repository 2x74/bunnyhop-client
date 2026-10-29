#include "replay_player.hpp"
#include "data_location.hpp"
#include <stdexcept>

namespace native {

void ReplayPlayer::begin(const std::filesystem::path &file) {
    active = true;
    paused = false;
    speed = 1;
    controls = {};
    controls.first_tick = session.range.from;
    camera.set_mode("eye");
    orbit_drag = false;
    id = data_location::utf8(file.filename());
    path = file;
}

void ReplayPlayer::action(ReplayControls::Action action, uint32_t tick, Input &camera_controls) {
    if (controls.action(action, tick, session.range, paused, speed)) {
        const auto mode = camera.mode == "eye" ? "chase" : camera.mode == "chase" ? "free" : "eye";
        camera.set_mode(mode);
        camera_controls.set_angles(camera.pitch, camera.yaw);
        camera_controls.clear();
    }
}

nlohmann::json ReplayPlayer::state(uint32_t tick, double seconds, double fallback_interval) const {
    return session.state(active, id, tick, paused, speed, camera.mode, seconds, fallback_interval);
}

ReplayMetadata::ReplayMetadata() : core_(bh_create(), bh_destroy) {
}

nlohmann::json ReplayMetadata::read(const std::filesystem::path &path) {
    size_t bytes = 0;
    const char *json = bh_replay_header(core_.get(), data_location::utf8(path).c_str(), &bytes);
    if (!json) {
        const char *error = bh_last_error(core_.get());
        throw std::runtime_error(
                std::string("Reading replay header: ") + (error && *error ? error : "native core failed")
        );
    }
    return nlohmann::json::parse(json, json + bytes);
}

}  // namespace native
