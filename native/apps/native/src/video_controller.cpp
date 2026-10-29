#include "video_controller.hpp"
#include "game_session.hpp"
#include "renderer.hpp"
#include "hud.hpp"
#include "video_capture.hpp"
#include "replay_player.hpp"
#include "audio.hpp"
#include "options.hpp"
#include "map_download.hpp"
#include "data_location.hpp"
#include <stdexcept>

namespace native {

VideoController::VideoController(ReplayCamera &playback_camera)
    : playback_camera_(playback_camera)
    , probe_(std::async(std::launch::async, [] { return NativeVideoExport::probe(); })) {
}

VideoController::~VideoController() {
    cancel();
}

void VideoController::bind(
        Context context, std::function<void(bool)> show_menu, std::function<void()> refresh_playback_pose
) {
    context_.emplace(context);
    show_menu_ = std::move(show_menu);
    refresh_playback_pose_ = std::move(refresh_playback_pose);
}

void VideoController::cancel() {
    encoder.cancel();
    pending_video.reset();
    director_job.reset();
    prepared_camera.cancel_direct();
    playback_camera_.cancel_direct();
    capture.reset();
    error.clear();
}

nlohmann::json VideoController::state() const {
    auto result = encoder.status();
    result["available"] = available.available;
    result["reason"] = available.reason;
    result["musicTracks"] = music_catalog;
    if (director_job) {
        result["state"] = "capturing";
        result["reason"] = "Preparing cinematic cameras…";
        result["progress"] = 0;
    }
    if (!error.empty()) {
        result["state"] = "error";
        result["error"] = error;
    }
    return result;
}

void VideoController::begin(const VideoOptions &options) {
    auto &context = *context_;
    const auto timeline = native::VideoTimeline::make(options, context.viewer.session.range.total);
    const char *downloads = SDL_GetUserFolder(SDL_FOLDER_DOWNLOADS);
    if (context.opt.video_smoke.empty() && !downloads) throw std::runtime_error("Downloads folder unavailable");
    const auto directory = context.opt.video_smoke.empty() ? native::data_location::from_utf8(downloads)
                                                           : std::filesystem::absolute(context.opt.video_smoke);
    std::filesystem::create_directories(directory);
    const auto destination =
            directory / ("bunnyhop-" + context.game.map_id + "-" + std::to_string(SDL_GetTicksNS()) + ".mp4");
    capture = std::make_unique<native::VideoCapture>(
            context.gl,
            context.game.core.get(),
            *context.game.renderer,
            context.hud,
            encoder,
            options,
            context.viewer.session.info.at("totalTicks").get<uint32_t>(),
            context.curr.tick,
            context.preferences,
            context.game.map_id,
            context.viewer.session.info.value("style", context.active_style),
            context.outfit,
            (context.viewer.session.info.contains("packedLoadout")
                             && context.viewer.session.info["packedLoadout"].is_string()
                     ? context.viewer.session.info["packedLoadout"].get<std::string>()
                     : std::string()),
            prepared_camera,
            context.assets,
            context.cache
    );
    try {
        encoder.start(options, destination, timeline.frames, available.encoder);
    } catch (...) {
        capture.reset();
        throw;
    }
    context.audio.pause();
}

void VideoController::request(VideoOptions options) {
    auto &context = *context_;
    if (!context.viewer.active || !context.game.renderer || !context.game.core || context.download.valid())
        throw std::runtime_error("Open a replay before exporting video");
    if (capture || director_job || encoder.busy()) throw std::runtime_error("A video export is already running");
    if (!available.available) throw std::runtime_error(available.reason);
    options.tick_interval = context.viewer.session.range.tick_interval;
    native::ReplayRange::make(context.viewer.session.info).export_bounds(options);
    native::VideoTimeline::make(options, context.viewer.session.range.total);
    error.clear();
    show_menu_(true);
    prepared_camera = {};
    prepared_camera.set_mode(options.camera);
    if (options.camera == "auto") {
        pending_video = options;
        director_only = false;
        director_job = std::make_unique<native::ReplayDirectorJob>(
                context.game.core.get(), context.viewer.session.info.at("totalTicks").get<uint32_t>(), context.curr.tick
        );
    } else
        begin(options);
}

void VideoController::prepare_viewer_camera() {
    auto &context = *context_;
    director_only = true;
    director_job = std::make_unique<ReplayDirectorJob>(
            context.game.core.get(), context.viewer.session.info.at("totalTicks").get<uint32_t>(), context.curr.tick
    );
}

void VideoController::step_director() {
    auto &context = *context_;
    if (director_job) try {
            if (director_job->step()) {
                const double interval = context.viewer.session.range.tick_interval;
                if (director_only) {
                    if (director_job->plan(
                                context.viewer.camera,
                                interval,
                                context.viewer.session.range.from,
                                context.viewer.session.range.to
                        )) {
                        director_job.reset();
                        refresh_playback_pose_();
                    }
                } else {
                    const auto options = *pending_video;
                    if (director_job->plan(prepared_camera, interval, options.from, options.to)) {
                        director_job.reset();
                        pending_video.reset();
                        begin(options);
                    }
                }
            }
        } catch (const std::exception &e) {
            cancel();
            refresh_playback_pose_();
            error = e.what();
        }
}

void VideoController::step_capture() {
    if (capture) try {
            if (!encoder.busy()) {
                capture.reset();
                refresh_playback_pose_();
            } else {
                capture->step();
                if (capture->done()) {
                    capture.reset();
                    refresh_playback_pose_();
                }
            }
        } catch (const std::exception &e) {
            cancel();
            refresh_playback_pose_();
            error = e.what();
        }
}

void VideoController::step() {
    step_director();
    step_capture();
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
