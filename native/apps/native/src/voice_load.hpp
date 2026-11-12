#pragma once
// --voice-load N: what voice chat costs a frame. The client plays a map as usual while N talkers (test tones, encoded
// with Opus and framed as the room sends them) arrive through the same main-thread path as the menu's messages, and
// you transmit from a test tone the whole time. N = 0 is the baseline: the same loop with no voice. The voice plays
// through the speakers and the talker list is drawn. At exit it prints the frame times and the main thread's time in
// voice code. Nothing goes to any server.
#include "room_bridge.hpp"
#include "base64.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <mutex>
#include <thread>
#include <vector>

namespace native {

class VoiceLoad {
public:
    static constexpr unsigned self_slot = 0;
    static constexpr size_t warm_up_frames = 120;
    static constexpr float first_tone_hz = 330;
    static constexpr float tone_step_hz = 110;

    VoiceLoad(RoomBridge &bridge, unsigned talkers) : bridge_(bridge), talkers_(std::min(talkers, 6u)) {
        room_.event(welcome());
        bridge_.voice().room(room_);
        if (talkers_) bridge_.voice().key(talk_key(), true, false);
        feeder_ = std::thread([this] { feed(); });
        frame_ms_.reserve(1 << 20);
        voice_us_.reserve(1 << 20);
    }

    ~VoiceLoad() {
        running_ = false;
        feeder_.join();
        report();
    }

    VoiceLoad(const VoiceLoad &) = delete;
    VoiceLoad &operator=(const VoiceLoad &) = delete;

    // Instead of RoomBridge::send_voice, once a frame.
    void frame(double now_ms, float master_volume) {
        const auto now = std::chrono::steady_clock::now();
        if (last_.time_since_epoch().count())
            frame_ms_.push_back(float(std::chrono::duration<double, std::milli>(now - last_).count()));
        last_ = now;
        std::vector<std::string> arrived;
        {
            std::lock_guard lock(mutex_);
            arrived.swap(inbox_);
        }
        for (const auto &frame : arrived)
            bridge_.voice().receive(frame);
        bridge_.send_voice(nullptr, false, now_ms, master_volume, true);
        voice_us_.push_back(
                float(std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - now).count())
        );
    }

    void report() const {
        auto frames = trimmed(frame_ms_);
        auto voice = trimmed(voice_us_);
        auto &engine = bridge_.voice().engine();
        std::printf(
                "{\"voiceTalkers\":%u,\"transmitting\":%s,\"frames\":%zu,\"frameMs\":{\"mean\":%.3f,\"p50\":%.3f,"
                "\"p99\":%.3f,\"max\":%.3f},\"voiceMainThreadUs\":{\"mean\":%.1f,\"p99\":%.1f,\"max\":%.1f},"
                "\"decodedFrames\":%u,\"concealed\":%u,\"sentPackets\":%u}\n",
                talkers_,
                engine.transmitting() ? "true" : "false",
                frames.size(),
                mean(frames),
                at(frames, .5),
                at(frames, .99),
                frames.empty() ? 0. : double(frames.back()),
                mean(voice),
                at(voice, .99),
                voice.empty() ? 0. : double(voice.back()),
                engine.receiver().stats.frames,
                engine.receiver().stats.concealed,
                engine.sent_packets.load()
        );
    }

private:
    RoomBridge &bridge_;
    unsigned talkers_;
    RoomState room_;
    std::atomic<bool> running_{true};
    std::thread feeder_;
    std::mutex mutex_;
    std::vector<std::string> inbox_;
    std::vector<float> frame_ms_, voice_us_;
    std::chrono::steady_clock::time_point last_{};

    std::string talk_key() const {
        const auto preferences = default_settings();
        return preferences["binds"]["voiceRecord"][0].get<std::string>();
    }

    nlohmann::json welcome() const {
        auto players = nlohmann::json::array();
        for (unsigned slot = 0; slot <= talkers_; ++slot)
            players.push_back(
                    {{"slot", slot},
                     {"id", "load-" + std::to_string(slot)},
                     {"name", slot == self_slot ? "You" : "Talker " + std::to_string(slot)},
                     {"provider", "discord"},
                     {"style", "autohop"}}
            );
        return {{"generation", 1},
                {"id", "voice-load"},
                {"event",
                 {{"t", "welcome"},
                  {"you", self_slot},
                  {"room", {{"id", "voice-load"}, {"name", "Voice load"}, {"voice", 1}}},
                  {"map", {{"name", "voice-load"}}},
                  {"players", players}}}};
    }

    // Each talker's packets at real time: two 20 ms frames every 40 ms.
    void feed() {
        std::vector<voice::Sender> senders(talkers_);
        for (auto &sender : senders)
            sender.press();
        std::array<float, voice::frame_samples> pcm{};
        uint64_t frame_index = 0;
        auto next = std::chrono::steady_clock::now();
        while (running_) {
            next += std::chrono::milliseconds(voice::frame_ms);
            std::this_thread::sleep_until(next);
            for (unsigned talker = 0; talker < talkers_; ++talker) {
                const double hz = first_tone_hz + tone_step_hz * talker;
                for (int i = 0; i < voice::frame_samples; ++i) {
                    const double t = double(frame_index * voice::frame_samples + uint64_t(i)) / voice::sample_rate;
                    pcm[size_t(i)] = .2f * float(std::sin(2 * 3.14159265358979 * hz * t));
                }
                std::vector<voice::Bytes> packets;
                senders[talker].frame(pcm, packets);
                std::lock_guard lock(mutex_);
                for (const auto &packet : packets) {
                    std::string down{char(voice::message_voice_down), char(talker + 1)};
                    down.append(packet.begin() + 1, packet.end());
                    inbox_.push_back(base64(down));
                }
            }
            ++frame_index;
        }
    }

    std::vector<float> trimmed(const std::vector<float> &values) const {
        std::vector<float> out(values.begin() + std::ptrdiff_t(std::min(values.size(), warm_up_frames)), values.end());
        std::sort(out.begin(), out.end());
        return out;
    }

    static double at(const std::vector<float> &sorted, double quantile) {
        if (sorted.empty()) return 0;
        return sorted[std::min(sorted.size() - 1, size_t(quantile * double(sorted.size())))];
    }

    static double mean(const std::vector<float> &values) {
        double total = 0;
        for (const float value : values)
            total += value;
        return values.empty() ? 0 : total / double(values.size());
    }
};

}  // namespace native
