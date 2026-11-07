#pragma once
#include <cstdint>
#include <string>

namespace native {
struct RoomModeAction {
    bool restart = false, stop_spectating = false;
    uint32_t track = 0;
    // Bonus races leave the selected main-track style alone; reset chooses Normal.
    std::string style;
    bool canonical_start = false;
    bool room_race_go = false, room_race_finish = false, room_race_over = false;
};
}  // namespace native
