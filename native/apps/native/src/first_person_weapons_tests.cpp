// The first-person weapons pass as a player sees it, on synthetic one-bone clips whose translation says which clip
// and time is showing: a switch lowers the old weapon out while the new one draws, resets and hidden frames never
// lower anything, the quiet inspect is yours only, an attack blends an inspect out, the gun's grip eases when quiet,
// a shot kicks the viewmodel FOV and a hard landing dips the hands; gun clips crossfade, rapid shots build recoil up,
// an interrupted silencer change shows what the core put back, and a reset leaves nothing of what came before.
#include "first_person_weapons.hpp"
#include <cassert>
#include <cstdio>
#include <memory>

namespace {
using native_vm::Action;
using native_vm::FirstPersonInput;

constexpr double frame_seconds = .01;
// The synthetic clips: the bone's x says which clip, y the time into it, z a grip-idle basis offset.
constexpr float knife_idle = 1, knife_draw = 2, knife_slash = 3, knife_stab = 4, own_trick = 10, second_trick = 11;
constexpr float quiet_check = 20, gun_idle = 31, gun_draw = 32, gun_fire = 33, gun_reload = 34, gun_holster = 35;
constexpr float gun_inspect = 36, gun_dry = 37, silencer_on = 40, silenced_holster = 41, silenced_idle = 42;
constexpr float silenced_draw = 43;
constexpr uint32_t usp_id = 3, m4a1_id = 18;

struct Library {
    std::vector<float> data;
    native_vm::PoseEntry knife, gun;

    void clip(native_vm::PoseEntry &entry, const char *name, double duration, float id, float z = 0) {
        constexpr double samples_per_second = 30;
        const size_t frames = duration > 0 ? size_t(duration * samples_per_second) + 1 : 1;
        entry.clips.push_back({name, duration, frames, data.size()});
        for (size_t f = 0; f < frames; f++) {
            const float t = frames > 1 ? float(duration * double(f) / double(frames - 1)) : 0;
            const float frame[12] = {1, 0, 0, id, 0, 1, 0, t, 0, 0, 1, z};
            data.insert(data.end(), frame, frame + 12);
        }
    }

    Library() {
        knife.bones = gun.bones = 1;
        clip(knife, "idle", 0, knife_idle);
        clip(knife, "draw", .5, knife_draw);
        clip(knife, "slash1", .4, knife_slash);
        clip(knife, "slash2", .4, knife_slash);
        clip(knife, "stab", .6, knife_stab);
        clip(knife, "inspect0", 2, own_trick);
        clip(knife, "inspect1", 2, second_trick);
        clip(knife, "inspectQuiet", 2.45, quiet_check);
        clip(gun, "idle", 0, gun_idle);
        clip(gun, "draw", .5, gun_draw);
        clip(gun, "fire", .8, gun_fire);
        clip(gun, "reload", 2, gun_reload);
        clip(gun, "holster", .2, gun_holster);
        clip(gun, "gripIndex", 0, gun_idle, 1);
        clip(gun, "gripOpen", 0, gun_idle, 2);
        clip(gun, "inspect", 2.4, gun_inspect);
        clip(gun, "dryFire", .5, gun_dry);
        clip(gun, "silencerOn", 2, silencer_on);
        clip(gun, "holster:silenced", .15, silenced_holster);
        clip(gun, "idle:silenced", 0, silenced_idle);
        clip(gun, "draw:silenced", .5, silenced_draw);
    }
};

native_vm::FirstPersonConfig config() {
    native_vm::FirstPersonConfig out;
    native_vm::TrickSpec trick;
    trick.length = 2;
    trick.enter = .3;
    trick.exit = 1.6;
    trick.open = .5;
    out.chains["carrot"] = {trick, trick};
    native_vm::TrickSpec quiet = trick;
    quiet.length = 2.45;
    quiet.enter = .42;
    quiet.exit = 1.95;
    quiet.open = .55;
    out.quiet_chains["carrot"] = {quiet, trick, trick};
    return out;
}

// The same with the Cottontail's and the Furrow's recoil (export-viewmodels.ts gunMotion).
native_vm::FirstPersonConfig config_with_recoil() {
    auto out = config();
    native_vm::GunMotionInfo pistol;
    pistol.cls = native_vm::GunClass::pistol;
    pistol.recoil = {3.2, 0.9, 1.6, 230};
    out.guns["usp"] = pistol;
    native_vm::GunMotionInfo rifle;
    rifle.recoil = {2.2, 1.1, 1.2, 160};
    out.guns["m4a1"] = rifle;
    return out;
}

struct Harness {
    Library library;
    std::unique_ptr<native_vm::FirstPersonWeapons> weapons;
    native_render::InspectCueQueue cues;
    double seconds = 0;
    uint32_t tick = 0;
    uint32_t weapon = native_vm::knife_weapon_id;
    bool silenced = false;

    explicit Harness(native_vm::FirstPersonConfig setup = config()) {
        weapons = std::make_unique<native_vm::FirstPersonWeapons>(std::move(setup), library.data);
    }

    // One frame (a tick each), with these events.
    const native_vm::FirstPersonOutput &step(bool shot = false, uint32_t flags = 0, bool feel = true) {
        FirstPersonInput in;
        in.seconds = seconds;
        in.weapon = weapon;
        const bool knife = weapon == native_vm::knife_weapon_id;
        in.entry = knife ? &library.knife : &library.gun;
        const bool m4a1 = weapon == m4a1_id;
        in.entry_name = knife ? "knife:carrot:knit" : m4a1 ? "gun:m4a1:knit" : "gun:usp:knit";
        in.item = knife ? "carrot" : m4a1 ? "m4a1" : "usp";
        in.tick = ++tick;
        in.shot = shot;
        in.flags = flags;
        in.attack_mode = 1;
        in.has_report = !knife;
        in.silenced = silenced;
        in.feel = feel;
        in.quiet_inspect = true;
        seconds += frame_seconds;
        cues.clear();
        return weapons->frame(in, cues);
    }

    const native_vm::FirstPersonOutput &run(double duration) {
        const auto *out = &step();
        for (double t = frame_seconds; t < duration - 1e-9; t += frame_seconds)
            out = &step();
        return *out;
    }
};

float clip_id(const native_vm::ViewmodelLayer &layer) {
    return (*layer.pose)[3];
}

// The weapon in hand (drawn last, over one lowering out).
const native_vm::ViewmodelLayer &in_hand(const native_vm::FirstPersonOutput &out) {
    return out.layers[out.count - 1];
}

float grip_offset(const native_vm::ViewmodelLayer &layer) {
    return (*layer.pose)[11];
}

// Height of the knife hand (about 16 forward, 6 right, 7 down of the eye) as a layer draws it.
float hand_height(const native_vm::ViewmodelLayer &layer) {
    constexpr float hand[3] = {16, -6, -7};
    const auto &v = layer.view;
    return v[8] * hand[0] + v[9] * hand[1] + v[10] * hand[2] + v[11];
}

// Knife to gun: the knife lowers out of view (down by the end) while the gun's draw starts at once.
void test_knife_lowers_while_the_gun_draws() {
    Harness h;
    h.run(1);
    h.weapon = 3;
    const auto &first = h.step();
    assert(first.count == 2 && first.layers[0].entry == &h.library.knife && first.layers[1].entry == &h.library.gun);
    assert(clip_id(first.layers[1]) == gun_draw);
    const float start = hand_height(first.layers[0]);
    float lowest = start;
    // It's gone in 0.15 s (viewmodel.ts KNIFE_HOLSTER).
    for (int frame = 0; frame < 13; frame++) {
        const auto &out = h.step();
        assert(out.count == 2);
        lowest = std::min(lowest, hand_height(out.layers[0]));
    }
    assert(lowest < start - 6);
    h.run(.05);
    assert(h.step().count == 1);
}

// Gun to knife: the gun plays its holster from where it was, then is gone.
void test_gun_holsters_from_where_it_was() {
    Harness h;
    h.weapon = 3;
    h.run(1);
    h.weapon = native_vm::knife_weapon_id;
    const auto &first = h.step();
    assert(first.count == 2 && first.layers[0].gun && clip_id(first.layers[0]) == gun_idle);
    assert(clip_id(first.layers[1]) == knife_draw);
    h.run(.08);
    assert(clip_id(h.step().layers[0]) == gun_holster);
    h.run(.15);
    assert(h.step().count == 1);
}

// A reset or a gap in drawn frames (hidden, a seek) never lowers anything.
void test_resets_and_hidden_frames_never_lower() {
    Harness h;
    h.run(1);
    h.weapons->reset();
    h.weapon = 3;
    assert(h.step().count == 1);
    h.run(1);
    h.seconds += 1;
    h.weapon = native_vm::knife_weapon_id;
    assert(h.step().count == 1);
}

// Quiet style: your first press starts the quiet check (yours only); pressing again carries on into the knife's own
// tricks. A replay's press plays the knife's own trick straight away.
void test_quiet_inspect_is_yours_only() {
    Harness h;
    h.run(1);
    assert(h.weapons->press_inspect(true, true));
    assert(clip_id(h.step().layers[0]) == quiet_check);
    assert(!h.weapons->press_inspect(true, true));
    // It takes over at the quiet check's exit (1.95 s) and crossfades in over 0.14 s.
    h.run(2.15);
    assert(clip_id(h.step().layers[0]) == own_trick);
    Harness replay;
    replay.run(1);
    assert(!replay.weapons->press_inspect(false, true));
    assert(clip_id(replay.step().layers[0]) == own_trick);
}

// An attack inside an inspect blends it out over the cancel's 65 ms instead of cutting to the swing.
void test_attack_blends_the_inspect_out() {
    Harness h;
    h.run(1);
    h.weapons->press_inspect(false, true);
    h.run(.5);
    assert(clip_id(h.step().layers[0]) == own_trick);
    const float during = clip_id(h.step(true).layers[0]);
    assert(during > knife_slash && during < own_trick);
    h.run(.03);
    const float later = clip_id(h.step().layers[0]);
    assert(later < during && later > knife_slash);
    h.run(.05);
    assert(clip_id(h.step().layers[0]) == knife_slash);
}

// A quiet gun eases its grip after a second or two; a shot puts it back at once.
void test_grip_idle_eases_and_a_shot_resets_it() {
    Harness h;
    h.weapon = 3;
    h.run(1);
    assert(grip_offset(h.step().layers[0]) == 0);
    // The trigger finger and the support fingers ease on their own slow periods (7.6 s and 10.3 s).
    float eased = 0;
    for (int frame = 0; frame < 1200; frame++)
        eased = std::max(eased, grip_offset(h.step().layers[0]));
    assert(eased > .5f);
    assert(clip_id(h.step(true).layers[0]) == gun_fire);
    h.run(.8);
    const auto &after = h.step();
    assert(clip_id(after.layers[0]) == gun_idle && grip_offset(after.layers[0]) == 0);
}

void test_shot_kicks_the_viewmodel_fov() {
    Harness h;
    h.weapon = 3;
    h.run(1);
    assert(h.step().layers[0].fov_scale == 1);
    h.step(true);
    h.run(.03);
    assert(h.step().layers[0].fov_scale < 1);
    h.run(.5);
    assert(h.step().layers[0].fov_scale == 1);
}

// The deepest dip of the hands within half a second of a landing at `vertical_speed`.
float landing_dip(double vertical_speed) {
    Harness h;
    h.run(1);
    const float rest = h.step().layers[0].view[11];
    h.weapons->simulation_tick(false, vertical_speed, 0);
    h.weapons->simulation_tick(true, 0, 0);
    float lowest = rest;
    for (int frame = 0; frame < 50; frame++)
        lowest = std::min(lowest, h.step().layers[0].view[11]);
    return rest - lowest;
}

void test_hard_landings_settle_the_hands() {
    const float bhop = landing_dip(-300), hard = landing_dip(-1200);
    assert(bhop < .1f && hard > .8f);
}

// How far the gun's muzzle points up (degrees) as the layer draws it.
double muzzle_up_degrees(const native_vm::ViewmodelLayer &layer) {
    return std::asin(std::clamp(double(layer.view[8]), -1., 1.)) / native_vm::radians_per_degree;
}

// The highest the muzzle gets with shots every `cycle` seconds (one shot if `cycle` is 0), with no movement feel.
double recoil_peak(double cycle) {
    Harness h(config_with_recoil());
    h.weapon = m4a1_id;
    h.run(1);
    double peak = 0;
    double since_shot = cycle;
    for (int frame = 0; frame < 100; frame++) {
        const bool shot = cycle > 0 ? since_shot >= cycle - 1e-9 : frame == 0;
        if (shot) since_shot = 0;
        since_shot += frame_seconds;
        const auto &out = h.step(shot, 0, false);
        assert(clip_id(out.layers[0]) >= gun_idle);
        peak = std::max(peak, muzzle_up_degrees(out.layers[0]));
    }
    return peak;
}

// Every shot kicks the recoil springs, so a string of shots climbs higher than one (guns/anim.ts fire); the fire clip
// itself restarts with each shot, as the website's slide and trigger do.
void test_rapid_fire_builds_the_recoil_up() {
    const double single = recoil_peak(0), rapid = recoil_peak(.09);
    assert(single > .5);
    assert(rapid > single * 1.3);
    Harness h(config_with_recoil());
    h.weapon = m4a1_id;
    h.run(1);
    h.step(true, 0, false);
    h.run(2);
    assert(std::abs(muzzle_up_degrees(h.step(false, 0, false).layers[0])) < 1e-3);
}

// A new gun clip crossfades from what's on screen: an inspect over 0.22 s, a shot out of it back over 0.22 s.
void test_gun_clips_crossfade() {
    Harness h;
    h.weapon = usp_id;
    h.run(1);
    h.weapons->press_inspect(true, true);
    const float entering = clip_id(h.step().layers[0]);
    assert(entering > gun_idle && entering < gun_inspect);
    h.run(.22);
    assert(clip_id(h.step().layers[0]) == gun_inspect);
    const float leaving = clip_id(h.step(true).layers[0]);
    assert(leaving < gun_inspect && leaving > gun_fire);
    h.run(.22);
    assert(clip_id(h.step().layers[0]) == gun_fire);
    // Shot to shot and idle to shot cut, as the website's overlays restart.
    assert(clip_id(h.step(true).layers[0]) == gun_fire);
}

// The click of an empty gun: its twitch clip and a small kick.
void test_dry_fire_twitches() {
    Harness h(config_with_recoil());
    h.weapon = m4a1_id;
    h.run(1);
    const auto &click = h.step(false, native_vm::dry_fire_flag, false);
    assert(clip_id(click.layers[0]) == gun_dry);
    h.run(.05);
    assert(muzzle_up_degrees(h.step(false, 0, false).layers[0]) > .05);
    h.run(.5);
    assert(clip_id(h.step(false, 0, false).layers[0]) == gun_idle);
}

// Physics 25: switching away 0.5 s into the M4A1's attach. It lowers with the can as it showed (the website's
// outgoing viewmodel keeps its silencer state); the core put the silencer back off, so it comes out plain next time.
void test_interrupted_attach_comes_back_as_the_core_has_it() {
    Harness h;
    h.weapon = m4a1_id;
    h.run(1);
    h.silenced = true;
    h.step(false, native_vm::silencer_flag);
    h.run(.3);
    assert(clip_id(h.step().layers[0]) == silencer_on);
    h.run(.2);
    h.weapon = native_vm::knife_weapon_id;
    h.silenced = false;
    h.step();
    h.run(.08);
    const auto &lowering = h.step();
    assert(lowering.count == 2 && clip_id(lowering.layers[0]) == silenced_holster);
    h.run(1);
    h.weapon = m4a1_id;
    assert(clip_id(in_hand(h.step())) == gun_draw);
    h.run(1);
    assert(clip_id(h.step().layers[0]) == gun_idle);
}

// A spectated player's silenced bit flips with a switch (the new gun's state, or an interrupted change put back): the
// gun coming out draws instead of playing an attach or detach.
void test_a_switch_never_starts_the_silencer() {
    Harness h;
    h.weapon = usp_id;
    h.silenced = true;
    h.run(1);
    assert(clip_id(h.step().layers[0]) == silenced_idle);
    h.weapon = m4a1_id;
    h.silenced = false;
    assert(clip_id(in_hand(h.step(false, native_vm::silencer_flag))) == gun_draw);
}

// After a reset the same frames pose the same, whatever was shown before (two exports of one replay match).
void test_a_reset_forgets_what_came_before() {
    auto after_reset = [](double before_seconds) {
        auto h = std::make_unique<Harness>(config_with_recoil());
        h->weapon = m4a1_id;
        h->run(before_seconds);
        h->step(true);
        h->weapons->reset();
        std::vector<native_vm::Matrix34> views;
        for (const uint32_t weapon : {native_vm::knife_weapon_id, m4a1_id}) {
            h->weapon = weapon;
            for (int frame = 0; frame < 150; frame++)
                views.push_back(h->step(frame == 120).layers[0].view);
            h->weapons->reset();
        }
        return views;
    };
    assert(after_reset(1.3) == after_reset(4.7));
}

// Every gun in the bundle's gunMotion is read, with its class, grip pivot and recoil.
void test_gun_motion_is_read_from_the_metadata() {
    const auto metadata = nlohmann::json::parse(R"({
        "inspects": {},
        "gunMotion": {
            "glock": {"cls": "pistol", "part": 4, "pivot": [1, 2, 3]},
            "m4a1": {"cls": "rifle", "part": 7, "pivot": [4, 5, 6],
                     "recoil": {"kick": 1.5, "back": 0.5, "roll": 0.25, "settle": 8}}
        }
    })");
    const auto config = native_vm::FirstPersonConfig::from_metadata(metadata);
    assert(config.guns.size() == 2);
    const auto &glock = config.guns.at("glock");
    assert(glock.cls == native_vm::GunClass::pistol);
    assert(glock.pivot_bone == 4);
    assert(glock.pivot[2] == 3);
    const auto &m4a1 = config.guns.at("m4a1");
    assert(m4a1.cls == native_vm::GunClass::rifle);
    assert(m4a1.pivot_bone == 7);
    assert(m4a1.recoil.kick == 1.5);
    assert(m4a1.recoil.settle == 8);
}

// Previews hold the weapon still.
void test_previews_have_no_feel() {
    Harness h;
    const auto &out = h.step(false, 0, false);
    for (int i = 0; i < 12; i++)
        assert(out.layers[0].view[i] == native_vm::identity34[i]);
}
}  // namespace

int main() {
    test_gun_motion_is_read_from_the_metadata();
    test_knife_lowers_while_the_gun_draws();
    test_gun_holsters_from_where_it_was();
    test_resets_and_hidden_frames_never_lower();
    test_quiet_inspect_is_yours_only();
    test_attack_blends_the_inspect_out();
    test_grip_idle_eases_and_a_shot_resets_it();
    test_shot_kicks_the_viewmodel_fov();
    test_hard_landings_settle_the_hands();
    test_previews_have_no_feel();
    test_rapid_fire_builds_the_recoil_up();
    test_gun_clips_crossfade();
    test_dry_fire_twitches();
    test_interrupted_attach_comes_back_as_the_core_has_it();
    test_a_switch_never_starts_the_silencer();
    test_a_reset_forgets_what_came_before();
    std::puts("First-person switching, inspects, grip idle, FOV kick, landings, recoil and silencer passed");
}
