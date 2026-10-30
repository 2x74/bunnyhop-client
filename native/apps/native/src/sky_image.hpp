#pragma once
// Sky panoramas for the Enhanced and Cinematic looks, read the way the website reads them (web sky-packs/): a Radiance
// .hdr, a PNG or JPEG 2:1 panorama, or a .bhsky.json sky pack holding one of those. Decoding runs on a worker
// (sky_library.hpp); the result is half-float linear RGB ready for one texture upload.
//
// Directions follow the website's three.js space (Y up), where Source's (x, y, z) is (x, z, -y), so a pack's declared
// sun and the panorama's longitude mean what they mean on the website.
#include <array>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace native {

// Byte budgets (web sky-packs/manifest.ts SKY_LIMITS and client-bridge.ts CLIENT_SKY_LIMITS).
inline constexpr size_t sky_picture_max_bytes = size_t(32) * 1024 * 1024;
inline constexpr size_t sky_pack_max_bytes = size_t(45) * 1024 * 1024;
inline constexpr int sky_max_width = 4096;

enum class SkyFileKind { hdr, image, pack, unsupported };

// How cloudy a photograph is: sets how firm its sun is (web from-hdr.ts).
enum class SkyClouds { clear, sparse, photographic };

struct SkyLighting {
    bool has_sun = false, has_ambient = false;
    // Toward the sun, three.js space.
    std::array<float, 3> sun_direction{0, 1, 0};
    std::array<float, 3> sun_color{1, 1, 1};
    float sun_intensity = 0;
    std::array<float, 3> ambient_color{1, 1, 1};
    float ambient_intensity = 0;
};

struct SkyPicture {
    int width = 0, height = 0;
    // Linear RGB as IEEE half floats, rows from the top of the panorama down.
    std::vector<uint16_t> pixels;
    SkyLighting lighting;
    // The pack's own turn (radians) and brightness (a multiplier).
    float rotation = 0, exposure = 1;
};

struct SkyDecodeResult {
    std::optional<SkyPicture> picture;
    std::string error;
};

SkyFileKind sky_file_kind(std::string_view file_name);

// The sky id of a skies-folder file: folder-<name as an id>-<FNV-1a of the exact name> (web sky-packs/folder.ts).
std::string folder_sky_id(std::string_view file_name);

// A pack id from a file or HDRI name: lower case [a-z0-9_-], at most 64 characters (web sources.ts skyIdFrom).
std::string sky_id_from(std::string_view name);

// The file's name without its sky extension, as the picker shows it.
std::string sky_display_name(std::string_view file_name);

// The sun and ambient a linear RGBA float panorama declares (web from-hdr.ts skyLighting).
SkyLighting sky_lighting(std::span<const float> rgba, int width, int height, SkyClouds clouds);

// Decodes `bytes` of the given kind. Expected failures (a broken file, the wrong shape) come back as an error.
SkyDecodeResult decode_sky(std::span<const uint8_t> bytes, SkyFileKind kind, SkyClouds clouds);

uint16_t half_from_float(float value);
float float_from_half(uint16_t value);

}  // namespace native
