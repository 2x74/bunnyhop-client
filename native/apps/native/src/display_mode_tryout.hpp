#pragma once
#include "display_mode_trial.hpp"
#include <SDL3/SDL.h>
#include <cstdio>
#include <optional>
#include <string>
#include <vector>

namespace native {

// Shows a new exclusive fullscreen mode straight away from Settings → Display and asks to keep it. The menu is
// hidden while the mode is tried (the menu is drawn by the desktop compositor, which exclusive fullscreen skips),
// and comes back afterwards. Enter keeps the mode; Escape, switching away or ten seconds go back to the old one.
class DisplayModeTryout {
public:
    // Settings went from `before` to `after` while the menu was open. True when the new mode is now on screen
    // for the player to keep or not; false when no trial is needed or the mode couldn't be shown (`error()`).
    template <class Modes, class Menu>
    bool
    start(const WindowJson &before,
          const WindowJson &after,
          Modes &modes,
          Menu *menu,
          SDL_Window *window,
          uint64_t now) {
        error_.clear();
        if (!menu || !DisplayModeTrial::wanted(before, after)) return false;
        trial_.begin(before, now);
        answer_ = Answer::none;
        menu->set_visible(false);
        modes.set_menu(false, false, after);
        if (!shows_exclusive(window)) {
            error_ = "The display mode couldn't be shown";
            answer_ = Answer::revert;
            return false;
        }
        describe(window);
        return true;
    }

    bool active() const { return trial_.active(); }

    const std::string &error() const { return error_; }

    // Enter keeps the mode, Escape goes back; other keys are ignored while asking. Losing focus goes back too
    // (and isn't the trial's event, so the window still handles it).
    bool event(const SDL_Event &event) {
        if (!trial_.active()) return false;
        if (event.type == SDL_EVENT_WINDOW_FOCUS_LOST || event.type == SDL_EVENT_WINDOW_MINIMIZED) {
            answer_ = Answer::revert;
            return false;
        }
        if (event.type == SDL_EVENT_KEY_DOWN && !event.key.repeat) {
            const auto key = event.key.scancode;
            if (key == SDL_SCANCODE_RETURN || key == SDL_SCANCODE_KP_ENTER) answer_ = Answer::keep;
            if (key == SDL_SCANCODE_ESCAPE) answer_ = Answer::revert;
        }
        return event.type == SDL_EVENT_KEY_DOWN || event.type == SDL_EVENT_KEY_UP || event.type == SDL_EVENT_TEXT_INPUT;
    }

    // Once per frame. When the trial ends it returns the settings to keep, `preferences` as tried or with the
    // old display mode put back, and shows the menu again.
    template <class Modes, class Menu>
    std::optional<WindowJson> finish_due(const WindowJson &preferences, Modes &modes, Menu *menu, uint64_t now) {
        if (!trial_.active()) return std::nullopt;
        if (answer_ == Answer::none && trial_.expired(now)) answer_ = Answer::revert;
        if (answer_ == Answer::none) return std::nullopt;
        WindowJson result = preferences;
        if (answer_ == Answer::keep)
            trial_.keep();
        else
            result = trial_.revert(preferences);
        answer_ = Answer::none;
        shown_seconds_ = -1;
        modes.set_menu(true, false, result);
        modes.choose(result);
        if (menu) menu->set_visible(true);
        return result;
    }

    // The question over the game, rebuilt only when the countdown changes.
    template <class Hud>
    void draw(Hud &hud, int width, int height, uint64_t now) {
        if (!trial_.active()) return;
        const int seconds = trial_.seconds_left(now);
        if (seconds != shown_seconds_) {
            shown_seconds_ = seconds;
            char countdown[96];
            std::snprintf(countdown, sizeof countdown, "Going back in %d s.  Enter keeps it, Esc goes back.", seconds);
            lines_ = {mode_label_, countdown};
        }
        hud.draw_panel(width, height, "Keep this display mode?", lines_);
    }

private:
    enum class Answer { none, keep, revert };

    DisplayModeTrial trial_;
    Answer answer_ = Answer::none;
    int shown_seconds_ = -1;
    std::vector<std::string> lines_;
    std::string mode_label_;
    std::string error_;

    static bool shows_exclusive(SDL_Window *window) {
        return window && (SDL_GetWindowFlags(window) & SDL_WINDOW_FULLSCREEN) && SDL_GetWindowFullscreenMode(window);
    }

    void describe(SDL_Window *window) {
        const auto *mode = SDL_GetWindowFullscreenMode(window);
        const char *name = SDL_GetDisplayName(SDL_GetDisplayForWindow(window));
        char label[192];
        std::snprintf(
                label,
                sizeof label,
                "%d × %d at %.0f Hz on %s",
                int(mode->w * mode->pixel_density),
                int(mode->h * mode->pixel_density),
                double(mode->refresh_rate),
                name ? name : "this monitor"
        );
        mode_label_ = label;
    }
};

}  // namespace native
