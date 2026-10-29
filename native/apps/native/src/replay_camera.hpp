#pragma once
#include "bunnyhop_native.h"
#include "native_input.hpp"
#include <array>
#include <optional>
#include <chrono>
#include <functional>
#include <limits>
#include <string>
#include <vector>

namespace native {
struct CameraShot {
    double from = 0, to = 0;
    std::string kind = "chase";
    std::array<double, 3> at{};
};

struct ReplayCamera {
    using Point = std::array<double, 3>;
    std::string mode = "eye";
    std::array<float, 3> position{};
    double yaw = 0, pitch = 0;
    bool initialized = false;
    double orbit_yaw = 0, orbit_pitch = 0, zoom = 1;
    int flyby_side = 1;

private:
    static constexpr double rad = 3.14159265358979323846 / 180;
    double last_seconds = NAN, chase_yaw = NAN, chase_pitch = 0, chase_dist = NAN, chase_height = 0, chase_z = NAN;
    double eye_last_z = NAN, eye_last_view = 0, eye_error = 0, orbit_angle = NAN;
    // Orbit: a slow turn around the runner, at a fixed distance and height, that walls pull in like the chase camera.
    static constexpr double orbit_degrees_per_second = 24, orbit_distance_units = 150, orbit_height_degrees = 16;
    bool eye_last_crouch = false;
    Point fly_pos = {NAN, 0, 0}, fly_vel{}, fly_look{}, tripod_look{};
    double heading = NAN;
    std::vector<CameraShot> shots;
    int shot_index = -1;
    std::string active_mode = "eye";

    struct DirectState {
        std::vector<BhGhostFrame> path;
        std::vector<uint8_t> teleported;
        bool explicit_teleports = false;
        unsigned rate = 0;
        uint32_t t = 0, to = 0, k = 0, seed = 0, end = 0;
        BhContext *core = nullptr;
        std::vector<CameraShot> result;
        CameraShot shot;
        Point p0{}, p1{}, pm{}, candidate{}, base{};
        double direction = 0, span = 0, best = -1;
        int candidate_index = 0, los = -1, seen = 0;
        bool building = false;

        double random() {
            seed = (seed ^ (seed >> 15)) * 2246822507u + 0x9e3779b9u;
            return double(seed) / 4294967296.;
        }

        Point p(uint32_t tick) const {
            const auto &f = path[std::min(tick, uint32_t(path.size() - 1))];
            return {f.position[0], f.position[1], f.position[2] + 40.};
        }
    };

    std::optional<DirectState> director;

    static double wrap(double a) { return std::fmod(std::fmod(a + 180, 360.) + 360., 360.) - 180; }

    static double damp(double rate, double dt) { return 1 - std::exp(-rate * dt); }

    static double trace(BhContext *core, const Point &from, const Point &to, float radius) {
        if (!core) return 1;
        float a[3], b[3], fraction = 0;
        for (int k = 0; k < 3; ++k) {
            a[k] = float(from[k]);
            b[k] = float(to[k]);
        }
        return bh_trace_camera(core, a, b, radius, &fraction) ? std::clamp(double(fraction), 0., 1.) : 0;
    }

    void snap() {
        chase_yaw = chase_z = chase_dist = orbit_angle = NAN;
        eye_last_z = NAN;
        eye_error = 0;
        fly_pos[0] = heading = NAN;
    }

    void look(const Point &from, const Point &at) {
        for (int k = 0; k < 3; ++k)
            position[k] = float(from[k]);
        const double dx = at[0] - from[0], dy = at[1] - from[1], dz = at[2] - from[2];
        yaw = std::atan2(dy, dx) / rad;
        pitch = -std::atan2(dz, std::hypot(dx, dy)) / rad;
    }

public:
    bool set_mode(const std::string &value) {
        if (value != "eye" && value != "chase" && value != "free" && value != "flyby" && value != "auto"
            && value != "orbit" && value != "path" && value != "freePath")
            return false;
        const bool keep_free = value == "free" && initialized;
        mode = (value == "path" || value == "freePath") ? "flyby" : value;
        if (!keep_free) initialized = false;
        snap();
        shot_index = -1;
        last_seconds = NAN;
        return true;
    }

    void reset() {
        initialized = false;
        last_seconds = NAN;
        shot_index = -1;
        snap();
    }

    bool third_person() const { return mode == "auto" ? active_mode != "eye" : mode != "eye"; }

    void orbit(double dx, double dy) {
        orbit_yaw = wrap(orbit_yaw - dx * .3);
        orbit_pitch = std::clamp(orbit_pitch + dy * .25, -40., 70.);
    }

    void zoom_by(double factor) {
        if (std::isfinite(factor) && factor > 0) zoom = std::clamp(zoom * factor, .4, 5.);
    }

    void reset_orbit() {
        orbit_yaw = orbit_pitch = 0;
        zoom = 1;
    }

    void set_shots(std::vector<CameraShot> value) {
        shots = std::move(value);
        shot_index = -1;
        snap();
    }

    const std::vector<CameraShot> &shot_list() const { return shots; }

    // Own the captured path; callers should move it to avoid a large UI-thread copy.
    void begin_direct(
            std::vector<BhGhostFrame> path,
            unsigned rate,
            uint32_t from,
            uint32_t to,
            BhContext *core = nullptr,
            uint32_t seed_ticks = 0,
            std::vector<uint8_t> teleported = {}
    ) {
        director.emplace();
        auto &d = *director;
        d.path = std::move(path);
        d.teleported = std::move(teleported);
        d.explicit_teleports = !d.teleported.empty();
        d.rate = rate;
        d.t = from;
        d.core = core;
        d.seed = (seed_ticks ? seed_ticks : uint32_t(d.path.size())) * 2654435761u;
        d.to = rate && !d.path.empty() && from < d.path.size() ? std::min(to, uint32_t(d.path.size() - 1)) : from;
    }

    bool direct_pending() const { return director.has_value(); }

    void cancel_direct() { director.reset(); }

    // A work unit performs at most one collision trace. A single trace is atomic;
    // both bounds are checked between units, including tripod LOS candidates.
    bool step_direct(unsigned max_work = 8, double max_ms = 4) {
        if (!director) return true;
        const auto started = std::chrono::steady_clock::now();
        for (unsigned work = 0; work < std::max(1u, max_work); ++work) {
            auto &d = *director;
            if (!d.building) {
                if (d.t >= d.to) {
                    set_shots(std::move(d.result));
                    director.reset();
                    return true;
                }
                uint32_t length = uint32_t(std::floor((2.5 + d.random() * 2.5) * d.rate + .5));
                for (uint32_t i = d.t + d.rate; i < std::min(d.to, d.t + length); ++i) {
                    const auto &a = d.path[i - 1], &b = d.path[i];
                    double distance = 0;
                    for (int j = 0; j < 3; ++j)
                        distance += std::pow(b.position[j] - a.position[j], 2);
                    if ((d.explicit_teleports && i < d.teleported.size() && d.teleported[i])
                        || (!d.explicit_teleports && distance > 256 * 256)) {
                        length = i - d.t;
                        break;
                    }
                }
                if (double(d.to - std::min(d.to, d.t + length)) < d.rate * 1.5) length = d.to - d.t;
                d.end = std::min(d.to, d.t + length);
                const char *cycle[] = {"chase", "tripod", "eye", "flyby", "tripod", "chase", "flyby", "tripod"};
                d.shot = {double(d.t) / d.rate, double(d.end) / d.rate, cycle[d.k++ % 8], {}};
                if (d.shot.kind != "tripod") {
                    d.result.push_back(d.shot);
                    d.t = d.end;
                } else {
                    d.p0 = d.p(d.t);
                    d.p1 = d.p(d.end);
                    d.pm = d.p(uint32_t(std::floor(d.t + (d.end - d.t) * .62 + .5)));
                    d.direction = std::atan2(d.p1[1] - d.p0[1], d.p1[0] - d.p0[0]);
                    d.span = std::hypot(d.p1[0] - d.p0[0], d.p1[1] - d.p0[1]);
                    d.best = -1;
                    d.candidate_index = 0;
                    d.los = -1;
                    d.building = true;
                }
            } else if (d.candidate_index >= 14) {
                if (d.best < 8 * .7) d.shot.kind = "chase";
                d.result.push_back(d.shot);
                d.t = d.end;
                d.building = false;
            } else if (d.los < 0) {
                const int c = d.candidate_index, side = c % 2 ? 1 : -1;
                d.base = c < 6 ? d.p1 : d.pm;
                if (c < 6) {
                    const double ahead = 80 + d.random() * 220, off = side * d.random() * 70;
                    d.candidate = {
                            d.p1[0] + std::cos(d.direction) * ahead - std::sin(d.direction) * off,
                            d.p1[1] + std::sin(d.direction) * ahead + std::cos(d.direction) * off,
                            d.p1[2] + 60 + d.random() * 140
                    };
                } else {
                    const double angle = d.direction + side * (.6 + d.random() * .9),
                                 distance = 140 + d.span * (.25 + d.random() * .35);
                    d.candidate = {
                            d.pm[0] + std::cos(angle) * distance,
                            d.pm[1] + std::sin(angle) * distance,
                            d.pm[2] + 40 + d.random() * 120
                    };
                }
                const auto fraction = trace(d.core, d.base, d.candidate, 8);
                if (fraction < 1)
                    for (int j = 0; j < 3; ++j)
                        d.candidate[j] = d.base[j] + (d.candidate[j] - d.base[j]) * std::max(0., fraction - .05);
                if (std::hypot(
                            std::hypot(d.candidate[0] - d.base[0], d.candidate[1] - d.base[1]),
                            d.candidate[2] - d.base[2]
                    )
                    < 70)
                    ++d.candidate_index;
                else {
                    d.seen = 0;
                    d.los = 0;
                }
            } else {
                if (trace(d.core, d.candidate, d.p(uint32_t(std::floor(d.t + double(d.end - d.t) * d.los / 8 + .5))), 1)
                    > .995)
                    ++d.seen;
                if (++d.los > 8) {
                    const double score = d.seen + d.random() * .5;
                    if (score > d.best) {
                        d.best = score;
                        d.shot.at = d.candidate;
                    }
                    ++d.candidate_index;
                    d.los = -1;
                }
            }
            if (max_ms >= 0
                && std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count()
                           >= max_ms)
                break;
        }
        return false;
    }

    // Synchronous compatibility path used by deterministic oracle fixtures.
    void
    direct(const std::vector<BhGhostFrame> &path,
           unsigned rate,
           uint32_t from,
           uint32_t to,
           BhContext *core = nullptr,
           uint32_t seed_ticks = 0,
           const std::vector<uint8_t> *teleported = nullptr) {
        begin_direct(path, rate, from, to, core, seed_ticks, teleported ? *teleported : std::vector<uint8_t>{});
        while (!step_direct(4096, -1)) {
        };
    }

    void sample_orbit(BhContext *core, const BhState &s, double view_yaw, double dt) {
        orbit_angle = std::isfinite(orbit_angle) ? wrap(orbit_angle + orbit_degrees_per_second * dt) : view_yaw;
        const double a = (orbit_angle + orbit_yaw) * rad,
                     p = std::clamp(orbit_height_degrees + orbit_pitch, -60., 80.) * rad,
                     ideal = orbit_distance_units * zoom;
        const Point pivot = {s.position[0], s.position[1], s.position[2] + s.view_offset_z - 8};
        Point want = {
                pivot[0] - std::cos(a) * std::cos(p) * ideal,
                pivot[1] - std::sin(a) * std::cos(p) * ideal,
                pivot[2] + std::sin(p) * ideal
        };
        const double reach = std::max(4., ideal * trace(core, pivot, want, 6) - 2);
        for (int j = 0; j < 3; ++j)
            want[j] = pivot[j] + (want[j] - pivot[j]) * reach / ideal;
        look(want, pivot);
    }

    void move(const Input &input, double dt, bool fast = false, bool slow = false) {
        if (mode != "free" || !initialized) return;
        dt = std::clamp(dt, 0., .1);
        yaw = input.yaw();
        pitch = input.pitch;
        const double cy = std::cos(yaw * rad), sy = std::sin(yaw * rad), cp = std::cos(pitch * rad),
                     sp = std::sin(pitch * rad);
        const auto bits = input.held;
        const double f = int(bool(bits & forward)) - int(bool(bits & back)),
                     s = int(bool(bits & right)) - int(bool(bits & left)),
                     up = int(bool(bits & jump)) - int(bool(bits & duck));
        const double v = (fast ? 1600 : slow ? 120 : 500) * dt;
        position[0] += float((cp * cy * f + sy * s) * v);
        position[1] += float((cp * sy * f - cy * s) * v);
        position[2] += float((-sp * f + up) * v);
    }

    // Explicit frame_dt makes offline renders deterministic. Existing callers
    // can derive dt from their presentation clock by leaving it at -1.
    void
    sample(BhContext *core,
           const BhState &s,
           double view_yaw,
           double view_pitch,
           double seconds,
           float eye[3],
           Input &view,
           double frame_dt = -1) {
        double dt = frame_dt >= 0                 ? frame_dt
                    : std::isfinite(last_seconds) ? std::clamp(seconds - last_seconds, 0., .1)
                                                  : 0;
        last_seconds = seconds;
        dt = std::clamp(dt, 0., .1);
        if (!initialized) {
            position = {s.position[0], s.position[1], s.position[2] + s.view_offset_z};
            yaw = view_yaw;
            pitch = view_pitch;
            initialized = true;
        }
        active_mode = mode;
        if (mode == "auto") {
            int index = -1;
            for (size_t i = 0; i < shots.size(); ++i)
                if (seconds >= shots[i].from) index = int(i);
            if (index != shot_index) {
                snap();
                flyby_side = index % 2 ? 1 : -1;
                tripod_look = {s.position[0], s.position[1], s.position[2] + 40.};
                shot_index = index;
            }
            active_mode = index >= 0 ? shots[size_t(index)].kind : "chase";
        }
        if (std::isfinite(eye_last_z) && dt > 0) {
            const double dv = s.view_offset_z - eye_last_view;
            if (std::abs(dv) > std::max(1.5, 120 * dt)) eye_error -= dv;
            if (bool(s.crouched) != eye_last_crouch) {
                const double dz = s.position[2] - eye_last_z;
                if (std::abs(dz) > 3 && std::abs(dz) < 40) eye_error -= dz;
            }
            eye_error = std::clamp(eye_error * std::exp(-dt / .05), -40., 40.);
            if (std::abs(eye_error) < .01) eye_error = 0;
        }
        eye_last_z = s.position[2];
        eye_last_view = s.view_offset_z;
        eye_last_crouch = s.crouched;
        if (active_mode == "eye") {
            position = {s.position[0], s.position[1], float(s.position[2] + s.view_offset_z + eye_error)};
            yaw = view_yaw;
            pitch = view_pitch;
        } else if (active_mode == "tripod" && shot_index >= 0) {
            const double k = damp(6, dt);
            for (int j = 0; j < 3; ++j)
                tripod_look[j] += ((j == 2 ? s.position[j] + 40. : s.position[j]) - tripod_look[j]) * k;
            look(shots[size_t(shot_index)].at, tripod_look);
        } else if (active_mode == "flyby") {
            const double speed = std::hypot(s.velocity[0], s.velocity[1]),
                         travel = speed > 60 ? std::atan2(s.velocity[1], s.velocity[0]) / rad : view_yaw;
            const bool fresh = !std::isfinite(fly_pos[0]);
            if (fresh || !std::isfinite(heading))
                heading = travel;
            else
                heading += wrap(travel - heading) * damp(1.6, dt);
            const double a = heading * rad, back = 150 + std::min(120., speed * .12);
            Point pivot = {s.position[0], s.position[1], s.position[2] + 48.},
                  want = {pivot[0] - std::cos(a) * back + std::sin(a) * 95 * flyby_side,
                          pivot[1] - std::sin(a) * back - std::cos(a) * 95 * flyby_side,
                          pivot[2] + 70};
            if (core) {
                const double f = trace(core, pivot, want, 8);
                for (int j = 0; j < 3; ++j)
                    want[j] = pivot[j] + (want[j] - pivot[j]) * std::max(.15, f - .02);
            }
            if (fresh) {
                fly_pos = want;
                fly_vel = {};
                fly_look = pivot;
            } else {
                for (int j = 0; j < 3; ++j) {
                    const double x = fly_pos[j] - want[j], accel = -3.2 * 3.2 * x - 2 * 3.2 * fly_vel[j];
                    fly_vel[j] += accel * dt;
                    fly_pos[j] += fly_vel[j] * dt;
                }
                if (trace(core, pivot, fly_pos, 4) < .98) {
                    fly_pos = want;
                    fly_vel = {};
                }
                for (int j = 0; j < 3; ++j)
                    fly_look[j] += (pivot[j] - fly_look[j]) * damp(9, dt);
            }
            look(fly_pos, fly_look);
        } else if (active_mode == "orbit") {
            sample_orbit(core, s, view_yaw, dt);
        } else if (active_mode != "free") {
            const bool fresh = !std::isfinite(chase_yaw);
            const double height = s.view_offset_z - 8 + eye_error;
            if (fresh || !std::isfinite(chase_z) || std::abs(s.position[2] - chase_z) > 160)
                chase_z = s.position[2];
            else
                chase_z += (s.position[2] - chase_z) * damp(10, dt);
            if (fresh) {
                chase_yaw = view_yaw;
                chase_pitch = view_pitch;
                chase_height = height;
            } else {
                chase_yaw += wrap(view_yaw - chase_yaw) * damp(7, dt);
                chase_pitch += (view_pitch - chase_pitch) * damp(3.5, dt);
                chase_height += (height - chase_height) * damp(9, dt);
            }
            const double a = (chase_yaw + orbit_yaw) * rad,
                         p = std::clamp(14 + orbit_pitch + chase_pitch * .15, -60., 80.) * rad, ideal = 96 * zoom;
            Point pivot = {s.position[0], s.position[1], chase_z + chase_height},
                  want = {pivot[0] - std::cos(a) * std::cos(p) * ideal,
                          pivot[1] - std::sin(a) * std::cos(p) * ideal,
                          pivot[2] + std::sin(p) * ideal};
            const double target = std::max(4., ideal * trace(core, pivot, want, 6) - 2);
            if (fresh || !std::isfinite(chase_dist) || target < chase_dist)
                chase_dist = target;
            else
                chase_dist += (target - chase_dist) * damp(3, dt);
            for (int j = 0; j < 3; ++j)
                want[j] = pivot[j] + (want[j] - pivot[j]) * chase_dist / ideal;
            look(want, pivot);
        }
        std::copy(position.begin(), position.end(), eye);
        view.set_angles(pitch, yaw, 5);
    }
};
}  // namespace native
