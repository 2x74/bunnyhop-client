#pragma once
#include <memory>
#include <string>
#include <vector>

struct SDL_Window;

namespace native {
// Menus/account UI only. The SDL view, OpenGL renderer, event loop and native
// relative mouse input remain owned by the client. All methods run on its main
// thread; destroy this object before destroying the SDL_Window.
class MenuWebView {
public:
    MenuWebView(SDL_Window *window, const std::string &bundled_html);
    ~MenuWebView();
    MenuWebView(const MenuWebView &) = delete;
    MenuWebView &operator=(const MenuWebView &) = delete;

    bool available() const;
    // Alpha composition over the SDL window; false for the separate GTK window.
    bool supports_backdrop() const;
    const std::string &error() const;
    void set_visible(bool visible);
    bool visible() const;
    // The menu (or its sign-in view) holds keyboard focus. On Windows the
    // WebView2 child takes focus without SDL seeing a focus loss.
    bool has_keyboard_focus() const;

    // Only the original trusted bundled top-level document may post JSON
    // objects with a string `type` to webkit.messageHandlers.bunnyhop.
    std::vector<std::string> drain_messages();
    void evaluate_js(const std::string &script);

    // Initial URL must be https://bunnyhop.lol/api/auth/*. Authentication uses
    // another WKWebView sharing cookies, with no host message handler. Its
    // HTTPS provider redirects are isolated from the trusted menu document.
    bool open_auth(const std::string &url);
    void close_auth();

    // Asynchronous PNG capture. Completion appears as a `menuSnapshot` message
    // with {ok,path,error?}. The filename is supplied by native code only.
    bool screenshot(const std::string &path);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}  // namespace native
