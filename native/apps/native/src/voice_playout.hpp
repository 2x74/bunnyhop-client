#pragma once
// One talker's playout queue: decoded 20 ms frames wait here until the audio callback plays them.
//
// The queue is kept 60-120 ms deep (docs/client/voice.md, native client). A spurt starts playing once `target` ms
// are queued (80 at first). Running dry in the middle of a spurt (a stall on the way) pauses until the queue refills
// and raises the target by 20 ms; a long calm stretch lowers it again by 20 ms. A queue that grows past the target
// plus 80 ms (a burst after a stall) drops its oldest frames back down to the target. The end of a spurt plays out
// whatever is left. Not thread safe: the voice engine holds its lock around every call.
#include "voice_meter.hpp"
#include "voice_wire.hpp"
#include <algorithm>
#include <array>
#include <cstddef>
#include <span>

namespace native::voice {

constexpr int playout_min_ms = 60;
constexpr int playout_max_ms = 120;
constexpr int playout_start_ms = 80;
constexpr int playout_step_ms = 20;
constexpr int playout_slack_ms = 80;
// Frames played without running dry before the target comes down one step.
constexpr unsigned playout_calm_frames = 250;
constexpr size_t playout_capacity_frames = (playout_max_ms + playout_slack_ms) / frame_ms + 4;

struct PlayoutFrame {
    std::array<float, frame_samples> pcm{};
    float level = 0;
    Bands bands{};
};

struct PlayoutStats {
    unsigned frames = 0, played = 0, dry = 0, dropped = 0, spurts = 0;
};

class Playout {
public:
    enum class State { idle, buffering, playing };

    // A new spurt: start buffering (a spurt that is still playing just carries on).
    void start_spurt() {
        ending_ = false;
        if (state_ == State::idle) {
            state_ = State::buffering;
            ++stats.spurts;
        }
    }

    // The talker let go: what is queued plays out, then the queue goes idle.
    void end_spurt() {
        ending_ = true;
        if (state_ == State::buffering && count_ == 0) state_ = State::idle;
    }

    // A decoded frame. The caller fills the slot returned (pcm, level, bands) before its next call.
    PlayoutFrame &push() {
        if (state_ == State::idle) start_spurt();
        ++stats.frames;
        if (count_ == frames_.size()) drop_oldest();
        PlayoutFrame &slot = frames_[(head_ + count_) % frames_.size()];
        ++count_;
        trim();
        return slot;
    }

    // Adds `count` samples of this talker into `out`, scaled by `gain`. Returns false when nothing played.
    bool mix(std::span<float> out, float gain) {
        if (state_ == State::buffering && (depth_ms() >= target_ms_ || (ending_ && count_ > 0)))
            state_ = State::playing;
        if (state_ != State::playing) {
            current_ = nullptr;
            return false;
        }
        size_t written = 0;
        while (written < out.size()) {
            if (count_ == 0) {
                run_dry();
                break;
            }
            PlayoutFrame &frame = frames_[head_];
            current_ = &frame;
            const size_t take = std::min(out.size() - written, size_t(frame_samples) - cursor_);
            for (size_t i = 0; i < take; ++i)
                out[written + i] += frame.pcm[cursor_ + i] * gain;
            written += take;
            cursor_ += take;
            if (cursor_ == size_t(frame_samples)) finish_frame();
        }
        return written > 0;
    }

    // Queued audio (ms), the part of the playing frame already out excluded.
    int depth_ms() const { return int((count_ * size_t(frame_samples) - cursor_) * 1000 / size_t(sample_rate)); }

    int target_ms() const { return target_ms_; }

    State state() const { return state_; }

    bool audible() const { return state_ != State::idle; }

    // The frame playing now (level and bands for the meter), or none.
    const PlayoutFrame *current() const { return current_; }

    void clear() {
        head_ = count_ = cursor_ = 0;
        state_ = State::idle;
        ending_ = false;
        current_ = nullptr;
    }

    PlayoutStats stats;

private:
    std::array<PlayoutFrame, playout_capacity_frames> frames_{};
    size_t head_ = 0, count_ = 0, cursor_ = 0;
    int target_ms_ = playout_start_ms;
    unsigned calm_frames_ = 0;
    State state_ = State::idle;
    bool ending_ = false;
    const PlayoutFrame *current_ = nullptr;

    void drop_oldest() {
        head_ = (head_ + 1) % frames_.size();
        --count_;
        cursor_ = 0;
        ++stats.dropped;
    }

    void trim() {
        if (depth_ms() <= target_ms_ + playout_slack_ms) return;
        while (count_ > 1 && depth_ms() > target_ms_)
            drop_oldest();
    }

    void finish_frame() {
        head_ = (head_ + 1) % frames_.size();
        --count_;
        cursor_ = 0;
        ++stats.played;
        if (++calm_frames_ >= playout_calm_frames) {
            calm_frames_ = 0;
            target_ms_ = std::max(playout_min_ms, target_ms_ - playout_step_ms);
        }
    }

    void run_dry() {
        current_ = nullptr;
        if (ending_) {
            state_ = State::idle;
            ending_ = false;
            return;
        }
        ++stats.dry;
        calm_frames_ = 0;
        target_ms_ = std::min(playout_max_ms, target_ms_ + playout_step_ms);
        state_ = State::buffering;
    }
};

}  // namespace native::voice
