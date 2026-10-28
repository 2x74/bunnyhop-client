#pragma once
#include "menu_webview.hpp"
#include <string>

namespace native {

// A menu screen opened by the game (F10 Settings, the HUD editor bind). A
// request made before the menu document is ready waits for it instead of
// being dropped. Only the latest request is kept.
class PendingMenuScript {
public:
    void open(MenuWebView *menu, bool ready, const std::string &script) {
        if (!menu) return;
        if (ready)
            menu->evaluate_js(script);
        else
            script_ = script;
    }

    // The menu document said it is ready.
    void ready(MenuWebView *menu) {
        if (!menu || script_.empty()) return;
        menu->evaluate_js(script_);
        script_.clear();
    }

private:
    std::string script_;
};

// What the HUD says when a menu screen is asked for and there is no menu.
inline std::string menu_unavailable_text(const std::string &failure) {
    if (failure.empty()) return "Menus are off in this launch (--no-menu).";
    return "Menus couldn't start: " + failure;
}

}  // namespace native
