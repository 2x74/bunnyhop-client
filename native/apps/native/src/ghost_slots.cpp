#include "ghost_slots.hpp"
#include "data_location.hpp"
#include <algorithm>
#include <stdexcept>

namespace native {
namespace {

void require(bool ok, BhContext *core, const char *operation) {
    if (!ok) {
        const char *error = bh_last_error(core);
        throw std::runtime_error(std::string(operation) + ": " + (error && *error ? error : "native core failed"));
    }
}

}  // namespace

void GhostSlots::load(BhContext *core, const std::filesystem::path &path, unsigned index) {
    if (index >= slots.size()) throw std::runtime_error("Invalid ghost slot");
    auto &slot = slots[index];
    if (slot.handle) bh_ghost_free(core, slot.handle);
    slot = {};
    cursors[index].reset();
    if (index == 0) {
        handle = 0;
        enabled = false;
        id.clear();
    }
    const auto next = bh_ghost_load(core, data_location::utf8(path).c_str());
    require(next != 0, core, "Loading ghost");
    size_t bytes = 0;
    const auto raw = bh_ghost_info(core, next, &bytes);
    require(raw != nullptr, core, "Reading ghost");
    slot = {next, data_location::utf8(path.filename()), true, nlohmann::json::parse(raw, raw + bytes)};
}

void GhostSlots::select_primary() {
    handle = slots[0].handle;
    enabled = slots[0].enabled;
    id = slots[0].id;
    info = slots[0].info;
}

void GhostSlots::clear_for_tutorial(BhContext *core) {
    for (size_t i = 1; i < slots.size(); ++i)
        if (slots[i].handle) bh_ghost_free(core, slots[i].handle);
    slots = {};
    if (handle) {
        bh_ghost_free(core, handle);
        handle = 0;
    }
    enabled = false;
}

bool GhostSlots::control(BhContext *core, const nlohmann::json &message) {
    const auto action = message.at("action").get<std::string>();
    const unsigned slot = message.value("slot", 0u);
    if (slot >= slot_count) throw std::runtime_error("Invalid ghost slot");
    if (action != "remove" && action != "clear" && action != "toggle") throw std::runtime_error("Invalid ghost action");
    for (unsigned i = 0; i < slot_count; i++)
        if (action == "clear" || i == slot) {
            auto &ghost = slots[i];
            if (action == "toggle")
                ghost.enabled = ghost.handle && message.value("enabled", !ghost.enabled);
            else {
                if (core && ghost.handle) bh_ghost_free(core, ghost.handle);
                ghost = {};
            }
            if (i == 0) select_primary();
        }
    return action == "clear" || slot == 0;
}

void GhostSlots::toggle(const nlohmann::json &message) {
    enabled = handle && message.at("enabled").get<bool>();
    slots[0].enabled = enabled;
}

bool GhostSlots::present(
        BhContext *core,
        unsigned index,
        const native_render::GhostPath &path,
        std::optional<double> elapsed,
        native_render::Actor &actor
) {
    const auto &slot = slots.at(index);
    native_render::GhostPose pose;
    if (!slot.handle || !native_render::pose_ghost(path, elapsed, pose)) return false;
    actor.frame = pose.frame;
    actor.frame.tick = uint32_t(pose.tick);
    actor.attack = 0;
    actor.inspect = 0;
    actor.inspectHeld = false;
    const auto range = cursors[index].advance(pose.tick, pose.moving, actor.snapped);
    BhReplayEvents events{};
    if (range && bh_ghost_events(core, slot.handle, range->first, range->second, &events)) {
        actor.attack = events.cosmetic;
        actor.inspect = events.inspect_signal;
        actor.inspectHeld = events.inspect_held != 0;
    }
    return true;
}

}  // namespace native
