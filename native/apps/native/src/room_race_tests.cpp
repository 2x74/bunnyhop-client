#include "room_modes.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <fstream>
#include <iostream>
using J = nlohmann::json;

J race(std::string state = "countdown", int you = 0) {
    J racers = J::array();
    for (const char *name : {"Alice", "Bob"})
        racers.push_back(
                {{"name", name},
                 {"slot", 1},
                 {"place", nullptr},
                 {"dnf", nullptr},
                 {"finish", nullptr},
                 {"checking", false}}
        );
    return {{"id", "roomrace01"},
            {"state", state},
            {"map", "bhop_eazy"},
            {"style", "sideways"},
            {"track", 0},
            {"you", you},
            {"racers", racers},
            {"joinUntil", 7000},
            {"goAt", 10000},
            {"endsAt", 610000}};
}

J event(J race, std::string type = "roomRace", unsigned generation = 1) {
    return {{"id", "test"},
            {"generation", generation},
            {"event", {{"t", type}, {type == "welcome" ? "roomRace" : "race", race}, {"nativeClockOffsetMs", 1000}}}};
}

void countdown_and_go() {
    native::RoomModes modes;
    auto action = modes.event(event(race("joining")), "bhop_eazy", false, 5000);
    assert(!action.restart && !modes.frozen());
    action = modes.event(event(race()), "bhop_eazy", true, 6000);
    assert(action.restart && action.canonical_start && action.stop_spectating && action.style == "sideways");
    assert(modes.frozen());
    modes.event(
            {{"id", "test"}, {"generation", 1}, {"event", {{"t", "race"}, {"race", nullptr}}}}, "bhop_eazy", false, 6500
    );
    assert(modes.frozen());
    for (const double now : {6000., 7000., 8000.}) {
        assert(modes.room_race_tick(now));
        assert(!modes.room_race_tick(now));
    }
    assert(!modes.room_race_tick(9000));
    assert(modes.frozen());
    assert(!modes.event(event(race()), "bhop_eazy", false, 9500).restart);
    action = modes.event(event(race("live")), "bhop_eazy", true, 9600);
    assert(action.restart && action.canonical_start && action.stop_spectating && action.room_race_go);
    assert(!modes.frozen());
    assert(!modes.event(event(race("live")), "bhop_eazy", false, 9700).restart);
}

void loading_cancellation_and_reconnect() {
    native::RoomModes loading;
    assert(!loading.event(event(race()), "old_map", true, 6000).restart);
    assert(loading.frozen());
    assert(!loading.event(event(race("live")), "old_map", true, 9100).restart);
    assert(loading.frozen());
    const auto action = loading.map_loaded("bhop_eazy", true, 9200);
    assert(action.restart && action.room_race_go && action.stop_spectating && !loading.frozen());
    assert(!loading.map_loaded("bhop_eazy", false, 9300).restart);
    native::RoomModes cancelled;
    cancelled.event(event(race()), "old_map", false, 6000);
    auto over = race("over");
    over["outcome"] = "cancelled";
    assert(cancelled.event(event(over), "old_map", false, 6500).room_race_over);
    assert(!cancelled.frozen() && !cancelled.map_loaded("bhop_eazy", false, 9200).restart);
    native::RoomModes reconnect;
    assert(!reconnect.event(event(race("live"), "welcome"), "bhop_eazy", false, 9200).restart);
    reconnect.event(event(race()), "bhop_eazy", false, 6000);
    assert(!reconnect.event(event(race("live"), "welcome"), "bhop_eazy", false, 9200).restart);
    assert(!reconnect.frozen());
    native::RoomModes countdown_reconnect;
    assert(countdown_reconnect.event(event(race(), "welcome"), "bhop_eazy", false, 6000).restart);
}

void observers_forfeits_and_results() {
    native::RoomModes observer;
    assert(!observer.event(event(race("countdown", -1)), "bhop_eazy", true, 6000).restart);
    assert(!observer.frozen() && !observer.room_race_tick(7000) && !observer.has_race());
    assert(!observer.event(event(race("live", -1)), "bhop_eazy", true, 9200).restart);
    native::RoomModes racer;
    racer.event(event(race()), "bhop_eazy", false, 6000);
    auto left = race();
    left["racers"][0]["dnf"] = "forfeit";
    racer.event(event(left), "bhop_eazy", false, 6500);
    assert(!racer.frozen());
    left["state"] = "live";
    assert(!racer.event(event(left), "bhop_eazy", false, 9200).restart);
    auto result = race("over");
    result["racers"][0]["place"] = 2;
    result["racers"][0]["finish"] = {{"time", 10}, {"real", 11}};
    auto action = racer.event(event(result), "bhop_eazy", false, 20000);
    assert(action.room_race_finish && action.room_race_over && !action.restart);
    action = racer.event(event(result), "bhop_eazy", false, 21000);
    assert(!action.room_race_finish && !action.room_race_over);
    assert(racer.room_race_display().line.view() == "Room race · Place 2");
    racer.room_race_tick(28001);
    assert(!racer.room_race_display().visible);
    racer.event(event(race()), "bhop_eazy", false, 30000);
    racer.close(1);
    assert(!racer.frozen() && !racer.map_loaded("bhop_eazy", false, 31000).restart);
    assert(!racer.event(event(race()), "bhop_eazy", false, 32000).restart);
    assert(racer.event(event(race(), "roomRace", 2), "bhop_eazy", false, 33000).restart);
    auto invalid = race();
    invalid["you"] = 2;
    native::RoomModes bounded;
    assert(!bounded.event(event(invalid), "bhop_eazy", false, 6000).restart && !bounded.frozen());
    auto bonus = race();
    bonus["track"] = 2;
    const auto bonus_action = bounded.event(event(bonus), "bhop_eazy", false, 6000);
    assert(bonus_action.restart && bonus_action.track == 2 && bonus_action.style.empty());
    bounded.event(event(nullptr), "bhop_eazy", false, 7000);
    assert(!bounded.frozen() && !bounded.room_race_display().visible);
}

void shared_vectors(const char *path) {
    std::ifstream input(path);
    assert(input.good());
    const auto vectors = J::parse(input);
    for (const auto &example : vectors) {
        native::RoomModes modes;
        for (const auto &step : example.at("steps")) {
            const auto action = modes.event(event(step.at("view")), "bhop_eazy", false, 6000);
            assert(action.restart == step.at("restart").get<bool>());
            assert(action.room_race_go == step.at("go").get<bool>());
            assert(action.room_race_finish == step.at("finish").get<bool>());
            assert(action.room_race_over == step.at("over").get<bool>());
            assert(modes.frozen() == step.at("frozen").get<bool>());
        }
    }
}

// The loopback socket qualification drives the same lifecycle without graphics.
int wire() {
    native::RoomModes modes;
    std::string line;
    while (std::getline(std::cin, line)) {
        const auto request = J::parse(line);
        const auto action = modes.event(
                request.at("message"), request.at("map"), request.value("spectating", false), request.at("now")
        );
        std::cout << J(
                             {{"restart", action.restart},
                              {"canonical", action.canonical_start},
                              {"go", action.room_race_go},
                              {"finish", action.room_race_finish},
                              {"over", action.room_race_over},
                              {"frozen", modes.frozen()}}
        ).dump() << std::endl;
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && std::string(argv[1]) == "--wire") return wire();
    if (argc == 2) shared_vectors(argv[1]);
    countdown_and_go();
    loading_cancellation_and_reconnect();
    observers_forfeits_and_results();
    std::cout << "Room-race holds, canonical starts, loading, reconnects, observers and results passed\n";
}
