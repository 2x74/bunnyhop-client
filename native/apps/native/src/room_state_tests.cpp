#include "room_state.hpp"
#include <cassert>
#include <algorithm>
#include <cmath>
#include <vector>
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

// A player running a circle at 300 u/s, sampled at 20 Hz and sent in 100 ms batches that arrive up to 30 ms late,
// drawn at 1000 FPS: the drawn speed stays close to 300, without the jumps each clock estimate change used to cause.
void test_smooth_under_jitter() {
    constexpr double radius = 400, speed = 300, jitter_seconds = .03, frame_seconds = .001;
    native::RoomState room;
    room.event(envelope(
            {{"t", "welcome"},
             {"you", 0},
             {"room", {{"name", "r"}}},
             {"map", {{"name", "m"}}},
             {"players", J::array({{{"slot", 0}, {"name", "me"}}, {{"slot", 1}, {"name", "them"}}})}}
    ));
    const double rate = speed / radius;

    struct Batch {
        double arrive;
        J message;
    };

    std::vector<Batch> batches;
    uint32_t noise = 12345;
    for (int b = 0; b < 200; ++b) {
        J samples = J::array();
        for (int k = 0; k < 2; ++k) {
            const unsigned tick = unsigned((b * 2 + k) * 5 + 5);
            const double t = tick * .01;
            samples.push_back(
                    {{"tick", tick},
                     {"x", radius * std::cos(rate * t)},
                     {"y", radius * std::sin(rate * t)},
                     {"z", 0},
                     {"vx", -speed * std::sin(rate * t)},
                     {"vy", speed * std::cos(rate * t)},
                     {"vz", 0},
                     {"yaw", 0},
                     {"pitch", 0},
                     {"flags", 1}}
            );
        }
        noise = noise * 1664525u + 1013904223u;
        const double late = jitter_seconds * double(noise >> 8) / double(1u << 24);
        J block = {{"slot", 1}, {"samples", samples}};
        batches.push_back(
                {(b * 2 + 1) * .05 + .09 + late,
                 {{"generation", 1}, {"id", "test"}, {"snapshot", {{"serverTime", 0}, {"blocks", J::array({block})}}}}}
        );
    }
    std::sort(batches.begin(), batches.end(), [](const Batch &a, const Batch &b) { return a.arrive < b.arrive; });
    size_t next = 0;
    double previous[2] = {NAN, NAN}, worst = 0;
    for (double now = 2; now < 18; now += frame_seconds) {
        for (; next < batches.size() && batches[next].arrive <= now; ++next)
            room.snapshot(batches[next].message, batches[next].arrive);
        const auto actors = room.actors(now);
        assert(actors.size() == 1);
        const auto &position = actors[0].frame.position;
        if (!std::isnan(previous[0])) {
            const double drawn = std::hypot(position[0] - previous[0], position[1] - previous[1]) / frame_seconds;
            worst = std::max(worst, std::abs(drawn - speed));
        }
        previous[0] = position[0];
        previous[1] = position[1];
    }
    assert(worst < 30);
}

// A roster patch with a new outfit or loadout (the room re-stamping a player who changed cosmetics) shows at once.
void test_live_cosmetics() {
    native::RoomState room;
    room.event(envelope(
            {{"t", "welcome"},
             {"you", 0},
             {"room", {{"name", "r"}}},
             {"map", {{"name", "m"}}},
             {"players",
              J::array(
                      {{{"slot", 0}, {"name", "me"}},
                       {{"slot", 2},
                        {"name", "them"},
                        {"outfit", "outfit-cream"},
                        {"loadout", {{"knife", "knife-carrot"}, {"finish", "fin-garden"}, {"glove", "glove-knit"}}}}}
              )}}
    ));
    feed(room, J::array({sample(100, 0), sample(105, 5)}), 1);
    auto actors = room.actors(2);
    assert(actors.size() == 1 && actors[0].outfit == "outfit-cream");
    assert(actors[0].loadout.find("knife-carrot") != std::string::npos);
    room.event(envelope(
            {{"t", "player"},
             {"slot", 2},
             {"patch",
              {{"outfit", "outfit-midnight"},
               {"loadout", {{"knife", "knife-bayonet"}, {"finish", "fin-garden"}, {"glove", "glove-knit"}}}}}}
    ));
    actors = room.actors(2.01);
    assert(actors[0].outfit == "outfit-midnight");
    assert(actors[0].loadout.find("knife-bayonet") != std::string::npos);
}

int main() {
    test_live_cosmetics();
    test_smooth_under_jitter();
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
