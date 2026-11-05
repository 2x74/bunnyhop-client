#pragma once
// The cursor a numbered menu keeps out when a chat line opened it (!spec, !race, !bright), as the website's chat does
// (free-cursor.ts holdFreeCursor, net/hud.ts releaseCursorOnClose). The rows can be clicked and the keys keep playing;
// the mouse doesn't turn the view. Once the menu closes (a pick, 0, Esc, a click elsewhere) the game takes the mouse
// back; a pick that opens the next menu (the race's player, then its style) keeps it out. A pause closes the menu.
#include "hud_area.hpp"
#include "hud_geometry.hpp"
#include "raw_keyboard.hpp"
#include <SDL3/SDL.h>
#include <array>
#include <optional>

namespace native {

class MenuCursor {
public:
    enum class Step { keep, recapture, close_menus };

    bool held() const { return held_; }

    std::optional<std::array<float, 2>> pointer() const { return pointer_; }

    // A chat line opened a menu: true when the cursor should come out for it.
    bool hold(bool menu_open, bool playing) {
        if (!menu_open || !playing) return false;
        held_ = true;
        pointer_.reset();
        return true;
    }

    // The cursor in HUD units, for the row under it.
    void point(std::array<float, 2> at) {
        if (held_) pointer_ = at;
    }

    // Once a frame: what to do now that the menus are as they are.
    Step step(bool menu_open, bool paused) {
        if (!held_) return Step::keep;
        if (!paused && menu_open) return Step::keep;
        held_ = false;
        pointer_.reset();
        return paused ? Step::close_menus : Step::recapture;
    }

private:
    bool held_ = false;
    std::optional<std::array<float, 2>> pointer_;
};

// A window position (SDL points) in the HUD's own units, as the numbered menus lay out.
inline std::array<float, 2> hud_point(float x, float y, const HudArea &area, float pixel_density, float percent) {
    const float density = pixel_density > 0 ? pixel_density : 1;
    const HudGeometry geometry(area.width, area.height, percent);
    return {(x * density - float(area.x)) / geometry.scale, (y * density - float(area.top)) / geometry.scale};
}

// Where the HUD lays out in the window now (between Aspect ratio's black bars), as the frame draws it.
template <class Renderer>
HudArea window_hud_area(SDL_Window *window, const Renderer *renderer) {
    int width = 0, height = 0;
    SDL_GetWindowSizeInPixels(window, &width, &height);
    return renderer ? hud_area(renderer->output_view(width, height), width, height) : HudArea{0, 0, width, height};
}

// The mouse out for a held menu, or back to the game, the way chat shows and hides it (raw keys off around the
// switch, so no key-up is lost while SDL restarts its raw input).
inline void show_menu_cursor(SDL_Window *window, bool shown) {
    if (shown) set_raw_keyboard(false);
    SDL_SetWindowRelativeMouseMode(window, !shown);
    if (!shown) set_raw_keyboard(true);
}

}  // namespace native
