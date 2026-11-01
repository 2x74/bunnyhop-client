#include "smoke_graphics.hpp"
#include "renderer.hpp"
#include "video_frames.hpp"
#include <filesystem>

namespace {
void write_ppm(const std::filesystem::path &path, const std::vector<uint8_t> &rgba, int width, int height) {
    std::ofstream file(path, std::ios::binary);
    file << "P6\n" << width << ' ' << height << "\n255\n";
    for (int y = height - 1; y >= 0; --y)
        for (int x = 0; x < width; ++x)
            file.write(reinterpret_cast<const char *>(rgba.data() + (size_t(y) * width + x) * 4), 3);
    if (!file) throw std::runtime_error("Cannot write video fixture");
}

void capture(native::gfx::Context &context, const std::filesystem::path &output, int supersample, int samples) {
    constexpr int width = 160, height = 90;
    native::VideoFrameTargets targets(context, width, height, supersample, samples);
    native::NativePresentation presentation(context);
    const std::array<native_render::Vec3, 4> quad = {{{-.8f, -.7f, 0}, {.2f, -.7f, 0}, {.2f, .5f, 0}, {-.8f, .5f, 0}}};
    const float eye[] = {0, 0, 2};
    // More frames than slots exercise slot reuse and a full asynchronous ring.
    for (size_t frame = 0; frame < 6; ++frame) {
        targets.begin_frame();
        for (int sample = 0; sample < samples; ++sample) {
            targets.bind_scene();
            context.depth_write(true);
            context.clear_color({.125f, .25f, .5f + float(sample) * .125f, 1});
            context.clear_depth();
            presentation.clear();
            presentation.quad(quad, {1, .25f, float(frame) * .125f, .75f});
            presentation.draw(native::identity(), eye);
            targets.add_sample(samples);
        }
        targets.resolve();
        const size_t slot = frame % native::VideoFrameTargets::readback_slots;
        if (targets.pending(slot)) throw std::runtime_error("Readback slot was not collected");
        targets.read_back(slot);
        if (frame < 2) continue;
        const size_t oldest = (frame - 2) % native::VideoFrameTargets::readback_slots;
        std::vector<uint8_t> pixels;
        targets.collect(oldest, pixels);
        write_ppm(
                output
                        / (std::to_string(supersample) + "x-" + std::to_string(samples) + "samples-"
                           + std::to_string(frame - 2) + ".ppm"),
                pixels,
                width,
                height
        );
    }
    for (size_t frame = 4; frame < 6; ++frame) {
        std::vector<uint8_t> pixels;
        targets.collect(frame % native::VideoFrameTargets::readback_slots, pixels);
        write_ppm(
                output
                        / (std::to_string(supersample) + "x-" + std::to_string(samples) + "samples-"
                           + std::to_string(frame) + ".ppm"),
                pixels,
                width,
                height
        );
    }
}
}  // namespace

int main(int argc, char **argv) {
    SDL_SetHint(SDL_HINT_MAC_BACKGROUND_APP, "1");
    try {
        if (argc != 2) throw std::runtime_error("usage: video-frames-smoke OUTPUT_DIRECTORY");
        if (!SDL_Init(SDL_INIT_VIDEO)) throw std::runtime_error(SDL_GetError());

        struct Sdl {
            ~Sdl() { SDL_Quit(); }
        } sdl;

        native::SmokeGraphics surface(64, 64);
        auto &graphics = surface.context();
        std::filesystem::create_directories(argv[1]);
        capture(graphics, argv[1], 1, 1);
        capture(graphics, argv[1], 2, 3);
        graphics.check_error("Video fixture");
        std::cout << "12 video frames; GL_NO_ERROR\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
