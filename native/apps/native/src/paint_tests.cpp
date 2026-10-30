#include "paint.hpp"
#include "render_menu_contracts.hpp"
#include "test_bsp.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <filesystem>
#include <fstream>
#include <memory>

namespace {
struct Presentation {
    size_t faces = 0;
    double area = 0;

    void
    decal(const std::array<native_render::Vec3, 4> &points,
          const std::array<float, 4> &color,
          const std::array<std::array<float, 2>, 4> &uv) {
        assert(color[3] == 1);
        ++faces;
        for (size_t vertex = 0; vertex < points.size(); ++vertex) {
            assert(uv[vertex][0] >= 0 && uv[vertex][0] <= 1);
            assert(uv[vertex][1] >= 0 && uv[vertex][1] <= 1);
            // The projector at (20,20) has right=(-1,0), up=(0,-1) and diameter=32.
            assert(std::abs(uv[vertex][0] - ((20 - points[vertex][0]) / 32 + .5f)) < .001f);
            assert(std::abs(uv[vertex][1] - ((20 - points[vertex][1]) / 32 + .5f)) < .001f);
        }
        const double width = points[1][0] - points[0][0], height = points[2][1] - points[0][1];
        const double other_width = points[2][0] - points[0][0], other_height = points[1][1] - points[0][1];
        area += std::abs(width * height - other_width * other_height) / 2;
    }
};

// Paint keeps every mark inline (about 1.3 MB), more than a Windows thread's default stack.
std::unique_ptr<native_render::Paint> make_paint() {
    return std::make_unique<native_render::Paint>();
}

void cadence() {
    const auto paint_owner = make_paint();
    auto &paint = *paint_owner;
    assert(paint.request(1, false));
    assert(!paint.request(1.05, true));
    constexpr double frames_per_second = 144;
    unsigned attempts = 0;
    for (unsigned frame = 1; frame <= 288; ++frame) {
        const double now = 1 + frame / frames_per_second;
        if (!paint.ready(now, true)) continue;
        // The frame gate and placement share a clock, even when the raycast begins a little later.
        assert(paint.request(now + .0001, true));
        ++attempts;
        if (frame == 150) paint.settings(native::default_graphics_settings());
    }
    assert(attempts == 19);              // One 100 ms limit, rounded up to the next rendered frame.
    assert(paint.request(3.01, false));  // Single marks bypass the held-stroke limit.
    paint.clear();
    assert(paint.request(3.02, true));
}

void projection_and_spacing() {
    const auto root = std::filesystem::temp_directory_path() / "bunnyhop-paint-test";
    std::filesystem::create_directories(root);
    const auto path = root / "fixture.bsp";
    const auto bytes = native::test::make_bsp();
    std::ofstream(path, std::ios::binary).write(reinterpret_cast<const char *>(bytes.data()), bytes.size());
    const std::unique_ptr<BhContext, decltype(&bh_destroy)> core(bh_create(), bh_destroy);
    assert(core && bh_load_map(core.get(), path.string().c_str(), nullptr));
    const auto paint_owner = make_paint();
    auto &paint = *paint_owner;
    native_render::SurfaceHit hit{{20, 20, 0}, {0, 0, 1}, {}};
    assert(paint.request(1, false) && paint.stamp(core.get(), hit));
    assert(paint.count() == 1);
    Presentation presentation;
    paint.draw(core.get(), presentation);
    assert(presentation.faces > 0 && presentation.area > 0);
    assert(paint.request(1.11, true));
    assert(!paint.stamp(core.get(), hit, true));
    hit.point[0] += 5;
    assert(paint.request(1.22, true) && paint.stamp(core.get(), hit, true));
    assert(paint.count() == 2);
    paint.clear();
    assert(paint.count() == 0);
    std::filesystem::remove_all(root);
}

struct Renderer {
    unsigned marks = 0;

    const char *surface_tool(std::string_view, const BhState &, const native::Input &) {
        ++marks;
        return "Paint mark placed.";
    }
};

struct Chat {
    std::string last;

    void push(const char *text, const char *, const char *, double) { last = text; }
};

void chat_eligibility() {
    Renderer renderer;
    Chat chat;
    BhState state{};
    native::Input input;
    native::reply_surface_chat(&renderer, "paint", state, input, chat, 1, false);
    assert(renderer.marks == 0 && chat.last.find("unavailable") != std::string::npos);
    native::reply_surface_chat(&renderer, "paintOptions", state, input, chat, 2, false);
    assert(renderer.marks == 0 && chat.last.find("Settings") != std::string::npos);
    native::reply_surface_chat(&renderer, "paint", state, input, chat, 3, true);
    assert(renderer.marks == 1 && chat.last == "Paint mark placed.");
    native::reply_surface_chat<Renderer>(nullptr, "paint", state, input, chat, 4, true);
    assert(chat.last.find("Load a map") != std::string::npos);
}
}  // namespace

int main() {
    cadence();
    projection_and_spacing();
    chat_eligibility();
}
