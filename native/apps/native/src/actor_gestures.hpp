#pragma once
// The arm half of the bunny's acting layer (web player/bunny/model.ts BunnyActing: arm, armL, reachR, reachL,
// square, handR, handL), for the avatar poses (avatar/stage.ts GESTURES). Works on the skinning matrices
// (3x4 per rig bone, bind model space -> posed model space) after the animation, like the web's applyActing.
#include "nlohmann/json.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace native_gestures {

using Vec3 = std::array<double, 3>;

// [pitch, yaw, roll] degrees about a joint, in the bone's own posed frame (turnAbout).
struct ArmTurn {
    Vec3 shoulder{}, elbow{};
    std::optional<Vec3> wrist;
};

// Where the wrist goes and which way the elbow bends, in the bunny's bind space (x its left, -y its front,
// z up) from between the shoulders, facing where the bunny looks.
struct ArmReach {
    Vec3 hand{}, pole{};
    std::optional<Vec3> wrist;
};

enum class HandShape { grip, open, point };

struct ArmGesture {
    std::optional<ArmTurn> turn;
    std::optional<ArmReach> reach;
    HandShape hand = HandShape::grip;
};

struct Gesture {
    // Right, then left.
    std::array<ArmGesture, 2> arms;
    // 0..1: undo the stance's twist and lean of the upper body.
    double square = 0;
};

namespace detail {

constexpr double radians_per_degree = 3.141592653589793 / 180;
constexpr double tiny = 1e-6;
// The IK keeps the arm this far from fully straight or folded.
constexpr double reach_slack = .05;

inline void concat(const float *a, const float *b, float *out) {
    float v[12];
    for (int r = 0; r < 3; r++)
        for (int c = 0; c < 4; c++)
            v[r * 4 + c] =
                    a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c == 3 ? a[r * 4 + 3] : 0);
    std::copy(v, v + 12, out);
}

inline Vec3 vec3(const nlohmann::json &value) {
    if (!value.is_array() || value.size() != 3) throw std::runtime_error("Gesture vector");
    return {value[0].get<double>(), value[1].get<double>(), value[2].get<double>()};
}

inline std::optional<Vec3> optional_vec3(const nlohmann::json &object, const char *key) {
    return object.contains(key) ? std::optional<Vec3>(vec3(object[key])) : std::nullopt;
}

inline HandShape hand_shape(const nlohmann::json &gesture, const char *key) {
    const auto shape = gesture.value(key, std::string());
    return shape == "open" ? HandShape::open : shape == "point" ? HandShape::point : HandShape::grip;
}

inline ArmGesture arm_gesture(const nlohmann::json &g, const char *turn, const char *reach, const char *hand) {
    ArmGesture arm;
    if (g.contains(turn))
        arm.turn = ArmTurn{vec3(g[turn].at("shoulder")), vec3(g[turn].at("elbow")), optional_vec3(g[turn], "wrist")};
    if (g.contains(reach))
        arm.reach = ArmReach{vec3(g[reach].at("hand")), vec3(g[reach].at("pole")), optional_vec3(g[reach], "wrist")};
    arm.hand = hand_shape(g, hand);
    return arm;
}

}  // namespace detail

// One avatar/stage.ts Gesture, as exported to avatar.json.
inline Gesture parse_gesture(const nlohmann::json &g) {
    Gesture out;
    out.arms[0] = detail::arm_gesture(g, "arm", "reachR", "handR");
    out.arms[1] = detail::arm_gesture(g, "armL", "reachL", "handL");
    out.square = g.contains("square")                           ? g["square"].get<double>()
                 : g.contains("reachR") || g.contains("reachL") ? 1
                                                                : 0;
    return out;
}

// The bones the gestures move, found once per rig.
struct Rig {
    struct Arm {
        int upper = -1, fore = -1, hand = -1;
        std::vector<int> upper_subtree, fore_subtree, hand_subtree, fingers, index_finger;
    };

    std::vector<float> bind;
    std::vector<int> parent;
    int bones = 0, cs_bones = 0, chest = -1, head = -1;
    std::vector<int> chest_subtree, head_subtree;
    std::array<Arm, 2> arms;
    // The shoulders' bind height and depth (R_UpperArm), the origin reaches are placed from.
    double shoulder_y = 0, shoulder_z = 0;

    explicit Rig(const nlohmann::json &rig) {
        bind = rig.at("bind").get<std::vector<float>>();
        parent = rig.at("parent").get<std::vector<int>>();
        cs_bones = rig.at("csBones").get<int>();
        const auto names = rig.at("names").get<std::vector<std::string>>();
        bones = int(names.size());
        auto bone = [&](const std::string &name) {
            for (int i = 0; i < cs_bones; i++)
                if (names[size_t(i)] == "ValveBiped.Bip01_" + name) return i;
            return -1;
        };
        chest = bone("Spine2");
        head = bone("Head1");
        chest_subtree = subtree(chest);
        head_subtree = subtree(head);
        for (int side = 0; side < 2; side++)
            arms[size_t(side)] = arm(bone, side ? "L" : "R");
        if (arms[0].upper >= 0) {
            shoulder_y = bind[size_t(arms[0].upper) * 12 + 7];
            shoulder_z = bind[size_t(arms[0].upper) * 12 + 11];
        }
    }

    // A bone and the animated bones under it (parents come before their children).
    std::vector<int> subtree(int root) const {
        std::vector<int> out;
        if (root < 0) return out;
        out.push_back(root);
        for (int i = root + 1; i < cs_bones; i++)
            if (std::find(out.begin(), out.end(), parent[size_t(i)]) != out.end()) out.push_back(i);
        return out;
    }

    template <class Find>
    Arm arm(Find &bone, const std::string &side) const {
        Arm out;
        out.upper = bone(side + "_UpperArm");
        out.fore = bone(side + "_Forearm");
        out.hand = bone(side + "_Hand");
        out.upper_subtree = subtree(out.upper);
        out.fore_subtree = subtree(out.fore);
        out.hand_subtree = subtree(out.hand);
        for (const char *finger : {"0", "1", "2"})
            for (const char *joint : {"", "1", "2"}) {
                const int index = bone(side + "_Finger" + finger + joint);
                if (index < 0) continue;
                out.fingers.push_back(index);
                if (std::string(finger) == "1") out.index_finger.push_back(index);
            }
        return out;
    }

    bool valid() const { return chest >= 0 && head >= 0 && arms[0].hand >= 0 && arms[1].hand >= 0; }

    // Where bone i's joint is now (model space).
    Vec3 joint(const std::vector<float> &skin, int i) const {
        const float *s = skin.data() + size_t(i) * 12;
        const float *b = bind.data() + size_t(i) * 12;
        Vec3 out;
        for (int r = 0; r < 3; r++)
            out[size_t(r)] = s[r * 4] * b[3] + s[r * 4 + 1] * b[7] + s[r * 4 + 2] * b[11] + s[r * 4 + 3];
        return out;
    }
};

// Applies the model-space transform `m` to every bone in `subtree`.
inline void transform_bones(const float *m, const std::vector<int> &subtree, std::vector<float> &skin) {
    for (const int bone : subtree)
        detail::concat(m, skin.data() + size_t(bone) * 12, skin.data() + size_t(bone) * 12);
}

// The rotation part of `m` set to `rotation`, about `pivot`.
inline void about_pivot(float *m, const double rotation[9], const Vec3 &pivot) {
    for (int r = 0; r < 3; r++) {
        double moved = 0;
        for (int c = 0; c < 3; c++) {
            m[r * 4 + c] = float(rotation[r * 3 + c]);
            moved += rotation[r * 3 + c] * pivot[size_t(c)];
        }
        m[r * 4 + 3] = float(pivot[size_t(r)] - moved);
    }
}

// Turns `bone` and `subtree` about the bone's posed joint in its own posed frame (bind frame: faces -y,
// left +x, up +z): nod down `pitch` (about +x), turn left `yaw` (about +z), tilt `roll` (about -y).
inline void turn_about(
        const Rig &rig,
        int bone,
        double pitch,
        double yaw,
        double roll,
        const std::vector<int> &subtree,
        std::vector<float> &skin
) {
    if (bone < 0 || (!pitch && !yaw && !roll)) return;
    const double x = pitch * detail::radians_per_degree, y = -roll * detail::radians_per_degree,
                 z = yaw * detail::radians_per_degree;
    const double cx = std::cos(x), sx = std::sin(x), cy = std::cos(y), sy = std::sin(y), cz = std::cos(z),
                 sz = std::sin(z);
    // Euler ZXY: Rz * Rx * Ry.
    const double local[9] = {
            cz * cy - sz * sx * sy,
            -sz * cx,
            cz * sy + sz * sx * cy,
            sz * cy + cz * sx * sy,
            cz * cx,
            sz * sy - cz * sx * cy,
            -cx * sy,
            sx,
            cx * cy
    };
    const float *s = skin.data() + size_t(bone) * 12;
    double turned[9] = {}, model[9] = {};
    for (int r = 0; r < 3; r++)
        for (int c = 0; c < 3; c++)
            for (int k = 0; k < 3; k++)
                turned[r * 3 + c] += s[r * 4 + k] * local[k * 3 + c];
    for (int r = 0; r < 3; r++)
        for (int c = 0; c < 3; c++)
            for (int k = 0; k < 3; k++)
                model[r * 3 + c] += turned[r * 3 + k] * s[c * 4 + k];
    float m[12];
    about_pivot(m, model, rig.joint(skin, bone));
    transform_bones(m, subtree, skin);
}

// Rotates `subtree` about `pivot` by the shortest rotation taking direction a to direction b.
inline void
swing(const Vec3 &a, const Vec3 &b, const Vec3 &pivot, const std::vector<int> &subtree, std::vector<float> &skin) {
    const double la = std::hypot(a[0], a[1], a[2]), lb = std::hypot(b[0], b[1], b[2]);
    if (la < detail::tiny || lb < detail::tiny) return;
    double ax = (a[1] * b[2] - a[2] * b[1]) / (la * lb), ay = (a[2] * b[0] - a[0] * b[2]) / (la * lb),
           az = (a[0] * b[1] - a[1] * b[0]) / (la * lb);
    const double sn = std::hypot(ax, ay, az), cs = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
    if (sn < detail::tiny) return;
    ax /= sn;
    ay /= sn;
    az /= sn;
    const double t = 1 - cs;
    const double rotation[9] = {
            cs + ax * ax * t,
            ax * ay * t - az * sn,
            ax * az * t + ay * sn,
            ay * ax * t + az * sn,
            cs + ay * ay * t,
            ay * az * t - ax * sn,
            az * ax * t - ay * sn,
            az * ay * t + ax * sn,
            cs + az * az * t
    };
    float m[12];
    about_pivot(m, rotation, pivot);
    transform_bones(m, subtree, skin);
}

// Faces the chest where the bunny looks: `look_yaw` is the eye yaw less the feet's, degrees.
inline void square_chest(const Rig &rig, double amount, double look_yaw, std::vector<float> &skin) {
    if (!amount) return;
    const float *s = skin.data() + size_t(rig.chest) * 12;
    const double fx = -s[1], fy = -s[5], fz = -s[9];
    double turn = look_yaw - std::atan2(fy, fx) / detail::radians_per_degree;
    turn = std::fmod(std::fmod(turn + 180, 360) + 360, 360) - 180;
    const double length = std::hypot(fx, fy, fz);
    const double lean = std::asin(std::clamp(fz / (length ? length : 1), -1., 1.)) / detail::radians_per_degree;
    turn_about(rig, rig.chest, lean * amount, turn * amount, 0, rig.chest_subtree, skin);
}

// Two-bone IK: the upper arm swings the elbow into the pole's plane, then the forearm reaches the wrist.
inline void
reach_arm(const Rig &rig, const Rig::Arm &arm, const ArmReach &reach, double look_yaw, std::vector<float> &skin) {
    const Vec3 right = rig.joint(skin, rig.arms[0].upper), left = rig.joint(skin, rig.arms[1].upper);
    const double yaw = look_yaw * detail::radians_per_degree, fx = std::cos(yaw), fy = std::sin(yaw);
    auto to_model = [&](const Vec3 &v, bool point) {
        const double x = v[0], y = point ? v[1] - rig.shoulder_y : v[1], z = point ? v[2] - rig.shoulder_z : v[2];
        return Vec3{
                fx * -y - fy * x + (point ? (right[0] + left[0]) / 2 : 0),
                fy * -y + fx * x + (point ? (right[1] + left[1]) / 2 : 0),
                z + (point ? (right[2] + left[2]) / 2 : 0)
        };
    };
    const Vec3 target = to_model(reach.hand, true), pole = to_model(reach.pole, false);
    const Vec3 p0 = rig.joint(skin, arm.upper), p1 = rig.joint(skin, arm.fore), p2 = rig.joint(skin, arm.hand);
    const double upper = std::hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const double fore = std::hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
    const Vec3 to_target = {target[0] - p0[0], target[1] - p0[1], target[2] - p0[2]};
    double target_length = std::hypot(to_target[0], to_target[1], to_target[2]);
    if (!target_length) target_length = 1;
    const double d =
            std::clamp(target_length, std::abs(upper - fore) + detail::reach_slack, upper + fore - detail::reach_slack);
    const Vec3 dir = {to_target[0] / target_length, to_target[1] / target_length, to_target[2] / target_length};
    const double along_pole = pole[0] * dir[0] + pole[1] * dir[1] + pole[2] * dir[2];
    Vec3 bend = {pole[0] - dir[0] * along_pole, pole[1] - dir[1] * along_pole, pole[2] - dir[2] * along_pole};
    double bend_length = std::hypot(bend[0], bend[1], bend[2]);
    if (!bend_length) bend_length = 1;
    for (auto &v : bend)
        v /= bend_length;
    const double along = (upper * upper - fore * fore + d * d) / (2 * d);
    const double height = std::sqrt(std::max(0., upper * upper - along * along));
    Vec3 elbow;
    for (size_t k = 0; k < 3; k++)
        elbow[k] = p0[k] + dir[k] * along + bend[k] * height;
    swing({p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]},
          {elbow[0] - p0[0], elbow[1] - p0[1], elbow[2] - p0[2]},
          p0,
          arm.upper_subtree,
          skin);
    const Vec3 wrist = rig.joint(skin, arm.hand);
    Vec3 reached;
    for (size_t k = 0; k < 3; k++)
        reached[k] = p0[k] + dir[k] * d;
    swing({wrist[0] - elbow[0], wrist[1] - elbow[1], wrist[2] - elbow[2]},
          {reached[0] - elbow[0], reached[1] - elbow[1], reached[2] - elbow[2]},
          elbow,
          arm.fore_subtree,
          skin);
}

inline void turn_arm(const Rig &rig, const Rig::Arm &arm, const ArmTurn &turn, std::vector<float> &skin) {
    turn_about(rig, arm.upper, turn.shoulder[0], turn.shoulder[1], turn.shoulder[2], arm.upper_subtree, skin);
    turn_about(rig, arm.fore, turn.elbow[0], turn.elbow[1], turn.elbow[2], arm.fore_subtree, skin);
    if (turn.wrist)
        turn_about(rig, arm.hand, (*turn.wrist)[0], (*turn.wrist)[1], (*turn.wrist)[2], arm.hand_subtree, skin);
}

// Straight fingers: a finger rigid with the hand in its bind shape has the hand's skinning matrix.
inline void shape_hand(const Rig::Arm &arm, HandShape shape, std::vector<float> &skin) {
    if (shape == HandShape::grip) return;
    for (const int finger : shape == HandShape::open ? arm.fingers : arm.index_finger)
        std::copy_n(skin.data() + size_t(arm.hand) * 12, 12, skin.data() + size_t(finger) * 12);
}

inline void pose_arms(const Rig &rig, const Gesture &gesture, double look_yaw, std::vector<float> &skin) {
    for (size_t side = 0; side < 2; side++) {
        const auto &arm = rig.arms[side];
        const auto &want = gesture.arms[side];
        if (want.reach) {
            reach_arm(rig, arm, *want.reach, look_yaw, skin);
            if (want.reach->wrist) {
                const auto &w = *want.reach->wrist;
                turn_about(rig, arm.hand, w[0], w[1], w[2], arm.hand_subtree, skin);
            }
        } else if (want.turn)
            turn_arm(rig, arm, *want.turn, skin);
        shape_hand(arm, want.hand, skin);
    }
}

}  // namespace native_gestures
