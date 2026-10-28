#pragma once
#include "bunnyhop_native.h"
#include "ghost_trails.hpp"
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
    static float opacity(const BhState &player, const BhGhostFrame &ghost, float opacity, bool near_fade);
};

}  // namespace native
