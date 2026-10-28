#pragma once
#include "bunnyhop_native.h"
#include "replay_controls.hpp"
#include "render_menu_contracts.hpp"
#include "video_controller.hpp"
#include "replay_camera.hpp"
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace native {

class Renderer;
class VideoCapture;
class ReplayDirectorJob;
class Audio;
struct PracticeController;

class GameSession {
public:
    using CorePtr = std::unique_ptr<BhContext, decltype(&bh_destroy)>;

    struct PreparedMap {
        CorePtr core{nullptr, &bh_destroy};
        std::vector<BhZone> zones;
    };

    explicit GameSession(ReplayCamera &playback_camera);
    ~GameSession();
    GameSession(const GameSession &) = delete;
    GameSession &operator=(const GameSession &) = delete;

    CorePtr core{nullptr, &bh_destroy};
    std::unique_ptr<Renderer> renderer;
    std::vector<BhZone> zones;
    std::string map_id;
    ReplayCompare replay_compare;
    ReplayTimelineService replay_timeline;
    ReplayCompareImportService replay_compare_import;
    VideoController video;

    static PreparedMap
    prepare(const std::string &path,
            const std::string &content,
            const BhSettings &settings,
            const nlohmann::json &detail);
    void prepare_workers(const std::string &path, const std::string &content);
    void install(CorePtr next, std::unique_ptr<Renderer> next_renderer, PracticeController &practice, Audio &audio);
    void configure_timer();
    void restart(const std::string &style);
    void leave(PracticeController &practice);

private:
    void release();
};

}  // namespace native
