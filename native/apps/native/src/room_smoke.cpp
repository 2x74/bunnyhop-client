// Room evidence: replays a recorded room session (the menu's host messages, one JSON object per line) into the room
// state, chat and scoreboard over a loaded map, and saves the frames listed in the shot file. The recording comes from
// a local server; nothing here opens a socket or submits anything.
// A shot can also draw the spectator bar ("spectating": "eye", "chase" or "free", with "spectateMenu") and the run
// HUD with freecam's line ("freecam"). Recorded race and room-race events draw as the client draws them; a shot can add
// the run's end card ("endcard": run seconds, "endcardAt": when it came up, in recording ms), "reducedMotion", the run
// HUD ("runHud") and the !copystart menu ("copyStartMenu").
#include "client_smoke.hpp"
#include "options.hpp"
#include "game_session.hpp"
#include "renderer.hpp"
#include "hud.hpp"
#include "room_state.hpp"
#include "room_modes.hpp"
#include "hud_result.hpp"
#include "copy_start_picker.hpp"
#include "native_chat.hpp"
#include "menu_backdrop.hpp"
#include "free_cameras.hpp"
#include "settings.hpp"
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
    // Watching the room's spectator target: "eye", "chase" or "free" draws the spectator bar for that camera.
    std::string spectating;
    bool spectate_menu = false, freecam = false;
    std::optional<double> endcard;
    double endcard_at = 0;
    bool reduced_motion = false, run_hud = false, copy_start_menu = false;
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
        shot.spectating = item.value("spectating", std::string());
        shot.spectate_menu = item.value("spectateMenu", false);
        shot.freecam = item.value("freecam", false);
        if (item.contains("endcard")) shot.endcard = item.at("endcard").get<double>();
        shot.endcard_at = item.value("endcardAt", 0.) / 1000;
        shot.reduced_motion = item.value("reducedMotion", false);
        shot.run_hud = item.value("runHud", false);
        shot.copy_start_menu = item.value("copyStartMenu", false);
        shots.push_back(std::move(shot));
    }
    return shots;
}

// The room as the host would hold it after the recorded messages up to some time.
class RoomReplay {
public:
    RoomState room;
    RoomModes modes;
    Chat chat;
    double epoch_offset_ms = 0;

    RoomReplay(std::vector<RecordedMessage> messages, std::string map)
        : messages_(std::move(messages))
        , map_(std::move(map)) {}

    void advance(double until) {
        for (; next_ < messages_.size() && messages_[next_].at <= until; ++next_)
            apply(messages_[next_]);
    }

    double epoch_ms(double at) const { return epoch_offset_ms + at * 1000; }

private:
    std::vector<RecordedMessage> messages_;
    std::string map_;
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
            modes.event(message, map_, false, epoch_ms(recorded.at));
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

const BindTable &default_binds() {
    static const BindTable binds = [] {
        BindTable table;
        table.rebuild(default_settings().at("binds"));
        return table;
    }();
    return binds;
}

// The spectator bar (and the N menu) as the client draws them while watching with the shot's camera.
void draw_spectating(NativeHud &hud, int width, int height, const RoomShot &shot, RoomState &room, double at) {
    Input input;
    std::set<std::string> held;
    InputTimeline timeline;
    const FreeLookInput controls{timeline, input, held};
    SpectatorView view;
    if (shot.spectating == "chase") view.toggle_chase(controls);
    if (shot.spectating == "free") view.toggle_free(controls);
    const auto target = room.spectator_target.value_or(256);
    const bool shown = room.spectated(at).has_value();
    const SpectatorBar bar{
            true,
            !shown,
            room.player_name(target),
            view.hint("KeyR", default_binds()),
            watched_name_look(room.appearance(target), target),
            at
    };
    draw_spectator_bar(hud, width, height, 100, bar);
    if (!shot.spectate_menu) return;
    SpectatePicker picker;
    picker.show(room.display(), room.spectator_target);
    picker.draw(hud, width, height, 100);
}

// The run HUD with freecam's line in the practice slot.
void draw_freecam_hud(NativeHud &hud, int width, int height, const std::string &map, const BhSnapshot &snapshot) {
    Freecam freecam;
    hud.extras.freecam_line.assign(freecam.hud_line(""));
    hud.draw(width, height, snapshot, BhRunState{}, BhCmd{}, map, "autohop", "", 0, true, false, false, {});
    hud.extras.freecam_line.assign("");
}

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
    if (shot.freecam) draw_freecam_hud(frame.hud, frame.width, frame.height, frame.game.map_id, snapshot);
    if (shot.run_hud)
        frame.hud.draw(
                frame.width,
                frame.height,
                snapshot,
                BhRunState{},
                BhCmd{},
                frame.game.map_id,
                "autohop",
                "",
                0,
                true,
                true,
                false,
                {}
        );
    if (!shot.spectating.empty()) draw_spectating(frame.hud, frame.width, frame.height, shot, frame.replay.room, at);
    if (shot.copy_start_menu) {
        CopyStartPicker picker;
        picker.show(frame.replay.room.display());
        picker.draw(frame.hud, frame.width, frame.height, 100, std::nullopt);
    }
    auto &modes = frame.replay.modes;
    modes.room_race_tick(epoch_ms);
    const HudGeometry geometry(frame.width, frame.height, 100);
    const auto &standings = modes.room_race_display();
    const float race_bottom = room_race_result_bottom(standings, geometry.height, epoch_ms);
    auto &result = frame.hud.result;
    result.reset();
    if (shot.endcard) {
        result.finish(1, *shot.endcard, shot.endcard_at, std::nullopt, false);
        result.status_line.assign("Rank #3");
        draw_result(frame.hud, frame.width, frame.height, 100, result, at, race_bottom);
    }
    draw_race(frame.hud, frame.width, frame.height, 100, modes.display(), epoch_ms);
    if (modes.display().state == RaceDisplay::State::none)
        draw_room_race(
                frame.hud,
                frame.width,
                frame.height,
                100,
                standings,
                epoch_ms,
                {shot.reduced_motion,
                 true,
                 result_bottom(geometry, result, at, race_bottom),
                 room_race_colors(frame.hud)}
        );
}

}  // namespace

int run_room_smoke(const Options &opt, SDL_Window *window, Gl &gl, GameSession &game, NativeHud &hud) {
    if (!game.renderer || !game.core) throw std::runtime_error("Room smoke requires a local map");
    bh_record_end(game.core.get());
    const std::filesystem::path directory = opt.room_smoke;
    RoomReplay replay(read_recording(directory / "room.jsonl"), game.map_id);
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
