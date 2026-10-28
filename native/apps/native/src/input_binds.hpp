#pragma once
#include "native_input.hpp"
#include <nlohmann/json.hpp>
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
    return 0;
}

// Physical code -> held command bits. Rebuilt when the binds change, so a tick never walks the settings JSON.
// Wheel codes are pulses (one tick per notch), never held.
class BindTable {
public:
    void rebuild(const nlohmann::json &binds) {
        bits_.clear();
        for (auto binding = binds.begin(); binding != binds.end(); ++binding) {
            const uint32_t bit = movement_bit(binding.key());
            if (!bit) {
                continue;
            }
            for (const auto &code : binding.value()) {
                if (code.is_string() && !is_wheel(code.get<std::string>())) {
                    bits_[code.get<std::string>()] |= bit;
                }
            }
        }
    }

    static bool is_wheel(std::string_view code) {
        return code == "MouseWheel" || code == "MWheelUp" || code == "MWheelDown";
    }

    uint32_t of(const std::string &code) const {
        const auto found = bits_.find(code);
        return found == bits_.end() ? 0 : found->second;
    }

    template <class Codes> uint32_t held(const Codes &codes) const {
        uint32_t out = 0;
        for (const auto &code : codes) {
            out |= of(code);
        }
        return out;
    }

private:
    std::unordered_map<std::string, uint32_t> bits_;
};

}  // namespace native
