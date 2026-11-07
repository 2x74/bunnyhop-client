#include "room_modes.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <fstream>
#include <iostream>
#include <algorithm>
#include <vector>
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
    // A place that comes with the final result goes in the standings, not under the crosshair.
    assert(racer.room_race_display().finish_until == 0 && racer.room_race_display().over);
    assert(racer.room_race_display().verdict.view() == "2nd of 2");
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

struct Drawn {
    std::string text;
    float x, y, size;
    native::NameColor color;
};

// Records what draw_room_race puts on screen (monospace widths, as the HUD font's).
struct RecordingHud {
    std::vector<Drawn> drawn;

    void overlay_begin(int, int, float) {}

    void overlay_end(int, int) {}

    void overlay_fade(float) {}

    void overlay_text(float x, float y, std::string_view text, float size, native::NameColor color, bool = false) {
        drawn.push_back({std::string(text), x, y, size, color});
    }

    float overlay_text_width(std::string_view text, float size) const { return float(text.size()) * size * .6f; }

    const Drawn *find(std::string_view text) const {
        for (const auto &d : drawn)
            if (d.text == text) return &d;
        return nullptr;
    }

    const Drawn *last(std::string_view text) const {
        for (auto d = drawn.rbegin(); d != drawn.rend(); ++d)
            if (d->text == text) return &*d;
        return nullptr;
    }
};

native::RoomRaceStack stack(bool reduced_motion, bool banner = true, float endcard_bottom = 0) {
    native::RoomRaceStack value;
    value.reduced_motion = reduced_motion;
    value.banner = banner;
    value.endcard_bottom = endcard_bottom;
    return value;
}

RecordingHud draw(const native::RoomModes &modes, double now, native::RoomRaceStack stack = {}) {
    RecordingHud hud;
    native::draw_room_race(hud, 1600, 900, 100, modes.room_race_display(), now, stack);
    return hud;
}

J racer(const char *name, J place = nullptr, J real = nullptr, J dnf = nullptr) {
    return {{"name", name},
            {"slot", 1},
            {"place", place},
            {"dnf", dnf},
            {"finish", real.is_null() ? J(nullptr) : J{{"time", real}, {"real", real}}},
            {"checking", false}};
}

// What racers see (web net/race.ts): the line, numerals, GO, the place and the standings. Observers see nothing.
void racer_visuals() {
    using native::race_ordinal;
    native::HudLabel<16> ordinal;
    for (const auto &[n, text] : std::vector<std::pair<unsigned, std::string>>{
                 {1, "1st"},
                 {2, "2nd"},
                 {3, "3rd"},
                 {4, "4th"},
                 {11, "11th"},
                 {12, "12th"},
                 {13, "13th"},
                 {21, "21st"},
                 {22, "22nd"},
                 {111, "111th"}
         }) {
        race_ordinal(ordinal, n);
        assert(ordinal.view() == text);
    }
    native::RoomModes modes;
    auto joining = race("joining");
    joining["track"] = 1;
    modes.event(event(joining), "bhop_eazy", false, 1000);
    auto hud = draw(modes, 1000);
    assert(hud.find("Room race") && hud.find("2 racers") && hud.find("starts in ") && hud.find("5 s"));
    auto countdown = race();
    countdown["track"] = 1;
    modes.event(event(countdown), "bhop_eazy", false, 6000);
    assert(modes.room_race_display().board.view() == "2 racers, Bonus 1");
    hud = draw(modes, 6500);
    assert(hud.find("3") && hud.find("2 racers, Bonus 1") && !hud.find("starts in "));
    // The numeral stamps in: big and faint at first, its own size once landed.
    const auto landing_hud = draw(modes, 8001), landed_hud = draw(modes, 8400);
    const auto *landing = landing_hud.find("1");
    const auto *landed = landed_hud.find("1");
    assert(landing && landed && landing->size > landed->size && landing->color[3] < landed->color[3]);
    // "1" holds until the room's GO, with no explainer; no banner while the map is changing.
    hud = draw(modes, 9500, stack(false, false));
    assert(hud.find("1") && !hud.find("Room race") && !hud.find("Waiting for GO"));
    auto live = countdown;
    live["state"] = "live";
    modes.event(event(live), "bhop_eazy", false, 9000);
    hud = draw(modes, 9200);
    assert(hud.find("GO") && hud.find("00:00.2") && hud.find("0 of 2 finished"));
    assert(!draw(modes, 9700).find("GO"));
    // Reduced motion: GO only fades, it never changes size.
    for (const double at : {9050., 9200., 9400.}) {
        const auto calm = draw(modes, at, stack(true));
        if (const auto *go = calm.find("GO")) assert(go->size == 88);
    }
    // Theme colours (Custom CSS): GO in the accent, numerals and the line in the text colour.
    native::RoomRaceStack themed;
    themed.colors.accent = {0, 0, 1, 1};
    themed.colors.text = {1, 0, 0, 1};
    const auto themed_hud = draw(modes, 9200, themed);
    assert(themed_hud.find("GO")->color[2] == 1 && themed_hud.find("GO")->color[0] == 0);
    assert(themed_hud.find("Room race")->color[0] == 1 && themed_hud.find("Room race")->color[1] == 0);
    auto placed = live;
    placed["racers"][0] = racer("Alice", 1, 3.51);
    modes.event(event(placed), "bhop_eazy", false, 12000);
    hud = draw(modes, 12500);
    assert(hud.find("1st") && hud.find("00:03.510") && hud.find("you ") && hud.find("1 of 2 finished"));
    const auto *place = hud.last("1st");
    // Above the crosshair; under an end card that reaches further down.
    assert(place->y < 450 && place->color[1] == 1 && place->color[0] < .5f);
    const auto under_card = draw(modes, 12500, stack(false, true, 500));
    const auto *under = under_card.last("1st");
    assert(under->y + under->size * (1.3f * 42 / 52 - .73f) >= 516 - .01f);
    // Gone after 2.4 s and its fade.
    hud = draw(modes, 12000 + 2400 + 401);
    assert(std::count_if(hud.drawn.begin(), hud.drawn.end(), [](const Drawn &d) { return d.text == "1st"; }) == 1);
    // Standings: place order, DNFs last, four rows and yours; the winner's time biggest; yours in white.
    native::RoomModes six;
    auto over = race("over");
    over["racers"] = J::array(
            {racer("Alice", 5, 8.904),
             racer("Bob", 2, 6.112),
             racer("Dim", 1, 5.871),
             racer("keyuu", 3, 7.25),
             racer("syl", 4, 8.033),
             racer("leo", nullptr, nullptr, "forfeit")}
    );
    six.event(event(over), "bhop_eazy", false, 20000);
    const auto &standings = six.room_race_display();
    assert(standings.row_count == 5 && standings.rows[0].name.view() == "Dim" && standings.rows[0].top);
    assert(standings.rows[4].me && standings.rows[4].name.view() == "you" && standings.rows[4].place.view() == "5th");
    assert(standings.verdict.view() == "5th of 6" && !standings.won);
    hud = draw(six, 21500);
    const auto *top = hud.find("00:05.871");
    const auto *mine = hud.find("00:08.904");
    const auto *second = hud.find("00:06.112");
    assert(top && mine && second && top->size > second->size && mine->color[3] == 1 && second->color[3] < 1);
    // Times line up on their right edge; places on theirs.
    assert(std::abs((top->x + top->text.size() * top->size * .6f) - (mine->x + mine->text.size() * mine->size * .6f))
           < .01f);
    assert(hud.find("5th of 6") && !hud.find("leo"));
    assert(native::room_race_result_bottom(standings, 900, 21500) > 150);
    assert(native::room_race_result_bottom(standings, 900, 28001) == 0);
    // Verdicts.
    auto won = over;
    won["racers"] = J::array({racer("Alice", 1, 3.5), racer("Bob", 2, 4.)});
    native::RoomModes winner;
    winner.event(event(won), "bhop_eazy", false, 20000);
    assert(winner.room_race_display().verdict.view() == "You won" && winner.room_race_display().won);
    const auto winner_hud = draw(winner, 21500);
    assert(winner_hud.find("00:03.500")->color[0] < .5f);
    auto dnf = over;
    dnf["racers"] = J::array({racer("Alice", nullptr, nullptr, "left"), racer("Bob", 1, 4.)});
    native::RoomModes left;
    left.event(event(dnf), "bhop_eazy", false, 20000);
    assert(left.room_race_display().verdict.view() == "You didn't finish");
    assert(left.room_race_display().rows[1].place.view() == "DNF"
           && left.room_race_display().rows[1].time.view() == "left");
    auto cancelled = race("over");
    cancelled["outcome"] = "cancelled";
    native::RoomModes stopped;
    stopped.event(event(cancelled), "bhop_eazy", false, 20000);
    assert(stopped.room_race_display().verdict.view() == "Race cancelled");
    assert(stopped.room_race_display().rows[0].time.view() == "no finish");
    auto nobody = race("over");
    native::RoomModes empty;
    empty.event(event(nobody), "bhop_eazy", false, 20000);
    assert(empty.room_race_display().verdict.view() == "Nobody finished");
    // Observers: nothing on screen.
    native::RoomModes observer;
    observer.event(event(race("joining", -1)), "bhop_eazy", false, 1000);
    assert(!observer.room_race_display().visible && draw(observer, 1000).drawn.empty());
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
    racer_visuals();
    std::cout << "Room-race holds, canonical starts, loading, reconnects, observers and results passed\n";
}
