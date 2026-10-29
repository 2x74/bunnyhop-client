#include "renderer.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cstdio>

namespace {
constexpr int image_size = 64;

struct Sdl {
    ~Sdl() { SDL_Quit(); }
};

struct Context {
    SDL_GLContext value;

    ~Context() { SDL_GL_DestroyContext(value); }
};

class Target {
    native::Gl &gl_;
    GLuint texture_ = 0, framebuffer_ = 0;

public:
    explicit Target(native::Gl &gl) : gl_(gl) {
        gl_.GenTextures(1, &texture_);
        gl_.BindTexture(GL_TEXTURE_2D, texture_);
        gl_.TexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, image_size, image_size, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        gl_.TexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        gl_.GenFramebuffers(1, &framebuffer_);
        gl_.BindFramebuffer(GL_FRAMEBUFFER, framebuffer_);
        gl_.FramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture_, 0);
        assert(gl_.CheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE);
        gl_.Viewport(0, 0, image_size, image_size);
        gl_.ClearColor(0, 0, 0, 0);
        gl_.Clear(GL_COLOR_BUFFER_BIT);
    }

    ~Target() {
        gl_.BindFramebuffer(GL_FRAMEBUFFER, 0);
        gl_.DeleteFramebuffers(1, &framebuffer_);
        gl_.DeleteTextures(1, &texture_);
    }

    unsigned red(int x, int y) const {
        std::array<unsigned char, 4> pixel{};
        gl_.ReadPixels(x, y, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, pixel.data());
        return pixel[0];
    }
};

void falloff(native::Gl &gl) {
    Target target(gl);
    native::NativePresentation presentation(gl);
    const std::array<native_render::Vec3, 4> points = {{{-1, -1, 0}, {1, -1, 0}, {1, 1, 0}, {-1, 1, 0}}};
    const std::array<std::array<float, 2>, 4> uv = {{{0, 0}, {1, 0}, {1, 1}, {0, 1}}};
    const float eye[] = {0, 0, 2};
    presentation.decal(points, {1, 0, 0, 1}, uv);
    presentation.draw(native::identity(), eye);
    constexpr int center = image_size / 2;
    const unsigned middle = target.red(center, center);
    const unsigned edge = target.red(image_size - 2, center);
    const unsigned outside = target.red(0, 0);
    assert(middle >= 250 && edge >= 100 && edge <= 140 && outside == 0);
    assert(gl.GetError() == GL_NO_ERROR);
    std::printf("Paint decal framebuffer: center=%u edge=%u outside=%u\n", middle, edge, outside);
}
}  // namespace

int main() {
    SDL_SetHint(SDL_HINT_MAC_BACKGROUND_APP, "1");
    if (!SDL_Init(SDL_INIT_VIDEO)) return 77;
    Sdl sdl;
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
    const std::unique_ptr<SDL_Window, decltype(&SDL_DestroyWindow)> window(
            SDL_CreateWindow("Paint offscreen check", image_size, image_size, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN),
            SDL_DestroyWindow
    );
    if (!window) return 77;
    Context context{SDL_GL_CreateContext(window.get())};
    if (!context.value) return 77;
    try {
        native::Gl gl;
        gl.load();
        falloff(gl);
    } catch (const std::exception &error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
