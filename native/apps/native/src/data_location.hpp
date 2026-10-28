#pragma once
// Where the native client keeps its data (settings, replays, the map/content
// store, custom sound/ and bgm/ folders). The default is SDL's per-user pref
// folder; a player may pick another folder (e.g. a second drive) in Settings ->
// Game data. That choice lives in a small data-location.json kept in the
// default folder, which is the one place the client can always find.
//
// A move is never done while the game has the folder open: it is recorded as
// "pending" and performed at the next start, before anything opens the data
// folder. A failed move rolls back and leaves the old folder in use.
#include <nlohmann/json.hpp>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <system_error>
#include <vector>
#ifndef _WIN32
#include <sys/stat.h>
#endif

namespace native::data_location {
namespace fs = std::filesystem;
inline constexpr const char *pointer_name = "data-location.json";
inline constexpr const char *subfolder_name = "Bunnyhop Data";

inline std::string utf8(const fs::path &p) {
    const auto s = p.u8string();
    return std::string(reinterpret_cast<const char *>(s.data()), s.size());
}

inline fs::path from_utf8(const std::string &s) {
    return fs::path(std::u8string(reinterpret_cast<const char8_t *>(s.data()), s.size()));
}

inline fs::path normal(const fs::path &p) {
    std::error_code ec;
    fs::path a = fs::absolute(p, ec);
    if (ec) a = p;
    const fs::path w = fs::weakly_canonical(a, ec);
    fs::path out = (ec ? a : w).lexically_normal();
    if (out.has_filename() == false && out.has_parent_path() && out != out.root_path())
        out = out.parent_path();  // drop a trailing separator
    return out;
}

inline bool same(const fs::path &a, const fs::path &b) {
    return normal(a) == normal(b);
}

// True when `inner` is `outer` or anywhere below it.
inline bool within(const fs::path &inner, const fs::path &outer) {
    const auto i = normal(inner), o = normal(outer);
    auto it = i.begin();
    for (const auto &part : o) {
        if (it == i.end() || *it != part) return false;
        ++it;
    }
    return true;
}

// file:// URL for opening a folder in the system file manager.
inline std::string file_url(const fs::path &p) {
    std::error_code ec;
    const auto abs = fs::absolute(p, ec);
    const auto u8 = (ec ? p : abs).generic_u8string();
    std::string url = "file://";
#ifdef _WIN32
    url += '/';
#endif
    static const char hex[] = "0123456789ABCDEF";
    for (char8_t ch : u8) {
        const auto c = static_cast<unsigned char>(ch);
        if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '/' || c == ':'
            || c == '-' || c == '_' || c == '.' || c == '~')
            url += char(c);
        else {
            url += '%';
            url += hex[c >> 4];
            url += hex[c & 15];
        }
    }
    return url;
}

struct Location {
    fs::path active;
    std::optional<fs::path> pending;
};

inline Location read(const fs::path &default_root) {
    Location out{default_root, std::nullopt};
    std::ifstream in(default_root / pointer_name);
    if (!in) return out;
    try {
        nlohmann::json j;
        in >> j;
        if (!j.is_object()) return out;
        if (const auto it = j.find("path"); it != j.end() && it->is_string()) {
            const auto p = from_utf8(it->get<std::string>());
            if (p.is_absolute()) out.active = p;
        }
        if (const auto it = j.find("pending"); it != j.end() && it->is_string()) {
            const auto p = from_utf8(it->get<std::string>());
            if (p.is_absolute() && !same(p, out.active)) out.pending = p;
        }
    } catch (...) {
        return Location{default_root, std::nullopt};
    }
    return out;
}

// Writes atomically; the default folder with nothing pending needs no file.
inline void write(const fs::path &default_root, const Location &l) {
    nlohmann::json j = nlohmann::json::object();
    if (!same(l.active, default_root)) j["path"] = utf8(normal(l.active));
    if (l.pending) j["pending"] = utf8(normal(*l.pending));
    std::error_code ec;
    const auto file = default_root / pointer_name;
    if (j.empty()) {
        fs::remove(file, ec);
        return;
    }
    fs::create_directories(default_root, ec);
    const auto tmp = default_root / (std::string(pointer_name) + ".tmp");
    {
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        if (!out) throw std::runtime_error("Cannot save the data folder choice");
        out << j.dump(2);
        if (!out) throw std::runtime_error("Cannot save the data folder choice");
    }
    fs::rename(tmp, file, ec);
    if (ec) {
        fs::remove(file, ec);
        fs::rename(tmp, file);
    }
}

// Top-level entries a move carries over (everything but the pointer file).
inline std::vector<fs::path> entries(const fs::path &root, const fs::path &default_root) {
    std::vector<fs::path> out;
    std::error_code ec;
    if (!fs::is_directory(root, ec)) return out;
    const bool is_default = same(root, default_root);
    for (const auto &e : fs::directory_iterator(root, ec)) {
        const auto name = e.path().filename();
        if (is_default && (name == pointer_name || name == std::string(pointer_name) + ".tmp")) continue;
        out.push_back(e.path());
    }
    return out;
}

inline std::uintmax_t size_of(const fs::path &p) {
    std::error_code ec;
    if (fs::is_symlink(fs::symlink_status(p, ec))) return 0;
    if (fs::is_regular_file(p, ec)) {
        const auto n = fs::file_size(p, ec);
        return ec ? 0 : n;
    }
    std::uintmax_t total = 0;
    if (!fs::is_directory(p, ec)) return 0;
    for (auto it = fs::recursive_directory_iterator(p, fs::directory_options::skip_permission_denied, ec);
         !ec && it != fs::recursive_directory_iterator();
         it.increment(ec)) {
        if (it->is_symlink(ec)) {
            it.disable_recursion_pending();
            continue;
        }
        if (it->is_regular_file(ec)) {
            const auto n = it->file_size(ec);
            if (!ec) total += n;
            ec.clear();
        }
    }
    return total;
}

inline std::uintmax_t total_size(const fs::path &root, const fs::path &default_root) {
    std::uintmax_t n = 0;
    for (const auto &e : entries(root, default_root))
        n += size_of(e);
    return n;
}

inline bool same_volume(const fs::path &a, const fs::path &b) {
#ifdef _WIN32
    return normal(a).root_name() == normal(b).root_name();
#else
    auto existing = [](fs::path p) {
        std::error_code ec;
        p = normal(p);
        while (!p.empty() && !fs::exists(p, ec) && p != p.root_path())
            p = p.parent_path();
        return p;
    };
    struct stat sa{}, sb{};
    if (stat(existing(a).c_str(), &sa) != 0 || stat(existing(b).c_str(), &sb) != 0) return false;
    return sa.st_dev == sb.st_dev;
#endif
}

struct Choice {
    fs::path target;
    std::string problem;
};

// Turns the folder a player picked into the folder data will live in, or says
// why it can't. A non-empty pick gets a "Bunnyhop Data" folder inside it, so the
// game never mixes its files into someone else's.
inline Choice choose(const fs::path &picked, const fs::path &active, const fs::path &default_root) {
    Choice c;
    std::error_code ec;
    if (picked.empty() || !picked.is_absolute()) return {{}, "Pick a full folder path"};
    fs::path target = normal(picked);
    const bool is_default = same(target, default_root);
    auto has_files = [&](const fs::path &p) {
        std::error_code e;
        if (!fs::is_directory(p, e)) return false;
        for (const auto &x : fs::directory_iterator(p, e)) {
            if (is_default && same(p, default_root) && (x.path().filename() == pointer_name)) continue;
            return true;
        }
        return false;
    };
    if (fs::exists(target, ec) && !fs::is_directory(target, ec)) return {{}, "That isn't a folder"};
    if (!is_default && has_files(target)) target /= subfolder_name;
    c.target = target;
    if (same(target, active)) return {target, "That's already your data folder"};
    if (within(target, active)) return {target, "Pick a folder outside your current data folder"};
    if (within(active, target)) return {target, "Pick a folder that doesn't contain your current data folder"};
    if (has_files(target)) return {target, "\"" + utf8(target) + "\" already has files in it. Pick an empty folder"};
    // Writable: probe the folder itself or its nearest existing parent.
    fs::path probe_dir = target;
    while (!probe_dir.empty() && !fs::exists(probe_dir, ec) && probe_dir != probe_dir.root_path())
        probe_dir = probe_dir.parent_path();
    if (!fs::is_directory(probe_dir, ec)) return {target, "That drive or folder isn't available"};
    {
        const auto probe = probe_dir / ".bunnyhop-write-test";
        std::ofstream out(probe, std::ios::binary);
        const bool ok = bool(out << "ok");
        out.close();
        fs::remove(probe, ec);
        if (!ok) return {target, "Can't write to that folder"};
    }
    if (!same_volume(active, target)) {
        const auto need = total_size(active, default_root);
        const auto space = fs::space(probe_dir, ec);
        if (!ec && space.available < need + (64ull << 20)) {
            auto gb = [](std::uintmax_t n) {
                char b[32];
                std::snprintf(b, sizeof b, "%.1f GB", double(n) / 1e9);
                return std::string(b);
            };
            return {target, "Not enough free space there: needs " + gb(need) + ", " + gb(space.available) + " free"};
        }
    }
    return c;
}

struct Progress {
    std::atomic<std::uintmax_t> done{0}, total{0};
};

// Moves every entry of `from` into `to`. Same-volume entries are renamed
// (instant); others are copied, and the originals removed only after every
// copy succeeded. Any failure undoes what was done. Returns an error or "".
inline std::string move(const fs::path &from, const fs::path &to, const fs::path &default_root, Progress &progress) {
    std::error_code ec;
    const auto items = entries(from, default_root);
    std::vector<std::uintmax_t> sizes;
    sizes.reserve(items.size());
    std::uintmax_t total = 0;
    for (const auto &e : items) {
        sizes.push_back(size_of(e));
        total += sizes.back();
    }
    progress.total = total;
    progress.done = 0;
    fs::create_directories(to, ec);
    if (ec) return "Cannot create " + utf8(to) + ": " + ec.message();
    for (const auto &e : items)
        if (fs::exists(to / e.filename(), ec)) return utf8(to) + " already has \"" + utf8(e.filename()) + "\"";

    struct Done {
        fs::path src, dst;
        bool renamed;
    };

    std::vector<Done> done;
    auto rollback = [&] {
        std::error_code e;
        for (auto it = done.rbegin(); it != done.rend(); ++it) {
            if (it->renamed)
                fs::rename(it->dst, it->src, e);
            else
                fs::remove_all(it->dst, e);
        }
    };
    for (size_t i = 0; i < items.size(); ++i) {
        const auto &src = items[i];
        const auto dst = to / src.filename();
        fs::rename(src, dst, ec);
        if (!ec) {
            done.push_back({src, dst, true});
            progress.done += sizes[i];
            continue;
        }
        ec.clear();
        done.push_back({src, dst, false});  // copied: remove dst on rollback
        auto copy_file = [&](const fs::path &s, const fs::path &d) -> bool {
            fs::copy_file(s, d, fs::copy_options::none, ec);
            if (ec) return false;
            const auto n = fs::file_size(s, ec);
            if (!ec) progress.done += n;
            ec.clear();
            return true;
        };
        if (fs::is_symlink(fs::symlink_status(src, ec))) {
            continue;
        }
        if (fs::is_regular_file(src, ec)) {
            if (!copy_file(src, dst)) {
                const auto why = ec.message();
                rollback();
                return "Copying " + utf8(src) + " failed: " + why;
            }
            continue;
        }
        fs::create_directories(dst, ec);
        if (ec) {
            const auto why = ec.message();
            rollback();
            return "Creating " + utf8(dst) + " failed: " + why;
        }
        for (auto it = fs::recursive_directory_iterator(src, ec); !ec && it != fs::recursive_directory_iterator();
             it.increment(ec)) {
            const auto rel = fs::relative(it->path(), src, ec);
            if (ec) break;
            const auto d = dst / rel;
            if (it->is_symlink(ec)) {
                it.disable_recursion_pending();
                continue;
            }
            if (it->is_directory(ec)) {
                fs::create_directories(d, ec);
                if (ec) break;
                continue;
            }
            if (it->is_regular_file(ec) && !copy_file(it->path(), d)) break;
        }
        if (ec) {
            const auto why = ec.message();
            rollback();
            return "Copying " + utf8(src) + " failed: " + why;
        }
    }
    // Every copy succeeded: drop the originals of copied entries.
    for (const auto &d : done)
        if (!d.renamed) fs::remove_all(d.src, ec);
    progress.done = progress.total.load();
    return {};
}
}  // namespace native::data_location
