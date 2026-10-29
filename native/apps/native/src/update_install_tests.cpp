// Installing updates in place: layout detection, staged package checks, the swap and its rollback, the helper's
// plan and result files, and the game data folder never being touched. Runs in temporary folders only.
#include "update_helper.hpp"
#include "update_install.hpp"
#include "update_schedule.hpp"
#include <cassert>
#include <fstream>
#include <iostream>
#include <random>
#include <thread>

namespace {
namespace fs = std::filesystem;
using namespace native;
using update_install::Layout;
using update_install::Replacement;

const std::string linux_platform = "linux/x64";

struct TempFolder {
    fs::path path;

    TempFolder() {
        std::random_device random;
        path = fs::temp_directory_path() / ("bunnyhop-update-test-" + std::to_string(random()));
        fs::create_directories(path);
    }

    ~TempFolder() {
        std::error_code ec;
        fs::remove_all(path, ec);
    }
};

void write(const fs::path &path, const std::string &text) {
    fs::create_directories(path.parent_path());
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out << text;
}

// The helper starts the old version again after a refused or undone update; let it start before the folder goes.
void let_relaunch_start() {
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
}

std::string read(const fs::path &path) {
    std::ifstream in(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()};
}

template <class Action>
bool throws(Action action) {
    try {
        action();
    } catch (const std::exception &) {
        return true;
    }
    return false;
}

std::string sha256_text(const std::string &text) {
    return update_install::sha256_hex(std::vector<uint8_t>(text.begin(), text.end()));
}

// A Linux-shaped package whose native-manifest.json matches its files, like package.ts writes.
struct FakePackage {
    std::string version;
    std::string build;
};

FakePackage make_package(const fs::path &folder, const std::string &version, const std::string &launcher_exit) {
    const std::string binary = "binary " + version;
    const std::string menu = "<html>" + version + "</html>";
    write(folder / "bin" / "bunnyhop-native", binary);
    write(folder / "share" / "bunnyhop-native" / "menu.html", menu);
    write(folder / "share" / "bunnyhop-native" / "native-assets" / "hud.txt", "assets " + version);
    write(folder / "lib" / "libSDL3.so.0", "sdl " + version);
    write(folder / "bunnyhop-native", "#!/bin/sh\nexit " + launcher_exit + "\n");
    fs::permissions(folder / "bunnyhop-native", fs::perms::owner_all);
    const auto binary_hash = sha256_text(binary);
    const auto menu_hash = sha256_text(menu);
    const auto assets_hash = assets_identity_hash(folder / "share" / "bunnyhop-native" / "native-assets");
    const std::string wasm(64, 'd');
    const auto build = update_install::package_build_id(linux_platform, binary_hash, menu_hash, assets_hash, wasm);
    const nlohmann::json manifest = {
            {"build", build},
            {"version", version},
            {"platform", linux_platform},
            {"canonicalWasmSha256", wasm},
            {"binarySha256", binary_hash},
            {"menuSha256", menu_hash},
            {"assetsSha256", assets_hash}
    };
    write(folder / "share" / "bunnyhop-native" / "native-manifest.json", manifest.dump());
    return {version, build};
}

Layout linux_layout(const fs::path &root) {
    return {linux_platform, root, root / update_install::staging_name, root / "bunnyhop-native"};
}

void build_id_matches_package_ts() {
    // Same inputs through package.ts packageIdentity.
    const auto build = update_install::package_build_id(
            linux_platform, std::string(64, 'a'), std::string(64, 'b'), std::string(64, 'c'), std::string(64, 'd')
    );
    assert(build == "bunnyhop-native/e8a99e0af4656013d3bb63f1");
}

void detects_install_layouts() {
    TempFolder temp;
    const auto app = temp.path / "Games" / "My Bunnyhop.app";
    fs::create_directories(app / "Contents" / "MacOS");
    const auto mac =
            update_install::detect(app / "Contents" / "MacOS" / "bunnyhop-native", "darwin/arm64", true, false);
    assert(mac.layout && mac.layout->root == app);
    assert(mac.layout->staging == temp.path / "Games" / update_install::staging_name);
    const auto translocated = temp.path / "AppTranslocation" / "X" / "d" / "b.app" / "Contents" / "MacOS";
    fs::create_directories(translocated);
    assert(!update_install::detect(translocated / "bunnyhop-native", "darwin/arm64", true, false).layout);
    assert(!update_install::detect(temp.path / "bunnyhop-native", "darwin/arm64", true, false).layout);

    const auto windows = temp.path / "Bunnyhop Native";
    fs::create_directories(windows / "resources");
    const auto win = update_install::detect(windows / "bunnyhop-native.exe", "win32/x64", true, false);
    assert(win.layout && win.layout->root == windows && win.layout->relaunch == windows / "bunnyhop-native.exe");

    const auto linux_root = temp.path / "bunnyhop";
    fs::create_directories(linux_root / "bin");
    fs::create_directories(linux_root / "share" / "bunnyhop-native");
    const auto linux_found =
            update_install::detect(linux_root / "bin" / "bunnyhop-native", linux_platform, true, false);
    assert(linux_found.layout && linux_found.layout->relaunch == linux_root / "bunnyhop-native");
    assert(!update_install::detect(linux_root / "bin" / "bunnyhop-native", linux_platform, true, true).layout);
    // A development build has no package identity to replace.
    const auto local = update_install::detect(linux_root / "bin" / "bunnyhop-native", linux_platform, false, false);
    assert(!local.layout && !local.reason.empty());
}

void verifies_staged_packages() {
    TempFolder temp;
    const auto package = make_package(temp.path, "0.6.3", "0");
    const auto staged = update_install::locate_package(temp.path, linux_platform);
    update_install::verify_package(staged, linux_platform, package.build, "0.6.3");
    assert(throws([&] { update_install::verify_package(staged, linux_platform, package.build, "0.6.4"); }));
    assert(throws([&] { update_install::verify_package(staged, "win32/x64", package.build, "0.6.3"); }));
    const auto other_build = "bunnyhop-native/" + std::string(24, '0');
    assert(throws([&] { update_install::verify_package(staged, linux_platform, other_build, "0.6.3"); }));
    write(staged.resources / "native-assets" / "extra.txt", "stale");
    assert(throws([&] { update_install::verify_package(staged, linux_platform, package.build, "0.6.3"); }));
    fs::remove(staged.resources / "native-assets" / "extra.txt");
    write(staged.resources / "menu.html", "tampered");
    assert(throws([&] { update_install::verify_package(staged, linux_platform, package.build, "0.6.3"); }));
}

// The archive tools the client calls: tar for Linux packages, ditto for macOS bundles.
void extracts_packages() {
#ifndef _WIN32
    TempFolder temp;
    const auto source = temp.path / "source";
    write(source / "bin" / "bunnyhop-native", "binary");
    const auto archive = data_location::utf8(temp.path / "package.tar.gz");
    const auto tar = update_install::system_tool("tar");
    const auto timeout = std::chrono::seconds(30);
    assert(update_process::run(tar, {"-czf", archive, "-C", data_location::utf8(source), "."}, timeout) == 0);
    fs::create_directories(temp.path / "linux");
    update_install::extract(archive, temp.path / "linux", linux_platform);
    assert(read(temp.path / "linux" / "bin" / "bunnyhop-native") == "binary");
    assert(throws([&] { update_install::extract(temp.path / "missing.tar.gz", temp.path / "linux", linux_platform); }));
#endif
#ifdef __APPLE__
    const auto app = temp.path / "zip" / "Game.app";
    write(app / "Contents" / "MacOS" / "bunnyhop-native", "binary");
    const auto zip = data_location::utf8(temp.path / "game.zip");
    const auto ditto = update_install::system_tool("ditto");
    assert(update_process::run(ditto, {"-c", "-k", "--keepParent", data_location::utf8(app), zip}, timeout) == 0);
    fs::create_directories(temp.path / "mac");
    update_install::extract(zip, temp.path / "mac", "darwin/arm64");
    const auto staged = update_install::locate_package(temp.path / "mac", "darwin/arm64");
    assert(read(staged.executable) == "binary");
#endif
}

void rejects_links_out_of_the_package() {
#ifndef _WIN32
    TempFolder temp;
    write(temp.path / "inside.txt", "ok");
    fs::create_symlink("inside.txt", temp.path / "fine");
    update_install::reject_escaping_links(temp.path);
    fs::create_symlink("../../etc", temp.path / "escape");
    assert(throws([&] { update_install::reject_escaping_links(temp.path); }));
#endif
}

struct Install {
    TempFolder temp;
    fs::path root, data, staged;
    Layout layout;
    FakePackage incoming;
    std::string data_before;

    Install() {
        root = temp.path / "game";
        make_package(root, "0.6.2", "0");
        write(root / "player notes.txt", "keep me");
        // A data folder the player chose inside the game folder, beside the entries a package holds.
        data = root / "Bunnyhop Data";
        write(data / "settings.json", "{\"sensitivity\":2}");
        write(data / "replays" / "run.bhr", "replay");
        data_before = read(data / "settings.json") + read(data / "replays" / "run.bhr");
        layout = linux_layout(root);
        staged = layout.staging / "0.6.3";
        incoming = make_package(staged, "0.6.3", "0");
    }

    std::vector<Replacement> planned() const {
        return update_install::replacements(layout, update_install::locate_package(staged, linux_platform));
    }

    std::string installed_version() const {
        return nlohmann::json::parse(read(root / "share" / "bunnyhop-native" / "native-manifest.json"))
                .at("version")
                .get<std::string>();
    }

    bool data_untouched() const {
        return read(data / "settings.json") + read(data / "replays" / "run.bhr") == data_before;
    }
};

void swaps_and_undoes() {
    Install install;
    const auto planned = install.planned();
    assert(update_install::data_overlap(planned, {install.data}).empty());
    update_install::Swap swap;
    swap.apply(planned);
    assert(install.installed_version() == "0.6.3");
    assert(read(install.root / "player notes.txt") == "keep me");
    assert(fs::exists(install.root / "share.update-old"));
    assert(install.data_untouched());
    swap.undo();
    assert(install.installed_version() == "0.6.2");
    assert(!fs::exists(install.root / "share.update-old"));
    assert(fs::exists(install.staged / "share"));
    swap.apply(planned);
    swap.remove_backups(planned);
    assert(!fs::exists(install.root / "share.update-old") && install.installed_version() == "0.6.3");
    assert(install.data_untouched());
}

void rolls_back_a_failed_swap() {
    Install install;
    int renames = 0;
    update_install::Swap swap([&](const fs::path &from, const fs::path &to) {
        if (++renames == 5) throw std::runtime_error("disk unplugged");
        fs::rename(from, to);
    });
    assert(throws([&] { swap.apply(install.planned()); }));
    assert(install.installed_version() == "0.6.2");
    assert(read(install.root / "bin" / "bunnyhop-native") == "binary 0.6.2");
    for (const auto &entry : fs::directory_iterator(install.root))
        assert(!entry.path().filename().string().ends_with(update_install::backup_suffix));
    assert(fs::exists(install.staged / "bin") && fs::exists(install.staged / "share"));
    assert(install.data_untouched());
}

void refuses_data_inside_replaced_entries() {
    Install install;
    const auto planned = install.planned();
    assert(!update_install::data_overlap(planned, {install.root / "share" / "bunnyhop-native" / "data"}).empty());
    assert(!update_install::data_overlap(planned, {install.root / "lib"}).empty());
    // A data folder holding the game is refused too: the swap would move part of it.
    assert(!update_install::data_overlap(planned, {install.temp.path}).empty());
    Layout mac{"darwin/arm64", install.temp.path / "Renamed.app", install.temp.path / ".bunnyhop-update", {}};
    const std::vector<Replacement> bundle{{install.temp.path / ".bunnyhop-update" / "1" / "x.app", mac.root}};
    assert(!update_install::data_overlap(bundle, {mac.root / "Contents" / "Data"}).empty());
    assert(update_install::data_overlap(bundle, {install.temp.path / "Bunnyhop Data"}).empty());
}

update_helper::Plan plan_for(const Install &install) {
    update_helper::Plan plan;
    plan.game_process = 0;  // not the helper's parent: counts as already closed
    plan.layout = install.layout;
    plan.staged_folder = install.staged;
    plan.version = install.incoming.version;
    plan.build = install.incoming.build;
    plan.previous_version = "0.6.2";
    plan.data_folders = {install.data};
    plan.result = install.data / "updates" / "last-update.json";
    return plan;
}

void plan_round_trips() {
    Install install;
    const auto plan = plan_for(install);
    const auto copy = update_helper::plan_from_json(update_helper::to_json(plan));
    assert(copy.staged_folder == plan.staged_folder && copy.layout.root == plan.layout.root);
    assert(copy.version == "0.6.3" && copy.data_folders == plan.data_folders);
    auto outside = update_helper::to_json(plan);
    outside["stagedFolder"] = data_location::utf8(install.temp.path / "elsewhere");
    assert(throws([&] { update_helper::plan_from_json(outside); }));
}

void helper_installs_and_relaunches() {
#ifndef _WIN32
    Install install;
    const auto plan = plan_for(install);
    assert(update_helper::finish(plan) == 0);
    assert(install.installed_version() == "0.6.3");
    assert(!fs::exists(install.root / "share.update-old") && !fs::exists(install.layout.staging));
    assert(install.data_untouched());
    const auto outcome = update_helper::take_outcome(plan.result, "0.6.3");
    assert(outcome && outcome->status == "installed");
    assert(!update_helper::take_outcome(plan.result, "0.6.3"));
#endif
}

void helper_undoes_a_version_that_fails_to_start() {
#ifndef _WIN32
    Install install;
    fs::remove_all(install.staged);
    install.incoming = make_package(install.staged, "0.6.3", "3");
    const auto plan = plan_for(install);
    assert(update_helper::finish(plan) == 1);
    assert(install.installed_version() == "0.6.2");
    assert(install.data_untouched());
    const auto outcome = update_helper::take_outcome(plan.result, "0.6.2");
    assert(outcome && outcome->status == "failed" && outcome->message.find("exit code 3") != std::string::npos);
    let_relaunch_start();
#endif
}

void helper_refuses_a_changed_staged_package() {
#ifndef _WIN32
    Install install;
    write(install.staged / "share" / "bunnyhop-native" / "menu.html", "swapped after staging");
    const auto plan = plan_for(install);
    assert(update_helper::finish(plan) == 1);
    assert(install.installed_version() == "0.6.2");
    assert(update_helper::take_outcome(plan.result, "0.6.2")->status == "failed");
    let_relaunch_start();
#endif
}

void outcomes_show_once() {
    TempFolder temp;
    const auto file = temp.path / "last-update.json";
    update_helper::write_json(
            file, {{"status", "installed"}, {"version", "0.6.3"}, {"at", update_helper::unix_seconds()}}
    );
    assert(!update_helper::settled(file));
    assert(!update_helper::take_outcome(file, "0.6.2"));  // the old version restarted after a rollback race
    update_helper::write_json(
            file, {{"status", "installed"}, {"version", "0.6.3"}, {"at", update_helper::unix_seconds()}}
    );
    assert(update_helper::take_outcome(file, "0.6.3"));
    assert(!update_helper::take_outcome(file, "0.6.3"));
    update_helper::write_json(file, {{"status", "failed"}, {"version", "0.6.3"}, {"at", int64_t(1)}});
    assert(update_helper::settled(file));
    assert(update_helper::take_outcome(file, "0.6.2")->status == "failed");
    assert(!fs::exists(file));
}

void leftovers_are_removed() {
    TempFolder temp;
    const auto layout = linux_layout(temp.path);
    write(temp.path / "bunnyhop-native.exe.update-old", "old");
    write(temp.path / "resources.update-old" / "menu.html", "old");
    write(layout.staging / "0.6.3" / "x", "staged");
    write(temp.path / "Bunnyhop Data" / "settings.json", "{}");
    update_install::remove_leftovers(layout);
    assert(!fs::exists(temp.path / "bunnyhop-native.exe.update-old"));
    assert(!fs::exists(temp.path / "resources.update-old") && !fs::exists(layout.staging));
    assert(fs::exists(temp.path / "Bunnyhop Data" / "settings.json"));
}

void restart_waits_for_runs_and_uploads() {
    constexpr uint32_t idle = 0, running = 1, finished = 2;
    updates::RestartGate gate;
    assert(gate.blocker({idle, false, 1}).empty());
    assert(!gate.blocker({running, false, 1}).empty());
    assert(gate.blocker({running, true, 1}).empty());  // standing in the start zone
    gate.service_status(1, "beat");
    assert(!gate.blocker({finished, false, 1}).empty());  // finished, upload not started yet
    gate.service_status(1, "uploading");
    assert(!gate.blocker({finished, false, 1}).empty());
    gate.service_status(2, "reset");
    assert(!gate.blocker({idle, true, 2}).empty());  // restarted while the last run still uploads
    gate.service_status(1, "verified");
    assert(gate.blocker({idle, true, 2}).empty());
    assert(gate.blocker({finished, false, 1}).empty());
    assert(!gate.blocker({idle, true, 2, true}).empty());  // a video export would be cut short
}

void automatic_checks_run_daily() {
    updates::CheckSchedule schedule;
    const int64_t now = 2'000'000'000;
    assert(schedule.due(now));
    schedule.last_check = now - 60;
    assert(!schedule.due(now));
    assert(schedule.due(now + updates::automatic_check_interval_seconds));
    assert(schedule.due(now - 3600));
    schedule.automatic = false;
    assert(!schedule.due(now + updates::automatic_check_interval_seconds));
    TempFolder temp;
    schedule.save(temp.path / "schedule.json");
    const auto loaded = updates::CheckSchedule::load(temp.path / "schedule.json");
    assert(!loaded.automatic && loaded.last_check == now - 60);
}
}  // namespace

int main() {
    build_id_matches_package_ts();
    detects_install_layouts();
    verifies_staged_packages();
    extracts_packages();
    rejects_links_out_of_the_package();
    swaps_and_undoes();
    rolls_back_a_failed_swap();
    refuses_data_inside_replaced_entries();
    plan_round_trips();
    helper_installs_and_relaunches();
    helper_undoes_a_version_that_fails_to_start();
    helper_refuses_a_changed_staged_package();
    outcomes_show_once();
    leftovers_are_removed();
    restart_waits_for_runs_and_uploads();
    automatic_checks_run_daily();
    std::cout << "update install checks passed\n";
}
