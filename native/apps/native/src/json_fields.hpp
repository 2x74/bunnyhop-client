#pragma once
#include <nlohmann/json.hpp>
#include <cstdint>
#include <string>
#include <type_traits>

namespace native {

// A field of a message or manifest, or `fallback` when the message isn't an object or the field is missing, null or of
// another type. nlohmann's value() throws on any of those, and a throw there used to spam chat and drop map changes.
template <class T>
T json_value(const nlohmann::json &object, const char *key, T fallback) {
    const auto found = object.find(key);
    if (found == object.end() || found->is_null()) return fallback;
    if constexpr (std::is_same_v<T, nlohmann::json>)
        return *found;
    else if constexpr (std::is_same_v<T, bool>)
        return found->is_boolean() ? found->get<bool>() : fallback;
    else if constexpr (std::is_same_v<T, std::string>)
        return found->is_string() ? found->get<std::string>() : fallback;
    else {
        static_assert(std::is_arithmetic_v<T>);
        if (!found->is_number()) return fallback;
        if constexpr (std::is_unsigned_v<T>)
            if (found->is_number_integer() && !found->is_number_unsigned() && found->get<int64_t>() < 0)
                return fallback;
        return found->get<T>();
    }
}

}  // namespace native
