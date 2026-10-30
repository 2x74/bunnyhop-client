// Windowless macOS renderer loading: CGL never creates an SDL window or captures input.
#include "renderer.hpp"
#include <OpenGL/OpenGL.h>
#include <dlfcn.h>
#include <sys/resource.h>
#include <thread>
#include <future>

namespace {
using Clock = std::chrono::steady_clock;

double milliseconds(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

struct OffscreenContext {
    CGLContextObj context = nullptr;
    void *library = nullptr;

    OffscreenContext() {
        CGLPixelFormatAttribute attributes[] = {
                kCGLPFAOpenGLProfile,
                CGLPixelFormatAttribute(kCGLOGLPVersion_3_2_Core),
                kCGLPFAAccelerated,
                CGLPixelFormatAttribute(0)
        };
        CGLPixelFormatObj format = nullptr;
        GLint count = 0;
        if (CGLChoosePixelFormat(attributes, &format, &count) != kCGLNoError || !format)
            throw std::runtime_error("No headless CGL pixel format");
        const auto status = CGLCreateContext(format, nullptr, &context);
        CGLDestroyPixelFormat(format);
        if (status != kCGLNoError || CGLSetCurrentContext(context) != kCGLNoError)
            throw std::runtime_error("Could not create headless CGL context");
        library = dlopen("/System/Library/Frameworks/OpenGL.framework/OpenGL", RTLD_LAZY);
        if (!library) throw std::runtime_error("Could not load OpenGL framework");
    }

    ~OffscreenContext() {
        CGLSetCurrentContext(nullptr);
        if (context) CGLDestroyContext(context);
        if (library) dlclose(library);
    }
};
}  // namespace

int main(int argc, char **argv) {
    try {
        if (argc < 2 || argc > 3) throw std::runtime_error("usage: bunnyhop-native-load-benchmark MAP.bsp [CONTENT]");
        OffscreenContext offscreen;
        native::Gl gl;
        gl.load([&](const char *name) { return dlsym(offscreen.library, name); });
        std::unique_ptr<BhContext, decltype(&bh_destroy)> core(bh_create(), &bh_destroy);
        const auto start = Clock::now();
        auto viewmodel = std::async(std::launch::async, [&gl]() {
            return std::make_unique<native::NativeViewmodel>(gl, BUNNYHOP_NATIVE_ASSET_ROOT, true);
        });
        if (!bh_load_map_begin(core.get(), argv[1], argc == 3 ? argv[2] : nullptr))
            throw std::runtime_error(bh_last_error(core.get()));
        double maximum_poll_ms = 0;
        unsigned polls = 0;
        for (;;) {
            const auto poll_start = Clock::now();
            const int status = bh_load_map_poll(core.get());
            maximum_poll_ms = std::max(maximum_poll_ms, milliseconds(poll_start));
            ++polls;
            if (status < 0) throw std::runtime_error(bh_last_error(core.get()));
            if (status) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        const double prepare_ms = milliseconds(start);
        const auto renderer_start = Clock::now();
        native::Renderer renderer(gl, core.get(), BUNNYHOP_NATIVE_ASSET_ROOT, true, viewmodel.get());
        double maximum_resource_poll_ms = 0;
        for (;;) {
            const auto poll_start = Clock::now();
            const bool ready = renderer.poll_loading();
            maximum_resource_poll_ms = std::max(maximum_resource_poll_ms, milliseconds(poll_start));
            if (ready) break;
        }
        const auto finish = reinterpret_cast<void (*)()>(dlsym(offscreen.library, "glFinish"));
        if (!finish) throw std::runtime_error("Missing glFinish");
        finish();
        const auto gl_error = reinterpret_cast<GLenum (*)()>(dlsym(offscreen.library, "glGetError"));
        if (!gl_error || gl_error() != GL_NO_ERROR) throw std::runtime_error("OpenGL load error");
        rusage usage{};
        getrusage(RUSAGE_SELF, &usage);
        const nlohmann::json report = {
                {"slowestResource", renderer.loading.slowest_step},
                {"map", argv[1]},
                {"prepareMs", prepare_ms},
                {"rendererMs", milliseconds(renderer_start)},
                {"totalMs", milliseconds(start)},
                {"peakRssBytes", usage.ru_maxrss},
                {"maximumResourcePollMs", maximum_resource_poll_ms},
                {"maximumPollMs", maximum_poll_ms},
                {"polls", polls},
                {"renderer", reinterpret_cast<const char *>(gl.GetString(GL_RENDERER))}
        };
        std::cout << report.dump() << '\n';
    } catch (const std::exception &failure) {
        std::cerr << failure.what() << '\n';
        return 1;
    }
}
