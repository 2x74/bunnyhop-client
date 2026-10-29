#include "preferences.hpp"
#include "input_binds.hpp"
#include "settings.hpp"
#include <cassert>
#include <iostream>
#include <set>

namespace {
void preference_changes() {
    const auto original = native::default_settings();
    auto settings = original;
    auto cached = native::Preferences::from_settings(settings);
    settings = native::patch_settings(
            settings,
            {{"fov", 110},
             {"hudScale", 175},
             {"sensitivity", 1.25},
             {"practiceKeepVelocity", false},
             {"showGhost", false},
             {"ghostOpacity", .25},
             {"mouseDiagnostics", true},
             {"fpsLimit", 144},
             {"holdRestart", true}}
    );
    assert(cached.fov == 90 && cached.hud_scale == 100 && cached.sensitivity == 2);
    assert(cached.practice_keep_velocity && cached.show_ghost && !cached.mouse_diagnostics);
    cached = native::Preferences::from_settings(settings);
    assert(cached.fov == 110 && cached.hud_scale == 175 && cached.sensitivity == 1.25);
    assert(!cached.practice_keep_velocity && !cached.show_ghost && cached.ghost_opacity == .25f);
    assert(cached.mouse_diagnostics && cached.hold_restart && cached.fps_limit == 144);
    assert(cached.input_backend == native::InputBackendChoice::automatic);
    for (const auto *choice : {"auto", "sdl", "raw"}) {
        const auto changed = native::patch_settings(original, {{"inputBackend", choice}});
        assert(native::Preferences::from_settings(changed).input_backend == native::input_backend_choice(choice));
    }
    bool rejected = false;
    try {
        native::patch_settings(original, {{"inputBackend", "unknown"}});
    } catch (const std::runtime_error &) {
        rejected = true;
    }
    assert(rejected);
    assert(original == native::default_settings());
    assert(native::patch_settings(original, settings) == settings);
}

void bind_changes() {
    native::BindTable table;
    const nlohmann::json binds = {
            {"forward", {"KeyW"}},
            {"attack", {"KeyW", "Mouse1"}},
            {"jump", {"Space", "MouseWheel", "MWheelUp"}},
            {"hideUi", {"KeyH"}},
            {"viewmodel", {"KeyH"}},
            {"inspect", {"Mouse2"}}
    };
    table.rebuild(binds);
    const std::set<std::string> keys = {"KeyW", "Space"};
    assert(table.held(keys) == (native::forward | native::attack | native::jump));
    assert(table.of("MouseWheel") == 0 && table.of("MWheelUp") == 0);
    assert(table.held_action("forward", keys) && !table.held_action("inspect", keys));
    assert(table.is_bound("jump", "MWheelUp") && !table.is_bound("jump", "MWheelDown"));
    assert(table.custom_mouse_binding("Mouse2") && !table.custom_mouse_binding("Mouse1"));
    // A key can toggle two settings. The first toggle can rebuild the table;
    // both actions must still run, in the same order as the original JSON.
    const auto event_binds = table.snapshot();
    std::vector<std::string> actions;
    for (const auto &binding : *event_binds) {
        if (std::find(binding.codes.begin(), binding.codes.end(), "KeyH") == binding.codes.end()) continue;
        actions.push_back(binding.action);
        table.rebuild({{"forward", {"KeyZ"}}});
    }
    assert((actions == std::vector<std::string>{"hideUi", "viewmodel"}));
    assert(table.of("KeyW") == 0 && table.of("KeyZ") == native::forward);
    assert(!table.held_action("forward", keys));
}
}  // namespace

int main() {
    preference_changes();
    bind_changes();
    std::cout << "Typed settings snapshots, bind reloads, shared keys and wheel binds passed\n";
}
