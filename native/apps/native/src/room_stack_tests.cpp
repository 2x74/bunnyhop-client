#include "room_state.hpp"
#include <cassert>
#include <fstream>
#include <iostream>
#include <string>
#ifdef _WIN32
#include <windows.h>
#else
#include <pthread.h>
#endif

using Json = nlohmann::json;

namespace {
constexpr size_t thread_stack_bytes = 1024 * 1024;
// v0.8.1's Windows run() frame reserves 729192 bytes, including its inline room.
// Model the other live subsystems while dispatching on the original 1 MiB stack.
constexpr size_t other_client_stack_bytes = 400 * 1024;
constexpr size_t page_bytes = 4096;
const char *recording_path = nullptr;

#if defined(_MSC_VER)
#define ROOM_NOINLINE __declspec(noinline)
#else
#define ROOM_NOINLINE __attribute__((noinline))
#endif

ROOM_NOINLINE void dispatch(native::RoomState &room, const Json &message, double now) {
    const auto type = message.value("type", std::string());
    if (type == "roomEvent") {
        room.event(message);
        room.refresh_display(now);
    } else if (type == "roomSnapshot") {
        room.snapshot(message, now);
        room.refresh_display(now);
    } else if (type == "scoreboard" || type == "roomScoreboard") {
        room.display_contract(message);
    }
}

Json envelope(Json event) {
    return {{"type", "roomEvent"}, {"generation", 1}, {"id", "easy"}, {"event", std::move(event)}};
}

void join_and_update(native::RoomState &room) {
    Json players = Json::array();
    Json rows = Json::array();
    constexpr unsigned player_count = 64;
    for (unsigned slot = 0; slot < player_count; ++slot) {
        const auto name = "Player " + std::to_string(slot);
        players.push_back({{"slot", slot}, {"name", name}, {"spec", nullptr}, {"loadout", nullptr}});
        rows.push_back({{"slot", slot}, {"name", name}, {"rank", nullptr}, {"pb", nullptr}, {"ping", nullptr}});
    }
    dispatch(
            room,
            envelope(
                    {{"t", "welcome"},
                     {"you", 0},
                     {"room", {{"name", "Easy"}}},
                     {"map", {{"name", "bhop_mixtape"}}},
                     {"players", players}}
            ),
            1
    );
    assert(room.id == "easy" && room.display().count == player_count);
    Json board = {
            {"type", "scoreboard"},
            {"generation", 1},
            {"id", "easy"},
            {"head", {{"room", "Easy"}, {"map", "bhop_mixtape"}, {"max", 20}}},
            {"rows", rows}
    };
    dispatch(room, board, 1);
    assert(room.display().count == player_count && room.display().head.room == "Easy");
    dispatch(
            room,
            {{"type", "roomSnapshot"}, {"generation", 1}, {"id", "easy"}, {"snapshot", {{"blocks", Json::array()}}}},
            2
    );
    board["rows"][0]["name"] = "Renamed";
    dispatch(room, board, 2);
    assert(room.player_name(0) == "Player 0");
    bool renamed = false;
    for (size_t i = 0; i < room.display().count; ++i)
        renamed |= room.display().rows[i].name == "Renamed";
    assert(renamed);
    dispatch(room, envelope({{"t", "nativeLeave"}}), 3);
    assert(room.id.empty() && room.display().count == 0);
    dispatch(room, {{"type", "scoreboard"}, {"head", nullptr}, {"rows", Json::array()}}, 3);
    assert(room.display().count == 0);
}

ROOM_NOINLINE void replay_on_small_stack() {
    native::RoomState room;
    volatile unsigned char other_client_state[other_client_stack_bytes];
    for (size_t i = 0; i < other_client_stack_bytes; i += page_bytes)
        other_client_state[i] = 1;
    join_and_update(room);
    if (recording_path) {
        std::ifstream input(recording_path);
        assert(input);
        room.clear();
        std::string line;
        double now = 4;
        while (std::getline(input, line)) {
            dispatch(room, Json::parse(line), now);
            now += .01;
        }
    }
    for (size_t i = 0; i < other_client_stack_bytes; i += page_bytes)
        assert(other_client_state[i] == 1);
}

#ifdef _WIN32
DWORD WINAPI thread_entry(void *) {
    replay_on_small_stack();
    return 0;
}
#else
void *thread_entry(void *) {
    replay_on_small_stack();
    return nullptr;
}
#endif
}  // namespace

int main(int argc, char **argv) {
    if (argc > 1) recording_path = argv[1];
#ifdef _WIN32
    const HANDLE thread = CreateThread(
            nullptr, thread_stack_bytes, thread_entry, nullptr, STACK_SIZE_PARAM_IS_A_RESERVATION, nullptr
    );
    assert(thread);
    assert(WaitForSingleObject(thread, INFINITE) == WAIT_OBJECT_0);
    DWORD result = 1;
    assert(GetExitCodeThread(thread, &result) && result == 0);
    assert(CloseHandle(thread));
#else
    pthread_attr_t attributes;
    assert(pthread_attr_init(&attributes) == 0);
    assert(pthread_attr_setstacksize(&attributes, thread_stack_bytes) == 0);
    pthread_t thread;
    assert(pthread_create(&thread, &attributes, thread_entry, nullptr) == 0);
    assert(pthread_attr_destroy(&attributes) == 0);
    assert(pthread_join(thread, nullptr) == 0);
#endif
    std::cout << "Room join, snapshots and scoreboard replacement passed on a 1 MiB stack\n";
}
