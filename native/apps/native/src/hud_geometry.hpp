#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <string_view>

namespace native {
template <class T, size_t Capacity> class HudSamples {
  public:
    size_t size() const {
        return count_;
    }
    bool empty() const {
        return count_ == 0;
    }
    void clear() {
        count_ = 0;
    }
    T *begin() {
        return values_.data();
    }
    const T *begin() const {
        return values_.data();
    }
    T *end() {
        return begin() + count_;
    }
    const T *end() const {
        return begin() + count_;
    }
    T &back() {
        return values_[count_ - 1];
    }
    const T &back() const {
        return values_[count_ - 1];
    }
    T &operator[](size_t index) {
        return values_[index];
    }
    const T &operator[](size_t index) const {
        return values_[index];
    }
    void pop_front() {
        if (count_) {
            std::move(begin() + 1, end(), begin());
            --count_;
        }
    }
    void push_back(const T &value) {
        if (count_ == Capacity)
            pop_front();
        values_[count_++] = value;
    }
    template <class... Args> void emplace_back(Args... args) {
        push_back(T{args...});
    }

  private:
    std::array<T, Capacity> values_{};
    size_t count_ = 0;
};

struct HudGeometry {
    float scale;
    float width;
    float height;

    HudGeometry(int w, int h, float percent)
        : scale(std::max(.6f, float(h) / 900.f) * std::clamp(std::isfinite(percent) ? percent : 100.f, 50.f, 175.f) /
                100.f),
          width(w / scale), height(h / scale) {}
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

    HudRect rect(float viewport_width, float viewport_height, float element_width, float element_height) const {
        const float horizontal = float(anchor % 3) / 2;
        const float vertical = float(anchor / 3) / 2;
        const float left = anchored ? (horizontal + x) * viewport_width - horizontal * element_width * scale
                                    : x * viewport_width / 100;
        const float top =
            anchored ? (vertical + y) * viewport_height - vertical * element_height * scale : y * viewport_height / 100;
        return {left, top, element_width * scale, element_height * scale};
    }
};

inline constexpr std::array<std::string_view, 32> hud_ids = {
    "crosshair",     "map",        "fps",        "timer", "speed",  "runStats", "status",        "jumpStats",
    "strafeTrainer", "splits",     "speedGraph", "keys",  "health", "notice",   "replay",        "track",
    "stage",         "sync",       "ghostKeys",  "pb",    "chat",   "startPre", "strafeOffsets", "firstJump",
    "longJump",      "spectators", "practice",   "split", "stats",  "graph",    "ammo",          "result"};

inline std::string_view canonical_hud_id(std::string_view id) {
    if (id == "split")
        return "splits";
    if (id == "stats")
        return "runStats";
    if (id == "graph")
        return "speedGraph";
    if (id == "ammo")
        return "health";
    return id;
}

inline size_t hud_index(std::string_view id) {
    id = canonical_hud_id(id);
    for (size_t i = 0; i < hud_ids.size(); ++i) {
        if (hud_ids[i] == id)
            return i;
    }
    return 0;
}

inline std::array<float, 2> hud_element_size(std::string_view id) {
    id = canonical_hud_id(id);
    if (id == "keys")
        return {78, 88};
    if (id == "timer")
        return {108, 26};
    if (id == "speed")
        return {130, 33};
    if (id == "runStats")
        return {430, 18};
    if (id == "strafeTrainer")
        return {240, 65};
    if (id == "speedGraph")
        return {260, 80};
    if (id == "map")
        return {340, 48};
    if (id == "fps" || id == "health")
        return {110, 24};
    if (id == "sync")
        return {180, 4};
    if (id == "spectators")
        return {200, 90};
    if (id == "longJump" || id == "jumpStats")
        return {450, 44};
    return {240, 26};
}

inline HudRect scoreboard_bounds(float width, float height, size_t rows) {
    const float panel_width = std::min(1100.f, width - 32);
    const float panel_height = std::min(height - 48, 158.f + float(rows) * 36);
    return {(width - panel_width) / 2, (height - panel_height) / 2, panel_width, panel_height};
}
}
