#pragma once
#include "graphics_settings.hpp"
#include <SDL3/SDL.h>

namespace native {

// Where the HUD lays out. With Graphics → Aspect ratio and black bars, the HUD, crosshair and chat stay inside the
// picture between the bars, as a 4:3 game shows them on a 16:9 monitor; otherwise they use the whole window.
// `top` counts from the window's top, as the HUD does; GL viewports count from the bottom.
struct HudArea {
    int x = 0;
    int top = 0;
    int width = 1;
    int height = 1;

    int bottom(int window_height) const { return window_height - top - height; }
};

inline HudArea hud_area(const GraphicsView &view, int width, int height) {
    if (view.output_width >= width && view.output_height >= height) return {0, 0, width, height};
    return {view.x, height - view.y - view.output_height, view.output_width, view.output_height};
}

// A mouse event in the HUD's own pixels, for the layout editor, which reads pixels from the HUD's top-left.
inline SDL_Event hud_area_event(SDL_Event event, const HudArea &area, float pixel_density) {
    const float density = pixel_density > 0 ? pixel_density : 1;
    const float dx = float(area.x) / density, dy = float(area.top) / density;
    if (event.type == SDL_EVENT_MOUSE_MOTION) {
        event.motion.x -= dx;
        event.motion.y -= dy;
    } else if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN || event.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        event.button.x -= dx;
        event.button.y -= dy;
    }
    return event;
}

// Draws into the HUD's area for its lifetime and gives the whole window back afterwards.
template <class Gl>
class HudViewport {
public:
    HudViewport(Gl &gl, const HudArea &area, int width, int height) : gl_(gl), width_(width), height_(height) {
        gl_.Viewport(area.x, area.bottom(height), area.width, area.height);
    }

    ~HudViewport() { gl_.Viewport(0, 0, width_, height_); }

    HudViewport(const HudViewport &) = delete;
    HudViewport &operator=(const HudViewport &) = delete;

private:
    Gl &gl_;
    int width_;
    int height_;
};

}  // namespace native
