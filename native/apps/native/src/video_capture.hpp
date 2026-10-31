#pragma once
#include "video_export.hpp"
#include "replay_audio.hpp"
#include "replay_camera.hpp"
#include "renderer.hpp"
#include "hud.hpp"
#include "video_frames.hpp"
#include <chrono>
#include <deque>
#include <memory>
#include <optional>

// Native GL capture and replay preparation stay on the context's owner thread.
namespace native {
class ReplayDirectorJob {
    BhContext *core;
    uint32_t total, saved;
    bool restored = false, gathered = false, planning = false;
    std::vector<BhGhostFrame> frames_;
    std::vector<uint8_t> teleports_;
    BhSnapshot snapshot{};

    void restore() {
        if (!restored) {
            if (!bh_replay_seek(core, saved, &snapshot))
                throw std::runtime_error("Cannot restore replay after camera preparation");
            restored = true;
        }
    }

public:
    ReplayDirectorJob(BhContext *ctx, uint32_t ticks, uint32_t original) : core(ctx), total(ticks), saved(original) {
        if (total > 1'000'000)
            throw std::runtime_error("Cinematic camera preparation supports up to one million replay ticks");
        frames_.reserve(size_t(total) + 1);
        teleports_.reserve(size_t(total) + 1);
        if (!bh_replay_seek(core, 0, &snapshot)) {
            bh_replay_seek(core, saved, &snapshot);
            throw std::runtime_error("Cannot prepare replay cameras");
        }
    }

    ~ReplayDirectorJob() {
        try {
            restore();
        } catch (...) {
        }
    }

    bool step() {
        if (gathered) return true;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(5);
        for (unsigned count = 0; count < 512; count++) {
            const auto &s = snapshot.player;
            BhCmd cmd{};
            BhWeaponReport weapon{};
            bh_last_command(core, &cmd);
            bh_weapon_report(core, &weapon);
            BhGhostFrame frame{};
            std::copy(s.position, s.position + 3, frame.position);
            std::copy(s.velocity, s.velocity + 3, frame.velocity);
            frame.yaw = cmd.yaw;
            frame.pitch = cmd.pitch;
            frame.view_offset_z = s.view_offset_z;
            frame.tick = s.tick;
            frame.flags = (s.crouched ? 1 : 0) | (s.grounded ? 2 : 0);
            frame.weapon = weapon.active;
            frames_.push_back(frame);
            teleports_.push_back(bool(s.events & 1));
            if (frames_.size() > total) {
                restore();
                gathered = true;
                return true;
            }
            if (!bh_replay_step(core, &snapshot))
                throw std::runtime_error("Cinematic camera replay preparation failed");
            if (std::chrono::steady_clock::now() >= deadline) break;
        }
        return false;
    }

    bool plan(ReplayCamera &camera, double dt, uint32_t from, uint32_t to) {
        if (!planning) {
            camera.begin_direct(
                    std::move(frames_), unsigned(std::lround(1 / dt)), from, to, core, total, std::move(teleports_)
            );
            planning = true;
        }
        return camera.step_direct(8, 4);
    }
};

// Renders a replay clip offscreen for the export process: each video frame is one or more replay subframes
// (motion blur) at the supersampled size, the HUD drawn over their average, read back asynchronously.
class VideoCapture {
public:
    struct Scene {
        std::string map, style, outfit, loadout;
        Json settings;
        std::filesystem::path assets, cache;
    };

    VideoCapture(
            Gl &gl,
            BhContext *core,
            Renderer &renderer,
            NativeHud &hud,
            NativeVideoExport &encoder,
            const VideoOptions &options,
            uint32_t ticks,
            Scene scene,
            const ReplayCamera &prepared
    );

    // Pre-rolls the replay sound from tick zero so cues crossing a trimmed start keep their tails.
    void prepare_audio();
    // One unit of work: hand a frame to the encoder, read one back or render the next. False while the encoder is
    // full.
    bool step();

    bool done() const { return done_; }

    uint64_t frame() const { return submitted_; }

    uint64_t frames() const { return timeline_.frames; }

private:
    BhContext *core_;
    Renderer &renderer_;
    NativeHud &hud_;
    NativeVideoExport &encoder_;
    VideoOptions options_;
    VideoTimeline timeline_;
    ReplayCamera camera_;
    Input input_;
    Scene scene_;
    VideoFrameTargets targets_;
    std::unique_ptr<ReplayAudioTrack> audio_;
    std::deque<std::vector<float>> frame_audio_;
    std::optional<std::vector<uint8_t>> waiting_;
    uint64_t frame_ = 0, collected_ = 0, submitted_ = 0;
    double last_sample_tick_ = -1;
    native_render::ThirdPersonEvents actor_events_;
    bool done_ = false;
    BhSnapshot previous_{}, next_{};
    BhCmd prior_command_{}, next_command_{};
    BhRunState run_{};

    double sample_tick(double frame_tick, int sample) const;
    void step_simulation();
    void advance_to(double tick);
    BhSnapshot interpolated(double tick, double &mix);
    void place_actor(const BhSnapshot &state);
    void draw_sample(double tick, double dt);
    void draw_overlays(const BhSnapshot &state);
    void finish_audio();
    void render_frame();
    bool hand_over();
};
}  // namespace native
