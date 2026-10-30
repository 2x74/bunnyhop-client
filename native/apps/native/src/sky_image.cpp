#include "sky_image.hpp"
#include "base64.hpp"
#include "bunnyhop_native.h"
#include "nlohmann/json.hpp"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <memory>
#include <numbers>
#include <regex>

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#define STBI_ONLY_HDR
#define STBI_NO_STDIO
#define STBI_FAILURE_USERMSG
#include "stb/stb_image.h"

namespace native {
namespace {

constexpr float pi = std::numbers::pi_v<float>;
// Half floats top out at 65504; the website limits sky radiance in half-float targets the same way.
constexpr float sky_radiance_limit = 60000;
constexpr int lighting_width = 512;
constexpr float aspect_slack = .02f;
constexpr int minimum_height = 256;

struct StbFree {
    void operator()(void *pixels) const { stbi_image_free(pixels); }
};

std::string lower(std::string_view text) {
    std::string out(text);
    for (auto &c : out)
        c = char(std::tolower(static_cast<unsigned char>(c)));
    return out;
}

bool ends_with(std::string_view text, std::string_view suffix) {
    return text.size() >= suffix.size() && text.substr(text.size() - suffix.size()) == suffix;
}

// UTF-16 code units of a UTF-8 string, which is what the website's FNV hash walks over.
std::vector<uint16_t> utf16_units(std::string_view text) {
    std::vector<uint16_t> units;
    for (size_t i = 0; i < text.size();) {
        const auto lead = static_cast<unsigned char>(text[i]);
        const int length = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
        uint32_t code = length == 1 ? lead : length == 2 ? lead & 0x1f : length == 3 ? lead & 0x0f : lead & 0x07;
        for (int k = 1; k < length && i + size_t(k) < text.size(); k++)
            code = code << 6 | (static_cast<unsigned char>(text[i + size_t(k)]) & 0x3f);
        i += size_t(length);
        if (code >= 0x10000) {
            code -= 0x10000;
            units.push_back(uint16_t(0xd800 + (code >> 10)));
            units.push_back(uint16_t(0xdc00 + (code & 0x3ff)));
        } else
            units.push_back(uint16_t(code));
    }
    return units;
}

std::string fnv_hex(std::string_view text) {
    uint32_t hash = 0x811c9dc5;
    for (const uint16_t unit : utf16_units(text))
        hash = (hash ^ unit) * 0x01000193u;
    char out[9]{};
    std::snprintf(out, sizeof(out), "%08x", hash);
    return out;
}

float srgb_to_linear(float value) {
    return value <= .04045f ? value / 12.92f : std::pow((value + .055f) / 1.055f, 2.4f);
}

bool is_webp(std::span<const uint8_t> bytes) {
    return bytes.size() >= 12 && std::memcmp(bytes.data(), "RIFF", 4) == 0
           && std::memcmp(bytes.data() + 8, "WEBP", 4) == 0;
}

// Linear float RGBA of w x h, with every channel kept under the half-float limit.
struct FloatImage {
    int width = 0, height = 0;
    std::vector<float> rgba;
};

FloatImage decode_hdr(std::span<const uint8_t> bytes) {
    int w = 0, h = 0, channels = 0;
    std::unique_ptr<float, StbFree> pixels(
            stbi_loadf_from_memory(bytes.data(), int(bytes.size()), &w, &h, &channels, 4)
    );
    if (!pixels) throw std::runtime_error("That .hdr file couldn't be read.");
    if (w != 2 * h) throw std::runtime_error("A sky .hdr must be a 2:1 panorama.");
    if (w > sky_max_width) throw std::runtime_error("That sky is too big. Use the 2k or 4k version.");
    FloatImage image{w, h, std::vector<float>(pixels.get(), pixels.get() + size_t(w) * h * 4)};
    return image;
}

FloatImage decode_picture(std::span<const uint8_t> bytes) {
    if (is_webp(bytes)) throw std::runtime_error("WebP skies don't load in the desktop client. Use PNG, JPEG or .hdr.");
    int w = 0, h = 0, channels = 0;
    std::unique_ptr<uint8_t, StbFree> pixels(
            stbi_load_from_memory(bytes.data(), int(bytes.size()), &w, &h, &channels, 4)
    );
    if (!pixels) throw std::runtime_error("That picture couldn't be read.");
    std::array<float, 256> table{};
    for (int i = 0; i < 256; i++)
        table[size_t(i)] = srgb_to_linear(float(i) / 255);
    FloatImage image{w, h, std::vector<float>(size_t(w) * h * 4)};
    const uint8_t *source = pixels.get();
    for (size_t i = 0; i < image.rgba.size(); i++)
        image.rgba[i] = i % 4 == 3 ? 1 : table[source[i]];
    return image;
}

// Bilinear resample of a linear RGBA image, for panoramas that aren't exactly 2:1 or are too wide.
FloatImage resample(const FloatImage &from, int width, int height) {
    if (from.width == width && from.height == height) return from;
    FloatImage to{width, height, std::vector<float>(size_t(width) * height * 4)};
    for (int y = 0; y < height; y++) {
        const float sy = std::clamp((y + .5f) * from.height / height - .5f, 0.f, float(from.height - 1));
        const int y0 = int(sy), y1 = std::min(y0 + 1, from.height - 1);
        const float fy = sy - float(y0);
        for (int x = 0; x < width; x++) {
            const float sx = std::clamp((x + .5f) * from.width / width - .5f, 0.f, float(from.width - 1));
            const int x0 = int(sx), x1 = std::min(x0 + 1, from.width - 1);
            const float fx = sx - float(x0);
            for (int c = 0; c < 4; c++) {
                auto at = [&](int px, int py) {
                    return from.rgba[(size_t(py) * from.width + px) * 4 + c];
                };
                const float top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
                const float bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
                to.rgba[(size_t(y) * width + x) * 4 + c] = top + (bottom - top) * fy;
            }
        }
    }
    return to;
}

// web from-image.ts skyImageSize: 2:1 within 2%, at least 256 tall, at most 4096 wide.
FloatImage panorama_shape(FloatImage image) {
    const float aspect = float(image.width) / float(std::max(1, image.height));
    if (std::abs(aspect - 2) > 2 * aspect_slack)
        throw std::runtime_error(
                "A sky picture must be a 2:1 panorama (like 4096x2048). This one is " + std::to_string(image.width)
                + "x" + std::to_string(image.height) + "."
        );
    if (image.height < minimum_height) throw std::runtime_error("That picture is too small for a sky.");
    const int height = std::min(sky_max_width / 2, int(std::lround(std::min(float(image.height), image.width / 2.f))));
    return resample(image, 2 * height, height);
}

SkyPicture to_picture(const FloatImage &image) {
    SkyPicture picture;
    picture.width = image.width;
    picture.height = image.height;
    picture.pixels.resize(size_t(image.width) * image.height * 3);
    for (size_t i = 0, o = 0; i < image.rgba.size(); i += 4)
        for (int c = 0; c < 3; c++)
            picture.pixels[o++] = half_from_float(std::clamp(image.rgba[i + size_t(c)], 0.f, sky_radiance_limit));
    return picture;
}

SkyPicture picture_with_lighting(const FloatImage &image, bool from_hdr, SkyClouds clouds) {
    auto picture = to_picture(image);
    if (from_hdr) {
        picture.lighting = sky_lighting(image.rgba, image.width, image.height, clouds);
    } else {
        // web from-image.ts: the sun of a small linear copy (a picture's sun is at most 1.0).
        const auto small = resample(image, lighting_width, lighting_width / 2);
        picture.lighting = sky_lighting(small.rgba, small.width, small.height, clouds);
    }
    return picture;
}

bool finite_in(const nlohmann::json &value, double low, double high) {
    if (!value.is_number()) return false;
    const double number = value.get<double>();
    return std::isfinite(number) && number >= low && number <= high;
}

std::optional<std::array<float, 3>> pack_color(const nlohmann::json &value) {
    if (!value.is_array() || value.size() != 3) return std::nullopt;
    std::array<float, 3> color{};
    for (size_t k = 0; k < 3; k++) {
        if (!finite_in(value[k], 0, 16)) return std::nullopt;
        color[k] = value[k].get<float>();
    }
    return color;
}

// A pack's declared lighting, checked like web sky-packs/manifest.ts validateSkyPack.
SkyLighting pack_lighting(const nlohmann::json &pack) {
    SkyLighting lighting;
    if (!pack.contains("lighting")) return lighting;
    const auto &declared = pack.at("lighting");
    if (declared.contains("sun")) {
        const auto &sun = declared.at("sun");
        const auto &direction = sun.value("direction", nlohmann::json());
        const auto color = pack_color(sun.value("color", nlohmann::json()));
        if (!direction.is_array() || direction.size() != 3 || !color || !finite_in(sun.value("intensity", -1.), 0, 8))
            throw std::runtime_error("Invalid sky sun metadata");
        float length = 0;
        for (size_t k = 0; k < 3; k++) {
            if (!finite_in(direction[k], -1, 1)) throw std::runtime_error("Invalid sky sun metadata");
            lighting.sun_direction[k] = direction[k].get<float>();
            length += lighting.sun_direction[k] * lighting.sun_direction[k];
        }
        if (std::abs(std::sqrt(length) - 1) > .01f) throw std::runtime_error("Invalid sky sun metadata");
        lighting.has_sun = true;
        lighting.sun_color = *color;
        lighting.sun_intensity = sun.at("intensity").get<float>();
    }
    if (declared.contains("ambient")) {
        const auto &ambient = declared.at("ambient");
        const auto color = pack_color(ambient.value("color", nlohmann::json()));
        if (!color || !finite_in(ambient.value("intensity", -1.), 0, 2))
            throw std::runtime_error("Invalid sky ambient metadata");
        lighting.has_ambient = true;
        lighting.ambient_color = *color;
        lighting.ambient_intensity = ambient.at("intensity").get<float>();
    }
    return lighting;
}

std::string sha256_hex(std::span<const uint8_t> bytes) {
    char out[65]{};
    if (!bh_sha256(bytes.data(), bytes.size(), out)) throw std::runtime_error("Sky hash failed");
    return out;
}

FloatImage pack_asset(const nlohmann::json &asset) {
    static const std::regex hash_pattern("^[a-f0-9]{64}$");
    const auto mime = asset.value("mime", std::string());
    const auto sha = asset.value("sha256", std::string());
    const int width = asset.value("width", 0), height = asset.value("height", 0);
    if (!std::regex_match(sha, hash_pattern) || width < 1 || height < 1 || width > sky_max_width
        || height > sky_max_width || width != 2 * height)
        throw std::runtime_error("Invalid sky image");
    const auto &data = asset.at("data");
    if (!data.is_string()) throw std::runtime_error("Invalid sky image");
    const auto bytes = base64_decode(data.get_ref<const std::string &>());
    if (!bytes) throw std::runtime_error("Invalid sky base64");
    const std::span<const uint8_t> view(reinterpret_cast<const uint8_t *>(bytes->data()), bytes->size());
    if (sha256_hex(view) != sha) throw std::runtime_error("Sky asset hash mismatch");
    FloatImage image;
    if (mime == "image/vnd.radiance")
        image = decode_hdr(view);
    else if (mime == "image/png" || mime == "image/webp")
        image = decode_picture(view);
    else
        throw std::runtime_error("Invalid sky image");
    if (image.width != width || image.height != height) throw std::runtime_error("Sky dimensions differ from manifest");
    return image;
}

SkyPicture decode_pack(std::span<const uint8_t> bytes) {
    if (bytes.size() > sky_pack_max_bytes) throw std::runtime_error("That sky file is over 45 MB.");
    nlohmann::json pack;
    try {
        pack = nlohmann::json::parse(bytes.begin(), bytes.end());
    } catch (const nlohmann::json::exception &) {
        throw std::runtime_error("That isn't a sky pack (it isn't JSON).");
    }
    if (!pack.is_object() || pack.value("schemaVersion", 0) != 1 || pack.value("kind", "") != "bunnyhop-sky")
        throw std::runtime_error("That isn't a sky pack.");
    const auto format = pack.value("format", std::string());
    if (format == "cube") throw std::runtime_error("Cube sky packs don't load in the desktop client yet.");
    if (format != "equirect" || !pack.contains("asset") || !pack.at("asset").is_object())
        throw std::runtime_error("Invalid sky pack manifest");
    const auto rotation = pack.value("rotation", nlohmann::json(0)),
               exposure = pack.value("exposure", nlohmann::json(0));
    if (!finite_in(rotation, -360, 360) || !finite_in(exposure, -8, 8))
        throw std::runtime_error("Invalid sky rotation/exposure");
    auto picture = to_picture(pack_asset(pack.at("asset")));
    picture.lighting = pack_lighting(pack);
    picture.rotation = rotation.get<float>() * pi / 180;
    picture.exposure = std::exp2(exposure.get<float>());
    return picture;
}

}  // namespace

SkyFileKind sky_file_kind(std::string_view file_name) {
    const auto name = lower(file_name);
    if (ends_with(name, ".hdr")) return SkyFileKind::hdr;
    if (ends_with(name, ".png") || ends_with(name, ".jpg") || ends_with(name, ".jpeg") || ends_with(name, ".webp"))
        return SkyFileKind::image;
    if (ends_with(name, ".json")) return SkyFileKind::pack;
    return SkyFileKind::unsupported;
}

std::string sky_id_from(std::string_view name) {
    auto text = lower(name);
    static const std::regex extension("\\.[a-z]+$"), invalid("[^a-z0-9_-]+"), edges("^[-_]+|[-_]+$");
    text = std::regex_replace(text, extension, "");
    text = std::regex_replace(text, invalid, "-");
    text = std::regex_replace(text, edges, "");
    text = text.substr(0, 64);
    return text.empty() ? "sky" : text;
}

std::string folder_sky_id(std::string_view file_name) {
    std::string base(file_name);
    if (ends_with(lower(base), ".bhsky.json")) base.resize(base.size() - std::string_view(".bhsky.json").size());
    return "folder-" + sky_id_from(base).substr(0, 47) + "-" + fnv_hex(file_name);
}

std::string sky_display_name(std::string_view file_name) {
    static const std::regex extension("\\.bhsky\\.json$|\\.(hdr|png|jpe?g|webp)$", std::regex::icase);
    auto name = std::regex_replace(std::string(file_name), extension, "");
    return name.empty() ? std::string(file_name) : name;
}

SkyLighting sky_lighting(std::span<const float> rgba, int width, int height, SkyClouds clouds) {
    float brightest = 0, weight = 0;
    size_t index = 0;
    std::array<double, 3> ambient{};
    for (int y = 0; 2 * y < height; y++) {
        const float a = std::cos((.5f - (y + .5f) / float(height)) * pi);
        for (int x = 0; x < width; x++) {
            const size_t i = (size_t(y) * width + x) * 4;
            const float l = rgba[i] * .2126f + rgba[i + 1] * .7152f + rgba[i + 2] * .0722f;
            if (l > brightest) {
                brightest = l;
                index = i;
            }
            for (size_t k = 0; k < 3; k++)
                ambient[k] += std::min(rgba[i + k], 2.f) * a;
            weight += a;
        }
    }
    const size_t pixel = index / 4;
    const int x = int(pixel % size_t(width)), y = int(pixel / size_t(width));
    const float latitude = (.5f - (y + .5f) / float(height)) * pi, longitude = ((x + .5f) / width - .5f) * 2 * pi;
    SkyLighting lighting;
    lighting.has_sun = lighting.has_ambient = true;
    lighting.sun_direction = {
            std::cos(latitude) * std::cos(longitude), std::sin(latitude), std::cos(latitude) * std::sin(longitude)
    };
    const float peak = std::max({rgba[index], rgba[index + 1], rgba[index + 2]});
    for (size_t k = 0; k < 3; k++)
        lighting.sun_color[k] = rgba[index + k] / (peak > 0 ? peak : 1);
    double ambient_peak = 0;
    for (auto &channel : ambient) {
        channel /= weight > 0 ? weight : 1;
        ambient_peak = std::max(ambient_peak, channel);
    }
    for (size_t k = 0; k < 3; k++)
        lighting.ambient_color[k] = float(ambient[k] / (ambient_peak > 0 ? ambient_peak : 1));
    const bool clear = clouds == SkyClouds::clear;
    lighting.sun_intensity = clear ? 1 : .8f;
    lighting.ambient_intensity = clear ? .28f : .3f;
    return lighting;
}

SkyDecodeResult decode_sky(std::span<const uint8_t> bytes, SkyFileKind kind, SkyClouds clouds) {
    try {
        switch (kind) {
            case SkyFileKind::hdr:
                if (bytes.size() > sky_picture_max_bytes)
                    return {std::nullopt, "That sky is too big. Use the 2k version."};
                return {picture_with_lighting(decode_hdr(bytes), true, clouds), {}};
            case SkyFileKind::image:
                if (bytes.size() > sky_picture_max_bytes) return {std::nullopt, "That picture is over 32 MB."};
                return {picture_with_lighting(panorama_shape(decode_picture(bytes)), false, clouds), {}};
            case SkyFileKind::pack:
                return {decode_pack(bytes), {}};
            case SkyFileKind::unsupported:
                break;
        }
        return {std::nullopt, "Skies are 2:1 panoramas (.hdr, PNG or JPEG) or .bhsky.json sky packs."};
    } catch (const std::exception &e) {
        return {std::nullopt, e.what()};
    }
}

uint16_t half_from_float(float value) {
    uint32_t bits = 0;
    std::memcpy(&bits, &value, sizeof(bits));
    const uint32_t sign = (bits >> 16) & 0x8000;
    const int exponent = int((bits >> 23) & 0xff) - 127 + 15;
    uint32_t mantissa = bits & 0x7fffff;
    if (exponent <= 0) {
        if (exponent < -10) return uint16_t(sign);
        mantissa |= 0x800000;
        const int shift = 14 - exponent;
        const uint32_t rounded = (mantissa + (1u << (shift - 1))) >> shift;
        return uint16_t(sign | rounded);
    }
    if (exponent >= 31) return uint16_t(sign | 0x7bff);
    const uint32_t rounded = (uint32_t(exponent) << 10 | mantissa >> 13) + ((mantissa >> 12) & 1);
    return uint16_t(sign | std::min<uint32_t>(rounded, 0x7bff));
}

float float_from_half(uint16_t value) {
    const uint32_t sign = uint32_t(value & 0x8000) << 16;
    const uint32_t exponent = (value >> 10) & 0x1f, mantissa = value & 0x3ff;
    float result = 0;
    if (exponent == 0)
        result = std::ldexp(float(mantissa), -24);
    else if (exponent == 31)
        result = mantissa ? std::numeric_limits<float>::quiet_NaN() : std::numeric_limits<float>::infinity();
    else
        result = std::ldexp(float(mantissa | 0x400), int(exponent) - 25);
    uint32_t bits = 0;
    std::memcpy(&bits, &result, sizeof(bits));
    bits |= sign;
    std::memcpy(&result, &bits, sizeof(bits));
    return result;
}

}  // namespace native
