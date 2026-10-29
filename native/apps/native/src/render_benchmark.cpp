// Matched scene throughput, not gameplay FPS. Every frame waits for a one-pixel GPU readback.
#include "renderer.hpp"
#include <chrono>
#include <filesystem>

int main(int argc, char **argv) {
    try {
        if (argc != 2) throw std::runtime_error("usage: bunnyhop-native-render-benchmark SPEC.json");
        std::ifstream spec_file(argv[1]);
        nlohmann::json spec;
        spec_file >> spec;
        const auto path = spec.at("path").get<std::string>(), content = spec.value("contentRoot", std::string()),
                   out = spec.at("out").get<std::string>();
        const bool profiling = spec.value("profile", false), sourceLook = spec.value("sourceLook", false),
                   effects = spec.value("effects", true), floorWeapons = spec.value("floorWeapons", true);
        const auto syncMode = spec.value("sync", std::string("readback"));
        if (syncMode != "readback" && syncMode != "finish" && syncMode != "batch")
            throw std::runtime_error("Invalid sync mode");
        const int width = spec.at("width"), height = spec.at("height"), frames = spec.value("frames", 600),
                  warmup = spec.value("warmup", 120);
        if (width < 64 || height < 64 || width > 4096 || height > 4096 || frames < 1 || frames > 100000 || warmup < 0
            || warmup > 10000)
            throw std::runtime_error("Invalid benchmark bounds");
        if (!SDL_Init(SDL_INIT_VIDEO)) throw std::runtime_error(SDL_GetError());

        struct Sdl {
            ~Sdl() { SDL_Quit(); }
        } sdl;

        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
        SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
        auto *window = SDL_CreateWindow("Native scene benchmark", width, height, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
        if (!window) throw std::runtime_error(SDL_GetError());

        struct Window {
            SDL_Window *w;

            ~Window() { SDL_DestroyWindow(w); }
        } cleanup{window};

        auto context = SDL_GL_CreateContext(window);
        if (!context) throw std::runtime_error(SDL_GetError());

        struct Context {
            SDL_GLContext c;

            ~Context() { SDL_GL_DestroyContext(c); }
        } contextCleanup{context};

        SDL_GL_MakeCurrent(window, context);
        SDL_GL_SetSwapInterval(0);
        native::Gl gl;
        gl.load();
        const auto finish = reinterpret_cast<void(APIENTRY *)()>(SDL_GL_GetProcAddress("glFinish"));
        if (!finish) throw std::runtime_error("Missing glFinish");
        using Core = std::unique_ptr<BhContext, decltype(&bh_destroy)>;
        Core core(bh_create(), &bh_destroy);
        if (!core || !bh_load_map(core.get(), path.c_str(), content.empty() ? nullptr : content.c_str()))
            throw std::runtime_error(core ? bh_last_error(core.get()) : "core creation failed");
        BhSettings settings{};
        bh_default_settings(&settings);
        if (!bh_set_settings(core.get(), &settings)) throw std::runtime_error(bh_last_error(core.get()));
        BhSnapshot snapshot{};
        bh_snapshot(core.get(), &snapshot);
        std::array<float, 3> eye{};
        for (int k = 0; k < 3; k++)
            eye[k] = snapshot.player.position[k] + (k == 2 ? snapshot.player.view_offset_z : 0);
        if (spec.contains("eye")) eye = spec.at("eye").get<std::array<float, 3>>();
        const float yaw = spec.value("yaw", snapshot.player.teleport_angles[1]), pitch = spec.value("pitch", 0.f);
        native::Input input;
        input.set_angles(pitch, yaw);
        native::Renderer renderer(gl, core.get());
        renderer.set_viewmodel_visible(false);
        renderer.set_zones_visible(false);
        renderer.set_triggers_visible(false);
        renderer.set_fov(90);
        renderer.set_water_quality(spec.value("waterQuality", 0));
        if (spec.contains("graphics")) renderer.graphics_settings(spec.at("graphics"));
        renderer.set_source_look(sourceLook);
        renderer.set_effects_visible(effects);
        renderer.set_profiling(profiling);
        renderer.set_floor_weapons_visible(floorWeapons);
        int actual_width = 0, actual_height = 0;
        SDL_GetWindowSizeInPixels(window, &actual_width, &actual_height);
        if (actual_width != width || actual_height != height)
            throw std::runtime_error("Drawable resolution differs from requested resolution");
        uint8_t pixel[4]{};
        auto sync = [&] {
            if (syncMode != "batch") finish();
            if (syncMode == "readback") gl.ReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, pixel);
        };
        for (int i = 0; i < warmup; i++) {
            renderer.draw(width, height, eye.data(), input, &snapshot, double(i) / 60);
            sync();
        }
        finish();
        using Clock = std::chrono::steady_clock;
        std::vector<double> wall, submission, finishTimes, readbackTimes;
        nlohmann::json profileSums = nlohmann::json::object();
        wall.reserve(frames);
        submission.reserve(frames);
        const auto batchStart = Clock::now();
        for (int i = 0; i < frames; i++) {
            SDL_PumpEvents();
            const auto start = Clock::now();
            renderer.draw(width, height, eye.data(), input, &snapshot, double(warmup + i) / 60);
            const auto submitted = Clock::now();
            if (syncMode != "batch") finish();
            const auto finished = Clock::now();
            if (syncMode == "readback") gl.ReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, pixel);
            const auto complete = Clock::now();
            submission.push_back(std::chrono::duration<double, std::milli>(submitted - start).count());
            wall.push_back(std::chrono::duration<double, std::milli>(complete - start).count());
            finishTimes.push_back(std::chrono::duration<double, std::milli>(finished - submitted).count());
            readbackTimes.push_back(std::chrono::duration<double, std::milli>(complete - finished).count());
            if (profiling) {
                const auto sample = renderer.profile_json();
                for (const auto &[key, value] : sample.items())
                    if (value.is_number()) profileSums[key] = profileSums.value(key, 0.) + value.get<double>();
            }
        }
        finish();
        const double batchMs = std::chrono::duration<double, std::milli>(Clock::now() - batchStart).count();
        const auto error = gl.GetError();
        if (error) throw std::runtime_error("OpenGL error " + std::to_string(error));
        std::filesystem::create_directories(std::filesystem::absolute(out).parent_path());
        renderer.screenshot(out + ".ppm", width, height);
        auto stats = [](std::vector<double> v) {
            std::sort(v.begin(), v.end());
            const double mean = std::accumulate(v.begin(), v.end(), 0.) / v.size();
            return nlohmann::json{
                    {"mean", mean},
                    {"p50", v[v.size() / 2]},
                    {"p95", v[std::min(v.size() - 1, size_t(v.size() * .95))]},
                    {"p99", v[std::min(v.size() - 1, size_t(v.size() * .99))]},
                    {"max", v.back()},
                    {"fps", 1000 / mean}
            };
        };
        const auto str = [&](GLenum key) {
            return std::string(reinterpret_cast<const char *>(gl.GetString(key)));
        };
        nlohmann::json result = {
                {"schema", 1},
                {"engine", "native"},
                {"map", spec.at("map")},
                {"width", width},
                {"height", height},
                {"eye", eye},
                {"yaw", yaw},
                {"pitch", pitch},
                {"frames", frames},
                {"warmup", warmup},
                {"gpu", str(GL_RENDERER)},
                {"driver", str(GL_VERSION)},
                {"wallMs", wall},
                {"submissionMs", submission},
                {"wall", stats(wall)},
                {"submission", stats(submission)},
                {"method",
                 "fixed-camera world render + glFinish + one-pixel readback; no presentation, simulation, UI or "
                 "network"},
                {"settings",
                 {{"fovDesired", 90},
                  {"waterQuality", spec.value("waterQuality", 0)},
                  {"graphics", spec.value("graphics", nlohmann::json::object())},
                  {"viewmodel", false},
                  {"zones", false},
                  {"triggers", false}}}
        };
        for (auto &[key, value] : profileSums.items())
            value = value.get<double>() / frames;
        result["profileMean"] = profileSums;
        result["profileLast"] = renderer.profile_json();
        result["profiling"] = profiling;
        result["finishMs"] = finishTimes;
        result["readbackMs"] = readbackTimes;
        result["sync"] = syncMode;
        result["batchMs"] = batchMs;
        result["batchFPS"] = 1000 * frames / batchMs;
        result["settings"]["sourceLook"] = sourceLook;
        result["settings"]["effects"] = effects;
        result["settings"]["floorWeapons"] = floorWeapons;
        result["visualTime"] = "warmup starts at 0; measured starts at warmup/60";
        result["method"] = "Fixed camera world render; sync=" + syncMode
                           + "; batch includes final GPU completion; no window presentation, simulation, UI or network";
        std::ofstream(out) << result.dump(2) << '\n';
        std::cout << nlohmann::json{{"out", out}, {"wall", result["wall"]}, {"eye", eye}, {"yaw", yaw}}.dump() << '\n';
        return 0;
    } catch (const std::exception &e) {
        std::cerr << "Render benchmark: " << e.what() << '\n';
        return 1;
    }
}
