#pragma once
#include "startup.hpp"
#include "client_graphics.hpp"
#include <cstdio>

namespace native {
template <class Hud>
class DataMoveDisplay final : public DataMoveProgress {
public:
    DataMoveDisplay(SDL_Window *window, ClientGraphics &device, Hud &hud)
        : window_(window)
        , device_(device)
        , hud_(hud) {}

    void draw(const std::filesystem::path &destination, double total, double done) override {
        int w = 0, h = 0;
        SDL_GetWindowSizeInPixels(window_, &w, &h);
        device_.begin();
        device_.context().viewport({0, 0, w, h});
        device_.context().clear_color({.03f, .03f, .045f, 1});
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
        device_.present(true);
    }

private:
    SDL_Window *window_;
    ClientGraphics &device_;
    Hud &hud_;
};
}  // namespace native
