#pragma once
// The second half of "Restart to update". The game writes a plan, starts its own program again as
// `--finish-update PLAN` and quits. This helper waits for the game to close, checks the staged package again,
// swaps it in, starts the new version and watches it briefly: if the new version exits with an error straight
// away, the old install is put back and started instead. The outcome goes to a small result file the next game
// start reads.
#include "update_install.hpp"
#include "update_process.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace native::update_helper {
namespace fs = std::filesystem;
using Json = nlohmann::json;

inline constexpr const char *finish_flag = "--finish-update";
inline constexpr auto game_exit_timeout = std::chrono::seconds(60);
// A new version that fails at startup (a missing library, a bad resource) exits well within this.
inline constexpr auto launch_watch = std::chrono::seconds(20);
inline constexpr int64_t result_settle_seconds = 120;

struct Plan {
    uint64_t game_process = 0;
    update_install::Layout layout;
    fs::path staged_folder;
    std::string version, build, previous_version;
    std::vector<fs::path> data_folders;
    std::vector<std::string> relaunch_arguments;
    fs::path result;
};

inline Json to_json(const Plan &plan) {
    using data_location::utf8;
    Json data_folders = Json::array();
    for (const auto &folder : plan.data_folders)
        data_folders.push_back(utf8(folder));
    return {{"schema", 1},
            {"gameProcess", plan.game_process},
            {"platform", plan.layout.platform},
            {"root", utf8(plan.layout.root)},
            {"staging", utf8(plan.layout.staging)},
            {"relaunch", utf8(plan.layout.relaunch)},
            {"stagedFolder", utf8(plan.staged_folder)},
            {"version", plan.version},
            {"build", plan.build},
            {"previousVersion", plan.previous_version},
            {"dataFolders", data_folders},
            {"relaunchArguments", plan.relaunch_arguments},
            {"result", utf8(plan.result)}};
}

inline fs::path absolute_path(const Json &json, const char *key) {
    auto path = data_location::from_utf8(json.at(key).get<std::string>());
    if (!path.is_absolute()) throw std::runtime_error(std::string("Update plan path is not absolute: ") + key);
    return path;
}

inline Plan plan_from_json(const Json &json) {
    if (json.at("schema") != 1) throw std::runtime_error("Unknown update plan");
    Plan plan;
    plan.game_process = json.at("gameProcess").get<uint64_t>();
    plan.layout = {
            json.at("platform").get<std::string>(),
            absolute_path(json, "root"),
            absolute_path(json, "staging"),
            absolute_path(json, "relaunch")
    };
    plan.staged_folder = absolute_path(json, "stagedFolder");
    if (!data_location::within(plan.staged_folder, plan.layout.staging))
        throw std::runtime_error("Staged update is outside the staging folder");
    plan.version = json.at("version").get<std::string>();
    plan.build = json.at("build").get<std::string>();
    plan.previous_version = json.at("previousVersion").get<std::string>();
    for (const auto &folder : json.at("dataFolders"))
        plan.data_folders.push_back(data_location::from_utf8(folder.get<std::string>()));
    plan.relaunch_arguments = json.at("relaunchArguments").get<std::vector<std::string>>();
    plan.result = absolute_path(json, "result");
    return plan;
}

inline void write_json(const fs::path &path, const Json &json) {
    std::error_code ec;
    fs::create_directories(path.parent_path(), ec);
    auto temporary = path;
    temporary += ".tmp";
    {
        std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
        if (!(out << json.dump(2))) throw std::runtime_error("Cannot write " + data_location::utf8(path));
    }
    fs::rename(temporary, path);
}

inline Json read_json(const fs::path &path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("Cannot read " + data_location::utf8(path));
    return Json::parse(in);
}

inline int64_t unix_seconds() {
    return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch())
            .count();
}

inline void report(const Plan &plan, const std::string &status, const std::string &message) {
    std::cerr << "Update: " << status << (message.empty() ? "" : ": " + message) << '\n';
    try {
        write_json(
                plan.result,
                {{"status", status},
                 {"version", plan.version},
                 {"previousVersion", plan.previous_version},
                 {"message", message},
                 {"at", unix_seconds()}}
        );
    } catch (const std::exception &e) {
        std::cerr << "Update: " << e.what() << '\n';
    }
}

inline void start_game(const fs::path &program, const std::vector<std::string> &arguments) noexcept {
    try {
        update_process::Child::start(program, arguments, update_process::Window::own_console);
    } catch (const std::exception &e) {
        std::cerr << "Update: " << e.what() << '\n';
    }
}

// Starts the new version and reports whether it got past startup.
inline bool new_version_started(const Plan &plan, std::string &problem) {
    update_process::Child game;
    try {
        game = update_process::Child::start(
                plan.layout.relaunch, plan.relaunch_arguments, update_process::Window::own_console
        );
    } catch (const std::exception &e) {
        problem = e.what();
        return false;
    }
    const auto code = game.wait_for(launch_watch);
    if (code && *code != 0) {
        problem = "the new version closed at startup (exit code " + std::to_string(*code) + ")";
        return false;
    }
    return true;
}

// Swaps the staged package in. Returns the process exit code; the outcome is in the plan's result file.
inline int finish(const Plan &plan) {
    if (!update_process::wait_for_exit(plan.game_process, game_exit_timeout)) {
        report(plan, "failed", "The game didn't close, so nothing was changed.");
        return 1;
    }
    std::vector<update_install::Replacement> planned;
    try {
        const auto package = update_install::locate_package(plan.staged_folder, plan.layout.platform);
        update_install::verify_package(package, plan.layout.platform, plan.build, plan.version);
        planned = update_install::replacements(plan.layout, package);
        if (const auto overlap = update_install::data_overlap(planned, plan.data_folders); !overlap.empty())
            throw std::runtime_error(overlap);
    } catch (const std::exception &e) {
        report(plan, "failed", std::string(e.what()) + ". Nothing was changed.");
        start_game(plan.layout.relaunch, plan.relaunch_arguments);
        return 1;
    }
    update_install::Swap swap;
    try {
        swap.apply(planned);
    } catch (const std::exception &e) {
        report(plan, "failed", std::string(e.what()) + ". The previous version was restored.");
        start_game(plan.layout.relaunch, plan.relaunch_arguments);
        return 1;
    }
    report(plan, "installed", {});
    std::string problem;
    if (!new_version_started(plan, problem)) {
        swap.undo();
        report(plan, "failed", "The update was undone: " + problem + ".");
        start_game(plan.layout.relaunch, plan.relaunch_arguments);
        return 1;
    }
    swap.remove_backups(planned);
    std::error_code ec;
    fs::remove_all(plan.layout.staging, ec);
    return 0;
}

// The plan from `--finish-update PLAN`, or nothing when the program wasn't started as the helper. Windows hands
// main() its arguments in the ANSI code page, so the path comes from the wide command line there.
inline std::optional<fs::path> plan_argument(int argc, char **argv) {
    if (argc != 3 || std::string(argv[1]) != finish_flag) return std::nullopt;
#ifdef _WIN32
    int count = 0;
    LPWSTR *wide = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!wide) return std::nullopt;
    std::optional<fs::path> plan;
    if (count == 3) plan = fs::path(wide[2]);
    LocalFree(wide);
    return plan;
#else
    return data_location::from_utf8(argv[2]);
#endif
}

// main() calls this before anything else when the program was started as the helper.
inline int run(const fs::path &plan_path) {
    Plan plan;
    try {
        plan = plan_from_json(read_json(plan_path));
    } catch (const std::exception &e) {
        std::cerr << "Update: " << e.what() << '\n';
        return 1;
    }
    std::error_code ec;
    fs::remove(plan_path, ec);
    return finish(plan);
}

// What the last update did, once, for the game to show. Old results also clear leftovers from the swap.
struct Outcome {
    std::string status, version, previous_version, message;
};

inline std::optional<Outcome> take_outcome(const fs::path &result, const std::string &running_version) {
    Json json;
    try {
        json = read_json(result);
    } catch (...) {
        return std::nullopt;
    }
    Outcome outcome{
            json.value("status", ""),
            json.value("version", ""),
            json.value("previousVersion", ""),
            json.value("message", "")
    };
    const bool announced = json.value("announced", false);
    const bool settled = unix_seconds() - json.value("at", int64_t(0)) > result_settle_seconds;
    std::error_code ec;
    if (settled) {
        fs::remove(result, ec);
    } else if (!announced) {
        json["announced"] = true;
        try {
            write_json(result, json);
        } catch (...) {
        }
    }
    if (announced) return std::nullopt;
    // An "installed" result written before a failed launch is overwritten; trust it only from the new version.
    if (outcome.status == "installed" && outcome.version != running_version) return std::nullopt;
    return outcome;
}

inline bool settled(const fs::path &result) {
    std::error_code ec;
    if (!fs::exists(result, ec)) return true;
    try {
        return unix_seconds() - read_json(result).value("at", int64_t(0)) > result_settle_seconds;
    } catch (...) {
        return true;
    }
}
}  // namespace native::update_helper
