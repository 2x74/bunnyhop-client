#pragma once
#include "hud.hpp"

namespace native {
// Sample values for every HUD element, so the layout editor has something to show, grab and move for each one. Drawn
// with the player's own settings and layout; the real run's values are swapped back in after each frame.
struct HudDemoState {
    HudExtras extras;
    MovementHud movement;
    JhudReadout jhud;
    std::string split_line = "Split 3  16.731s";
    std::string delta_line;
    Chat chat;

    HudDemoState() {
        extras.contract(
                {{"pbTimeMs", 16731},
                 {"place", 4u},
                 {"topPercent", 3},
                 {"spectators", {"Watcher", "Bunny"}},
                 {"ghostButtons", left | jump},
                 {"ghostDelta", -.042}}
        );
        constexpr int demo_speed_difference = 42;
        extras.ghost_speed.show(demo_speed_difference);
        constexpr double demo_tick_interval = .01;
        JhudReport jump;
        jump.jump = 6;
        jump.speed = 624;
        // Reads 84.21, as the website's sample does: the readout cuts digits, and 84.21 is stored a hair under.
        jump.gain = 84.215f;
        jump.sync = 90.5f;
        jump.jss = .98;
        jhud.show(jump, 0, demo_tick_interval);
        movement.start_pre.assign("Start Pre 280");
        movement.offset.assign("Offset -1 (key early)");
        movement.first_jump.assign("FJT 0 ticks (0 ms)");
        movement.long_jump.assign("LJ 254.32");
        movement.long_jump_details.assign("278 pre | 342 max | 6 str | 91% sync");
        constexpr double chat_lifetime_seconds = 1e9;
        chat.push("Bunny: gg", "", "player", 0, chat_lifetime_seconds);
        chat.push("Runner: one more", "", "player", 0, chat_lifetime_seconds);
    }
};

inline void draw_hud_demo(
        NativeHud &hud,
        HudDemoState &demo,
        int width,
        int height,
        float percent,
        const std::string &map,
        const std::string &style,
        double fps
) {
    constexpr float demo_speed = 645;
    BhSnapshot snapshot{};
    snapshot.health = 100;
    snapshot.player.velocity[0] = demo_speed;
    BhRunState run{};
    run.status = 1;
    run.track = 1;
    run.split_count = 3;
    run.seconds = 16.731;
    run.jumps = 6;
    run.strafes = 28;
    run.sync_percent = 94.2;
    BhCmd command{};
    BhWeaponReport weapon{};
    weapon.clip = 12;
    weapon.clip_size = 36;
    const native::Practice practice;
    demo.jhud.configure(hud.preferences().jhud);
    hud.swap_demo(demo);
    hud.draw(
            width,
            height,
            snapshot,
            run,
            command,
            map,
            style,
            "Notices show here",
            fps,
            true,
            true,
            true,
            weapon,
            "Jump 6 | 645 u/s (+87)\nGain 87.5%  Sync 94%  6 str",
            87.5f,
            StrafeReading{108, StrafeHint::strafe_less},
            true,
            nullptr,
            percent,
            &practice
    );
    hud.draw_chat_overlay(width, height, demo.chat.visible(1), "", "", {}, false, 0, percent, &demo.chat, 1);
    hud.swap_demo(demo);
}
}  // namespace native
