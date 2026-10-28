// Linux/Xvfb integration test. Link this file and menu_webview_gtk.cpp with
// pkg-config --cflags --libs sdl3 webkit2gtk-4.1 gtk+-3.0, plus -lGL.
#ifdef NDEBUG
#undef NDEBUG
#endif
#include "menu_webview.hpp"
#include <SDL3/SDL.h>
#include <SDL3/SDL_opengl.h>
#include <glib.h>
#include <cassert>
#include <chrono>
#include <iostream>
#include <stdexcept>

namespace {
void check_context(SDL_Window *window, SDL_GLContext context) {
    assert(SDL_GL_GetCurrentWindow() == window && SDL_GL_GetCurrentContext() == context);
    // Check the driver context too: SDL's TLS alone cannot establish that GTK
    // left the actual native GL binding in the expected state.
    assert(glGetString(GL_VERSION));
    glClear(GL_COLOR_BUFFER_BIT);
    assert(glGetError() == GL_NO_ERROR);
}
}  // namespace

int main(int argc, char **argv) {
    assert(argc == 2);  // Snapshot output path supplied by the test runner.
    assert(SDL_Init(SDL_INIT_VIDEO));

    struct Sdl {
        ~Sdl() { SDL_Quit(); }
    } sdl;

    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
    auto *window = SDL_CreateWindow("GTK boundary test", 320, 240, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
    assert(window);

    struct Window {
        SDL_Window *value;

        ~Window() { SDL_DestroyWindow(value); }
    } window_cleanup{window};

    auto context = SDL_GL_CreateContext(window);
    assert(context);

    struct Context {
        SDL_GLContext &value;

        ~Context() {
            if (value) SDL_GL_DestroyContext(value);
        }
    } context_cleanup{context};

    auto menu = std::make_unique<native::MenuWebView>(window, R"html(
        <!doctype html><html><head></head><body>GTK boundary test<script>
        window.webkit.messageHandlers.bunnyhop.postMessage('{"type":"ready"}');
        </script></body></html>)html");
    if (!menu->available()) throw std::runtime_error(menu->error());
    check_context(window, context);
    menu->set_visible(true);
    check_context(window, context);
    menu->set_visible(false);
    check_context(window, context);
    menu->set_visible(true);
    check_context(window, context);
    assert(!menu->open_auth("https://example.invalid/api/auth/"));
    menu->close_auth();
    check_context(window, context);

    struct Idle {
        native::MenuWebView *menu;
        bool ran = false;
    } idle{menu.get()};

    g_idle_add(
            [](gpointer data) -> gboolean {
                auto &idle = *static_cast<Idle *>(data);
                assert(!SDL_GL_GetCurrentWindow() && !SDL_GL_GetCurrentContext());
                // Reentrant menu methods must not bind SDL while GTK is dispatching.
                idle.menu->set_visible(false);
                idle.menu->set_visible(true);
                idle.menu->close_auth();
                assert(!SDL_GL_GetCurrentWindow() && !SDL_GL_GetCurrentContext());
                idle.ran = true;
                return G_SOURCE_REMOVE;
            },
            &idle
    );
    bool ready = false, evaluated = false, snapshot = false;
    auto drain_until = [&](const auto &done) {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
        while (!done() && std::chrono::steady_clock::now() < deadline) {
            for (const auto &message : menu->drain_messages()) {
                if (message.find("\"menuError\"") != std::string::npos) throw std::runtime_error(message);
                ready |= message.find("\"ready\"") != std::string::npos;
                evaluated |= message.find("\"evaluated\"") != std::string::npos;
                snapshot |= message.find("\"menuSnapshot\"") != std::string::npos
                            && message.find("\"ok\":true") != std::string::npos;
            }
            check_context(window, context);
            SDL_Delay(5);
        }
        assert(done());
    };
    drain_until([&] { return ready && idle.ran; });
    menu->evaluate_js("window.webkit.messageHandlers.bunnyhop.postMessage('{\"type\":\"evaluated\"}')");
    check_context(window, context);
    drain_until([&] { return evaluated; });
    assert(menu->screenshot(argv[1]));
    check_context(window, context);
    drain_until([&] { return snapshot; });

    // Replace/destroy the original renderer context while the menu is alive.
    // Later calls must capture the replacement rather than restore a stale one.
    auto replacement = SDL_GL_CreateContext(window);
    assert(replacement);
    assert(SDL_GL_DestroyContext(context));
    context = replacement;
    menu->set_visible(false);
    check_context(window, context);
    menu->set_visible(true);
    check_context(window, context);
    assert(SDL_GL_MakeCurrent(nullptr, nullptr));
    menu->evaluate_js("null");
    assert(!SDL_GL_GetCurrentWindow() && !SDL_GL_GetCurrentContext());
    assert(SDL_GL_DestroyContext(context));
    context = nullptr;
    menu.reset();  // No attempt to restore either destroyed context.
    assert(!SDL_GL_GetCurrentWindow() && !SDL_GL_GetCurrentContext());
    std::cout << "GTK/SDL lifecycle, reentrancy, JS, snapshot and context replacement passed\n";
}
