// Standalone Linux boundary test; no display/GTK or SDL library is needed:
// c++ -std=c++20 $(pkg-config --cflags sdl3) menu_gl_context_tests.cpp -o TEST
#ifdef NDEBUG
#undef NDEBUG
#endif
#include "menu_gl_context.hpp"
#include <cassert>
#include <cstdlib>
#include <iostream>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>

namespace {
struct Binding { SDL_Window *window; SDL_GLContext context; };
Binding current{};
std::vector<Binding> calls;
bool fail_release = false, fail_restore = false, logged = false;
int window_token, context_token, other_window_token, other_context_token;
const Binding first{reinterpret_cast<SDL_Window *>(&window_token), reinterpret_cast<SDL_GLContext>(&context_token)};
const Binding second{reinterpret_cast<SDL_Window *>(&other_window_token), reinterpret_cast<SDL_GLContext>(&other_context_token)};
void expect(Binding expected) {
    assert(current.window == expected.window && current.context == expected.context);
}
void reset(Binding binding) {
    current = binding; calls.clear(); fail_release = fail_restore = logged = false;
}
void expect_call(size_t at, Binding expected) {
    assert(calls.at(at).window == expected.window && calls.at(at).context == expected.context);
}
}

extern "C" {
SDL_Window *SDLCALL SDL_GL_GetCurrentWindow() { return current.window; }
SDL_GLContext SDLCALL SDL_GL_GetCurrentContext() { return current.context; }
const char *SDLCALL SDL_GetError() { return "injected SDL failure"; }
bool SDLCALL SDL_GL_MakeCurrent(SDL_Window *window, SDL_GLContext context) {
    calls.push_back({window, context});
    if ((!context && fail_release) || (context && fail_restore)) return false;
    current = {window, context}; return true;
}
void SDLCALL SDL_LogCritical(int category, const char *, ...) {
    assert(category == SDL_LOG_CATEGORY_VIDEO); logged = true;
}
}

int main() {
    reset(first);
    {
        native::GlContextRelease outer;
        expect({}); assert(calls.size() == 1); expect_call(0, {});
        { native::GlContextRelease inner; expect({}); }
        expect({}); assert(calls.size() == 1); // Inner scope must not restore early.
    }
    expect(first); assert(calls.size() == 2); expect_call(1, first);

    reset({});
    { native::GlContextRelease no_context; }
    expect({}); assert(calls.empty());

    reset(second);
    { native::GlContextRelease scope; expect({}); }
    expect(second); expect_call(1, second); // Capture this call's pair, not a cached one.

    reset({nullptr, first.context});
    { native::GlContextRelease surfaceless; expect({}); }
    expect({nullptr, first.context});

    reset(first);
    bool propagated = false;
    try {
        native::GlContextRelease scope;
        throw std::runtime_error("GTK work failed");
    } catch (const std::runtime_error &error) {
        propagated = std::string(error.what()) == "GTK work failed";
    }
    assert(propagated); expect(first); assert(calls.size() == 2);

    reset(first); fail_release = true;
    bool entered_gtk = false, reported = false;
    try {
        native::GlContextRelease scope;
        entered_gtk = true;
    } catch (const std::runtime_error &error) {
        reported = std::string(error.what()).find("injected SDL failure") != std::string::npos;
    }
    assert(reported && !entered_gtk); expect(first); assert(calls.size() == 1);

    // Failed restoration is fatal with a diagnostic, including while unwinding.
    // Run each case in a child so the suite can verify the terminate path.
    for (const bool unwind : {false, true}) {
        const pid_t child = fork(); assert(child >= 0);
        if (child == 0) {
            reset(first); fail_restore = true;
            std::set_terminate([] { _exit(logged && calls.size() == 2 ? 73 : 74); });
            try {
                native::GlContextRelease scope;
                if (unwind) throw std::runtime_error("GTK work failed");
            } catch (...) { _exit(75); }
            _exit(76);
        }
        int status = 0;
        assert(waitpid(child, &status, 0) == child);
        assert(WIFEXITED(status) && WEXITSTATUS(status) == 73);
    }
    std::cout << "GTK SDL context release/restore boundaries passed\n";
}
