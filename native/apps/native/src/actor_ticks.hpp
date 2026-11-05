#pragma once
// Tick presentation for a bunny posed once per simulation tick (web player/bunny/model.ts present, used through
// player/tick-stepper.ts by the replay viewer): each frame shows it `amount` of the way from the tick before to the
// last one (skinning, feet yaw, bank and root), so between ticks above the tick rate it moves instead of holding its
// pose. A tick that teleported or snapped the model holds the tick before until it's all the way there.
#include <algorithm>
#include <array>
#include <cmath>
#include <span>
#include <vector>

namespace native_actor_anim {

struct ShownPose {
    double feet_yaw = 0, bank = 0;
    std::array<float, 3> root{};
};

class TickPresentation {
public:
    // A new tick's output. The first one after a reset stands for both ticks.
    void
    keep(std::span<const float> skin, double feet_yaw, double bank, const std::array<float, 3> &root, bool snapped) {
        if (!has_ticks_) {
            store(previous_, skin, feet_yaw, bank, root, snapped);
            has_ticks_ = true;
        } else
            std::swap(previous_, current_);
        store(current_, skin, feet_yaw, bank, root, snapped);
    }

    void reset() { has_ticks_ = false; }

    // Writes the shown skinning into `skin` (its size must be the kept ticks') and returns the shown yaw, bank, root.
    ShownPose present(double amount, std::span<float> skin) const {
        const double a = !has_ticks_ ? 1 : current_.snapped ? (amount >= 1 ? 1 : 0) : std::clamp(amount, 0., 1.);
        if (!has_ticks_ || skin.size() != current_.skin.size() || previous_.skin.size() != current_.skin.size())
            return {current_.feet_yaw, current_.bank, current_.root};
        for (size_t i = 0; i < skin.size(); i++)
            skin[i] = float(previous_.skin[i] + (current_.skin[i] - previous_.skin[i]) * a);
        ShownPose shown;
        shown.feet_yaw = previous_.feet_yaw + std::remainder(current_.feet_yaw - previous_.feet_yaw, 360.) * a;
        shown.bank = previous_.bank + (current_.bank - previous_.bank) * a;
        for (size_t k = 0; k < 3; k++)
            shown.root[k] = float(previous_.root[k] + (current_.root[k] - previous_.root[k]) * a);
        return shown;
    }

private:
    struct Tick {
        std::vector<float> skin;
        double feet_yaw = 0, bank = 0;
        std::array<float, 3> root{};
        bool snapped = false;
    };

    static void
    store(Tick &tick,
          std::span<const float> skin,
          double feet_yaw,
          double bank,
          const std::array<float, 3> &root,
          bool snapped) {
        tick.skin.assign(skin.begin(), skin.end());
        tick.feet_yaw = feet_yaw;
        tick.bank = bank;
        tick.root = root;
        tick.snapped = snapped;
    }

    Tick previous_, current_;
    bool has_ticks_ = false;
};

}  // namespace native_actor_anim
