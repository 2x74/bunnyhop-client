#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <string_view>

namespace native {
template <class T, size_t Capacity>
class HudSamples {
public:
    size_t size() const { return count_; }

    bool empty() const { return count_ == 0; }

    void clear() { count_ = 0; }

    T *begin() { return values_.data(); }

    const T *begin() const { return values_.data(); }

    T *end() { return begin() + count_; }

    const T *end() const { return begin() + count_; }

    T &back() { return values_[count_ - 1]; }

    const T &back() const { return values_[count_ - 1]; }

    T &operator[](size_t index) { return values_[index]; }

    const T &operator[](size_t index) const { return values_[index]; }

    void pop_front() {
        if (count_) {
            std::move(begin() + 1, end(), begin());
            --count_;
        }
    }

    void push_back(const T &value) {
        if (count_ == Capacity) pop_front();
        values_[count_++] = value;
    }

    template <class... Args>
    void emplace_back(Args... args) {
        push_back(T{args...});
    }

private:
    std::array<T, Capacity> values_{};
    size_t count_ = 0;
};

// HUD units are 1/900 of the screen height at 100% (never under .6 px), so the built-in places are the same
// fraction of the screen at any size. The HUD scale grows them only while the screen still holds the whole layout:
// past that the elements would overlap, so the scale stops there.
inline constexpr float hud_reference_height_units = 900;
inline constexpr float hud_smallest_unit_px = .6f;
inline constexpr float hud_min_width_units = 1060;
inline constexpr float hud_min_height_units = 800;

inline float hud_scale(int width_px, int height_px, float percent) {
    const float wanted = std::clamp(std::isfinite(percent) ? percent : 100.f, 50.f, 175.f) / 100.f;
    const float base = std::max(hud_smallest_unit_px, float(height_px) / hud_reference_height_units);
    const float fits = std::min(float(width_px) / hud_min_width_units, float(height_px) / hud_min_height_units);
    return std::min(base * wanted, fits);
}

struct HudGeometry {
    float scale;
    float width;
    float height;

    HudGeometry(int w, int h, float percent) : scale(hud_scale(w, h, percent)), width(w / scale), height(h / scale) {}
};

struct HudRect {
    float x = 0;
    float y = 0;
    float width = 0;
    float height = 0;
};

struct HudPlace {
    bool visible = true;
    bool anchored = false;
    unsigned anchor = 0;
    float x = 0;
    float y = 0;
    float scale = 1;
    // False while the element sits at the native HUD's own place: only its visibility and scale come from here.
    bool placed = true;

    HudRect rect(float viewport_width, float viewport_height, float element_width, float element_height) const {
        const float horizontal = float(anchor % 3) / 2;
        const float vertical = float(anchor / 3) / 2;
        const float left = anchored ? (horizontal + x) * viewport_width - horizontal * element_width * scale
                                    : x * viewport_width / 100;
        const float top = anchored ? (vertical + y) * viewport_height - vertical * element_height * scale
                                   : y * viewport_height / 100;
        return {left, top, element_width * scale, element_height * scale};
    }
};

inline constexpr std::array<std::string_view, 32> hud_ids = {
        "crosshair",     "map",        "fps",        "timer", "speed",  "runStats", "status",        "jumpStats",
        "strafeTrainer", "splits",     "speedGraph", "keys",  "health", "notice",   "replay",        "track",
        "stage",         "sync",       "ghostKeys",  "pb",    "chat",   "startPre", "strafeOffsets", "firstJump",
        "longJump",      "spectators", "practice",   "split", "stats",  "graph",    "ammo",          "result"
};

inline std::string_view canonical_hud_id(std::string_view id) {
    if (id == "split") return "splits";
    if (id == "stats") return "runStats";
    if (id == "graph") return "speedGraph";
    if (id == "ammo") return "health";
    return id;
}

inline size_t hud_index(std::string_view id) {
    id = canonical_hud_id(id);
    for (size_t i = 0; i < hud_ids.size(); ++i) {
        if (hud_ids[i] == id) return i;
    }
    return 0;
}

// The box each element draws at element scale 1, in HUD units: anchoring, the layout editor's outlines and its
// snapping all use it. The keys row and the strafe trainer change with their settings (NativeHud::element_size).
inline std::array<float, 2> hud_element_size(std::string_view id) {
    id = canonical_hud_id(id);
    if (id == "map") return {340, 44};
    if (id == "fps") return {70, 19};
    if (id == "pb") return {100, 18};
    if (id == "timer") return {186, 46};
    if (id == "status") return {74, 20};
    if (id == "speed") return {124, 34};
    if (id == "runStats") return {300, 19};
    if (id == "jumpStats") return {300, 38};
    if (id == "strafeTrainer") return {240, 30};
    if (id == "splits") return {170, 40};
    if (id == "keys") return {292, 28};
    if (id == "health") return {154, 19};
    if (id == "speedGraph") return {260, 80};
    if (id == "notice") return {360, 21};
    if (id == "replay") return {288, 19};
    if (id == "sync") return {180, 4};
    if (id == "spectators") return {150, 56};
    if (id == "longJump") return {260, 40};
    if (id == "ghostKeys") return {180, 34};
    if (id == "strafeOffsets") return {200, 18};
    if (id == "firstJump") return {170, 18};
    if (id == "practice") return {190, 18};
    if (id == "stage" || id == "startPre") return {104, 18};
    if (id == "track") return {64, 18};
    return {240, 26};
}

}  // namespace native
