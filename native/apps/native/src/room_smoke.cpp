// Room evidence: replays a recorded room session (the menu's host messages, one JSON object per line) into the room
// state, chat and scoreboard over a loaded map, and saves the frames listed in the shot file. The recording comes from
// a local server; nothing here opens a socket or submits anything.
#include "client_smoke.hpp"
#include "options.hpp"
#include "game_session.hpp"
#include "renderer.hpp"
#include "hud.hpp"
#include "room_state.hpp"
#include "native_chat.hpp"
#include "menu_backdrop.hpp"
#include <SDL3/SDL.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace native {
namespace {

constexpr double frame_seconds = 1. / 60;
constexpr double warm_up_seconds = 1.5;
constexpr double chat_lifetime_seconds = 3600;

struct RecordedMessage {
    double at = 0;
    nlohmann::json message;
};

struct RoomShot {
    std::string name;
    double at = 0;
    std::array<float, 3> eye{};
    float yaw = 0, pitch = 0;
    bool scoreboard = false, chat = false, tags = true;
};

std::vector<RecordedMessage> read_recording(const std::filesystem::path &path) {
    std::ifstream file(path);
    if (!file) throw std::runtime_error("Room smoke: cannot read " + path.string());
    std::vector<RecordedMessage> out;
    std::string line;
    while (std::getline(file, line)) {
        if (line.empty()) continue;
        const auto value = nlohmann::json::parse(line);
        out.push_back({value.at("at").get<double>() / 1000, value.at("m")});
    }
    return out;
}

std::vector<RoomShot> read_shots(const std::filesystem::path &path) {
    std::ifstream file(path);
    if (!file) throw std::runtime_error("Room smoke: cannot read " + path.string());
    const auto value = nlohmann::json::parse(file);
    std::vector<RoomShot> shots;
    for (const auto &item : value) {
        RoomShot shot;
        shot.name = item.at("name").get<std::string>();
        shot.at = item.at("at").get<double>() / 1000;
        shot.eye = item.at("eye").get<std::array<float, 3>>();
        shot.yaw = item.value("yaw", 0.f);
        shot.pitch = item.value("pitch", 0.f);
        shot.scoreboard = item.value("scoreboard", false);
        shot.chat = item.value("chat", false);
        shot.tags = item.value("tags", true);
        shots.push_back(std::move(shot));
    }
    return shots;
}

// The room as the host would hold it after the recorded messages up to some time.
class RoomReplay {
public:
    RoomState room;
    Chat chat;
    double epoch_offset_ms = 0;

    explicit RoomReplay(std::vector<RecordedMessage> messages) : messages_(std::move(messages)) {}

    void advance(double until) {
        for (; next_ < messages_.size() && messages_[next_].at <= until; ++next_)
            apply(messages_[next_]);
    }

    double epoch_ms(double at) const { return epoch_offset_ms + at * 1000; }

private:
    std::vector<RecordedMessage> messages_;
    size_t next_ = 0;

    void apply(const RecordedMessage &recorded) {
        const auto &message = recorded.message;
        const auto type = message.value("type", std::string());
        if (type == "roomEvent") {
            const auto &event = message.at("event");
            if (event.value("t", std::string()) == "welcome" && event.contains("now"))
                epoch_offset_ms = event.at("now").get<double>() - recorded.at * 1000;
            room.event(message);
            room.refresh_display(recorded.at);
        } else if (type == "roomSnapshot") {
            room.snapshot(message, recorded.at);
            room.refresh_display(recorded.at);
        } else if (type == "scoreboard") {
            room.display_contract(message);
        } else if (type == "chatLine") {
            chat.push(
                    message.at("text").get<std::string>(),
                    message.value("name", std::string()),
                    message.value("kind", std::string()),
                    epoch_ms(recorded.at) / 1000,
                    chat_lifetime_seconds,
                    chat_decoration(message)
            );
        }
    }
};

struct RoomSmokeFrame {
    Gl &gl;
    GameSession &game;
    NativeHud &hud;
    RoomReplay &replay;
    NameTagSights &sights;
    int width = 0, height = 0;
};

void draw_room_frame(RoomSmokeFrame &frame, const RoomShot &shot, double at, BhSnapshot &snapshot) {
    auto &renderer = *frame.game.renderer;
    auto actors = frame.replay.room.actors(at);
    Input input;
    input.set_angles(shot.pitch, shot.yaw);
    renderer.set_viewmodel_visible(false);
    renderer.set_room_actors(actors);
    renderer.draw(frame.width, frame.height, shot.eye.data(), input, &snapshot, at);
    const auto matrix = renderer.camera(shot.eye.data(), shot.yaw, shot.pitch, float(frame.width) / frame.height);
    frame.sights.begin(at, shot.eye.data());
    if (shot.tags)
        draw_name_tags(
                frame.hud,
                frame.width,
                frame.height,
                100,
                matrix.data(),
                actors,
                frame.replay.room,
                frame.sights,
                true,
                true,
                false,
                NameTagTrace{frame.game.core.get(), shot.eye.data()},
                at,
                renderer.output_view(frame.width, frame.height)
        );
    const double epoch_ms = frame.replay.epoch_ms(at);
    if (shot.chat) {
        auto &chat = frame.replay.chat;
        const double now = epoch_ms / 1000;
        frame.hud.draw_chat_overlay(
                frame.width, frame.height, chat.visible(now), "", "", {}, false, 0, 100, &chat, chat.viewport(now)
        );
    }
    if (shot.scoreboard)
        draw_scoreboard(frame.hud, frame.width, frame.height, 100, frame.replay.room.display(), at, epoch_ms);
}

}  // namespace

int run_room_smoke(const Options &opt, SDL_Window *window, Gl &gl, GameSession &game, NativeHud &hud) {
    if (!game.renderer || !game.core) throw std::runtime_error("Room smoke requires a local map");
    bh_record_end(game.core.get());
    const std::filesystem::path directory = opt.room_smoke;
    RoomReplay replay(read_recording(directory / "room.jsonl"));
    NameTagSights sights;
    RoomSmokeFrame frame{gl, game, hud, replay, sights};
    SDL_GetWindowSizeInPixels(window, &frame.width, &frame.height);
    BhSnapshot snapshot{};
    if (!bh_snapshot(game.core.get(), &snapshot)) throw std::runtime_error("Room smoke: no snapshot");
    nlohmann::json evidence = nlohmann::json::array();
    for (const auto &shot : read_shots(directory / "shots.json")) {
        // Frames leading up to the shot, so interpolation, poses and fades settle as they would live.
        for (double at = std::max(0., shot.at - warm_up_seconds); at <= shot.at; at += frame_seconds) {
            replay.advance(at);
            draw_room_frame(frame, shot, at, snapshot);
        }
        const auto png = backbuffer_png(gl, frame.width, frame.height, 64u * 1024u * 1024u);
        if (png.empty()) throw std::runtime_error("Room smoke: empty screenshot");
        const auto path = directory / (shot.name + ".png");
        std::ofstream file(path, std::ios::binary);
        file.write(png.data(), std::streamsize(png.size()));
        if (!file) throw std::runtime_error("Room smoke: writing " + path.string());
        evidence.push_back(
                {{"shot", shot.name}, {"image", path.string()}, {"actors", replay.room.actors(shot.at).size()}}
        );
    }
    std::cout << evidence.dump() << '\n';
    return 0;
}

}  // namespace native
