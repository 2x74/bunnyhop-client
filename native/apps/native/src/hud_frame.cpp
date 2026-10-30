#include "hud_frame.hpp"
#include "practice_controller.hpp"
#include "mouse_diagnostics.hpp"
#include "diagnostics_report.hpp"
#include "run_timing.hpp"
#include "replay_player.hpp"
#include "room_state.hpp"
#include "room_modes.hpp"
#include "leave_hold.hpp"
#include <chrono>
#include <cstdio>

namespace native {
namespace {

constexpr double nanoseconds_per_second = 1e9;
constexpr float overlay_scale_percent = 100;
constexpr float diagnostic_left_px = 16;
constexpr float diagnostic_text_left_px = 24;
constexpr float mouse_top_px = 40;
constexpr float mouse_text_top_px = 48;
constexpr float mouse_width_px = 730;
constexpr float frame_top_px = 74;
constexpr float frame_text_top_px = 82;
constexpr float frame_width_px = 1180;
constexpr float row_height_px = 32;
constexpr float diagnostic_font_px = 14;
constexpr size_t mouse_label_bytes = 220;
constexpr size_t frame_label_bytes = 320;
constexpr std::array<float, 4> diagnostic_background{.02f, .02f, .025f, .85f};
constexpr std::array<float, 4> diagnostic_text_color{1, 1, 1, 1};

double epoch_ms() {
    return std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
}

}  // namespace

void HudFrame::draw() const {
    BhCmd shown{};
    bh_last_command(core, &shown);
    BhWeaponReport weapon{};
    bh_weapon_report(core, &weapon);
    if (!visible) return;
    if (layout_editor.active()) {
        draw_layout_editor();
        return;
    }
    draw_status(shown, weapon);
    draw_diagnostics();
    draw_playback();
    draw_chat();
    draw_panels();
    draw_notifications();
}

// Every element with sample values, at the layout being edited, under the editor's outlines and bar.
void HudFrame::draw_layout_editor() const {
    if (layout_editor.take_preview()) hud.preferences(layout_editor.working_settings());
    hud.set_editing(true);
    draw_hud_demo(hud, layout_demo, width, height, prefs.hud_scale, map_id, display_style, display_fps);
    hud.set_editing(false);
    layout_editor.draw(hud, width, height, display_scale, layout_editor_key);
}

void HudFrame::draw_status(const BhCmd &shown, const BhWeaponReport &weapon) const {
    hud.draw(
            width,
            height,
            state,
            display_run,
            shown,
            map_id,
            display_style,
            shown_notice,
            display_fps,
            prefs.hud && (!viewer.active || viewer.hud),
            prefs.crosshair,
            viewer.active && !viewer.ui_shown,
            weapon,
            prefs.jump_stats ? hud.ssj_line() : std::string_view(),
            feedback.ssj_gain,
            prefs.strafe_trainer ? feedback.strafe_reading : std::nullopt,
            prefs.strafe_trainer_hints,
            &hud_layout,
            prefs.hud_scale,
            &practice,
            prefs.practice_keep_velocity,
            gauntlet_line,
            gauntlet_delta,
            gauntlet_good,
            leave_hold.progress(epoch_ms())
    );
}

void HudFrame::draw_diagnostics() const {
    if (prefs.mouse_diagnostics && !viewer.active) {
        const auto &m = mouse_diagnostics.last;
        char label[mouse_label_bytes];
        std::snprintf(
                label,
                sizeof(label),
                "%s %.0f/s | jitter %.2f ms | age %.2f/%.2f ms | pump %.2f ms",
                mouse_diagnostics.backend,
                m.events_per_second,
                m.timestamp_jitter_ms,
                m.average_age_ms,
                m.max_age_ms,
                m.max_pump_ms
        );
        hud.overlay_begin(width, height, overlay_scale_percent);
        hud.overlay_rect(diagnostic_left_px, mouse_top_px, mouse_width_px, row_height_px, diagnostic_background);
        hud.overlay_text(
                diagnostic_text_left_px,
                mouse_text_top_px,
                m.seconds ? label : "Mouse diagnostics: move continuously for a sample",
                diagnostic_font_px,
                diagnostic_text_color
        );
        char frame_line[frame_label_bytes];
        native::format_frame_line(frame_diagnostics.last(), frame_line, sizeof(frame_line));
        hud.overlay_rect(diagnostic_left_px, frame_top_px, frame_width_px, row_height_px, diagnostic_background);
        hud.overlay_text(
                diagnostic_text_left_px, frame_text_top_px, frame_line, diagnostic_font_px, diagnostic_text_color
        );
        hud.overlay_end(width, height);
    }
}

void HudFrame::draw_playback() const {
    if (viewer.active && !viewer.ui_shown && !chat.active && !video_preparing) {
        native::draw_replay_controls(
                hud,
                width,
                height,
                native::HudGeometry(width, height, overlay_scale_percent).scale,
                viewer.controls,
                curr.tick,
                viewer.session.range.to,
                viewer.session.range.tick_interval,
                viewer.paused,
                viewer.speed,
                viewer.camera.mode
        );
    }
}

void HudFrame::draw_chat() const {
    if (chat.active || prefs.hud)
        hud.draw_chat_overlay(
                width,
                height,
                chat.visible(epoch_ms() / milliseconds_per_second),
                chat.input,
                chat.composition,
                chat.suggestions,
                chat.active,
                chat.scroll_offset(),
                prefs.hud_scale,
                &chat,
                chat.viewport(epoch_ms() / milliseconds_per_second)
        );
}

void HudFrame::draw_panels() const {
    if (scoreboard && !chat.active) {
        hud.scoreboard(
                width, height, prefs.hud_scale, room.display(), steady_seconds, epoch_ms(), run_state, active_style
        );
    } else if (gun_menu.open && !chat.active) {
        gun_menu.draw(hud, width, height, prefs.hud_scale, weapon_menu_context);
    } else if (trigger_menu.open && !chat.active) {
        trigger_menu.draw(
                hud, width, height, prefs.hud_scale, hud.preferences().triggers_visible, hud.preferences().clips_visible
        );
    } else if (!chat.active) {
        native::draw_vote(hud, width, height, prefs.hud_scale, room.vote_display, epoch_ms());
    }
}

void HudFrame::draw_notifications() const {
    if (prefs.hud) {
        const float percent = prefs.hud_scale;
        native::draw_result(hud, width, height, percent, hud.result, double(SDL_GetTicksNS()) / nanoseconds_per_second);
        native::draw_toasts(hud, width, height, percent, hud.toasts, double(SDL_GetTicksNS()) / nanoseconds_per_second);
        native::draw_race(hud, width, height, percent, room_modes.display(), epoch_ms());
        native::draw_race_picker(hud, width, height, percent, race_picker);
    }
    room.draw_change(hud, width, height, prefs.hud_scale, epoch_ms());
}

}  // namespace native
