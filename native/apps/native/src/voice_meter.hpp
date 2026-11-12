#pragma once
// Levels for the talker indicator and its audio meter: one overall level per 20 ms frame (the website's levelOf) and
// a few frequency bands from a small band-pass filter bank. Both run on the voice worker, never on the render thread.
#include "voice_wire.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <span>

namespace native::voice {

constexpr size_t meter_band_count = 8;
using Bands = std::array<float, meter_band_count>;

// -54 dBFS (room hiss) reads 0 and -12 dBFS (loud speech) reads 1, as on the website.
constexpr float meter_floor_db = -54;
constexpr float meter_range_db = 42;
constexpr float meter_silence_rms = 1e-5f;

inline float level_from_rms(float rms) {
    if (rms <= meter_silence_rms) return 0;
    const float db = 20 * std::log10(rms);
    return std::clamp((db - meter_floor_db) / meter_range_db, 0.f, 1.f);
}

inline float level_of(std::span<const float> pcm) {
    double energy = 0;
    for (const float sample : pcm)
        energy += double(sample) * sample;
    return level_from_rms(float(std::sqrt(energy / double(std::max<size_t>(1, pcm.size())))));
}

// Centre frequencies (Hz), about two thirds of an octave apart over the range a voice uses.
constexpr std::array<float, meter_band_count> meter_band_hz{100, 180, 320, 560, 1000, 1800, 3200, 5600};
constexpr float meter_band_q = 1.4f;
constexpr float pi = 3.14159265358979f;

class BandMeter {
    struct Filter {
        float b0 = 0, b2 = 0, a1 = 0, a2 = 0;
        float x1 = 0, x2 = 0, y1 = 0, y2 = 0;

        float step(float x) {
            const float y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = y;
            return y;
        }
    };

    std::array<Filter, meter_band_count> filters_{};

public:
    BandMeter() {
        // RBJ band-pass with 0 dB peak gain.
        for (size_t i = 0; i < meter_band_count; ++i) {
            const float w0 = 2 * pi * meter_band_hz[i] / float(sample_rate);
            const float alpha = std::sin(w0) / (2 * meter_band_q);
            const float a0 = 1 + alpha;
            auto &filter = filters_[i];
            filter.b0 = alpha / a0;
            filter.b2 = -alpha / a0;
            filter.a1 = -2 * std::cos(w0) / a0;
            filter.a2 = (1 - alpha) / a0;
        }
    }

    void reset() {
        for (auto &filter : filters_)
            filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0;
    }

    // Each band's level for one frame, on the same scale as level_of.
    Bands measure(std::span<const float> pcm) {
        Bands out{};
        for (size_t band = 0; band < meter_band_count; ++band) {
            double energy = 0;
            for (const float sample : pcm) {
                const float filtered = filters_[band].step(sample);
                energy += double(filtered) * filtered;
            }
            out[band] = level_from_rms(float(std::sqrt(energy / double(std::max<size_t>(1, pcm.size())))));
        }
        return out;
    }
};

}  // namespace native::voice
