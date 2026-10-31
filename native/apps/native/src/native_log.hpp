#pragma once
#include <chrono>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

namespace native::log {

inline constexpr std::string_view file_name = "bunnyhop-native.log";

// logs/ in the game's data folder.
std::filesystem::path folder(const std::filesystem::path &data);

// One run of the game. From here on std::cerr also goes to the log, and lines wait in memory until open() names the
// file. A small queue and one writer thread own the disk, so a line never waits on it and neither does the frame loop.
// Logging can't throw, and a log file that won't open costs the log and nothing else.
class Session {
public:
    Session();
    ~Session();
    Session(const Session &) = delete;
    Session &operator=(const Session &) = delete;
};

// Starts the file: the last two sessions move aside, and `header` opens this one and every file a long session rolls
// over to. Only the first call does anything.
void open(const std::filesystem::path &data, std::vector<std::string> header = {});

// Any thread. Lines are stamped here and scrubbed on the writer thread.
void write(std::string_view line) noexcept;

// What the crash note quotes. It can't be scrubbed from a signal handler: pass only map ids and stage names.
void set_crash_context(std::string_view text) noexcept;

// False when the writer didn't catch up in time.
bool wait_until_written(std::chrono::milliseconds limit) noexcept;

std::string scrub_line(std::string_view line);
std::string os_description();

// For crash_note.cpp: both are safe in a signal handler. Text goes straight to the open file, unscrubbed.
void write_raw(const char *text, size_t size) noexcept;
size_t read_crash_context(char *out, size_t capacity) noexcept;
// Writes YYYY-MM-DDTHH:MM:SS.mmmZ, which is timestamp_bytes long, without allocating.
inline constexpr size_t timestamp_bytes = 24;
void format_timestamp(std::chrono::system_clock::time_point when, char *out) noexcept;

}  // namespace native::log
