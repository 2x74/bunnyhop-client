#pragma once
#include "game_session.hpp"
#include "map_download.hpp"
#include "renderer.hpp"

namespace native {

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
            if (!ready) return false;
            if (!renderer) {
                if (viewmodels.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
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
};

}  // namespace native
