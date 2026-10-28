#include "room_state.hpp"
#include <cassert>
#include <cmath>
using J = nlohmann::json;

J envelope(J event) {
    return {{"generation", 1}, {"id", "test"}, {"event", event}};
}

J sample(unsigned tick, double x, unsigned flags = 1) {
    return {{"tick", tick},
            {"x", x},
            {"y", 0},
            {"z", 0},
            {"vx", 100},
            {"vy", 0},
            {"vz", 0},
            {"yaw", 0},
            {"pitch", 0},
            {"flags", flags}};
}

void feed(native::RoomState &room, J samples, double now, J meta = nullptr, bool silenced = false) {
    room.snapshot(
            {{"generation", 1},
             {"id", "test"},
             {"snapshot",
              {{"blocks",
                J::array(
                        {{{"slot", 2}, {"samples", samples}, {"meta", meta}, {"weapon", 2}, {"silenced", silenced}}}
                )}}}},
            now
    );
}

int main() {
    native::RoomState room;
    room.event(envelope(
            {{"t", "welcome"},
             {"you", 1},
             {"players",
              J::array(
                      {{{"slot", 1}, {"name", "Self"}},
                       {{"slot", 2},
                        {"name", "Other"},
                        {"style", "legit"},
                        {"playerGlow", {{"enabled", true}, {"aura", true}, {"color", "cyan"}, {"intensity", .8}}}}}
              )},
             {"map", {{"name", "bhop_test"}}},
             {"room", {{"name", "Test"}}},
             {"nativeClockOffsetMs", 500}}
    ));
    feed(room,
         J::array({sample(100, 0), sample(110, 10, 17), sample(120, 20)}),
         1,
         {{"timer", 2}, {"timerTicks", 100}, {"ping", 35}},
         true);
    auto actors = room.actors(1);
    assert(actors.size() == 1 && std::abs(actors[0].frame.position[0] - 10) < .001);
    assert(actors[0].attack == 1 && actors[0].silenced);
    assert(actors[0].playerGlow && actors[0].playerGlow->enabled && actors[0].playerGlow->color[2] > .9f);
    assert(room.actors(1)[0].attack == 1);     // Multiple consumers of one render frame share the event.
    assert(room.actors(1.01)[0].attack == 0);  // Events are never retriggered on following frames.
    assert(room.timer(2, 2)->first == 2 && room.timer(2, 2)->second == 2);
    const auto rows = room.scoreboard(2);
    assert(rows.size() == 2 && rows[1].is_object());
    auto held = room.actors(2);
    assert(held[0].frame.position[0] <= 30.001);  // 100ms extrapolation ceiling.
    feed(room, J::array({sample(130, 500, 9)}), 2);
    assert(room.actors(2)[0].frame.position[0] == 500 && room.actors(2)[0].snapped);
    room.event(envelope({{"t", "change"}, {"change", {{"map", "bhop_next"}, {"at", 10500}}}}));
    assert(room.change_notice(9000).find("1s") != std::string::npos);
    room.event(envelope({{"t", "nativeStatus"}, {"status", "closed"}}));
    assert(room.actors(3).empty() && !room.spectator_target);
    room.close();
    feed(room, J::array({sample(200, 999)}), 4);
    assert(room.actors(4).empty());
}
