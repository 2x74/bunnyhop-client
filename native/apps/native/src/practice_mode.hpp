#pragma once
#include "practice.hpp"
#include "start_point.hpp"
#include <optional>

namespace native {

struct PracticeMode {
    enum class Change { unchanged, on, off, cleared_spawns };

    template <class Enter, class Restart>
    static Change
    apply(Practice &practice,
          StartPoints &points,
          const std::string &map,
          std::optional<bool> requested,
          Enter &&enter,
          Restart &&restart) {
        const bool on = requested.value_or(!practice.mode);
        if (on) {
            if (practice.mode) return Change::unchanged;
            practice.mode = true;
            practice.tool.clear();
            enter("");
            return Change::on;
        }
        // A saved spawn can taint an attempt even when the mode is already off.
        practice.noclip = false;
        practice.mode = false;
        const bool cleared = points.clear_practice(map);
        restart();
        return cleared ? Change::cleared_spawns : Change::off;
    }
};

}  // namespace native
