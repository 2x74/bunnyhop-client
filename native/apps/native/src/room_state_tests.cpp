#include "room_state.hpp"
#include <memory>
#include <cassert>
#include <algorithm>
#include <cmath>
#include <vector>
#include <array>
#include <functional>
#include <set>
#include <string>
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
    const auto room_owner = std::make_unique<native::RoomState>();
    auto &room = *room_owner;
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
    const auto room_owner = std::make_unique<native::RoomState>();
    auto &room = *room_owner;
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

// Room roster cosmetics use the same packed field positions as profile/replay loadouts: hilt 10, camo 11.
void test_full_room_loadout_encoding() {
    const auto room_owner = std::make_unique<native::RoomState>();
    auto &room = *room_owner;
    J loadout = {
            {"knife", "knife-bunnyfly"},
            {"finish", "fin-sunset"},
            {"glove", "glove-aviator"},
            {"crown", 3},
            {"hat", "hat-starfish"},
            {"body", "body-a"},
            {"outfit", "outfit-cream"},
            {"hairColor", 0xf29bbf},
            {"hairLength", 120},
            {"hilt", "hilt-daikon"},
            {"camo", "camo-gold-vein"}
    };
    J players = J::array(
            {{{"slot", 0}, {"name", "me"}},
             {{"slot", 2}, {"name", "them"}, {"outfit", "outfit-cream"}, {"loadout", loadout}}}
    );
    room.event(envelope(
            {{"t", "welcome"}, {"you", 0}, {"room", {{"name", "r"}}}, {"map", {{"name", "m"}}}, {"players", players}}
    ));
    feed(room, J::array({sample(100, 0), sample(105, 5)}), 1);
    const auto actors = room.actors(2);
    assert(actors.size() == 1);
    assert(actors[0].loadout
           == "2;knife-bunnyfly;fin-sunset;glove-aviator;3;hat-starfish;body-a;outfit-cream;f29bbf;120;hilt-daikon;"
              "camo-gold-vein");
}

void test_null_loadout_fields_use_defaults() {
    const auto room = std::make_unique<native::RoomState>();
    room->event(envelope(
            {{"t", "welcome"},
             {"you", 0},
             {"map", {{"name", "m"}}},
             {"players",
              J::array(
                      {{{"slot", 2},
                        {"name", "them"},
                        {"loadout", {{"knife", nullptr}, {"finish", 42}, {"glove", nullptr}}}}}
              )}}
    ));
    feed(*room, J::array({sample(100, 0), sample(105, 5)}), 1);
    const auto actors = room->actors(2);
    assert(actors.size() == 1);
    assert(actors[0].loadout == "2;knife-carrot;finish-default;glove-default;;;body-a;;;;;");
}

struct Spectators {
    unsigned spectator_count = 0;
    std::array<native::HudLabel<64>, 8> spectators;
};

// The display steps the client runs after every room event and snapshot; none may throw on a room's data.
void refresh(native::RoomState &room, double now) {
    Spectators extras;
    room.refresh_display(now);
    room.refresh_spectators(extras);
    (void)room.change_notice(now);
    (void)room.scoreboard(now);
    (void)room.spectated(now);
}

J easy_welcome() {
    return {{"t", "welcome"},
            {"you", 0},
            {"room", {{"name", "Easy"}, {"maxPlayers", 16}, {"host", 0}}},
            {"map", {{"name", "bhop_eazy"}, {"tier", 1}, {"endsAt", 9000}}},
            {"players", J::array({{{"slot", 0}, {"name", "me"}}, {{"slot", 1}, {"name", "them"}}})},
            {"metas", {{"1", {{"style", 0}, {"timer", 2}, {"timerTicks", 100}, {"track", 0}, {"ping", 30}}}}},
            {"vote",
             {{"id", 1},
              {"kind", "rtv"},
              {"options", J::array({{{"map", "bhop_blue"}, {"tier", 1}}, {{"extend", true}, {"minutes", 10}}})},
              {"endsAt", 5000},
              {"counts", J::array({1, 0})}}},
            {"change", {{"map", "bhop_blue"}, {"tier", 1}, {"at", 9000}}},
            {"nominations", J::array({{{"map", "bhop_a"}, {"name", "p"}}})}};
}

// dr_unlisted 11-07 (easy server): snapshots for a slot whose join never arrived threw "type_error.306 cannot use
// value() with null" on every refresh, into chat, and the throw on the map event dropped the map change.
void test_unknown_slot_keeps_map_changes() {
    const auto room = std::make_unique<native::RoomState>();
    room->event(envelope(easy_welcome()));
    feed(*room, J::array({sample(100, 0)}), 1);
    room->snapshot(
            {{"generation", 1},
             {"id", "test"},
             {"snapshot", {{"blocks", J::array({{{"slot", 7}, {"samples", J::array({sample(1, 0)})}}})}}}},
            1
    );
    refresh(*room, 2);
    assert(room->display().count == 2);
    assert(room->event(envelope({{"t", "map"}, {"map", {{"name", "bhop_blue"}}}})) == "bhop_blue");
    refresh(*room, 3);
}

// Every optional field of the room's events and snapshots may be null: nothing on the display side throws, and an
// event only refuses the fields it can't do without (its type, your slot, the map's and a player's name and slot).
void test_null_fields_never_break_the_display() {
    const std::vector<J> events = {
            easy_welcome(),
            {{"t", "vote"}, {"vote", easy_welcome()["vote"]}, {"myVote", 0}},
            {{"t", "voteEnd"}, {"id", 1}, {"winner", {{"map", "bhop_blue"}, {"tier", 1}}}},
            {{"t", "change"}, {"change", {{"map", "bhop_blue"}, {"tier", 1}, {"at", 9000}}}},
            {{"t", "map"}, {"map", {{"name", "bhop_blue"}, {"tier", 1}, {"endsAt", 9}}}, {"nextMap", nullptr}},
            {{"t", "join"}, {"player", {{"slot", 2}, {"name", "new"}, {"spec", 0}, {"loadout", {{"knife", "k"}}}}}},
            {{"t", "player"}, {"slot", 1}, {"patch", {{"spec", 0}, {"afk", true}}}},
            {{"t", "chat"}, {"name", "n"}, {"text", "t"}},
            {{"t", "kicked"}, {"reason", "r"}},
    };
    const std::set<std::string> required = {
            "/t",
            "/you",
            "/map",
            "/map/name",
            "/players/0",
            "/players/0/name",
            "/players/0/slot",
            "/players/1",
            "/players/1/name",
            "/players/1/slot",
            "/player",
            "/player/name",
            "/player/slot",
            "/slot"
    };
    std::vector<J::json_pointer> paths;
    const std::function<void(const J &, const J::json_pointer &)> walk = [&](const J &value,
                                                                             const J::json_pointer &at) {
        if (!at.empty()) paths.push_back(at);
        if (value.is_object())
            for (const auto &[key, child] : value.items())
                walk(child, at / key);
        else if (value.is_array())
            for (size_t i = 0; i < value.size(); i++)
                walk(value[i], at / i);
    };
    for (size_t e = 0; e < events.size(); e++) {
        paths.clear();
        walk(events[e], J::json_pointer());
        for (const auto &path : paths) {
            auto event = events[e];
            event[path] = nullptr;
            const auto room = std::make_unique<native::RoomState>();
            if (e) room->event(envelope(easy_welcome()));
            try {
                room->event(envelope(event));
            } catch (const nlohmann::json::exception &) {
                assert(required.contains(path.to_string()));
            }
            refresh(*room, 2);
            feed(*room, J::array({sample(100, 0)}), 3, {{"style", nullptr}, {"timer", nullptr}, {"track", nullptr}});
            refresh(*room, 4);
        }
    }
    // Snapshot samples with a missing field are skipped, not thrown.
    const auto room = std::make_unique<native::RoomState>();
    room->event(envelope(easy_welcome()));
    for (const char *field : {"tick", "x", "yaw", "flags"}) {
        auto bad = sample(200, 0);
        bad[field] = nullptr;
        feed(*room, J::array({bad, nullptr}), 5);
    }
    refresh(*room, 6);
}

// The map vote shows each map's tier, as the website does (protocol.ts VoteOption {map, tier}); Extend and maps
// without a tier show none.
void test_vote_shows_tiers() {
    const auto room = std::make_unique<native::RoomState>();
    auto welcome = easy_welcome();
    welcome["vote"]["options"] = J::array(
            {{{"map", "bhop_blue"}, {"tier", 3}},
             {{"map", "bhop_a"}, {"tier", nullptr}},
             {{"extend", true}, {"minutes", 10}}}
    );
    welcome["vote"]["counts"] = J::array({2u, 0u, 1u});
    room->event(envelope(welcome));
    room->refresh_display(1);
    const auto &vote = room->vote_display;
    assert(vote.count == 3);
    assert(vote.options[0].view() == "bhop_blue" && vote.tiers[0] == 3 && vote.counts[0] == 2);
    assert(vote.options[1].view() == "bhop_a" && vote.tiers[1] == 0);
    assert(vote.options[2].view() == "Extend 10 minutes" && vote.tiers[2] == 0 && vote.counts[2] == 1);
}

// Watching a replay of another map from a room keeps the room (v0.8.0); closing it goes back to the room's map.
void test_closing_a_replay_returns_to_the_room_map() {
    const auto room = std::make_unique<native::RoomState>();
    assert(room->map_after_replay("bhop_eazy").empty());
    room->event(envelope(easy_welcome()));
    assert(room->map_after_replay("bhop_eazy").empty());
    assert(room->map_after_replay("bhop_blue") == "bhop_eazy");
    room->event(envelope({{"t", "kicked"}, {"reason", "r"}}));
    assert(room->map_after_replay("bhop_blue").empty());
}

int main() {
    test_closing_a_replay_returns_to_the_room_map();
    test_vote_shows_tiers();
    test_unknown_slot_keeps_map_changes();
    test_null_fields_never_break_the_display();
    test_null_loadout_fields_use_defaults();
    test_full_room_loadout_encoding();
    test_live_cosmetics();
    test_smooth_under_jitter();
    const auto room_owner = std::make_unique<native::RoomState>();
    auto &room = *room_owner;
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
