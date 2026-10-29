#pragma once
#include "hud.hpp"
#include "hud_editor_layout.hpp"
#include <SDL3/SDL.h>
#include <optional>
#include <string>
#include <vector>

namespace native {
// The HUD layout editor (the website's hud/editor.ts, drawn by the native HUD): over the game, drag any element,
// resize it from its corner, snap to a grid and the screen's centre lines, nudge with the arrow keys, switch elements
// on and off, apply a preset, reset, and copy or paste the layout as a code. Moves preview live and are saved on
// release. Opened by the hudEditor bind (F2) or Settings → HUD → Edit layout.
class HudLayoutEditor {
public:
    bool active() const { return active_; }

    // Starts editing a copy of `settings`; changes come back through take_patch().
    void open(const Json &settings);
    void close();

    // Takes the mouse and keyboard while editing. Returns true when the event was the editor's.
    bool event(const SDL_Event &event, const NativeHud &hud, float pixel_density, const std::vector<std::string> &bind);

    // A settings patch to save, after a release, a switch, a preset, an import or a key.
    std::optional<Json> take_patch();

    // True once after the editor closed (the game takes the mouse back).
    bool take_closed();

    // The layout being edited, for the HUD to draw this frame (a drag shows before it is saved).
    const Json &working_settings() const { return settings_; }

    bool take_preview();

    void draw(NativeHud &hud, int width, int height, float display_scale, std::string_view done_key);

private:
    struct Button {
        HudRect box;
        std::string action;
    };

    struct Drag {
        std::string_view id;
        bool resize = false;
        float start_x = 0;
        float start_y = 0;
        HudRect start_box;
        double start_scale = 1;
    };

    bool active_ = false;
    bool closed_ = false;
    bool preview_ = false;
    bool snap_ = true;
    bool bar_at_bottom_ = false;
    Json settings_;
    std::optional<Json> patch_;
    std::string_view selected_ = "timer";
    std::optional<Drag> drag_;
    bool vertical_guide_ = false;
    bool horizontal_guide_ = false;
    std::vector<Button> buttons_;
    HudRect bar_box_;
    std::string message_;
    uint64_t message_until_ns_ = 0;
    int width_ = 0;
    int height_ = 0;
    float grid_px_ = 8;
    float mouse_x_ = -1;
    float mouse_y_ = -1;

    bool mouse_event(const SDL_Event &event, const NativeHud &hud, float pixel_density);
    bool key_event(const SDL_KeyboardEvent &key, const NativeHud &hud, const std::vector<std::string> &bind);
    void press(float x, float y, const NativeHud &hud);
    void move(float x, float y, bool free, const NativeHud &hud);
    void release();
    bool click_button(float x, float y, const NativeHud &hud);
    void run_action(const std::string &action, const NativeHud &hud);
    std::optional<std::string_view> element_at(float x, float y, const NativeHud &hud) const;

    Json current_place(std::string_view id, const NativeHud &hud) const;
    void set_place(std::string_view id, const Json &place, bool save);
    void place_box(std::string_view id, const HudRect &box, double scale, const NativeHud &hud, bool save);
    void nudge(float dx, float dy, const NativeHud &hud);
    void rescale(double step, const NativeHud &hud);
    void toggle(std::string_view id, const NativeHud &hud);
    void apply(const Json &patch);
    void say(std::string text);
    void select_next(int step);

    void draw_outlines(NativeHud &hud, float scale);
    void draw_bar(NativeHud &hud, float units_width, float units_height, float scale, std::string_view done_key);
    float draw_bar_head(NativeHud &hud, float left, float top, float width, float scale, std::string_view done_key);
    unsigned chip_rows(NativeHud &hud, float width) const;
    float draw_chips(NativeHud &hud, float left, float top, float width, float scale);
    float draw_tools(NativeHud &hud, float left, float top, float scale);
    float draw_button(
            NativeHud &hud, float x, float y, std::string_view label, std::string action, float scale, bool on = false
    );
    std::string info_line(const NativeHud &hud) const;
};
}  // namespace native
