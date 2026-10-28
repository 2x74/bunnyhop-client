#pragma once
#include <SDL3/SDL.h>
#include "atomic_replace.hpp"
#include <limits>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <system_error>

namespace native {

// Text files the menu asks for through the system file dialogs (SDL3).
// Purposes: "settings" (a .json backup or a saved bhs1. code) and "css" (a
// stylesheet the host then watches). The host reads and writes the files; the
// menu only gets their text and name and never supplies a path.

constexpr std::uintmax_t file_dialog_max_bytes = 1024 * 1024;

inline bool file_dialog_purpose(const std::string &purpose) {
    return purpose == "settings" || purpose == "css";
}

inline std::string utf8_path(const std::filesystem::path &path) {
    const auto text = path.u8string();
    return std::string(text.begin(), text.end());
}

inline std::filesystem::path path_from_utf8(const std::string &text) {
    return std::filesystem::path(std::u8string(text.begin(), text.end()));
}

inline std::string file_display_name(const std::filesystem::path &path) {
    return utf8_path(path.filename());
}

inline bool starts_with_utf8_bom(const std::string &text) {
    return text.size() >= 3 && static_cast<unsigned char>(text[0]) == 0xEF
           && static_cast<unsigned char>(text[1]) == 0xBB && static_cast<unsigned char>(text[2]) == 0xBF;
}

// The whole file as text. Throws a sentence for the player.
inline std::string read_dialog_file(const std::filesystem::path &path, std::uintmax_t limit = file_dialog_max_bytes) {
    std::error_code ec;
    if (!std::filesystem::is_regular_file(path, ec)) throw std::runtime_error("That isn't a file.");
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("The file couldn't be opened.");
    if (limit >= static_cast<std::uintmax_t>(std::numeric_limits<std::streamsize>::max()))
        throw std::runtime_error("Invalid file read limit.");
    std::string text(static_cast<size_t>(limit) + 1, '\0');
    in.read(text.data(), static_cast<std::streamsize>(text.size()));
    const auto count = in.gcount();
    if (in.bad() || (in.fail() && !in.eof())) throw std::runtime_error("The file couldn't be read.");
    if (static_cast<std::uintmax_t>(count) > limit) throw std::runtime_error("The file is too large.");
    text.resize(static_cast<size_t>(count));
    if (starts_with_utf8_bom(text)) text.erase(0, 3);
    if (text.find('\0') != std::string::npos) throw std::runtime_error("That isn't a text file.");
    return text;
}

// Written beside the target and renamed over it, so a failed write never
// leaves half a file.
inline void write_dialog_file(const std::filesystem::path &path, const std::string &text) {
    if (text.size() > file_dialog_max_bytes) throw std::runtime_error("Too much to save.");
    atomic_write_file(path, text);
}

struct FileDialogResult {
    std::string id;
    std::string purpose;
    std::string action;
    bool ok = false;
    bool cancelled = false;
    std::filesystem::path path;
    std::string error;
    std::string text;
};

// One file dialog at a time. SDL answers on its own schedule, possibly on
// another thread, so the answer lands in process-lifetime shared state.
class FileDialogs {
public:
    using Launcher = void (*)(SDL_DialogFileCallback, void *);

    explicit FileDialogs(Launcher launcher = nullptr) : launcher_(launcher) {}

    bool busy() const {
        auto &shared = state();
        std::lock_guard lock(shared.mutex);
        return shared.open;
    }

    // action "open" or "save"; `start` is a folder, or for save a suggested file.
    bool
    show(SDL_Window *window,
         const std::string &action,
         const std::string &purpose,
         const std::string &id,
         const std::filesystem::path &start,
         std::string text = {}) {
        if (!file_dialog_purpose(purpose) || (action != "open" && action != "save")) return false;
        auto &shared = state();
        {
            std::lock_guard lock(shared.mutex);
            if (shared.open || shared.done) return false;
            shared.open = true;
            shared.asked = FileDialogResult{id, purpose, action, false, false, {}, {}, {}};
            shared.asked.text = std::move(text);
        }
        if (launcher_) {
            launcher_(&answered, nullptr);
            return true;
        }
        const auto location = utf8_path(start);
        const char *from = location.empty() ? nullptr : location.c_str();
        const auto *filter = purpose == "css" ? &css_filter : &settings_filter;
        if (action == "open")
            SDL_ShowOpenFileDialog(&answered, nullptr, window, filter, 1, from, false);
        else
            SDL_ShowSaveFileDialog(&answered, nullptr, window, filter, 1, from);
        return true;
    }

    std::optional<FileDialogResult> take() {
        auto &shared = state();
        std::lock_guard lock(shared.mutex);
        auto done = std::move(shared.done);
        shared.done.reset();
        return done;
    }

private:
    Launcher launcher_;

    struct State {
        std::mutex mutex;
        bool open = false;
        FileDialogResult asked;
        std::optional<FileDialogResult> done;
    };

    static State &state() {
        static State shared;
        return shared;
    }

    // SDL keeps the filter pointers until the dialog answers.
    static inline const SDL_DialogFileFilter settings_filter{"Settings (JSON or settings code)", "json;txt"};
    static inline const SDL_DialogFileFilter css_filter{"CSS stylesheet", "css"};

    // Called from C: nothing may throw out of it.
    static void answered(void *, const char *const *files, int) {
        auto &shared = state();
        std::lock_guard lock(shared.mutex);
        auto result = std::move(shared.asked);
        try {
            if (!files)
                result.error = SDL_GetError();
            else if (!files[0])
                result.cancelled = true;
            else {
                result.path = path_from_utf8(files[0]);
                result.ok = true;
            }
        } catch (...) {
            result.ok = false;
            result.error = "The chosen path can't be used.";
        }
        shared.open = false;
        shared.done = std::move(result);
    }
};

// A chosen .css file, read again each time it is saved, as the desktop app does.
class CssFileWatch {
public:
    static constexpr auto kCheckInterval = std::chrono::seconds(1);

    struct Change {
        std::string name;
        std::string text;
        std::string error;
    };

    const std::optional<std::filesystem::path> &path() const { return path_; }

    void watch(std::optional<std::filesystem::path> path) {
        path_ = std::move(path);
        sent_ = false;
        missing_ = false;
        next_check_ = {};
    }

    // The file's text when it changed (or was never sent), checked at most once
    // per kCheckInterval unless forced; an error when it went missing.
    std::optional<Change> poll(bool force = false) {
        if (!path_) return std::nullopt;
        const auto now = std::chrono::steady_clock::now();
        if (!force && now < next_check_) return std::nullopt;
        next_check_ = now + kCheckInterval;

        const auto name = file_display_name(*path_);
        std::error_code ec;
        const auto modified = std::filesystem::last_write_time(*path_, ec);
        const auto size = ec ? 0 : std::filesystem::file_size(*path_, ec);
        if (ec) return missing(name, force);
        if (!force && sent_ && !missing_ && modified == modified_ && size == size_) return std::nullopt;
        modified_ = modified;
        size_ = size;
        sent_ = true;
        missing_ = false;
        try {
            return Change{name, read_dialog_file(*path_), ""};
        } catch (const std::exception &e) {
            return Change{name, "", e.what()};
        }
    }

private:
    std::optional<Change> missing(const std::string &name, bool force) {
        if (missing_ && !force) return std::nullopt;
        missing_ = true;
        sent_ = true;
        return Change{name, "", "The file can't be found. Save it again or choose another."};
    }

    std::optional<std::filesystem::path> path_;
    std::filesystem::file_time_type modified_{};
    std::uintmax_t size_ = 0;
    bool sent_ = false;
    bool missing_ = false;
    std::chrono::steady_clock::time_point next_check_{};
};

}  // namespace native
