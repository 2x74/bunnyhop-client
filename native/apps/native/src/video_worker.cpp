#include "video_worker.hpp"
#include "client_util.hpp"
#include "game_session.hpp"
#include "native_cosmetics.hpp"
#include "online.hpp"
#include "preferences.hpp"
#include "replay_session.hpp"
#include "startup.hpp"
#include "video_capture.hpp"
#include "video_request.hpp"
#include <SDL3/SDL.h>
#include <atomic>
#include <chrono>
#include <ctime>
#include <fstream>
#include <iostream>
#include <thread>

namespace native::video_worker {
namespace {

using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
constexpr auto progress_interval = std::chrono::milliseconds(200);
constexpr auto encoder_poll_ms = 20;
constexpr auto full_queue_wait_ms = 1;
constexpr int window_side_pixels = 64;
constexpr double eta_smoothing = .15;
constexpr size_t max_spec_bytes = size_t(64) << 20;
constexpr size_t max_jobs = 256;
constexpr int max_name_attempts = 1000;
// Elements that never belong in a video: the live counters, chat and the viewer's banner.
constexpr std::array<std::string_view, 8> never_in_video = {
        "fps", "chat", "notice", "replay", "spectators", "practice", "pb", "ghostKeys"
};
// "Timer and sync": everything but the speed, keys and graph, which have their own switches.
constexpr std::array<std::string_view, 15> run_elements = {
        "map",
        "timer",
        "runStats",
        "status",
        "jumpStats",
        "strafeTrainer",
        "splits",
        "health",
        "track",
        "stage",
        "sync",
        "startPre",
        "strafeOffsets",
        "firstJump",
        "longJump"
};

// Commands from the game on stdin, read on their own thread so a slow frame never delays a cancel.
struct Control {
    std::atomic_bool cancel = false;
    std::atomic<double> pace_fps = 0;
};

void listen(Control &control, bool parent) {
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line == "cancel") control.cancel = true;
        if (line.starts_with("pace ")) {
            const double fps = std::strtod(line.c_str() + 5, nullptr);
            control.pace_fps = std::isfinite(fps) && fps > 0 ? fps : 0;
        }
    }
    // The game closed the pipe: it quit or crashed, and nobody will collect this export.
    if (parent) control.cancel = true;
}

void emit(const Json &event) {
    std::cout << event.dump() << std::endl;
}

struct Job {
    size_t index = 0;
    std::filesystem::path replay, bsp, content, output;
    std::string map;
    Json detail, options;
};

struct Spec {
    std::filesystem::path assets, cache;
    Json settings;
    std::string outfit, program = "ffmpeg";
    std::optional<VideoEncoders> encoders;
    bool parent = false;
    std::vector<Job> jobs;
};

Job read_job(const Json &value, size_t index) {
    Job job;
    job.index = index;
    job.replay = data_location::from_utf8(value.at("replay").get<std::string>());
    job.map = value.at("map").get<std::string>();
    if (!valid_map_id(job.map)) throw std::runtime_error("Invalid map name in export job");
    if (value.contains("bsp")) job.bsp = data_location::from_utf8(value.at("bsp").get<std::string>());
    if (value.contains("content")) job.content = data_location::from_utf8(value.at("content").get<std::string>());
    job.detail = value.value("detail", Json::object());
    job.output = data_location::from_utf8(value.at("output").get<std::string>());
    job.options = value.at("options");
    return job;
}

Spec read_spec(const std::filesystem::path &path) {
    if (std::filesystem::file_size(path) > max_spec_bytes) throw std::runtime_error("Export spec is too large");
    std::ifstream input(path, std::ios::binary);
    const auto value = Json::parse(input);
    Spec spec;
    spec.assets = value.contains("assets") ? data_location::from_utf8(value.at("assets").get<std::string>())
                                           : resource("native-assets", BUNNYHOP_NATIVE_ASSET_ROOT);
    spec.cache = data_location::from_utf8(value.at("cache").get<std::string>());
    spec.settings = patch_settings(default_settings(), value.value("settings", Json::object()));
    spec.outfit = value.value("outfit", std::string("outfit-cream"));
    spec.program = value.value("program", spec.program);
    if (value.contains("encoders"))
        spec.encoders = VideoEncoders{
                spec.program, value.at("encoders").get<std::vector<std::string>>(), value.value("aac", true)
        };
    spec.parent = value.value("parent", false);
    const auto &jobs = value.at("jobs");
    if (!jobs.is_array() || jobs.empty() || jobs.size() > max_jobs) throw std::runtime_error("Export spec has no jobs");
    for (size_t index = 0; index < jobs.size(); ++index)
        spec.jobs.push_back(read_job(jobs[index], index));
    return spec;
}

struct Surface {
    WindowPtr window{nullptr, &SDL_DestroyWindow};
    ContextPtr context;

    Surface() {
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
        SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
        SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE, 8);
        window.reset(SDL_CreateWindow(
                "bunnyhop export", window_side_pixels, window_side_pixels, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN
        ));
        if (!window) throw std::runtime_error(std::string("Cannot create the export window: ") + SDL_GetError());
        context.reset(SDL_GL_CreateContext(window.get()));
        if (!context || !SDL_GL_MakeCurrent(window.get(), context.get()))
            throw std::runtime_error(std::string("Cannot create the export OpenGL context: ") + SDL_GetError());
        SDL_GL_SetSwapInterval(0);
    }
};

// The player's HUD with the export's switches: elements switched off are hidden in the layout, as the editor would.
Json export_hud_settings(Json settings, const VideoOptions &options) {
    auto &layout = settings["hudLayout"];
    const auto hide = [&layout](std::string_view id) {
        layout[std::string(id)]["visible"] = false;
        layout[std::string(id)]["on"] = false;
    };
    for (const auto id : never_in_video)
        hide(id);
    if (!options.hud)
        for (const auto id : run_elements)
            hide(id);
    if (!options.speed) hide("speed");
    settings["keysOverlay"] = options.keys;
    settings["speedGraph"] = options.graph;
    return settings;
}

void configure_renderer(Renderer &renderer, const Json &settings, const VideoOptions &options) {
    const auto prefs = Preferences::from_settings(settings);
    renderer.graphics_settings(settings);
    renderer.set_fov(prefs.fov);
    renderer.set_viewmodel(
            settings.at("viewmodelFov").get<float>(),
            settings.at("viewmodelX").get<float>(),
            settings.at("viewmodelY").get<float>(),
            settings.at("viewmodelZ").get<float>(),
            settings.at("viewmodelLeftHand").get<bool>(),
            options.weapon,
            settings.at("viewmodelBob").get<float>(),
            settings.at("viewmodelSway").get<float>()
    );
    renderer.set_color_blind(settings.value("colorBlind", std::string("off")));
    renderer.set_actor_models(
            settings.value("playerModel", std::string("bunny")), settings.value("ghostModel", std::string("same"))
    );
    renderer.set_zones_visible(settings.value("zonesVisible", true));
    renderer.set_effects_visible(settings.value("effectsVisible", true));
    renderer.set_water_quality(settings.value("waterQuality", std::string("simple")) == "refracted" ? 1 : 0);
    renderer.set_source_look(options.look == "settings" ? prefs.source_look : options.look == "source");
}

ReplayCamera prepare_camera(BhContext *core, const VideoOptions &options, uint32_t total_ticks) {
    ReplayCamera camera;
    camera.set_mode(options.camera);
    if (options.camera != "auto") return camera;
    ReplayDirectorJob director(core, total_ticks, options.from);
    while (!director.step()) {
    }
    while (!director.plan(camera, options.tick_interval, options.from, options.to)) {
    }
    return camera;
}

std::string timestamp() {
    const std::time_t now = std::time(nullptr);
    std::tm local{};
#ifdef _WIN32
    localtime_s(&local, &now);
#else
    localtime_r(&now, &local);
#endif
    char text[32];
    std::strftime(text, sizeof(text), "%Y%m%d-%H%M%S", &local);
    return text;
}

std::filesystem::path
unique_output(const std::filesystem::path &folder, const std::string &map, const std::string &codec) {
    std::filesystem::create_directories(folder);
    const std::string stem = "bunnyhop-" + map + "-" + timestamp();
    const std::string extension = video_extension(codec);
    for (int attempt = 1; attempt <= max_name_attempts; ++attempt) {
        const auto name = attempt == 1 ? stem : stem + "-" + std::to_string(attempt);
        const auto path = folder / (name + extension);
        if (!std::filesystem::exists(path)) return path;
    }
    throw std::runtime_error("Too many exports with the same name in the output folder");
}

// Smoothed time per frame for the estimate: the cost changes along a run (open areas, the end of the map).
class Progress {
public:
    Progress(size_t job, uint64_t frames) : job_(job), frames_(frames), last_at_(Clock::now()) {}

    void report(uint64_t frame, const char *stage, bool force = false) {
        const auto now = Clock::now();
        if (!force && now - emitted_at_ < progress_interval) return;
        if (frame > last_frame_) {
            const double per = std::chrono::duration<double>(now - last_at_).count() / double(frame - last_frame_);
            seconds_per_frame_ =
                    seconds_per_frame_ ? seconds_per_frame_ * (1 - eta_smoothing) + per * eta_smoothing : per;
            last_frame_ = frame;
            last_at_ = now;
        }
        emitted_at_ = now;
        const double eta = seconds_per_frame_ * double(frames_ - std::min(frame, frames_));
        emit({{"event", "progress"},
              {"job", job_},
              {"stage", stage},
              {"frame", frame},
              {"frames", frames_},
              {"eta", seconds_per_frame_ ? eta : -1},
              {"fps", seconds_per_frame_ ? 1 / seconds_per_frame_ : 0}});
    }

private:
    size_t job_;
    uint64_t frames_, last_frame_ = 0;
    double seconds_per_frame_ = 0;
    Clock::time_point last_at_, emitted_at_{};
};

void pace(const Control &control, Clock::time_point &next_frame) {
    const double fps = control.pace_fps;
    if (fps <= 0) return;
    const auto now = Clock::now();
    next_frame = std::max(next_frame, now)
                 + std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(1 / fps));
    std::this_thread::sleep_until(next_frame);
}

struct LoadedJob {
    GameSession::PreparedMap map;
    ReplaySession session;
    VideoOptions options;
    std::string loadout, outfit;
};

LoadedJob load_job(const Spec &spec, const Job &job, Control &control) {
    std::string bsp = data_location::utf8(job.bsp), content = data_location::utf8(job.content);
    Json detail = job.detail;
    if (job.bsp.empty()) {
        const auto map = download_map(job.map, spec.cache, [](const std::string &) {}, &control.cancel);
        bsp = data_location::utf8(map.bsp);
        content = data_location::utf8(map.content_root);
        detail = map.detail;
    }
    BhSettings settings{};
    bh_default_settings(&settings);
    LoadedJob loaded{
            GameSession::prepare(bsp, content, settings, detail), {}, parse_video_options(job.options), {}, {}
    };
    loaded.session = ReplaySession::open(loaded.map.core.get(), job.replay, loaded.options.full_recording);
    if (loaded.session.info.value("map", std::string()) != job.map)
        throw std::runtime_error("The replay is for another map.");
    loaded.options.tick_interval = loaded.session.range.tick_interval;
    loaded.session.range.export_bounds(loaded.options);
    VideoTimeline::make(loaded.options, loaded.session.range.total);
    const auto &packed = loaded.session.info.value("packedLoadout", Json());
    loaded.loadout = packed.is_string() ? packed.get<std::string>() : std::string();
    loaded.outfit = native_render::packed_outfit(loaded.loadout).value_or(spec.outfit);
    return loaded;
}

VideoEncoderChoice encoder_for(const VideoAvailability &available, const VideoOptions &options) {
    auto choice = choose_video_encoder(available.encoders, options);
    if (!choice)
        throw std::runtime_error(
                "This FFmpeg has no encoder for " + std::string(video_codec_label(options.codec)) + "."
        );
    if (options.has_audio() && !video_codec_is_image_sequence(choice->codec) && video_extension(choice->codec) == ".mp4"
        && !available.encoders.aac)
        throw std::runtime_error("This FFmpeg has no AAC encoder for the sound: turn sound off or choose ProRes.");
    return NativeVideoExport::verified_choice(available, options, std::move(*choice));
}

bool render(VideoCapture &capture, NativeVideoExport &encoder, Control &control, Progress &progress) {
    auto next_frame = Clock::now();
    capture.prepare_audio();
    while (!capture.done()) {
        if (control.cancel) {
            encoder.cancel();
            return false;
        }
        const uint64_t before = capture.frame();
        if (!capture.step()) SDL_Delay(full_queue_wait_ms);
        if (!encoder.busy()) return false;
        if (capture.frame() > before) pace(control, next_frame);
        progress.report(capture.frame(), "rendering");
    }
    while (encoder.busy()) {
        if (control.cancel) encoder.cancel();
        progress.report(capture.frames(), "encoding");
        SDL_Delay(encoder_poll_ms);
    }
    return true;
}

void run_job(const Spec &spec, const Job &job, Gl &gl, const VideoAvailability &available, Control &control) {
    const auto started = Clock::now();
    emit({{"event", "start"}, {"job", job.index}, {"replay", data_location::utf8(job.replay)}});
    auto loaded = load_job(spec, job, control);
    const auto &options = loaded.options;
    const auto choice = encoder_for(available, options);
    auto renderer = std::make_unique<Renderer>(gl, loaded.map.core.get(), spec.assets);
    configure_renderer(*renderer, spec.settings, options);
    renderer->set_zones(loaded.map.zones);
    renderer->set_cosmetics(loaded.outfit, loaded.loadout);
    NativeHud hud(gl, spec.assets);
    hud.preferences(export_hud_settings(spec.settings, options));
    const uint32_t total = loaded.session.range.total;
    const auto camera = prepare_camera(loaded.map.core.get(), options, total);
    const auto output = unique_output(job.output, job.map, choice.codec);
    NativeVideoExport encoder;
    const auto timeline = VideoTimeline::make(options, total);
    encoder.start(options, output, timeline.frames, available.encoder, choice);
    VideoCapture capture(
            gl,
            loaded.map.core.get(),
            *renderer,
            hud,
            encoder,
            options,
            total,
            {job.map, loaded.session.style, loaded.outfit, loaded.loadout, spec.settings, spec.assets, spec.cache},
            camera
    );
    emit({{"event", "encoder"},
          {"job", job.index},
          {"encoder", choice.name},
          {"codec", choice.codec},
          {"hardware", choice.hardware},
          {"note", choice.note},
          {"frames", timeline.frames},
          {"seconds", timeline.seconds()}});
    Progress progress(job.index, timeline.frames);
    render(capture, encoder, control, progress);
    const auto status = encoder.status();
    const double elapsed = std::chrono::duration<double>(Clock::now() - started).count();
    if (status.at("state") == "completed")
        emit({{"event", "done"},
              {"job", job.index},
              {"path", status.at("path")},
              {"bytes", status.at("bytes")},
              {"elapsed", elapsed},
              {"frames", timeline.frames},
              {"seconds", timeline.seconds()},
              {"encoder", choice.name},
              {"hardware", choice.hardware},
              {"note", choice.note}});
    else if (control.cancel || status.at("state") == "canceled")
        emit({{"event", "canceled"}, {"job", job.index}});
    else
        throw std::runtime_error(status.value("error", std::string("The export failed.")));
}

VideoAvailability encoders_for(const Spec &spec) {
    if (!spec.encoders) return NativeVideoExport::probe(spec.program);
    return {true, "", spec.program, *spec.encoders};
}

int run_jobs(const Spec &spec, Control &control) {
    SDL_SetHint(SDL_HINT_MAC_BACKGROUND_APP, "1");
    if (!SDL_Init(SDL_INIT_VIDEO))
        throw std::runtime_error(std::string("SDL initialization failed: ") + SDL_GetError());
    SDL_SetCurrentThreadPriority(SDL_THREAD_PRIORITY_LOW);
    int failures = 0;
    {
        Surface surface;
        Gl gl;
        gl.load();
        const auto available = encoders_for(spec);
        if (!available.available) throw std::runtime_error(available.reason);
        for (const auto &job : spec.jobs) {
            if (control.cancel) {
                emit({{"event", "canceled"}, {"job", job.index}});
                continue;
            }
            try {
                run_job(spec, job, gl, available, control);
            } catch (const std::exception &error) {
                ++failures;
                emit({{"event", "error"}, {"job", job.index}, {"message", error.what()}});
            }
        }
    }
    SDL_Quit();
    return failures ? 1 : 0;
}

}  // namespace

std::optional<std::filesystem::path> argument(int argc, char **argv) {
    if (argc != 3 || argv[1] != flag) return std::nullopt;
    return data_location::from_utf8(argv[2]);
}

int run(const std::filesystem::path &spec_path) {
    Control control;
    try {
        const auto spec = read_spec(spec_path);
        std::thread(listen, std::ref(control), spec.parent).detach();
        return run_jobs(spec, control);
    } catch (const std::exception &error) {
        emit({{"event", "error"}, {"message", error.what()}});
        return 1;
    }
}

}  // namespace native::video_worker
