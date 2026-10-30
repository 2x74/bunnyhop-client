#include "video_controller.hpp"
#include "game_session.hpp"
#include "video_capture.hpp"
#include "replay_player.hpp"
#include "options.hpp"
#include "data_location.hpp"
#include "startup.hpp"
#include "online.hpp"
#include "video_request.hpp"
#include <stdexcept>

namespace native {
namespace {

// While a run is being played the export renders this many frames a second: progress continues without taking GPU
// time the game needs.
constexpr double playing_export_fps = 8;

const char *item_state(const std::string &state) {
    if (state == "queued" || state == "loading" || state == "rendering") return "capturing";
    return state.c_str();
}

nlohmann::json item_json(const VideoQueue::Item &item) {
    return {{"id", item.id},
            {"title", item.title},
            {"map", item.map},
            {"state", item.state},
            {"frame", item.frame},
            {"frames", item.frames},
            {"eta", item.eta},
            {"fps", item.fps},
            {"path", item.path},
            {"bytes", item.bytes},
            {"error", item.error},
            {"encoder", item.encoder},
            {"codec", item.codec},
            {"hardware", item.hardware},
            {"note", item.note},
            {"elapsed", item.elapsed},
            {"seconds", item.seconds}};
}

}  // namespace

VideoController::VideoController(ReplayCamera &playback_camera)
    : playback_camera_(playback_camera)
    , probe_(std::async(std::launch::async, [] { return NativeVideoExport::probe(); })) {
}

VideoController::~VideoController() {
    cancel_preparation();
}

void VideoController::bind(Context context, std::function<void()> refresh_playback_pose) {
    context_.emplace(context);
    refresh_playback_pose_ = std::move(refresh_playback_pose);
}

void VideoController::cancel(uint64_t id) {
    queue_.cancel(id);
    error.clear();
}

void VideoController::clear_finished() {
    queue_.clear_finished();
    error.clear();
}

void VideoController::cancel_preparation() {
    director_job.reset();
    playback_camera_.cancel_direct();
}

// The dialog's fields describe the newest export; "queue" lists them all.
nlohmann::json VideoController::state() const {
    const auto items = queue_.items();
    nlohmann::json result = {
            {"state", "idle"}, {"frames", 0}, {"totalFrames", 0}, {"progress", 0}, {"path", ""}, {"error", ""}
    };
    if (!items.empty()) {
        const auto &latest = items.back();
        result = item_json(latest);
        result["state"] = item_state(latest.state);
        result["frames"] = latest.frame;
        result["totalFrames"] = latest.frames;
        result["progress"] = latest.frames ? double(latest.frame) / double(latest.frames) : 0.;
        if (latest.state == "encoding") result["state"] = "encoding";
    }
    auto queue = nlohmann::json::array();
    for (const auto &item : items)
        queue.push_back(item_json(item));
    result["queue"] = std::move(queue);
    result["available"] = available.available;
    result["reason"] = available.reason;
    result["codecs"] = describe_video_encoders(available.encoders);
    result["musicTracks"] = music_catalog;
    if (director_job) {
        result["preparing"] = true;
        result["reason"] = "Preparing cinematic cameras…";
    }
    if (!error.empty()) {
        result["state"] = "error";
        result["error"] = error;
    }
    return result;
}

std::filesystem::path VideoController::output_folder() const {
    const auto &opt = context_->opt;
    if (!opt.video_smoke.empty()) return std::filesystem::absolute(data_location::from_utf8(opt.video_smoke));
    const char *downloads = SDL_GetUserFolder(SDL_FOLDER_DOWNLOADS);
    if (!downloads) throw std::runtime_error("Downloads folder unavailable");
    return data_location::from_utf8(downloads);
}

VideoQueue::Context VideoController::queue_context() const {
    const auto &context = *context_;
    return {executable_path(), context.assets, context.cache, context.preferences, context.outfit, available};
}

void VideoController::request(VideoOptions options, const std::string &title) {
    auto &context = *context_;
    if (!context.viewer.active || !context.game.core) throw std::runtime_error("Open a replay before exporting video");
    if (!available.available) throw std::runtime_error(available.reason);
    const auto &range = context.viewer.session.range;
    options.tick_interval = range.tick_interval;
    range.export_bounds(options);
    VideoTimeline::make(options, range.total);
    VideoQueue::Request request;
    request.replay = context.viewer.path;
    request.map = context.game.map_id;
    request.bsp = data_location::from_utf8(context.game.map_path);
    request.content = data_location::from_utf8(context.game.content_root);
    request.detail = context.game.map_detail;
    request.output = output_folder();
    request.title = title.empty() ? context.game.map_id : title;
    request.options = std::move(options);
    error.clear();
    queue_.add(std::move(request), queue_context());
}

void VideoController::request_file(const std::filesystem::path &replay, const std::string &map, VideoOptions options) {
    if (!available.available) throw std::runtime_error(available.reason);
    if (!valid_map_id(map)) throw std::runtime_error("Invalid map name");
    VideoQueue::Request request;
    request.replay = replay;
    request.map = map;
    request.output = output_folder();
    request.title = data_location::utf8(replay.filename());
    request.options = std::move(options);
    error.clear();
    queue_.add(std::move(request), queue_context());
}

void VideoController::message(const nlohmann::json &message, const std::filesystem::path &replays) {
    try {
        const auto action = message.value("action", std::string());
        if (action == "start") {
            request(parse_video_options(message.at("options")), message.value("title", std::string()));
        } else if (action == "file") {
            const auto id = message.at("id").get<std::string>();
            const auto file = std::filesystem::path(id);
            if (id.empty() || id.size() > 200 || file.filename() != file || file.extension() != ".bhr")
                throw std::runtime_error("Invalid replay id");
            request_file(
                    replays / file, message.at("map").get<std::string>(), parse_video_options(message.at("options"))
            );
        } else if (action == "cancel") {
            cancel(message.value("id", uint64_t(0)));
        } else if (action == "clear") {
            clear_finished();
        } else {
            throw std::runtime_error("Unknown video export action");
        }
    } catch (const std::exception &failure) {
        error = failure.what();
    }
}

void VideoController::prepare_viewer_camera() {
    auto &context = *context_;
    director_job = std::make_unique<ReplayDirectorJob>(
            context.game.core.get(), context.viewer.session.info.at("totalTicks").get<uint32_t>(), context.curr.tick
    );
}

void VideoController::step(bool playing) {
    queue_.set_pace(playing ? playing_export_fps : 0);
    if (!director_job) return;
    auto &context = *context_;
    try {
        if (!director_job->step()) return;
        const auto &range = context.viewer.session.range;
        if (director_job->plan(context.viewer.camera, range.tick_interval, range.from, range.to)) {
            director_job.reset();
            refresh_playback_pose_();
        }
    } catch (const std::exception &e) {
        cancel_preparation();
        refresh_playback_pose_();
        error = e.what();
    }
}

void VideoController::wait_probe() {
    if (probe_.valid()) available = probe_.get();
}

void VideoController::poll_probe() {
    if (probe_.valid() && probe_.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
        available = probe_.get();
    }
}

}  // namespace native
