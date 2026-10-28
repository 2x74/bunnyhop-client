#include "hud_theme.hpp"
#include <cassert>

int main() {
    using native::parse_hud_theme;

    // Nothing set: the default HUD.
    const auto empty = parse_hud_theme(nlohmann::json::object());
    assert(!empty.text && !empty.gain && empty.elements.empty());
    assert(parse_hud_theme(nullptr).elements.empty());

    const auto theme = parse_hud_theme({
        {"colors", {{"text", {1, 1, 1, 1}}, {"accent", {0.5, 0.8, 1, 1}}, {"gain", {0, 0.5, 1, 1}},
                    {"loss", "red"}, {"sync", {1, 2, 0, 1}}}},
        {"elements", {{"speed", {{"color", {1, 0.4, 0.8, 1}}, {"opacity", 0.5}}},
                      {"keys", {{"opacity", 3}}},
                      {"chat", {{"opacity", 0.1}}},
                      {"timer", "bold"}}},
    });
    assert(theme.text && (*theme.text)[0] == 1);
    assert(theme.accent && (*theme.accent)[1] == 0.8f);
    // Malformed colours are ignored, not guessed.
    assert(!theme.loss && !theme.sync);

    const auto* speed = theme.element("speed");
    assert(speed && speed->color && speed->opacity == 0.5f);
    const auto* keys = theme.element("keys");
    assert(keys && !keys->color && keys->opacity == 1);
    // Elements the native HUD doesn't draw from this table are dropped.
    assert(!theme.element("chat") && !theme.element("timer"));

    // Gain applies over the palette; colours that weren't set stay.
    auto palette = native::semantic_palette("off");
    const auto loss = palette.loss;
    theme.apply(palette);
    assert(palette.gain[2] == 1 && palette.loss == loss);
}
