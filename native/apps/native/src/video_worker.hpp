#pragma once
#include <filesystem>
#include <optional>
#include <string_view>

namespace native::video_worker {

// The export process, `bunnyhop-native --export-video SPEC.json`. It loads the map and replays with its own
// simulation and a hidden OpenGL context, so an export never shares a frame with gameplay. It reports JSON lines on
// stdout ({"event": "start" | "progress" | "done" | "error" | "canceled", "job": n, ...}) and reads "cancel" and
// "pace FPS" lines on stdin; "pace 0" lifts the limit.
//
// The spec: {"assets", "cache", "settings", "outfit", "program"?, "encoders"?, "aac"?, "parent"?, "jobs": [{"replay",
// "map", "bsp"?, "content"?, "detail"?, "output", "options"}]}. Without "bsp" the map comes from the content cache (or
// is downloaded). Without "encoders" the process probes FFmpeg itself. With "parent" it stops when stdin closes.
inline constexpr std::string_view flag = "--export-video";

std::optional<std::filesystem::path> argument(int argc, char **argv);
int run(const std::filesystem::path &spec);

}  // namespace native::video_worker
