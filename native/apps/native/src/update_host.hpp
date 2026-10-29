#pragma once
// Settings → Updates on the game side. Owns the update service, answers the menu's "update" messages, sends the
// menu the update state when it changes, and starts the update helper once the game has closed.
#include "native_update.hpp"
#include "startup.hpp"
#include "update_config.hpp"
#include "update_helper.hpp"
#include "update_install.hpp"
#include "update_process.hpp"
#include "update_schedule.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace native::updates {
inline constexpr const char *local_build = "bunnyhop-native/local";

// The release keys and manifest URL built into this copy. Test builds may point at a local trust file instead.
inline Json trust_config() {
#ifdef BUNNYHOP_UPDATE_TEST_HOOKS
    if (const char *file = std::getenv("BUNNYHOP_UPDATE_TEST_TRUST"); file && *file) {
        std::ifstream in(data_location::from_utf8(file), std::ios::binary);
        return Json::parse(in);
    }
#endif
    return Json::parse(update_config_json);
}

inline InstallTarget install_target(
        const Json &identity, const std::filesystem::path &executable, std::vector<std::filesystem::path> data_folders
) {
    const bool released = identity.value("build", std::string(local_build)) != local_build;
    const char *appimage = std::getenv("APPIMAGE");
    return {update_install::detect(executable, platform(), released, appimage && *appimage), std::move(data_folders)};
}

inline std::filesystem::path write_plan(const update_helper::Plan &plan) {
    const auto path = plan.result.parent_path() / "restart-plan.json";
    update_helper::write_json(path, update_helper::to_json(plan));
    return path;
}

// Called from main() after the game has shut down. The helper waits for this process to end.
inline bool start_helper(const std::filesystem::path &executable, const std::filesystem::path &plan) {
    try {
        update_process::Child::start(executable, {update_helper::finish_flag, data_location::utf8(plan)});
        return true;
    } catch (const std::exception &e) {
        std::cerr << "Update: " << e.what() << '\n';
        return false;
    }
}

struct MenuReply {
    std::string notice;  // shown as a toast when not empty
    bool quit = false;   // the game should close so the helper can install the update
};

class Host {
    Service service_;
    RestartGate gate_;
    std::optional<update_install::Layout> layout_;
    std::filesystem::path result_file_;
    std::string version_;
    std::string last_state_;
    std::optional<std::filesystem::path> plan_;

    Host(const std::filesystem::path &data_folder, const Json &identity, const InstallTarget &target)
        : service_(
                  trust_config(),
                  data_folder / "updates",
                  identity.value("version", std::string("local")),
                  identity.value("build", std::string(local_build)),
                  target
          )
        , layout_(target.detection.layout)
        , result_file_(data_folder / "updates" / "last-update.json")
        , version_(identity.value("version", std::string("local"))) {}

public:
    Host(const std::filesystem::path &data_folder,
         const std::filesystem::path &default_root,
         const Json &identity,
         const std::filesystem::path &executable)
        : Host(data_folder, identity, install_target(identity, executable, {data_folder, default_root})) {}

    // The outcome of the last update, once, and cleanup of what it left behind once its helper is done.
    std::string startup_notice() {
        const bool helper_done = update_helper::settled(result_file_);
        const auto outcome = update_helper::take_outcome(result_file_, version_);
        if (helper_done && layout_) update_install::remove_leftovers(*layout_);
        if (!outcome) return {};
        if (outcome->status == "installed") return "Updated to " + outcome->version + ".";
        return "The update to " + outcome->version + " didn't install. " + outcome->message;
    }

    void check_if_due() { service_.check_if_due(); }

    void service_status(uint64_t generation, const std::string &status) { gate_.service_status(generation, status); }

    MenuReply handle(const Json &message, const GameActivity &game) {
        const auto action = message.value("action", std::string());
        last_state_.clear();
        if (action == "check")
            service_.check();
        else if (action == "download")
            service_.download();
        else if (action == "cancel")
            service_.cancel();
        else if (action == "reveal")
            service_.reveal();
        else if (action == "automatic")
            service_.set_automatic(message.value("enabled", true));
        else if (action == "restart")
            return restart(game);
        return {};
    }

    // JavaScript that hands the menu the new state, when it changed since the last call.
    std::optional<std::string> state_script() {
        auto state = service_.state().dump();
        if (state == last_state_) return std::nullopt;
        last_state_ = state;
        return "window.dispatchEvent(new CustomEvent('bunnyhop:update',{detail:" + state + "}))";
    }

    // Set once the player confirmed "Restart to update"; main() starts the helper with it.
    const std::optional<std::filesystem::path> &plan() const { return plan_; }

private:
    MenuReply restart(const GameActivity &game) {
        if (const auto blocker = gate_.blocker(game); !blocker.empty()) return {blocker, false};
        const auto plan = service_.restart_plan(update_process::current_process_id());
        if (!plan) return {};
        try {
            plan_ = write_plan(*plan);
        } catch (const std::exception &e) {
            return {e.what(), false};
        }
        return {{}, true};
    }
};

#ifdef BUNNYHOP_UPDATE_TEST_HOOKS
// `--update-smoke DATA_DIR`: check, download, stage and restart into the new version without a window, so an
// end-to-end test can drive the real program. The relaunched version runs the home menu smoke.
inline Json wait_while(Service &service, std::initializer_list<const char *> statuses) {
    constexpr auto smoke_timeout = std::chrono::minutes(5);
    const auto deadline = std::chrono::steady_clock::now() + smoke_timeout;
    for (;;) {
        auto state = service.state();
        const auto status = state.value("status", std::string());
        bool waiting = false;
        for (const char *busy : statuses)
            waiting = waiting || status == busy;
        if (!waiting || std::chrono::steady_clock::now() > deadline) return state;
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

inline int run_smoke(const std::filesystem::path &data) {
    const auto executable = executable_path();
    const auto identity = load_release_identity(
            resource("native-manifest.json", BUNNYHOP_NATIVE_MANIFEST),
            resource("menu.html", BUNNYHOP_MENU_HTML),
            resource("native-assets", BUNNYHOP_NATIVE_ASSET_ROOT)
    );
    Service service(
            trust_config(),
            data / "updates",
            identity.value("version", std::string("local")),
            identity.value("build", std::string(local_build)),
            install_target(identity, executable, {data})
    );
    service.check();
    auto state = wait_while(service, {"checking"});
    std::cout << "Update smoke: " << state.dump() << '\n';
    if (state.value("status", "") != "available") return 1;
    service.download();
    state = wait_while(service, {"downloading", "staging"});
    std::cout << "Update smoke: " << state.dump() << '\n';
    const auto relaunched = data_location::utf8(data / "relaunched");
    const auto plan =
            service.restart_plan(update_process::current_process_id(), {"--menu-home-smoke", relaunched, "--hidden"});
    if (!plan) return 1;
    return start_helper(executable, write_plan(*plan)) ? 0 : 1;
}
#endif
}  // namespace native::updates
