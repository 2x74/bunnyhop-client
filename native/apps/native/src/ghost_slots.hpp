#pragma once
#include "bunnyhop_native.h"
#include "ghost_playback.hpp"
#include "render_shaders.hpp"
#include <nlohmann/json.hpp>
#include <array>
#include <filesystem>
#include <string>

namespace native {

struct GhostSlot {
    uint32_t handle = 0;
    std::string id;
    bool enabled = false;
    nlohmann::json info;
};

struct GhostSlots {
    static constexpr unsigned slot_count = 4;
    std::array<GhostSlot, slot_count> slots;
    std::array<native_render::GhostSource, slot_count> sources{};
    uint32_t handle = 0;
    std::string id;
    bool enabled = false;
    nlohmann::json info;

    void load(BhContext *core, const std::filesystem::path &path, unsigned slot);
    void select_primary();
    void clear_for_tutorial(BhContext *core);
    bool control(BhContext *core, const nlohmann::json &message);
    void toggle(const nlohmann::json &message);
    std::array<native_render::GhostEventCursor, slot_count> cursors;

    // Poses slot `index` for this frame and adds the swings and inspects it played since the last one.
    bool
    present(BhContext *core,
            unsigned index,
            const native_render::GhostPath &path,
            std::optional<double> elapsed,
            native_render::Actor &actor);
};

}  // namespace native
