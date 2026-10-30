#include "settings.hpp"
#include "start_point.hpp"
#include "restart_names.hpp"
#include "replay_camera.hpp"
#include "weapon_commands.hpp"
#include "spatial_audio.hpp"
#include "hud_text.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <iostream>
static float trace_fraction = 1;

extern "C" int bh_trace_camera(BhContext *, const float[3], const float[3], float radius, float *out) {
    assert(radius == 6);
    *out = trace_fraction;
    return 1;
}

template <class F>
void rejects(F fn) {
    bool rejected = false;
    try {
        fn();
    } catch (...) {
        rejected = true;
    }
    assert(rejected);
}

int main() {
    const auto defaults = native::default_settings();
    // Old persisted objects merge with new defaults without wiping user binds.
    const auto migrated =
            native::patch_settings(defaults, {{"sensitivity", 3.5}, {"binds", {{"jump", {"MWheelDown"}}}}});
    assert(migrated["invertY"] == false && migrated["sensitivity"] == 3.5 && migrated["viewmodelSway"] == 1);
    assert(migrated["binds"]["jump"][0] == "MWheelDown" && migrated["binds"].contains("setStart"));
    // A full serialized configuration must remain loadable after the schema grows.
    assert(native::patch_settings(defaults, native::Json::parse(migrated.dump())) == migrated);
    // v0.0.29's wider viewmodel: an untouched old framing moves to it, a player's own framing stays.
    native::Json untouched = {{"viewmodelFov", 54}, {"viewmodelX", .6}, {"viewmodelZ", -.9}};
    native::migrate_viewmodel(untouched);
    assert(!untouched.contains("viewmodelFov") && !untouched.contains("viewmodelZ") && untouched["viewmodelRev"] == 3);
    native::Json own = {{"viewmodelFov", 54}, {"viewmodelX", 2}};
    native::migrate_viewmodel(own);
    assert(own["viewmodelFov"] == 54 && own["viewmodelX"] == 2 && own["viewmodelRev"] == 3);
    native::Json chosen = {{"viewmodelFov", 54}, {"viewmodelX", .6}, {"viewmodelZ", -.9}, {"viewmodelRev", 3}};
    native::migrate_viewmodel(chosen);
    assert(chosen["viewmodelFov"] == 54 && chosen["viewmodelZ"] == -.9);
    assert(defaults["viewmodelFov"] == 64 && defaults["viewmodelX"] == .5 && defaults["viewmodelZ"] == 0);
    rejects([&] { native::patch_settings(defaults, {{"crosshairColor", "#fff;"}}); });
    rejects([&] { native::patch_settings(defaults, {{"crosshairColor", "#gg0000"}}); });
    rejects([&] { native::patch_settings(defaults, {{"viewmodelFov", 101}}); });
    rejects([&] { native::patch_settings(defaults, {{"sfxVolume", -1}}); });
    rejects([&] { native::patch_settings(defaults, {{"waterQuality", "ultra"}}); });
    rejects([&] { native::patch_settings(defaults, {{"ghostOpacity", 2}}); });
    rejects([&] {
        native::patch_settings(defaults, {{"hudLayout", {{"timer", {{"x", 50}, {"y", 20}, {"scale", 0}}}}}});
    });
    const auto layout = native::patch_settings(
            defaults, {{"hudLayout", {{"timer", {{"x", 50}, {"y", 20}, {"scale", 1.5}, {"visible", false}}}}}}
    );
    assert(!layout["hudLayout"]["timer"]["visible"].get<bool>());
    native::Input normal, inverted;
    inverted.invert_y = true;
    normal.accumulate(10, 8);
    inverted.accumulate(10, 8);
    normal.arrived(20);
    inverted.arrived(20);
    normal.take_tick(0, 10);
    inverted.take_tick(0, 10);
    assert(normal.pitch == -inverted.pitch && normal.yaw() == inverted.yaw());
    normal.take_tick(10, 20);
    inverted.take_tick(10, 20);
    assert(normal.pitch == -inverted.pitch);
    normal.motion(1, 3);
    inverted.motion(1, 3);
    assert(normal.pitch == -inverted.pitch);
    native::RestartGuard guard;
    assert(guard.press("restart", 0, true, true, true));     // wheel remains immediate
    assert(!guard.press("restart", 0, true, false, false));  // hold also applies before timer
    assert(!guard.frame(499, true, false));
    assert(guard.frame(500, true, false) == "restart");
    assert(!guard.frame(1000, true, false));
    guard.press("restart", 0, true, true, false);
    assert(!guard.frame(300, false, false));
    assert(!guard.frame(600, true, false));
    guard.press("restart", 0, true, true, false);
    assert(!guard.frame(600, true, true));
    BhZone zone{};
    zone.maxs[0] = zone.maxs[1] = 100;
    zone.mins[2] = 1;
    zone.maxs[2] = 50;
    BhState player{};
    player.grounded = 1;
    player.position[0] = player.position[1] = 50;
    std::vector<BhZone> zones = {zone};
    assert(native::start_point_problem(player, false).empty());
    assert(native::start_point_in_zone(player, zones, 0));
    player.position[0] = 15;
    assert(native::start_point_problem(player, false).empty());
    assert(!native::start_point_in_zone(player, zones, 0));
    player.position[0] = 50;                                     // allowed, outside the zone
    assert(!native::start_point_problem(player, true).empty());  // noclip refuses
    player.velocity[0] = 2;
    assert(!native::start_point_problem(player, false).empty());
    player.velocity[0] = 0;
    player.grounded = 0;
    assert(!native::start_point_problem(player, false).empty());
    player.grounded = 1;
    {  // A restart lands the player at the saved point; right after bh_set_position the core reports
        // grounded=0 and no velocity until the first tick (bhop_furame probe), which the old check rejected.
        native::StartPoint saved{};
        saved.position[0] = 297.855652f;
        saved.position[1] = 221.637680f;
        saved.position[2] = 256.03125f;
        BhState fresh{};
        fresh.position[0] = saved.position[0];
        fresh.position[1] = saved.position[1];
        fresh.position[2] = saved.position[2];
        fresh.grounded = 0;
        assert(native::start_point_landed(fresh, saved));
        fresh.position[2] = saved.position[2] - 3.5f;
        assert(native::start_point_landed(fresh, saved));  // settled onto the same floor
        fresh.position[2] = saved.position[2] - 40;
        assert(!native::start_point_landed(fresh, saved));  // fell to another floor
        fresh.position[2] = saved.position[2];
        fresh.position[0] += 1;
        assert(!native::start_point_landed(fresh, saved));  // pushed out of solid
    }
    native::StartPoints points;
    points.save("map", 0, player, 90, -5);
    native::StartPoints restored;
    assert(restored.load(native::Json::parse(points.points.dump())));
    assert(restored.get("map", 0)->yaw == 90);
    assert(!restored.get("map", 1));
    assert(!restored.load({{"bad", {{"position", {1, 2, 3}}, {"yaw", 0}, {"pitch", 100}}}}));
    // The saved point carries tool provenance even when it is inside the start zone.
    player.position[0] = player.position[1] = 50;
    assert(native::start_point_in_zone(player, zones, 0));
    for (const bool used_tool : {false, true}) {
        points.save("map", 0, player, 90, -5, used_tool);
        assert(restored.load(native::Json::parse(points.points.dump())));
        const auto saved = restored.get("map", 0);
        assert(saved && native::start_point_practice(*saved, player, zones, 0) == used_tool);
    }
    auto legacy = points.points;
    legacy["map:0"].erase("practice");
    assert(restored.load(legacy) && !restored.get("map", 0)->practice);
    player.position[0] = 150;
    assert(native::start_point_practice(*restored.get("map", 0), player, zones, 0));
    player.position[0] = 50;
    const auto japan = native::restart_names("bhop_japan", 0);
    const auto shutdown = native::restart_names("bhop_shutdown", 0);
    assert(japan && std::string(japan->classname) == "beginner" && std::string(japan->targetname).empty());
    assert(shutdown && std::string(shutdown->targetname) == "asdf" && std::string(shutdown->classname).empty());
    assert(!native::restart_names("bhop_japan", 1) && !native::restart_names("bhop_shutdown", 1));
    assert(!native::restart_names("unknown", 0));
    native::ReplayCamera camera;
    native::Input view;
    float eye[3]{};
    player.view_offset_z = 64;
    assert(camera.set_mode("chase"));
    trace_fraction = .5;
    camera.sample(reinterpret_cast<BhContext *>(1), player, 0, 0, 0, eye, view);
    assert(std::abs(eye[0] - (50 - std::cos(14 * 3.141592653589793 / 180) * 46)) < .001);
    assert(std::abs(eye[2] - (56 + std::sin(14 * 3.141592653589793 / 180) * 46)) < .001);
    assert(!camera.set_mode("unknown"));
    assert(camera.mode == "chase");
    camera.set_mode("free");
    camera.sample(nullptr, player, 0, 0, 0, eye, view);
    native::Input flight;
    flight.held = native::forward;
    const float free_start = camera.position[0];
    camera.move(flight, .1);
    assert(std::abs(camera.position[0] - free_start - 50) < .001);
    camera.reset();
    assert(!camera.initialized);
    const float listener[] = {0, 0, 0}, right[] = {0, -80, 0}, left[] = {0, 80, 0}, distant[] = {2000, 0, 0};
    assert(native::spatial_mix(right, listener, 0).pan == 1 && native::spatial_mix(left, listener, 0).pan == -1);
    assert(native::spatial_mix(right, listener, 180).pan < -.99 && native::spatial_mix(distant, listener, 0).gain == 0);
    assert(native::spatial_mix(listener, listener, 0).gain == 1 && native::spatial_mix(listener, listener, 0).pan == 0);
    assert((native::pan_gains(1) == std::array<float, 2>{0, 1})
           && (native::pan_gains(0) == std::array<float, 2>{1, 1}));
    assert(native::text_prefix("héllo", 2) == "hé");
    assert(native::text_tail("ab猫狗", 2) == "狗");
    assert(native::text_prefix("e\xcc\x81x", 1) == "e\xcc\x81");
    const auto emoji = native::text_clusters("👩🏽‍💻!");
    assert(emoji.size() == 2 && emoji[0].text == "👩🏽‍💻");
    const auto wrapped = native::wrap_text("猫狗猫", 2);
    assert(wrapped.size() == 3 && wrapped[1] == "狗");
    // Chat lines break between words when they can, inside a word only when it is longer than a line.
    const auto words = native::wrap_text("Watcher: nice route through the second room", 20);
    assert(words.size() == 3 && words[0] == "Watcher: nice route " && words[1] == "through the second "
           && words[2] == "room");
    const auto long_word = native::wrap_text("abcdefghij klm", 4);
    assert(long_word.size() == 4 && long_word[0] == "abcd" && long_word[2] == "ij " && long_word[3] == "klm");
    assert(native::text_clusters("🇺🇸!").size() == 2);
    native::HudTextPieces<8> pieces;
    assert(native::split_numeric_text("1:05.20", pieces) && pieces.count == 7);
    assert(pieces.pieces[1].begin == 1 && pieces.pieces[1].length == 1 && pieces.pieces[6].begin == 6);
    assert(native::split_numeric_text("812 u/s", pieces) && pieces.count == 4);
    assert(pieces.pieces[3].begin == 3 && pieces.pieces[3].length == 4);
    assert(!native::split_numeric_text("PERFECT", pieces));
    assert(!native::split_numeric_text("12 · 3", pieces));
    assert(!native::split_numeric_text("123456789", pieces));
    native::KeptWeapons kept;
    BhWeaponReport report{};
    report.active = report.secondary = 3;
    report.flags = 512;
    kept.observe(report);
    report.flags = 0;
    report.silencer = 1;
    kept.observe(report);
    assert(kept.weapons() == std::vector<uint32_t>{3} && kept.modes()[0]);
    report.active = report.primary = 16;
    report.flags = 512;
    report.silencer = 0;
    kept.observe(report);  // a practice-only primary
    assert(kept.restarted(false, true) == std::vector<uint32_t>{3});
    assert(kept.next() == (3 | 32 | 64));
    assert(kept.next() == 0);
    assert(kept.restarted(true, true) == (std::vector<uint32_t>{3, 16}));
    assert(kept.next() == (3 | 32 | 64));
    for (int i = 0; i < 9; ++i)
        assert(kept.next() == 0);
    assert(kept.next() == (16 | 32));
    kept.restarted(true, false);
    assert(kept.next() == 3);
    kept.cancel();
    for (int i = 0; i < 20; ++i)
        assert(kept.next() == 0);
    // A map strip has no drop flag and must not forget commanded weapons.
    report = {};
    kept.observe(report);
    assert(kept.weapons().size() == 2);
    report.primary = report.active = 16;
    kept.observe(report);
    report.primary = 0;
    report.active = 1;
    report.flags = 32;
    kept.observe(report);
    assert(kept.weapons() == std::vector<uint32_t>{3});
    report.flags = 512;
    kept.observe(report);
    assert(kept.weapons().empty());
    std::cout << "Gameplay preferences, start points, guard and replay cameras passed\n";
}
