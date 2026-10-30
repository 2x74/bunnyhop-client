#pragma once
// The bunny holding a gun in third person, as the website poses it (player/bunny/gun-hold.ts): where the gun sits,
// both arms reaching it by two-bone IK, and the gestures others read from a distance (shot kick, reload, draw).
// It runs on the skinning matrices after the animation, the acting layer and the inspect, and writes the gun mesh's
// own two bones (the gun and the magazine), which native appends after the rig's.
//
// Each gun's hold data (the grip baked into the right fist, the support hand's places, the butt and muzzle) comes from
// the website's gunHoldData through export-viewmodels.ts, so only the per-frame pose is computed here. Matrices are
// 3x4 row-major: a point p maps to (row r) . (p, 1). Model space is Source's axes before the feet's yaw.
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace native_gun {
using M34 = std::array<double, 12>;
using V3 = std::array<double, 3>;

constexpr double pi = 3.14159265358979323846;
constexpr double radians_per_degree = pi / 180;

inline V3 add(const V3 &a, const V3 &b) {
    return {a[0] + b[0], a[1] + b[1], a[2] + b[2]};
}

inline V3 sub(const V3 &a, const V3 &b) {
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

inline V3 scaled(const V3 &a, double s) {
    return {a[0] * s, a[1] * s, a[2] * s};
}

inline double dot(const V3 &a, const V3 &b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

inline double length(const V3 &a) {
    return std::sqrt(dot(a, a));
}

inline V3 cross(const V3 &a, const V3 &b) {
    return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}

// The website's norm3: a zero vector stays zero (divided by 1).
inline V3 normalized(const V3 &a) {
    const double l = length(a);
    return scaled(a, 1 / (l > 0 ? l : 1));
}

inline V3 origin(const M34 &m) {
    return {m[3], m[7], m[11]};
}

inline void set_origin(M34 &m, const V3 &o) {
    m[3] = o[0];
    m[7] = o[1];
    m[11] = o[2];
}

inline V3 transform(const M34 &m, const V3 &p) {
    return {m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
            m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
            m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]};
}

inline V3 rotate(const M34 &m, const V3 &v) {
    return {m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
            m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
            m[8] * v[0] + m[9] * v[1] + m[10] * v[2]};
}

inline M34 concat(const M34 &a, const M34 &b) {
    M34 out{};
    for (int r = 0; r < 3; ++r) {
        const double a0 = a[r * 4], a1 = a[r * 4 + 1], a2 = a[r * 4 + 2], a3 = a[r * 4 + 3];
        out[r * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8];
        out[r * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
        out[r * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
        out[r * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3;
    }
    return out;
}

// Rigid inverse.
inline M34 inverse(const M34 &m) {
    const V3 t = origin(m);
    return {m[0],
            m[4],
            m[8],
            -(m[0] * t[0] + m[4] * t[1] + m[8] * t[2]),
            m[1],
            m[5],
            m[9],
            -(m[1] * t[0] + m[5] * t[1] + m[9] * t[2]),
            m[2],
            m[6],
            m[10],
            -(m[2] * t[0] + m[6] * t[1] + m[10] * t[2])};
}

// A frame with rotation columns a = up, b = forward made perpendicular to a, c = a x b, at origin o.
inline M34 frame(const V3 &o, const V3 &up, const V3 &forward) {
    const V3 a = normalized(up), f = normalized(forward);
    const V3 b = normalized(sub(f, scaled(a, dot(f, a))));
    const V3 c = cross(a, b);
    M34 out{};
    for (int r = 0; r < 3; ++r) {
        out[r * 4] = a[r];
        out[r * 4 + 1] = b[r];
        out[r * 4 + 2] = c[r];
        out[r * 4 + 3] = o[r];
    }
    return out;
}

// Rotation about a unit axis through a pivot.
inline M34 rotation_about(const V3 &axis, double angle, const V3 &pivot) {
    const double c = std::cos(angle), s = std::sin(angle), t = 1 - c;
    const double x = axis[0], y = axis[1], z = axis[2];
    M34 out = {
            t * x * x + c,
            t * x * y - s * z,
            t * x * z + s * y,
            0,
            t * x * y + s * z,
            t * y * y + c,
            t * y * z - s * x,
            0,
            t * x * z - s * y,
            t * y * z + s * x,
            t * z * z + c,
            0
    };
    for (int r = 0; r < 3; ++r)
        out[r * 4 + 3] = pivot[r] - (out[r * 4] * pivot[0] + out[r * 4 + 1] * pivot[1] + out[r * 4 + 2] * pivot[2]);
    return out;
}

// The shortest rotation taking direction a to direction b about pivot p, or nothing when they're parallel.
inline std::optional<M34> swing(const V3 &a, const V3 &b, const V3 &p) {
    const double la = length(a), lb = length(b);
    if (la < 1e-9 || lb < 1e-9) return std::nullopt;
    const V3 axis = cross(a, b);
    const double s = length(axis) / (la * lb), c = dot(a, b) / (la * lb);
    if (s < 1e-9) return std::nullopt;
    return rotation_about(normalized(axis), std::atan2(s, c), p);
}

inline double smooth(double t) {
    return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

// 0 -> 1 over [a, b], smoothstepped.
inline double ramp(double t, double a, double b) {
    return smooth((t - a) / (b - a));
}

enum class GunClass { pistol, smg, rifle, shotgun, sniper };

// Kick per class: muzzle flip (deg), push back (units), spring stiffness and damping.
struct Kick {
    double flip, back, stiffness, damping;
};

inline Kick kick_of(GunClass cls) {
    switch (cls) {
        case GunClass::pistol:
            return {9, 1.1, 330, .42};
        case GunClass::smg:
            return {3.2, .7, 520, .5};
        case GunClass::rifle:
            return {4.5, 1.1, 420, .45};
        case GunClass::shotgun:
            return {9, 2.0, 240, .4};
        case GunClass::sniper:
            return {10, 2.4, 200, .38};
    }
    return {9, 1.1, 330, .42};
}

struct Pump {
    double at = 0, duration = 0;
};

// One gun's hold, exported from the website's gunHoldData (export-viewmodels.ts gunHolds).
struct GunHoldData {
    GunClass cls = GunClass::pistol;
    bool long_gun = false;
    double scale = 1;
    // Gun-local -> bunny bind space, and the right fist's frame on the grip (bind space) with its inverse.
    M34 bake{}, grip{}, grip_inverse{};
    // Fist frames on the gun (fist-local -> gun-local): right grip, left support, magazine / port / rack / bolt.
    M34 right{}, left{};
    std::optional<M34> mag, port, rack, bolt;
    V3 butt{}, muzzle{};
    std::optional<V3> silencer_tip;
    V3 eject_point{}, eject_direction{};
    std::optional<double> reload_seconds, shell_seconds;
    std::optional<Pump> pump;
};

struct Fists {
    M34 right{}, left{}, right_inverse{}, left_inverse{};
};

inline M34 json_matrix(const nlohmann::json &value);
inline V3 json_vector(const nlohmann::json &value);
inline GunHoldData parse_hold(const nlohmann::json &value);
inline Fists parse_fists(const nlohmann::json &value);

// The rig the hold poses: bone names, parents and bind matrices (export-viewmodels.ts actorRig).
struct Rig {
    std::span<const std::string> names;
    std::span<const int> parents;
    std::span<const float> bind;
    size_t cs_bones = 0;
    Fists fists;

    int bone(std::string_view name) const;
};

// What the hold reads from the frame. Angles in degrees; yaw relative to the feet, pitch positive down.
struct HoldInput {
    double yaw = 0, pitch = 0, dt = 0;
    bool snap = false;
    // Potato: the hold stays, the gestures simplify (cosmeticsStill).
    bool still = false;
};

struct Spring {
    double x = 0, v = 0;
};

inline void step_spring(Spring &spring, double stiffness, double damping, double dt);

struct Arm {
    int upper = -1, fore = -1, hand = -1;
    std::vector<int> upper_sub, fore_sub, hand_sub, fingers;
    double upper_length = 0, fore_length = 0;
    // The bind forearm direction (elbow -> wrist), unit.
    V3 forearm{};
    double side = 1;
};

class GunHold {
public:
    // The gun mesh's two bones (bind -> posed, 3x4 each): the gun, then the magazine.
    std::array<float, 24> skin{};
    // Posed model-space muzzle and the barrel's direction, the ejection port and its throw (after apply).
    V3 muzzle{}, barrel{}, port{}, throw_direction{};
    bool silenced = false;

    explicit GunHold(const Rig &rig);

    const GunHoldData *data() const { return data_; }

    // The gun in hand (null: none); `draw` plays the draw (a switch or pickup, not a model appearing).
    void set_gun(const GunHoldData *data, bool draw);
    // A shot; `jitter_flip` and `jitter_roll` are uniform randoms in [0, 1).
    void shot(double jitter_flip, double jitter_roll);
    // A reload started (`seconds` long), or one shell went in; `empty`: rack at the end.
    void reload(double seconds, bool shell = false, bool empty = false);
    // Poses both arms on the gun in `skinning` (12 floats per bone) and writes `skin`. `arms_free`: the arms keep
    // their pose and the gun rides the right hand (the avatar editor's gestures).
    void apply(std::span<float> skinning, const HoldInput &input, bool arms_free = false);

private:
    struct ReloadPhase {
        double t = 0, cant = 0, dip = 0, inward = 0, lower = 0;
    };

    const Rig &rig_;
    std::array<Arm, 2> arms_;
    int chest_ = -1, neck_ = -1, pelvis_ = -1;
    std::vector<int> chest_sub_, neck_sub_;
    const GunHoldData *data_ = nullptr;
    Spring flip_, back_;
    double roll_ = 0, roll_sign_ = 1;
    double reload_t_ = -1, cant_k_ = 0, reload_length_ = 0;
    bool reload_shell_ = false, reload_empty_ = false;
    double draw_t_ = -1, since_shot_ = 9;
    bool want_draw_ = false, mag_held_ = false;
    std::array<double, 2> gap_{};
    // The aim frame (forward, right, up) and the gun's posed frame.
    V3 aim_{}, right_{}, up_{};
    M34 gun_{}, grip_pose_{}, fist_right_{}, fist_left_{}, mag_inverse_{};

    std::vector<int> descendants(int root) const;
    Arm make_arm(char side) const;
    V3 bind_origin(int bone) const;
    V3 joint(std::span<const float> skinning, int bone) const;
    static M34 load(std::span<const float> skinning, int bone);
    static void store(std::span<float> skinning, int bone, const M34 &m);
    static void pre(std::span<float> skinning, const std::vector<int> &bones, const M34 &m);
    void reset();
    void advance_clocks(const HoldInput &input);
    void aim(const HoldInput &input);
    void blade(std::span<float> skinning, double want);
    void place_by(const V3 &point, const V3 &at);
    void turn_gun(int axis, double angle, const V3 &pivot);
    M34 fist_on(const M34 &grip) const;
    double pistol_reach(const V3 &base, const V3 &shoulder, const V3 &direction);
    V3 place_gun(std::span<float> skinning, const HoldInput &input, const std::optional<ReloadPhase> &phase);
    void reach(std::span<float> skinning, const Arm &arm, const M34 &fist, int k, double soft);
    void solve_arm(std::span<float> skinning, const Arm &arm, M34 &target, int k);
    void twist_forearm(std::span<float> skinning, const Arm &arm);
    void mirror_fingers(std::span<float> skinning);
    void slide_left_into_reach(std::span<const float> skinning);
    void bolt_right();
    void pump_left();
    ReloadPhase reload_phase() const;
    void reload_left(std::span<const float> skinning, double t);
    static void blend_fist(M34 &fist, const M34 &target, double k);
    void points();
};

namespace hold_detail {

inline constexpr double twist_share = .75;
// Soft grip (deg): how far a fist may turn on its grip toward the forearm's line (the gun stays put).
inline constexpr double soft_pistol_degrees = 8;
inline constexpr double soft_long_degrees = 20;
inline constexpr double soft_support_degrees = 25;
// Long guns: the grip at least this share of the arm's length from the shoulder.
inline constexpr double min_grip_share = .5;
// Stance (deg): the shoulders' line turned from square to the aim, left shoulder forward.
inline constexpr double blade_long_degrees = 32;
inline constexpr double blade_pistol_degrees = 10;
inline constexpr double max_blade_degrees = 40;
inline constexpr double draw_seconds = .42;
inline constexpr double shell_tail_seconds = .35;
inline constexpr double cant_ease_out_seconds = .22;
inline constexpr double cant_rate = 11;
inline constexpr double spring_step_seconds = 1. / 240;
inline constexpr double pump_window_seconds = .9;

inline GunClass class_of(std::string_view name) {
    if (name == "smg") return GunClass::smg;
    if (name == "rifle") return GunClass::rifle;
    if (name == "shotgun") return GunClass::shotgun;
    if (name == "sniper") return GunClass::sniper;
    return GunClass::pistol;
}

inline std::optional<M34> optional_matrix(const nlohmann::json &value, const char *key) {
    const auto found = value.find(key);
    if (found == value.end() || found->is_null()) return std::nullopt;
    return json_matrix(*found);
}

inline std::optional<double> optional_number(const nlohmann::json &value, const char *key) {
    const auto found = value.find(key);
    if (found == value.end() || !found->is_number()) return std::nullopt;
    return found->get<double>();
}

}  // namespace hold_detail

using namespace hold_detail;

inline M34 json_matrix(const nlohmann::json &value) {
    if (!value.is_array() || value.size() != 12) throw std::runtime_error("Invalid gun hold matrix");
    M34 out{};
    for (size_t i = 0; i < 12; ++i)
        out[i] = value[i].get<double>();
    return out;
}

inline V3 json_vector(const nlohmann::json &value) {
    if (!value.is_array() || value.size() != 3) throw std::runtime_error("Invalid gun hold point");
    return {value[0].get<double>(), value[1].get<double>(), value[2].get<double>()};
}

inline GunHoldData parse_hold(const nlohmann::json &value) {
    GunHoldData d;
    d.cls = class_of(value.at("cls").get<std::string>());
    d.long_gun = value.at("long").get<bool>();
    d.scale = value.at("scale").get<double>();
    d.bake = json_matrix(value.at("bake"));
    d.grip = json_matrix(value.at("grip"));
    d.grip_inverse = json_matrix(value.at("gripInv"));
    d.right = json_matrix(value.at("right"));
    d.left = json_matrix(value.at("left"));
    d.mag = optional_matrix(value, "mag");
    d.port = optional_matrix(value, "port");
    d.rack = optional_matrix(value, "rack");
    d.bolt = optional_matrix(value, "bolt");
    d.butt = json_vector(value.at("butt"));
    d.muzzle = json_vector(value.at("muzzle"));
    if (value.contains("silencerTip") && !value["silencerTip"].is_null())
        d.silencer_tip = json_vector(value["silencerTip"]);
    d.eject_point = json_vector(value.at("eject").at("point"));
    d.eject_direction = json_vector(value.at("eject").at("direction"));
    d.reload_seconds = optional_number(value, "reload");
    d.shell_seconds = optional_number(value, "shellEach");
    const auto pump = value.find("pump");
    if (pump != value.end() && pump->is_object())
        d.pump = Pump{pump->at("at").get<double>(), pump->at("dur").get<double>()};
    return d;
}

inline Fists parse_fists(const nlohmann::json &value) {
    return {json_matrix(value.at("R")),
            json_matrix(value.at("L")),
            json_matrix(value.at("Rinv")),
            json_matrix(value.at("Linv"))};
}

// The website's rig.bone: a short name means the ValveBiped bone.
inline int Rig::bone(std::string_view name) const {
    std::string full = name.find('.') == std::string_view::npos ? "ValveBiped.Bip01_" : "";
    full += name;
    for (size_t i = 0; i < names.size(); ++i)
        if (names[i] == full) return int(i);
    throw std::runtime_error("Gun hold: the rig has no " + full);
}

inline void step_spring(Spring &spring, double stiffness, double damping, double dt) {
    const double c = 2 * damping * std::sqrt(stiffness);
    const int steps = std::max(1, int(std::ceil(dt / spring_step_seconds)));
    const double h = dt / steps;
    for (int i = 0; i < steps; ++i) {
        spring.v += (-stiffness * spring.x - c * spring.v) * h;
        spring.x += spring.v * h;
    }
}

inline GunHold::GunHold(const Rig &rig) : rig_(rig) {
    arms_ = {make_arm('R'), make_arm('L')};
    chest_ = rig_.bone("Spine2");
    chest_sub_ = descendants(chest_);
    neck_ = rig_.bone("Neck1");
    neck_sub_ = descendants(neck_);
    pelvis_ = rig_.bone("Pelvis");
}

// A bone and everything under it among the CS bones (the ears and knife are left alone).
inline std::vector<int> GunHold::descendants(int root) const {
    std::vector<int> out{root};
    for (size_t i = size_t(root) + 1; i < rig_.cs_bones; ++i)
        if (std::find(out.begin(), out.end(), rig_.parents[i]) != out.end()) out.push_back(int(i));
    return out;
}

inline V3 GunHold::bind_origin(int bone) const {
    const auto o = size_t(bone) * 12;
    return {rig_.bind[o + 3], rig_.bind[o + 7], rig_.bind[o + 11]};
}

inline Arm GunHold::make_arm(char side) const {
    const std::string prefix(1, side);
    Arm arm;
    arm.upper = rig_.bone(prefix + "_UpperArm");
    arm.fore = rig_.bone(prefix + "_Forearm");
    arm.hand = rig_.bone(prefix + "_Hand");
    arm.upper_sub = descendants(arm.upper);
    arm.fore_sub = descendants(arm.fore);
    arm.hand_sub = descendants(arm.hand);
    arm.fingers.assign(arm.hand_sub.begin() + 1, arm.hand_sub.end());
    const V3 shoulder = bind_origin(arm.upper), elbow = bind_origin(arm.fore), wrist = bind_origin(arm.hand);
    arm.upper_length = length(sub(elbow, shoulder));
    arm.fore_length = length(sub(wrist, elbow));
    arm.forearm = normalized(sub(wrist, elbow));
    arm.side = side == 'R' ? 1 : -1;
    return arm;
}

inline V3 GunHold::joint(std::span<const float> skinning, int bone) const {
    const M34 m = load(skinning, bone);
    return transform(m, bind_origin(bone));
}

inline M34 GunHold::load(std::span<const float> skinning, int bone) {
    M34 out{};
    for (size_t i = 0; i < 12; ++i)
        out[i] = skinning[size_t(bone) * 12 + i];
    return out;
}

inline void GunHold::store(std::span<float> skinning, int bone, const M34 &m) {
    for (size_t i = 0; i < 12; ++i)
        skinning[size_t(bone) * 12 + i] = float(m[i]);
}

// Premultiplies m onto each bone.
inline void GunHold::pre(std::span<float> skinning, const std::vector<int> &bones, const M34 &m) {
    for (const int bone : bones)
        store(skinning, bone, concat(m, load(skinning, bone)));
}

inline void GunHold::set_gun(const GunHoldData *data, bool draw) {
    if (data == data_) return;
    data_ = data;
    reload_t_ = -1;
    flip_ = back_ = {};
    since_shot_ = 9;
    want_draw_ = draw && data;
}

inline void GunHold::shot(double jitter_flip, double jitter_roll) {
    if (!data_) return;
    const auto k = kick_of(data_->cls);
    // Impulses sized so the first peak is about `flip` / `back` (an underdamped spring peaks near v / sqrt(k)).
    flip_.v += k.flip * std::sqrt(k.stiffness) * (.85 + jitter_flip * .3);
    back_.v += k.back * std::sqrt(k.stiffness);
    roll_sign_ = -roll_sign_;
    roll_ = roll_sign_ * (.4 + jitter_roll * .6);
    since_shot_ = 0;
    // A shot cancels a tube gun's loading, not a magazine reload.
    if (reload_shell_) reload_t_ = -1;
}

inline void GunHold::reload(double seconds, bool shell, bool empty) {
    if (!data_) return;
    if (shell) {
        reload_shell_ = true;
        reload_length_ = std::clamp(seconds, .25, 1.2);
        reload_t_ = 0;
        return;
    }
    reload_shell_ = data_->shell_seconds.has_value();
    reload_length_ = std::clamp(seconds, .3, 6.);
    reload_empty_ = empty;
    reload_t_ = 0;
}

inline void GunHold::reset() {
    reload_t_ = -1;
    draw_t_ = -1;
    flip_ = back_ = {};
    since_shot_ = 9;
}

inline void GunHold::advance_clocks(const HoldInput &input) {
    const double dt = input.snap ? 0 : input.dt;
    if (input.snap) reset();
    if (want_draw_) {
        want_draw_ = false;
        if (!input.snap && !input.still) draw_t_ = 0;
    }
    if (input.still) {
        flip_ = back_ = {};
    } else {
        const auto k = kick_of(data_->cls);
        step_spring(flip_, k.stiffness, k.damping, dt);
        step_spring(back_, k.stiffness * .8, k.damping + .1, dt);
    }
    since_shot_ += dt;
    if (draw_t_ >= 0 && (draw_t_ += dt) > draw_seconds) draw_t_ = -1;
    const double length = reload_shell_ ? reload_length_ + shell_tail_seconds : reload_length_;
    if (reload_t_ >= 0) {
        reload_t_ += dt;
        if (reload_t_ > length) reload_t_ = -1;
    }
    // The reload's cant eases in and out (and holds between a tube gun's shells).
    const double want = reload_t_ >= 0 && reload_t_ < length - cant_ease_out_seconds ? 1 : 0;
    cant_k_ = input.still || input.snap ? want : cant_k_ + (want - cant_k_) * (1 - std::exp(-cant_rate * dt));
}

// The aim frame: forward along the aim, right, and up perpendicular to it.
inline void GunHold::aim(const HoldInput &input) {
    const double yaw = input.yaw * radians_per_degree;
    const double pitch = std::clamp(input.pitch < 0 ? input.pitch * .82 : input.pitch, -60., 75.) * radians_per_degree;
    const double cy = std::cos(yaw), sy = std::sin(yaw), cp = std::cos(pitch), sp = std::sin(pitch);
    aim_ = {cp * cy, cp * sy, -sp};
    right_ = {sy, -cy, 0};
    up_ = cross(right_, aim_);
}

inline void GunHold::apply(std::span<float> skinning, const HoldInput &input, bool arms_free) {
    if (!data_) return;
    const auto &d = *data_;
    if (arms_free) {
        // The gun rides the right hand (its bake is the hand's bind): both bones take the hand's matrix.
        for (size_t i = 0; i < 12; ++i)
            skin[i] = skin[12 + i] = skinning[size_t(arms_[0].hand) * 12 + i];
        points();
        return;
    }
    advance_clocks(input);
    aim(input);
    blade(skinning, d.long_gun ? blade_long_degrees : blade_pistol_degrees);
    const auto phase = reload_t_ >= 0 || cant_k_ > .001 ? std::optional(reload_phase()) : std::nullopt;
    place_gun(skinning, input, phase);
    // Bone 0: bind -> posed, the right hand's skinning matrix while it grips (fist on the grip * fist bind^-1).
    fist_right_ = fist_on(d.right);
    grip_pose_ = concat(fist_right_, d.grip_inverse);
    for (size_t i = 0; i < 12; ++i)
        skin[i] = skin[12 + i] = float(grip_pose_[i]);
    if (d.bolt && !input.still) bolt_right();
    reach(skinning,
          arms_[0],
          fist_right_,
          0,
          (d.long_gun ? soft_long_degrees : soft_pistol_degrees) * radians_per_degree);
    fist_left_ = fist_on(d.left);
    mag_held_ = false;
    if (phase && reload_t_ >= 0 && !input.still)
        reload_left(skinning, phase->t);
    else if (since_shot_ < pump_window_seconds && d.cls == GunClass::shotgun && d.pump)
        pump_left();
    slide_left_into_reach(skinning);
    reach(skinning, arms_[1], fist_left_, 1, soft_support_degrees * radians_per_degree);
    // The magazine in the left fist where the hand actually got to.
    if (mag_held_) {
        const M34 hand = concat(load(skinning, arms_[1].hand), rig_.fists.left);
        const M34 bone = concat(concat(hand, mag_inverse_), grip_pose_);
        for (size_t i = 0; i < 12; ++i)
            skin[12 + i] = float(bone[i]);
    }
    mirror_fingers(skinning);
    points();
}

// Places the gun: its rotation along the aim, its pivot (a pistol's fist, a long gun's butt), then the gestures as
// turns about that pivot (kick, reload cant, draw dip). Returns the pivot.
inline V3
GunHold::place_gun(std::span<float> skinning, const HoldInput &input, const std::optional<ReloadPhase> &phase) {
    const auto &d = *data_;
    const auto &arm = arms_[0];
    const V3 right_shoulder = joint(skinning, arms_[0].upper), left_shoulder = joint(skinning, arms_[1].upper);
    for (int r = 0; r < 3; ++r) {
        gun_[r * 4] = aim_[r];
        gun_[r * 4 + 1] = -right_[r];
        gun_[r * 4 + 2] = up_[r];
    }
    ReloadPhase pose = phase.value_or(ReloadPhase{});
    if (draw_t_ >= 0) {
        const double k = 1 - smooth(draw_t_ / draw_seconds);
        pose.dip += 55 * k;
        pose.lower += 4 * k;
        pose.inward += 2 * k;
    }
    const double high = std::clamp(-input.pitch / 55, 0., 1.);
    V3 pivot{};
    if (d.long_gun) {
        // The butt in the right shoulder's pocket: in toward the chest, a little forward and down.
        const double flat = std::hypot(aim_[0], aim_[1]);
        const double hz = flat > 0 ? flat : 1;
        for (int r = 0; r < 3; ++r)
            pivot[r] = right_shoulder[r] - right_[r] * (3.2 + pose.inward - high * 6)
                       + (r < 2 ? aim_[r] / hz * (1.6 + high * 5) : 0) - (r == 2 ? 1.2 + pose.lower + high * 5 : 0);
        place_by(d.butt, pivot);
        // A short stock puts the grip almost on the shoulder: slide the gun forward until the grip is far enough.
        const V3 grip = sub(add(origin(gun_), scaled(rotate(gun_, origin(d.right)), d.scale)), right_shoulder);
        const double least = min_grip_share * (arm.upper_length + arm.fore_length);
        if (dot(grip, grip) < least * least) {
            const double along = dot(grip, aim_), squared = dot(grip, grip);
            const double t = -along + std::sqrt(std::max(0., along * along - squared + least * least));
            set_origin(gun_, add(origin(gun_), scaled(aim_, t)));
            pivot = add(pivot, scaled(aim_, t));
        }
    } else {
        // Pistols: both hands out in front, a little right of the chest's middle, below the shoulders.
        for (int r = 0; r < 3; ++r)
            pivot[r] = (right_shoulder[r] + left_shoulder[r]) / 2 + right_[r] * (1.2 - pose.inward)
                       - (r == 2 ? 4.5 + pose.lower : 0);
        const double held_pitch =
                std::clamp(input.pitch < 0 ? input.pitch * .82 : input.pitch, -60., 75.) * radians_per_degree;
        const double hands_pitch = held_pitch * (held_pitch < 0 ? .6 : .9);
        const double yaw = input.yaw * radians_per_degree;
        const V3 reach_direction = {
                std::cos(hands_pitch) * std::cos(yaw), std::cos(hands_pitch) * std::sin(yaw), -std::sin(hands_pitch)
        };
        pivot = add(pivot, scaled(reach_direction, pistol_reach(pivot, right_shoulder, reach_direction)));
        place_by(origin(d.right), pivot);
    }
    const double flip = flip_.x - pose.dip;
    if (flip != 0) turn_gun(1, -flip * radians_per_degree, pivot);
    if (pose.cant != 0) turn_gun(0, pose.cant * radians_per_degree, pivot);
    if (roll_ != 0 && !input.still) turn_gun(0, roll_ * flip_.x * .08 * radians_per_degree, pivot);
    if (back_.x != 0) set_origin(gun_, sub(origin(gun_), scaled(aim_, back_.x)));
    return pivot;
}

// Turns the chest about the vertical so the shoulders' line makes `want` degrees with the aim's right axis (left
// shoulder forward), at most max_blade_degrees either way; the neck turns back so the head keeps facing the aim.
inline void GunHold::blade(std::span<float> skinning, double want) {
    const V3 right_shoulder = joint(skinning, arms_[0].upper), left_shoulder = joint(skinning, arms_[1].upper);
    const double lx = left_shoulder[0] - right_shoulder[0], ly = left_shoulder[1] - right_shoulder[1];
    const double flat = std::hypot(aim_[0], aim_[1]);
    const double hz = flat > 0 ? flat : 1;
    const double current =
            std::atan2((lx * aim_[0] + ly * aim_[1]) / hz, -(lx * right_[0] + ly * right_[1])) / radians_per_degree;
    const double delta = std::clamp(want - current, -max_blade_degrees, max_blade_degrees) * radians_per_degree;
    if (std::abs(delta) < 1e-4) return;
    constexpr V3 vertical = {0, 0, 1};
    pre(skinning, chest_sub_, rotation_about(vertical, -delta, joint(skinning, chest_)));
    pre(skinning, neck_sub_, rotation_about(vertical, delta, joint(skinning, neck_)));
}

// Sets the gun's translation so gun-local `point` lands on posed `at`.
inline void GunHold::place_by(const V3 &point, const V3 &at) {
    set_origin(gun_, sub(at, scaled(rotate(gun_, point), data_->scale)));
}

// Turns the gun about its own axis (0 x, 1 y, 2 z) by `angle` about posed `pivot`.
inline void GunHold::turn_gun(int axis, double angle, const V3 &pivot) {
    const V3 direction = {gun_[size_t(axis)], gun_[4 + size_t(axis)], gun_[8 + size_t(axis)]};
    gun_ = concat(rotation_about(direction, angle, pivot), gun_);
}

// Pistols: how far along the aim the fist goes so the right forearm continues the hand's line (a straight wrist),
// the elbow just short of locked.
inline double GunHold::pistol_reach(const V3 &base, const V3 &shoulder, const V3 &direction) {
    const auto &d = *data_;
    const auto &arm = arms_[0];
    place_by(origin(d.right), base);
    const M34 hand = concat(fist_on(d.right), d.grip_inverse);
    const V3 wrist = transform(hand, bind_origin(arm.hand));
    const V3 offset = sub(sub(wrist, scaled(rotate(hand, arm.forearm), arm.fore_length)), shoulder);
    const double along = dot(offset, direction), squared = dot(offset, offset), reach = .97 * arm.upper_length;
    const double disc = along * along - squared + reach * reach;
    const double t = disc > 0 ? -along + std::sqrt(disc) : -along;
    return std::clamp(t, 4., 26.);
}

// The posed fist frame (fist-local -> posed) of a grip (fist-local -> gun-local) on the posed gun.
inline M34 GunHold::fist_on(const M34 &grip) const {
    M34 out{};
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c)
            out[r * 4 + c] = gun_[r * 4] * grip[c] + gun_[r * 4 + 1] * grip[4 + c] + gun_[r * 4 + 2] * grip[8 + c];
        out[r * 4 + 3] =
                gun_[r * 4 + 3]
                + data_->scale * (gun_[r * 4] * grip[3] + gun_[r * 4 + 1] * grip[7] + gun_[r * 4 + 2] * grip[11]);
    }
    return out;
}

// Two-bone IK onto a fist, then a soft grip: the fist turns on its grip toward the forearm's line by up to `soft`.
inline void GunHold::reach(std::span<float> skinning, const Arm &arm, const M34 &fist, int k, double soft) {
    M34 target = concat(fist, arm.side > 0 ? data_->grip_inverse : rig_.fists.left_inverse);
    solve_arm(skinning, arm, target, k);
    if (soft > 0) {
        const V3 forearm = rotate(load(skinning, arm.fore), arm.forearm);
        const V3 hand = rotate(load(skinning, arm.hand), arm.forearm);
        const double lengths = length(forearm) * length(hand);
        const double angle = std::acos(std::clamp(dot(forearm, hand) / (lengths != 0 ? lengths : 1), -1., 1.));
        if (angle > .01) {
            const auto turn = rotation_about(normalized(cross(hand, forearm)), std::min(angle, soft), origin(fist));
            target = concat(turn, target);
            solve_arm(skinning, arm, target, k);
        }
    }
    twist_forearm(skinning, arm);
}

// The two-bone solve for a hand target (the hand's skinning matrix): upper arm, forearm, then the hand. The elbow is
// the point of its circle nearest a straight wrist, pulled down and out of the body.
inline void GunHold::solve_arm(std::span<float> skinning, const Arm &arm, M34 &target, int k) {
    const V3 shoulder = joint(skinning, arm.upper), elbow = joint(skinning, arm.fore);
    const V3 wrist = transform(target, bind_origin(arm.hand));
    const V3 straight_elbow = sub(wrist, scaled(rotate(target, arm.forearm), arm.fore_length));
    const V3 to_wrist = sub(wrist, shoulder);
    const double distance = length(to_wrist) > 0 ? length(to_wrist) : 1;
    const double l1 = arm.upper_length, l2 = arm.fore_length;
    const double reach = std::clamp(distance, std::abs(l1 - l2) + .05, l1 + l2 - .02);
    const V3 direction = scaled(to_wrist, 1 / distance);
    gap_[size_t(k)] = std::max(0., distance - reach);
    const double side = arm.side * (k == 0 ? .22 : .25);
    V3 pole = sub(add(scaled(sub(straight_elbow, shoulder), 1 / l1), scaled(right_, side)), scaled(up_, .2));
    pole[2] -= .2;
    pole = normalized(sub(pole, scaled(direction, dot(pole, direction))));
    const double along = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach);
    const double height = std::sqrt(std::max(0., l1 * l1 - along * along));
    const V3 new_elbow = add(add(shoulder, scaled(direction, along)), scaled(pole, height));
    if (const auto m = swing(sub(elbow, shoulder), sub(new_elbow, shoulder), shoulder))
        pre(skinning, arm.upper_sub, *m);
    const V3 hand_joint = joint(skinning, arm.hand);
    const V3 reached = add(shoulder, scaled(direction, reach));
    if (const auto m = swing(sub(hand_joint, new_elbow), sub(reached, new_elbow), new_elbow))
        pre(skinning, arm.fore_sub, *m);
    if (gap_[size_t(k)] > 0) set_origin(target, add(origin(target), sub(reached, wrist)));
    pre(skinning, arm.hand_sub, concat(target, inverse(load(skinning, arm.hand))));
}

// The forearm turns about its own axis by a share of the hand's twist against it, so the wrist doesn't wring.
inline void GunHold::twist_forearm(std::span<float> skinning, const Arm &arm) {
    const M34 fore = load(skinning, arm.fore), hand = load(skinning, arm.hand);
    const V3 elbow = joint(skinning, arm.fore);
    // q = fore^T hand (rotation parts), as a quaternion (w, x, y, z).
    std::array<double, 9> q{};
    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c)
            q[size_t(r * 3 + c)] = fore[size_t(r)] * hand[size_t(c)] + fore[size_t(4 + r)] * hand[size_t(4 + c)]
                                   + fore[size_t(8 + r)] * hand[size_t(8 + c)];
    double w = 0, x = 0, y = 0, z = 0;
    const double trace = q[0] + q[4] + q[8];
    if (trace > 0) {
        const double s4 = std::sqrt(trace + 1) * 2;
        w = .25 * s4, x = (q[7] - q[5]) / s4, y = (q[2] - q[6]) / s4, z = (q[3] - q[1]) / s4;
    } else if (q[0] > q[4] && q[0] > q[8]) {
        const double s4 = std::sqrt(1 + q[0] - q[4] - q[8]) * 2;
        w = (q[7] - q[5]) / s4, x = .25 * s4, y = (q[1] + q[3]) / s4, z = (q[2] + q[6]) / s4;
    } else if (q[4] > q[8]) {
        const double s4 = std::sqrt(1 + q[4] - q[0] - q[8]) * 2;
        w = (q[2] - q[6]) / s4, x = (q[1] + q[3]) / s4, y = .25 * s4, z = (q[5] + q[7]) / s4;
    } else {
        const double s4 = std::sqrt(1 + q[8] - q[0] - q[4]) * 2;
        w = (q[3] - q[1]) / s4, x = (q[2] + q[6]) / s4, y = (q[5] + q[7]) / s4, z = .25 * s4;
    }
    const double projected = dot({x, y, z}, arm.forearm);
    double twist = 2 * std::atan2(projected, w);
    twist = std::atan2(std::sin(twist), std::cos(twist));
    const V3 axis = normalized(rotate(fore, arm.forearm));
    store(skinning, arm.fore, concat(rotation_about(axis, twist * twist_share, elbow), fore));
}

// The left hand's fingers curl like the right's, mirrored: a fist round the fore-end.
inline void GunHold::mirror_fingers(std::span<float> skinning) {
    const auto &right = arms_[0], &left = arms_[1];
    const size_t count = std::min(right.fingers.size(), left.fingers.size());
    const M34 right_inverse = inverse(load(skinning, right.hand)), left_hand = load(skinning, left.hand);
    for (size_t i = 0; i < count; ++i) {
        // Relative to the hand, mirrored across x = 0 (M rel M with M = diag(-1, 1, 1)).
        M34 relative = concat(right_inverse, load(skinning, right.fingers[i]));
        for (const size_t at : {1, 2, 3, 4, 8})
            relative[at] = -relative[at];
        store(skinning, left.fingers[i], concat(left_hand, relative));
    }
}

// If the support grip is out of the left arm's reach, slide it back along the gun until it isn't.
inline void GunHold::slide_left_into_reach(std::span<const float> skinning) {
    if (!data_->long_gun) return;
    const auto &arm = arms_[1];
    const V3 shoulder = joint(skinning, arm.upper);
    const double most = arm.upper_length + arm.fore_length - 1;
    const V3 offset = sub(origin(fist_left_), shoulder);
    if (length(offset) + 2.5 <= most) return;
    const V3 barrel = {gun_[0], gun_[4], gun_[8]};
    const double along = dot(offset, barrel), squared = dot(offset, offset), m = most - 2.5;
    const double disc = along * along - squared + m * m;
    const double t = std::clamp(disc > 0 ? along - std::sqrt(disc) : along, 0., 9 * data_->scale);
    set_origin(fist_left_, sub(origin(fist_left_), scaled(barrel, t)));
}

// A bolt action after a shot: the right fist goes to the knob, lifts it, throws it back and home, and returns.
inline void GunHold::bolt_right() {
    const auto &d = *data_;
    if (!d.pump) return;
    const double at = d.pump->at, duration = d.pump->duration, t = since_shot_;
    if (t > at + duration + .05) return;
    const double k = ramp(t, at - .05, at + duration * .18) * (1 - ramp(t, at + duration * .8, at + duration + .05));
    if (k <= 0) return;
    const M34 knob = concat(concat(fist_on(*d.bolt), rig_.fists.right_inverse), d.grip);
    blend_fist(fist_right_, knob, k);
    const double lift =
            ramp(t, at + duration * .15, at + duration * .3) * (1 - ramp(t, at + duration * .6, at + duration * .75));
    const double back =
            ramp(t, at + duration * .3, at + duration * .42) * (1 - ramp(t, at + duration * .48, at + duration * .6));
    for (int r = 0; r < 3; ++r)
        fist_right_[size_t(r * 4 + 3)] +=
                gun_[size_t(r * 4 + 2)] * lift * .5 * d.scale - gun_[size_t(r * 4)] * back * 2.3 * d.scale;
}

// Shotgun pump after a shot: the left hand runs back and home along the fore-end.
inline void GunHold::pump_left() {
    const auto &d = *data_;
    const double at = d.pump->at, duration = d.pump->duration, t = since_shot_;
    const double k = ramp(t, at, at + duration * .45) - ramp(t, at + duration * .5, at + duration);
    for (int r = 0; r < 3; ++r)
        fist_left_[size_t(r * 4 + 3)] -= gun_[size_t(r * 4)] * k * 2.4 * d.scale;
}

inline GunHold::ReloadPhase GunHold::reload_phase() const {
    const double length = reload_shell_ ? reload_length_ + shell_tail_seconds : reload_length_;
    const double k = cant_k_;
    const bool long_gun = data_->long_gun;
    return {std::clamp(reload_t_ / length, 0., 1.),
            (long_gun ? 32 : 28) * k,
            (long_gun ? 7 : -10) * k,
            (long_gun ? 1.5 : 2.5) * k,
            (long_gun ? 2.0 : 2.5) * k};
}

// The left hand's reload path. Magazine guns: grip -> magazine -> down with it -> back -> seat it (-> rack). Tube guns:
// from the hip to the loading port once per shell.
inline void GunHold::reload_left(std::span<const float> skinning, double t) {
    const auto &d = *data_;
    const double flat = std::hypot(gun_[0], gun_[4]);
    const double hz = flat > 0 ? flat : 1;
    const V3 gun_up = {gun_[2], gun_[6], gun_[10]};
    if (reload_shell_ || !d.mag) {
        const V3 pelvis = joint(skinning, pelvis_);
        V3 hip{};
        for (int r = 0; r < 3; ++r)
            hip[r] = pelvis[r] - right_[r] * 3 + (r < 2 ? gun_[size_t(r * 4)] / hz * 8 : 8);
        const M34 port = fist_on(d.port ? *d.port : d.left);
        const double tt = std::clamp(reload_t_ / (reload_length_ + shell_tail_seconds), 0., 1.);
        blend_fist(fist_left_, port, cant_k_);
        const double k = ramp(tt, .05, .4) * (1 - ramp(tt, .45, .85));
        const double press = std::sin(std::clamp((tt - .85) / .12, 0., 1.) * pi);
        const V3 fist = origin(fist_left_);
        set_origin(fist_left_, add(add(fist, scaled(sub(hip, fist), k * .8)), scaled(gun_up, press * .7)));
        return;
    }
    const M34 mag = fist_on(*d.mag);
    V3 low{};
    for (int r = 0; r < 3; ++r)
        low[r] = mag[size_t(r * 4 + 3)] - right_[r] * 2 + (r < 2 ? gun_[size_t(r * 4)] / hz * 2 : -9);
    blend_fist(fist_left_, mag, ramp(t, .08, .22) * (1 - ramp(t, .66, .78)));
    const double out = ramp(t, .24, .36) * (1 - ramp(t, .42, .56));
    const double shove = std::sin(std::clamp((t - .56) / .06, 0., 1.) * pi);
    const V3 fist = origin(fist_left_);
    set_origin(fist_left_, add(add(fist, scaled(sub(low, fist), out)), scaled(gun_up, shove * .8)));
    mag_held_ = out > .02;
    if (mag_held_) mag_inverse_ = inverse(mag);
    if (reload_empty_ && d.rack) {
        blend_fist(fist_left_, fist_on(*d.rack), ramp(t, .64, .72) * (1 - ramp(t, .82, .9)));
        const double pull = ramp(t, .72, .77) * (1 - ramp(t, .77, .8));
        for (int r = 0; r < 3; ++r)
            fist_left_[size_t(r * 4 + 3)] -= gun_[size_t(r * 4)] * pull * 1.6 * d.scale;
    }
}

// Blends a fist toward a target: positions linearly, the rotation by a normalised lerp of its axes.
inline void GunHold::blend_fist(M34 &fist, const M34 &target, double k) {
    if (k <= 0) return;
    if (k >= 1) {
        fist = target;
        return;
    }
    for (size_t i = 0; i < 12; ++i)
        fist[i] += (target[i] - fist[i]) * k;
    const V3 a = normalized({fist[0], fist[4], fist[8]});
    const V3 b0 = {fist[1], fist[5], fist[9]};
    const V3 b = normalized(sub(b0, scaled(a, dot(a, b0))));
    const V3 c = cross(a, b);
    for (int r = 0; r < 3; ++r) {
        fist[size_t(r * 4)] = a[r];
        fist[size_t(r * 4 + 1)] = b[r];
        fist[size_t(r * 4 + 2)] = c[r];
    }
}

// The muzzle, barrel, port and throw in posed model space, from bone 0.
inline void GunHold::points() {
    const auto &d = *data_;
    M34 bone{};
    for (size_t i = 0; i < 12; ++i)
        bone[i] = skin[i];
    const M34 placed = concat(bone, d.bake);
    muzzle = transform(placed, silenced && d.silencer_tip ? *d.silencer_tip : d.muzzle);
    barrel = normalized(rotate(placed, {1, 0, 0}));
    port = transform(placed, d.eject_point);
    throw_direction = normalized(rotate(placed, d.eject_direction));
}
}  // namespace native_gun
