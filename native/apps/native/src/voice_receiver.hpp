#pragma once
// Listening: each talker's VOICE_DOWN packets are decoded (concealing up to four lost frames), measured for the
// meter and queued in that talker's playout; the audio callback mixes every queue through the talker's gain.
//
// Threads: receive() and end_silent() run on the voice worker, mix() on the audio callback, snapshot() and the gain
// setters anywhere. Decoding happens outside the lock; the lock only covers the queues, so the callback never waits
// on a decode.
#include "voice_codec.hpp"
#include "voice_meter.hpp"
#include "voice_playout.hpp"
#include "voice_wire.hpp"
#include <array>
#include <atomic>
#include <memory>
#include <mutex>
#include <optional>
#include <span>

namespace native::voice {

constexpr unsigned slot_count = 256;
// A talker with no packet for this long has stopped (their END was refused, or they left).
constexpr double talker_silent_seconds = .6;
constexpr float max_talker_gain = 2;

struct TalkerView {
    bool audible = false;
    float level = 0;
    Bands bands{};
};

struct ReceiverStats {
    unsigned packets = 0, frames = 0, concealed = 0, malformed = 0, refused = 0;
};

class Receiver {
public:
    Receiver() {
        for (auto &gain : gains_)
            gain.store(1, std::memory_order_relaxed);
    }

    // One VOICE_DOWN frame from the room (worker thread). `self` is your own slot: never played back.
    void receive(std::span<const uint8_t> bytes, double now_seconds, unsigned self) {
        const auto down = parse_voice_down(bytes);
        if (!down) {
            ++stats.malformed;
            return;
        }
        if (down->slot == self || down->slot >= slot_count) {
            ++stats.refused;
            return;
        }
        ++stats.packets;
        auto &talker = talker_for(down->slot);
        talker.last_packet = now_seconds;
        const auto &packet = down->packet;
        int lost_frames = 0;
        bool start = (packet.flags & flag_start) || !talker.open;
        if (!start && talker.last_seq) {
            if (!seq_after(packet.seq, *talker.last_seq)) return;
            const unsigned lost_packets = uint16_t(packet.seq - *talker.last_seq - 1);
            if (lost_packets * frames_per_packet > unsigned(max_concealed_frames))
                start = true;
            else
                lost_frames = int(lost_packets * frames_per_packet);
        }
        talker.last_seq = packet.seq;
        talker.open = true;
        if (start) begin_spurt(talker);
        for (int i = 0; i < lost_frames; ++i)
            queue_frame(talker, {});
        for (size_t i = 0; i < packet.frame_count; ++i)
            queue_frame(talker, packet.frames[i]);
        if (packet.flags & flag_end) end_spurt(talker);
    }

    // Ends spurts that went quiet without an END (worker thread).
    void end_silent(double now_seconds) {
        for (auto &talker : talkers_)
            if (talker && talker->open && now_seconds - talker->last_packet > talker_silent_seconds)
                end_spurt(*talker);
    }

    // Adds every talker into `out` (audio callback).
    void mix(std::span<float> out, float bus_gain) {
        std::lock_guard lock(mutex_);
        for (unsigned slot = 0; slot < slot_count; ++slot) {
            const auto &talker = talkers_[slot];
            if (!talker || !talker->playout.audible()) continue;
            talker->playout.mix(out, bus_gain * gains_[slot].load(std::memory_order_relaxed));
        }
    }

    // Your gain for a talker: 0 mutes, 1 is as sent, up to 2.
    void set_gain(unsigned slot, float gain) {
        if (slot < slot_count) gains_[slot].store(std::clamp(gain, 0.f, max_talker_gain), std::memory_order_relaxed);
    }

    // Who is audible now, with the level and bands of the frame playing (any thread).
    void snapshot(std::array<TalkerView, slot_count> &views) const {
        std::lock_guard lock(mutex_);
        for (unsigned slot = 0; slot < slot_count; ++slot) {
            const auto &talker = talkers_[slot];
            auto &view = views[slot];
            view = {};
            if (!talker || !talker->playout.audible()) continue;
            view.audible = gains_[slot].load(std::memory_order_relaxed) > 0;
            if (const auto *frame = talker->playout.current()) {
                view.level = frame->level;
                view.bands = frame->bands;
            }
        }
    }

    // A player left: their voice stops at once (worker thread).
    void forget(unsigned slot) {
        if (slot >= slot_count) return;
        std::lock_guard lock(mutex_);
        talkers_[slot].reset();
        gains_[slot].store(1, std::memory_order_relaxed);
    }

    void clear() {
        std::lock_guard lock(mutex_);
        for (auto &talker : talkers_)
            talker.reset();
    }

    std::optional<PlayoutStats> playout_stats(unsigned slot) const {
        std::lock_guard lock(mutex_);
        if (slot >= slot_count || !talkers_[slot]) return std::nullopt;
        return talkers_[slot]->playout.stats;
    }

    std::optional<int> playout_target_ms(unsigned slot) const {
        std::lock_guard lock(mutex_);
        if (slot >= slot_count || !talkers_[slot]) return std::nullopt;
        return talkers_[slot]->playout.target_ms();
    }

    // Every decoded frame, before it is queued (the interoperability proof checks what it hears).
    void (*tap)(void *context, unsigned slot, std::span<const float> pcm) = nullptr;
    void *tap_context = nullptr;

    ReceiverStats stats;

private:
    struct Talker {
        unsigned slot = 0;
        Decoder decoder;
        BandMeter meter;
        std::optional<uint16_t> last_seq;
        bool open = false;
        double last_packet = 0;
        Playout playout;
    };

    std::array<std::unique_ptr<Talker>, slot_count> talkers_{};
    std::array<std::atomic<float>, slot_count> gains_{};
    mutable std::mutex mutex_;

    Talker &talker_for(unsigned slot) {
        auto &talker = talkers_[slot];
        if (!talker) {
            auto made = std::make_unique<Talker>();
            made->slot = slot;
            std::lock_guard lock(mutex_);
            talker = std::move(made);
        }
        return *talker;
    }

    void begin_spurt(Talker &talker) {
        talker.meter.reset();
        std::lock_guard lock(mutex_);
        talker.playout.start_spurt();
    }

    void end_spurt(Talker &talker) {
        talker.open = false;
        talker.last_seq.reset();
        std::lock_guard lock(mutex_);
        talker.playout.end_spurt();
    }

    // An empty packet conceals a lost frame.
    void queue_frame(Talker &talker, std::span<const uint8_t> packet) {
        PlayoutFrame decoded;
        talker.decoder.decode(packet, std::span<float, frame_samples>(decoded.pcm));
        ++stats.frames;
        if (packet.empty()) ++stats.concealed;
        if (tap) tap(tap_context, talker.slot, decoded.pcm);
        decoded.level = level_of(decoded.pcm);
        decoded.bands = talker.meter.measure(decoded.pcm);
        std::lock_guard lock(mutex_);
        talker.playout.push() = decoded;
    }
};

}  // namespace native::voice
