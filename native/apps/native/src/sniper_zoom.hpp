#pragma once
#include "bunnyhop_native.h"
#include <algorithm>
#include <cmath>
#include <cstdint>

namespace native {
// Presentation only: no input bits, core state or recorder are changed here.
// Web WeaponPresenter: 40/15/off; accepted sniper shots drop and resume in1.25s.
class SniperZoom {
    uint32_t weapon_ = 0;
    unsigned zoom_ = 0, resume_ = 0;
    double remaining_ = 0;

public:
    static bool sniper(uint32_t weapon) { return weapon >= 21 && weapon <= 24; }

    void reset(uint32_t weapon = 0) {
        weapon_ = weapon;
        zoom_ = resume_ = 0;
        remaining_ = 0;
    }

    bool secondary(uint32_t weapon) {
        if (weapon != weapon_) reset(weapon);
        if (!sniper(weapon)) return false;
        remaining_ = 0;
        resume_ = 0;
        zoom_ = (zoom_ + 1) % 3;
        return true;
    }

    void observe(const BhWeaponReport &weapon, const BhAttackReport *attack = nullptr) {
        if (weapon.active != weapon_) reset(weapon.active);
        if (attack && sniper(attack->weapon) && zoom_) {
            resume_ = zoom_;
            remaining_ = 1.25;
            zoom_ = 0;
        }
    }

    bool frame(double dt) {
        if (remaining_ <= 0 || !std::isfinite(dt) || dt <= 0) return false;
        remaining_ -= dt;
        if (remaining_ > 0) return false;
        remaining_ = 0;
        if (sniper(weapon_)) {
            zoom_ = resume_;
            resume_ = 0;
            return zoom_ != 0;
        }
        return false;
    }

    bool scoped() const { return zoom_ != 0; }

    unsigned level() const { return zoom_; }

    double resume_in() const { return remaining_; }

    float fov(float base) const { return zoom_ == 1 ? 40.f : zoom_ == 2 ? 15.f : base; }
};
}  // namespace native
