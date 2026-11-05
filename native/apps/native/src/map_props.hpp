#pragma once
// Animated map props: prop_dynamics playing a sequence as CS:S draws them (bhop_ceaseless's butterflies,
// bhop_crash_egypt's crates, bhop_retrowave's blocks), as the website's map-props.ts poses them. The core says what the
// map's I/O asked each prop to play (bh_prop_anim_states); this turns that into a sequence and cycle at the world's
// visual time and the prop's skinning matrices. Drawing is the renderer's (map_prop_meshes.hpp).
//
// Source (CDynamicProp, game/server/props.cpp): Spawn plays DefaultAnim from cycle 0 at rate 1, so every prop starts
// with the map and props on one sequence run in step; a non-looping sequence holds its last frame, or plays DefaultAnim
// again when it ends; a name that isn't a sequence is tried as an activity; a prop with neither shows sequence 0,
// still.
//
// Cost, as on the website: only props in view are posed, once per frame; props of one model on the same sequence and
// cycle share the computation; far props step their animation at a lower rate; one-frame sequences are posed once.
#include "studio_rig.hpp"
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace native_map_props {

// Distances (Source units) past which a prop's animation steps at a lower rate, and those steps (seconds).
constexpr double near_lod_units = 1536;
constexpr double far_lod_units = 4096;
constexpr double near_lod_step_seconds = 1. / 20;
constexpr double far_lod_step_seconds = 1. / 6;
// Seeds the fixed pick among an activity's sequences (Source picks at random).
constexpr uint32_t activity_pick_multiplier = 0x9e3779b1u;
// Samples over a sequence that size its culling sphere.
constexpr int reach_samples = 8;

// What a prop plays, with its names already looked up in its model: sequence seconds at visual time t are
// `base + (t - since) * rate`. -1: no such sequence or activity (or no name).
struct SequenceState {
    int anim = -1;
    int default_anim = -1;
    double base = 0, since = 0, rate = 1;
};

struct Shown {
    int sequence = 0;
    double cycle = 0;
};

// map-props.ts sequenceAt. `source` gives cycles_per_second(seq) and looping(seq).
template <class Source>
Shown sequence_at(const SequenceState &state, double seconds, Source &source) {
    double sequence_seconds = state.base + (seconds - state.since) * state.rate;
    int sequence = state.anim;
    if (sequence < 0) return {0, 0};
    double rate = source.cycles_per_second(sequence);
    double cycle = sequence_seconds * rate;
    if (source.looping(sequence))
        cycle -= std::floor(cycle);
    else if (cycle >= 1) {
        if (state.default_anim >= 0) {
            sequence_seconds -= rate > 0 ? 1 / rate : 0;
            sequence = state.default_anim;
            rate = source.cycles_per_second(sequence);
            cycle = sequence_seconds * rate;
            cycle -= std::floor(cycle);
        } else
            cycle = 1;
    } else if (cycle < 0)
        cycle = 0;
    return {sequence, std::isfinite(cycle) ? cycle : 0};
}

// One studio model shared by its props: its bone setup and what the props ask of it.
class PropModel {
public:
    // The bone setup holds a reference to the rig: a model stays where it was made.
    PropModel(const PropModel &) = delete;
    PropModel &operator=(const PropModel &) = delete;

    PropModel(native_studio::Rig model_rig, double radius)
        : rig(std::move(model_rig))
        , setup(rig)
        , mesh_radius(radius)
        , rates_(rig.sequences.size(), std::numeric_limits<double>::quiet_NaN())
        , reaches_(rig.sequences.size(), std::numeric_limits<double>::quiet_NaN()) {
        for (size_t i = 0; i < rig.sequences.size(); ++i)
            still_.push_back(rig.still(int(i)));
    }

    native_studio::Rig rig;
    native_studio::BoneSetup setup;
    // Bind-pose mesh radius around the model origin.
    double mesh_radius;

    double cycles_per_second(int sequence) {
        auto &rate = rates_[size_t(sequence)];
        if (std::isnan(rate)) rate = setup.cycle_rate(sequence);
        return rate;
    }

    bool looping(int sequence) const { return rig.sequences[size_t(sequence)].looping(); }

    bool still(int sequence) const { return still_[size_t(sequence)]; }

    // The ACT_IDLE sequences in model order with their activity weights, for random animators.
    const std::vector<std::pair<int, double>> &idle_sequences() {
        if (!idle_) {
            idle_.emplace();
            for (size_t i = 0; i < rig.sequences.size(); ++i)
                if (native_studio::lower_ascii(rig.sequences[i].activity) == "act_idle")
                    idle_->push_back({int(i), rig.sequences[i].activity_weight});
        }
        return *idle_;
    }

    // map-props.ts lookup (`LookupSequence`): a sequence name, else an activity; among an activity's sequences a
    // weighted pick fixed by the entity, so replays and exports agree. -1 for neither or an empty name.
    int lookup(std::string_view name, uint32_t entity) {
        if (name.empty()) return -1;
        const auto &candidates = candidates_for(name);
        if (candidates.empty()) return -1;
        if (candidates.size() == 1) return candidates.front().first;
        double total = 0;
        for (const auto &c : candidates)
            total += c.second;
        const uint32_t hashed = (entity + 1) * activity_pick_multiplier;
        double pick = double(hashed) / 4294967296. * total;
        for (const auto &c : candidates)
            if ((pick -= c.second) < 0) return c.first;
        return candidates.back().first;
    }

    // Largest bone distance from the model origin over the sequence: sizes the culling sphere.
    double reach(int sequence) {
        auto &reach = reaches_[size_t(sequence)];
        if (!std::isnan(reach)) return reach;
        reach = 0;
        for (int k = 0; k < reach_samples; ++k) {
            setup.init_pose();
            setup.accumulate(sequence, double(k) / reach_samples, 1);
            const auto world = setup.build_matrices();
            for (size_t b = 0; b < rig.bones; ++b) {
                const float *m = world.data() + b * native_studio::matrix_floats;
                reach = std::max(reach, std::sqrt(double(m[3]) * m[3] + double(m[7]) * m[7] + double(m[11]) * m[11]));
            }
        }
        return reach;
    }

    // The last pose computed this frame, for props on the same sequence and cycle.
    struct LastPose {
        double stamp = std::numeric_limits<double>::quiet_NaN();
        int sequence = -1;
        double cycle = 0;
        uint32_t slot = 0;
    } last;

private:
    std::vector<double> rates_, reaches_;
    std::vector<bool> still_;
    std::unordered_map<std::string, std::vector<std::pair<int, double>>> lookups_;
    std::optional<std::vector<std::pair<int, double>>> idle_;

    const std::vector<std::pair<int, double>> &candidates_for(std::string_view name) {
        auto key = native_studio::lower_ascii(name);
        const auto found = lookups_.find(key);
        if (found != lookups_.end()) return found->second;
        std::vector<std::pair<int, double>> candidates;
        const int sequence = rig.sequence(name);
        if (sequence >= 0)
            candidates.push_back({sequence, 1});
        else
            for (size_t i = 0; i < rig.sequences.size(); ++i) {
                const auto &s = rig.sequences[i];
                if (s.activity_weight > 0 && native_studio::lower_ascii(s.activity) == key)
                    candidates.push_back({int(i), s.activity_weight});
            }
        return lookups_.emplace(std::move(key), std::move(candidates)).first->second;
    }
};

// map-props.ts seededRandom (mulberry32): random animators draw the same times and picks in every replay and export.
class SeededRandom {
public:
    explicit SeededRandom(uint32_t seed) : state_(seed) {}

    double next() {
        static constexpr uint32_t increment = 0x6d2b79f5u;
        state_ += increment;
        uint32_t t = state_;
        t = (t ^ (t >> 15)) * (t | 1u);
        t ^= t + (t ^ (t >> 7)) * (t | 61u);
        return double(t ^ (t >> 14)) / 4294967296.;
    }

private:
    uint32_t state_;
};

// map-props.ts RandomAnimator: a `RandomAnimation 1` prop_dynamic as CDynamicProp::AnimThink switches it.
// - Spawn ignores DefaultAnim: sequence 0, cycle 0, playback rate 0 until the first think at MinAnimTime..MaxAnimTime
//   + 0.1 s.
// - Thinks every 0.1 s after that; once the next switch time has passed:
// ResetSequence(SelectWeightedSequence(ACT_IDLE))
//   and the next switch MinAnimTime..MaxAnimTime later.
// - ResetSequence keeps the cycle when the old sequence looped (else 0), and resets the rate to 1 only when the
//   sequence changed or the old one didn't loop.
// - Source draws at random; here a generator seeded by the map and the entity runs on the world's visual time. Switches
//   are computed forward once and kept, so seeking back is a search.
class RandomAnimator {
public:
    RandomAnimator(uint32_t seed, double min_seconds, double max_seconds)
        : random_(seed)
        , min_(min_seconds)
        , max_(max_seconds) {
        static constexpr size_t reserved_switches = 256;
        segments_.reserve(reserved_switches);
        segments_.push_back({0, 0, 0, 0});
        next_switch_ = draw();
        next_think_ = next_switch_ + think_seconds;
    }

    // `model` gives cycles_per_second(seq), looping(seq) and idle_sequences() (PropModel does).
    template <class Model>
    Shown at(double seconds, Model &model) {
        extend(seconds, model);
        size_t low = 0, high = segments_.size() - 1;
        while (low < high) {
            const size_t middle = (low + high + 1) / 2;
            if (segments_[middle].start <= seconds)
                low = middle;
            else
                high = middle - 1;
        }
        return {segments_[low].sequence, cycle_at(segments_[low], std::max(seconds, segments_[low].start), model)};
    }

private:
    // CDynamicProp::AnimThink's interval, and how many switches a prop remembers (10 hours at one per think).
    static constexpr double think_seconds = .1;
    static constexpr size_t max_switches = size_t(1) << 18;
    // Keeps 2.9 / 0.1 from flooring to 28: the think at exactly the switch time doesn't switch (`<` in AnimThink).
    static constexpr double think_epsilon = 1e-6;

    struct Segment {
        double start;
        int sequence;
        double cycle;
        double rate;
    };

    std::vector<Segment> segments_;
    SeededRandom random_;
    double min_, max_;
    double next_switch_ = 0, next_think_ = 0;
    bool loops_ = false;

    // RandomFloat(min, max).
    double draw() { return min_ + (max_ - min_) * random_.next(); }

    template <class Model>
    static double cycle_at(const Segment &s, double seconds, Model &model) {
        const double cycle = s.cycle + (seconds - s.start) * model.cycles_per_second(s.sequence) * s.rate;
        if (cycle >= 0 && cycle < 1) return cycle;
        if (model.looping(s.sequence)) return cycle - std::floor(cycle);
        return cycle < 0 ? 0 : 1;
    }

    // SelectWeightedSequence(ACT_IDLE, current): Source's reservoir pick; a negative weight keeps the current one.
    template <class Model>
    int pick(int current, Model &model) {
        int sequence = -1;
        double total = 0;
        for (const auto &[candidate, weight] : model.idle_sequences()) {
            if (candidate == current && weight < 0) return candidate;
            const double magnitude = std::abs(weight);
            total += magnitude;
            const double roll = total > 0 ? std::floor(random_.next() * total) : 0;
            if (total == 0 || roll < magnitude) sequence = candidate;
        }
        return sequence;
    }

    template <class Model>
    void extend(double seconds, Model &model) {
        while (next_think_ <= seconds && segments_.size() < max_switches && std::isfinite(next_think_))
            think(model);
    }

    template <class Model>
    void think(Model &model) {
        const double now = next_think_;
        const auto &last = segments_.back();
        double cycle = cycle_at(last, now, model);
        int sequence = last.sequence;
        double rate = last.rate;
        const int next = pick(sequence, model);
        if (!loops_) cycle = 0;
        const bool changed = next != sequence;
        sequence = next < 0 ? 0 : next;
        if (changed || !loops_) {
            loops_ = model.looping(sequence);
            rate = 1;
        }
        segments_.push_back({now, sequence, cycle, rate});
        next_switch_ = now + draw();
        next_think_ = now + think_seconds * (std::floor((next_switch_ - now) / think_seconds + think_epsilon) + 1);
    }
};

// The core's PROP_ANIM_SET: the map's I/O set a sequence, which a random animator then follows instead.
constexpr uint32_t prop_anim_set_flag = 4;

// One posed prop.
struct PropInstance {
    uint32_t entity = 0;
    uint32_t model = 0;
    // First bone row of its skinning matrices.
    uint32_t slot = 0;
    SequenceState state;
    // Pose stamp (visual seconds of the frame it was posed for).
    double stamp = std::numeric_limits<double>::quiet_NaN();
    // A one-frame sequence posed already.
    int still_sequence = -1;
    // Sequence the culling radius was sized for.
    int sized_for = -2;
    double radius = 1;
    // RandomAnimation props, until the map's I/O sets a sequence (`set`).
    std::optional<RandomAnimator> random;
    bool set = false;
};

class MapProps {
public:
    // Floats per bone row: a 3x4 skinning matrix.
    static constexpr size_t row_floats = native_studio::matrix_floats;

    uint32_t add_model(native_studio::Rig rig, double mesh_radius) {
        models_.push_back(std::make_unique<PropModel>(std::move(rig), mesh_radius));
        return uint32_t(models_.size() - 1);
    }

    // Props in entity order.
    void add_instance(uint32_t entity, uint32_t model, std::optional<RandomAnimator> random = std::nullopt) {
        PropInstance instance;
        instance.entity = entity;
        instance.model = model;
        instance.random = std::move(random);
        instance.slot = uint32_t(bone_count_);
        bone_count_ += models_[model]->rig.bones;
        instances_.push_back(std::move(instance));
        rows_.resize(bone_count_ * row_floats);
    }

    PropModel &model(uint32_t index) { return *models_[index]; }

    std::span<PropInstance> instances() { return instances_; }

    std::span<const PropInstance> instances() const { return instances_; }

    size_t model_count() const { return models_.size(); }

    size_t bone_count() const { return bone_count_; }

    // Room for `bones` rows, so whole texture rows can be uploaded.
    void reserve_rows(size_t bones) { rows_.resize(std::max(rows_.size(), bones * row_floats)); }

    // Viewer position (Source units) for the distance steps: the main camera's.
    void set_viewer(const float eye[3]) {
        for (int k = 0; k < 3; ++k)
            viewer_[size_t(k)] = eye[k];
    }

    // Sequence and cycle of a prop at visual time `seconds`.
    Shown at(PropInstance &instance, double seconds) {
        auto &model = *models_[instance.model];
        if (instance.random && !instance.set) return instance.random->at(seconds, model);
        return sequence_at(instance.state, seconds, model);
    }

    // The culling radius around the prop's origin: its mesh plus the bones' reach over the sequence it plays now.
    double radius(PropInstance &instance, double seconds) {
        auto &model = *models_[instance.model];
        const int sequence = at(instance, seconds).sequence;
        if (instance.sized_for != sequence) {
            instance.sized_for = sequence;
            instance.radius = std::max(1., model.mesh_radius + model.reach(sequence));
        }
        return instance.radius;
    }

    // Poses `instance` (at `origin`) for the frame at `seconds`, once per frame; false when its rows didn't change.
    bool pose(PropInstance &instance, double seconds, const float origin[3]) {
        if (instance.stamp == seconds) return false;
        instance.stamp = seconds;
        auto &model = *models_[instance.model];
        const auto shown = at(instance, lod_time(seconds, origin));
        if (model.still(shown.sequence) && instance.still_sequence == shown.sequence) return false;
        instance.still_sequence = -1;
        float *rows = rows_.data() + size_t(instance.slot) * row_floats;
        const size_t floats = model.rig.bones * row_floats;
        auto &last = model.last;
        if (last.stamp == seconds && last.sequence == shown.sequence && last.cycle == shown.cycle)
            std::copy_n(rows_.data() + size_t(last.slot) * row_floats, floats, rows);
        else {
            compute(model, shown, rows);
            last = {seconds, shown.sequence, shown.cycle, instance.slot};
            ++poses_;
        }
        if (model.still(shown.sequence)) instance.still_sequence = shown.sequence;
        mark_dirty(instance.slot, model.rig.bones);
        return true;
    }

    // Skinning matrices, 3x4 row-major per bone row.
    std::span<const float> rows() const { return rows_; }

    // Bone rows written since the last call, as [first, end).
    std::pair<size_t, size_t> take_dirty() {
        const auto range =
                dirty_first_ < dirty_end_ ? std::pair{dirty_first_, dirty_end_} : std::pair{size_t(0), size_t(0)};
        dirty_first_ = std::numeric_limits<size_t>::max();
        dirty_end_ = 0;
        return range;
    }

    // Poses computed since the last call.
    size_t take_pose_count() { return std::exchange(poses_, 0); }

private:
    std::vector<std::unique_ptr<PropModel>> models_;
    std::vector<PropInstance> instances_;
    std::vector<float> rows_;
    size_t bone_count_ = 0;
    std::array<double, 3> viewer_{std::numeric_limits<double>::infinity(), 0, 0};
    size_t dirty_first_ = std::numeric_limits<size_t>::max(), dirty_end_ = 0;
    size_t poses_ = 0;

    // Far props step at a lower rate: deterministic steps of visual time, the same in every replay of the frame.
    double lod_time(double seconds, const float origin[3]) const {
        double squared = 0;
        for (int k = 0; k < 3; ++k) {
            const double delta = double(origin[k]) - viewer_[size_t(k)];
            squared += delta * delta;
        }
        const double distance = std::sqrt(squared);
        const double step = distance > far_lod_units    ? far_lod_step_seconds
                            : distance > near_lod_units ? near_lod_step_seconds
                                                        : 0;
        return step > 0 ? std::floor(seconds / step) * step : seconds;
    }

    static void compute(PropModel &model, Shown shown, float *rows) {
        model.setup.init_pose();
        model.setup.accumulate(shown.sequence, shown.cycle, 1);
        const auto world = model.setup.build_matrices();
        const float *pose_to_bone = model.rig.pose_to_bone.data();
        for (size_t b = 0; b < model.rig.bones; ++b) {
            const size_t at = b * native_studio::matrix_floats;
            native_studio::concat34(world.data() + at, pose_to_bone + at, rows + b * row_floats);
        }
    }

    void mark_dirty(uint32_t slot, size_t bones) {
        dirty_first_ = std::min(dirty_first_, size_t(slot));
        dirty_end_ = std::max(dirty_end_, size_t(slot) + bones);
    }
};

}  // namespace native_map_props
