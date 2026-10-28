#pragma once
#include "bunnyhop_native.h"
#include <algorithm>
#include <cstdint>
#include <deque>
#include <optional>
#include <vector>

namespace native {
constexpr uint32_t give_shift = 16, give_mask = 0x1fu << give_shift, give_restore = 1u << 21, give_mode = 1u << 22;
constexpr uint32_t weapon_command_mask = give_mask | give_restore | give_mode;

inline bool ranked_command_weapon(uint32_t id) {
    return id == 1 || id == 2 || id == 3;
}

// apps/web/src/weapon-rules.ts KeptWeapons. Accepted GIVEN reports alone
// remember a commanded weapon; cooldown-rejected requests never affect it.
class KeptWeapons {
    struct Kept {
        uint32_t slot, id;
        bool mode;
    };

    std::vector<Kept> kept;
    std::deque<uint32_t> queue;
    unsigned wait = 0;
    std::optional<BhWeaponReport> previous;

public:
    std::vector<uint32_t> weapons() const {
        std::vector<uint32_t> out;
        for (const auto &v : kept)
            out.push_back(v.id);
        return out;
    }

    std::vector<bool> modes() const {
        std::vector<bool> out;
        for (const auto &v : kept)
            out.push_back(v.mode);
        return out;
    }

    size_t queued() const { return queue.size(); }

    void observe(const BhWeaponReport &r) {
        const auto prev = previous;
        previous = r;
        if ((r.flags & 32) && prev)
            std::erase_if(kept, [&](const Kept &k) {
                return (k.slot == 1 ? r.primary : r.secondary) == 0
                       && (k.slot == 1 ? prev->primary : prev->secondary) != 0;
            });
        if (r.flags & 512) {
            if (r.active == 1) {
                forget();
                return;
            }
            const uint32_t slot = r.primary == r.active ? 1 : r.secondary == r.active ? 2 : 0;
            if (slot) {
                std::erase_if(kept, [&](const Kept &k) { return k.slot == slot; });
                kept.push_back({slot, r.active, false});
            }
        }
        for (auto &k : kept)
            if (k.id == r.active && (k.slot == 1 ? r.primary : r.secondary) == r.active) k.mode = r.silencer || r.burst;
    }

    void forget() {
        kept.clear();
        queue.clear();
    }

    void cancel() { queue.clear(); }

    std::vector<uint32_t> restarted(bool any_gun, bool restore = false) {
        previous.reset();
        wait = 0;
        queue.clear();
        std::vector<uint32_t> ids;
        for (const auto &k : kept)
            if (any_gun || ranked_command_weapon(k.id)) {
                queue.push_back(k.id | (restore ? 32u | (k.mode ? 64u : 0u) : 0u));
                ids.push_back(k.id);
            }
        return ids;
    }

    // Unshifted command value (id + restore/mode flags): shift by give_shift
    // into buttons, replacing weapon_command_mask, before constructing BhCmd.
    uint32_t next() {
        if (wait) {
            --wait;
            return 0;
        }
        if (queue.empty()) return 0;
        const auto result = queue.front();
        queue.pop_front();
        wait = 9;
        return result;
    }
};
}  // namespace native
