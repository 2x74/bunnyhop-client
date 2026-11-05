#pragma once
// Hand-level pose work on the knife viewmodel's baked poses, ported from the website's inspect kit
// (viewmodel/inspects/kit.ts): the hand's frame, the wrist bend and finger curls the hand idle uses, and the
// hierarchical blend an inspect's cancel and chain crossfades use. Baked clips hold skinning matrices (bone * inverse
// bind); these work on bone-to-model matrices, so a pose goes through to_world and back through to_skin.
//
// Matrices are row-major 3x4, 12 floats per bone. Nothing here allocates once PoseWork is sized.
#include "viewmodel_feel.hpp"
#include <nlohmann/json.hpp>
#include <span>
#include <stdexcept>
#include <vector>

namespace native_vm {

using Vec3 = std::array<double, 3>;
inline constexpr size_t floats_per_bone = 12;

enum class Finger { index, middle, ring, pinky, thumb };

// The knife viewmodel's rig and the inspect kit's bone sets (export-viewmodels.ts knifeRig).
struct KnifeRig {
    std::vector<int> parent;
    std::vector<float> bind, inverse_bind;
    // Bones a cancel or chain blend moves, parents first: the arm, the hand and fingers, then the knife.
    std::vector<int> blend;
    std::vector<int> hand, helper, knife;
    std::array<std::array<int, 3>, 5> fingers{};
    int hand_bone = 0, arm_bone = 0, knife_handle = 0, knife_parent = 0;
    // Handedness of (axis, width, normal) on this rig, fixed from the bind pose.
    double normal_sign = 1;
    // Per bone: 1 for a finger, 2 for the knife (the cancel blends them at their own weights).
    std::vector<uint8_t> cancel_group;
    // Per bone: whether it is in `blend`.
    std::vector<uint8_t> blended;

    size_t bones() const { return parent.size(); }

    // The knife hangs off the hand, so it blends with it.
    int blend_parent(int bone) const { return bone == knife_parent ? hand_bone : parent[size_t(bone)]; }

    static KnifeRig from_json(const nlohmann::json &rig);
};

inline Vec3 position(std::span<const float> world, int bone) {
    const size_t at = size_t(bone) * floats_per_bone;
    return {world[at + 3], world[at + 7], world[at + 11]};
}

inline Vec3 add(const Vec3 &a, const Vec3 &b) {
    return {a[0] + b[0], a[1] + b[1], a[2] + b[2]};
}

inline Vec3 subtract(const Vec3 &a, const Vec3 &b) {
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}

inline Vec3 scale(const Vec3 &a, double s) {
    return {a[0] * s, a[1] * s, a[2] * s};
}

inline double dot(const Vec3 &a, const Vec3 &b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

inline Vec3 cross(const Vec3 &a, const Vec3 &b) {
    return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}

inline Vec3 normalize(const Vec3 &a) {
    const double length = std::hypot(a[0], a[1], a[2]);
    return length > 0 ? scale(a, 1 / length) : a;
}

// The posed hand: wrist, along the knuckles (axis), across them (width), the palm normal, and the knife's grip.
struct HandFrame {
    Vec3 wrist{}, elbow{}, forearm{}, axis{}, width{}, normal{}, grip{};
};

inline HandFrame hand_frame(const KnifeRig &rig, std::span<const float> world, double normal_sign) {
    constexpr Finger knuckles[] = {Finger::index, Finger::middle, Finger::ring, Finger::pinky};
    HandFrame f;
    f.wrist = position(world, rig.hand_bone);
    f.elbow = position(world, rig.arm_bone);
    std::array<Vec3, 4> roots{};
    for (size_t k = 0; k < 4; k++)
        roots[k] = position(world, rig.fingers[size_t(knuckles[k])][0]);
    const Vec3 knuckle_centre = scale(add(add(roots[0], roots[1]), add(roots[2], roots[3])), .25);
    f.axis = normalize(subtract(knuckle_centre, f.wrist));
    Vec3 width = subtract(roots[0], roots[3]);
    f.width = normalize(subtract(width, scale(f.axis, dot(width, f.axis))));
    f.normal = scale(cross(f.axis, f.width), normal_sign);
    f.forearm = normalize(subtract(f.wrist, f.elbow));
    f.grip = position(world, rig.knife_handle);
    return f;
}

inline HandFrame hand_frame(const KnifeRig &rig, std::span<const float> world) {
    return hand_frame(rig, world, rig.normal_sign);
}

inline KnifeRig KnifeRig::from_json(const nlohmann::json &rig) {
    KnifeRig out;
    out.parent = rig.at("parent").get<std::vector<int>>();
    out.bind = rig.at("bind").get<std::vector<float>>();
    out.inverse_bind = rig.at("inv").get<std::vector<float>>();
    out.blend = rig.at("blend").get<std::vector<int>>();
    out.hand = rig.at("hand").get<std::vector<int>>();
    out.helper = rig.at("helper").get<std::vector<int>>();
    out.knife = rig.at("knife").get<std::vector<int>>();
    const char *names[] = {"index", "middle", "ring", "pinky", "thumb"};
    for (size_t k = 0; k < 5; k++)
        out.fingers[k] = rig.at("fingers").at(names[k]).get<std::array<int, 3>>();
    out.hand_bone = rig.at("handBone");
    out.arm_bone = rig.at("armBone");
    out.knife_handle = rig.at("knifeHandle");
    out.knife_parent = rig.at("knifeParent");
    if (out.bind.size() != out.bones() * floats_per_bone || out.inverse_bind.size() != out.bind.size())
        throw std::runtime_error("Knife rig matrices don't match its bones");
    const auto bind_frame = hand_frame(out, out.bind, 1);
    const auto thumb = subtract(position(out.bind, out.fingers[size_t(Finger::thumb)][1]), bind_frame.wrist);
    out.normal_sign = dot(cross(bind_frame.axis, bind_frame.width), thumb) < 0 ? -1 : 1;
    out.blended.assign(out.bones(), 0);
    for (int bone : out.blend)
        out.blended[size_t(bone)] = 1;
    out.cancel_group.assign(out.bones(), 0);
    for (const auto &chain : out.fingers)
        for (int bone : chain)
            out.cancel_group[size_t(bone)] = 1;
    for (int bone : out.knife)
        out.cancel_group[size_t(bone)] = 2;
    return out;
}

// out = a * b for 3x4s at the given bone offsets (rig.ts concat).
inline void concat_at(const float *a, const float *b, float *out) {
    for (int r = 0; r < 3; r++) {
        const float a0 = a[r * 4], a1 = a[r * 4 + 1], a2 = a[r * 4 + 2], a3 = a[r * 4 + 3];
        out[r * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8];
        out[r * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
        out[r * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
        out[r * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3;
    }
}

// Bone-to-model matrices of a baked pose (skinning * bind), and back.
inline void to_world(const KnifeRig &rig, std::span<const float> skin, std::span<float> world) {
    for (size_t i = 0; i < rig.bones(); i++) {
        const size_t at = i * floats_per_bone;
        concat_at(skin.data() + at, rig.bind.data() + at, world.data() + at);
    }
}

inline void to_skin(const KnifeRig &rig, std::span<const float> world, std::span<float> skin) {
    for (size_t i = 0; i < rig.bones(); i++) {
        const size_t at = i * floats_per_bone;
        concat_at(world.data() + at, rig.inverse_bind.data() + at, skin.data() + at);
    }
}

// Rotation by `angle` (radians) about unit `axis` through `pivot` (math.ts rotAbout).
inline std::array<float, 12> rotate_about(const Vec3 &axis, double angle, const Vec3 &pivot) {
    const double x = axis[0], y = axis[1], z = axis[2];
    const double c = std::cos(angle), s = std::sin(angle), t = 1 - c;
    const double r00 = t * x * x + c, r01 = t * x * y - s * z, r02 = t * x * z + s * y;
    const double r10 = t * x * y + s * z, r11 = t * y * y + c, r12 = t * y * z - s * x;
    const double r20 = t * x * z - s * y, r21 = t * y * z + s * x, r22 = t * z * z + c;
    const double px = pivot[0], py = pivot[1], pz = pivot[2];
    return {float(r00),
            float(r01),
            float(r02),
            float(px - (r00 * px + r01 * py + r02 * pz)),
            float(r10),
            float(r11),
            float(r12),
            float(py - (r10 * px + r11 * py + r12 * pz)),
            float(r20),
            float(r21),
            float(r22),
            float(pz - (r20 * px + r21 * py + r22 * pz))};
}

// W[i] = M * W[i] for each bone (Arm.rigid).
inline void move_rigidly(std::span<float> world, const std::array<float, 12> &m, std::span<const int> bones) {
    std::array<float, 12> moved{};
    for (int bone : bones) {
        float *at = world.data() + size_t(bone) * floats_per_bone;
        concat_at(m.data(), at, moved.data());
        std::copy(moved.begin(), moved.end(), at);
    }
}

// Wrist bend about the wrist (Arm.wrist): flex curls the palm in, deviation turns about the palm normal; the helper
// bones take half.
inline void bend_wrist(const KnifeRig &rig, std::span<float> world, double flex, double deviation) {
    if (!flex && !deviation) return;
    const auto f = hand_frame(rig, world);
    const auto curl_axis = normalize(cross(f.axis, f.normal));
    auto bend = [&](double share) {
        const auto t = rotate_about(curl_axis, flex * share * radians_per_degree, f.wrist);
        const auto t2 = rotate_about(f.normal, deviation * share * radians_per_degree, f.wrist);
        std::array<float, 12> h{};
        concat_at(t2.data(), t.data(), h.data());
        return h;
    };
    const auto whole = bend(1);
    move_rigidly(world, whole, rig.hand);
    move_rigidly(world, whole, rig.knife);
    move_rigidly(world, bend(.5), rig.helper);
}

// Adds curl (degrees per joint: proximal, middle, distal; + toward the palm) to a finger (Arm.curl, no spread).
inline void curl_finger(
        const KnifeRig &rig,
        std::span<float> world,
        Finger finger,
        const std::array<double, 3> &curl,
        const HandFrame &f
) {
    const auto &chain = rig.fingers[size_t(finger)];
    Vec3 axis{};
    if (finger == Finger::thumb) {
        const auto along = normalize(subtract(position(world, chain[1]), position(world, chain[0])));
        axis = normalize(cross(along, f.normal));
    } else
        axis = normalize(cross(f.axis, f.normal));
    for (size_t k = 0; k < 3; k++) {
        if (!curl[k]) continue;
        const auto t = rotate_about(axis, curl[k] * radians_per_degree, position(world, chain[k]));
        move_rigidly(world, t, std::span<const int>(chain.data() + k, 3 - k));
    }
}

// The knife hand's idle on a posed hand (idle.ts HandIdle.apply).
inline void apply_hand_idle(const KnifeRig &rig, std::span<float> world, const HandIdlePose &pose) {
    constexpr double index_middle_share = .5, pinky_middle_share = .4;
    bend_wrist(rig, world, pose.flex, pose.deviation);
    if (!pose.index && !pose.pinky) return;
    const auto f = hand_frame(rig, world);
    if (pose.index) curl_finger(rig, world, Finger::index, {-pose.index, -pose.index * index_middle_share, 0}, f);
    if (pose.pinky) curl_finger(rig, world, Finger::pinky, {-pose.pinky, -pose.pinky * pinky_middle_share, 0}, f);
}

// Rotation part of a 3x4 as a quaternion (x, y, z, w; kit.ts quat).
inline std::array<double, 4> quaternion(const float *m) {
    const double m00 = m[0], m01 = m[1], m02 = m[2], m10 = m[4], m11 = m[5], m12 = m[6];
    const double m20 = m[8], m21 = m[9], m22 = m[10];
    const double trace = m00 + m11 + m22;
    if (trace > 0) {
        const double s = std::sqrt(trace + 1) * 2;
        return {(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, .25 * s};
    }
    if (m00 > m11 && m00 > m22) {
        const double s = std::sqrt(1 + m00 - m11 - m22) * 2;
        return {.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s};
    }
    if (m11 > m22) {
        const double s = std::sqrt(1 + m11 - m00 - m22) * 2;
        return {(m01 + m10) / s, .25 * s, (m12 + m21) / s, (m02 - m20) / s};
    }
    const double s = std::sqrt(1 + m22 - m00 - m11) * 2;
    return {(m02 + m20) / s, (m12 + m21) / s, .25 * s, (m10 - m01) / s};
}

// a = blend(a, b, w) for one bone: rotations by shortest-arc normalised quaternion lerp, translations linearly.
inline void blend_bone(float *a, const float *b, double w) {
    if (w <= 0) return;
    if (w >= 1) {
        std::copy(b, b + floats_per_bone, a);
        return;
    }
    const auto qa = quaternion(a), qb = quaternion(b);
    const double sign = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3] < 0 ? -1 : 1;
    std::array<double, 4> q{};
    for (size_t k = 0; k < 4; k++)
        q[k] = qa[k] + (qb[k] * sign - qa[k]) * w;
    const double length = std::hypot(std::hypot(q[0], q[1]), std::hypot(q[2], q[3]));
    for (auto &value : q)
        value /= length > 0 ? length : 1;
    const auto [x, y, z, r] = q;
    const double tx = a[3] + (b[3] - a[3]) * w, ty = a[7] + (b[7] - a[7]) * w, tz = a[11] + (b[11] - a[11]) * w;
    const double out[12] = {
            1 - 2 * (y * y + z * z),
            2 * (x * y - z * r),
            2 * (x * z + y * r),
            tx,
            2 * (x * y + z * r),
            1 - 2 * (x * x + z * z),
            2 * (y * z - x * r),
            ty,
            2 * (x * z - y * r),
            2 * (y * z + x * r),
            1 - 2 * (x * x + y * y),
            tz
    };
    for (size_t k = 0; k < floats_per_bone; k++)
        a[k] = float(out[k]);
}

inline void invert_rigid(const float *m, float *out) {
    const float r00 = m[0], r01 = m[1], r02 = m[2], tx = m[3];
    const float r10 = m[4], r11 = m[5], r12 = m[6], ty = m[7];
    const float r20 = m[8], r21 = m[9], r22 = m[10], tz = m[11];
    const float inverse[12] = {
            r00,
            r10,
            r20,
            -(r00 * tx + r10 * ty + r20 * tz),
            r01,
            r11,
            r21,
            -(r01 * tx + r11 * ty + r21 * tz),
            r02,
            r12,
            r22,
            -(r02 * tx + r12 * ty + r22 * tz)
    };
    std::copy(inverse, inverse + floats_per_bone, out);
}

// Scratch space for blends, sized once for a rig.
struct PoseWork {
    std::vector<float> original, local_a, local_b;

    void size_for(const KnifeRig &rig) {
        const size_t n = rig.bones() * floats_per_bone;
        original.assign(n, 0);
        local_a.assign(n, 0);
        local_b.assign(n, 0);
    }
};

// Weights of a cancel's bone groups (inspects/runtime.ts): the fingers and the knife blend at their own.
struct CancelWeights {
    double fingers = 0, knife = 0;
};

// A = blend(A, B, w) through the hierarchy (kit.ts blendPoseH): each blended bone's transform relative to its blend
// parent is blended and the chain recomposed root to tip, so bone lengths hold and only joint angles move. With
// `groups`, fingers and the knife use their own weights instead of w.
inline void blend_hierarchy(
        const KnifeRig &rig,
        std::span<float> a,
        std::span<const float> b,
        double w,
        PoseWork &work,
        const CancelWeights *groups = nullptr
) {
    if (w <= 0 && !(groups && (groups->fingers > 0 || groups->knife > 0))) return;
    std::copy(a.begin(), a.end(), work.original.begin());
    std::array<float, 12> parent_inverse{};
    const auto in_blend = [&](int bone) {
        return rig.blended[size_t(bone)] != 0;
    };
    for (int bone : rig.blend) {
        const int parent = rig.blend_parent(bone);
        const size_t at = size_t(bone) * floats_per_bone;
        if (parent >= 0 && in_blend(parent)) {
            const size_t parent_at = size_t(parent) * floats_per_bone;
            invert_rigid(work.original.data() + parent_at, parent_inverse.data());
            concat_at(parent_inverse.data(), work.original.data() + at, work.local_a.data() + at);
            invert_rigid(b.data() + parent_at, parent_inverse.data());
            concat_at(parent_inverse.data(), b.data() + at, work.local_b.data() + at);
        } else {
            std::copy_n(work.original.data() + at, floats_per_bone, work.local_a.data() + at);
            std::copy_n(b.data() + at, floats_per_bone, work.local_b.data() + at);
        }
    }
    for (int bone : rig.blend) {
        const auto group = groups ? rig.cancel_group[size_t(bone)] : 0;
        const double weight = group == 1 ? groups->fingers : group == 2 ? groups->knife : w;
        const size_t at = size_t(bone) * floats_per_bone;
        blend_bone(work.local_a.data() + at, work.local_b.data() + at, weight);
    }
    std::array<float, 12> composed{};
    for (int bone : rig.blend) {
        const int parent = rig.blend_parent(bone);
        const size_t at = size_t(bone) * floats_per_bone;
        if (parent >= 0 && in_blend(parent)) {
            concat_at(a.data() + size_t(parent) * floats_per_bone, work.local_a.data() + at, composed.data());
            std::copy(composed.begin(), composed.end(), a.data() + at);
        } else
            std::copy_n(work.local_a.data() + at, floats_per_bone, a.data() + at);
    }
}

// a = blend(a, b, w) bone by bone in model space (kit.ts blendPose): short fades between gun poses.
inline void blend_flat(std::span<float> a, std::span<const float> b, double w) {
    for (size_t at = 0; at + floats_per_bone <= a.size() && at + floats_per_bone <= b.size(); at += floats_per_bone)
        blend_bone(a.data() + at, b.data() + at, w);
}

}  // namespace native_vm
