#pragma once
#include "startup.hpp"
#include <SDL3/SDL_opengl.h>
#include <cstdio>

namespace native {
template <class Gl, class Hud>
class DataMoveDisplay final : public DataMoveProgress {
public:
    DataMoveDisplay(SDL_Window *window, Gl &gl, Hud &hud) : window_(window), gl_(gl), hud_(hud) {}

    void draw(const std::filesystem::path &destination, double total, double done) override {
        int w = 0, h = 0;
        SDL_GetWindowSizeInPixels(window_, &w, &h);
        gl_.Viewport(0, 0, w, h);
        gl_.ClearColor(.03f, .03f, .045f, 1);
        gl_.Clear(GL_COLOR_BUFFER_BIT);
        char line[96];
        std::snprintf(
                line,
                sizeof line,
                "%.0f%%   %.2f / %.2f GB",
                total > 0 ? 100 * done / total : 0.,
                done / 1e9,
                total / 1e9
        );
        hud_.draw_panel(
                w,
                h,
                "Moving game data",
                {"To " + data_location::utf8(destination), line, "The game starts as soon as this finishes."}
        );
    }

private:
    SDL_Window *window_;
    Gl &gl_;
    Hud &hud_;
};
}  // namespace native
