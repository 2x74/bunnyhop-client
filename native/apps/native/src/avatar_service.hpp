#pragma once
// Include after renderer.hpp. The avatar editor's host side (ui/avatar-host.ts): avatarRender messages in, one GL
// render per frame, the 2D work and PNG / WebP encoding on a worker, replies out as JavaScript for the menu.
// The live preview replaces a pending preview; thumbnails and saves queue (bounded).
#include "avatar_stage.hpp"
#include "base64.hpp"
#include "data_location.hpp"

#include <condition_variable>
#include <deque>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <thread>

namespace native::avatar {

// spec.ts AVATAR_MAX_BYTES: the largest picture the server keeps.
constexpr size_t max_saved_bytes = 96 * 1024;
constexpr size_t max_queued_renders = 96;
constexpr int max_file_suffix = 1000;

// Encodes finished renders off the frame loop. Replies are JavaScript calls ready for evaluate_js.
class AvatarEncoder {
    struct Job {
        Request request;
        BunnyLayer layer;
    };

    struct State {
        std::mutex mutex;
        std::condition_variable changed;
        std::deque<Job> jobs;
        std::vector<std::string> replies;
        bool stop = false;
    };

    std::shared_ptr<State> state_ = std::make_shared<State>();
    std::thread worker_;

    static std::string reply(unsigned id, const char *field, const std::string &value) {
        return "window.bunnyhopNativeAvatar?.(" + nlohmann::json{{"id", id}, {field, value}}.dump() + ")";
    }

    // bunnyhop-avatar-512.png, or -2, -3... beside an earlier one.
    static std::filesystem::path free_name(const std::filesystem::path &folder, int size) {
        const auto stem = "bunnyhop-avatar-" + std::to_string(size);
        auto path = folder / (stem + ".png");
        for (int n = 2; std::filesystem::exists(path) && n < max_file_suffix; ++n)
            path = folder / (stem + "-" + std::to_string(n) + ".png");
        return path;
    }

    static std::string write_file(const Request &request, const std::string &png) {
        if (request.folder.empty()) return reply(request.id, "error", "There's no folder to save pictures in.");
        const auto path = free_name(request.folder, request.size);
        std::ofstream out(path, std::ios::binary);
        out.write(png.data(), std::streamsize(png.size()));
        if (!out) return reply(request.id, "error", "The picture couldn't be saved.");
        return reply(request.id, "saved", native::data_location::utf8(path));
    }

    static std::string encode(const Job &job) {
        const auto picture = compose(job.request, job.layer);
        if (!job.layer.px) return reply(job.request.id, "error", "The picture couldn't be drawn.");
        if (job.request.output == Output::file) return write_file(job.request, encode_png(picture));
        if (job.request.output == Output::preview)
            return reply(job.request.id, "png", "data:image/png;base64," + native::base64(encode_png(picture)));
        const auto webp = encode_avatar_webp(picture, max_saved_bytes);
        if (webp.empty()) return reply(job.request.id, "error", "That picture is too detailed to save.");
        return reply(job.request.id, "webp", native::base64(webp));
    }

    static void run(const std::shared_ptr<State> &state) {
        std::unique_lock lock(state->mutex);
        for (;;) {
            state->changed.wait(lock, [&] { return state->stop || !state->jobs.empty(); });
            if (state->stop) return;
            auto job = std::move(state->jobs.front());
            state->jobs.pop_front();
            lock.unlock();
            std::string js;
            try {
                js = encode(job);
            } catch (const std::exception &e) {
                js = reply(job.request.id, "error", e.what());
            }
            lock.lock();
            state->replies.push_back(std::move(js));
        }
    }

public:
    AvatarEncoder() : worker_(run, state_) {}

    AvatarEncoder(const AvatarEncoder &) = delete;
    AvatarEncoder &operator=(const AvatarEncoder &) = delete;

    ~AvatarEncoder() {
        {
            std::lock_guard lock(state_->mutex);
            state_->stop = true;
            state_->jobs.clear();
        }
        state_->changed.notify_one();
        worker_.join();
    }

    void push(Request request, BunnyLayer layer) {
        {
            std::lock_guard lock(state_->mutex);
            state_->jobs.push_back({std::move(request), std::move(layer)});
        }
        state_->changed.notify_one();
    }

    std::vector<std::string> take_replies() {
        std::lock_guard lock(state_->mutex);
        return std::exchange(state_->replies, {});
    }
};

class AvatarService {
    native::Gl &gl;
    std::filesystem::path assets;
    std::unique_ptr<NativeAvatarStage> stage;
    std::optional<Request> preview;
    // Saves and downloads go before the preview; thumbnails fill in after it.
    std::deque<Request> exports, thumbnails;
    std::vector<std::string> errors;
    // Started with the first picture, so the game has no idle thread until the editor is used.
    std::unique_ptr<AvatarEncoder> encoder;
    bool unavailable = false;

    static std::string failure(unsigned id, const std::string &message) {
        return "window.bunnyhopNativeAvatar?.(" + nlohmann::json{{"id", id}, {"error", message}}.dump() + ")";
    }

    static std::optional<Request> pop(std::deque<Request> &queue) {
        if (queue.empty()) return std::nullopt;
        auto out = std::move(queue.front());
        queue.pop_front();
        return out;
    }

    std::optional<Request> next() {
        if (auto out = pop(exports)) return out;
        if (preview) return std::exchange(preview, std::nullopt);
        return pop(thumbnails);
    }

    static std::filesystem::path downloads_folder() {
        for (const auto folder : {SDL_FOLDER_DOWNLOADS, SDL_FOLDER_PICTURES, SDL_FOLDER_HOME})
            if (const char *path = SDL_GetUserFolder(folder)) return native::data_location::from_utf8(path);
        return {};
    }

public:
    AvatarService(native::Gl &api, std::filesystem::path asset_root) : gl(api), assets(std::move(asset_root)) {}

    // A menu message. Previews ("live": the big picture) replace each other; the rest queue.
    void request(const nlohmann::json &message) {
        const auto parsed = parse_request(message);
        const unsigned id = message.is_object() ? message.value("id", 0u) : 0u;
        if (!parsed) {
            errors.push_back(failure(id, "Bad avatar request."));
            return;
        }
        if (message.value("live", false)) {
            if (preview) errors.push_back(failure(preview->id, "replaced"));
            preview = *parsed;
            return;
        }
        auto job = *parsed;
        if (job.output == Output::file) job.folder = downloads_folder();
        auto &queue = job.output == Output::preview ? thumbnails : exports;
        if (queue.size() >= max_queued_renders) {
            errors.push_back(failure(id, "Too many pictures at once."));
            return;
        }
        queue.push_back(std::move(job));
    }

    // Renders at most one queued picture. Call on the GL thread while the menu shows.
    void frame() {
        auto job = next();
        if (!job) return;
        try {
            if (!stage && !unavailable) stage = std::make_unique<NativeAvatarStage>(gl, assets);
        } catch (const std::exception &e) {
            unavailable = true;
            std::cerr << "Avatar renderer: " << e.what() << '\n';
        }
        if (!stage) {
            errors.push_back(failure(job->id, "Avatar pictures aren't available in this build."));
            return;
        }
        try {
            auto layer = stage->draw(*job);
            if (!encoder) encoder = std::make_unique<AvatarEncoder>();
            encoder->push(std::move(*job), std::move(layer));
        } catch (const std::exception &e) {
            std::cerr << "Avatar render: " << e.what() << '\n';
            errors.push_back(failure(job->id, "The picture couldn't be drawn."));
        }
    }

    // JavaScript replies for the menu (finished pictures and errors).
    std::vector<std::string> take_replies() {
        auto out = encoder ? encoder->take_replies() : std::vector<std::string>();
        for (auto &error : errors)
            out.push_back(std::move(error));
        errors.clear();
        return out;
    }

    // The menu closed the editor: drop what's waiting and the renderer's GPU memory.
    void close() {
        preview.reset();
        exports.clear();
        thumbnails.clear();
        stage.reset();
    }
};

}  // namespace native::avatar
