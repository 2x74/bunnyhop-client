#pragma once
#include "ghost_slots.hpp"
#include "renderer.hpp"
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace native {

// Slot 0 is the ghost the HUD races against; its name tag carries the time and the live delta.
inline constexpr std::string_view primary_ghost_id = "ghost-0";

struct GhostFrameContext {
    BhContext *core = nullptr;
    const BhRunState &run;
    uint32_t tick = 0;
    float blend = 1;
    uint32_t track = 0;
    const std::string &style;
    const std::string &outfit;
    float opacity = .55f;
};

struct PrimaryGhost {
    bool shown = false;
    BhCmd command{};
};

inline const native_render::Actor *find_primary_ghost(const std::vector<native_render::Actor> &actors) {
    for (const auto &actor : actors)
        if (actor.id == primary_ghost_id) return &actor;
    return nullptr;
}

inline bool
ghost_slot_races(const GhostSlot &slot, const Renderer &renderer, unsigned index, const GhostFrameContext &context) {
    return slot.handle && slot.enabled && renderer.ghost_visible(index) && slot.info.value("track", 0u) == context.track
           && slot.info.value("style", std::string("autohop")) == context.style;
}

// Adds every race ghost to the frame's actors, all four slots alike: your outfit with the runner's loadout, as the
// website draws them. Returns slot 0's recorded keys for the HUD.
inline PrimaryGhost append_ghost_actors(
        GhostSlots &ghosts,
        Renderer &renderer,
        const GhostFrameContext &context,
        std::vector<native_render::Actor> &actors
) {
    PrimaryGhost primary;
    const auto elapsed =
            native_render::ghost_elapsed_ticks(context.run.status, context.tick, context.run.start_tick, context.blend);
    for (unsigned index = 0; index < GhostSlots::slot_count; ++index) {
        const auto &slot = ghosts.slots[index];
        if (!ghost_slot_races(slot, renderer, index, context)) {
            ghosts.cursors[index].reset();
            continue;
        }
        native_render::Actor actor;
        actor.id = "ghost-" + std::to_string(index);
        if (!ghosts.present(context.core, index, renderer.ghost_path(index), elapsed, actor)) continue;
        actor.name = renderer.ghost_name(index);
        actor.outfit = context.outfit;
        actor.loadout = renderer.ghost_loadout(index);
        actor.opacity = context.opacity;
        renderer.decorate_ghost(actor, index);
        if (index == 0) {
            primary.shown = true;
            if (actor.frame.tick <= renderer.ghost_path(0).end)
                bh_ghost_command(context.core, slot.handle, actor.frame.tick, &primary.command);
        }
        actors.push_back(std::move(actor));
    }
    return primary;
}

}  // namespace native
