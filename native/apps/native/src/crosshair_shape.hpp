#pragma once
#include <algorithm>
#include <cmath>
#include <string>
#include <string_view>
#include <vector>

namespace native {
// The crosshair as the website draws it (style.css #crosshair): sizes are CSS pixels times the display scale, so it
// keeps its size whatever the HUD scale is. Every length is rounded to whole pixels and the shape is a pixel mask,
// so both arms of a pair come out the same width on any screen.
struct CrosshairRun {
    int x = 0;
    int y = 0;
    int width = 0;
    bool outline = false;
};

class CrosshairShape {
public:
    // Rebuilt only when a crosshair setting or the display scale changes; drawing just walks the runs.
    void build(std::string_view style, float size, float gap, float thickness, bool outline, float display_scale) {
        const Key key{std::string(style), size, gap, thickness, outline, display_scale};
        if (key == key_) return;
        key_ = key;
        runs_.clear();
        const float scale = std::isfinite(display_scale) && display_scale > 0 ? display_scale : 1;
        thickness_ = std::max(1, int(std::round(thickness * scale)));
        size_ = std::max(0, int(std::round(size * scale)));
        gap_ = std::max(0, int(std::round(gap * scale)));
        // Odd widths centre on the middle pixel; even widths on the line between the two middle pixels.
        odd_ = thickness_ % 2 == 1;
        reach_ = size_ + gap_ + thickness_ + outline_px + 1;
        mask_.assign(size_t(2 * reach_) * size_t(2 * reach_), cell_empty);
        if (style == "cross" || style == "cross-dot" || style == "t") fill_arms(style != "t");
        if (style == "circle") fill_ring();
        if (style == "dot") fill_disc(std::max(1, int(std::round(thickness_ * dot_diameter_per_thickness))));
        if (style == "cross-dot" || style == "circle") fill_square_dot();
        if (outline) add_outline();
        collect_runs();
    }

    const std::vector<CrosshairRun> &runs() const { return runs_; }

    // Where the crosshair's middle falls: whole pixels from the screen's top-left, ignoring Windows' extra borderless
    // row (an odd height rounds down to the even one's middle).
    static int centre_px(int length_px) { return length_px / 2; }

private:
    static constexpr float dot_diameter_per_thickness = 1.6f;
    static constexpr int outline_px = 1;
    static constexpr unsigned char cell_empty = 0;
    static constexpr unsigned char cell_fill = 1;
    static constexpr unsigned char cell_outline = 2;

    struct Key {
        std::string style;
        float size = -1;
        float gap = -1;
        float thickness = -1;
        bool outline = false;
        float display_scale = -1;

        bool operator==(const Key &) const = default;
    };

    Key key_;
    std::vector<unsigned char> mask_;
    std::vector<CrosshairRun> runs_;
    int thickness_ = 1;
    int size_ = 0;
    int gap_ = 0;
    int reach_ = 0;
    bool odd_ = false;

    unsigned char &cell(int x, int y) { return mask_[size_t(y + reach_) * size_t(2 * reach_) + size_t(x + reach_)]; }

    // [from, to) in pixels from the centre, clipped to the mask.
    void fill_rect(int left, int top, int right, int bottom) {
        for (int y = std::max(top, -reach_); y < std::min(bottom, reach_); ++y) {
            for (int x = std::max(left, -reach_); x < std::min(right, reach_); ++x)
                cell(x, y) = cell_fill;
        }
    }

    int band_start() const { return -(thickness_ / 2); }

    void fill_arms(bool top) {
        const int core = odd_ ? 1 : 0;
        const int band = band_start();
        fill_rect(-gap_ - size_, band, -gap_, band + thickness_);
        fill_rect(core + gap_, band, core + gap_ + size_, band + thickness_);
        if (top) fill_rect(band, -gap_ - size_, band + thickness_, -gap_);
        fill_rect(band, core + gap_, band + thickness_, core + gap_ + size_);
    }

    void fill_square_dot() {
        const int band = band_start();
        fill_rect(band, band, band + thickness_, band + thickness_);
    }

    // Pixels whose centres pass `inside` for their distance from the middle: a pixel's centre for odd widths, the
    // corner between four pixels for even ones.
    template <class Inside>
    void fill_round(bool odd_width, Inside inside) {
        const float middle = odd_width ? .5f : 0;
        for (int y = -reach_; y < reach_; ++y) {
            for (int x = -reach_; x < reach_; ++x) {
                const float distance = std::hypot(float(x) + .5f - middle, float(y) + .5f - middle);
                if (inside(distance)) cell(x, y) = cell_fill;
            }
        }
    }

    void fill_disc(int diameter) {
        const float radius = float(diameter) / 2;
        fill_round(diameter % 2 == 1, [radius](float distance) { return distance < radius; });
    }

    // The website's ring: a border of the crosshair's thickness whose outer edge is size + gap from the middle.
    void fill_ring() {
        const float outer = float(size_ + gap_);
        const float inner = std::max(0.f, outer - float(thickness_));
        fill_round(odd_, [outer, inner](float distance) { return distance < outer && distance >= inner; });
    }

    void add_outline() {
        for (int y = -reach_; y < reach_; ++y) {
            for (int x = -reach_; x < reach_; ++x) {
                if (cell(x, y) == cell_empty && touches_fill(x, y)) cell(x, y) = cell_outline;
            }
        }
    }

    bool touches_fill(int x, int y) {
        for (int dy = -outline_px; dy <= outline_px; ++dy) {
            for (int dx = -outline_px; dx <= outline_px; ++dx) {
                const int nx = x + dx;
                const int ny = y + dy;
                if (nx >= -reach_ && nx < reach_ && ny >= -reach_ && ny < reach_ && cell(nx, ny) == cell_fill)
                    return true;
            }
        }
        return false;
    }

    void collect_runs() {
        for (int y = -reach_; y < reach_; ++y) {
            int x = -reach_;
            while (x < reach_) {
                const unsigned char kind = cell(x, y);
                int end = x + 1;
                while (end < reach_ && cell(end, y) == kind)
                    ++end;
                if (kind != cell_empty) runs_.push_back({x, y, end - x, kind == cell_outline});
                x = end;
            }
        }
    }
};
}  // namespace native
