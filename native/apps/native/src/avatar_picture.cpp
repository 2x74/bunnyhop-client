#include "avatar_picture.hpp"
#include "webp_lossless.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <zlib.h>

namespace native::avatar {
namespace {

// avatar/stage.ts paintBackdrop: the light's centre and reach as shares of the picture, and its strength.
constexpr double light_center_x = .5;
constexpr double light_center_y = .28;
constexpr double light_radius = .7;
constexpr double colourway_light_alpha = .42;
constexpr double white_light_alpha = .16;
constexpr Rgb white = {255, 255, 255};

constexpr int png_filter_sub = 1;
constexpr int png_compression_level = 6;
// Posterize steps tried when a lossless picture is too big (map-photo-like detail).
constexpr int posterize_steps[] = {2, 4, 8, 16};

struct Colour {
    double r = 0, g = 0, b = 0, a = 0;
};

Colour mix(const Colour &a, const Colour &b, double t) {
    return {a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, a.a + (b.a - a.a) * t};
}

Colour opaque(Rgb c) {
    return {double(c.r), double(c.g), double(c.b), 1};
}

// Straight-alpha `top` over an opaque `bottom`.
Colour over(const Colour &bottom, const Colour &top) {
    return {top.r * top.a + bottom.r * (1 - top.a),
            top.g * top.a + bottom.g * (1 - top.a),
            top.b * top.a + bottom.b * (1 - top.a),
            1};
}

uint8_t byte(double v) {
    return uint8_t(std::clamp(std::lround(v), 0l, 255l));
}

void put(Picture &picture, int x, int y, const Colour &premultiplied) {
    uint8_t *p = picture.rgba.data() + (size_t(y) * picture.width + x) * 4;
    p[0] = byte(premultiplied.r);
    p[1] = byte(premultiplied.g);
    p[2] = byte(premultiplied.b);
    p[3] = byte(premultiplied.a * 255);
}

Picture blank(int width, int height) {
    Picture out;
    out.width = width;
    out.height = height;
    out.rgba.assign(size_t(width) * height * 4, 0);
    return out;
}

Colour studio_pixel(const Backdrop &backdrop, int x, int y, int size) {
    const double px = x + .5, py = y + .5;
    const Colour base = mix(opaque(backdrop.top), opaque(backdrop.bottom), py / size);
    const double distance = std::hypot(px - size * light_center_x, py - size * light_center_y);
    const double t = std::clamp(distance / (size * light_radius), 0., 1.);
    Colour light = backdrop.glow ? opaque(*backdrop.glow) : opaque(white);
    light.a = backdrop.glow ? colourway_light_alpha : white_light_alpha;
    Colour fade = opaque(white);
    fade.a = 0;
    return over(base, mix(light, fade, t));
}

// Straight alpha for the encoders.
std::vector<uint8_t> straight(const Picture &picture) {
    std::vector<uint8_t> out(picture.rgba.size());
    for (size_t i = 0; i < out.size(); i += 4) {
        const unsigned a = picture.rgba[i + 3];
        out[i + 3] = uint8_t(a);
        for (int k = 0; k < 3; ++k)
            out[i + k] = a ? uint8_t(std::min(255u, (picture.rgba[i + k] * 255u + a / 2) / a)) : 0;
    }
    return out;
}

void put_be32(std::string &out, uint32_t n) {
    for (int shift = 24; shift >= 0; shift -= 8)
        out.push_back(char((n >> shift) & 0xff));
}

void png_chunk(std::string &png, const char *kind, const std::string &data) {
    put_be32(png, uint32_t(data.size()));
    const size_t start = png.size();
    png.append(kind, 4);
    png += data;
    put_be32(png, uint32_t(crc32(0, reinterpret_cast<const Bytef *>(png.data() + start), uInt(4 + data.size()))));
}

std::string png_rows(const std::vector<uint8_t> &rgba, int width, int height) {
    const size_t stride = size_t(width) * 4;
    std::string rows;
    rows.reserve((stride + 1) * height);
    for (int y = 0; y < height; ++y) {
        rows.push_back(char(png_filter_sub));
        const uint8_t *row = rgba.data() + y * stride;
        for (size_t i = 0; i < stride; ++i)
            rows.push_back(char(i < 4 ? row[i] : uint8_t(row[i] - row[i - 4])));
    }
    return rows;
}

std::vector<uint8_t> posterized(std::vector<uint8_t> rgba, int step) {
    for (size_t i = 0; i < rgba.size(); i += 4)
        for (int k = 0; k < 3; ++k)
            rgba[i + k] = uint8_t(std::min(255, (rgba[i + k] + step / 2) / step * step));
    return rgba;
}

}  // namespace

std::optional<Rgb> parse_hex(std::string_view text) {
    if (text.size() != 7 || text[0] != '#') return std::nullopt;
    uint32_t value = 0;
    for (char c : text.substr(1)) {
        const int digit = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1;
        if (digit < 0) return std::nullopt;
        value = value * 16 + uint32_t(digit);
    }
    return Rgb{uint8_t(value >> 16), uint8_t(value >> 8), uint8_t(value)};
}

Picture paint_backdrop(const Backdrop &backdrop, int size) {
    auto out = blank(size, size);
    if (backdrop.kind == Backdrop::Kind::clear) return out;
    for (int y = 0; y < size; ++y)
        for (int x = 0; x < size; ++x)
            put(out,
                x,
                y,
                backdrop.kind == Backdrop::Kind::solid ? opaque(backdrop.top) : studio_pixel(backdrop, x, y, size));
    return out;
}

Picture downsample(const Picture &source, int factor) {
    if (factor <= 1) return source;
    auto out = blank(source.width / factor, source.height / factor);
    const unsigned area = unsigned(factor * factor);
    for (int y = 0; y < out.height; ++y)
        for (int x = 0; x < out.width; ++x)
            for (int k = 0; k < 4; ++k) {
                unsigned sum = 0;
                for (int sy = 0; sy < factor; ++sy)
                    for (int sx = 0; sx < factor; ++sx)
                        sum += source.rgba[(size_t(y * factor + sy) * source.width + x * factor + sx) * 4 + k];
                out.rgba[(size_t(y) * out.width + x) * 4 + k] = uint8_t((sum + area / 2) / area);
            }
    return out;
}

void draw_over(Picture &bottom, const Picture &top) {
    if (bottom.width != top.width || bottom.height != top.height) throw std::runtime_error("Avatar layer size");
    for (size_t i = 0; i < bottom.rgba.size(); i += 4) {
        const unsigned keep = 255u - top.rgba[i + 3];
        for (int k = 0; k < 4; ++k)
            bottom.rgba[i + k] = uint8_t(std::min(255u, top.rgba[i + k] + (bottom.rgba[i + k] * keep + 127) / 255));
    }
}

Picture from_gl_rows(const std::vector<uint8_t> &rows, int width, int height) {
    auto out = blank(width, height);
    const size_t stride = size_t(width) * 4;
    for (int y = 0; y < height; ++y)
        std::copy_n(rows.data() + size_t(height - 1 - y) * stride, stride, out.rgba.data() + size_t(y) * stride);
    return out;
}

std::string encode_png(const Picture &picture) {
    const auto rows = png_rows(straight(picture), picture.width, picture.height);
    uLongf bytes = compressBound(uLong(rows.size()));
    std::string compressed(bytes, '\0');
    if (compress2(
                reinterpret_cast<Bytef *>(compressed.data()),
                &bytes,
                reinterpret_cast<const Bytef *>(rows.data()),
                uLong(rows.size()),
                png_compression_level
        )
        != Z_OK)
        throw std::runtime_error("Avatar PNG compression failed");
    compressed.resize(bytes);
    std::string png("\x89PNG\r\n\x1a\n", 8), header;
    put_be32(header, uint32_t(picture.width));
    put_be32(header, uint32_t(picture.height));
    // 8-bit RGBA, deflate, adaptive filtering, no interlace.
    header.append("\x08\x06\0\0\0", 5);
    png_chunk(png, "IHDR", header);
    png_chunk(png, "IDAT", compressed);
    png_chunk(png, "IEND", {});
    return png;
}

std::string encode_avatar_webp(const Picture &picture, size_t max_bytes) {
    const auto pixels = straight(picture);
    auto webp = encode_webp_lossless(pixels, picture.width, picture.height);
    for (const int step : posterize_steps) {
        if (webp.size() <= max_bytes) return webp;
        webp = encode_webp_lossless(posterized(pixels, step), picture.width, picture.height);
    }
    return webp.size() <= max_bytes ? webp : std::string();
}

}  // namespace native::avatar
