#pragma once
#include "hud.hpp"
#include "room_state.hpp"
#include "room_modes.hpp"
#include "weapon_menu.hpp"
#include <filesystem>
#include <fstream>

namespace native {
// The timer, speed, FPS and run stats change every frame while running. Once each digit has
// been drawn, new values must not reach the system rasterizer.
inline void numeric_hud_smoke(NativeHud &hud, int width, int height) {
    constexpr int frames_per_pass = 120;
    BhSnapshot snapshot{};
    snapshot.health = 100;
    BhRunState run{};
    run.status = 1;
    BhCmd command{};
    const auto draw_frames = [&](int first_frame) {
        for (int frame = first_frame; frame < first_frame + frames_per_pass; ++frame) {
            snapshot.player.velocity[0] = 250.f + float(frame) * 7.3f;
            snapshot.player.tick = uint32_t(frame);
            run.seconds = double(frame) * .0137;
            run.jumps = uint32_t(frame / 9);
            run.strafes = uint32_t(frame / 4);
            run.sync_percent = 80 + double(frame % 200) * .1;
            hud.draw(
                    width,
                    height,
                    snapshot,
                    run,
                    command,
                    "bhop_lol_tutorial",
                    "autohop",
                    "",
                    900.f + float(frame),
                    true,
                    true,
                    false,
                    BhWeaponReport{}
            );
        }
    };
    draw_frames(0);
    const auto warmed = hud.rasterizations();
    draw_frames(frames_per_pass);
    if (hud.rasterizations() != warmed) throw std::runtime_error("Changing HUD numbers were rasterized again");
}

// Every gameplay element with something to show, as in a start zone or mid-run with the strafe trainer, jump stats,
// keys, splits and chat on. Shared by the layout check below and the presentation smoke's screenshots.
struct HudLayoutFixture {
    bool running = false;
    float percent = 100;
};

inline Json hud_layout_fixture_settings(float percent) {
    auto settings = default_settings();
    settings["hudScale"] = percent;
    settings["jumpStats"] = true;
    settings["strafeTrainer"] = true;
    settings["strafeTrainerHints"] = true;
    settings["speedGraph"] = true;
    settings["hudPlace"] = "top";
    auto &layout = settings["hudLayoutWeb"];
    for (const char *id : {"fps", "graph", "jumpStats", "strafeTrainer", "sync"})
        layout[id]["on"] = true;
    return settings;
}

inline void
draw_hud_layout_fixture(NativeHud &hud, Chat &chat, int width, int height, const HudLayoutFixture &fixture) {
    hud.preferences(hud_layout_fixture_settings(fixture.percent));
    hud.extras.contract(
            {{"pbTimeMs", 16731}, {"place", 4u}, {"topPercent", 3}, {"spectators", {"Watcher"}}, {"ghostDelta", -.042}}
    );
    BhSnapshot snapshot{};
    snapshot.health = 100;
    BhRunState run{};
    run.track = fixture.running ? 1 : 0;
    run.in_start = fixture.running ? 0 : 1;
    run.status = fixture.running ? 1 : 0;
    BhCmd command{};
    if (fixture.running) {
        constexpr uint32_t graph_ticks = 250;
        for (uint32_t tick = 1; tick <= graph_ticks; ++tick) {
            BhState state{};
            state.tick = tick;
            state.velocity[0] = 400 + float(tick) * 2.5f;
            hud.tick(state);
        }
        snapshot.player.velocity[0] = 1045;
        run.seconds = 3599.731;
        run.split_count = 12;
        run.jumps = 106;
        run.strafes = 228;
        run.sync_percent = 94.2;
        command.buttons = forward | left | jump;
        hud.set_run_comparison("Split 12  3599.731s", "");
    } else {
        hud.set_run_comparison("", "");
    }
    hud.command_tick(command, 1);
    BhWeaponReport weapon{};
    weapon.clip = 12;
    weapon.clip_size = 36;
    const std::string_view jump_stats =
            fixture.running ? "Jump 6 | 1045 u/s (+87)\nGain 87.5%  Sync 94%  6 str  Eff 91%" : std::string_view();
    const auto strafe =
            fixture.running ? std::optional<StrafeReading>(StrafeReading{108, StrafeHint::strafe_less}) : std::nullopt;
    hud.draw(
            width,
            height,
            snapshot,
            run,
            command,
            "bhop_lol_hermes_v2_final",
            "autohop",
            "",
            1000,
            true,
            true,
            false,
            weapon,
            jump_stats,
            87.5f,
            strafe,
            true,
            nullptr,
            fixture.percent
    );
    hud.draw_chat_overlay(
            width, height, chat.visible(2), "", "", {}, false, 0, fixture.percent, &chat, chat.viewport(2)
    );
}

// Fails when two elements overlap or one leaves the screen, at the sizes and HUD scales players use (2560x1441 is a
// Windows borderless window). Boxes touching at their shadows are allowed.
inline void hud_layout_smoke(NativeHud &hud) {
    constexpr std::array<std::array<int, 2>, 4> sizes = {{{2560, 1441}, {1920, 1080}, {1280, 720}, {746, 997}}};
    constexpr std::array<float, 3> percents = {75, 100, 150};
    constexpr float shadow_px = 2;
    Chat chat;
    for (const auto *line : {"Bunny: gg", "Runner: one more", "Watcher: nice route through the second room"})
        chat.push(line, "", "player", 1, 60);
    for (const auto [width, height] : sizes) {
        for (const float percent : percents) {
            for (const bool running : {false, true}) {
                draw_hud_layout_fixture(hud, chat, width, height, {running, percent});
                std::array<std::string_view, hud_ids.size() + 1> ids{};
                std::copy(hud_ids.begin(), hud_ids.end(), ids.begin());
                ids.back() = "boardPlace";
                for (size_t a = 0; a < ids.size(); ++a) {
                    const auto &box = hud.drawn_bounds(ids[a]);
                    if (box.width <= 0 || canonical_hud_id(ids[a]) != ids[a]) continue;
                    if (box.x < 0 || box.y < 0 || box.x + box.width > float(width) + shadow_px
                        || box.y + box.height > float(height) + shadow_px)
                        throw std::runtime_error("HUD element leaves the screen: " + std::string(ids[a]));
                    for (size_t b = a + 1; b < ids.size(); ++b) {
                        const auto &other = hud.drawn_bounds(ids[b]);
                        if (other.width <= 0 || canonical_hud_id(ids[b]) != ids[b]) continue;
                        const bool apart = box.x + box.width <= other.x + shadow_px
                                           || other.x + other.width <= box.x + shadow_px
                                           || box.y + box.height <= other.y + shadow_px
                                           || other.y + other.height <= box.y + shadow_px;
                        if (!apart)
                            throw std::runtime_error(
                                    "HUD elements overlap at " + std::to_string(width) + "x" + std::to_string(height)
                                    + " " + std::to_string(int(percent)) + "%: " + std::string(ids[a]) + " and "
                                    + std::string(ids[b])
                            );
                    }
                }
            }
        }
    }
    hud.preferences(default_settings());
    hud.reset_history();
}

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
        name.format("hud-scoreboard-%d", int(percent));
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
    save("hud-chat");
    HudResult result;
    result.restart_bind("KeyR");
    result.finish(1, 16.731, 1, 17.421, true);
    clear();
    draw_result(hud, width, height, 100, result, 3.5);
    save("hud-result-pending");
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
    save("hud-result-wr-reel");
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
    save("hud-vote-race");
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
        draw_trainer(hud, 600, top, {108, StrafeHint::strafe_more}, preferences.trainer, true, preferences.palette);
        top += 110;
    }
    hud.overlay_end(width, height);
    save("hud-toasts-trainers");
    NativeTriggerMenu trigger_menu;
    trigger_menu.toggle();
    clear();
    trigger_menu.draw(hud, width, height, 100, true, false);
    save("hud-trigger-menu");
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
        filename.assign("hud-");
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
    save("hud-hidden-speed-keys");
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
    save("hud-hidden-nothing");
    hud.preferences(default_settings());
    numeric_hud_smoke(hud, width, height);
    hud_layout_smoke(hud);
    Chat layout_chat;
    layout_chat.push("Bunny: gg", "", "player", 1, 60);
    for (const float percent : {75.f, 100.f, 150.f}) {
        for (const bool running : {false, true}) {
            clear();
            draw_hud_layout_fixture(hud, layout_chat, width, height, {running, percent});
            HudLabel<64> name;
            name.format("hud-layout-%s-%d", running ? "run" : "start", int(percent));
            save(name.view());
        }
    }
    hud.preferences(default_settings());
    hud.reset_history();
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
