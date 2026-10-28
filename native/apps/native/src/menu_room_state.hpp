#pragma once
#include <nlohmann/json.hpp>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace native {

struct MenuRoomView {
    std::string_view map;
    std::string_view selected_style;
    std::string_view active_style;
    std::string_view room_id;
    std::string_view room_map;
    unsigned track;
    uint64_t generation;
    std::optional<unsigned> target;
    bool loading;
    bool practice;
    bool frozen;
};

// Compare typed fields before allocating or serializing a hidden-menu update.
class MenuRoomState {
public:
    nlohmann::json update(const MenuRoomView &next) {
        if (sent_ && next.map == map_ && next.selected_style == selected_style_ && next.active_style == active_style_
            && next.room_id == room_id_ && next.room_map == room_map_ && next.track == track_
            && next.generation == generation_ && next.target == target_ && next.loading == loading_
            && next.practice == practice_ && next.frozen == frozen_)
            return nullptr;
        map_ = next.map;
        selected_style_ = next.selected_style;
        active_style_ = next.active_style;
        room_id_ = next.room_id;
        room_map_ = next.room_map;
        track_ = next.track;
        generation_ = next.generation;
        target_ = next.target;
        loading_ = next.loading;
        practice_ = next.practice;
        frozen_ = next.frozen;
        sent_ = true;
        return {{"map", map_},
                {"style", selected_style_},
                {"track", track_},
                {"runGeneration", generation_},
                {"loading", loading_},
                {"player",
                 {{"map", map_},
                  {"style", active_style_},
                  {"track", track_},
                  {"mode", "multiplayer"},
                  {"practice", practice_}}},
                {"room",
                 {{"id", room_id_},
                  {"map", room_map_},
                  {"spectating", target_.has_value()},
                  {"target", target_ ? nlohmann::json(*target_) : nlohmann::json(nullptr)},
                  {"raceFrozen", frozen_}}}};
    }

private:
    std::string map_;
    std::string selected_style_;
    std::string active_style_;
    std::string room_id_;
    std::string room_map_;
    unsigned track_ = 0;
    uint64_t generation_ = 0;
    std::optional<unsigned> target_;
    bool loading_ = false;
    bool practice_ = false;
    bool frozen_ = false;
    bool sent_ = false;
};

}  // namespace native
