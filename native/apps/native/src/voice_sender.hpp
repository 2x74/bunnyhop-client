#pragma once
// Talking: captured 20 ms frames go through the Opus encoder and leave two to a VOICE_UP. The first packet of a spurt
// carries START. Let go and the microphone keeps going for the release tail (220 ms, so the last syllable isn't cut),
// then the spurt ends with END and whatever frames are left (0 or 1). A spurt stops itself at 59 s, a little under
// the room's 60 s cap. Runs on the voice worker; the tests drive it with synthetic frames.
#include "voice_codec.hpp"
#include "voice_meter.hpp"
#include "voice_wire.hpp"
#include <array>
#include <cstdint>
#include <span>
#include <vector>

namespace native::voice {

constexpr int release_tail_ms = 220;
constexpr unsigned release_tail_frames = (release_tail_ms + frame_ms - 1) / frame_ms;
constexpr int client_spurt_ms = 59000;
constexpr unsigned client_spurt_frames = client_spurt_ms / frame_ms;

using Bytes = std::vector<uint8_t>;

class Sender {
public:
    enum class Stop { none, released, limit };

    // The key went down. Pressed again inside the release tail, the same spurt goes on.
    void press() {
        held_ = true;
        if (state_ == State::tail) state_ = State::talking;
        if (state_ != State::idle) return;
        state_ = State::talking;
        start_flag_ = true;
        spurt_frames_ = 0;
        pending_count_ = 0;
        encoder_.reset();
        meter_.reset();
    }

    // The key came up: the tail, then END.
    void release() {
        held_ = false;
        if (state_ != State::talking) return;
        state_ = State::tail;
        tail_left_ = release_tail_frames;
    }

    bool transmitting() const { return state_ != State::idle; }

    bool held() const { return held_; }

    // One captured frame. Packets that are due go into `out`. Returns why the spurt stopped, if it did.
    Stop frame(std::span<const float, frame_samples> pcm, std::vector<Bytes> &out) {
        if (state_ == State::idle) return Stop::none;
        level = level_of(pcm);
        bands = meter_.measure(pcm);
        std::array<uint8_t, max_opus_frame_bytes> packet{};
        const size_t size = encoder_.encode(pcm, packet);
        if (size) {
            auto &slot = pending_[pending_count_++];
            slot.assign(packet.begin(), packet.begin() + std::ptrdiff_t(size));
        }
        ++spurt_frames_;
        if (spurt_frames_ >= client_spurt_frames) {
            finish(out);
            held_ = false;
            return Stop::limit;
        }
        if (state_ == State::tail && --tail_left_ == 0) {
            finish(out);
            return Stop::released;
        }
        if (pending_count_ >= frames_per_packet) send(0, out);
        return Stop::none;
    }

    // Ends the spurt at once (voice turned off, the room went away): END with what is left.
    void stop_now(std::vector<Bytes> &out) {
        if (state_ == State::idle) return;
        finish(out);
        held_ = false;
    }

    // Level and bands of the last captured frame, for your own row.
    float level = 0;
    Bands bands{};

private:
    enum class State { idle, talking, tail };

    Encoder encoder_;
    BandMeter meter_;
    State state_ = State::idle;
    bool held_ = false, start_flag_ = false;
    unsigned tail_left_ = 0, spurt_frames_ = 0;
    uint16_t seq_ = 0;
    std::array<Bytes, max_frames> pending_{};
    size_t pending_count_ = 0;

    void send(uint8_t flags, std::vector<Bytes> &out) {
        std::array<std::span<const uint8_t>, max_frames> frames{};
        for (size_t i = 0; i < pending_count_; ++i)
            frames[i] = pending_[i];
        if (start_flag_) flags |= flag_start;
        seq_ = uint16_t(seq_ + 1);
        if (auto bytes = encode_voice_up(flags, seq_, std::span(frames).first(pending_count_)))
            out.push_back(std::move(*bytes));
        start_flag_ = false;
        pending_count_ = 0;
    }

    void finish(std::vector<Bytes> &out) {
        send(flag_end, out);
        state_ = State::idle;
        level = 0;
        bands = {};
    }
};

// The room's budgets for one talker (apps/api rooms/voice.ts VOICE_LIMITS), kept on this side too: a packet the room
// would refuse with a strike is never sent. Only a long stall that bunches packets up ever hits it.
struct RelayBudget {
    static constexpr double frame_burst = 16, frame_refill_ms = 18;
    static constexpr double byte_burst = 4096, bytes_per_ms = 8;

    double frames = frame_burst, bytes = byte_burst, at_ms = -1;

    bool spend(size_t frame_count, size_t byte_count, double now_ms) {
        if (at_ms >= 0) {
            const double elapsed = now_ms > at_ms ? now_ms - at_ms : 0;
            frames = std::min(frame_burst, frames + elapsed / frame_refill_ms);
            bytes = std::min(byte_burst, bytes + elapsed * bytes_per_ms);
        }
        at_ms = now_ms;
        if (frames < double(frame_count) || bytes < double(byte_count)) return false;
        frames -= double(frame_count);
        bytes -= double(byte_count);
        return true;
    }
};

}  // namespace native::voice
