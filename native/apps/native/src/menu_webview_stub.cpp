#include "menu_webview.hpp"

namespace native {
struct MenuWebView::Impl {
    std::string error = "Embedded native web menus are not implemented on this platform";
};
MenuWebView::MenuWebView(SDL_Window *, const std::string &) : impl_(std::make_unique<Impl>()) {}
MenuWebView::~MenuWebView() = default;
bool MenuWebView::available() const { return false; }
bool MenuWebView::supports_backdrop() const { return false; }
const std::string &MenuWebView::error() const { return impl_->error; }
void MenuWebView::set_visible(bool) {}
bool MenuWebView::visible() const { return false; }
std::vector<std::string> MenuWebView::drain_messages() { return {}; }
void MenuWebView::evaluate_js(const std::string &) {}
bool MenuWebView::open_auth(const std::string &) { return false; }
void MenuWebView::close_auth() {}
bool MenuWebView::screenshot(const std::string &) { return false; }
}
