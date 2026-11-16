#pragma once
// The HUD side of spectating a room player (spectate_input.hpp). Sender: each tick's feed and jump stats go to the
// room bridge. Spectator: the watched player's records play into your HUD at the tick the camera shows: their keys,
// your strafe trainer look on their turning, their jump stats and JHUD, and their start prespeed.
#include "hud.hpp"
#include "room_bridge.hpp"
#include "spectate_input.hpp"

namespace native {
// What the sender's own trackers reported this tick.
struct HudFeedReports {
    std::optional<spectate_input::Jump> every_jump, sixth_jump;
    std::optional<std::optional<int>> start_pre;
};

// One tick of your own HUD feed for anyone watching you.
inline void send_hud_feed(
        RoomBridge &bridge,
        const BhCmd &cmd,
        const BhState &curr,
        BhAirSpeedGain gain,
        bool noclip,
        const BhSettings &settings,
        double tick_interval,
        const HudFeedReports &reports
) {
    using namespace spectate_input;
    if (!bridge.inputs.on) return;
    if (reports.every_jump) bridge.inputs.report({0, report_every, *reports.every_jump, {}});
    if (reports.sixth_jump) bridge.inputs.report({0, report_sixth, *reports.sixth_jump, {}});
    if (reports.start_pre) bridge.inputs.report({0, report_start_pre, {}, *reports.start_pre});
    // EVENT_TELEPORTED | EVENT_RESPAWNED: the web's interrupted tick.
    constexpr uint32_t moved_events = 9;
    const bool interrupted = noclip || (curr.events & moved_events) != 0;
    Tick tick;
    tick.keys = keys_of(cmd.buttons);
    tick.forward = cmd.forward;
    tick.side = cmd.side;
    tick.gain = gain_band(gain.delta, gain.best);
    tick.state = (curr.grounded ? state_grounded : 0) | (curr.on_ladder ? state_ladder : 0)
                 | ((curr.events & jump) ? state_jumped : 0) | (interrupted ? state_interrupted : 0);
    tick.yaw = cmd.yaw;
    tick.vx = curr.velocity[0];
    tick.vy = curr.velocity[1];
    bridge.record_input(tick, {tick_interval, settings.max_speed, settings.air_accelerate});
}

// The watched player's feed (RoomState::watched_feed), played into your HUD.
class WatchedHud {
public:
    // While the feed is live, the keys row shows this command.
    const BhCmd *command(const spectate_input::Feed &feed, double now) const {
        return feed.live(now) && shown_ ? &*shown_ : nullptr;
    }

    // A new target, or none: nothing of the last one stays on screen.
    void restart(NativeHud &hud, MovementFeedback &feedback, spectate_input::Feed &feed) {
        feed.reset();
        shown_.reset();
        feedback.reset();
        hud.reset_history(false, false);
        hud.movement.show_start_pre(std::nullopt);
    }

    // Plays the records up to `render_tick`, the watched player's tick the camera shows. `style` is theirs.
    void
    frame(NativeHud &hud,
          MovementFeedback &feedback,
          spectate_input::Feed &feed,
          uint32_t render_tick,
          std::string_view style,
          double now) {
        feed.take(
                render_tick,
                [&](const spectate_input::Tick &tick, const spectate_input::Settings &settings) {
                    play(hud, feedback, tick, settings, style);
                },
                [&](const spectate_input::Report &report) { show(hud, report); }
        );
        if (!feed.live(now)) feedback.strafe_reading.reset();
    }

private:
    std::optional<BhCmd> shown_;

    void
    play(NativeHud &hud,
         MovementFeedback &feedback,
         const spectate_input::Tick &tick,
         const spectate_input::Settings &settings,
         std::string_view style) {
        using namespace spectate_input;
        if (tick.state & state_reset) {
            feedback.reset();
            hud.jhud.clear();
        }
        BhCmd cmd{};
        cmd.forward = tick.forward > 0 ? move_speed : tick.forward < 0 ? -move_speed : 0;
        cmd.side = tick.side > 0 ? move_speed : tick.side < 0 ? -move_speed : 0;
        cmd.yaw = tick.yaw;
        cmd.buttons = buttons_of(tick.keys);
        BhState state{};
        state.tick = tick.tick;
        state.velocity[0] = tick.vx;
        state.velocity[1] = tick.vy;
        state.grounded = (tick.state & state_grounded) != 0;
        state.on_ladder = (tick.state & state_ladder) != 0;
        state.events = (tick.state & state_jumped) ? jump : 0;
        hud.command_tick(cmd, tick.tick);
        shown_ = cmd;
        BhSettings trainer{};
        trainer.max_speed = settings.max_speed;
        trainer.air_accelerate = settings.air_accelerate;
        const SsjCmd ssj_cmd{cmd.forward, cmd.side, cmd.yaw, cmd.buttons};
        const BhAirSpeedGain gain{float(band_gain(tick.gain)), 1};
        feed_strafe_trainer(
                feedback,
                hud.preferences(),
                state,
                ssj_cmd,
                trainer,
                style,
                settings.tick_interval,
                (tick.state & state_interrupted) != 0,
                gain
        );
        hud.jhud.expire(tick.tick);
        tick_interval_ = settings.tick_interval;
    }

    void show(NativeHud &hud, const spectate_input::Report &report) {
        using namespace spectate_input;
        if (report.kind == report_start_pre) return hud.movement.show_start_pre(report.start_pre);
        if (const auto ssj = shown_jump(report, hud.preferences().ssj_mode)) hud.ssj_report(*ssj);
        if (const auto jhud = jhud_of(report)) hud.jhud.show(*jhud, report.tick, tick_interval_);
    }

    double tick_interval_ = .01;
};
}  // namespace native
