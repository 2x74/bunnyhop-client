#pragma once
#include "native_input.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <memory>
#include <vector>
#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>

namespace native {

// The command button an action holds (forward, jump, attack...), or 0 for actions that are not held buttons.
inline uint32_t movement_bit(std::string_view action) {
    if (action == "forward") return forward;
    if (action == "back") return back;
    if (action == "left") return left;
    if (action == "right") return right;
    if (action == "jump") return jump;
    if (action == "duck") return duck;
    if (action == "use") return use;
    if (action == "attack") return attack;
    if (action == "attack2") return attack2;
    if (action == "turnLeft") return turn_left;
    if (action == "turnRight") return turn_right;
    if (action == "turnFast") return turn_fast;
    return 0;
}

// Physical code -> held command bits. Rebuilt when the binds change, so a tick never walks the settings JSON.
// Wheel codes are pulses (one tick per notch), never held.
class BindTable {
public:
    struct Binding {
        std::string action;
        uint32_t bit;
        std::vector<std::string> codes;
    };

    using Bindings = std::vector<Binding>;

    void rebuild(const nlohmann::json &binds) {
        bits_.clear();
        auto bindings = std::make_shared<Bindings>();
        bindings->reserve(binds.size());
        for (auto binding = binds.begin(); binding != binds.end(); ++binding) {
            Binding typed{binding.key(), movement_bit(binding.key()), {}};
            for (const auto &code : binding.value()) {
                if (!code.is_string()) continue;
                typed.codes.push_back(code.get<std::string>());
                if (typed.bit && !is_wheel(typed.codes.back())) bits_[typed.codes.back()] |= typed.bit;
            }
            bindings->push_back(std::move(typed));
        }
        bindings_ = std::move(bindings);
    }

    // A settings action can rebuild this table during dispatch. Finish that event using its original binds.
    std::shared_ptr<const Bindings> snapshot() const { return bindings_; }

    const std::vector<std::string> &codes(std::string_view action) const {
        for (const auto &binding : *bindings_)
            if (binding.action == action) return binding.codes;
        static const std::vector<std::string> empty;
        return empty;
    }

    bool is_bound(std::string_view action, const std::string &code) const {
        const auto &keys = codes(action);
        return std::find(keys.begin(), keys.end(), code) != keys.end();
    }

    template <class Codes>
    bool held_action(std::string_view action, const Codes &held_codes) const {
        for (const auto &key : codes(action))
            if (held_codes.contains(key)) return true;
        return false;
    }

    bool custom_mouse_binding(const std::string &code) const {
        for (const auto &binding : *bindings_) {
            if (binding.action == "attack" || binding.action == "attack2") continue;
            for (const auto &key : binding.codes)
                if (key == code) return true;
        }
        return false;
    }

    static bool is_wheel(std::string_view code) {
        return code == "MouseWheel" || code == "MWheelUp" || code == "MWheelDown";
    }

    uint32_t of(const std::string &code) const {
        const auto found = bits_.find(code);
        return found == bits_.end() ? 0 : found->second;
    }

    template <class Codes>
    uint32_t held(const Codes &codes) const {
        uint32_t out = 0;
        for (const auto &code : codes) {
            out |= of(code);
        }
        return out;
    }

private:
    std::unordered_map<std::string, uint32_t> bits_;
    std::shared_ptr<const Bindings> bindings_ = std::make_shared<Bindings>();
};

}  // namespace native
