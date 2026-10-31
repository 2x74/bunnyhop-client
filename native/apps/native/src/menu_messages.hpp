#pragma once
#include <cstddef>
#include <string>
#include <string_view>

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

// The address a web view reports for the menu moves when a shared screen calls history.replaceState, so a message is
// judged by the document's origin. Nothing but the bundled document can ever be on this origin: the hosts cancel every
// navigation after the first.
inline bool menu_message_source_trusted(std::wstring_view source) {
    constexpr std::wstring_view game_origin = L"https://bunnyhop.lol/";
    return source.starts_with(game_origin);
}

}  // namespace native
