#pragma once
// Discord Rich Presence and Join over Discord's local IPC socket.
//
// Same protocol and rules as the Electron client's electron/discord-rpc.mjs:
// frames are [u32 op][u32 length][JSON], a handshake with the application id,
// then SET_ACTIVITY at most once a second and only when it changed. Polled
// from the game loop and never blocks: if Discord isn't running the connect
// fails immediately and is retried on a backoff (2, 5, 10, 30, 60 s).
//
// Join: while you're on a public server the activity carries a party (a hash
// of the room id) and a join secret instead of the Play button. A friend's
// Join arrives as ACTIVITY_JOIN; the secret is checked and turned back into a
// room id. Private lobbies are shared only with discordJoinLobbies on, and
// never in privacy mode.
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <functional>
#include <optional>
#include <random>
#include <regex>
#include <string>
#include <vector>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <cerrno>
#include <cstdlib>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace native::discord {
using Json = nlohmann::json;
inline constexpr const char *application_id = "1556467060916224040";
inline constexpr const char *logo_url = "https://bunnyhop.lol/icons/icon-512.png";
inline constexpr uint32_t op_handshake = 0, op_frame = 1, op_close = 2, op_ping = 3, op_pong = 4;
inline constexpr size_t max_frame = 64 * 1024;

inline std::string encode_frame(uint32_t op, const Json &payload) {
    const auto body = payload.dump();
    if (body.size() > max_frame) throw std::runtime_error("Discord RPC frame is too large");
    std::string out(8, '\0');
    for (int i = 0; i < 4; ++i) {
        out[i] = char((op >> (8 * i)) & 255);
        out[4 + i] = char((body.size() >> (8 * i)) & 255);
    }
    return out + body;
}

struct Frame {
    uint32_t op;
    Json payload;
};

// Takes bytes off the front of |buffer| as whole frames arrive.
inline std::vector<Frame> decode_frames(std::string &buffer) {
    std::vector<Frame> frames;
    while (buffer.size() >= 8) {
        auto u32 = [&](size_t at) {
            uint32_t v = 0;
            for (int i = 3; i >= 0; --i)
                v = (v << 8) | uint8_t(buffer[at + i]);
            return v;
        };
        const uint32_t op = u32(0), length = u32(4);
        if (length > max_frame) throw std::runtime_error("Discord RPC frame exceeded the limit");
        if (buffer.size() < 8 + size_t(length)) break;
        frames.push_back({op, Json::parse(buffer.substr(8, length))});
        buffer.erase(0, 8 + size_t(length));
    }
    return frames;
}

inline std::string clean(std::string value, size_t max = 80) {
    std::string out;
    for (unsigned char c : value)
        if (c >= 32 && c != 127) out += char(c);
    const auto first = out.find_first_not_of(' '), last = out.find_last_not_of(' ');
    out = first == std::string::npos ? "" : out.substr(first, last - first + 1);
    if (out.size() > max) {
        out.resize(max);
        while (!out.empty() && (uint8_t(out.back()) & 0xC0) == 0x80)
            out.pop_back();
        if (!out.empty() && uint8_t(out.back()) >= 0xC0) out.pop_back();
    }
    return out;
}

inline bool server_id(const std::string &id) {
    static const std::regex re("^[a-z0-9][a-z0-9-]{0,31}$");
    return std::regex_match(id, re);
}

inline bool lobby_id(const std::string &id) {
    static const std::regex re("^p-[a-z2-7]{10}$");
    return std::regex_match(id, re);
}

inline std::string join_secret(const std::string &room) {
    return lobby_id(room) ? "bh1:l:" + room.substr(2) : "bh1:s:" + room;
}

// The room a Join secret leads to, or nothing. Secrets come from Discord, so
// they're checked like any other input.
inline std::optional<std::string> join_target(const std::string &secret) {
    static const std::regex re("^bh1:(s|l):([a-z0-9-]{1,32})$");
    std::smatch m;
    if (!std::regex_match(secret, m, re)) return std::nullopt;
    if (m[1] == "l") {
        const auto id = "p-" + m[2].str();
        return lobby_id(id) ? std::optional(id) : std::nullopt;
    }
    return server_id(m[2]) && !lobby_id(m[2]) ? std::optional(m[2].str()) : std::nullopt;
}

struct Settings {
    bool enabled = true, show_map = true, join = true, join_lobbies = false, privacy = false;
};

inline Settings settings_from(const Json &prefs) {
    Settings s;
    s.enabled = prefs.value("discordRichPresence", true);
    s.show_map = prefs.value("discordShowMap", true);
    s.join = prefs.value("discordJoin", true);
    s.join_lobbies = prefs.value("discordJoinLobbies", false);
    s.privacy = prefs.value("privacyMode", false);
    return s;
}

// What the game is doing; client.cpp fills this each frame.
struct Status {
    std::string kind = "menu";  // menu | playing | paused | replay
    std::string mode = "solo";  // solo | multiplayer | practice | replay
    std::string map, style;     // style is the display name ("Normal")
    int64_t started_at = 0;     // unix seconds
    std::string room;           // room id while connected to a server or lobby
};

inline Json build_activity(
        const Status &raw,
        const Settings &settings,
        const std::function<std::string(const std::string &)> &hash,
        int64_t now
) {
    static const char *kinds[] = {"menu", "playing", "paused", "replay"};
    std::string kind = "menu";
    for (const char *k : kinds)
        if (raw.kind == k) kind = k;
    const bool named = settings.show_map && !settings.privacy;
    const auto map = named ? clean(raw.map, 64) : std::string();
    const auto details = kind == "menu"      ? std::string("In the menu")
                         : kind == "playing" ? (map.empty() ? "Bunnyhopping" : "Hopping on " + map)
                         : kind == "paused"  ? (map.empty() ? "Run paused" : "Paused on " + map)
                                             : (map.empty() ? "Watching a replay" : "Watching " + map);
    const std::string mode = raw.mode == "multiplayer" ? "Multiplayer"
                             : raw.mode == "practice"  ? "Practice"
                             : raw.mode == "replay"    ? "Replay"
                                                       : "Solo";
    const auto style = !settings.privacy && kind != "menu" ? clean(raw.style, 40) : std::string();
    const auto state = kind == "menu" ? std::string("Bunnyhop") : mode + (style.empty() ? "" : " · " + style);
    const int64_t start = raw.started_at >= 946684800 && raw.started_at <= now + 60 ? raw.started_at : now;
    Json activity = {
            {"type", 0},
            {"details", details},
            {"state", state},
            {"assets", {{"large_image", logo_url}, {"large_text", "Bunnyhop"}}},
            {"timestamps", {{"start", start}}},
            {"instance", false}
    };
    const bool lobby = lobby_id(raw.room);
    const bool joinable = kind != "menu" && kind != "replay" && settings.join && !settings.privacy
                          && (lobby ? settings.join_lobbies : server_id(raw.room));
    if (joinable) {
        activity["party"] = {{"id", hash("bunnyhop-room:" + raw.room).substr(0, 32)}};
        activity["secrets"] = {{"join", join_secret(raw.room)}};
    } else
        activity["buttons"] = Json::array({{{"label", "Play Bunnyhop"}, {"url", "https://bunnyhop.lol"}}});
    return activity;
}

// The same activity without Join, Play button back. Used once Discord has
// refused a Join secret, so presence carries on regardless.
inline Json without_join(Json activity) {
    if (!activity.contains("secrets")) return activity;
    activity.erase("party");
    activity.erase("secrets");
    activity["buttons"] = Json::array({{{"label", "Play Bunnyhop"}, {"url", "https://bunnyhop.lol"}}});
    return activity;
}

class Client {
public:
    using Clock = std::chrono::steady_clock;
    // Reported to the menu so the Discord section can say what's happening.
    std::string state = "disabled";  // disabled | connecting | ready | reconnecting
    std::string message;
    std::function<void(const std::string &room)> on_join;

    ~Client() { close(); }

    // Call every frame. |activity| is null to clear; |wanted| false disconnects.
    void update(bool wanted, const Json &activity) {
        const auto now = Clock::now();
        if (!wanted) {
            if (state != "disabled") {
                if (ready_) send_activity(Json(nullptr), true);
                close();
                state = "disabled";
                message.clear();
                retry_ = 0;
                next_try_ = {};
            }
            return;
        }
        pending_ = activity;
        if (!connected()) {
            if (now < next_try_) return;
            if (!open()) {
                lost("Discord isn't running");
                return;
            }
            write(op_handshake, {{"v", 1}, {"client_id", application_id}});
            handshake_at_ = now;
            state = "connecting";
        }
        if (!read()) return;
        if (!ready_ && now - handshake_at_ > std::chrono::seconds(5)) {
            lost("Discord didn't answer");
            return;
        }
        if (ready_ && now - last_sent_ >= std::chrono::seconds(1)) send_activity(pending_, false);
    }

private:
#ifdef _WIN32
    HANDLE pipe_ = INVALID_HANDLE_VALUE;

    bool connected() const { return pipe_ != INVALID_HANDLE_VALUE; }

    bool open() {
        for (int i = 0; i < 10; ++i) {
            const auto name = "\\\\.\\pipe\\discord-ipc-" + std::to_string(i);
            pipe_ = CreateFileA(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
            if (pipe_ != INVALID_HANDLE_VALUE) return true;
        }
        return false;
    }

    void close_socket() {
        if (pipe_ != INVALID_HANDLE_VALUE) CloseHandle(pipe_);
        pipe_ = INVALID_HANDLE_VALUE;
    }

    bool raw_write(const std::string &bytes) {
        DWORD done = 0;
        return WriteFile(pipe_, bytes.data(), DWORD(bytes.size()), &done, nullptr) && done == bytes.size();
    }

    // 1 data, 0 nothing waiting, -1 gone.
    int raw_read(char *buffer, size_t size, size_t &got) {
        DWORD available = 0;
        if (!PeekNamedPipe(pipe_, nullptr, 0, nullptr, &available, nullptr)) return -1;
        if (!available) return 0;
        DWORD n = 0;
        if (!ReadFile(pipe_, buffer, DWORD(std::min<size_t>(size, available)), &n, nullptr)) return -1;
        got = n;
        return 1;
    }

    static long pid() { return long(GetCurrentProcessId()); }
#else
    int fd_ = -1;

    bool connected() const { return fd_ >= 0; }

    bool open() {
        std::vector<std::string> roots;
        for (const char *name : {"XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"})
            if (const char *v = std::getenv(name); v && *v) roots.emplace_back(v);
        roots.push_back("/run/user/" + std::to_string(getuid()));
        roots.emplace_back("/tmp");
        // Flatpak and Snap Discord put the socket one level down.
        const char *subdirs[] = {
                "", "app/com.discordapp.Discord/", "snap.discord/", ".flatpak/com.discordapp.Discord/xdg-run/"
        };
        for (const auto &root : roots)
            for (const char *sub : subdirs)
                for (int i = 0; i < 10; ++i) {
                    const auto path = root + "/" + sub + "discord-ipc-" + std::to_string(i);
                    sockaddr_un addr{};
                    addr.sun_family = AF_UNIX;
                    if (path.size() >= sizeof(addr.sun_path)) continue;
                    std::memcpy(addr.sun_path, path.c_str(), path.size() + 1);
#ifdef SOCK_CLOEXEC
                    const int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
                    if (fd < 0) return false;
#else
                    // macOS has no SOCK_CLOEXEC; set close-on-exec right after creating it.
                    const int fd = socket(AF_UNIX, SOCK_STREAM, 0);
                    if (fd < 0) return false;
                    fcntl(fd, F_SETFD, fcntl(fd, F_GETFD) | FD_CLOEXEC);
#endif
                    if (connect(fd, reinterpret_cast<sockaddr *>(&addr), sizeof addr) == 0) {
                        fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
#ifdef SO_NOSIGPIPE
                        int one = 1;
                        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);
#endif
                        fd_ = fd;
                        return true;
                    }
                    ::close(fd);
                }
        return false;
    }

    void close_socket() {
        if (fd_ >= 0) ::close(fd_);
        fd_ = -1;
    }

    bool raw_write(const std::string &bytes) {
#ifdef MSG_NOSIGNAL
        constexpr int flags = MSG_NOSIGNAL;
#else
        constexpr int flags = 0;
#endif
        size_t sent = 0;
        // Frames are small and the socket is local, so a short write only
        // happens if Discord has stopped reading; treat that as gone.
        for (int spins = 0; sent < bytes.size() && spins < 100; ++spins) {
            const auto n = ::send(fd_, bytes.data() + sent, bytes.size() - sent, flags);
            if (n > 0)
                sent += size_t(n);
            else if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)
                return false;
        }
        return sent == bytes.size();
    }

    int raw_read(char *buffer, size_t size, size_t &got) {
        const auto n = ::recv(fd_, buffer, size, 0);
        if (n > 0) {
            got = size_t(n);
            return 1;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) return 0;
        return -1;
    }

    static long pid() { return long(getpid()); }
#endif

    std::string inbox_;
    bool ready_ = false, join_rejected_ = false;
    Json pending_, last_activity_ = Json("unsent");
    Clock::time_point handshake_at_{}, last_sent_{}, next_try_{};
    int retry_ = 0;

    static std::string nonce() {
        static std::mt19937_64 rng{std::random_device{}()};
        char out[33];
        std::snprintf(out, sizeof out, "%016llx%016llx", (unsigned long long)rng(), (unsigned long long)rng());
        return out;
    }

    void write(uint32_t op, const Json &payload) {
        if (connected() && !raw_write(encode_frame(op, payload))) lost("Lost Discord");
    }

    void close() {
        close_socket();
        inbox_.clear();
        ready_ = false;
        join_rejected_ = false;
        last_activity_ = Json("unsent");
    }

    void lost(const std::string &why) {
        close();
        static constexpr int delays[] = {2, 5, 10, 30, 60};
        next_try_ = Clock::now() + std::chrono::seconds(delays[std::min(retry_, 4)]);
        ++retry_;
        state = "reconnecting";
        message = why;
    }

    void send_activity(const Json &activity, bool force) {
        const auto sent = join_rejected_ && activity.is_object() ? without_join(activity) : activity;
        if (!force && sent == last_activity_) return;
        last_activity_ = sent;
        last_sent_ = Clock::now();
        write(op_frame, {{"cmd", "SET_ACTIVITY"}, {"args", {{"pid", pid()}, {"activity", sent}}}, {"nonce", nonce()}});
    }

    // False once the connection has been dropped.
    bool read() {
        char buffer[8192];
        for (int i = 0; i < 16 && connected(); ++i) {
            size_t got = 0;
            const int r = raw_read(buffer, sizeof buffer, got);
            if (r < 0) {
                lost("Discord closed the connection");
                return false;
            }
            if (!r) break;
            inbox_.append(buffer, got);
            if (inbox_.size() > 4 * max_frame) {
                lost("Discord sent too much");
                return false;
            }
        }
        // Parsing valid JSON is only the first protocol boundary: malformed
        // field types and errors while handling a frame must also stay inside
        // Discord, never unwind through the game's update loop.
        try {
            for (const auto &frame : decode_frames(inbox_))
                if (!handle(frame)) return false;
        } catch (const std::exception &e) {
            lost(e.what());
            return false;
        }
        return connected();
    }

    bool handle(const Frame &frame) {
        const auto &p = frame.payload;
        if (frame.op == op_ping) {
            write(op_pong, p);
            return connected();
        }
        const auto string_field = [](const Json &object, const char *key, const std::string &fallback) {
            if (!object.is_object()) throw std::runtime_error("Invalid Discord RPC object");
            const auto field = object.find(key);
            if (field == object.end()) return fallback;
            if (!field->is_string()) throw std::runtime_error(std::string("Invalid Discord RPC ") + key);
            return field->get<std::string>();
        };
        if (frame.op == op_close) {
            lost(clean(string_field(p, "message", "Discord closed RPC"), 160));
            return false;
        }
        if (frame.op != op_frame) return true;
        if (!p.is_object() || !p.contains("cmd") || !p["cmd"].is_string())
            throw std::runtime_error("Invalid Discord RPC cmd");
        // Successful command replies legitimately carry evt:null.
        const auto evt = !p.contains("evt") || p["evt"].is_null() ? "" : string_field(p, "evt", "");
        const auto cmd = p["cmd"].get<std::string>();
        const auto error_text = [&](const char *fallback) {
            return p.contains("data") && !p["data"].is_null() ? clean(string_field(p["data"], "message", fallback), 160)
                                                              : std::string(fallback);
        };
        if (evt == "READY") {
            ready_ = true;
            retry_ = 0;
            state = "ready";
            message.clear();
            write(op_frame,
                  {{"cmd", "SUBSCRIBE"}, {"evt", "ACTIVITY_JOIN"}, {"args", Json::object()}, {"nonce", nonce()}});
            send_activity(pending_, true);
        } else if (evt == "ERROR" && cmd == "SUBSCRIBE") {
            message = "Join unavailable: " + error_text("Discord refused ACTIVITY_JOIN");  // presence still works
        } else if (evt == "ERROR" && cmd == "SET_ACTIVITY" && pending_.is_object() && pending_.contains("secrets")
                   && !join_rejected_) {
            join_rejected_ = true;
            message = "Join unavailable: " + error_text("Discord refused the Join secret");
            send_activity(pending_, true);
        } else if (evt == "ERROR") {
            message = error_text("Discord rejected the activity");
        } else if (evt == "ACTIVITY_JOIN" && cmd == "DISPATCH" && p.contains("data") && p["data"].is_object()
                   && p["data"].value("secret", Json()).is_string()) {
            if (const auto room = join_target(p["data"]["secret"].get<std::string>()); room && on_join) on_join(*room);
        }
        return connected();
    }
};
}  // namespace native::discord
