#pragma once
// Installing a verified update in place. The game unpacks the signed package into a staging folder on the same
// volume as the install, checks the unpacked files against the package's own identity, and on "Restart to update"
// hands a plan to a helper (update_helper.hpp) that swaps the files once the game has closed.
//
// The swap renames each installed entry to "<name>.update-old", moves the new entry into place, and undoes every
// step if any rename fails. Only entries the package itself provides are replaced; the game data folder is refused
// outright if it overlaps one of them.
#include "bunnyhop_native.h"
#include "data_location.hpp"
#include "update_process.hpp"
#include "../packaging/assets_identity.hpp"
#include "../packaging/executable_identity.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <optional>
#include <regex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace native::update_install {
namespace fs = std::filesystem;
using Json = nlohmann::json;

inline constexpr const char *backup_suffix = ".update-old";
inline constexpr const char *staging_name = ".bunnyhop-update";
inline constexpr int rename_attempts = 20;
// Antivirus scanners briefly hold freshly written files open on Windows.
inline constexpr auto rename_retry_delay = std::chrono::milliseconds(150);
inline constexpr auto extract_timeout = std::chrono::minutes(5);

struct Layout {
    std::string platform;  // "darwin/arm64", "win32/x64" or "linux/x64"
    fs::path root;         // the .app bundle on macOS, otherwise the folder holding the game
    fs::path staging;      // packages unpack here, on the same volume as `root`
    fs::path relaunch;     // what to start once the update is in place
};

struct Detection {
    std::optional<Layout> layout;
    std::string reason;  // why this copy can't update itself, when `layout` is empty
};

inline std::string os_of(const std::string &platform) {
    return platform.substr(0, platform.find('/'));
}

inline bool writable_folder(const fs::path &folder) {
    const auto probe = folder / ".bunnyhop-write-test";
    std::error_code ec;
    {
        std::ofstream out(probe, std::ios::binary);
        if (!(out << "ok")) return false;
    }
    fs::remove(probe, ec);
    return true;
}

inline Detection detect_macos(const fs::path &executable) {
    const auto contents = executable.parent_path().parent_path();
    const auto bundle = contents.parent_path();
    if (executable.parent_path().filename() != "MacOS" || contents.filename() != "Contents"
        || bundle.extension() != ".app")
        return {std::nullopt, "This copy isn't inside an app bundle."};
    if (std::ranges::find(bundle, fs::path("AppTranslocation")) != bundle.end())
        return {std::nullopt,
                "macOS is running the game from a temporary copy. Move the app to another folder, open it from "
                "there, then update."};
    return {Layout{{}, bundle, bundle.parent_path() / staging_name, executable}, {}};
}

inline Detection detect_windows(const fs::path &executable) {
    const auto root = executable.parent_path();
    if (!fs::is_directory(root / "resources")) return {std::nullopt, "This copy isn't a packaged install."};
    return {Layout{{}, root, root / staging_name, root / "bunnyhop-native.exe"}, {}};
}

inline Detection detect_linux(const fs::path &executable, bool appimage) {
    if (appimage) return {std::nullopt, "AppImage copies update by replacing the AppImage file."};
    const auto root = executable.parent_path().parent_path();
    if (executable.parent_path().filename() != "bin" || !fs::is_directory(root / "share" / "bunnyhop-native"))
        return {std::nullopt, "This copy isn't a packaged install."};
    return {Layout{{}, root, root / staging_name, root / "bunnyhop-native"}, {}};
}

// Only a released package can replace itself: a development build has no package layout or identity to check.
inline Detection detect(const fs::path &executable, const std::string &platform, bool released, bool appimage) {
    if (!released) return {std::nullopt, "Development builds don't update themselves."};
    const auto os = os_of(platform);
    Detection found = os == "darwin"  ? detect_macos(executable)
                      : os == "win32" ? detect_windows(executable)
                                      : detect_linux(executable, appimage);
    if (!found.layout) return found;
    found.layout->platform = platform;
    if (!writable_folder(found.layout->staging.parent_path()))
        return {std::nullopt,
                "The game's folder is read-only for your account. Download the update and install it yourself."};
    return found;
}

// --- The unpacked package ------------------------------------------------------------------------------------

struct StagedPackage {
    fs::path folder;      // the staging folder the archive was unpacked into
    fs::path executable;  // the new game binary
    fs::path resources;   // holds menu.html, native-assets and native-manifest.json
};

inline std::vector<fs::path> top_level_entries(const fs::path &folder) {
    std::vector<fs::path> entries;
    for (const auto &entry : fs::directory_iterator(folder))
        entries.push_back(entry.path());
    std::sort(entries.begin(), entries.end());
    return entries;
}

inline StagedPackage locate_package(const fs::path &folder, const std::string &platform) {
    const auto os = os_of(platform);
    if (os == "darwin") {
        const auto entries = top_level_entries(folder);
        if (entries.size() != 1 || entries.front().extension() != ".app")
            throw std::runtime_error("The update package doesn't hold exactly one app");
        const auto app = entries.front();
        return {folder, app / "Contents" / "MacOS" / "bunnyhop-native", app / "Contents" / "Resources"};
    }
    if (os == "win32") return {folder, folder / "bunnyhop-native.exe", folder / "resources"};
    return {folder, folder / "bin" / "bunnyhop-native", folder / "share" / "bunnyhop-native"};
}

// A package never needs links that leave it; refuse any, whatever the archive tool allowed.
inline void reject_escaping_links(const fs::path &folder) {
    const auto root = data_location::normal(folder);
    for (auto it = fs::recursive_directory_iterator(folder); it != fs::recursive_directory_iterator(); ++it) {
        if (!it->is_symlink()) continue;
        it.disable_recursion_pending();
        const auto target = fs::read_symlink(it->path());
        if (target.is_absolute() || !data_location::within(it->path().parent_path() / target, root))
            throw std::runtime_error("The update package links outside itself");
    }
}

inline std::string sha256_hex(const std::vector<uint8_t> &bytes) {
    char digest[65]{};
    if (!bh_sha256(bytes.empty() ? nullptr : bytes.data(), bytes.size(), digest))
        throw std::runtime_error("Cannot hash the update");
    return digest;
}

inline std::vector<uint8_t> read_file(const fs::path &path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) throw std::runtime_error("Cannot read " + data_location::utf8(path.filename()));
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}

// package.ts packageIdentity: the build id hashes the platform, the three file hashes and the verifier hash.
inline std::string package_build_id(
        const std::string &platform,
        const std::string &binary_sha256,
        const std::string &menu_sha256,
        const std::string &assets_sha256,
        const std::string &wasm_sha256
) {
    const auto slash = platform.find('/');
    std::string payload = "package-v1";
    for (const auto &part :
         {platform.substr(0, slash),
          platform.substr(slash + 1),
          binary_sha256,
          menu_sha256,
          assets_sha256,
          wasm_sha256}) {
        payload += '\0';
        payload += part;
    }
    const std::vector<uint8_t> bytes(payload.begin(), payload.end());
    return "bunnyhop-native/" + sha256_hex(bytes).substr(0, 24);
}

// Checks the unpacked files are the build the signed release names, by recomputing its identity from the files.
inline void verify_package(
        const StagedPackage &package, const std::string &platform, const std::string &build, const std::string &version
) {
    const auto manifest = Json::parse(read_file(package.resources / "native-manifest.json"));
    static const std::regex hash_pattern("^[a-f0-9]{64}$");
    if (manifest.value("build", "") != build || manifest.value("version", "") != version
        || manifest.value("platform", "") != platform)
        throw std::runtime_error("The unpacked update isn't the release that was signed");
    const auto wasm = manifest.value("canonicalWasmSha256", "");
    if (!std::regex_match(wasm, hash_pattern)) throw std::runtime_error("The unpacked update has no verifier hash");
    const auto mode = os_of(platform) == "darwin" ? "macho-code-v1" : "sha256";
    const auto binary = sha256_hex(executable_identity_bytes(read_file(package.executable), mode));
    const auto menu = sha256_hex(read_file(package.resources / "menu.html"));
    const auto assets = assets_identity_hash(package.resources / "native-assets");
    if (manifest.value("binarySha256", "") != binary || manifest.value("menuSha256", "") != menu
        || manifest.value("assetsSha256", "") != assets)
        throw std::runtime_error("The unpacked update's files don't match its identity");
    if (package_build_id(platform, binary, menu, assets, wasm) != build)
        throw std::runtime_error("The unpacked update's identity doesn't add up");
}

inline fs::path system_tool(const char *name) {
#ifdef _WIN32
    const char *system_root = std::getenv("SystemRoot");
    return fs::path(system_root ? system_root : "C:\\Windows") / "System32" / name;
#else
    for (const char *folder : {"/usr/bin", "/bin"})
        if (fs::exists(fs::path(folder) / name)) return fs::path(folder) / name;
    return fs::path("/usr/bin") / name;
#endif
}

// ditto keeps the app bundle's signature intact on macOS; Windows 10 and later ship bsdtar, which reads zip files.
inline void extract(const fs::path &archive, const fs::path &folder, const std::string &platform) {
    const auto os = os_of(platform);
    const auto archive_path = data_location::utf8(archive);
    const auto folder_path = data_location::utf8(folder);
    int code = 1;
    if (os == "darwin")
        code = update_process::run(system_tool("ditto"), {"-x", "-k", archive_path, folder_path}, extract_timeout);
    else if (os == "win32")
        code = update_process::run(system_tool("tar.exe"), {"-xf", archive_path, "-C", folder_path}, extract_timeout);
    else
        code = update_process::run(
                system_tool("tar"), {"-xzf", archive_path, "-C", folder_path, "--no-same-owner"}, extract_timeout
        );
    if (code != 0) throw std::runtime_error("Unpacking the update failed");
}

inline void verify_code_signature(const StagedPackage &package, const std::string &platform) {
    if (os_of(platform) != "darwin") return;
    const auto app = data_location::utf8(package.executable.parent_path().parent_path().parent_path());
    const auto code =
            update_process::run(system_tool("codesign"), {"--verify", "--deep", "--strict", app}, extract_timeout);
    if (code != 0) throw std::runtime_error("The unpacked app's signature is broken");
}

// Unpacks a verified archive into a fresh staging folder and checks what came out. Returns the staged package.
inline StagedPackage
stage(const fs::path &archive, const Layout &layout, const std::string &build, const std::string &version) {
    std::error_code ec;
    fs::remove_all(layout.staging, ec);
    const auto folder = layout.staging / version;
    fs::create_directories(folder);
    try {
        extract(archive, folder, layout.platform);
        reject_escaping_links(folder);
        const auto package = locate_package(folder, layout.platform);
        verify_package(package, layout.platform, build, version);
        verify_code_signature(package, layout.platform);
        return package;
    } catch (...) {
        fs::remove_all(layout.staging, ec);
        throw;
    }
}

// --- Swapping ------------------------------------------------------------------------------------------------

struct Replacement {
    fs::path incoming;  // inside the staging folder
    fs::path target;    // the installed entry it replaces
};

inline fs::path backup_of(const fs::path &target) {
    auto name = target.filename();
    name += backup_suffix;
    return target.parent_path() / name;
}

// macOS swaps the whole bundle (whatever the player renamed it to); Windows and Linux swap each top-level entry
// the package holds, so files the player added next to the game stay where they are.
inline std::vector<Replacement> replacements(const Layout &layout, const StagedPackage &package) {
    std::vector<Replacement> out;
    if (os_of(layout.platform) == "darwin") {
        out.push_back({top_level_entries(package.folder).front(), layout.root});
        return out;
    }
    for (const auto &entry : top_level_entries(package.folder))
        out.push_back({entry, layout.root / entry.filename()});
    return out;
}

// Settings, replays and maps must never be inside anything the swap moves.
inline std::string data_overlap(const std::vector<Replacement> &planned, const std::vector<fs::path> &data_folders) {
    for (const auto &replacement : planned)
        for (const auto &folder : data_folders)
            if (data_location::within(folder, replacement.target) || data_location::within(replacement.target, folder))
                return "Your game data folder is inside the game's install. Move it in Settings → Game data, or "
                       "install the update yourself.";
    return {};
}

using RenameStep = std::function<void(const fs::path &from, const fs::path &to)>;

inline void rename_with_retries(const fs::path &from, const fs::path &to) {
    for (int attempt = 1;; ++attempt) {
        std::error_code ec;
        fs::rename(from, to, ec);
        if (!ec) return;
        if (attempt == rename_attempts)
            throw std::runtime_error("Cannot move " + data_location::utf8(from.filename()) + ": " + ec.message());
        std::this_thread::sleep_for(rename_retry_delay);
    }
}

// Every completed rename, so a failure (now or after a failed launch) can be undone in reverse.
class Swap {
    std::vector<std::pair<fs::path, fs::path>> done_;
    RenameStep rename_;

    void move(const fs::path &from, const fs::path &to) {
        rename_(from, to);
        done_.emplace_back(from, to);
    }

public:
    explicit Swap(RenameStep rename = rename_with_retries) : rename_(std::move(rename)) {}

    // Throws after restoring the previous install if any step fails.
    void apply(const std::vector<Replacement> &planned) {
        try {
            for (const auto &replacement : planned) {
                const auto backup = backup_of(replacement.target);
                std::error_code ec;
                fs::remove_all(backup, ec);
                if (fs::exists(fs::symlink_status(replacement.target))) move(replacement.target, backup);
                move(replacement.incoming, replacement.target);
            }
        } catch (...) {
            undo();
            throw;
        }
    }

    // Puts everything back where it was. Undo renames use the plain retrying rename, not the injected one.
    void undo() noexcept {
        for (auto it = done_.rbegin(); it != done_.rend(); ++it) {
            try {
                rename_with_retries(it->second, it->first);
            } catch (...) {
            }
        }
        done_.clear();
    }

    void remove_backups(const std::vector<Replacement> &planned) const noexcept {
        for (const auto &replacement : planned) {
            std::error_code ec;
            fs::remove_all(backup_of(replacement.target), ec);
        }
    }
};

// Backups the helper couldn't delete (Windows keeps the helper's own program file locked while it runs).
inline void remove_leftovers(const Layout &layout) noexcept {
    std::error_code ec;
    if (os_of(layout.platform) == "darwin") {
        fs::remove_all(backup_of(layout.root), ec);
    } else {
        for (const auto &entry : fs::directory_iterator(layout.root, ec)) {
            const auto name = data_location::utf8(entry.path().filename());
            if (name.ends_with(backup_suffix)) fs::remove_all(entry.path(), ec);
        }
    }
    fs::remove_all(layout.staging, ec);
}
}  // namespace native::update_install
