#pragma once
#include "hud.hpp"
#include "room_state.hpp"
#include "room_modes.hpp"
#include "weapon_menu.hpp"
#include <filesystem>
#include <fstream>

namespace native {
// Uses the existing presentation-smoke context. Fixtures never connect to a room or submit a run.
template <class Save>
void hud_parity_smoke(Gl &gl, NativeHud &hud, int width, int height, Save save) {
    const auto clear = [&]() {
        gl.ClearColor(.035f, .04f, .06f, 1);
        gl.Clear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
    };
    HudScoreboard board;
    board.contract(
            {{"head",
              {{"room", "Bunnyhop community"},
               {"map", "bhop_lol_tutorial"},
               {"tier", 7},
               {"timeLeft", "12:34 left"},
               {"max", 16}}},
             {"rows",
              Json::array(
                      {{{"slot", 0},
                        {"you", true},
                        {"name", "Bunny"},
                        {"country", "US"},
                        {"style", "autohop"},
                        {"rank", {{"name", "Gold"}, {"color", "#ffc53d"}}},
                        {"status", "00:16.731"},
                        {"statusKind", "finished"},
                        {"pb", 16.731},
                        {"ping", 28u},
                        {"host", true},
                        {"nameColor", "rose"},
                        {"nameColor2", "aqua"},
                        {"nameEffect", "paint"},
                        {"supporter", true},
                        {"verified", true},
                        {"special", {"mapper"}}},
                       {{"slot", 1},
                        {"name", "Runner"},
                        {"country", "GB"},
                        {"style", "scroll"},
                        {"status", "00:20.170"},
                        {"statusKind", "running"},
                        {"pb", 18.421},
                        {"ping", 42u},
                        {"nameColor", "aqua"},
                        {"nameEffect", "glow"},
                        {"booster", true}},
                       {{"slot", 2},
                        {"name", "観戦者"},
                        {"country", "JP"},
                        {"status", "SPEC -> Bunny"},
                        {"statusKind", "spec"},
                        {"style", "autohop"}}}
              )}}
    );
    const Json host_marks = Json::array(
            {{{"id", "contributor"}, {"name", "Contributor"}},
             {{"id", "verified"}, {"name", "Verified"}},
             {{"id", "supporter"}, {"name", "Supporter"}},
             {{"id", "gifter-prism"},
              {"name", "Prism Gifter"},
              {"colors", {"#ffa8cb", "#6ff0f0", "#a8b8ff"}},
              {"animated", true}}}
    );
    board.rows[0].look =
            host_name_appearance({{"color", "#ffa8cb"}, {"color2", "#6ff0f0"}, {"effect", "paint"}}, host_marks);
    for (float percent : {50.f, 100.f, 175.f}) {
        clear();
        draw_scoreboard(hud, width, height, percent, board, 1, 0);
        HudLabel<64> name;
        name.format("ws4-scoreboard-%d", int(percent));
        save(name.view());
    }
    Chat chat;
    chat.active = true;
    const std::array<Json, 3> looks = {
            Json{{"nativeNameColor", "#ffa8cb"},
                 {"nativeNameColor2", "#6ff0f0"},
                 {"nativeNameEffect", "paint"},
                 {"nativeCountry", "US"},
                 {"nativeBadge", "Verified Supporter Mapper"}},
            Json{{"nativeNameColor", "#6ff0f0"},
                 {"nativeNameEffect", "glow"},
                 {"nativeCountry", "GB"},
                 {"nativeBadge", "Booster"}},
            Json{{"nativeNameColor", "#a8b8ff"}, {"nativeNameEffect", "sparkle"}, {"nativeCountry", "JP"}}
    };
    for (size_t i = 0; i < looks.size(); ++i)
        chat.push(
                "Finished in 16.731 | https://bunnyhop.lol/u/bunny",
                i == 0 ? "Bunny" : "Runner",
                "player",
                1,
                60,
                chat_decoration(looks[i])
        );
    chat.push(
            "Merged menu name and ordered marks",
            "Contributor",
            "player",
            1,
            60,
            chat_decoration(
                    {{"nativeName", {{"color", "#ffa8cb"}, {"color2", "#6ff0f0"}, {"effect", "paint"}}},
                     {"nativeMarks", host_marks},
                     {"nativeCountry", "ca"},
                     {"nativeRank", "Gold"},
                     {"nativeRankColor", "#ffc53d"}}
            )
    );
    clear();
    hud.draw_chat_overlay(width, height, chat.visible(2), "", "", {}, true, 0, 100, &chat, chat.viewport(2));
    save("ws4-chat");
    HudResult result;
    result.restart_bind("KeyR");
    result.finish(1, 16.731, 1, 17.421, true);
    clear();
    draw_result(hud, width, height, 100, result, 3.5);
    save("ws4-result-pending");
    result.service(
            {{"generation", 1},
             {"status", "verified"},
             {"announcer", "wr"},
             {"rank", 1u},
             {"rewards", Json::array({{{"title", "+120 XP"}, {"detail", "Level 12 | New hat unlocked"}}})}},
            1,
            3.2
    );
    clear();
    draw_result(hud, width, height, 100, result, 3.5);
    save("ws4-result-wr-reel");
    const auto rasterizations = hud.rasterizations();
    clear();
    draw_result(hud, width, height, 100, result, 3.5);
    if (hud.rasterizations() != rasterizations)
        throw std::runtime_error("Unchanged result strings were rasterized again");
    clear();
    RoomState room;
    room.vote = {
            {"options", {{{"map", "bhop_boxes_snowy"}}, {{"map", "bhop_japan"}}, {{"extend", true}, {"minutes", 10}}}},
            {"counts", Json::array({5u, 3u, 1u})},
            {"endsAt", 14000}
    };
    room.refresh_vote();
    room.voted(1);
    draw_vote(hud, width, height, 100, room.vote_display, 2000);
    RaceDisplay race;
    race.state = RaceDisplay::State::challenge;
    race.recipient = true;
    race.opponent.assign("Bunny");
    race.board.assign("Autohop | Main track");
    race.deadline = 14000;
    draw_race(hud, width, height, 100, race, 2000);
    save("ws4-vote-race");
    Toasts toasts;
    toasts.push("New hat unlocked", 1, 5, ToastTone::unlock, "Level 12");
    toasts.push("Bunny: ready for another race?", 1, 5, ToastTone::whisper);
    clear();
    draw_toasts(hud, width, height, 100, toasts, 2);
    hud.overlay_begin(width, height);
    float top = 270;
    for (std::string_view preset : {"beginner", "standard", "strict"}) {
        const auto settings = patch_settings(default_settings(), trainer_preset(preset));
        const auto preferences = HudPreferences::from(settings);
        draw_trainer(hud, 600, top, {108, StrafeHint::strafe_more}, preferences.trainer, true, preferences.palette, -1);
        top += 110;
    }
    hud.overlay_end(width, height);
    save("ws4-toasts-trainers");
    NativeTriggerMenu trigger_menu;
    trigger_menu.toggle();
    clear();
    trigger_menu.draw(hud, width, height, 100, true, false);
    save("ws4-trigger-menu");
    auto preferences = default_settings();
    preferences["hudMovementLj"] = true;
    for (const char *id : {"startPre", "strafeOffsets", "firstJump", "longJump", "sync", "ghostKeys"})
        preferences["hudLayout"][id] = {{"a", 4}, {"x", 0}, {"y", -.12}, {"s", 1}, {"on", true}};
    preferences["hudLayout"]["startPre"]["x"] = -.16;
    preferences["hudLayout"]["startPre"]["y"] = .3;
    preferences["hudLayout"]["strafeOffsets"]["y"] = -.25;
    preferences["hudLayout"]["firstJump"]["y"] = -.21;
    preferences["hudLayout"]["longJump"]["y"] = -.33;
    preferences["hudLayout"]["sync"]["y"] = .44;
    preferences["hudLayout"]["ghostKeys"]["x"] = .30;
    preferences["hudLayout"]["ghostKeys"]["y"] = .25;
    hud.extras.contract(
            {{"pbTimeMs", 16731},
             {"spectators", {"Watcher", "Bunny"}},
             {"ghostButtons", left | jump},
             {"ghostDelta", -.042}}
    );
    hud.movement.start_pre.assign("Start Pre 280");
    hud.movement.offset.assign("Offset -1 (key early)");
    hud.movement.first_jump.assign("FJT 0 ticks (0 ms)");
    hud.movement.long_jump.assign("LJ 275.50");
    hud.movement.long_jump_details.assign("280 pre | 345 max | 6 str | 94% sync");
    BhSnapshot snapshot{};
    snapshot.health = 100;
    snapshot.player.velocity[0] = 645;
    BhRunState run{};
    run.status = 1;
    run.track = 1;
    run.split_count = 3;
    run.seconds = 16.731;
    run.jumps = 6;
    run.strafes = 28;
    run.sync_percent = 94.2;
    BhCmd command{};
    command.buttons = forward | left | jump;
    hud.command_tick(command, 1);
    for (std::string_view style : {"classic", "keycaps", "minimal"}) {
        preferences["keysStyle"] = style;
        hud.preferences(preferences);
        clear();
        hud.draw(
                width,
                height,
                snapshot,
                run,
                command,
                "bhop_lol_tutorial",
                "autohop",
                "",
                500,
                true,
                true,
                false,
                BhWeaponReport{},
                "Jump 6 | 645 u/s (+87)\nGain 87.5% | Sync 94% | 6 str"
        );
        HudLabel<64> filename;
        filename.assign("ws4-hud-");
        filename.append(style);
        save(filename.view());
    }
    clear();
    hud.draw(
            width,
            height,
            snapshot,
            run,
            command,
            "bhop_lol_tutorial",
            "autohop",
            "",
            500,
            false,
            false,
            false,
            BhWeaponReport{}
    );
    save("ws4-hidden-speed-keys");
    preferences["hudHiddenKeeps"] = "nothing";
    hud.preferences(preferences);
    clear();
    hud.draw(
            width,
            height,
            snapshot,
            run,
            command,
            "bhop_lol_tutorial",
            "autohop",
            "",
            500,
            false,
            false,
            false,
            BhWeaponReport{}
    );
    save("ws4-hidden-nothing");
    hud.preferences(default_settings());
}

inline void hud_parity_smoke(Gl &gl, NativeHud &hud, int width, int height, const std::filesystem::path &output) {
    hud_parity_smoke(gl, hud, width, height, [&](std::string_view name) {
        const auto bytes = backbuffer_png(gl, width, height);
        std::ofstream file(output / (std::string(name) + ".png"), std::ios::binary);
        file.write(bytes.data(), bytes.size());
        if (!file || bytes.empty() || gl.GetError() != GL_NO_ERROR)
            throw std::runtime_error("HUD smoke screenshot failed");
    });
}
}  // namespace native
