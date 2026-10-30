#include "map_audio_scene.hpp"
#include <cstdlib>

namespace native {
namespace {
// Source sound.cpp rgdpvpreset: pitch, pitchstart, spinup/down, volrun/start, fadein/out.
constexpr std::array<std::array<int, 8>, 27> ambient_presets{
        {{255, 75, 95, 95, 10, 1, 50, 95},  {255, 85, 70, 88, 10, 1, 20, 88},  {255, 100, 50, 75, 10, 1, 10, 75},
         {100, 100, 0, 0, 10, 1, 90, 90},   {100, 100, 0, 0, 10, 1, 80, 80},   {100, 100, 0, 0, 10, 1, 50, 70},
         {100, 100, 0, 0, 5, 1, 40, 50},    {100, 100, 0, 0, 5, 1, 40, 50},    {100, 100, 0, 0, 5, 1, 40, 50},
         {128, 100, 50, 75, 10, 1, 30, 40}, {128, 100, 50, 75, 10, 1, 30, 40}, {128, 100, 50, 75, 10, 1, 30, 40},
         {50, 50, 0, 0, 10, 1, 20, 50},     {70, 70, 0, 0, 10, 1, 20, 50},     {90, 90, 0, 0, 10, 1, 20, 50},
         {120, 120, 0, 0, 10, 1, 20, 50},   {180, 180, 0, 0, 10, 1, 20, 50},   {255, 255, 0, 0, 10, 1, 20, 50},
         {200, 75, 90, 90, 10, 1, 50, 90},  {255, 75, 97, 90, 10, 1, 50, 90},  {100, 100, 0, 0, 10, 1, 30, 50},
         {160, 160, 0, 0, 10, 1, 50, 50},   {255, 75, 88, 0, 10, 1, 40, 0},    {200, 20, 95, 70, 10, 1, 70, 70},
         {180, 100, 50, 60, 10, 1, 40, 60}, {60, 60, 0, 0, 10, 1, 40, 70},     {128, 90, 10, 10, 10, 1, 20, 40}}
};
constexpr double ramp_steps_per_second = 5;
constexpr double ramp_fraction = 256;
constexpr double legacy_ramp_scale = 64;
constexpr double percent = 100;
constexpr double volume_key_scale = 10;

double ramp_seconds(double distance, double step) {
    return step > 0 ? std::max(0., distance) / (step * ramp_steps_per_second / ramp_fraction) : 0;
}

double legacy_step(double value) {
    return value > 0 ? (101 - value) * legacy_ramp_scale : 0;
}
}  // namespace

MapAmbientLevels map_ambient_levels(const nlohmann::json &entity) {
    const auto integer = [&](const char *key, double maximum) {
        const auto text = entity.value(key, std::string("0"));
        const double value = std::strtod(text.c_str(), nullptr);
        return std::isfinite(value) ? std::clamp(std::trunc(value), 0., maximum) : 0.;
    };
    double pitch = integer("pitch", 255), pitch_start = integer("pitchstart", 255);
    double spin_up = legacy_step(integer("spinup", percent));
    double spin_down = legacy_step(integer("spindown", percent));
    double volume = std::min(percent, integer("health", percent) * volume_key_scale);
    double volume_start = integer("volstart", volume_key_scale) * volume_key_scale;
    const auto fade_step = [&](const char *legacy, const char *seconds) {
        if (!entity.contains(seconds)) return legacy_step(integer(legacy, percent));
        const double value = integer(seconds, percent);
        return value > 0 ? percent * ramp_fraction / (value * ramp_steps_per_second) : 0;
    };
    double fade_in = fade_step("fadein", "fadeinsecs");
    double fade_out = fade_step("fadeout", "fadeoutsecs");
    const int preset = int(integer("preset", 100000));
    if (preset > 0 && size_t(preset) <= ambient_presets.size()) {
        const auto &values = ambient_presets[size_t(preset - 1)];
        pitch = values[0];
        pitch_start = values[1];
        spin_up = legacy_step(values[2]);
        spin_down = legacy_step(values[3]);
        volume = values[4] * volume_key_scale;
        volume_start = values[5] * volume_key_scale;
        fade_in = legacy_step(values[6]);
        fade_out = legacy_step(values[7]);
    }
    return {volume / percent,
            volume_start / percent,
            ramp_seconds(volume - volume_start, fade_in),
            ramp_seconds(volume - volume_start, fade_out),
            pitch == 0 ? percent : pitch,
            pitch_start == 0 ? percent : pitch_start,
            ramp_seconds(pitch - pitch_start, spin_up),
            ramp_seconds(pitch - pitch_start, spin_down)};
}
}  // namespace native
