#pragma once
// Voice chat's audio side: a worker thread that captures, encodes and decodes, and its own 48 kHz playback stream
// that SDL mixes beside the game's sound. The render thread only hands bytes in and takes packets out; encoding,
// decoding and mixing never run on it.
#include "voice_receiver.hpp"
#include "voice_sender.hpp"
#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <span>
#include <thread>
#include <vector>

struct SDL_AudioStream;

namespace native::voice {

// Where talking frames come from: the default microphone, or a synthetic one in tests and the local proof.
class CaptureSource {
public:
    virtual ~CaptureSource() = default;
    // Opens the device. Returns false if it can't (no device, blocked by the system).
    virtual bool open() = 0;
    // Starts or stops delivering frames; stopping drops what was captured.
    virtual void run(bool on) = 0;
    // The next whole frame, if one is ready.
    virtual bool read(std::span<float, frame_samples> pcm) = 0;
};

std::unique_ptr<CaptureSource> default_microphone();
// A test tone (Hz) at real time, as if from a microphone.
std::unique_ptr<CaptureSource> tone_source(float frequency_hz, float amplitude);

enum class EngineEvent { asking, denied, mic_failed, limit };

class Engine {
public:
    // `devices` false: no playback stream (tests mix by hand).
    Engine(std::function<std::unique_ptr<CaptureSource>()> capture, bool devices);
    ~Engine();
    Engine(const Engine &) = delete;
    Engine &operator=(const Engine &) = delete;

    // Render thread.
    void receive(std::span<const uint8_t> bytes);
    void press();
    void release();
    void stop_talking();
    void set_self(unsigned slot);
    void forget(unsigned slot);
    void clear_talkers();
    void set_listening(bool on);
    void set_gain(unsigned slot, float gain) { receiver_.set_gain(slot, gain); }
    void set_bus_gain(float gain) { bus_gain_.store(gain, std::memory_order_relaxed); }
    std::vector<Bytes> take_outgoing();
    std::vector<EngineEvent> take_events();
    void snapshot(std::array<TalkerView, slot_count> &views) const { receiver_.snapshot(views); }
    TalkerView self_view() const;
    bool transmitting() const { return transmitting_.load(std::memory_order_relaxed); }

    // Mixes `out` by hand when there is no playback stream.
    void mix(std::span<float> out);

    Receiver &receiver() { return receiver_; }
    std::atomic<unsigned> sent_packets{0}, sent_frames{0};

private:
    enum class Command { press, release, stop, forget, clear, self, listen_on, listen_off };

    struct Pending {
        Command command;
        unsigned slot = 0;
    };

    std::function<std::unique_ptr<CaptureSource>()> make_capture_;
    std::unique_ptr<CaptureSource> capture_;
    Receiver receiver_;
    Sender sender_;
    bool devices_;
    SDL_AudioStream *playback_ = nullptr;
    std::atomic<float> bus_gain_{1};
    std::atomic<bool> transmitting_{false};
    std::atomic<float> self_level_{0};
    std::array<std::atomic<float>, meter_band_count> self_bands_{};
    unsigned self_slot_ = slot_count;
    // Waiting for the system prompt; the key may come up before the answer.
    bool asking_ = false, wants_talk_ = false;
    std::atomic<int> permission_answer_{-1};

    mutable std::mutex mutex_;
    std::condition_variable wake_;
    std::vector<Bytes> inbox_, outbox_;
    std::vector<Pending> commands_;
    std::vector<EngineEvent> events_;
    bool running_ = true;
    std::thread worker_;

    void post(Command command, unsigned slot = 0);
    void work();
    void apply(const Pending &pending);
    void start_talking();
    void open_playback(bool on);
    bool ensure_capture();
    void pump_capture(std::vector<Bytes> &out);
    void answer_permission();
    void emit(EngineEvent event);
    static void playback_callback(void *data, SDL_AudioStream *stream, int additional, int total);
};

}  // namespace native::voice
