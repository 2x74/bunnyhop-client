// Offline full-frame workload. The hidden window never captures input or creates a menu/network client.
#include "renderer.hpp"
#include "hud.hpp"
#include "input_timeline.hpp"
#include "input_scheduler.hpp"
#include "run_session.hpp"
#include "frame_pacing.hpp"
#include "frame_diagnostics.hpp"
#include "low_latency.hpp"
#include "play_priority.hpp"
#include <iomanip>

namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
constexpr uint64_t second_ns = 1'000'000'000;
constexpr uint64_t tick_ns = second_ns / 100;
constexpr double tick_seconds = .01;
constexpr float move_speed = 450;
constexpr unsigned ghost_ticks = 600;
constexpr unsigned scoreboard_rows = 12;
constexpr float overlay_scale = 100;
constexpr double chat_seconds = 1;

enum Phase : size_t {
    pump,
    simulation,
    feedback,
    diagnostics,
    heartbeat,
    actors,
    world,
    hud,
    swap,
    gpu_wait,
    sleep,
    count
};

constexpr std::array<const char *, count> phase_names = {
        "pump",
        "simulation",
        "feedback",
        "diagnostics",
        "heartbeat",
        "actors",
        "world",
        "hud",
        "swap",
        "gpuWait",
        "sleep"
};

struct Spec {
    Json json;
    std::string path, content, output;
    int width, height, frames, warmup, fps, hz, ghosts;
    bool vsync, queued, ordinary_sleep, play_priority;
    std::string low_latency;

    explicit Spec(const char *file) {
        std::ifstream input(file);
        input >> json;
        path = json.at("path");
        content = json.value("contentRoot", std::string());
        output = json.at("out");
        width = json.value("width", 1920);
        height = json.value("height", 1080);
        frames = json.value("frames", 2000);
        warmup = json.value("warmup", 300);
        fps = json.value("fpsLimit", 0);
        hz = json.value("mouseHz", 2000);
        ghosts = json.value("ghosts", 3);
        vsync = json.value("vsync", false);
        queued = json.value("limitQueuedFrames", true);
        ordinary_sleep = json.value("ordinarySleep", false);
        // Windows: the play-time process settings, and presenting through DXGI ("on" or "boost").
        play_priority = json.value("playPriority", false);
        low_latency = json.value("lowLatency", std::string("off"));
        if (!native::valid_low_latency_mode(low_latency)) throw std::runtime_error("Invalid lowLatency");
        if (width < 64 || height < 64 || width > 4096 || height > 4096 || frames < 1 || frames > 100000 || warmup < 0
            || warmup > 10000 || fps < 0 || fps > 10000 || hz < 125 || hz > 8000 || ghosts < 0 || ghosts > 4)
            throw std::runtime_error("Invalid gameplay benchmark bounds");
        std::filesystem::create_directories(std::filesystem::absolute(output).parent_path());
    }
};

struct Surface {
    SDL_Window *window = nullptr;
    SDL_GLContext context = nullptr;

    explicit Surface(const Spec &spec) {
        if (!SDL_Init(SDL_INIT_VIDEO)) throw std::runtime_error(SDL_GetError());
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
        SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
        window = SDL_CreateWindow(
                "Offline gameplay benchmark", spec.width, spec.height, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN
        );
        if (!window) throw std::runtime_error(SDL_GetError());
        context = SDL_GL_CreateContext(window);
        if (!context || !SDL_GL_MakeCurrent(window, context)) throw std::runtime_error(SDL_GetError());
        if (!SDL_GL_SetSwapInterval(spec.vsync ? 1 : 0)) throw std::runtime_error(SDL_GetError());
        int width = 0, height = 0;
        SDL_GetWindowSizeInPixels(window, &width, &height);
        if (width != spec.width || height != spec.height) throw std::runtime_error("Drawable size differs from spec");
    }

    ~Surface() {
        if (context) SDL_GL_DestroyContext(context);
        if (window) SDL_DestroyWindow(window);
        SDL_Quit();
    }
};

Json spread(std::vector<double> values) {
    std::sort(values.begin(), values.end());
    const double mean = std::accumulate(values.begin(), values.end(), 0.) / double(values.size());
    return {{"p50Ms", values[values.size() / 2]},
            {"p99Ms", values[std::min(values.size() - 1, size_t(values.size() * .99))]},
            {"maxMs", values.back()},
            {"meanMs", mean},
            {"fps", mean > 0 ? 1000 / mean : 0}};
}

class Benchmark {
public:
    explicit Benchmark(const Spec &spec) : spec_(spec), surface_(spec), core_(bh_create(), bh_destroy) {
        gl_.load();
        if (!core_) throw std::runtime_error("Cannot create simulation");
        require(bh_load_map(core_.get(), spec.path.c_str(), spec.content.empty() ? nullptr : spec.content.c_str()));
        bh_default_settings(&settings_);
        require(bh_set_settings(core_.get(), &settings_));
        require(bh_snapshot(core_.get(), &snapshot_));
        input_.set_angles(0, snapshot_.player.teleport_angles[1]);
        for (size_t axis = 0; axis < eye_.size(); ++axis)
            eye_[axis] = snapshot_.player.position[axis] + (axis == 2 ? snapshot_.player.view_offset_z : 0);
        if (spec.json.contains("eye")) eye_ = spec.json.at("eye").get<std::array<float, 3>>();
        view_.set_angles(spec.json.value("pitch", 0.), spec.json.value("yaw", input_.yaw()));
        renderer_ = std::make_unique<native::Renderer>(gl_, core_.get());
        renderer_->set_profiling(true);
        renderer_->set_viewmodel_visible(true);
        hud_ = std::make_unique<native::NativeHud>(gl_, BUNNYHOP_NATIVE_ASSET_ROOT);
        auto preferences = native::default_settings();
        preferences = native::patch_settings(preferences, {{"strafeTrainer", true}});
        hud_->preferences(preferences);
        timeline_.rebuild_binds(preferences.at("binds"));
        prepare_panels();
        prepare_recording();
        for (auto &samples : phases_)
            samples.reserve(spec.frames);
        frames_.reserve(spec.frames);
        actor_frames_.resize(spec.ghosts);
    }

    ~Benchmark() { pacer_.release(gl_); }

    void run() {
        const uint64_t started = SDL_GetTicksNS();
        scheduler_.reset(started);
        report_at_ = started;
        diagnostics_.start(started, timeline_.queue(), true);
        uint64_t rasterized = 0;
        play_priority_.update(spec_.play_priority);
        if (!presenter_.configure(surface_.window, native::low_latency_mode(spec_.low_latency), spec_.fps, false))
            throw std::runtime_error("Low latency mode: " + presenter_.error());
        for (int frame = -spec_.warmup; frame < spec_.frames; ++frame) {
            const auto start = Clock::now();
            mark_ = start;
            current_.fill(0);
            frame_diagnostics_.start_frame(SDL_GetTicksNS(), true);
            presenter_.frame_start();
            frame_input();
            frame_ticks();
            frame_diagnostics();
            frame_heartbeat();
            frame_actors();
            presenter_.render_start(spec_.width, spec_.height);
            renderer_->draw(spec_.width, spec_.height, eye_.data(), view_, &snapshot_);
            mark(world);
            frame_hud();
            mark(hud);
            frame_diagnostics_.mark(native::FrameDiagnostics::kRender, SDL_GetTicksNS());
            if (presenter_.active())
                presenter_.present(spec_.vsync);
            else
                SDL_GL_SwapWindow(surface_.window);
            mark(swap);
            frame_diagnostics_.mark(native::FrameDiagnostics::kSwap, SDL_GetTicksNS());
            pacer_.after_swap(gl_, spec_.queued);
            mark(gpu_wait);
            frame_diagnostics_.mark(native::FrameDiagnostics::kGpuWait, SDL_GetTicksNS());
            limiter_.frame(
                    true,
                    false,
                    true,
                    false,
                    false,
                    true,
                    false,
                    std::chrono::duration<double>(Clock::now() - start).count(),
                    SDL_DelayNS,
                    spec_.ordinary_sleep ? SDL_DelayNS : SDL_DelayPrecise
            );
            mark(sleep);
            frame_diagnostics_.mark(native::FrameDiagnostics::kSleep, SDL_GetTicksNS());
            if (frame == -1) rasterized = hud_->rasterizations();
            if (frame >= 0) {
                frames_.push_back(std::chrono::duration<double, std::milli>(Clock::now() - start).count());
                for (size_t phase = 0; phase < count; ++phase)
                    phases_[phase].push_back(current_[phase]);
            }
        }
        write(rasterized);
    }

private:
    const Spec &spec_;
    Surface surface_;
    native::Gl gl_;
    std::unique_ptr<BhContext, decltype(&bh_destroy)> core_;
    std::unique_ptr<native::Renderer> renderer_;
    std::unique_ptr<native::NativeHud> hud_;
    native::Input input_, view_;
    native::InputTimeline timeline_;
    native::InputScheduler scheduler_;
    native::RunDiagnostics diagnostics_;
    native::FrameDiagnostics frame_diagnostics_;
    native::MovementFeedback feedback_;
    native::FramePacer<native::Gl> pacer_;
    native::GraphicsMenuPacer limiter_;
    native::PlayPriority play_priority_;
    native::LowLatencyPresenter presenter_;
    native::Chat chat_;
    native::HudScoreboard board_;
    native::RunHeartbeat heartbeat_;
    BhSnapshot snapshot_{};
    BhSettings settings_{};
    BhRunState run_{};
    BhCmd command_{};
    std::array<float, 3> eye_{};
    std::array<BhGhostFrame, ghost_ticks> ghost_frames_{};
    std::vector<native_render::Actor> actor_frames_;
    std::set<std::string> held_;
    uint64_t report_at_ = 0, next_beat_ = 0;
    uint64_t ticks_ = 0, reports_ = 0;
    bool right_ = false;
    Clock::time_point mark_;
    std::array<double, count> current_{};
    std::array<std::vector<double>, count> phases_;
    std::vector<double> frames_;

    void require(int ok) const {
        if (!ok) throw std::runtime_error(bh_last_error(core_.get()));
    }

    void mark(Phase phase) {
        const auto now = Clock::now();
        current_[phase] += std::chrono::duration<double, std::milli>(now - mark_).count();
        mark_ = now;
    }

    void prepare_panels() {
        board_.head.room = "Offline benchmark";
        board_.head.map = std::filesystem::path(spec_.path).stem().string();
        board_.head.max = scoreboard_rows;
        board_.count = scoreboard_rows;
        for (size_t index = 0; index < board_.count; ++index) {
            auto &row = board_.rows[index];
            row.slot = unsigned(index);
            row.name = "Runner " + std::to_string(index + 1);
            row.style = "autohop";
            row.timer = 1;
            row.seconds = double(index);
            row.ping = 20 + unsigned(index);
        }
        for (unsigned index = 0; index < 8; ++index)
            chat_.push("A busy offline chat line with timing and player names", "Runner", "chat", chat_seconds);
        limiter_.game_limit = spec_.fps;
    }

    void prepare_recording() {
        BhRunOptions options{};
        bh_default_run_options(&options);
        BhZone start{};
        constexpr float start_radius = 8;
        for (size_t axis = 0; axis < 3; ++axis) {
            start.mins[axis] = snapshot_.player.position[axis] - start_radius;
            start.maxs[axis] = snapshot_.player.position[axis] + start_radius;
        }
        const BhZone zones[] = {start, {1, 0, 0, {-30000, -30000, -30000}, {-29900, -29900, -29900}}};
        require(bh_run_configure(core_.get(), &options, zones, 2));
        require(bh_record_begin(core_.get(), "", "autohop", "Offline benchmark", 100));
        BhState state{};
        for (unsigned tick = 0; tick < ghost_ticks; ++tick) {
            BhCmd command{};
            command.buttons = native::jump | native::forward;
            command.forward = move_speed;
            command.yaw = float(input_.yaw());
            require(bh_step(core_.get(), &command, &state));
            auto &frame = ghost_frames_[tick];
            std::copy_n(state.position, 3, frame.position);
            std::copy_n(state.velocity, 3, frame.velocity);
            frame.tick = state.tick;
            frame.yaw = command.yaw;
            frame.view_offset_z = state.view_offset_z;
            frame.flags = (state.crouched ? 1 : 0) | (state.grounded ? 2 : 0);
        }
        require(bh_record_end(core_.get()));
        require(bh_reset(core_.get()));
        require(bh_record_begin(core_.get(), "", "autohop", "Offline benchmark", 100));
        require(bh_snapshot(core_.get(), &snapshot_));
        heartbeat_.begin(0);
    }

    void frame_input() {
        SDL_Event event{};
        while (SDL_PollEvent(&event)) {
        }
        const uint64_t now = SDL_GetTicksNS();
        auto pump_schedule = scheduler_;
        pump_schedule.frame(now, true, tick_ns);
        timeline_.begin_pump(input_, now, pump_schedule, tick_ns);
        const uint64_t interval = second_ns / uint64_t(spec_.hz);
        while (report_at_ + interval <= now) {
            report_at_ += interval;
            const bool right = (reports_ / uint64_t(spec_.hz / 5)) % 2 != 0;
            if (reports_ == 0 || right != right_) {
                timeline_.key(held_, right_ ? "KeyD" : "KeyA", false, false, report_at_, now);
                timeline_.key(held_, right ? "KeyD" : "KeyA", true, false, report_at_, now);
                right_ = right;
            }
            const double counts = right ? 1 : -1;
            timeline_.motion(input_, report_at_, now, counts, 0);
            diagnostics_.motion(report_at_, now, counts, 0);
            ++reports_;
        }
        scheduler_.frame(now, true, tick_ns);
        timeline_.begin_frame(input_, true, now);
        mark(pump);
        frame_diagnostics_.mark(native::FrameDiagnostics::kPump, SDL_GetTicksNS());
    }

    void frame_ticks() {
        while (scheduler_.due(tick_ns)) {
            const BhState previous = snapshot_.player;
            timeline_.take_tick(input_, scheduler_.sim_ns, tick_ns, false);
            input_.held = timeline_.held(held_) | native::jump | native::forward;
            command_ = input_.command();
            const auto look = input_.look_sample();
            require(bh_step_look_v2(core_.get(), &command_, look ? &*look : nullptr, &snapshot_.player));
            require(bh_last_command(core_.get(), &command_));
            input_.events(snapshot_.player);
            require(bh_snapshot(core_.get(), &snapshot_));
            require(bh_run_state(core_.get(), &run_));
            scheduler_.consume(tick_ns);
            ++ticks_;
            mark(simulation);
            tick_feedback(previous);
            mark(feedback);
        }
        input_.frame();
        frame_diagnostics_.mark(native::FrameDiagnostics::kSimulation, SDL_GetTicksNS());
    }

    void tick_feedback(const BhState &previous) {
        renderer_->simulation_tick();
        hud_->movement.tick_jump(command_, snapshot_.player);
        hud_->tick(snapshot_.player);
        hud_->command_tick(command_, snapshot_.player.tick);
        const native::SsjState pre{
                previous.position, previous.velocity, bool(previous.grounded), bool(previous.on_ladder)
        };
        const native::SsjCmd command{command_.forward, command_.side, command_.yaw, command_.buttons};
        native::SsjTick info;
        info.jumped = snapshot_.player.events & 2;
        info.teleported = snapshot_.player.events & native::teleported;
        info.time = run_.seconds;
        hud_->configure_feedback(feedback_);
        if (const auto report = feedback_.ssj.tick(pre, command, info)) hud_->ssj_report(*report);
        native::feed_strafe_trainer(
                feedback_, hud_->preferences(), snapshot_.player, command, settings_, "autohop", tick_seconds, false
        );
        BhJumpObservation jump{};
        const bool observed = bh_jump_observation(core_.get(), &jump);
        hud_->movement.feed(observed ? &jump : nullptr, run_, tick_seconds, "autohop", true, false, false);
    }

    void frame_diagnostics() {
        diagnostics_.frame(SDL_GetTicksNS(), timeline_.queue());
        frame_diagnostics_.input(timeline_.queue());
        mark(diagnostics);
    }

    void frame_heartbeat() {
        if (ticks_ >= next_beat_) {
            heartbeat_.fold(core_.get(), run_);
            next_beat_ = ticks_ + 400;
        }
        mark(heartbeat);
    }

    void frame_actors() {
        for (size_t slot = 0; slot < actor_frames_.size(); ++slot) {
            auto &actor = actor_frames_[slot];
            actor.id = "ghost-" + std::to_string(slot);
            actor.opacity = .5f;
            actor.ghost_slot = int(slot);
            actor.frame = ghost_frames_[ticks_ % ghost_ticks];
            // Separate the ghosts in front of the fixed profiling camera so all draw every frame.
            constexpr float forward_distance = 150, spacing = 45;
            const double radians = view_.yaw() * native::ssj_detail::pi / 180;
            const float side = float(slot) * spacing;
            actor.frame.position[0] =
                    eye_[0] + float(std::cos(radians)) * forward_distance - float(std::sin(radians)) * side;
            actor.frame.position[1] =
                    eye_[1] + float(std::sin(radians)) * forward_distance + float(std::cos(radians)) * side;
            actor.frame.position[2] = eye_[2] - actor.frame.view_offset_z;
        }
        renderer_->set_room_actors(actor_frames_);
        mark(actors);
    }

    void frame_hud() {
        BhWeaponReport weapon{};
        bh_weapon_report(core_.get(), &weapon);
        hud_->draw(
                spec_.width,
                spec_.height,
                snapshot_,
                run_,
                command_,
                board_.head.map,
                "autohop",
                "",
                frames_.empty() ? 1000 : 1000 / frames_.back(),
                true,
                true,
                false,
                weapon,
                hud_->ssj_line(),
                feedback_.ssj_gain,
                feedback_.strafe_reading,
                true
        );
        hud_->draw_chat_overlay(
                spec_.width, spec_.height, chat_.visible(chat_seconds), "", "", {}, false, 0, overlay_scale
        );
        hud_->scoreboard(
                spec_.width, spec_.height, overlay_scale, board_, double(ticks_) * tick_seconds, 0, run_, "autohop"
        );
    }

    void write(uint64_t rasterized) {
        const auto string = [this](GLenum name) {
            return std::string(reinterpret_cast<const char *>(gl_.GetString(name)));
        };
        size_t summary_bytes = 0;
        const auto *summary = bh_record_summary_json(core_.get(), &summary_bytes);
        const Json recording = summary && summary_bytes ? Json::parse(summary, summary + summary_bytes) : Json();
        Json result = {
                {"schema", 1},
                {"recording", recording},
                {"spec", spec_.json},
                {"presenter", presenter_.active() ? std::string(presenter_.technique()) : std::string("OpenGL swap")},
                {"gpu", string(GL_RENDERER)},
                {"driver", string(GL_VERSION)},
                {"sdl", SDL_GetVersion()},
                {"frame", spread(frames_)},
                {"framesMs", frames_},
                {"ticks", ticks_},
                {"reports", reports_},
                {"runStatus", run_.status},
                {"rasterizationsMeasured", hud_->rasterizations() - rasterized},
                {"rendererLast", renderer_->profile_json()},
                {"method",
                 "Hidden fixed camera; real timed input, canonical simulation/recording, SSJ/trainer, "
                 "run diagnostics, 4s heartbeat, cached ghost fixtures, HUD/chat/12-row scoreboard, swap/fence/cap. "
                 "No menu, audio, network or real input devices; hidden swap is not display latency."}
        };
        for (size_t phase = 0; phase < count; ++phase)
            result["phases"][phase_names[phase]] = spread(phases_[phase]);
        if (gl_.GetError() != GL_NO_ERROR) throw std::runtime_error("Benchmark OpenGL error");
        std::ofstream output(spec_.output);
        output << result.dump(2) << '\n';
        if (!output) throw std::runtime_error("Cannot write benchmark result");
        std::cout << result.at("frame").dump() << '\n';
    }
};
}  // namespace

int main(int argc, char **argv) {
    try {
        if (argc != 2) throw std::runtime_error("usage: bunnyhop-native-gameplay-benchmark SPEC.json");
        const Spec spec(argv[1]);
        Benchmark(spec).run();
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "Gameplay benchmark: " << error.what() << '\n';
        return 1;
    }
}
