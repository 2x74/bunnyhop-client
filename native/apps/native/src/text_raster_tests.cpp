#include "text_raster.hpp"
#include <cassert>
#include <algorithm>
#include <numeric>
#include <cmath>

static size_t coverage(const native::TextBitmap &b) {
    size_t out = 0;
    assert(b.rgba.size() == size_t(b.width) * b.height * 4);
    for (size_t i = 0; i < b.rgba.size(); i += 4) {
        assert(b.rgba[i] == 255 && b.rgba[i + 1] == 255 && b.rgba[i + 2] == 255);
        out += b.rgba[i + 3];
    }
    return out;
}

int main() {
    const auto ones = native::raster_text("11111", 30, true);
    const auto eights = native::raster_text("88888", 30, true);
    assert(ones.width == eights.width && coverage(ones) > 0 && coverage(eights) > 0);

    for (const auto &line :
         {"Hello hopper", "Ünïcødé 日本語 한국어", "مرحبا بالعالم", "שלום עולם", "e\xcc\x81\x20\xf0\x9f\x90\xb0"}) {
        const auto b = native::raster_text(line, 20);
        assert(b.width > 8 && b.height >= 20 && b.width <= 4096 && b.height <= 256);
        assert(coverage(b) > 1000);
        bool transparent = false;
        for (size_t i = 3; i < b.rgba.size(); i += 4)
            transparent |= b.rgba[i] == 0;
        assert(transparent);
    }
    const auto small_text = native::raster_text("你好", 16), large = native::raster_text("你好", 32);
    assert(large.width > small_text.width && large.height > small_text.height);
    assert(native::raster_text("", 20).rgba.empty());
    assert(native::raster_text(std::string(4097, 'a'), 20).rgba.empty());
    assert(native::raster_text(std::string("a\0b", 3), 20).rgba.empty());
    assert(native::raster_text(std::string("\xff"), 20).rgba.empty());
    for (const std::string value : {"abc", "é", "👩‍👩‍👧‍👦", "क्ष", "אבג", "a אבג b", "�"}) {
        const auto bitmap = native::raster_text(value, 20);
        const auto carets = native::text_carets(value, 20);
        assert(!carets.empty());
        for (const auto &c : carets) {
            assert(c.byte <= value.size() && std::isfinite(c.x));
            assert(c.x >= -1 && c.x <= bitmap.width + 1);
        }
        const auto boxes = native::text_range_boxes(value, 20, 0, value.size());
        assert(!boxes.empty());
        for (const auto &box : boxes)
            assert(box.width > 0 && box.x >= -1 && box.x + box.width <= bitmap.width + 2);
    }
    assert(native::text_carets("é", 20).size() == 2);
    assert(native::text_carets("👩‍👩‍👧‍👦", 20).size() == 2);
    const auto rtl = native::text_carets("אבג", 20);
    assert(rtl.front().x > rtl.back().x);
    const auto mixed = native::text_carets("abc אבג def", 20);
    bool dual = false;
    for (const auto &a : mixed)
        if (a.secondary)
            for (const auto &b : mixed)
                if (!b.secondary && a.byte == b.byte && std::abs(a.x - b.x) > .5f) dual = true;
    assert(dual);

    // Orientation regression: upright F has its wide right-hand crossbar at the
    // top, not the bottom. This fails if platform scanlines/texture UVs are flipped.
    const auto upright = native::raster_text("F", 60);
    int left = upright.width, right = 0, top = upright.height, bottom = 0;
    for (int y = 0; y < upright.height; y++)
        for (int x = 0; x < upright.width; x++)
            if (upright.rgba[(size_t(y) * upright.width + x) * 4 + 3] > 64) {
                left = std::min(left, x);
                right = std::max(right, x);
                top = std::min(top, y);
                bottom = std::max(bottom, y);
            }
    assert(right > left && bottom > top);
    uint64_t upper = 0, lower = 0;
    const int band = std::max(1, (bottom - top + 1) / 3);
    for (int x = (left + right) / 2; x <= right; x++)
        for (int y = 0; y < band; y++) {
            upper += upright.rgba[(size_t(top + y) * upright.width + x) * 4 + 3];
            lower += upright.rgba[(size_t(bottom - y) * upright.width + x) * 4 + 3];
        }
    assert(upper > lower + 1020);
}
