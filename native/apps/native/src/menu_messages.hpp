#pragma once
#include <cstddef>
#include <string>

namespace native {

constexpr std::size_t kMenuMessageBytes = 16 * 1024;
constexpr std::size_t kMenuRoomMessageBytes = 128 * 1024;
// A settings file saved through the host (menu_files.hpp), with JSON escaping.
constexpr std::size_t kMenuFileMessageBytes = 2 * 1024 * 1024;
constexpr std::size_t kMenuReplayMessageBytes = 12 * 1024 * 1024;

// The largest message of each type the host accepts from the menu.
inline std::size_t menu_message_limit(const std::string &type) {
    if (type == "replayData" || type == "menuBackdrop") return kMenuReplayMessageBytes;
    if (type == "roomSnapshot" || type == "roomEvent") return kMenuRoomMessageBytes;
    if (type == "file") return kMenuFileMessageBytes;
    return kMenuMessageBytes;
}

}  // namespace native
