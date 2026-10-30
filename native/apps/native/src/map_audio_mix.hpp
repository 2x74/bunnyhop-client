#pragma once
#include "audio_pack.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <mutex>
#include <numbers>
#include <span>

namespace native {
inline constexpr size_t map_voice_limit = 32;
inline constexpr double map_assign_seconds = .2;
inline constexpr double map_min_audible = 1.01e-3;
inline constexpr double map_scape_fade_seconds = 3;
inline constexpr size_t map_decoded_byte_limit = 128000000;
inline constexpr int map_mixer_rate = 22050;
inline constexpr double map_reference_units = 36;
inline constexpr double map_reference_db = 60;
inline constexpr double map_radius_db = 40;
inline constexpr double map_db_scale = 20;
inline constexpr double map_swap_seconds = .05;
inline constexpr float map_slider_exponent = 1.7f;

inline int map_sound_level(double radius, bool everywhere) {
    if (!(radius > 0) || everywhere) return 0;
    return int(std::trunc(map_radius_db + map_db_scale * std::log10(radius / map_reference_units)));
}

inline double map_reference_distance(double level) {
    return map_reference_units * std::pow(10., (level - map_reference_db) / map_db_scale);
}

inline double map_distance_gain(double level, double distance) {
    if (!level) return 1;
    const double reference = map_reference_distance(level);
    return distance <= reference ? 1 : reference / distance;
}

inline std::array<float, 2>
map_pan_gains(const std::array<float, 3> &source, const std::array<float, 3> &listener, double yaw, double pitch) {
    constexpr double radians_per_degree = std::numbers::pi / 180;
    const double yaw_radians = yaw * radians_per_degree;
    const double pitch_radians = pitch * radians_per_degree;
    const double dx = double(source[0]) - listener[0];
    const double dy = double(source[1]) - listener[1];
    const double dz = double(source[2]) - listener[2];
    const double side = dx * std::sin(yaw_radians) - dy * std::cos(yaw_radians);
    const double forward = (dx * std::cos(yaw_radians) + dy * std::sin(yaw_radians)) * std::cos(pitch_radians)
                           - dz * std::sin(pitch_radians);
    const double projected_distance = std::hypot(side, forward);
    // WebAudio's equal-power panner projects onto the listener's plane and folds rear azimuths into +/-90 degrees.
    const double azimuth = projected_distance > 0 ? std::asin(std::clamp(side / projected_distance, -1., 1.)) : 0;
    const double angle = (azimuth + std::numbers::pi / 2) / 2;
    return {float(std::cos(angle)), float(std::sin(angle))};
}

struct MapLoop {
    int64_t start = -1;
    int64_t end = -1;
};

MapLoop map_wave_loop(std::span<const unsigned char> bytes);

struct MapAudioFile {
    std::string path;
    DecodedAudio audio;
    MapLoop loop;
};

inline double map_loop_cursor(double cursor, const MapAudioFile &file) {
    const double frames = double(file.audio.samples.size() / size_t(file.audio.channels));
    if (file.loop.start >= 0 && cursor >= file.loop.end) {
        const double length = double(file.loop.end - file.loop.start);
        return file.loop.start + std::fmod(cursor - file.loop.start, length);
    }
    return std::clamp(cursor, 0., frames);
}

// This pool is separate from Audio's 48 movement/weapon voices. Its pointers refer to the installed map's bank.
class MapAudioMixer {
public:
    struct Voice {
        const MapAudioFile *file = nullptr;
        size_t sound = SIZE_MAX;
        double cursor = 0;
        double rate = 1;
        double target_rate = 1;
        float left = 0;
        float right = 0;
        float target_left = 0;
        float target_right = 0;
        bool releasing = false;
    };

    std::mutex mutex;
    std::array<Voice, map_voice_limit + 8> voices{};

    void clear() { voices = {}; }

    void release(size_t sound) {
        for (auto &voice : voices) {
            if (voice.sound != sound) continue;
            voice.sound = SIZE_MAX;
            voice.releasing = true;
            voice.target_left = 0;
            voice.target_right = 0;
        }
    }

    Voice *acquire(size_t sound, const MapAudioFile &file, double seconds, double rate) {
        Voice *available = nullptr;
        for (auto &voice : voices) {
            if (!voice.file) {
                available = &voice;
                break;
            }
            if (voice.releasing && (!available || voice.left + voice.right < available->left + available->right))
                available = &voice;
        }
        if (!available) return nullptr;
        *available = {};
        available->file = &file;
        available->sound = sound;
        available->rate = available->target_rate = rate;
        available->cursor = map_loop_cursor(std::max(0., seconds * rate * file.audio.rate), file);
        return available;
    }

    void mix(float *output, size_t count, float master) {
        std::lock_guard lock(mutex);
        const float smoothing = float(1 - std::exp(-1. / (map_swap_seconds * map_mixer_rate)));
        constexpr float quiet_gain = 1e-5f;
        for (auto &voice : voices) {
            if (!voice.file) continue;
            const auto &file = *voice.file;
            const auto &audio = file.audio;
            const auto frames = audio.samples.size() / size_t(audio.channels);
            for (size_t i = 0; i < count; ++i) {
                voice.cursor = map_loop_cursor(voice.cursor, file);
                if (voice.cursor >= frames
                    || (voice.releasing && std::abs(voice.left) < quiet_gain && std::abs(voice.right) < quiet_gain)) {
                    voice = {};
                    break;
                }
                const size_t at = size_t(voice.cursor);
                size_t next = std::min(at + 1, frames - 1);
                if (file.loop.start >= 0 && next >= size_t(file.loop.end)) next = size_t(file.loop.start);
                const float fraction = float(voice.cursor - at);
                const auto sample = [&](size_t channel) {
                    const float first = audio.samples[at * size_t(audio.channels) + channel];
                    const float second = audio.samples[next * size_t(audio.channels) + channel];
                    return first + (second - first) * fraction;
                };
                voice.left += (voice.target_left - voice.left) * smoothing;
                voice.right += (voice.target_right - voice.right) * smoothing;
                voice.rate += (voice.target_rate - voice.rate) * smoothing;
                output[i * 2] += sample(0) * voice.left * master;
                output[i * 2 + 1] += sample(audio.channels == 1 ? 0 : 1) * voice.right * master;
                voice.cursor += voice.rate * audio.rate / map_mixer_rate;
            }
        }
    }
};
}  // namespace native
