#include "replay_player.hpp"
#include "data_location.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace native {

void ReplayPlayer::begin(const std::filesystem::path &file) {
    runner_view.reset();
    active = true;
    paused = false;
    speed = 1;
    controls = {};
    controls.first_tick = session.range.from;
    camera.set_mode("eye");
    orbit_drag = false;
    id = data_location::utf8(file.filename());
    path = file;
    loop.reset();
    hud = true;
    ui_open = false;
    view_continuous_ = false;
}

void ReplayPlayer::viewer_ui(const nlohmann::json &message) {
    constexpr double max_bar_css_pixels = 4000;
    ui_open = message.value("open", false);
    ui_top = std::clamp(message.value("top", 0.), 0., max_bar_css_pixels);
    ui_bottom = std::clamp(message.value("bottom", 0.), 0., max_bar_css_pixels);
}

void ReplayPlayer::toggle_weapon() {
    auto &shown = camera.third_person() ? weapon_third : weapon_eye;
    shown = !shown;
}

void ReplayPlayer::set_loop(const nlohmann::json &value) {
    if (value.is_null()) {
        loop.reset();
        return;
    }
    const Loop next{value.at("from").get<uint32_t>(), value.at("to").get<uint32_t>()};
    const auto &range = session.range;
    if (next.from < range.from || next.to > range.to || next.to <= next.from)
        throw std::runtime_error("Replay loop outside playback range");
    loop = next;
}

void ReplayPlayer::wrap_loop(uint32_t tick) {
    if (!active || !loop || controls.dragging || controls.pending || tick < loop->to) return;
    controls.pending = loop->from;
    paused = false;
}

void ReplayPlayer::record_view(const BhCmd &command, uint32_t tick) {
    view_continuous_ = tick == view_tick_ + 1;
    view_from_ = view_continuous_ ? view_to_ : command;
    view_to_ = command;
    view_tick_ = tick;
}

void ReplayPlayer::smooth(
        BhState &shown, const BhState &previous, const BhState &current, float blend, Input &view
) const {
    constexpr uint32_t teleported = 1;
    const auto mix = [blend](float from, float to) {
        return from + (to - from) * blend;
    };
    if (!(current.events & teleported) && previous.tick + 1 == current.tick) {
        for (int axis = 0; axis < 3; ++axis)
            shown.position[axis] = mix(previous.position[axis], current.position[axis]);
        shown.view_offset_z = mix(previous.view_offset_z, current.view_offset_z);
    }
    if (!view_continuous_ || view_tick_ != current.tick) return;
    const double yaw_delta = std::remainder(double(view_to_.yaw - view_from_.yaw), 360.);
    view.set_angles(mix(view_from_.pitch, view_to_.pitch), view_from_.yaw + yaw_delta * blend, 5);
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
    auto result = session.state(active, id, tick, paused, speed, camera.mode, seconds, fallback_interval);
    result["weapon"] = weapon_shown();
    result["hud"] = hud;
    result["loop"] = loop ? nlohmann::json{{"from", loop->from}, {"to", loop->to}} : nlohmann::json(nullptr);
    return result;
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
