// The knife attack on the third-person bunny: the website's fire layer frame by frame, then your own ticks of the real
// simulation and the trailer of a real replay through to the bones a player sees.
#include "actor_anim.hpp"
#include "bunnyhop_native.h"
#include "data_location.hpp"
#include "ghost_slots.hpp"
#include "native_input.hpp"
#include "replay_controls.hpp"
#include "test_bsp.hpp"
#include "third_person_events.hpp"
#include "weapon_commands.hpp"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using native_actor_anim::Data;
using native_actor_anim::V;
using native_render::Actor;
using native_render::ThirdPersonEvents;
using J = nlohmann::json;
using Core = std::unique_ptr<BhContext, decltype(&bh_destroy)>;

constexpr int missing_assets_exit = 77;
constexpr double web_matrix_tolerance = .002;
// A swing a player can see: the hand leaves where it would have been by more than this.
constexpr double visible_swing_units = 4;
constexpr double back_to_normal_units = .001;
constexpr double web_hand_tolerance_units = .01;
constexpr uint32_t attack_event = 1u << 5, grounded_flag = 2;
constexpr uint32_t first_gun = native_render::first_gun_weapon;
constexpr uint32_t ticks_per_frame = 2;
constexpr double tick_seconds = .01;
constexpr float walk_forward = 100;

void check(bool ok, const std::string &what) {
    if (!ok) throw std::runtime_error("third-person swing: " + what);
}

void require(int result, BhContext *core, const char *what) {
    if (!result) throw std::runtime_error(std::string(what) + ": " + bh_last_error(core));
}

double distance(const native_gestures::Vec3 &a, const native_gestures::Vec3 &b) {
    return std::hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// What a player sees of a swing: where the right hand and the knife are against the same pose without one.
class SwingWatch {
public:
    explicit SwingWatch(const Data &data) : rig_(data.rig) {
        const auto names = data.rig.at("names").get<std::vector<std::string>>();
        const auto knife = std::find(names.begin(), names.end(), "bunny.Knife");
        knife_ = knife == names.end() ? -1 : int(knife - names.begin());
    }

    double hand_offset(const V &swung, const V &plain) const {
        return distance(rig_.joint(swung, rig_.arms[0].hand), rig_.joint(plain, rig_.arms[0].hand));
    }

    double knife_offset(const V &swung, const V &plain) const {
        return knife_ < 0 ? 0 : distance(rig_.joint(swung, knife_), rig_.joint(plain, knife_));
    }

private:
    native_gestures::Rig rig_;
    int knife_ = -1;
};

native_actor_anim::Input stance_input(const J &stance) {
    native_actor_anim::Input input;
    input.velocity = stance.at("velocity").get<std::array<float, 3>>();
    input.yaw = 25;
    input.pitch = 10;
    input.ducking = stance.at("ducking");
    input.grounded = stance.at("onGround");
    return input;
}

double web_matrix_error(const J &frame, const J &bones, const V &world) {
    const auto expected = frame.at("world").get<V>();
    double error = 0;
    for (size_t b = 0; b < bones.size(); ++b)
        for (size_t k = 0; k < 12; ++k)
            error = std::max(error, std::abs(double(expected[b * 12 + k] - world[bones[b].get<size_t>() * 12 + k])));
    return error;
}

// Runs one stance on the native model beside the same stance without a swing, against the website's frames.
void web_stance(const Data &data, const SwingWatch &watch, const J &stance, const J &bones) {
    const std::string name = stance.at("name");
    const auto &frames = stance.at("frames");
    native_actor_anim::State swung(data), plain(data);
    const auto input = stance_input(stance);
    V swung_skin, plain_skin;
    double peak_hand = 0, peak_knife = 0, error = 0, last_hand = 0;
    bool swing_seen = false;
    for (size_t index = 0; index < frames.size(); ++index) {
        const auto &frame = frames[index];
        const double time = frame.at("time");
        const bool shot = frame.at("shot"), snap = index == 0;
        swung.pose(input, time, snap, shot, swung_skin);
        plain.pose(input, time, snap, false, plain_skin);
        error = std::max(error, web_matrix_error(frame, bones, swung.bs.world));
        const bool active = frame.at("fireActive");
        check((swung.fireSeq >= 0) == active, name + ": the gesture's timing differs from the website's");
        swing_seen |= shot;
        last_hand = watch.hand_offset(swung_skin, plain_skin);
        check(std::abs(last_hand - frame.at("handOffset").get<double>()) <= web_hand_tolerance_units,
              name + ": the hand doesn't move as far as on the website");
        peak_hand = std::max(peak_hand, last_hand);
        peak_knife = std::max(peak_knife, watch.knife_offset(swung_skin, plain_skin));
        if (!swing_seen) check(last_hand <= back_to_normal_units, name + ": the hand moved before the swing");
    }
    check(error <= web_matrix_tolerance, name + ": arm bones differ from the website by " + std::to_string(error));
    check(peak_hand >= visible_swing_units, name + ": the swing barely moves the hand");
    check(peak_knife >= visible_swing_units, name + ": the swing barely moves the knife");
    check(last_hand <= back_to_normal_units, name + ": the pose did not return to normal after the swing");
    check(!frames.back().at("fireActive").get<bool>(), name + ": the website's gesture has not ended");
    std::cout << name << ": hand moves " << peak_hand << " units, knife " << peak_knife
              << ", worst arm error against the website " << error << '\n';
}

void web_fire_layer(const Data &data, const J &fire) {
    const SwingWatch watch(data);
    for (const auto &stance : fire.at("stances"))
        web_stance(data, watch, stance, fire.at("bones"));
}

Actor knife_actor() {
    Actor actor;
    actor.frame.weapon = native_render::knife_weapon;
    return actor;
}

void remote_and_repeat_pulses() {
    using native_render::actor_pulses;
    auto actor = knife_actor();
    actor.attack = 2;
    actor.snapped = true;
    const auto first = actor_pulses(actor, false);
    check(first.swing && first.snapped && !first.shot && !first.reload, "a remote stab is a swing");
    const auto again = actor_pulses(actor, true);
    check(!again.swing && !again.snapped, "the shadow and mirror poses of a frame replay its pulses");
    actor.frame.weapon = first_gun;
    actor.attack = 1;
    const auto shot = actor_pulses(actor, false);
    check(shot.shot && !shot.swing && !shot.reload, "a remote gun's shot played as a knife swing");
    actor.attack = 2;
    const auto reload = actor_pulses(actor, false);
    check(reload.reload && !reload.swing && !reload.shot, "a remote gun's reload played as a knife swing");
    check(actor_pulses(actor, false, true).swing, "an avatar pose with a gun in hand stops swinging");
}

BhWeaponReport knife_report() {
    BhWeaponReport weapon{};
    weapon.active = native_render::knife_weapon;
    return weapon;
}

BhAttackReport knife_swing(uint32_t mode) {
    BhAttackReport attack{};
    attack.weapon = native_render::knife_weapon;
    attack.mode = mode;
    return attack;
}

unsigned frame_swing(ThirdPersonEvents &events, Actor &actor) {
    events.own_frame();
    events.apply(actor);
    return actor.attack;
}

void own_frames_play_each_swing_once() {
    ThirdPersonEvents events;
    auto actor = knife_actor();
    const auto idle = knife_report();
    const auto slash = knife_swing(1), stab = knife_swing(2);
    check(frame_swing(events, actor) == 0 && actor.snapped, "the first frame starts the model over");
    events.tick(idle, &slash, tick_seconds);
    check(frame_swing(events, actor) == 1 && !actor.snapped, "a slash reaches the model on the next frame");
    check(frame_swing(events, actor) == 0, "a frame without a new tick repeats the swing");
    events.tick(idle, &slash, tick_seconds);
    events.tick(idle, &stab, tick_seconds);
    events.tick(idle, nullptr, tick_seconds);
    check(frame_swing(events, actor) == 2, "a frame spanning several ticks loses the last swing");
    events.tick(idle, &slash, tick_seconds);
    events.own_frame();
    events.own_frame();
    check(frame_swing(events, actor) == 0, "a swing made in first person plays late in third person");
    check(actor.snapped, "the model doesn't start over when it comes back into view");
    frame_swing(events, actor);
    events.snap();
    frame_swing(events, actor);
    check(actor.snapped, "a teleport doesn't start the model over");
    frame_swing(events, actor);
    check(!actor.snapped, "a teleport keeps starting the model over");
}

void own_gun_events() {
    ThirdPersonEvents events;
    Actor actor;
    actor.frame.weapon = first_gun;
    BhWeaponReport gun{};
    gun.active = first_gun;
    gun.clip = 2;
    BhAttackReport shot{};
    shot.weapon = first_gun;
    events.tick(gun, nullptr, tick_seconds);
    events.tick(gun, &shot, tick_seconds);
    check(frame_swing(events, actor) == native_render::gun_shot_pulse, "your shot doesn't kick the gun");
    gun.flags = native_render::weapon_reload_started_flag;
    gun.reload_ticks = 220;
    gun.clip = 0;
    events.tick(gun, nullptr, tick_seconds);
    gun.flags = 0;
    frame_swing(events, actor);
    check(actor.gunReload && actor.gunReload->empty && !actor.gunReload->shell,
          "an empty reload doesn't reach the gun");
    check(std::abs(actor.gunReload->seconds - 2.2) < 1e-9, "the reload isn't timed by the core");
    gun.clip = 1;
    gun.reload_ticks = 1;
    events.tick(gun, nullptr, tick_seconds);
    frame_swing(events, actor);
    check(actor.gunReload && actor.gunReload->shell, "a clip that rises isn't reported as a shell");
    check(actor.gunReload->seconds == native_render::min_own_reload_seconds, "the shortest reload isn't the website's");
    frame_swing(events, actor);
    check(!actor.gunReload, "a reload plays again on the next frame");
}

// A short walk off the fixture's box, finished and written out, with a trailer the oracle chose.
struct RecordedRun {
    std::filesystem::path path;
    uint32_t start_tick = 0;
};

class Fixture {
public:
    Fixture()
        : directory_(
                  std::filesystem::temp_directory_path()
                  / ("bunnyhop-swing-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()))
          ) {
        std::filesystem::create_directories(directory_ / "models" / "fixture");
        write(directory_ / "fixture.bsp", native::test::make_bsp());
        write(directory_ / "models" / "fixture" / "box.mdl", native::test::make_box_model());
    }

    ~Fixture() {
        std::error_code error;
        std::filesystem::remove_all(directory_, error);
    }

    Core load() const {
        Core core(bh_create(), bh_destroy);
        const auto map = native::data_location::utf8(directory_ / "fixture.bsp");
        const auto content = native::data_location::utf8(directory_);
        require(bh_load_map(core.get(), map.c_str(), content.c_str()), core.get(), "Loading fixture");
        return core;
    }

    std::filesystem::path path(const char *name) const { return directory_ / name; }

private:
    static void write(const std::filesystem::path &path, const std::vector<uint8_t> &bytes) {
        std::ofstream output(path, std::ios::binary);
        output.write(reinterpret_cast<const char *>(bytes.data()), std::streamsize(bytes.size()));
    }

    std::filesystem::path directory_;
};

void stand_on_box(BhContext *core) {
    require(bh_reset(core), core, "Restarting");
    require(bh_set_position(core, 10, 20, 65, 0), core, "Placing");
}

// Two models on the same movement, one playing the swings: how far the visible hand strays from the plain one.
class ArmWatch {
public:
    explicit ArmWatch(const Data &data) : swung_(data), plain_(data), watch_(data) {}

    void pose(const Actor &self, double time) {
        native_actor_anim::Input input;
        std::copy_n(self.frame.velocity, 3, input.velocity.begin());
        input.yaw = self.frame.yaw;
        input.pitch = self.frame.pitch;
        input.grounded = bool(self.frame.flags & grounded_flag);
        const auto pulses = native_render::actor_pulses(self, false);
        swung_.pose(input, time, pulses.snapped, pulses.swing, swung_skin_);
        plain_.pose(input, time, pulses.snapped, false, plain_skin_);
        last_hand = watch_.hand_offset(swung_skin_, plain_skin_);
        peak_hand = std::max(peak_hand, last_hand);
    }

    double peak_hand = 0, last_hand = 0;

private:
    native_actor_anim::State swung_, plain_;
    SwingWatch watch_;
    V swung_skin_, plain_skin_;
};

void step_tick(BhContext *core, uint32_t buttons, ThirdPersonEvents &events, BhWeaponReport &weapon) {
    BhCmd command{};
    command.buttons = buttons;
    BhState state{};
    require(bh_step(core, &command, &state), core, "Stepping");
    bh_weapon_report(core, &weapon);
    BhAttackReport attack{};
    const bool attacked = bh_attack_report(core, &attack);
    check(attacked == bool(state.events & attack_event), "the attack report and event disagree");
    events.tick(weapon, attacked ? &attack : nullptr, tick_seconds);
}

// Your own swings: the real buttons through the real simulation to the model's arm.
void live_swings_reach_the_arm(const Fixture &fixture, const Data *data) {
    constexpr uint32_t slash_tick = 10, stab_tick = 130, last_tick = 320;
    auto core = fixture.load();
    stand_on_box(core.get());
    ThirdPersonEvents events;
    std::optional<ArmWatch> arm;
    if (data) arm.emplace(*data);
    std::vector<unsigned> pulses;
    for (uint32_t tick = 0; tick < last_tick; ++tick) {
        BhWeaponReport weapon{};
        const uint32_t buttons = tick == slash_tick ? native::attack : tick == stab_tick ? native::attack2 : 0;
        step_tick(core.get(), buttons, events, weapon);
        if (tick % ticks_per_frame) continue;
        events.own_frame();
        BhSnapshot snapshot{};
        require(bh_snapshot(core.get(), &snapshot), core.get(), "Reading snapshot");
        auto self = native_render::own_actor(snapshot, 10, 25, weapon.active);
        events.apply(self);
        if (self.attack) pulses.push_back(self.attack);
        if (arm) arm->pose(self, tick * tick_seconds);
    }
    check((pulses == std::vector<unsigned>{1, 2}), "your slash and stab each reach the model once");
    if (!arm) return;
    check(arm->peak_hand >= visible_swing_units, "your swing doesn't move the third-person arm");
    check(arm->last_hand <= back_to_normal_units, "your arm doesn't come back after the swing");
    std::cout << "your own swing: hand moves " << arm->peak_hand << " units\n";
}

void live_shots_reach_the_gun(const Fixture &fixture) {
    constexpr uint32_t draw_ticks = 150, press_period = 40, shots_wanted = 3, tick_limit = 3000;
    auto core = fixture.load();
    stand_on_box(core.get());
    ThirdPersonEvents events;
    BhWeaponReport weapon{};
    step_tick(core.get(), first_gun << native::give_shift, events, weapon);
    for (uint32_t tick = 0; tick < draw_ticks; ++tick)
        step_tick(core.get(), 0, events, weapon);
    check(weapon.active >= first_gun, "the fixture didn't hand out a gun");
    uint32_t shots = 0, pulses = 0;
    for (uint32_t tick = 0; tick < tick_limit && shots < shots_wanted; ++tick) {
        step_tick(core.get(), tick % press_period ? 0 : native::attack, events, weapon);
        BhAttackReport attack{};
        if (bh_attack_report(core.get(), &attack)) ++shots;
        events.own_frame();
        Actor actor;
        actor.frame.weapon = weapon.active;
        events.apply(actor);
        const auto pulse = native_render::actor_pulses(actor, false);
        check(!pulse.swing, "a shot plays the knife's swing");
        if (pulse.shot) ++pulses;
    }
    check(shots == shots_wanted, "the gun didn't fire");
    check(pulses == shots, "each of your shots should kick the gun once");
}

RecordedRun record_run(BhContext *core, const Fixture &fixture, const J &trailer, const J &inspects) {
    constexpr uint32_t tick_limit = 6000;
    const std::array<BhZone, 2> zones = {
            BhZone{0, 0, 0, {-100, -100, -10000}, {18, 100, 1000}},
            BhZone{1, 0, 0, {300, -100, -10000}, {1000, 100, 1000}}
    };
    BhRunOptions options{};
    bh_default_run_options(&options);
    require(bh_run_configure(core, &options, zones.data(), zones.size()), core, "Configuring zones");
    stand_on_box(core);
    require(bh_record_begin(core, "", "autohop", "test", 100), core, "Recording");
    BhState state{};
    BhRunState run{};
    RecordedRun recorded;
    for (uint32_t tick = 0; tick < tick_limit && run.status != 2; ++tick) {
        BhCmd command{};
        command.forward = walk_forward;
        require(bh_step(core, &command, &state), core, "Stepping the run");
        require(bh_run_state(core, &run), core, "Reading the run");
        if (run.status != 1) continue;
        recorded.start_tick = run.start_tick;
        const uint32_t at = state.tick - run.start_tick;
        for (const auto &swing : trailer)
            if (swing.at("tick") == at) require(bh_record_cosmetic(core, swing.at("kind")), core, "Marking a swing");
        for (const auto &inspect : inspects)
            if (inspect.at("tick") == at) require(bh_record_inspect(core, inspect.at("kind")), core, "Marking inspect");
    }
    check(run.status == 2, "the fixture run didn't finish");
    check(state.tick - run.start_tick > trailer.back().at("tick").get<uint32_t>(), "the fixture run is too short");
    require(bh_record_end(core), core, "Ending the run");
    recorded.path = fixture.path("swings.bhr");
    const auto path = native::data_location::utf8(recorded.path);
    require(bh_record_write_bhr(core, path.c_str()), core, "Writing the replay");
    return recorded;
}

void check_gestures(const Actor &actor, const J &want, const std::string &who) {
    const std::string at = who + " at tick " + want.at("tick").dump();
    check(actor.attack == want.at("attack").get<unsigned>(), at + ": swing differs from the website");
    check(actor.inspect == want.at("inspect").get<unsigned>(), at + ": inspect differs from the website");
    check(actor.inspectHeld == want.at("held").get<bool>(), at + ": inspect hold differs from the website");
}

native_render::GhostPath ghost_path(BhContext *core, uint32_t handle, const nlohmann::json &info) {
    native_render::GhostPath path;
    path.start = info.at("startTick");
    path.end = info.at("endTick");
    path.frames.resize(size_t(path.end) + 1);
    for (uint32_t tick = 0; tick <= path.end; ++tick)
        require(bh_ghost_frame(core, handle, tick, &path.frames[tick]), core, "Reading the ghost");
    path.teleports.assign(path.frames.size(), 0);
    return path;
}

void race_ghost_plays_trailer(BhContext *core, const std::filesystem::path &replay, const J &frames) {
    native::GhostSlots ghosts;
    ghosts.load(core, replay, 0);
    const auto &slot = ghosts.slots[0];
    const auto path = ghost_path(core, slot.handle, slot.info);
    for (const auto &want : frames) {
        Actor actor;
        check(ghosts.present(core, 0, path, want.at("tick").get<double>(), actor), "the race ghost isn't posed");
        check_gestures(actor, want, "race ghost");
    }
}

void compare_ghost_plays_trailer(BhContext *core, const RecordedRun &run, const J &frames) {
    native::ReplayCompare compare;
    const auto handle = bh_ghost_load(core, native::data_location::utf8(run.path).c_str());
    require(handle != 0, core, "Loading the ghost");
    size_t bytes = 0;
    const char *raw = bh_ghost_info(core, handle, &bytes);
    auto playback = J::parse(raw, raw + bytes);
    bh_ghost_free(core, handle);
    auto play = [&](const char *who) {
        for (const auto &want : frames) {
            const uint32_t tick = run.start_tick + uint32_t(want.at("tick").get<double>());
            const auto *actor = compare.sample(tick, tick_seconds);
            check(actor != nullptr, "the compare ghost isn't posed");
            check_gestures(*actor, want, who);
        }
    };
    const auto path = native::data_location::utf8(run.path);
    compare.load(core, path, native_render::GhostSource::custom, playback);
    play("compare ghost");
    compare.adopt(compare.detach());
    play("prepared compare ghost");
}

void replay_viewer_plays_trailer(BhContext *core, const RecordedRun &run, const J &frames) {
    require(bh_replay_load(core, native::data_location::utf8(run.path).c_str()), core, "Loading the replay");
    ThirdPersonEvents events;
    for (const auto &want : frames) {
        auto actor = knife_actor();
        events.replay_frame(core, run.start_tick + want.at("tick").get<uint32_t>());
        events.apply(actor);
        check_gestures(actor, want, "replay viewer");
    }
    // An empty hand doesn't swing or inspect; neither does a gun, though native replays mark its shots.
    ThirdPersonEvents hand, gun;
    for (const auto &want : frames) {
        const uint32_t tick = run.start_tick + want.at("tick").get<uint32_t>();
        auto empty = knife_actor();
        empty.emptyHand = true;
        hand.replay_frame(core, tick);
        hand.apply(empty);
        check(!empty.attack && !empty.inspect && !empty.inspectHeld, "an empty hand plays the replay's swing");
        auto armed = knife_actor();
        armed.frame.weapon = first_gun;
        gun.replay_frame(core, tick);
        gun.apply(armed);
        check(!armed.attack && !armed.inspect && !armed.gunReload, "a gun in a replay plays the trailer's swing");
    }
    require(bh_replay_stop(core), core, "Stopping the replay");
}

void recorded_trailer_paths(const Fixture &fixture, const J &oracle) {
    auto core = fixture.load();
    const auto run = record_run(core.get(), fixture, oracle.at("trailer"), oracle.at("inspects"));
    race_ghost_plays_trailer(core.get(), run.path, oracle.at("ghost"));
    compare_ghost_plays_trailer(core.get(), run, oracle.at("ghost"));
    replay_viewer_plays_trailer(core.get(), run, oracle.at("viewer"));
}

}  // namespace

int main(int argc, char **argv) {
    try {
        check(argc == 3, "usage: third_person_swing_tests ASSETS ORACLE");
        J oracle;
        std::ifstream(argv[2]) >> oracle;
        check(!oracle.is_null(), "the oracle didn't load");
        std::unique_ptr<Data> data;
        if (!oracle.at("fire").is_null()) data = std::make_unique<Data>(argv[1]);
        remote_and_repeat_pulses();
        own_frames_play_each_swing_once();
        own_gun_events();
        const Fixture fixture;
        live_swings_reach_the_arm(fixture, data.get());
        live_shots_reach_the_gun(fixture);
        recorded_trailer_paths(fixture, oracle);
        if (!data) {
            std::cout << "Hosted actor assets absent; run bun run models first\n";
            return missing_assets_exit;
        }
        web_fire_layer(*data, oracle.at("fire"));
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
