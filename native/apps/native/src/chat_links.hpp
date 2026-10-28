#pragma once
#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace native {
struct ChatTarget {
    std::string kind, id, url;
};

inline bool chat_identifier(std::string_view s, size_t maximum = 128, bool dot = false) {
    return !s.empty() && s.size() <= maximum && std::all_of(s.begin(), s.end(), [dot](unsigned char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-'
               || (dot && c == '.');
    });
}

// This is a navigation allowlist, never a generic external URL launcher. No
// percent escapes, credentials, ports, fragments, extra queries or other hosts.
inline std::optional<ChatTarget> safe_chat_target(std::string_view raw) {
    if (raw.size() > 512) return std::nullopt;
    std::string_view path;
    for (const auto prefix :
         {"https://bunnyhop.lol", "http://bunnyhop.lol", "https://www.bunnyhop.lol", "http://www.bunnyhop.lol"})
        if (raw.starts_with(prefix)) {
            path = raw.substr(std::string_view(prefix).size());
            break;
        }
    if (path.empty() || path[0] != '/') return std::nullopt;
    for (const auto &route : std::vector<std::pair<std::string, std::string>>{
                 {"/maps/", "map"}, {"/replay/", "replay"}, {"/u/", "profile"}
         }) {
        if (path.starts_with(route.first)) {
            const auto id = path.substr(route.first.size());
            if (id != "." && id != ".." && chat_identifier(id, 128, route.second == "map"))
                return ChatTarget{route.second, std::string(id), "https://bunnyhop.lol" + std::string(path)};
            return std::nullopt;
        }
    }
    for (const auto &route :
         std::vector<std::pair<std::string, std::string>>{{"/?lobby=", "lobby"}, {"/?server=", "server"}})
        if (path.starts_with(route.first)) {
            const auto id = path.substr(route.first.size());
            if (chat_identifier(id, 64))
                return ChatTarget{route.second, std::string(id), "https://bunnyhop.lol" + std::string(path)};
            return std::nullopt;
        }
    return std::nullopt;
}

inline std::optional<ChatTarget> chat_profile_target(std::string_view id) {
    return chat_identifier(id) ? safe_chat_target("https://bunnyhop.lol/u/" + std::string(id)) : std::nullopt;
}

struct ChatLinkSpan {
    size_t begin = 0, end = 0;
    ChatTarget target;
};

inline std::vector<ChatLinkSpan> chat_links(std::string_view text) {
    std::vector<ChatLinkSpan> out;
    for (size_t at = 0; at < text.size() && out.size() < 32;) {
        const auto https = text.find("https://", at), http = text.find("http://", at);
        const auto start = std::min(https, http);
        if (start == std::string_view::npos) break;
        size_t end = start;
        while (end < text.size() && uint8_t(text[end]) > 32 && text[end] != '<' && text[end] != '>' && text[end] != '"')
            ++end;
        size_t trimmed = end;
        while (trimmed > start && std::string_view(".,!?;:)]}").find(text[trimmed - 1]) != std::string_view::npos)
            --trimmed;
        if (const auto target = safe_chat_target(text.substr(start, trimmed - start)))
            out.push_back({start, trimmed, *target});
        at = end > start ? end : start + 1;
    }
    return out;
}

struct ChatHitBox {
    float x = 0, y = 0, width = 0, height = 0;
    ChatTarget target;
    uint64_t sequence = 0;
};

// Geometry belongs to a particular visible, scrolled viewport. A changed chat
// viewport must invalidate hit targets before another pointer event is handled.
class ChatLinkHits {
    std::vector<ChatHitBox> boxes;
    uint64_t viewport_ = 0;

public:
    void set(std::vector<ChatHitBox> next, uint64_t viewport) {
        boxes = std::move(next);
        viewport_ = viewport;
    }

    void clear() { boxes.clear(); }

    std::optional<ChatTarget> hit(float x, float y, uint64_t viewport) const {
        if (viewport != viewport_) return std::nullopt;
        for (auto it = boxes.rbegin(); it != boxes.rend(); ++it)
            if (it->width > 0 && it->height > 0 && x >= it->x && x < it->x + it->width && y >= it->y
                && y < it->y + it->height)
                return it->target;
        return std::nullopt;
    }

    const std::vector<ChatHitBox> &regions() const { return boxes; }
};
}  // namespace native
