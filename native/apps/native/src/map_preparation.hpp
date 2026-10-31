#pragma once
#include "game_session.hpp"
#include "map_download.hpp"
#include "renderer.hpp"

namespace native {

// The workers that parse the BSP and load the models report no progress, so a wait on them can only be bounded as a
// whole. The largest map on a slow disk takes well under this.
inline constexpr auto map_worker_wait_limit = std::chrono::minutes(5);

class MapPreparation {
public:
    MapDownloadResult download;
    std::optional<GameSession::PreparedMap> prepared;

    MapJobs<std::unique_ptr<NativeViewmodel>> viewmodels;
    std::unique_ptr<Renderer> renderer;
    bool ready = false;

    void cancel() {
        ready = false;
        viewmodels.cancel();
        renderer.reset();
        prepared.reset();
        download = {};
    }

    void start(MapDownloadResult next, const BhSettings &settings, Gl &gl, const std::filesystem::path &assets) {
        cancel();
        download = std::move(next);
        if (!download.map) return;
        worker_wait_started = std::chrono::steady_clock::now();
        try {
            viewmodels.start([&gl, assets](const std::atomic_bool &cancel) {
                if (cancel) return std::unique_ptr<NativeViewmodel>{};
                return std::make_unique<NativeViewmodel>(gl, assets, true);
            });
            const auto &map = *download.map;
            prepared = GameSession::PreparedMap::begin(
                    data_location::utf8(map.bsp), data_location::utf8(map.content_root), settings, map.detail
            );
        } catch (const std::exception &failure) {
            download.error = failure.what();
        }
    }

    GameSession::PreparedMap
    take(const std::string &path,
         const std::string &content,
         const BhSettings &settings,
         const nlohmann::json &detail) {
        if (ready && prepared && download.map && data_location::utf8(download.map->bsp) == path) {
            ready = false;
            return std::move(*prepared);
        }
        return GameSession::prepare(path, content, settings, detail);
    }

    bool poll(Gl &gl, const std::filesystem::path &assets) {
        viewmodels.poll();
        if (!download.error.empty() || !prepared) return true;
        try {
            if (!ready) ready = prepared->poll();
            if (!ready) return give_up_on_worker();
            if (!renderer) {
                if (viewmodels.wait_for(std::chrono::seconds(0)) != std::future_status::ready)
                    return give_up_on_worker();
                renderer = std::make_unique<Renderer>(gl, prepared->core.get(), assets, true, viewmodels.get());
            }
            return renderer->poll_loading();
        } catch (const std::exception &failure) {
            download.error = failure.what();
            renderer.reset();
            prepared.reset();
            return true;
        }
    }

private:
    bool give_up_on_worker() {
        if (std::chrono::steady_clock::now() - worker_wait_started < map_worker_wait_limit) return false;
        download.error = "This map stopped loading while it was being prepared. Try again.";
        renderer.reset();
        prepared.reset();
        return true;
    }

    std::chrono::steady_clock::time_point worker_wait_started;
};

}  // namespace native
