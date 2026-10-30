#pragma once
#include "replay_session.hpp"
#include "replay_controls.hpp"
#include "replay_camera.hpp"
#include "runner_view.hpp"
#include <memory>

namespace native {

struct ReplayPlayer {
    ReplaySession session;
    ReplayControls controls;
    ReplayCamera camera;
    std::string id;
    bool active = false, paused = false, failed = false, orbit_drag = false;
    double speed = 1;
    // "Runner's view": the replay drawn in the runner's shape, fit and FOV (replayControl runnerView).
    std::optional<RunnerView> runner_view;

    void begin(const std::filesystem::path &path);
    void action(ReplayControls::Action action, uint32_t tick, Input &camera_controls);
    nlohmann::json state(uint32_t tick, double seconds, double fallback_interval) const;
};

class ReplayMetadata {
public:
    ReplayMetadata();
    nlohmann::json read(const std::filesystem::path &path);

private:
    std::unique_ptr<BhContext, decltype(&bh_destroy)> core_;
};

}  // namespace native
