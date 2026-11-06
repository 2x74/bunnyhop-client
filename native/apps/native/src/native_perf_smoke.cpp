// Hidden-window benchmark of first-sight players and every cosmetic preview category.
#include "menu_backdrop.hpp"
#include "loadout_preview_service.hpp"
#include "base64.hpp"
#include "native_perf_probe.hpp"
#include "native_perf_checks.hpp"
#include "native_perf_stdio.hpp"

namespace {
constexpr int width = 640, height = 480;

std::string
packed(const std::string &knife,
       const std::string &finish,
       const std::string &glove,
       const std::string &hilt = "",
       const std::string &camo = "",
       const std::string &hat = "") {
    return "2;knife-" + knife + ";" + finish + ";" + glove + ";;" + hat + ";;;;;" + hilt + ";" + camo;
}

nlohmann::json preview_job(const std::string &look, const std::string &view = "fp") {
    return {{"id", 1},
            {"loadout", look},
            {"outfit", "outfit-cream"},
            {"ghost", "ghost-gold"},
            {"view", view},
            {"weapon", 17},
            {"yaw", 0},
            {"pitch", 0},
            {"inspect", 0},
            {"held", false},
            {"width", 384},
            {"height", 240}};
}

void save(const std::filesystem::path &output, const std::string &name, const std::string &png) {
    if (png.size() < 1000) throw std::runtime_error("Blank capture: " + name);
    std::ofstream(output / (name + ".png"), std::ios::binary) << png;
}

nlohmann::json
join(native::Gl &gl, const std::filesystem::path &assets, const std::filesystem::path &output, bool scheduled) {
    auto models = std::make_unique<native::NativeViewmodel>(gl, assets);
    std::unique_ptr<native::ActorWarmup> warmup;
    if (scheduled) {
        models->prepare_room_fallback();
        warmup = std::make_unique<native::ActorWarmup>(assets);
    }
    const std::array<std::string, 6> looks = {
            packed("bunnyfly", "fin-geode", "glove-dress-lapis", "hilt-geode", "camo-lapis"),
            packed("leek", "fin-aurora", "glove-aviator-bomber", "hilt-bamboo", "camo-woodland"),
            packed("sprouts", "fin-rift", "glove-mitts-whiteout", "hilt-antler", "camo-snow"),
            packed("whirligig", "fin-spectrum", "glove-dress-dealer", "hilt-borealis", "camo-riptide"),
            packed("parsnip", "fin-goldleaf", "glove-mitts-tidepool", "hilt-cork", "camo-picnic"),
            packed("bunnyfly", "fin-geode", "glove-dress-lapis", "hilt-geode", "camo-lapis")
    };
    const float eye[3] = {110, 0, 40};
    const auto projection = native::camera_matrix(eye, 180, 8, float(width) / height);
    nlohmann::json result = nlohmann::json::array();
    for (size_t index = 0; index < looks.size(); ++index) {
        native_render::Actor actor;
        actor.id = "join-" + std::to_string(index);
        actor.outfit = "outfit-cream";
        actor.loadout = looks[index];
        actor.opacity = 1;
        actor.frame.weapon = index == 1 || index == 3 ? 10 : 1;
        actor.frame.flags = 2;
        actor.playerGlow =
                native_render::parse_glow({{"enabled", true}, {"aura", true}, {"color", "violet"}, {"intensity", 1}});
        native_perf::reset();
        std::vector<double> frames;
        double worst_block = 0;
        const auto joined = native_perf::Clock::now();
        double ready_ms = -1;
        int ready_frames = 0;
        for (int frame = 0; frame < 1200 && ready_frames < 30; ++frame) {
            const auto start = native_perf::Clock::now();
            if (warmup) native_perf::timed("Admission", [&] { warmup->frame(std::span(&actor, 1), *models); });
            if (!warmup || warmup->ready(actor)) {
                if (ready_ms < 0) ready_ms = native_perf::elapsed(joined);
                ++ready_frames;
            }
            gl.Viewport(0, 0, width, height);
            gl.ClearColor(.55f, .62f, .7f, 1);
            gl.DepthMask(GL_TRUE);
            gl.Clear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
            native_perf::timed("DrawActor", [&] {
                if (warmup)
                    warmup->draw(*models, actor, projection, eye, 2.);
                else
                    models->draw_actor(actor, projection, eye, 2.);
            });
            worst_block = std::max(worst_block, native_perf::elapsed(start));
            const auto finish = reinterpret_cast<void(APIENTRY *)()>(SDL_GL_GetProcAddress("glFinish"));
            native_perf::timed("Finish", [&] { finish(); });
            frames.push_back(native_perf::elapsed(start));
            if (ready_frames == 30) save(output, actor.id, backbuffer_png(gl, width, height, 4000000));
            std::this_thread::sleep_until(start + std::chrono::microseconds(16667));
        }
        for (int view = 0; view < 2; ++view) {
            const float side_eye[3] = {view ? -110.f : 0.f, view ? 0.f : -110.f, 40};
            const auto side_projection = native::camera_matrix(side_eye, view ? 0 : 90, 8, float(width) / height);
            gl.Clear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
            models->draw_actor(actor, side_projection, side_eye, 2.);
            save(output, actor.id + (view ? "-back" : "-side"), backbuffer_png(gl, width, height, 4000000));
        }
        if (ready_ms < 0) throw std::runtime_error("Join warm-up timeout");
        result.push_back(
                {{"readyLatencyMs", ready_ms},
                 {"look", looks[index]},
                 {"weapon", actor.frame.weapon},
                 {"framesMs", frames},
                 {"worstFrameMs", *std::max_element(frames.begin(), frames.end())},
                 {"gameThreadBlockMs", worst_block},
                 {"gl", native_perf::calls},
                 {"stacks", native_perf::stacks}}
        );
    }
    native_perf::recording = false;
    models.reset();
    warmup.reset();
    return result;
}

nlohmann::json
loadout(native::Gl &gl, const std::filesystem::path &assets, const std::filesystem::path &output, bool scheduled) {
    std::unique_ptr<LoadoutPreviewService> preview;
    std::unique_ptr<NativeLoadoutPreview> direct;
    if (scheduled)
        preview = std::make_unique<LoadoutPreviewService>(assets, 2.);
    else
        direct = std::make_unique<NativeLoadoutPreview>(gl, assets);
    nlohmann::json metadata;
    std::ifstream(assets / "viewmodels.json") >> metadata;
    std::vector<std::pair<std::string, nlohmann::json>> jobs;
    const auto default_look = packed("carrot", "fin-garden", "glove-knit");
    auto add = [&](const std::string &name, nlohmann::json job) {
        jobs.emplace_back(name, std::move(job));
    };
    for (const auto &[id, value] : metadata.at("inspects").items())
        add("knife-" + id, preview_job(packed(id, "fin-garden", "glove-knit"), "knife"));
    for (const auto &[id, value] : metadata.at("finishes").items())
        add(id, preview_job(packed("carrot", id, "glove-knit"), "knife"));
    for (const auto &[id, value] : metadata.at("gloves").items())
        add(id, preview_job(packed("carrot", "fin-garden", id)));
    for (const auto &[id, value] : metadata.at("outfits").items()) {
        auto job = preview_job(default_look, "bunny");
        job["outfit"] = id;
        add(id, job);
    }
    for (const auto &[id, value] : metadata.at("hats").items())
        add(id, preview_job(packed("carrot", "fin-garden", "glove-knit", "", "", id), "bunny"));
    for (const auto &[id, value] : metadata.at("ghostColors").items()) {
        auto job = preview_job(default_look, "ghost");
        job[id.starts_with("trail-") ? "trail" : "ghost"] = id;
        add(id, job);
    }
    for (const auto *category : {"hilts", "camos"}) {
        if (!metadata.contains(category)) continue;
        for (const auto &[id, value] : metadata.at(category).items()) {
            const bool hilt = std::string(category) == "hilts";
            add(id,
                preview_job(
                        packed("carrot", "fin-garden", "glove-knit", hilt ? id : "", hilt ? "" : id),
                        hilt ? "hilt" : "gunside"
                ));
        }
    }
    auto stage = preview_job(default_look);
    stage["width"] = 960;
    stage["height"] = 600;
    add("stage", stage);
    nlohmann::json result = nlohmann::json::array();
    unsigned serial = 0;
    for (int pass = 0; pass < 2; ++pass) {
        for (auto &[name, job] : jobs) {
            native_perf::reset();
            job["id"] = ++serial;
            job["thumbnail"] = name != "stage";
            const auto start = native_perf::Clock::now();
            std::string uri;
            if (direct)
                uri = "data:image/png;base64," + native::base64(direct->render(job, 2.));
            else
                preview->request(job);
            double block_ms = native_perf::elapsed(start);
            double frame_ms = block_ms;
            while (native_perf::elapsed(start) < 30000 && uri.empty()) {
                const auto poll_start = native_perf::Clock::now();
                const auto replies = preview->take_replies();
                if (!replies.empty()) {
                    const auto first = replies.front().find('(');
                    const auto reply = nlohmann::json::parse(
                            replies.front().substr(first + 1, replies.front().size() - first - 2)
                    );
                    uri = reply.at("png");
                    if (uri.empty()) throw std::runtime_error("Empty async preview: " + name);
                }
                block_ms = std::max(block_ms, native_perf::elapsed(poll_start));
                gl.Clear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
                const auto finish = reinterpret_cast<void(APIENTRY *)()>(SDL_GL_GetProcAddress("glFinish"));
                finish();
                frame_ms = std::max(frame_ms, native_perf::elapsed(poll_start));
                std::this_thread::sleep_until(poll_start + std::chrono::microseconds(16667));
            }
            if (uri.empty()) throw std::runtime_error("Preview timeout: " + name);
            const double latency_ms = native_perf::elapsed(start);
            const auto png = native::base64_decode(uri.substr(uri.find(',') + 1)).value();
            if (pass == 0) save(output, "tile-" + name, png);
            result.push_back(
                    {{"name", name},
                     {"pass", pass},
                     {"gameThreadBlockMs", block_ms},
                     {"worstFrameMs", frame_ms},
                     {"readyLatencyMs", latency_ms},
                     {"bytes", uri.size()},
                     {"gl", native_perf::calls},
                     {"stacks", native_perf::stacks}}
            );
        }
    }
    native_perf::recording = false;
    return result;
}
}  // namespace

int main(int argc, char **argv) {
    try {
        if (argc != 4) throw std::runtime_error("usage: native-perf-smoke ASSETS OUTPUT join|loadout|checks");
        if (!SDL_Init(SDL_INIT_VIDEO)) throw std::runtime_error(SDL_GetError());
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
        SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
        auto *window = SDL_CreateWindow("Native perf", width, height, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
        if (!window) throw std::runtime_error(SDL_GetError());
        auto context = SDL_GL_CreateContext(window);
        if (!context) throw std::runtime_error(SDL_GetError());
        SDL_GL_MakeCurrent(window, context);
        SDL_GL_SetSwapInterval(0);
        native::Gl gl;
        gl.load();
        native_perf::install(gl);
        if (std::string(argv[2]) == "--stdio") {
            native_perf::serve_previews(argv[1]);
            SDL_GL_DestroyContext(context);
            SDL_DestroyWindow(window);
            SDL_Quit();
            return 0;
        }
        std::filesystem::create_directories(argv[2]);
        nlohmann::json report = {
                {"vendor", reinterpret_cast<const char *>(gl.GetString(GL_VENDOR))},
                {"renderer", reinterpret_cast<const char *>(gl.GetString(GL_RENDERER))},
                {"version", reinterpret_cast<const char *>(gl.GetString(GL_VERSION))},
                {"parallelShaderCompile", bool(SDL_GL_ExtensionSupported("GL_KHR_parallel_shader_compile"))}
        };
        const std::string mode = argv[3];
        if (mode == "checks") {
            report["compilation"] = native_perf::compilation_checks(gl, argv[1]);
            report["lifecycle"] = native_perf::lifecycle_checks(gl, argv[1]);
            report["cancellation"] = native_perf::cancellation_checks(argv[1]);
        } else {
            const bool scheduled = !mode.ends_with("-sync");
            if (mode != "join" && mode != "join-sync" && mode != "loadout" && mode != "loadout-sync")
                throw std::runtime_error("Unknown perf mode");
            report["mode"] = mode;
            report["samples"] = mode.starts_with("join") ? join(gl, argv[1], argv[2], scheduled)
                                                         : loadout(gl, argv[1], argv[2], scheduled);
        }
        if (gl.GetError() != GL_NO_ERROR) throw std::runtime_error("Perf GL error");
        std::ofstream(std::filesystem::path(argv[2]) / "results.json") << report.dump(2);
        SDL_GL_DestroyContext(context);
        SDL_DestroyWindow(window);
        SDL_Quit();
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
