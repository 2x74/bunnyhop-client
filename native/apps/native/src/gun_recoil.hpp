#pragma once
// A gun's recoil as the website kicks it (viewmodel/guns/anim.ts fire, dryFire, stepSpring): five damped springs,
// pitch, push back, roll, yaw and a slower sink, that every shot adds an impulse to. Rapid fire and the Glock's burst
// build up, and the roll kick alternates side with seeded variation, so a string of shots rocks rather than drifts and
// the same replay looks the same every time.
//
// The baked fire clip carries only what the shot does to the gun's parts (slide, bolt, trigger, pump). The recoil moves
// the gun and the hands on it on top, as guns/pose.ts places the gun: its angles turn it about the right grip, its
// offset moves it in view space. The arms come along rigidly instead of being solved again; they enter from the edge
// of the screen, so only their far ends differ. gun_recoil_tests.cpp checks it against the website (gun-recoil-oracle).
#include "viewmodel_pose.hpp"
#include <string_view>

namespace native_vm {

// viewmodel/rand.ts VmRandom: mulberry32, reseeded per owner so one viewer never disturbs another.
class PresentationRandom {
public:
    explicit PresentationRandom(uint32_t base) : base_(base), state_(base) {}

    void seed(uint32_t salt) { state_ = base_ ^ (salt * 0x85ebca6bu); }

    // 0 <= x < 1.
    double next() {
        state_ += 0x6d2b79f5u;
        uint32_t t = state_;
        t = (t ^ (t >> 15)) * (t | 1u);
        t ^= t + (t ^ (t >> 7)) * (t | 61u);
        return double(t ^ (t >> 14)) / 4294967296.;
    }

private:
    uint32_t base_, state_;
};

// viewmodel/rand.ts saltOf: FNV-1a over the id.
inline uint32_t salt_of(std::string_view id) {
    uint32_t hash = 2166136261u;
    for (const char c : id)
        hash = (hash ^ uint32_t(static_cast<unsigned char>(c))) * 16777619u;
    return hash;
}

// A gun's recoil from its definition (guns/types.ts GunDef.recoil): the kick's size per spring and how fast it settles.
struct RecoilSpec {
    double kick = 0, back = 0, roll = 0, settle = 1;
};

class GunRecoil {
public:
    // Reduced motion scales the kicks (guns/anim.ts motion).
    double motion = 1;

    // A gun comes into hand (anim.ts setGun -> settle): springs at rest, its own variation stream from the start.
    void set_gun(std::string_view id, const RecoilSpec &spec) {
        spec_ = spec;
        random_.seed(salt_of(id));
        roll_side_ = 1;
        stop();
    }

    // A draw or a jump: the springs at rest (the variation stream carries on).
    void stop() { springs_ = {}; }

    void advance(double dt) {
        const double omega = std::sqrt(spec_.settle);
        for (size_t i = 0; i < springs_.size(); i++)
            spring_step(springs_[i], 0, i == sink ? omega * sink_frequency : omega, damping[i], dt);
    }

    void shot() {
        // Each spring's first peak is about 0.77 of the configured kick at its own damping.
        const double w = std::sqrt(spec_.settle) * motion;
        springs_[pitch].v += spec_.kick * w * 1.47;
        springs_[back].v += spec_.back * w * 1.57;
        roll_side_ = -roll_side_;
        springs_[roll].v += roll_side_ * (.55 + .45 * random_.next()) * spec_.roll * w * 1.42;
        springs_[yaw].v += (random_.next() * 2 - 1) * spec_.roll * .5 * w * 1.42;
        // The arms soak up a fraction of the push back after the muzzle has risen.
        springs_[sink].v -= spec_.back * .3 * w * sink_frequency * 2.6;
    }

    void dry_fire() {
        constexpr double dry_kick = .6;
        springs_[pitch].v += dry_kick * std::sqrt(spec_.settle) * motion;
    }

    double value(size_t spring) const { return springs_[spring].x; }

    // The recoil as a change of the gun (and everything riding it) in viewmodel space: offset * G * R_grip * G^-1,
    // where `gun` is the gun bone's matrix this frame and `grip` the right grip on it (gun space).
    Matrix34 matrix(const float *gun, const std::array<float, 3> &grip) const {
        constexpr double at_rest = 1e-7;
        bool resting = true;
        for (const auto &spring : springs_)
            resting = resting && std::abs(spring.x) < at_rest;
        if (resting) return identity34;
        Matrix34 turn{};
        angle_matrix(-springs_[pitch].x, springs_[yaw].x, springs_[roll].x, 0, 0, 0, turn);
        for (int r = 0; r < 3; r++)
            turn[r * 4 + 3] = grip[r] - (turn[r * 4] * grip[0] + turn[r * 4 + 1] * grip[1] + turn[r * 4 + 2] * grip[2]);
        Matrix34 placed{}, inverse{};
        std::copy(gun, gun + floats_per_bone, placed.begin());
        invert_rigid(gun, inverse.data());
        auto out = concat(concat(placed, turn), inverse);
        out[3] -= float(springs_[back].x);
        out[11] += float(springs_[sink].x);
        return out;
    }

private:
    static constexpr size_t pitch = 0, back = 1, roll = 2, yaw = 3, sink = 4;
    static constexpr std::array<double, 5> damping = {.5, .62, .55, .6, .8};
    // The sink's frequency relative to the others (slower: it follows the kick).
    static constexpr double sink_frequency = .55;
    static constexpr uint32_t random_base = 0x3243f6a8;

    RecoilSpec spec_;
    std::array<Spring, 5> springs_{};
    PresentationRandom random_{random_base};
    double roll_side_ = 1;
};

}  // namespace native_vm
