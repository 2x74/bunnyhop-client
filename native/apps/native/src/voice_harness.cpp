// The native client's voice chat without a window, for the local interoperability proof (tools/voice-local.ts).
// Reads the menu's messages one JSON object per line on stdin (roomEvent, voiceDown, voicePeople) plus the proof's
// own {"type": "key", "down": bool} and {"type": "report"}; writes {"type": "voiceUp", "data": base64} lines for the
// menu's socket and the report. "Talking" sends a test tone (--tone Hz) through the real encoder, and what it hears
// is mixed as the client's playback would be and checked for each talker's pitch.
#include "room_state.hpp"
#include "settings.hpp"
#include "voice_chat.hpp"
#include <atomic>
#include <chrono>
#include <cmath>
#include <iostream>
#include <map>
#include <mutex>
#include <string>
#include <thread>

using Json = nlohmann::json;
namespace voice = native::voice;

namespace {

constexpr double two_pi = 6.283185307179586;
constexpr auto loop_interval = std::chrono::milliseconds(5);
constexpr size_t mix_chunk = voice::frame_samples / 2;
constexpr size_t kept_samples = voice::sample_rate * 4;
constexpr std::array<double, 5> pitches{330, 440, 550, 660, 880};

struct Heard {
    unsigned frames = 0;
    std::vector<float> pcm;
};

std::mutex heard_mutex;
std::map<unsigned, Heard> heard;

void tap(void *, unsigned slot, std::span<const float> pcm) {
    std::lock_guard lock(heard_mutex);
    auto &talker = heard[slot];
    ++talker.frames;
    if (talker.pcm.size() < kept_samples) talker.pcm.insert(talker.pcm.end(), pcm.begin(), pcm.end());
}

double power_at(std::span<const float> pcm, double hz) {
    const double k = 2 * std::cos(two_pi * hz / voice::sample_rate);
    double s1 = 0, s2 = 0;
    for (const float sample : pcm) {
        const double s = sample + k * s1 - s2;
        s2 = s1;
        s1 = s;
    }
    return s1 * s1 + s2 * s2 - k * s1 * s2;
}

Json report(voice::VoiceChat &chat, const std::vector<float> &mixed) {
    Json out{{"type", "report"}, {"heard", Json::object()}};
    std::lock_guard lock(heard_mutex);
    for (const auto &[slot, talker] : heard) {
        // Past the encoder's first 100 ms.
        const auto skip = std::min(talker.pcm.size(), size_t(voice::sample_rate / 10));
        const std::span<const float> pcm(talker.pcm.data() + skip, talker.pcm.size() - skip);
        double best = 0, best_power = -1, total = 0;
        for (const double hz : pitches) {
            const double power = power_at(pcm, hz);
            total += power;
            if (power > best_power) best_power = power, best = hz;
        }
        Json entry{{"frames", talker.frames}, {"seconds", talker.frames * voice::frame_ms / 1000.}, {"pitch", best}};
        entry["purity"] = total > 0 ? best_power / total : 0;
        if (const auto stats = chat.engine().receiver().playout_stats(slot))
            entry["playout"] = {
                    {"played", stats->played},
                    {"dry", stats->dry},
                    {"dropped", stats->dropped},
                    {"targetMs", *chat.engine().receiver().playout_target_ms(slot)}
            };
        out["heard"][std::to_string(slot)] = entry;
    }
    double energy = 0;
    for (const float sample : mixed)
        energy += double(sample) * sample;
    out["mixedRms"] = mixed.empty() ? 0 : std::sqrt(energy / double(mixed.size()));
    out["sentPackets"] = chat.engine().sent_packets.load();
    out["sentFrames"] = chat.engine().sent_frames.load();
    out["concealed"] = chat.engine().receiver().stats.concealed;
    out["active"] = chat.active();
    return out;
}

}  // namespace

int main(int argc, char **argv) {
    float tone_hz = 550;
    for (int i = 1; i + 1 < argc; ++i)
        if (std::string(argv[i]) == "--tone") tone_hz = std::stof(argv[i + 1]);
    voice::VoiceChat chat(std::make_unique<voice::Engine>([&] { return voice::tone_source(tone_hz, .25f); }, false));
    chat.engine().receiver().tap = tap;
    chat.settings(native::default_settings());
    native::RoomState room;

    std::mutex lines_mutex;
    std::vector<std::string> lines;
    std::atomic<bool> running{true};
    std::thread reader([&] {
        std::string line;
        while (std::getline(std::cin, line)) {
            std::lock_guard lock(lines_mutex);
            lines.push_back(line);
        }
        running = false;
    });
    reader.detach();

    std::vector<float> mixed;
    const auto start = std::chrono::steady_clock::now();
    size_t mixed_samples = 0;
    while (running) {
        std::vector<std::string> batch;
        {
            std::lock_guard lock(lines_mutex);
            batch.swap(lines);
        }
        for (const auto &line : batch) {
            const auto message = Json::parse(line, nullptr, false);
            if (!message.is_object()) continue;
            const auto type = message.value("type", std::string());
            if (type == "roomEvent") {
                room.event(message);
                chat.room(room);
            } else if (type == "voiceDown" && message.value("id", std::string()) == room.id
                       && message.value("generation", uint64_t(0)) == room.generation)
                chat.receive(message.at("data").get<std::string>());
            else if (type == "voicePeople")
                chat.people(message.at("people"));
            else if (type == "key")
                chat.key("KeyX", message.at("down").get<bool>(), false);
            else if (type == "report")
                std::cout << report(chat, mixed).dump() << std::endl;
            else if (type == "quit")
                return 0;
        }
        const double now_ms =
                std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        // Playback at real time, as the audio callback would pull it.
        while (double(mixed_samples) < now_ms * voice::sample_rate / 1000) {
            std::array<float, mix_chunk> chunk{};
            chat.engine().mix(chunk);
            if (mixed.size() < kept_samples * 4) mixed.insert(mixed.end(), chunk.begin(), chunk.end());
            mixed_samples += mix_chunk;
        }
        chat.frame(now_ms, 1, true);
        for (const auto &packet : chat.outgoing(now_ms))
            std::cout << Json{{"type", "voiceUp"}, {"data", packet}}.dump() << std::endl;
        std::this_thread::sleep_for(loop_interval);
    }
    return 0;
}
