#pragma once
// A studio model's skeleton, sequences and decoded animations in typed form, and Source's bone setup over them: the
// website's player/studio/data.ts and pose.ts (bone_setup.cpp of the 2013 SDK), for map props that animate.
//
//   init_pose -> accumulate(sequence, cycle, 1) -> bone-to-model matrices
//
// accumulate = CalcPoseSingle (up to 4 animations blended by the sequence's two pose parameters, frames interpolated)
// + SlerpBones (per-bone weights, delta and post-delta layers) + the sequence's autolayers. Quaternion blends are
// normalised lerps as on the website. Arithmetic runs in double and stores in float, like the website's typed arrays,
// so both sides pose the same matrices. Nothing allocates after construction.
#include "nlohmann/json.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <functional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace native_studio {

// studio.h sequence and autolayer flags.
constexpr int studio_looping = 0x0001;
constexpr int studio_delta = 0x0004;
constexpr int studio_post = 0x0010;
constexpr int studio_layer_spline = 0x0040;
constexpr int studio_layer_crossfade = 0x0080;
constexpr int studio_layer_no_blend = 0x0200;
constexpr int studio_layer_local = 0x1000;
constexpr int studio_layer_pose = 0x4000;

// Floats per bh_studio_vertices vertex: position 3, normal 3, uv 2, tangent 4, weights 3, bones 3.
constexpr size_t vertex_floats = 18;
constexpr size_t vertex_weights_at = 12;
constexpr size_t vertex_bones_at = 15;
// Floats per bone and frame in bh_studio_animation: quaternion xyzw, position xyz.
constexpr size_t animation_floats = 7;
constexpr size_t matrix_floats = 12;
constexpr size_t max_bones = 256;
// Autolayers nest at most this deep (pose.ts accumulate).
constexpr int max_layer_depth = 6;

inline std::string lower_ascii(std::string_view text) {
    std::string out(text);
    std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return char(std::tolower(c)); });
    return out;
}

struct PoseParameter {
    double start = 0, end = 1, loop = 0;
};

struct Animation {
    double fps = 30;
    int flags = 0;
    int frames = 1;
    // frames x bones x 7 floats.
    std::vector<float> samples;
};

struct AutoLayer {
    int sequence = -1, pose = -1, flags = 0;
    double start = 0, peak = 0, tail = 0, end = 0;
};

struct Sequence {
    std::string name, activity;
    double activity_weight = 0;
    int flags = 0;
    std::array<int, 2> group_size{1, 1};
    std::array<int, 2> parameters{-1, -1};
    std::array<double, 2> parameter_start{}, parameter_end{};
    std::vector<int> animations;
    std::vector<float> bone_weights;
    // Bones with weight > 0: the only ones the sequence touches.
    std::vector<uint16_t> active;
    std::vector<double> pose_keys;
    std::vector<AutoLayer> layers;

    bool looping() const { return flags & studio_looping; }

    bool delta() const { return flags & studio_delta; }

    bool post() const { return flags & studio_post; }
};

// Decodes animation `index` of the model: frames x bones x 7 floats, empty if it can't.
using AnimationReader = std::function<std::span<const float>(uint32_t index)>;

class Rig {
public:
    size_t bones = 0;
    std::vector<int16_t> parent;
    std::vector<float> rest_rotation, rest_position, pose_to_bone;
    std::vector<PoseParameter> pose_parameters;
    std::vector<Animation> animations;
    std::vector<Sequence> sequences;

    // `info` is bh_studio_info's JSON. Throws on a model the bone setup can't take.
    Rig(const nlohmann::json &info, const AnimationReader &read) {
        read_bones(info.at("bones"));
        for (const auto &p : info.at("poseParams"))
            pose_parameters.push_back(
                    {p.at("start").get<double>(), p.at("end").get<double>(), p.at("loop").get<double>()}
            );
        read_animations(info.at("anims"), read);
        read_sequences(info.at("seqs"));
    }

    // Floats the decoded animations take.
    size_t sample_count() const {
        size_t count = 0;
        for (const auto &a : animations)
            count += a.samples.size();
        return count;
    }

    // `LookupSequence` by name (case-insensitive, the first match), -1 when there is none.
    int sequence(std::string_view name) const {
        const auto key = lower_ascii(name);
        for (size_t i = 0; i < sequences.size(); ++i)
            if (lower_ascii(sequences[i].name) == key) return int(i);
        return -1;
    }

    // Sequences whose animations all have one frame and no layers: their pose never changes.
    bool still(int index) const {
        const auto &s = sequences[size_t(index)];
        if (!s.layers.empty()) return false;
        return std::all_of(s.animations.begin(), s.animations.end(), [&](int a) {
            return size_t(a) >= animations.size() || animations[size_t(a)].frames <= 1;
        });
    }

private:
    void read_bones(const nlohmann::json &list) {
        bones = list.size();
        if (!bones || bones > max_bones) throw std::runtime_error("Unsupported studio bone count");
        for (const auto &b : list) {
            const int index = b.at("parent").get<int>();
            if (index >= int(parent.size())) throw std::runtime_error("Studio bone parent after its child");
            parent.push_back(int16_t(index));
            append(rest_rotation, b.at("quat"), 4);
            append(rest_position, b.at("pos"), 3);
            append(pose_to_bone, b.at("poseToBone"), matrix_floats);
        }
    }

    static void append(std::vector<float> &out, const nlohmann::json &values, size_t count) {
        if (values.size() != count) throw std::runtime_error("Studio bone data size");
        for (const auto &v : values)
            out.push_back(v.get<float>());
    }

    // data.ts `anim`: an animation that doesn't decode holds the reference pose (identity for a delta).
    void read_animations(const nlohmann::json &list, const AnimationReader &read) {
        for (size_t index = 0; index < list.size(); ++index) {
            const auto &a = list[index];
            Animation animation;
            animation.fps = a.at("fps").get<double>();
            animation.flags = a.at("flags").get<int>();
            animation.frames = std::max(1, a.at("frames").get<int>());
            const size_t expected = size_t(animation.frames) * bones * animation_floats;
            const auto samples = read(uint32_t(index));
            if (samples.size() == expected)
                animation.samples.assign(samples.begin(), samples.end());
            else
                animation.samples = reference_frames(animation);
            animations.push_back(std::move(animation));
        }
    }

    std::vector<float> reference_frames(const Animation &animation) const {
        std::vector<float> out(size_t(animation.frames) * bones * animation_floats, 0.f);
        const bool delta = animation.flags & studio_delta;
        for (size_t frame = 0; frame < size_t(animation.frames); ++frame)
            for (size_t b = 0; b < bones; ++b) {
                float *at = out.data() + (frame * bones + b) * animation_floats;
                if (delta) {
                    at[3] = 1;
                    continue;
                }
                std::copy_n(rest_rotation.data() + b * 4, 4, at);
                std::copy_n(rest_position.data() + b * 3, 3, at + 4);
            }
        return out;
    }

    void read_sequences(const nlohmann::json &list) {
        for (const auto &q : list) {
            Sequence s;
            s.name = q.at("name").get<std::string>();
            s.activity = q.at("activity").get<std::string>();
            s.activity_weight = q.at("actWeight").get<double>();
            s.flags = q.at("flags").get<int>();
            for (int k = 0; k < 2; ++k) {
                s.group_size[k] = std::max(1, q.at("groupSize")[k].get<int>());
                s.parameters[k] = q.at("params")[k].get<int>();
                s.parameter_start[k] = q.at("paramStart")[k].get<double>();
                s.parameter_end[k] = q.at("paramEnd")[k].get<double>();
            }
            read_sequence_lists(q, s);
            sequences.push_back(std::move(s));
        }
    }

    void read_sequence_lists(const nlohmann::json &q, Sequence &s) const {
        for (const auto &a : q.at("anims")) {
            const int index = a.get<int>();
            if (index < 0 || size_t(index) >= animations.size()) throw std::runtime_error("Studio sequence animation");
            s.animations.push_back(index);
        }
        if (s.animations.empty()) throw std::runtime_error("Studio sequence without animations");
        const auto &weights = q.at("weights");
        for (size_t b = 0; b < bones; ++b) {
            s.bone_weights.push_back(weights.size() == bones ? weights[b].get<float>() : 1.f);
            if (s.bone_weights.back() > 0) s.active.push_back(uint16_t(b));
        }
        for (const auto &k : q.at("poseKeys"))
            s.pose_keys.push_back(k.get<double>());
        for (const auto &l : q.at("layers"))
            s.layers.push_back(
                    {l.at("seq").get<int>(),
                     l.at("pose").get<int>(),
                     l.at("flags").get<int>(),
                     l.at("start").get<double>(),
                     l.at("peak").get<double>(),
                     l.at("tail").get<double>(),
                     l.at("end").get<double>()}
            );
    }
};

// pose.ts BoneSetup over one rig. Each model keeps one and poses its props in turn.
class BoneSetup {
public:
    explicit BoneSetup(const Rig &rig)
        : rig_(rig)
        , rotation_(rig.bones * 4)
        , position_(rig.bones * 3)
        , world_(rig.bones * matrix_floats)
        , parameters_(rig.pose_parameters.size()) {
        for (auto &depth : scratch_rotation_)
            depth.resize(rig.bones * 4);
        for (auto &depth : scratch_position_)
            depth.resize(rig.bones * 3);
        // Each parameter's 0 value, as the website's defaults.
        for (size_t i = 0; i < parameters_.size(); ++i)
            set_pose_parameter(int(i), 0);
    }

    // Studio_SetPoseParameter: stores the normalised value.
    void set_pose_parameter(int index, double value) {
        if (index < 0 || size_t(index) >= parameters_.size()) return;
        const auto &p = rig_.pose_parameters[size_t(index)];
        if (p.loop != 0) {
            const double wrap = (p.start + p.end) / 2 + p.loop / 2;
            const double shift = p.loop - wrap;
            value = value - p.loop * std::floor((value + shift) / p.loop);
        }
        parameters_[size_t(index)] = float(std::clamp((value - p.start) / (p.end - p.start), 0., 1.));
    }

    double pose_parameter(int index) const {
        if (index < 0 || size_t(index) >= parameters_.size()) return 0;
        const auto &p = rig_.pose_parameters[size_t(index)];
        return double(parameters_[size_t(index)]) * (p.end - p.start) + p.start;
    }

    // Studio_CPS: cycles per second of a sequence at the current pose parameters.
    double cycle_rate(int sequence) {
        if (sequence < 0 || size_t(sequence) >= rig_.sequences.size()) return 0;
        const int count = sequence_animations(rig_.sequences[size_t(sequence)]);
        double rate = 0;
        for (int k = 0; k < count; ++k) {
            const auto &a = rig_.animations[size_t(corner_animation_[k])];
            if (a.frames > 1) rate += (a.fps / (a.frames - 1)) * double(corner_weight_[k]);
        }
        return rate;
    }

    void init_pose() {
        std::copy(rig_.rest_rotation.begin(), rig_.rest_rotation.end(), rotation_.begin());
        std::copy(rig_.rest_position.begin(), rig_.rest_position.end(), position_.begin());
    }

    // AccumulatePose: blends `sequence` at `cycle` into the current pose, with its autolayers.
    void accumulate(int sequence, double cycle, double weight, int depth = 0) {
        if (sequence < 0 || weight <= 0 || depth > max_layer_depth) return;
        if (size_t(sequence) >= rig_.sequences.size()) return;
        weight = std::min(weight, 1.);
        const auto &s = rig_.sequences[size_t(sequence)];
        auto &rotation = scratch_rotation_[size_t(depth)];
        auto &position = scratch_position_[size_t(depth)];
        calc_pose_single(s, cycle, rotation, position);
        slerp_bones(s, rotation, position, weight);
        for (const auto &layer : s.layers)
            accumulate_layer(layer, cycle, weight, depth);
    }

    // Bone-to-model matrices (3x4 row-major per bone); parents precede children.
    std::span<const float> build_matrices() {
        for (size_t i = 0; i < rig_.bones; ++i)
            bone_matrix(i);
        return world_;
    }

private:
    const Rig &rig_;
    std::vector<float> rotation_, position_, world_, parameters_;
    std::array<std::vector<float>, max_layer_depth + 1> scratch_rotation_, scratch_position_;
    std::array<int, 4> corner_animation_{};
    std::array<float, 4> corner_weight_{};

    // Studio_LocalPoseParameter: blend axis k of a sequence -> (fraction, index).
    std::pair<double, int> local_pose(const Sequence &s, int k) const {
        const int index = s.parameters[size_t(k)];
        if (index < 0 || size_t(index) >= parameters_.size()) return {0, 0};
        const auto &p = rig_.pose_parameters[size_t(index)];
        double value = parameters_[size_t(index)];
        const int size = s.group_size[size_t(k)];
        if (s.pose_keys.empty()) {
            const double local_start = (s.parameter_start[size_t(k)] - p.start) / (p.end - p.start);
            const double local_end = (s.parameter_end[size_t(k)] - p.start) / (p.end - p.start);
            double t = std::clamp((value - local_start) / (local_end - local_start), 0., 1.);
            int at = 0;
            if (size > 2) {
                at = std::min(int(std::floor(t * (size - 1))), size - 2);
                t = t * (size - 1) - at;
            }
            return {t, at};
        }
        value = value * (p.end - p.start) + p.start;
        const size_t base = k == 0 ? 0 : size_t(s.group_size[0]);
        int at = 0;
        double t = 0;
        for (;;) {
            const size_t key = base + size_t(at);
            if (key + 1 >= s.pose_keys.size()) break;
            t = (value - s.pose_keys[key]) / (s.pose_keys[key + 1] - s.pose_keys[key]);
            if (at < size - 2 && t > 1) {
                ++at;
                continue;
            }
            break;
        }
        return {std::clamp(t, 0., 1.), at};
    }

    // Studio_SeqAnims: up to 4 animations and their weights into the corner arrays; the count.
    int sequence_animations(const Sequence &s) {
        const auto [s0, i0] = local_pose(s, 0);
        const auto [s1, i1] = local_pose(s, 1);
        const int x1 = std::min(i0 + 1, s.group_size[0] - 1);
        const int y1 = std::min(i1 + 1, s.group_size[1] - 1);
        int count = corner(s, 0, i0, i1, (1 - s0) * (1 - s1));
        count = corner(s, count, x1, i1, s0 * (1 - s1));
        count = corner(s, count, i0, y1, (1 - s0) * s1);
        return corner(s, count, x1, y1, s0 * s1);
    }

    // One corner of the blend grid, skipped when its weight is about 0; the new count.
    int corner(const Sequence &s, int count, int x, int y, double weight) {
        static constexpr double negligible_weight = .001;
        if (weight <= negligible_weight) return count;
        const size_t cell = std::min(s.animations.size() - 1, size_t(std::max(0, y * s.group_size[0] + x)));
        corner_animation_[size_t(count)] = s.animations[cell];
        corner_weight_[size_t(count)] = float(weight);
        return count + 1;
    }

    static double wrap_cycle(const Sequence &s, double cycle) {
        if (cycle >= 0 && cycle < 1) return cycle;
        if (!s.looping()) return cycle < 0 ? 0 : 1;
        cycle -= std::trunc(cycle);
        return cycle < 0 ? cycle + 1 : cycle;
    }

    void calc_pose_single(const Sequence &s, double cycle, std::vector<float> &rotation, std::vector<float> &position) {
        cycle = wrap_cycle(s, cycle);
        const int count = sequence_animations(s);
        for (int k = 0; k < count; ++k)
            add_animation(s, k, cycle, rotation, position);
        normalise(s, count, rotation, position);
    }

    // Corner k's animation at `cycle` (frames interpolated), weighted into (rotation, position).
    void add_animation(
            const Sequence &s, int k, double cycle, std::vector<float> &rotation, std::vector<float> &position
    ) const {
        const auto &a = rig_.animations[size_t(corner_animation_[size_t(k)])];
        const double weight = corner_weight_[size_t(k)];
        const double f = cycle * (a.frames - 1);
        const int f0 = std::min(a.frames - 1, int(std::floor(f)));
        const int f1 = std::min(a.frames - 1, f0 + 1);
        const double t = f - f0;
        const float *row0 = a.samples.data() + size_t(f0) * rig_.bones * animation_floats;
        const float *row1 = a.samples.data() + size_t(f1) * rig_.bones * animation_floats;
        for (const auto bone : s.active) {
            const float *p0 = row0 + bone * animation_floats;
            const float *p1 = row1 + bone * animation_floats;
            std::array<double, 4> q{p0[0], p0[1], p0[2], p0[3]};
            if (t > 0) {
                std::array<double, 4> b{p1[0], p1[1], p1[2], p1[3]};
                if (q[0] * b[0] + q[1] * b[1] + q[2] * b[2] + q[3] * b[3] < 0)
                    for (auto &v : b)
                        v = -v;
                for (int i = 0; i < 4; ++i)
                    q[size_t(i)] += (b[size_t(i)] - q[size_t(i)]) * t;
            }
            std::array<double, 3> p{};
            for (int i = 0; i < 3; ++i)
                p[size_t(i)] = p0[4 + i] + (double(p1[4 + i]) - p0[4 + i]) * t;
            float *r = rotation.data() + bone * 4;
            float *o = position.data() + bone * 3;
            if (k == 0) {
                for (int i = 0; i < 4; ++i)
                    r[i] = float(q[size_t(i)] * weight);
                for (int i = 0; i < 3; ++i)
                    o[i] = float(p[size_t(i)] * weight);
                continue;
            }
            const double dot = double(r[0]) * q[0] + double(r[1]) * q[1] + double(r[2]) * q[2] + double(r[3]) * q[3];
            const double sign = dot < 0 ? -weight : weight;
            for (int i = 0; i < 4; ++i)
                r[i] = float(r[i] + q[size_t(i)] * sign);
            for (int i = 0; i < 3; ++i)
                o[i] = float(o[i] + p[size_t(i)] * weight);
        }
    }

    // Normalises the blended quaternions; corner weights sum to about 1, so positions only rescale when they don't.
    void normalise(const Sequence &s, int count, std::vector<float> &rotation, std::vector<float> &position) const {
        double total = 0;
        for (int k = 0; k < count; ++k)
            total += corner_weight_[size_t(k)];
        const double inverse = total > 0 ? 1 / total : 1;
        for (const auto bone : s.active) {
            float *r = rotation.data() + bone * 4;
            double length =
                    std::sqrt(double(r[0]) * r[0] + double(r[1]) * r[1] + double(r[2]) * r[2] + double(r[3]) * r[3]);
            if (length == 0) length = 1;
            for (int i = 0; i < 4; ++i)
                r[i] = float(r[i] / length);
            if (inverse == 1) continue;
            float *o = position.data() + bone * 3;
            for (int i = 0; i < 3; ++i)
                o[i] = float(o[i] * inverse);
        }
    }

    // Source QuaternionScale: the rotation angle of q scaled by t (kept in float, as the website's scratch array).
    static std::array<float, 4> quaternion_scale(const float *q, double t) {
        static constexpr double epsilon = 1e-6;
        const double sin_angle =
                std::min(1., std::sqrt(double(q[0]) * q[0] + double(q[1]) * q[1] + double(q[2]) * q[2]));
        const double scaled = std::sin(std::asin(sin_angle) * t);
        const double k = scaled / (sin_angle + epsilon);
        const double w = std::sqrt(std::max(0., 1 - scaled * scaled));
        return {float(q[0] * k), float(q[1] * k), float(q[2] * k), float(q[3] < 0 ? -w : w)};
    }

    void slerp_bones(
            const Sequence &s, const std::vector<float> &rotation, const std::vector<float> &position, double weight
    ) {
        if (weight <= 0) return;
        weight = std::min(weight, 1.);
        for (const auto bone : s.active) {
            const double amount = weight * s.bone_weights[bone];
            if (amount <= 0) continue;
            if (s.delta())
                add_delta(s.post(), bone, rotation.data() + bone * 4, position.data() + bone * 3, amount);
            else
                blend_bone(bone, rotation.data() + bone * 4, position.data() + bone * 3, amount);
        }
    }

    // Delta layers: q = scale(delta) * q (post-delta: q * scale(delta)), positions added.
    void add_delta(bool post, size_t bone, const float *delta_rotation, const float *delta_position, double amount) {
        const auto scaled = quaternion_scale(delta_rotation, amount);
        const std::array<double, 4> d{scaled[0], scaled[1], scaled[2], scaled[3]};
        float *q = rotation_.data() + bone * 4;
        const double ax = q[0], ay = q[1], az = q[2], aw = q[3];
        std::array<double, 4> r{};
        if (post)
            r = {aw * d[0] + ax * d[3] + ay * d[2] - az * d[1],
                 aw * d[1] - ax * d[2] + ay * d[3] + az * d[0],
                 aw * d[2] + ax * d[1] - ay * d[0] + az * d[3],
                 aw * d[3] - ax * d[0] - ay * d[1] - az * d[2]};
        else
            r = {d[3] * ax + d[0] * aw + d[1] * az - d[2] * ay,
                 d[3] * ay - d[0] * az + d[1] * aw + d[2] * ax,
                 d[3] * az + d[0] * ay - d[1] * ax + d[2] * aw,
                 d[3] * aw - d[0] * ax - d[1] * ay - d[2] * az};
        double length = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2] + r[3] * r[3]);
        if (length == 0) length = 1;
        for (int i = 0; i < 4; ++i)
            q[i] = float(r[size_t(i)] / length);
        float *p = position_.data() + bone * 3;
        for (int i = 0; i < 3; ++i)
            p[i] = float(p[i] + delta_position[i] * amount);
    }

    void blend_bone(size_t bone, const float *to_rotation, const float *to_position, double amount) {
        float *q = rotation_.data() + bone * 4;
        float *p = position_.data() + bone * 3;
        if (amount >= 1) {
            std::copy_n(to_rotation, 4, q);
            std::copy_n(to_position, 3, p);
            return;
        }
        const double keep = 1 - amount;
        std::array<double, 4> b{to_rotation[0], to_rotation[1], to_rotation[2], to_rotation[3]};
        if (double(q[0]) * b[0] + double(q[1]) * b[1] + double(q[2]) * b[2] + double(q[3]) * b[3] < 0)
            for (auto &v : b)
                v = -v;
        std::array<double, 4> r{};
        for (int i = 0; i < 4; ++i)
            r[size_t(i)] = q[i] * keep + b[size_t(i)] * amount;
        double length = std::sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2] + r[3] * r[3]);
        if (length == 0) length = 1;
        for (int i = 0; i < 4; ++i)
            q[i] = float(r[size_t(i)] / length);
        for (int i = 0; i < 3; ++i)
            p[i] = float(p[i] * keep + to_position[i] * amount);
    }

    // AddSequenceLayers: one autolayer of a sequence played at `cycle`.
    void accumulate_layer(const AutoLayer &l, double cycle, double weight, int depth) {
        if (l.flags & studio_layer_local) return;
        double layer_cycle = cycle;
        double layer_weight = weight;
        if (l.start != l.end) {
            const bool by_pose = l.flags & studio_layer_pose;
            const double index = by_pose ? (l.pose >= 0 ? pose_parameter(l.pose) : 0) : cycle;
            if (index < l.start || index >= l.end) return;
            double scale = 1;
            if (index < l.peak && l.start != l.peak)
                scale = (index - l.start) / (l.peak - l.start);
            else if (index > l.tail && l.end != l.tail)
                scale = (l.end - index) / (l.end - l.tail);
            if (l.flags & studio_layer_spline) scale = scale * scale * (3 - 2 * scale);
            if ((l.flags & studio_layer_crossfade) && index > l.tail)
                layer_weight = (scale * weight) / (1 - weight + scale * weight);
            else if (l.flags & studio_layer_no_blend)
                layer_weight = scale;
            else
                layer_weight = weight * scale;
            if (!by_pose) layer_cycle = (cycle - l.start) / (l.end - l.start);
        }
        accumulate(l.sequence, layer_cycle, layer_weight, depth + 1);
    }

    // QuaternionMatrix of bone i, times its parent's matrix.
    void bone_matrix(size_t i) {
        const double x = rotation_[i * 4], y = rotation_[i * 4 + 1], z = rotation_[i * 4 + 2], w = rotation_[i * 4 + 3];
        const std::array<double, 12> local{
                1 - 2 * y * y - 2 * z * z,
                2 * x * y - 2 * w * z,
                2 * x * z + 2 * w * y,
                position_[i * 3],
                2 * x * y + 2 * w * z,
                1 - 2 * x * x - 2 * z * z,
                2 * y * z - 2 * w * x,
                position_[i * 3 + 1],
                2 * x * z - 2 * w * y,
                2 * y * z + 2 * w * x,
                1 - 2 * x * x - 2 * y * y,
                position_[i * 3 + 2]
        };
        float *out = world_.data() + i * matrix_floats;
        const int parent = rig_.parent[i];
        if (parent < 0) {
            for (size_t k = 0; k < matrix_floats; ++k)
                out[k] = float(local[k]);
            return;
        }
        const float *p = world_.data() + size_t(parent) * matrix_floats;
        for (int r = 0; r < 3; ++r) {
            const double a0 = p[r * 4], a1 = p[r * 4 + 1], a2 = p[r * 4 + 2], a3 = p[r * 4 + 3];
            for (int c = 0; c < 3; ++c)
                out[r * 4 + c] = float(a0 * local[size_t(c)] + a1 * local[size_t(4 + c)] + a2 * local[size_t(8 + c)]);
            out[r * 4 + 3] = float(a0 * local[3] + a1 * local[7] + a2 * local[11] + a3);
        }
    }
};

// pose.ts concat34To44 without the 4x4: out (3x4 row-major) = a (3x4) * b (3x4), as the skinning matrix the vertex
// shader reads (bone-to-model times pose-to-bone).
inline void concat34(const float *a, const float *b, float *out) {
    for (int r = 0; r < 3; ++r) {
        const double a0 = a[r * 4], a1 = a[r * 4 + 1], a2 = a[r * 4 + 2], a3 = a[r * 4 + 3];
        for (int c = 0; c < 4; ++c)
            out[r * 4 + c] = float(a0 * b[c] + a1 * b[4 + c] + a2 * b[8 + c] + (c == 3 ? a3 : 0.));
    }
}

}  // namespace native_studio
