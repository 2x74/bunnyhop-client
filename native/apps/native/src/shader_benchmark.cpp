#include "renderer.hpp"
#include "benchmark_system.hpp"
#ifdef __APPLE__
#include <OpenGL/OpenGL.h>
#include <dlfcn.h>
#endif

namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;

double milliseconds(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

struct Context {
#ifdef __APPLE__
    CGLContextObj context = nullptr;
    void *library = nullptr;
    Context() {
        const CGLPixelFormatAttribute attributes[] = {kCGLPFAOpenGLProfile,
            CGLPixelFormatAttribute(kCGLOGLPVersion_3_2_Core), kCGLPFAAllowOfflineRenderers, CGLPixelFormatAttribute(0)};
        CGLPixelFormatObj format = nullptr;
        GLint count = 0;
        if (CGLChoosePixelFormat(attributes, &format, &count) != kCGLNoError || !format)
            throw std::runtime_error("No headless CGL pixel format");
        const auto status = CGLCreateContext(format, nullptr, &context);
        CGLDestroyPixelFormat(format);
        if (status != kCGLNoError || CGLSetCurrentContext(context) != kCGLNoError)
            throw std::runtime_error("Cannot create headless CGL context");
        library = dlopen("/System/Library/Frameworks/OpenGL.framework/OpenGL", RTLD_LAZY);
        if (!library) throw std::runtime_error("OpenGL framework unavailable");
    }
    ~Context() {
        CGLSetCurrentContext(nullptr);
        if (context) CGLDestroyContext(context);
        if (library) dlclose(library);
    }
    void load(native::Gl &gl) { gl.load([this](const char *name) { return dlsym(library, name); }); }
#else
    SDL_Window *window = nullptr;
    SDL_GLContext context = nullptr;
    Context() {
        if (!SDL_Init(SDL_INIT_VIDEO)) throw std::runtime_error(SDL_GetError());
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
        window = SDL_CreateWindow("Shader compilation measurement", 64, 64, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
        if (!window) throw std::runtime_error(SDL_GetError());
        context = SDL_GL_CreateContext(window);
        if (!context || !SDL_GL_MakeCurrent(window, context)) throw std::runtime_error(SDL_GetError());
    }
    ~Context() {
        if (context) SDL_GL_DestroyContext(context);
        if (window) SDL_DestroyWindow(window);
        SDL_Quit();
    }
    void load(native::Gl &gl) { gl.load(); }
#endif
};

Json permutation(native::Gl &gl, const native_render::PlayerShaderSources &sources,
                 int finish, bool glove, bool detail, native_render::PlayerMaterial material) {
    const auto start = Clock::now();
    const auto defines = native_render::player_defines(finish, glove, detail, material);
    const bool gun = material == native_render::PlayerMaterial::gun || material == native_render::PlayerMaterial::world_gun;
    const auto vertex = defines + (gun ? sources.gunVertex : sources.vertex);
    const auto fragment = defines + (material == native_render::PlayerMaterial::ghost ? sources.ghost
                                      : gun ? sources.gun : sources.solid);
    const auto vertex_start = Clock::now();
    const GLuint vertex_shader = native::shader(gl, GL_VERTEX_SHADER, vertex.c_str());
    const double vertex_ms = milliseconds(vertex_start);
    const auto fragment_start = Clock::now();
    const GLuint fragment_shader = native::shader(gl, GL_FRAGMENT_SHADER, fragment.c_str());
    const double fragment_ms = milliseconds(fragment_start);
    const auto link_start = Clock::now();
    const GLuint program = gl.CreateProgram();
    gl.AttachShader(program, vertex_shader);
    gl.AttachShader(program, fragment_shader);
    gl.LinkProgram(program);
    GLint ok = 0;
    gl.GetProgramiv(program, GL_LINK_STATUS, &ok);
    const double link_ms = milliseconds(link_start);
    if (!ok) {
        char log[8192]{};
        gl.GetProgramInfoLog(program, sizeof log, nullptr, log);
        throw std::runtime_error(log);
    }
    const double total_ms = milliseconds(start);
    gl.DeleteShader(vertex_shader);
    gl.DeleteShader(fragment_shader);
    // Keep programs alive, as the lazy cache does. The context owns their lifetime.
    return {{"key", native_render::player_program_key(finish, glove, detail, material)}, {"finish", finish},
            {"glove", glove}, {"detail", detail}, {"material", int(material)}, {"defines", defines},
            {"vertexMs", vertex_ms}, {"fragmentMs", fragment_ms}, {"linkMs", link_ms}, {"totalMs", total_ms}};
}
}

int main(int argc, char **argv) {
    try {
        if (argc != 3) throw std::runtime_error("usage: bunnyhop-native-shader-benchmark ASSET_DIRECTORY OUTPUT.json");
        Context context;
        native::Gl gl;
        context.load(gl);
        native_render::PlayerShaderSources sources(argv[1]);
        Json result = {{"schema", 1}, {"gpu", reinterpret_cast<const char *>(gl.GetString(GL_RENDERER))},
                       {"driver", reinterpret_cast<const char *>(gl.GetString(GL_VERSION))},
                       {"os", benchmark_os()}, {"permutations", Json::array()},
                       {"method", "First runtime compile/link per lazy cache key, same player_defines and sources as NativeViewmodel. "
                        "Includes duplicate source keys. Driver caches are left intact; excludes uniform lookup and first draw specialization."}};
        for (int material = 0; material < 4; ++material) {
            const int finishes = material == 0 ? 28 : 1;
            for (int finish = 0; finish < finishes; ++finish)
                for (bool glove : {false, true})
                    for (bool detail : {false, true})
                        result["permutations"].push_back(permutation(gl, sources, finish, glove, detail,
                                                                    native_render::PlayerMaterial(material)));
        }
        if (gl.GetError() != GL_NO_ERROR) throw std::runtime_error("Shader benchmark GL error");
        std::ofstream output(argv[2]);
        output << result.dump(2) << '\n';
        if (!output) throw std::runtime_error("Cannot write shader result");
        std::cout << result["permutations"].size() << " player shader permutations measured\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "Shader benchmark: " << error.what() << '\n';
        return 1;
    }
}
