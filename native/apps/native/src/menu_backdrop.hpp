#include "data_location.hpp"
#pragma once
// The home-screen backdrop: the web attract tour (menu_tour.hpp) over a real
// map, or a stored PB replay, drawn by the native Renderer from its own
// BhContext. Only that private context is stepped for PB playback: nothing here
// touches the gameplay core, input, recording, heartbeat, scores or style.
// Include after renderer.hpp (Gl, Renderer) and online.hpp. Main thread only,
// except the loader: it downloads into the cache on a worker and must not
// call GL, SDL or the native core. The context is created, used and destroyed
// on the main thread, as bunnyhop_native.h requires.
#include "menu_tour.hpp"
#include "menu_pb.hpp"
#include <atomic>
#include <chrono>
#include <future>
#include <list>
#include <zlib.h>

namespace {
struct BackdropMap {
    std::unique_ptr<BhContext, decltype(&bh_destroy)> core{nullptr, &bh_destroy};
    std::vector<native::tour::Shot> shots;
};

// A new map context and its camera plan (main thread). Gameplay settings are
// applied only so bh_reset can place doors, trains and other brush entities.
inline BackdropMap load_backdrop_map(const std::filesystem::path &bsp, const std::filesystem::path &content) {
    BackdropMap out;
    // Also bound cached/local BSPs before the core allocates/parses them.
    if (std::filesystem::file_size(bsp) > (32u << 20))
        throw std::runtime_error("Backdrop BSP exceeds 32 MiB");
    out.core.reset(bh_create());
    if (!out.core) throw std::runtime_error("Could not create backdrop map context");
    if (!bh_load_map(out.core.get(), native::data_location::utf8(bsp).c_str(),
                     content.empty() ? nullptr : native::data_location::utf8(content).c_str()))
        throw std::runtime_error(std::string("Backdrop map: ") + bh_last_error(out.core.get()));
    BhSettings settings{};
    bh_default_settings(&settings);
    if (bh_set_settings(out.core.get(), &settings)) bh_reset(out.core.get());
    size_t bytes = 0;
    const char *raw = bh_entities_json(out.core.get(), &bytes);
    const auto entities = raw && bytes ? nlohmann::json::parse(raw, raw + bytes, nullptr, false) : nlohmann::json::array();
    BhContext *core = out.core.get();
    out.shots = native::tour::shots(native::tour::anchors(entities), [core](const native::tour::Vec &from, const native::tour::Vec &dir, double max) {
        const float start[3] = {float(from[0]), float(from[1]), float(from[2])};
        const float end[3] = {float(from[0] + dir[0] * max), float(from[1] + dir[1] * max), float(from[2] + dir[2] * max)};
        float fraction = 1;
        return bh_trace_camera(core, start, end, 2, &fraction) && std::isfinite(fraction) ? std::clamp(double(fraction), 0.0, 1.0) * max : max;
    });
    return out;
}

// The current back buffer as a small PNG: box-filtered to fit 960x540, halved
// again until its data URI fits `max_uri_bytes`. Read before SwapWindow.
inline std::string backbuffer_png(Gl &gl, int width, int height, size_t max_uri_bytes = 2000000) {
    if (width <= 0 || height <= 0) return {};
    std::vector<unsigned char> pixels(size_t(width) * height * 3);
    int alignment = 4;
    gl.GetIntegerv(GL_PACK_ALIGNMENT, &alignment);
    gl.PixelStorei(GL_PACK_ALIGNMENT, 1);
    gl.ReadPixels(0, 0, width, height, GL_RGB, GL_UNSIGNED_BYTE, pixels.data());
    gl.PixelStorei(GL_PACK_ALIGNMENT, alignment);
    double scale = std::min({1.0, 960.0 / width, 540.0 / height});
    for (;;) {
        const int w = std::max(1, int(width * scale)), h = std::max(1, int(height * scale));
        std::vector<unsigned char> rows(size_t(w * 3 + 1) * h);
        for (int y = 0; y < h; ++y) {
            // PNG rows run top-down; GL rows bottom-up.
            const int y0 = int(double(height) * (h - 1 - y) / h), y1 = std::max(y0 + 1, int(double(height) * (h - y) / h));
            for (int x = 0; x < w; ++x) {
                const int x0 = int(double(width) * x / w), x1 = std::max(x0 + 1, int(double(width) * (x + 1) / w));
                unsigned sum[3] = {}, n = 0;
                for (int sy = y0; sy < y1 && sy < height; ++sy)
                    for (int sx = x0; sx < x1 && sx < width; ++sx, ++n)
                        for (int k = 0; k < 3; ++k) sum[k] += pixels[(size_t(sy) * width + sx) * 3 + k];
                for (int k = 0; k < 3; ++k) rows[size_t(y) * (w * 3 + 1) + 1 + x * 3 + k] = (unsigned char)(n ? sum[k] / n : 0);
            }
        }
        uLongf bytes = compressBound(uLong(rows.size()));
        std::string compressed(bytes, '\0');
        if (compress2(reinterpret_cast<Bytef *>(compressed.data()), &bytes, rows.data(), uLong(rows.size()), 6) != Z_OK)
            throw std::runtime_error("Backdrop PNG compression failed");
        compressed.resize(bytes);
        auto integer = [](std::string &s, uint32_t n) { for (int shift : {24, 16, 8, 0}) s.push_back(char(n >> shift)); };
        std::string png("\x89PNG\r\n\x1a\n", 8);
        auto chunk = [&](const char *kind, const std::string &data) {
            integer(png, uint32_t(data.size()));
            const size_t start = png.size();
            png.append(kind, 4);
            png += data;
            integer(png, uint32_t(crc32(0, reinterpret_cast<const Bytef *>(png.data() + start), uInt(4 + data.size()))));
        };
        std::string header;
        integer(header, w); integer(header, h);
        header.append("\x08\x02\0\0\0", 5);
        chunk("IHDR", header); chunk("IDAT", compressed); chunk("IEND", {});
        // "data:image/png;base64," + base64.
        if (22 + (png.size() + 2) / 3 * 4 <= max_uri_bytes) return png;
        if (w <= 160) throw std::runtime_error("Backdrop PNG exceeds its size limit");
        scale *= .5;
    }
}

class MenuBackdrop {
public:
    enum class Status { idle, loading, ready, failed };
    // Download/cache work for one map id, on a worker thread. It must give up
    // promptly once `cancel` is set and must not write the cache after that.
    using Loader = std::function<native::DownloadedMap(const std::string &map, const std::atomic_bool &cancel)>;

    MenuBackdrop(Gl &api, std::filesystem::path asset_root, Loader loader)
        : gl(api), assets(std::move(asset_root)), load(std::move(loader)) {}
    ~MenuBackdrop() { release(); for (auto &job : retired) job->cancel = true; retired.clear(); }
    MenuBackdrop(const MenuBackdrop &) = delete;
    MenuBackdrop &operator=(const MenuBackdrop &) = delete;

    // Same map/path: no-op. A changed PB path also rebuilds the same map.
    // Paths name immutable cache entries; the host owns bytes/cache selection.
    bool request(const std::string &map, const std::string &replayPath = {}) {
        if (map == wanted && replayPath == wanted_replay && status_ != Status::idle) return false;
        release();
        wanted = map; wanted_replay = replayPath;
        if (map.empty()) return true;
        status_ = Status::loading;
        auto next = std::make_shared<Job>();
        // The flag lives in the Job, whose future waits for this worker on
        // destruction, so a plain pointer outlives every use.
        const std::atomic_bool *cancel = &next->cancel;
        next->result = std::async(std::launch::async, [loader = load, map, cancel] { return loader(map, *cancel); });
        job = std::move(next);
        return true;
    }
    // A gameplay download is starting: stop competing for the cache. A scene
    // already on screen stays until the game map actually loads.
    bool cancel_loading() {
        if (!job && !pending) return false;
        if (job) { job->cancel = true; retired.push_back(std::move(job)); }
        pending.reset(); status_ = Status::idle; interrupted = std::move(wanted); interrupted_replay = std::move(wanted_replay);
        wanted.clear(); wanted_replay.clear();
        return true;
    }
    // The gameplay download that cancelled a tour failed: load that tour again.
    // The menu may never have seen the loading state, so it won't ask itself.
    bool resume() {
        if (interrupted.empty() || status_ != Status::idle || !wanted.empty()) return false;
        const auto map = std::move(interrupted);
        const auto replay = std::move(interrupted_replay);
        interrupted.clear(); interrupted_replay.clear();
        return request(map, replay);
    }
    // Drops the scene and cancels any load (a gameplay map is taking over).
    void release() {
        if (job) { job->cancel = true; retired.push_back(std::move(job)); }
        replay.reset(); renderer.reset(); map_.reset(); director.reset(); pending.reset();
        status_ = Status::idle; error_.clear(); replay_error.clear(); wanted.clear(); wanted_replay.clear();
        interrupted.clear(); interrupted_replay.clear(); seconds = 0;
    }
    // Once per frame. A finished download is loaded and given a Renderer only
    // when `may_build` (no gameplay download is writing the shared cache).
    void poll(bool may_build) {
        retired.remove_if([](const std::shared_ptr<Job> &j) { return j->result.wait_for(std::chrono::seconds(0)) == std::future_status::ready; });
        if (job && job->result.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
            try { pending = std::make_unique<native::DownloadedMap>(job->result.get()); }
            catch (const std::exception &e) { status_ = Status::failed; error_ = e.what(); }
            job.reset();
        }
        if (pending && may_build) {
            try {
                auto loaded = std::make_unique<BackdropMap>(load_backdrop_map(pending->bsp, pending->content_root));
                auto next = std::make_unique<Renderer>(gl, loaded->core.get(), assets);
                next->set_viewmodel_visible(false);
                next->set_fov(native::tour::renderer_fov());
                director = std::make_unique<native::tour::Director>(loaded->shots);
                renderer = std::move(next); map_ = std::move(loaded);
                if (!wanted_replay.empty()) {
                    try {
                        auto pb = std::make_unique<native::backdrop::PbPlayback>();
                        pb->load(map_->core.get(), wanted_replay);
                        replay = std::move(pb);
                        renderer->reset_presentation();
                    } catch (const std::exception &e) { fallback_tour(e.what()); }
                }
                status_ = Status::ready;
            } catch (const std::exception &e) { status_ = Status::failed; error_ = e.what(); }
            pending.reset();
        }
    }
    // Reduced motion/static capture holds the current PB state and shader time,
    // or the tour's canonical still pose.
    bool draw(int width, int height, double dt, bool still) {
        if (status_ != Status::ready || width <= 0 || height <= 0) return false;
        if (replay) {
            try {
                const auto generation = replay->generation();
                if (!still) replay->advance(dt);
                if (generation != replay->generation()) renderer->reset_presentation();
                const auto &state = replay->snapshot();
                const auto &cmd = replay->command();
                const float eye[3] = {state.player.position[0], state.player.position[1], state.player.position[2] + state.player.view_offset_z};
                native::Input view; view.set_angles(cmd.pitch, cmd.yaw);
                renderer->draw(width, height, eye, view, &state, replay->seconds());
                return true;
            } catch (const std::exception &e) {
                try { fallback_tour(e.what()); }
                catch (const std::exception &failure) { status_ = Status::failed; error_ = failure.what(); return false; }
            }
        }
        if (!still) { director->advance(dt); seconds += std::clamp(dt, 0.0, .1); }
        const auto pose = still ? director->still() : director->pose();
        const float eye[3] = {float(pose.eye[0]), float(pose.eye[1]), float(pose.eye[2])};
        native::Input view;
        view.set_angles(pose.pitch, pose.yaw);
        renderer->draw(width, height, eye, view, nullptr, seconds);
        return true;
    }
    bool cut(bool still) const { return status_ == Status::ready && !replay && !still && director->cut(); }
    bool seek_replay(uint32_t tick) {
        if (!replay || status_ != Status::ready || tick > replay->total_ticks()) return false;
        try { replay->seek(tick); renderer->reset_presentation(); return true; }
        catch (const std::exception &e) {
            try { fallback_tour(e.what()); }
            catch (const std::exception &failure) { status_ = Status::failed; error_ = failure.what(); }
            return false;
        }
    }
    Status status() const { return status_; }
    const std::string &map() const { return wanted; }
    const std::string &error() const { return error_; }
    size_t shots() const { return director ? director->count() : 0; }
    nlohmann::json state(const std::string &source) const {
        static const char *names[] = {"idle", "loading", "ready", "failed"};
        return {{"status", names[int(status_)]}, {"map", wanted}, {"renderer", "native-bsp"}, {"kind", replay ? "pb" : "tour"},
                {"shots", shots()}, {"source", source}, {"error", error_}, {"replayError", replay_error},
                {"replayTick", replay ? replay->snapshot().player.tick : 0}, {"replayTicks", replay ? replay->total_ticks() : 0}};
    }

private:
    void fallback_tour(const std::string &failure) {
        replay_error = failure; replay.reset();
        BhContext *core = map_->core.get();
        BhSettings settings{}; bh_default_settings(&settings);
        if (!bh_replay_stop(core) || !bh_run_clear(core) || !bh_set_settings(core, &settings) || !bh_reset(core))
            throw std::runtime_error(std::string("Backdrop tour reset: ") + bh_last_error(core));
        renderer->reset_presentation();
        seconds = 0;
    }
    struct Job { std::atomic_bool cancel{false}; std::future<native::DownloadedMap> result; };
    Gl &gl;
    std::filesystem::path assets;
    Loader load;
    std::shared_ptr<Job> job;
    // Cancelled loads finish on their own; their futures are dropped once ready.
    std::list<std::shared_ptr<Job>> retired;
    std::unique_ptr<native::DownloadedMap> pending;
    std::unique_ptr<BackdropMap> map_;
    std::unique_ptr<Renderer> renderer;
    std::unique_ptr<native::tour::Director> director;
    std::unique_ptr<native::backdrop::PbPlayback> replay;
    Status status_ = Status::idle;
    std::string wanted, wanted_replay, error_, replay_error, interrupted, interrupted_replay;
    double seconds = 0;
};
}
