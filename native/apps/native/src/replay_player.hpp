#pragma once
#include "replay_session.hpp"
#include "replay_controls.hpp"
#include "replay_camera.hpp"
#include <algorithm>
#include <cmath>
#include "runner_view.hpp"
#include <memory>
#include <optional>

namespace native {

struct ReplayPlayer {
    struct Loop {
        uint32_t from = 0, to = 0;
    };

    ReplaySession session;
    ReplayControls controls;
    ReplayCamera camera;
    std::string id;
    std::filesystem::path path;
    // The runner's look, shown on the player model in third person.
    std::string runner_outfit, runner_loadout;
    bool active = false, paused = false, failed = false, orbit_drag = false;
    // The weapon in hand (V) in-eye and in third person, and the viewer's HUD switch (H).
    bool weapon_eye = true, weapon_third = true, hud = true;
    // The menu shows the viewer (ui_open) and is on screen (ui_shown, each frame): playback runs and the runner's HUD
    // draws under it, like the website's viewer.
    bool ui_open = false, ui_shown = false;
    // The viewer's title bar and bottom panel in CSS pixels: the HUD under it lays out between them.
    double ui_top = 0, ui_bottom = 0;
    double speed = 1;
    // Playback returns to `from` on reaching `to`.
    std::optional<Loop> loop;
    // "Runner's view": the replay drawn in the runner's shape, fit and FOV (replayControl runnerView).
    std::optional<RunnerView> runner_view;

    void begin(const std::filesystem::path &file);
    void action(ReplayControls::Action action, uint32_t tick, Input &camera_controls);
    nlohmann::json state(uint32_t tick, double seconds, double fallback_interval) const;

    bool weapon_shown() const { return camera.third_person() ? weapon_third : weapon_eye; }

    void toggle_weapon();
    // {from, to} in absolute ticks inside the shown range, or null to stop looping.
    void set_loop(const nlohmann::json &value);
    // Once per frame: a loop that reached its end starts again.
    void wrap_loop(uint32_t tick);
    // Once per replay tick: the command the runner looked with, for smooth angles between ticks.
    void record_view(const BhCmd &command, uint32_t tick);
    // The runner's position and view drawn `blend` of the way from the previous tick to the current one, so the
    // camera moves smoothly at any frame rate and playback speed.
    void smooth(BhState &shown, const BhState &previous, const BhState &current, float blend, Input &view) const;
    // The menu's viewer message: open or closed, and the space its bars take.
    void viewer_ui(const nlohmann::json &message);

    // The HUD's area (hud_area.hpp HudArea) without the viewer's bars while it is on screen.
    template <class Area>
    Area hud_area(Area area, int window_height, float pixel_density) const {
        if (!ui_shown) return area;
        const double density = pixel_density > 0 ? pixel_density : 1;
        const int top = std::max(area.top, int(std::lround(ui_top * density)));
        const int bottom = std::min(area.top + area.height, window_height - int(std::lround(ui_bottom * density)));
        if (bottom - top < area.height / 3) return area;
        area.top = top;
        area.height = bottom - top;
        return area;
    }

private:
    BhCmd view_from_{}, view_to_{};
    uint32_t view_tick_ = 0;
    bool view_continuous_ = false;
};

class ReplayMetadata {
public:
    ReplayMetadata();
    nlohmann::json read(const std::filesystem::path &path);

private:
    std::unique_ptr<BhContext, decltype(&bh_destroy)> core_;
};

}  // namespace native
