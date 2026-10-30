#include "practice_controller.hpp"
#include <stdexcept>

namespace native {
namespace {

void require(bool ok, BhContext *core, const char *operation) {
    if (!ok) {
        const char *error = bh_last_error(core);
        throw std::runtime_error(std::string(operation) + ": " + (error && *error ? error : "native core failed"));
    }
}

std::string binding_label(const BindTable &binds, const char *action) {
    const auto &keys = binds.codes(action);
    if (keys.empty()) {
        const std::string_view name(action);
        return name == "cpSave" ? "!save" : name == "cpTeleport" ? "!tele" : "!nc";
    }
    std::string key = keys[0];
    if (key == "Backquote") return "`";
    if (key.starts_with("Key") || key.starts_with("Digit")) return key.substr(key.starts_with("Key") ? 3 : 5);
    if (key.starts_with("Mouse")) return "M" + key.substr(5);
    return key;
}

}  // namespace

std::optional<std::string> PracticeController::activate(BhContext *core, const std::string &used_tool) {
    if (active) return std::nullopt;
    BhRunState timing{};
    bh_run_state(core, &timing);
    active = true;
    segment_status(-1);
    tool = used_tool;
    return timing.status == 1 ? "This run is practice now. Press R to restart for a real run."
                              : "Practice until you restart. Press R for a real run.";
}

nlohmann::json PracticeController::enter(
        BhContext *core,
        const std::string &used_tool,
        RunRecorder &recorder,
        RunHeartbeat &heartbeat,
        std::string &score_notice
) {
    require(bh_practice_enter(core, used_tool == "noclip"), core, "Entering practice");
    recorder.input.stop();
    recorder.clear(false);
    score_notice.clear();
    return heartbeat.invalidate();
}

std::string PracticeController::help(const BindTable &binds) {
    return "Practice: no scores. " + binding_label(binds, "noclip") + ": noclip | " + binding_label(binds, "cpSave")
           + ": save checkpoint | " + binding_label(binds, "cpTeleport") + ": teleport.";
}

void PracticeController::save(
        BhContext *core,
        const Input &input,
        const std::string &selected_style,
        const std::string &active_style,
        uint32_t track
) {
    auto handle = bh_practice_save(core, float(input.yaw()), float(input.pitch));
    // Retain the newest 100 snapshots within the bridge's 128 MiB cap.
    // On large maps evict the oldest and retry, as the web checkpoint store does.
    while (!handle && !checkpoints.empty() && std::string(bh_last_error(core)).find("Segmented") == std::string::npos) {
        bh_practice_free(core, checkpoints.front().handle);
        checkpoints.erase(checkpoints.begin());
        handle = bh_practice_save(core, float(input.yaw()), float(input.pitch));
    }
    require(handle != 0, core, "Saving checkpoint");
    retain({handle, selected_style, active_style, track});
}

void PracticeController::begin_flight(const BhState &state) {
    for (int k = 0; k < 3; k++) {
        flight.position[k] = state.position[k];
        flight.velocity[k] = state.velocity[k];
    }
}

bool PracticeController::exit_flight(BhContext *core, const Input &input, BhState &current_state, BhState &previous) {
    BhSnapshot snapshot{};
    const auto result = bh_practice_noclip_exit(core, &flight, float(input.yaw()), float(input.pitch), &snapshot);
    noclip = false;
    current_state = previous = snapshot.player;
    return result;
}

BhCmd PracticeController::restore(BhContext *core) const {
    BhSnapshot snapshot{};
    BhCmd view{};
    const auto handle = checkpoints[current].handle;
    const auto restored = segmented ? bh_segment_restore(core, handle, &view, &snapshot)
                                    : bh_practice_restore(core, handle, &view, &snapshot);
    require(restored, core, "Restoring checkpoint");
    return view;
}

BhState PracticeController::restore_velocity(BhContext *core, bool keep_velocity) {
    if (!segmented && !keep_velocity) require(bh_set_velocity(core, 0, 0, 0), core, "Clearing checkpoint speed");
    BhState state{};
    require(bh_state(core, &state), core, "Reading checkpoint");
    return state;
}

nlohmann::json PracticeController::state(const std::string &unavailable, bool third_person, bool keep_velocity) const {
    return {{"available", unavailable.empty()},
            {"unavailable", unavailable.empty() ? nlohmann::json(nullptr) : nlohmann::json(unavailable)},
            {"mode", mode},
            {"active", active},
            {"thirdPerson", third_person},
            {"tool", tool.empty() ? nlohmann::json(nullptr) : nlohmann::json(tool)},
            {"noclip", noclip},
            {"menuOpen", menu_open},
            {"count", checkpoints.size()},
            {"current", number()},
            {"keepVelocity", keep_velocity}};
}

}  // namespace native
