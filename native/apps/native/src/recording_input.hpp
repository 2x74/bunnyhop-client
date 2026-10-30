#pragma once
#include "bunnyhop_native.h"
#include "turn_settings.hpp"

namespace native {

class RecordingInput {
public:
    TurnSettings turns;

    bool begin(BhContext *core, TurnSettings settings) {
        turns = settings;
        options_ = {BH_V29_ABI_VERSION, sizeof(BhRecordOptionsV29), turns.yaw_speed, turns.angle_speed_key, 0, 0};
        active_ = bh_record_options_v29(core, &options_) != 0;
        return active_;
    }

    bool mark_timed(BhContext *core, bool contributed) {
        if (!active_ || !contributed || options_.timed_input) {
            return true;
        }
        options_.timed_input = 1;
        if (!bh_record_options_v29(core, &options_)) {
            options_.timed_input = 0;
            return false;
        }
        return true;
    }

    // Like the website, a run with null binds stays ranked: the header flag tells the anticheat to expect instant
    // key switches.
    bool mark_null_binds(BhContext *core) {
        if (!active_ || options_.null_binds) {
            return true;
        }
        options_.null_binds = 1;
        if (!bh_record_options_v29(core, &options_)) {
            options_.null_binds = 0;
            return false;
        }
        return true;
    }

    bool restore(BhContext *core) {
        active_ = bh_record_options_read_v29(core, &options_) != 0;
        if (active_) turns = {options_.yaw_speed, options_.angle_speed_key};
        return active_;
    }

    void stop() { active_ = false; }

    bool active() const { return active_; }

private:
    BhRecordOptionsV29 options_{};
    bool active_ = false;
};

}  // namespace native
