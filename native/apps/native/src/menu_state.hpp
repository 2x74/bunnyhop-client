#pragma once
#include <nlohmann/json.hpp>
#include <string>

namespace native {

// onState already merges top-level fields. Keep slices whole so older menus
// receive the same objects, and send a full snapshot after ready or reopening.
class MenuState {
  public:
    void reset() {
        full_ = true;
    }
    void settings_changed() {
        settings_dirty_ = true;
    }
    void replays_changed() {
        replays_dirty_ = true;
    }
    bool needs_full(bool visible) const {
        return full_ || (visible && !visible_);
    }

    std::string publish(nlohmann::json state, bool visible, const nlohmann::json &settings,
                        const nlohmann::json &replays) {
        const bool full = needs_full(visible);
        if (full || (visible && settings_dirty_)) {
            state["settings"] = settings;
            settings_dirty_ = false;
        }
        if (full || (visible && replays_dirty_)) {
            state["replays"] = replays;
            replays_dirty_ = false;
        }
        nlohmann::json changed = nlohmann::json::object();
        for (auto field = state.begin(); field != state.end(); ++field) {
            const auto previous = sent_.find(field.key());
            if (full || previous == sent_.end() || *previous != field.value()) {
                changed[field.key()] = field.value();
                sent_[field.key()] = std::move(field.value());
            }
        }
        // The world-record receiver validates these fields together.
        if (changed.contains("map") || changed.contains("style") || changed.contains("track") ||
            changed.contains("runGeneration") || changed.contains("loading")) {
            for (const char *key : {"map", "style", "track", "runGeneration", "loading"}) {
                if (sent_.contains(key))
                    changed[key] = sent_.at(key);
            }
        }
        full_ = false;
        visible_ = visible;
        if (changed.empty())
            return {};
        return "window.bunnyhopNativeMenu?.onState(" + changed.dump() + ")";
    }

  private:
    nlohmann::json sent_ = nlohmann::json::object();
    bool full_ = true;
    bool visible_ = false;
    bool settings_dirty_ = true;
    bool replays_dirty_ = true;
};

} // namespace native
