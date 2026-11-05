// Brightness and Fullbright per map (map_look.hpp, web map-look.ts), !bright's quick menu (look_menu.hpp) and the
// cursor a chat-opened menu keeps out (menu_cursor.hpp).
#include "graphics_settings.hpp"
#include "look_menu.hpp"
#include "menu_cursor.hpp"
#include "settings.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cmath>
#include <cstdio>

namespace {

using native::Json;

bool near(double a, double b) {
    return std::abs(a - b) < 1e-9;
}

// A map draws with its own values, falling back field by field to Settings → Graphics; other maps and the home
// screen keep the global ones.
void test_map_look_wins_on_its_map() {
    auto settings = native::default_settings();
    settings["graphicsBrightness"] = 1.2;
    settings["graphicsFullbright"] = false;
    settings = native::patch_settings(
            settings,
            {{"mapLooks", {{"bhop_aux_a9", {{"brightness", 1.3}}}, {"bhop_dumb_blocks_3", {{"fullbright", true}}}}}}
    );
    const auto aux = native::GraphicsSettings::read(settings, "bhop_aux_a9");
    assert(near(aux.brightness, 1.3f) && !aux.fullbright);
    const auto blocks = native::GraphicsSettings::read(settings, "bhop_dumb_blocks_3");
    assert(near(blocks.brightness, 1.2f) && blocks.fullbright);
    const auto other = native::GraphicsSettings::read(settings, "bhop_eazy");
    assert(near(other.brightness, 1.2f) && !other.fullbright);
    const auto home = native::GraphicsSettings::read(settings);
    assert(near(home.brightness, 1.2f) && !home.fullbright);
}

// Saved or sent looks are cleaned like the website's: bad names and values are dropped, brightness is clamped, and
// nothing in them can fail the settings.
void test_map_looks_are_cleaned() {
    const auto cleaned = native::clean_map_looks(
            {{"bhop_bright", {{"brightness", 9}, {"fullbright", "yes"}}},
             {"bhop_dim", {{"brightness", 0.123}}},
             {"bad name!", {{"brightness", 1.1}}},
             {"__proto__", {{"fullbright", true}}},
             {"bhop_empty", {{"brightness", "1.3"}}},
             {"bhop_null", nullptr}}
    );
    assert(cleaned == Json({{"bhop_bright", {{"brightness", 2.0}}}, {"bhop_dim", {{"brightness", 0.5}}}}));
    assert(native::clean_map_looks("junk") == Json::object());
    auto many = Json::object();
    for (int i = 0; i < 400; ++i)
        many["bhop_" + std::to_string(i)] = {{"fullbright", true}};
    assert(native::clean_map_looks(many).size() == native::map_looks_host_cap);
    const auto settings = native::patch_settings(native::default_settings(), {{"mapLooks", {1, 2, 3}}});
    assert(settings.at("mapLooks") == Json::object());
    assert(native::clamp_map_brightness(1.234) == 1.23);
}

// The menu's patches: one step darker or brighter, Fullbright switched, the map's own values dropped, or made the
// global setting.
void test_look_menu_patches() {
    auto settings = native::default_settings();
    settings["graphicsBrightness"] = 1.1;
    native::LookMenu menu;
    menu.toggle("bhop_aux_a9", settings);
    assert(menu.open());
    // Nothing of its own yet: Reset and Use on all maps do nothing.
    assert(!menu.pick(native::LookMenu::reset, settings) && !menu.pick(native::LookMenu::everywhere, settings));
    settings = native::patch_settings(settings, *menu.pick(native::LookMenu::brighter, settings));
    menu.refresh(settings);
    assert(near(settings["mapLooks"]["bhop_aux_a9"]["brightness"].get<double>(), 1.15));
    settings = native::patch_settings(settings, *menu.pick(native::LookMenu::fullbright, settings));
    menu.refresh(settings);
    assert(settings["mapLooks"]["bhop_aux_a9"] == Json({{"brightness", 1.15}, {"fullbright", true}}));
    const auto everywhere = *menu.pick(native::LookMenu::everywhere, settings);
    assert(near(everywhere["graphicsBrightness"].get<double>(), 1.15) && everywhere["graphicsFullbright"] == true);
    assert(everywhere["mapLooks"] == Json::object());
    const auto reset = *menu.pick(native::LookMenu::reset, settings);
    assert(reset == Json({{"mapLooks", Json::object()}}));
    assert(menu.key("Digit0", true, false, settings).handled && !menu.open());
    assert(!menu.key("Digit1", true, false, settings).handled);
    menu.toggle("bhop_aux_a9", settings);
    menu.toggle("bhop_aux_a9", settings);
    assert(!menu.open());
}

// Darker stops at the slider's end, and a click on the bar sets the value under it, in the slider's steps.
void test_look_menu_bar_and_limits() {
    auto settings = native::default_settings();
    settings["graphicsBrightness"] = .5;
    native::LookMenu menu;
    menu.toggle("bhop_dark", settings);
    const auto darker = *menu.pick(native::LookMenu::darker, settings);
    assert(near(darker["mapLooks"]["bhop_dark"]["brightness"].get<double>(), .5));
    const auto rows = menu.rows(1280, 720, 100);
    const float bar_y = rows.top + 59;
    assert(!menu.bar_value(1280, 720, 100, rows.left + 18, rows.top + 120));
    assert(near(*menu.bar_value(1280, 720, 100, rows.left + 18, bar_y), .5));
    assert(near(*menu.bar_value(1280, 720, 100, rows.left + 18 + 330, bar_y), 2));
    assert(near(*menu.bar_value(1280, 720, 100, rows.left + 18 + 110, bar_y), 1));
}

// The cursor stays out while the menu it was held for is open, comes back to the game once it closes, and a pause
// closes the menu instead.
void test_menu_cursor_steps() {
    using Step = native::MenuCursor::Step;
    native::MenuCursor cursor;
    assert(!cursor.hold(false, true) && !cursor.hold(true, false) && !cursor.held());
    assert(cursor.step(true, false) == Step::keep);
    assert(cursor.hold(true, true) && cursor.held());
    cursor.point({10, 20});
    const std::array<float, 2> pointed = {10, 20};
    assert(cursor.pointer() == pointed);
    assert(cursor.step(true, false) == Step::keep && cursor.held());
    assert(cursor.step(false, false) == Step::recapture && !cursor.held() && !cursor.pointer());
    assert(cursor.step(false, false) == Step::keep);
    assert(cursor.hold(true, true));
    assert(cursor.step(true, true) == Step::close_menus && !cursor.held());
}

// Window points to HUD units: the pixel density, the black bars' offset and the HUD scale.
void test_hud_point() {
    const native::HudArea area{100, 50, 1920, 1080};
    const auto at = native::hud_point(160, 100, area, 2, 100);
    const native::HudGeometry geometry(1920, 1080, 100);
    assert(near(at[0], (320 - 100) / geometry.scale) && near(at[1], (200 - 50) / geometry.scale));
}

}  // namespace

int main() {
    test_map_look_wins_on_its_map();
    test_map_looks_are_cleaned();
    test_look_menu_patches();
    test_look_menu_bar_and_limits();
    test_menu_cursor_steps();
    test_hud_point();
    std::puts("look menu passed");
}
