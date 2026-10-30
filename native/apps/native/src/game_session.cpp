#include "game_session.hpp"
#include "renderer.hpp"
#include "hud.hpp"
#include "video_capture.hpp"
#include "practice_controller.hpp"
#include "audio.hpp"
#include "data_location.hpp"
#include <stdexcept>

namespace native {
namespace {

void require(bool ok, BhContext *core, const char *operation) {
    if (!ok) {
        const char *error = bh_last_error(core);
        throw std::runtime_error(std::string(operation) + ": " + (error && *error ? error : "native core failed"));
    }
}

std::vector<BhZone> timer_zones(const nlohmann::json &detail) {
    std::vector<BhZone> out;
    if (!detail.contains("zones") || !detail["zones"].is_object()) return out;
    for (const auto &z : detail["zones"].value("zones", nlohmann::json::array())) {
        const auto kind = z.at("kind").get<std::string>();
        BhZone zone{};
        if (kind == "start")
            zone.kind = 0;
        else if (kind == "end")
            zone.kind = 1;
        else if (kind == "stage")
            zone.kind = 2;
        else if (kind == "checkpoint")
            zone.kind = 3;
        else
            continue;
        zone.track = z.value("track", 0u);
        zone.index = z.value("index", 0u);
        for (int i = 0; i < 3; ++i) {
            zone.mins[i] = z.at("mins").at(i).get<float>();
            zone.maxs[i] = z.at("maxs").at(i).get<float>();
        }
        out.push_back(zone);
    }
    return out;
}

}  // namespace

GameSession::GameSession(ReplayCamera &playback_camera) : video(playback_camera) {
}

GameSession::~GameSession() {
    release();
}

GameSession::PreparedMap GameSession::prepare(
        const std::string &path, const std::string &content, const BhSettings &settings, const nlohmann::json &detail
) {
    PreparedMap next;
    next.core.reset(bh_create());
    if (!next.core) throw std::runtime_error("Could not create native core");
    require(bh_load_map(next.core.get(), path.c_str(), content.empty() ? nullptr : content.c_str()),
            next.core.get(),
            "Loading BSP map");
    require(bh_set_settings(next.core.get(), &settings), next.core.get(), "Applying settings");
    next.zones = timer_zones(detail);
    next.configure();
    return next;
}

GameSession::PreparedMap GameSession::PreparedMap::begin(
        const std::string &path, const std::string &content, const BhSettings &settings, const nlohmann::json &detail
) {
    PreparedMap next;
    next.core.reset(bh_create());
    if (!next.core) throw std::runtime_error("Could not create native core");
    require(bh_set_settings(next.core.get(), &settings), next.core.get(), "Applying settings");
    require(bh_load_map_begin(next.core.get(), path.c_str(), content.empty() ? nullptr : content.c_str()),
            next.core.get(),
            "Preparing BSP map");
    next.zones = timer_zones(detail);
    return next;
}

bool GameSession::PreparedMap::poll() {
    const auto status = bh_load_map_poll(core.get());
    if (status < 0) throw std::runtime_error(bh_last_error(core.get()));
    if (!status) return false;
    configure();
    return true;
}

void GameSession::PreparedMap::configure() {
    BhRunOptions timing{};
    bh_default_run_options(&timing);
    if (!zones.empty()) {
        require(bh_run_configure(core.get(), &timing, zones.data(), zones.size()), core.get(), "Configuring timer");
    }
}

void GameSession::prepare_workers(const std::string &path, const std::string &content, const nlohmann::json &detail) {
    video.cancel_preparation();
    map_path = path;
    content_root = content;
    map_detail = detail;
    replay_timeline.map(data_location::from_utf8(path), data_location::from_utf8(content));
    replay_compare_import.map(data_location::from_utf8(path), data_location::from_utf8(content));
}

void GameSession::install(
        CorePtr next, std::unique_ptr<Renderer> next_renderer, PracticeController &practice, Audio &audio
) {
    replay_compare.clear();
    practice.clear(core.get());
    renderer.reset();
    core = std::move(next);
    audio.set_map(core.get());
    renderer = std::move(next_renderer);
}

void GameSession::configure_timer() {
    BhRunOptions canonical{};
    bh_default_run_options(&canonical);
    if (zones.empty()) {
        require(bh_run_clear(core.get()), core.get(), "Clearing replay timer");
    } else {
        require(bh_run_configure(core.get(), &canonical, zones.data(), zones.size()),
                core.get(),
                "Restoring canonical map timer");
    }
}

void GameSession::restart(const std::string &style) {
    require(bh_style_set(core.get(), style.c_str()), core.get(), "Applying movement style");
    require(bh_reset(core.get()), core.get(), "Restarting map");
}

void GameSession::leave(PracticeController &practice) {
    if (core) bh_record_end(core.get());
    practice.clear(core.get());
    release();
}

void GameSession::release() {
    // Camera preparation restores borrowed replay state during teardown. Exports run on in their own process.
    video.cancel_preparation();
    replay_timeline.reset();
    replay_compare_import.reset();
    replay_compare.clear();
    renderer.reset();
    core.reset();
}

}  // namespace native
