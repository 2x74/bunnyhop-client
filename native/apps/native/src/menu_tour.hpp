#pragma once
// The web menu's cinematic map tour (apps/web/src/attract.ts TourDirector),
// in Source coordinates (Z up, yaw in degrees). Pure: no GL, SDL or core. The
// caller supplies the map's entities and a clear-distance probe; the backdrop
// uses bh_trace_camera on its own map context for that.
#include "nlohmann/json.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <functional>
#include <sstream>
#include <string>
#include <vector>

namespace native::tour {
using Vec = std::array<double, 3>;
struct Anchor { Vec pos; double yaw = 0; };
struct Shot { Vec from, to; double yaw = 0, sway = 0; };  // yaw/sway in radians
struct Pose { Vec eye; double yaw = 0, pitch = 0; };      // degrees; Source pitch is positive down

constexpr double eye_height = 64, shot_seconds = 7.5, fade_out = .55, fade_in = .08;
constexpr double pi = 3.14159265358979323846;
// THREE.PerspectiveCamera(62) is vertical; Renderer::camera scales Source's
// fixed 4:3 projection, so this horizontal-at-4:3 value gives the same lens.
inline float renderer_fov() { return float(2 * std::atan(4.0 / 3.0 * std::tan(31 * pi / 180)) * 180 / pi); }

// Intl.Collator(undefined,{numeric:true,sensitivity:"base"}): digit runs
// compare by value and letters ignore case, so t2 < t10.
inline int natural_compare(const std::string &a, const std::string &b) {
    size_t i = 0, j = 0;
    while (i < a.size() && j < b.size()) {
        const unsigned char ca = a[i], cb = b[j];
        if (std::isdigit(ca) && std::isdigit(cb)) {
            size_t ei = i, ej = j;
            while (ei < a.size() && std::isdigit(static_cast<unsigned char>(a[ei]))) ++ei;
            while (ej < b.size() && std::isdigit(static_cast<unsigned char>(b[ej]))) ++ej;
            size_t si = i, sj = j;
            while (si + 1 < ei && a[si] == '0') ++si;
            while (sj + 1 < ej && b[sj] == '0') ++sj;
            if (ei - si != ej - sj) return ei - si < ej - sj ? -1 : 1;
            for (; si < ei; ++si, ++sj) if (a[si] != b[sj]) return a[si] < b[sj] ? -1 : 1;
            i = ei; j = ej;
            continue;
        }
        const int la = std::tolower(ca), lb = std::tolower(cb);
        if (la != lb) return la < lb ? -1 : 1;
        ++i; ++j;
    }
    return i < a.size() ? 1 : j < b.size() ? -1 : 0;
}

inline std::vector<double> numbers(const nlohmann::json &e, const char *key) {
    std::vector<double> out;
    if (!e.contains(key) || !e[key].is_string()) return out;
    std::istringstream in(e[key].get<std::string>());
    std::string word;
    while (in >> word) {
        try { size_t used = 0; const double n = std::stod(word, &used); out.push_back(used == word.size() ? n : NAN); }
        catch (...) { out.push_back(NAN); }
    }
    return out;
}

// Checkpoints in course order, else spawns ahead of them; near-duplicates
// (spawn grids, stacked destinations) within 160 units are dropped.
inline std::vector<Anchor> anchors(const nlohmann::json &entities) {
    auto pick = [&](auto matches) {
        std::vector<std::pair<std::string, Anchor>> found;
        if (!entities.is_array()) return std::vector<Anchor>{};
        for (const auto &e : entities) {
            if (!e.is_object()) continue;
            const auto cls = e.contains("classname") && e["classname"].is_string() ? e["classname"].get<std::string>() : std::string();
            if (!matches(cls) || !e.contains("origin")) continue;
            const auto o = numbers(e, "origin"), a = numbers(e, "angles");
            if (o.size() < 3 || !std::isfinite(o[0]) || !std::isfinite(o[1]) || !std::isfinite(o[2])) continue;
            const auto name = e.contains("targetname") && e["targetname"].is_string() ? e["targetname"].get<std::string>() : std::string();
            found.push_back({name, {{o[0], o[1], o[2]}, a.size() > 1 && std::isfinite(a[1]) ? a[1] : 0}});
        }
        std::stable_sort(found.begin(), found.end(), [](const auto &x, const auto &y) { return natural_compare(x.first, y.first) < 0; });
        std::vector<Anchor> out;
        for (auto &f : found) out.push_back(f.second);
        return out;
    };
    auto list = pick([](const std::string &c) { return c == "info_teleport_destination"; });
    if (list.size() < 2) {
        auto spawns = pick([](const std::string &c) {
            return c == "info_player_start" || c == "info_player_counterterrorist" || c == "info_player_terrorist";
        });
        spawns.insert(spawns.end(), list.begin(), list.end());
        list = std::move(spawns);
    }
    std::vector<Anchor> out;
    for (const auto &a : list) {
        const bool nearby_anchor = std::any_of(out.begin(), out.end(), [&](const Anchor &b) {
            return std::hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) < 160;
        });
        if (!nearby_anchor) out.push_back(a);
    }
    return out;
}

// Clear distance from `from` along unit `dir`, at most `max`.
using Probe = std::function<double(const Vec &from, const Vec &dir, double max)>;

inline std::vector<Shot> shots(const std::vector<Anchor> &list, const Probe &free) {
    std::vector<Shot> out;
    const Vec up{0, 0, 1};
    auto add = [](Vec a, const Vec &d, double s) { for (int k = 0; k < 3; ++k) a[k] += d[k] * s; return a; };
    for (const auto &a : list) {
        const double yaw = a.yaw * pi / 180;
        const Vec dir{std::cos(yaw), std::sin(yaw), 0}, back_dir{-dir[0], -dir[1], 0};
        const Vec eye{a.pos[0], a.pos[1], a.pos[2] + eye_height};
        const double ahead = free(eye, dir, 900), behind = free(eye, back_dir, 120), ceil = free(eye, up, 220);
        const double rise = std::max(0.0, std::min(110.0, ceil - 28));
        const double back = std::max(0.0, std::min(56.0, behind - 24));
        const double len = std::max(0.0, std::min(560.0, ahead - 150));
        const Vec from = add(add(eye, dir, -back), up, std::min(18.0, rise));
        const Vec to = add(add(eye, dir, len), up, rise);
        out.push_back({from, to, yaw, (out.size() % 2 ? 1 : -1) * .12});
    }
    if (out.empty()) {
        // No entities to go by: the web's slow pass across the origin.
        out.push_back({{-400, 0, 200}, {400, 0, 280}, 0, .1});
    }
    return out;
}

inline Pose place(const Shot &s, double u) {
    Pose p;
    for (int k = 0; k < 3; ++k) p.eye[k] = s.from[k] + (s.to[k] - s.from[k]) * u;
    p.yaw = (s.yaw + s.sway * (u - .5)) * 180 / pi;
    p.pitch = (.1 + .06 * u) * 180 / pi;
    return p;
}

// One camera clock: advance(dt) in seconds; cut() is the fade-through-black
// window around each change of shot (only with more than one shot).
class Director {
    std::vector<Shot> list;
    size_t index = 0;
    double t = 0;
public:
    explicit Director(std::vector<Shot> s) : list(std::move(s)) { if (list.empty()) list = shots({}, {}); }
    size_t count() const { return list.size(); }
    void advance(double dt) {
        if (!std::isfinite(dt) || dt <= 0) return;
        t += std::min(dt, .1);
        if (t >= shot_seconds) { t -= shot_seconds; index = (index + 1) % list.size(); }
    }
    bool cut() const { return list.size() > 1 && (t > shot_seconds - fade_out || t < fade_in); }
    Pose pose() const { return place(list[index], t / shot_seconds); }
    // Reduced motion and static captures: the web still() frame.
    Pose still() const { return place(list[std::min<size_t>(1, list.size() - 1)], .35); }
};
}
