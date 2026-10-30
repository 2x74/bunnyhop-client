#pragma once
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

// The 2D half of an avatar picture (the website's avatar/stage.ts paintBackdrop and render): the backdrop,
// the supersampled bunny scaled down over it, and the files it becomes. No GL here.
namespace native::avatar {

// Premultiplied RGBA8, rows top-down.
struct Picture {
    int width = 0, height = 0;
    std::vector<uint8_t> rgba;
};

struct Rgb {
    uint8_t r = 0, g = 0, b = 0;
};

// "#rrggbb" only.
std::optional<Rgb> parse_hex(std::string_view text);

// What the menu resolved spec.bg to. A studio is a top-to-bottom gradient lit from above: by the colourway's
// swatch (`glow`) for the colourway backdrop, else by a faint white.
struct Backdrop {
    enum class Kind { clear, solid, studio };
    Kind kind = Kind::clear;
    Rgb top, bottom;
    std::optional<Rgb> glow;
};

Picture paint_backdrop(const Backdrop &backdrop, int size);

// Box-filters a premultiplied picture down by a whole factor.
Picture downsample(const Picture &source, int factor);

// Source-over: `top` drawn onto `bottom` (same size).
void draw_over(Picture &bottom, const Picture &top);

// A GL read-back (rows bottom-up, the bunny drawn over a cleared transparent target) as a Picture.
Picture from_gl_rows(const std::vector<uint8_t> &rows, int width, int height);

std::string encode_png(const Picture &picture);

// The saved picture: lossless WebP, posterized a little at a time if it would go over `max_bytes`.
// Empty when even that doesn't fit.
std::string encode_avatar_webp(const Picture &picture, size_t max_bytes);

}  // namespace native::avatar
