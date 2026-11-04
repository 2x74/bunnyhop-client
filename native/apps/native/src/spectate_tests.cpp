// Room spectating: the camera cycle, the hint under the spectator bar, the N / !spec menu and the chat lines.
#include "free_cameras.hpp"
#include "settings.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cstdio>
#include <string>
#include <vector>

namespace {

using Mode = native::SpectatorView::Mode;

struct Controls {
    native::Input input;
    std::set<std::string> held;
    native::InputTimeline timeline;
    native::FreeLookInput free_look{timeline, input, held};

    Controls() { timeline.rebuild_binds(native::default_settings().at("binds")); }
};

native::BindTable default_binds() {
    native::BindTable binds;
    binds.rebuild(native::default_settings().at("binds"));
    return binds;
}

void test_space_and_f_cycle_the_camera() {
    Controls controls;
    const auto binds = default_binds();
    native::SpectatorView view;
    view.watch(true, controls.free_look);
    assert(view.mode() == Mode::eye);
    assert(view.changes_camera("Space", binds) && view.changes_camera("KeyF", binds));
    assert(!view.changes_camera("KeyW", binds));
    view.cycle(controls.free_look);
    assert(view.mode() == Mode::chase && !controls.timeline.diverted());
    controls.held = {"KeyW"};
    view.cycle(controls.free_look);
    assert(view.free() && controls.timeline.diverted() && controls.held.empty());
    // Free look, as on the website (net/mp.ts): Space is jump, so it flies (rises); F still goes back in-eye.
    assert(!view.changes_camera("Space", binds) && view.changes_camera("KeyF", binds));
    view.cycle(controls.free_look);
    assert(view.mode() == Mode::eye && !controls.timeline.diverted());
}

void test_switching_players_keeps_the_camera() {
    Controls controls;
    native::SpectatorView view;
    view.watch(true, controls.free_look);
    view.toggle_free(controls.free_look);
    view.watch(false, controls.free_look);
    assert(view.free());
    view.watch(true, controls.free_look);
    assert(view.mode() == Mode::eye);
    view.toggle_chase(controls.free_look);
    view.watch(false, controls.free_look);
    assert(view.chase());
    view.stop(controls.free_look);
    assert(view.mode() == Mode::eye);
}

void test_hint_names_the_way_out() {
    auto settings = native::default_settings().at("binds");
    native::BindTable binds;
    binds.rebuild(settings);
    Controls controls;
    native::SpectatorView view;
    assert(view.hint("KeyR", binds) == "Space changes the camera, R stops watching.");
    assert(view.hint("", binds) == "Space changes the camera, !r stops watching.");
    view.toggle_free(controls.free_look);
    assert(view.hint("KeyR", binds) == "Free look. F goes back in-eye, R stops watching.");
    settings["forward"] = {"KeyF"};
    binds.rebuild(settings);
    assert(view.hint("KeyR", binds) == "Free look. !freecam goes back in-eye, R stops watching.");
    assert(!view.changes_camera("KeyF", binds));
}

// As on the website (net/mp.ts): with F bound to movement too, F and Space both fly in free look, and !freecam or the
// freecam bind is the way back in-eye. The restart key still stops watching.
void test_free_look_always_has_a_way_back() {
    auto settings = native::default_settings().at("binds");
    settings["forward"] = {"KeyW", "KeyF"};
    Controls controls;
    controls.timeline.rebuild_binds(settings);
    const auto &binds = controls.timeline.binds();
    native::FreeCameras cameras;
    cameras.follow(std::nullopt, 3, {true, false, false}, controls.free_look);
    assert(cameras.spectator.changes_camera("KeyF", binds) && cameras.spectator.changes_camera("Space", binds));
    cameras.spectator.cycle(controls.free_look);
    cameras.spectator.cycle(controls.free_look);
    assert(cameras.spectator.free());
    assert(!cameras.spectator.changes_camera("KeyF", binds) && !cameras.spectator.changes_camera("Space", binds));
    assert(cameras.spectator.hint("KeyR", binds) == "Free look. !freecam goes back in-eye, R stops watching.");
    assert(cameras.toggle(true, {true, false, false}, controls.free_look).empty());
    assert(cameras.spectator.mode() == Mode::eye && !controls.timeline.diverted());
}

// Free look starts where the In-eye or Chase view last was, not where the frame first put the camera.
void test_free_look_starts_from_the_last_view() {
    Controls controls;
    native::FreeCameras cameras;
    cameras.follow(std::nullopt, 3, {true, false, false}, controls.free_look);
    float chase_eye[3] = {100, 200, 300};
    native::Input view;
    view.set_angles(10, 45);
    assert(!cameras.place(true, chase_eye, view, {}, controls.input, .01));
    cameras.spectator.cycle(controls.free_look);
    cameras.spectator.cycle(controls.free_look);
    float eye[3] = {0, 0, 64};
    native::Input frame_view;
    assert(cameras.place(true, eye, frame_view, {}, controls.input, .01));
    assert(eye[0] == 100 && eye[1] == 200 && eye[2] == 300);
    assert(std::abs(frame_view.yaw() - 45) < 1e-9 && std::abs(frame_view.pitch - 10) < 1e-9);
    assert(cameras.wheel(1, true) && cameras.spectator.free_look().speed_ups() == 625);
}

void test_watching_ends_freecam() {
    Controls controls;
    native::FreeCameras cameras;
    assert(cameras.toggle(false, {true, false, false}, controls.free_look).empty());
    assert(cameras.freecam.active() && cameras.flying(false));
    cameras.follow(std::nullopt, 3, {true, false, false}, controls.free_look);
    assert(!cameras.freecam.active() && !controls.timeline.diverted() && cameras.spectator.mode() == Mode::eye);
    // !freecam while watching is free look.
    assert(cameras.toggle(true, {true, false, false}, controls.free_look).empty());
    assert(cameras.spectator.free() && !cameras.freecam.active());
    cameras.follow(3, std::nullopt, {true, false, false}, controls.free_look);
    assert(!controls.timeline.diverted());
    assert(cameras.toggle(false, {true, true, false}, controls.free_look)
           == "Freecam isn't available in the tutorial.");
    assert(!cameras.freecam.active());
}

// The client loop's side of the cameras: once a frame they follow whom you watch, and leaving the map or restarting
// stops them (client.cpp leave_map, reset).
struct ClientFrames {
    Controls controls;
    native::FreeCameras cameras;
    std::optional<unsigned> observed;
    native::FreecamPlace place{true, false, false};

    void frame(std::optional<unsigned> watched) {
        cameras.follow(observed, watched, place, controls.free_look);
        observed = watched;
    }

    void leave_map() {
        cameras.stop(controls.free_look);
        observed.reset();
        place.map_loaded = false;
    }

    void watch_in_free_look() {
        frame(3);
        cameras.spectator.cycle(controls.free_look);
        cameras.spectator.cycle(controls.free_look);
        assert(cameras.spectator.free() && controls.timeline.diverted());
    }

    // Back in your own body: W and the mouse reach the next tick.
    void assert_input_is_yours() {
        assert(!controls.timeline.diverted() && !cameras.flying(observed.has_value()));
        assert(cameras.spectator.mode() == Mode::eye && !cameras.freecam.active());
        auto &queue = controls.timeline.queue();
        const size_t edges = queue.pending_edges();
        const double motion = queue.pending_x;
        controls.timeline.key(controls.held, "KeyW", true, false, 0, 0);
        controls.timeline.motion(controls.input, 0, 0, 7, 0);
        assert(queue.pending_edges() == edges + 1 && queue.pending_x == motion + 7);
        controls.timeline.key(controls.held, "KeyW", false, false, 0, 0);
    }
};

void test_every_way_out_of_watching_gives_the_input_back() {
    // Leaving the room, a disconnect, R / B / M, the Esc menu's Stop and a map change all reach the client as nobody
    // watched any more.
    {
        ClientFrames client;
        client.watch_in_free_look();
        client.frame(std::nullopt);
        client.assert_input_is_yours();
    }
    // Leaving to the main menu forgets the watched player, so the next frame sees no change; then a solo map loads.
    {
        ClientFrames client;
        client.watch_in_free_look();
        client.leave_map();
        client.frame(std::nullopt);
        client.assert_input_is_yours();
        client.place.map_loaded = true;
        client.frame(std::nullopt);
        client.assert_input_is_yours();
    }
    // Even with the watched player forgotten and no stop, the free look ends on the next frame.
    {
        ClientFrames client;
        client.watch_in_free_look();
        client.observed.reset();
        client.frame(std::nullopt);
        client.assert_input_is_yours();
    }
}

void test_every_way_out_of_freecam_gives_the_input_back() {
    const auto flying = [](ClientFrames &client) {
        assert(client.cameras.toggle(false, client.place, client.controls.free_look).empty());
        assert(client.cameras.freecam.active() && client.controls.timeline.diverted());
    };
    {
        ClientFrames client;
        flying(client);
        client.leave_map();
        client.frame(std::nullopt);
        client.assert_input_is_yours();
    }
    // A restart (R / B / M, a style switch) stops the cameras as leaving does.
    {
        ClientFrames client;
        flying(client);
        client.cameras.stop(client.controls.free_look);
        client.assert_input_is_yours();
    }
    // The map unloads, or a replay or tutorial lesson opens, without a stop.
    for (const native::FreecamPlace place :
         {native::FreecamPlace{false, false, false}, {true, true, false}, {true, false, true}}) {
        ClientFrames client;
        flying(client);
        client.place = place;
        client.frame(std::nullopt);
        client.assert_input_is_yours();
    }
    // Starting to watch someone.
    {
        ClientFrames client;
        flying(client);
        client.frame(3);
        assert(!client.cameras.freecam.active() && !client.controls.timeline.diverted());
    }
}

native::HudScoreboard room_of(std::initializer_list<std::tuple<unsigned, const char *, bool, bool>> rows) {
    native::HudScoreboard board;
    for (const auto &[slot, name, you, spectator] : rows) {
        auto &row = board.rows[board.count++];
        row.slot = slot;
        row.name = name;
        row.you = you;
        row.spectator = spectator;
    }
    return board;
}

void test_spectate_menu() {
    native::SpectatePicker picker;
    assert(!picker.show(room_of({{0, "me", true, false}, {1, "watcher", false, true}}), std::nullopt));
    assert(!picker.open());
    const auto board = room_of({{0, "me", true, false}, {1, "goobert", false, false}, {2, "akee", false, false}});
    assert(picker.show(board, std::nullopt) && picker.count() == 2 && picker.name(0) == "goobert");
    assert(!picker.offers_stop());
    auto pick = picker.key("Digit3", true, false);
    assert(pick.handled && !pick.watch && !pick.stop && picker.open());
    pick = picker.key("Digit2", true, false);
    assert(pick.handled && pick.watch == 2u && !picker.open());
    assert(picker.show(board, 1u) && picker.offers_stop());
    pick = picker.key("Digit3", true, false);
    assert(pick.stop && !pick.watch && !picker.open());
    picker.show(board, 1u);
    assert(!picker.key("Digit1", true, true).handled && !picker.key("KeyW", true, false).handled);
    assert(picker.key("Digit0", true, false).handled && !picker.open());
    assert(native::spectate_script(2u) == "window.bunnyhopNativeMenu?.onRoomCommand?.({t:'spec',target:2})");
    assert(native::spectate_script(std::nullopt)
           == "window.bunnyhopNativeMenu?.onRoomCommand?.({t:'spec',target:null})");
}

struct ChatLog {
    std::vector<std::string> lines;

    void push(std::string text, std::string, std::string kind, double) {
        assert(kind == "local");
        lines.push_back(std::move(text));
    }
};

struct Names {
    std::string_view player_name(unsigned slot) const { return slot == 3 ? "goobert" : ""; }
};

void test_chat_lines() {
    ChatLog chat;
    const auto binds = default_binds();
    native::announce_watching(chat, Names{}, std::nullopt, 3u, binds, 0);
    native::announce_watching(chat, Names{}, 3u, std::nullopt, binds, 0);
    native::announce_watching(chat, Names{}, std::nullopt, std::nullopt, binds, 0);
    assert(chat.lines.size() == 2);
    assert(chat.lines[0]
           == "Spectating goobert. Mouse 1 and 2 switch players, Space changes the camera, R stops watching.");
    assert(chat.lines[1] == "Back in the run. N or !spec to watch again.");
}

}  // namespace

int main() {
    test_space_and_f_cycle_the_camera();
    test_switching_players_keeps_the_camera();
    test_hint_names_the_way_out();
    test_free_look_always_has_a_way_back();
    test_free_look_starts_from_the_last_view();
    test_watching_ends_freecam();
    test_every_way_out_of_watching_gives_the_input_back();
    test_every_way_out_of_freecam_gives_the_input_back();
    test_spectate_menu();
    test_chat_lines();
    std::puts("spectate passed");
}
