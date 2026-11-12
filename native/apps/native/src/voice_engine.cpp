#include "voice_engine.hpp"
#include "mic_permission.hpp"
#include <SDL3/SDL.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>

namespace native::voice {
namespace {

using Clock = std::chrono::steady_clock;
constexpr auto worker_interval = std::chrono::milliseconds(5);
constexpr size_t mix_chunk_samples = 480;
constexpr float output_limit = .98f;

double seconds_now() {
    return std::chrono::duration<double>(Clock::now().time_since_epoch()).count();
}

class Microphone final : public CaptureSource {
public:
    ~Microphone() override {
        if (stream_) SDL_DestroyAudioStream(stream_);
        if (initialized_) SDL_QuitSubSystem(SDL_INIT_AUDIO);
    }

    bool open() override {
        initialized_ = SDL_InitSubSystem(SDL_INIT_AUDIO);
        if (!initialized_) return false;
        const SDL_AudioSpec spec{SDL_AUDIO_F32, 1, sample_rate};
        stream_ = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_RECORDING, &spec, nullptr, nullptr);
        if (!stream_) std::cerr << "Voice: the microphone didn't open: " << SDL_GetError() << '\n';
        return stream_ != nullptr;
    }

    void run(bool on) override {
        SDL_ClearAudioStream(stream_);
        if (on)
            SDL_ResumeAudioStreamDevice(stream_);
        else
            SDL_PauseAudioStreamDevice(stream_);
    }

    bool read(std::span<float, frame_samples> pcm) override {
        constexpr int frame_bytes = frame_samples * int(sizeof(float));
        if (SDL_GetAudioStreamAvailable(stream_) < frame_bytes) return false;
        return SDL_GetAudioStreamData(stream_, pcm.data(), frame_bytes) == frame_bytes;
    }

private:
    SDL_AudioStream *stream_ = nullptr;
    bool initialized_ = false;
};

class Tone final : public CaptureSource {
public:
    Tone(float frequency_hz, float amplitude) : frequency_hz_(frequency_hz), amplitude_(amplitude) {}

    bool open() override { return true; }

    void run(bool on) override {
        running_ = on;
        started_ = Clock::now();
        delivered_ = 0;
    }

    bool read(std::span<float, frame_samples> pcm) override {
        if (!running_) return false;
        const auto elapsed = std::chrono::duration<double>(Clock::now() - started_).count();
        if (double(delivered_ + 1) * frame_ms / 1000 > elapsed) return false;
        constexpr float two_pi = 2 * pi;
        for (int i = 0; i < frame_samples; ++i) {
            const double t = double(sample_++) / sample_rate;
            // A 4 Hz syllable envelope, as the website's synthetic microphone.
            const float envelope = .65f + .35f * float(std::sin(two_pi * 4 * t));
            pcm[size_t(i)] = amplitude_ * envelope * float(std::sin(two_pi * frequency_hz_ * t));
        }
        ++delivered_;
        return true;
    }

private:
    float frequency_hz_, amplitude_;
    bool running_ = false;
    Clock::time_point started_{};
    uint64_t delivered_ = 0, sample_ = 0;
};

}  // namespace

std::unique_ptr<CaptureSource> default_microphone() {
    return std::make_unique<Microphone>();
}

std::unique_ptr<CaptureSource> tone_source(float frequency_hz, float amplitude) {
    return std::make_unique<Tone>(frequency_hz, amplitude);
}

Engine::Engine(std::function<std::unique_ptr<CaptureSource>()> capture, bool devices)
    : make_capture_(std::move(capture))
    , devices_(devices) {
    worker_ = std::thread([this] { work(); });
}

Engine::~Engine() {
    {
        std::lock_guard lock(mutex_);
        running_ = false;
    }
    wake_.notify_one();
    worker_.join();
    open_playback(false);
}

void Engine::receive(std::span<const uint8_t> bytes) {
    if (bytes.empty() || bytes.size() > max_voice_down_bytes) return;
    {
        std::lock_guard lock(mutex_);
        inbox_.emplace_back(bytes.begin(), bytes.end());
    }
    wake_.notify_one();
}

void Engine::post(Command command, unsigned slot) {
    {
        std::lock_guard lock(mutex_);
        commands_.push_back({command, slot});
    }
    wake_.notify_one();
}

void Engine::press() {
    post(Command::press);
}

void Engine::release() {
    post(Command::release);
}

void Engine::stop_talking() {
    post(Command::stop);
}

void Engine::set_self(unsigned slot) {
    post(Command::self, slot);
}

void Engine::forget(unsigned slot) {
    post(Command::forget, slot);
}

void Engine::clear_talkers() {
    post(Command::clear);
}

void Engine::set_listening(bool on) {
    post(on ? Command::listen_on : Command::listen_off);
}

std::vector<Bytes> Engine::take_outgoing() {
    std::lock_guard lock(mutex_);
    return std::exchange(outbox_, {});
}

std::vector<EngineEvent> Engine::take_events() {
    std::lock_guard lock(mutex_);
    return std::exchange(events_, {});
}

TalkerView Engine::self_view() const {
    TalkerView view;
    view.audible = transmitting();
    view.level = self_level_.load(std::memory_order_relaxed);
    for (size_t i = 0; i < meter_band_count; ++i)
        view.bands[i] = self_bands_[i].load(std::memory_order_relaxed);
    return view;
}

void Engine::mix(std::span<float> out) {
    receiver_.mix(out, bus_gain_.load(std::memory_order_relaxed));
    for (auto &sample : out)
        sample = std::clamp(sample, -output_limit, output_limit);
}

void Engine::emit(EngineEvent event) {
    std::lock_guard lock(mutex_);
    events_.push_back(event);
}

void Engine::work() {
    std::vector<Bytes> inbox, out;
    std::vector<Pending> commands;
    for (;;) {
        {
            std::unique_lock lock(mutex_);
            wake_.wait_for(lock, worker_interval, [&] { return !running_ || !inbox_.empty() || !commands_.empty(); });
            if (!running_) return;
            inbox.swap(inbox_);
            commands.swap(commands_);
        }
        const double now = seconds_now();
        for (const auto &pending : commands)
            apply(pending);
        for (const auto &bytes : inbox)
            receiver_.receive(bytes, now, self_slot_);
        if (permission_answer_.load() >= 0) answer_permission();
        pump_capture(out);
        receiver_.end_silent(now);
        inbox.clear();
        commands.clear();
        if (!out.empty()) {
            std::lock_guard lock(mutex_);
            for (auto &bytes : out)
                outbox_.push_back(std::move(bytes));
            out.clear();
        }
    }
}

void Engine::apply(const Pending &pending) {
    switch (pending.command) {
        case Command::press:
            wants_talk_ = true;
            start_talking();
            break;
        case Command::release:
            wants_talk_ = false;
            sender_.release();
            break;
        case Command::stop: {
            wants_talk_ = false;
            std::vector<Bytes> out;
            sender_.stop_now(out);
            std::lock_guard lock(mutex_);
            for (auto &bytes : out)
                outbox_.push_back(std::move(bytes));
            break;
        }
        case Command::forget:
            receiver_.forget(pending.slot);
            break;
        case Command::clear:
            receiver_.clear();
            break;
        case Command::self:
            self_slot_ = pending.slot;
            break;
        case Command::listen_on:
        case Command::listen_off:
            open_playback(pending.command == Command::listen_on);
            break;
    }
}

void Engine::start_talking() {
    if (asking_) return;
    if (!capture_) {
        if (devices_) {
            const auto access = mic_access();
            if (access == MicAccess::denied) return emit(EngineEvent::denied);
            if (access == MicAccess::undetermined) {
                asking_ = true;
                emit(EngineEvent::asking);
                request_mic_access([this](bool granted) {
                    permission_answer_.store(granted ? 1 : 0);
                    wake_.notify_one();
                });
                return;
            }
        }
        if (!ensure_capture()) return;
    }
    const bool was_transmitting = sender_.transmitting();
    sender_.press();
    if (!was_transmitting) capture_->run(true);
    transmitting_.store(true, std::memory_order_relaxed);
}

void Engine::answer_permission() {
    const bool granted = permission_answer_.exchange(-1) == 1;
    asking_ = false;
    if (!granted) return emit(EngineEvent::denied);
    // The key is usually still down after the prompt; if it came up, the next press talks.
    if (wants_talk_) start_talking();
}

bool Engine::ensure_capture() {
    if (capture_) return true;
    auto made = make_capture_();
    if (!made || !made->open()) {
        emit(EngineEvent::mic_failed);
        return false;
    }
    capture_ = std::move(made);
    return true;
}

void Engine::pump_capture(std::vector<Bytes> &out) {
    if (!capture_ || !sender_.transmitting()) return;
    std::array<float, frame_samples> pcm{};
    while (sender_.transmitting() && capture_->read(pcm)) {
        const size_t before = out.size();
        const auto stop = sender_.frame(pcm, out);
        self_level_.store(sender_.level, std::memory_order_relaxed);
        for (size_t i = 0; i < meter_band_count; ++i)
            self_bands_[i].store(sender_.bands[i], std::memory_order_relaxed);
        for (size_t i = before; i < out.size(); ++i) {
            sent_packets.fetch_add(1, std::memory_order_relaxed);
            sent_frames.fetch_add(out[i][4], std::memory_order_relaxed);
        }
        if (stop == Sender::Stop::limit) emit(EngineEvent::limit);
    }
    if (!sender_.transmitting()) {
        capture_->run(false);
        transmitting_.store(false, std::memory_order_relaxed);
        self_level_.store(0, std::memory_order_relaxed);
    }
}

void Engine::open_playback(bool on) {
    if (!devices_ || on == (playback_ != nullptr)) return;
    if (!on) {
        SDL_DestroyAudioStream(playback_);
        playback_ = nullptr;
        SDL_QuitSubSystem(SDL_INIT_AUDIO);
        return;
    }
    if (!SDL_InitSubSystem(SDL_INIT_AUDIO)) return;
    const SDL_AudioSpec spec{SDL_AUDIO_F32, 1, sample_rate};
    playback_ = SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, &spec, playback_callback, this);
    if (!playback_) {
        std::cerr << "Voice: no playback stream: " << SDL_GetError() << '\n';
        SDL_QuitSubSystem(SDL_INIT_AUDIO);
        return;
    }
    SDL_ResumeAudioStreamDevice(playback_);
}

void SDLCALL Engine::playback_callback(void *data, SDL_AudioStream *stream, int additional, int) {
    auto &engine = *static_cast<Engine *>(data);
    std::array<float, mix_chunk_samples> chunk{};
    while (additional > 0) {
        const size_t count = std::min(chunk.size(), size_t(additional + 3) / sizeof(float));
        std::fill(chunk.begin(), chunk.end(), 0.f);
        engine.mix(std::span(chunk).first(count));
        SDL_PutAudioStreamData(stream, chunk.data(), int(count * sizeof(float)));
        additional -= int(count * sizeof(float));
    }
}

}  // namespace native::voice
