#pragma once
#include "loadout_preview.hpp"
#include "hidden_gl_context.hpp"
#include "preview_readback.hpp"
#include "base64.hpp"
#include <condition_variable>
#include <mutex>

// The context and its window are created on the SDL thread. All preview resources live on the render worker;
// the game context never waits for their shaders, draws, readbacks or image encoding.
class LoadoutPreviewService {
    static constexpr size_t max_requests = 64, max_cached_thumbnails = 512, max_cached_bytes = 16 * 1024 * 1024;

    struct Request {
        unsigned id = 0;
        nlohmann::json job;
        std::string key;
    };

    struct Encode {
        Request request;
        native::PreviewReadback::Pixels pixels;
    };

    struct Reply {
        unsigned id;
        std::string uri;
    };

    struct Cached {
        std::string uri;
        uint64_t used;
    };

    struct State {
        std::mutex mutex;
        std::condition_variable changed;
        bool stop = false, failed = false;
        std::unordered_set<unsigned> wanted;
        std::deque<Request> requests;
        std::deque<Encode> encodes;
        std::vector<Reply> replies;
        std::unordered_map<std::string, Cached> cache;
        size_t cached_bytes = 0;
        uint64_t cache_clock = 0;
    };

    native::HiddenGlContext context{false};
    std::unique_ptr<State> state = std::make_unique<State>();
    std::filesystem::path assets;
    std::optional<double> fixed_seconds;
    std::thread renderer, encoder;

    void reply(unsigned id, std::string uri) {
        if (state->wanted.contains(id)) state->replies.push_back({id, std::move(uri)});
    }

    void remember(const std::string &key, const std::string &uri) {
        if (key.empty() || uri.empty()) return;
        if (const auto found = state->cache.find(key); found != state->cache.end()) {
            state->cached_bytes -= found->second.uri.size();
            state->cache.erase(found);
        }
        while ((state->cached_bytes + uri.size() > max_cached_bytes || state->cache.size() >= max_cached_thumbnails)
               && !state->cache.empty()) {
            auto oldest = std::min_element(state->cache.begin(), state->cache.end(), [](const auto &a, const auto &b) {
                return a.second.used < b.second.used;
            });
            state->cached_bytes -= oldest->second.uri.size();
            state->cache.erase(oldest);
        }
        if (uri.size() > max_cached_bytes) return;
        state->cache.emplace(key, Cached{uri, ++state->cache_clock});
        state->cached_bytes += uri.size();
    }

    void encode_loop() {
        SDL_SetCurrentThreadPriority(SDL_THREAD_PRIORITY_LOW);
        for (;;) {
            Encode job;
            {
                std::unique_lock lock(state->mutex);
                state->changed.wait(lock, [&] { return state->stop || !state->encodes.empty(); });
                if (state->stop) return;
                job = std::move(state->encodes.front());
                state->encodes.pop_front();
                if (!state->wanted.contains(job.request.id)) continue;
            }
            std::string uri;
            try {
                const auto &pixels = job.pixels;
                uri = "data:image/png;base64,"
                      + native::base64(native::encode_backbuffer_png(pixels.rgb, pixels.width, pixels.height));
            } catch (const std::exception &error) {
                std::cerr << "Loadout encoding: " << error.what() << '\n';
            }
            {
                std::lock_guard lock(state->mutex);
                remember(job.request.key, uri);
                reply(job.request.id, std::move(uri));
            }
            state->changed.notify_all();
        }
    }

    void render_jobs(native::Gl &gl) {
        struct Slot {
            native::PreviewReadback transfer;
            Request request;

            explicit Slot(native::Gl &api) : transfer(api) {}
        };

        std::array<std::unique_ptr<Slot>, 2> slots = {std::make_unique<Slot>(gl), std::make_unique<Slot>(gl)};
        std::unique_ptr<NativeLoadoutPreview> tiles, stage;
        for (;;) {
            for (auto &slot : slots) {
                if (!slot->transfer.pending()) continue;
                {
                    std::lock_guard lock(state->mutex);
                    if (state->encodes.size() >= slots.size()) continue;
                }
                if (auto pixels = slot->transfer.poll()) {
                    std::lock_guard lock(state->mutex);
                    if (state->wanted.contains(slot->request.id))
                        state->encodes.push_back({std::move(slot->request), std::move(*pixels)});
                    state->changed.notify_all();
                }
            }
            Request next;
            Slot *free = nullptr;
            for (auto &slot : slots)
                if (!slot->transfer.pending()) {
                    free = slot.get();
                    break;
                }
            {
                std::unique_lock lock(state->mutex);
                if (state->stop) return;
                if (free && !state->requests.empty()) {
                    next = std::move(state->requests.front());
                    state->requests.pop_front();
                } else {
                    state->changed.wait_for(lock, std::chrono::milliseconds(2));
                    continue;
                }
            }
            try {
                auto &preview = next.key.empty() ? stage : tiles;
                if (!preview) preview = std::make_unique<NativeLoadoutPreview>(gl, assets);
                free->request = std::move(next);
                const auto &request = free->request;
                const auto now = fixed_seconds.value_or(double(SDL_GetTicksNS()) / 1e9);
                if (!preview->capture(request.job, now, [&](int w, int h) { free->transfer.submit(w, h); })) {
                    std::lock_guard lock(state->mutex);
                    reply(request.id, {});
                }
            } catch (const std::exception &error) {
                std::cerr << "Loadout render: " << error.what() << '\n';
                std::lock_guard lock(state->mutex);
                reply(free->request.id, {});
            }
        }
    }

    void render_loop() {
        SDL_SetCurrentThreadPriority(SDL_THREAD_PRIORITY_LOW);
        try {
            context.bind();
            native::Gl gl;
            gl.load();
            render_jobs(gl);
        } catch (const std::exception &error) {
            std::cerr << "Loadout worker: " << error.what() << '\n';
            std::lock_guard lock(state->mutex);
            state->failed = true;
            for (unsigned id : state->wanted)
                reply(id, {});
            state->requests.clear();
        }
        context.unbind();
    }

public:
    explicit LoadoutPreviewService(std::filesystem::path asset_root, std::optional<double> clock = std::nullopt)
        : assets(std::move(asset_root))
        , fixed_seconds(clock) {
        try {
            renderer = std::thread([this] { render_loop(); });
            encoder = std::thread([this] { encode_loop(); });
        } catch (...) {
            {
                std::lock_guard lock(state->mutex);
                state->stop = true;
            }
            state->changed.notify_all();
            if (renderer.joinable()) renderer.join();
            throw;
        }
    }

    ~LoadoutPreviewService() {
        {
            std::lock_guard lock(state->mutex);
            state->stop = true;
        }
        state->changed.notify_all();
        renderer.join();
        encoder.join();
    }

    LoadoutPreviewService(const LoadoutPreviewService &) = delete;
    LoadoutPreviewService &operator=(const LoadoutPreviewService &) = delete;

    void request(nlohmann::json job) {
        if (!job.is_object() || job.dump().size() > 8192) return;
        const unsigned id = job.value("id", 0u);
        if (!id) return;
        Request request{id, std::move(job), {}};
        if (request.job.value("thumbnail", false)) {
            auto key = request.job;
            key.erase("id");
            key.erase("type");
            request.key = key.dump();
        }
        std::lock_guard lock(state->mutex);
        if (!state->wanted.insert(id).second) return;
        if (state->failed || state->wanted.size() > max_requests) {
            reply(id, {});
            return;
        }
        if (const auto cached = state->cache.find(request.key); cached != state->cache.end()) {
            cached->second.used = ++state->cache_clock;
            reply(id, cached->second.uri);
        } else if (request.key.empty()) {
            state->requests.push_front(std::move(request));
        } else {
            state->requests.push_back(std::move(request));
        }
        state->changed.notify_all();
    }

    void cancel(unsigned id) {
        std::lock_guard lock(state->mutex);
        state->wanted.erase(id);
        std::erase_if(state->requests, [id](const auto &request) { return request.id == id; });
        std::erase_if(state->encodes, [id](const auto &job) { return job.request.id == id; });
        std::erase_if(state->replies, [id](const auto &result) { return result.id == id; });
    }

    void cancel_all() {
        std::lock_guard lock(state->mutex);
        state->wanted.clear();
        state->requests.clear();
        state->encodes.clear();
        state->replies.clear();
    }

    std::vector<std::string> take_replies() {
        std::vector<Reply> ready;
        {
            std::lock_guard lock(state->mutex);
            ready.swap(state->replies);
            for (const auto &result : ready)
                state->wanted.erase(result.id);
        }
        std::vector<std::string> replies;
        replies.reserve(ready.size());
        for (auto &result : ready)
            replies.push_back(
                    "window.bunnyhopNativeLoadoutPreview?.("
                    + nlohmann::json{{"id", result.id}, {"png", std::move(result.uri)}}.dump() + ")"
            );
        return replies;
    }
};
