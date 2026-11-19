// Seeking in a replay: the frames before the cut come from the replay itself, and with them the chase camera and the
// bunny's bank arrive where continuous playback has them (web chase-camera.test.ts: within 2.5 units).
#include "actor_anim.hpp"
#include "bunnyhop_native.h"
#include "data_location.hpp"
#include "native_input.hpp"
#include "replay_camera.hpp"
#include "replay_preroll.hpp"
#include "replay_seeker.hpp"
#include "replay_session.hpp"
#include "test_bsp.hpp"
#include "third_person_events.hpp"
#include <chrono>
#include <cmath>
#include <cstring>
#include <optional>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using Core = std::unique_ptr<BhContext, decltype(&bh_destroy)>;

constexpr int missing_assets_exit = 77;
constexpr double tick_seconds = .01;
constexpr uint32_t preroll_ticks = 60, seek_after_ticks = 100;
// The website's bound for a seek against continuous playback, and how far a snap without a pre-roll lands.
constexpr double seek_camera_units = 2.5, snapped_camera_units = 5;
constexpr double seek_bank_degrees = .05;
constexpr float run_forward = 400, sweep_degrees = 25, sweep_rate = .05;

void check(bool ok, const std::string &what) {
    if (!ok) throw std::runtime_error("replay pre-roll: " + what);
}

void require(int result, BhContext *core, const char *what) {
    if (!result) throw std::runtime_error(std::string(what) + ": " + bh_last_error(core));
}

class Fixture {
public:
    Fixture()
        : directory_(
                  std::filesystem::temp_directory_path()
                  / ("bunnyhop-preroll-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()))
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

// A run across the fixture's box at full speed, the view sweeping left and right, after `wait_ticks` standing in the
// start zone; returns its first tick.
uint32_t record_run(BhContext *core, const std::filesystem::path &file, uint32_t wait_ticks = 0) {
    constexpr uint32_t tick_limit = 3000;
    const std::array<BhZone, 2> zones = {
            BhZone{0, 0, 0, {-100, -100, -10000}, {18, 100, 1000}},
            BhZone{1, 0, 0, {300, -100, -10000}, {1000, 100, 1000}}
    };
    BhRunOptions options{};
    bh_default_run_options(&options);
    require(bh_run_configure(core, &options, zones.data(), zones.size()), core, "Configuring zones");
    require(bh_reset(core), core, "Restarting");
    require(bh_set_position(core, 10, 20, 65, 0), core, "Placing");
    require(bh_record_begin(core, "", "autohop", "test", 100), core, "Recording");
    BhState state{};
    BhRunState run{};
    const BhCmd still{};
    for (uint32_t tick = 0; tick < wait_ticks; ++tick)
        require(bh_step(core, &still, &state), core, "Waiting in the start zone");
    for (uint32_t tick = 0; tick < tick_limit && run.status != 2; ++tick) {
        BhCmd command{};
        command.forward = run_forward;
        command.yaw = sweep_degrees * std::sin(float(tick) * sweep_rate);
        require(bh_step(core, &command, &state), core, "Stepping the run");
        require(bh_run_state(core, &run), core, "Reading the run");
    }
    check(run.status == 2, "the fixture run didn't finish");
    require(bh_record_end(core), core, "Ending the run");
    const auto path = native::data_location::utf8(file);
    require(bh_record_write_bhr(core, path.c_str()), core, "Writing the replay");
    require(bh_replay_load(core, path.c_str()), core, "Loading the replay");
    BhSnapshot first{};
    require(bh_replay_seek(core, 0, &first), core, "Seeking the start");
    return first.player.tick;
}

void frames_come_from_the_replay(BhContext *core, uint32_t start) {
    const uint32_t cut = start + seek_after_ticks;
    const auto frames = native::gather_replay_preroll(core, cut, tick_seconds);
    check(frames.size() == preroll_ticks, "the pre-roll isn't the 0.6 s before the cut");
    for (size_t i = 0; i < frames.size(); i++)
        check(frames[i].snapshot.player.tick == cut - preroll_ticks + i, "the pre-roll skips a tick");
    BhSnapshot at_cut{};
    require(bh_replay_seek(core, cut, &at_cut), core, "Seeking after the pre-roll");
    check(at_cut.player.tick == cut, "the replay doesn't seek to the cut after a pre-roll");
    check(native::gather_replay_preroll(core, start, tick_seconds).size() == std::min(start, preroll_ticks),
          "a cut near the start pre-rolls what there is");
    check(native::gather_replay_preroll(core, 0, tick_seconds).empty(), "a cut at the first tick pre-rolls");
}

// A seek spread over frames stops at the pre-roll's start, and finishing it there lands where a direct seek does.
void seeks_in_slices_land_where_a_seek_does(const Fixture &fixture, uint32_t start) {
    auto core = fixture.load();
    const auto path = native::data_location::utf8(fixture.path("preroll.bhr"));
    require(bh_replay_load(core.get(), path.c_str()), core.get(), "Loading the replay");
    const uint32_t cut = start + seek_after_ticks;
    native::ReplaySeeker seeker;
    seeker.start(cut, native::replay_preroll_start(cut, tick_seconds));
    check(seeker.seeking(), "a seek doesn't start");
    std::optional<uint32_t> ready;
    for (int frame = 0; frame < 100 && !ready; frame++)
        ready = seeker.advance(core.get());
    check(ready == cut && !seeker.seeking(), "a sliced seek doesn't finish at its tick");
    BhState here{};
    require(bh_state(core.get(), &here), core.get(), "Reading the state");
    check(here.tick == cut - preroll_ticks, "a sliced seek doesn't stop at the pre-roll's start");
    const auto frames = native::gather_replay_preroll(core.get(), cut, tick_seconds);
    BhSnapshot sliced{}, direct{};
    require(bh_replay_seek(core.get(), cut, &sliced), core.get(), "Finishing the seek");
    auto other = fixture.load();
    require(bh_replay_load(other.get(), path.c_str()), other.get(), "Loading the replay again");
    require(bh_replay_seek(other.get(), cut, &direct), other.get(), "Seeking directly");
    check(frames.size() == preroll_ticks, "the pre-roll after a sliced seek is short");
    check(std::memcmp(&sliced.player, &direct.player, sizeof(BhState)) == 0, "a sliced seek lands somewhere else");
}

// Opening for the viewer doesn't seek: playback stays at the first tick until the seeker reaches the range's start,
// which lands where opening with the seek does.
void opening_defers_the_start_seek(const Fixture &fixture) {
    constexpr uint32_t wait_ticks = 300;
    using Session = native::ReplaySession;
    auto core = fixture.load();
    const auto path = fixture.path("waited.bhr");
    record_run(core.get(), path, wait_ticks);
    core = fixture.load();
    const auto deferred = Session::open(core.get(), path, false, Session::Seek::later);
    BhState here{};
    require(bh_state(core.get(), &here), core.get(), "Reading the state");
    check(deferred.initial.snapshot.player.tick == 0 && here.tick == 0, "opening for the viewer seeked");
    check(deferred.range.from > wait_ticks / 2, "the fixture run's range starts at its first tick");
    native::ReplaySeeker seeker;
    seeker.start(deferred.range.from, native::replay_preroll_start(deferred.range.from, tick_seconds));
    std::optional<uint32_t> ready;
    for (int frame = 0; frame < 100 && !ready; frame++)
        ready = seeker.advance(core.get());
    check(ready == deferred.range.from, "the start seek doesn't finish");
    const auto reached = deferred.seek(core.get(), *ready);
    auto other = fixture.load();
    const auto direct = Session::open(other.get(), path);
    check(std::memcmp(&reached.snapshot.player, &direct.initial.snapshot.player, sizeof(BhState)) == 0,
          "the deferred start lands somewhere else");
}

native::PrerollFrame frame_at(BhContext *core, uint32_t tick) {
    native::PrerollFrame frame;
    require(bh_replay_seek(core, tick, &frame.snapshot), core, "Seeking");
    require(bh_last_command(core, &frame.view), core, "Reading the view");
    return frame;
}

std::array<float, 3>
chase_eye(native::ReplayCamera &camera, BhContext *core, const native::PrerollFrame &frame, double dt) {
    native::Input view;
    std::array<float, 3> eye{};
    const auto &player = frame.snapshot.player;
    camera.sample(core, player, frame.view.yaw, frame.view.pitch, player.tick * tick_seconds, eye.data(), view, dt);
    return eye;
}

double apart(const std::array<float, 3> &a, const std::array<float, 3> &b) {
    return std::hypot(double(a[0]) - b[0], double(a[1]) - b[1], double(a[2]) - b[2]);
}

void camera_lands_where_playback_has_it(BhContext *core, uint32_t start) {
    const uint32_t cut = start + seek_after_ticks;
    native::ReplayCamera playing, seeked, snapped;
    for (auto *camera : {&playing, &seeked, &snapped})
        camera->set_mode("chase");
    std::array<float, 3> continuous{};
    for (uint32_t tick = start; tick <= cut; tick++)
        continuous = chase_eye(playing, core, frame_at(core, tick), tick == start ? 0 : tick_seconds);
    const auto frames = native::gather_replay_preroll(core, cut, tick_seconds);
    const auto at_cut = frame_at(core, cut);
    seeked.preroll(core, frames, tick_seconds);
    const double with_preroll = apart(continuous, chase_eye(seeked, core, at_cut, tick_seconds));
    const double without = apart(continuous, chase_eye(snapped, core, at_cut, 0));
    check(with_preroll <= seek_camera_units, "the chase camera lands " + std::to_string(with_preroll) + " units off");
    check(without >= snapped_camera_units, "the fixture's view doesn't turn enough to show the pre-roll");
    std::cout << "chase camera after a seek: " << with_preroll << " units from playback (" << without
              << " without the pre-roll)\n";
}

native_actor_anim::Input bunny_input(const native::PrerollFrame &frame) {
    const auto actor = native_render::prerolled_actor({}, frame);
    native_actor_anim::Input input;
    std::copy_n(actor.frame.position, 3, input.position.begin());
    std::copy_n(actor.frame.velocity, 3, input.velocity.begin());
    input.yaw = actor.frame.yaw;
    input.pitch = actor.frame.pitch;
    input.grounded = actor.frame.flags & 2;
    input.ducking = actor.frame.flags & 1;
    input.sidemove = actor.sidemove;
    return input;
}

void bunny_banks_like_playback(BhContext *core, uint32_t start, const native_actor_anim::Data &data) {
    const uint32_t cut = start + seek_after_ticks;
    auto playing = std::make_unique<native_actor_anim::State>(data);
    auto seeked = std::make_unique<native_actor_anim::State>(data);
    native_actor_anim::V skin;
    for (uint32_t tick = start; tick <= cut; tick++)
        playing->pose(bunny_input(frame_at(core, tick)), tick * tick_seconds, tick == start, false, skin);
    bool first = true;
    for (const auto &frame : native::gather_replay_preroll(core, cut, tick_seconds)) {
        seeked->pose(bunny_input(frame), frame.snapshot.player.tick * tick_seconds, first, false, skin);
        first = false;
    }
    seeked->pose(bunny_input(frame_at(core, cut)), cut * tick_seconds, false, false, skin);
    check(std::abs(playing->bank) > seek_bank_degrees, "the fixture run doesn't bank the bunny");
    check(std::abs(seeked->bank - playing->bank) <= seek_bank_degrees, "the bunny banks differently after a seek");
    std::cout << "bunny bank after a seek: " << seeked->bank << " degrees, playback " << playing->bank << "\n";
}

}  // namespace

int main(int argc, char **argv) {
    try {
        check(argc == 2, "usage: replay_preroll_tests ASSETS");
        const Fixture fixture;
        auto core = fixture.load();
        const uint32_t start = record_run(core.get(), fixture.path("preroll.bhr"));
        frames_come_from_the_replay(core.get(), start);
        seeks_in_slices_land_where_a_seek_does(fixture, start);
        opening_defers_the_start_seek(fixture);
        camera_lands_where_playback_has_it(core.get(), start);
        if (!std::filesystem::exists(std::filesystem::path(argv[1]) / "actor-animations.json")) {
            std::cout << "Hosted actor assets absent; run bun run models first\n";
            return missing_assets_exit;
        }
        const auto data = std::make_unique<native_actor_anim::Data>(argv[1]);
        bunny_banks_like_playback(core.get(), start, *data);
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
