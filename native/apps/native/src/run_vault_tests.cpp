#include "run_vault.hpp"
#include <iostream>
#include <cassert>
#include <thread>

static void test_millisecond_pbs(const std::filesystem::path &root) {
    using J = nlohmann::json;
    native::RunVault vault(root);
    auto raw =
            J{{"map", "map"},
              {"style", "autohop"},
              {"track", 0},
              {"time", 12.34549},
              {"jumps", 2},
              {"strafes", 3},
              {"sync", 90},
              {"finishedAt", 1},
              {"eligible", true}};
    assert(vault.archive("legacy.bhr", raw).at("timeMs") == 12345);
    raw["time"] = 12.3446;
    assert(vault.archive("tie.bhr", raw).at("localPb") == false);
    raw["timeMs"] = 12344;
    raw["timingPolicy"] = 1;
    const auto faster = vault.archive("faster.bhr", raw);
    assert(faster.at("localPb") == true && faster.at("time") == 12.344);
    assert(faster.at("timingPolicy") == 1);
    assert(!faster.contains("view"));
    raw["view"] = {{"aspect", 1.333}, {"screen", 1.778}, {"fit", "stretch"}, {"fov", 90}};
    const auto viewed = native::RunVault::sanitize(raw);
    assert(native::read_runner_view(viewed.at("view"))->stretched());
    raw["view"] = {{"aspect", 1.333}, {"screen", 1.778}, {"fit", "zoom"}, {"fov", 90}};
    assert(!native::RunVault::sanitize(raw).contains("view"));
    raw.erase("view");
    raw["timeMs"] = 12344.5;
    assert(native::RunVault::sanitize(raw).is_null());
    raw.erase("timeMs");
    raw["time"] = 12.3455;
    assert(native::RunVault::sanitize(raw).at("timeMs") == 12346);
    // A pre-v29 PB index remains authoritative after summaries were pruned.
    const auto old_root = root / "old-index";
    std::filesystem::create_directories(old_root);
    std::ofstream(old_root / "pbs.json") << J{{J::array({"map", "autohop", 0}).dump(), 12.34549}};
    native::RunVault migrated(old_root);
    raw["time"] = 12.3446;
    assert(migrated.archive("tie.bhr", raw).at("localPb") == false);
    raw["time"] = 12.344;
    assert(migrated.archive("better.bhr", raw).at("localPb") == true);
}

int main() {
    namespace fs = std::filesystem;
    using J = nlohmann::json;
    const auto root =
            fs::temp_directory_path()
            / ("bunnyhop-vault-test-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));

    struct Cleanup {
        fs::path p;

        ~Cleanup() {
            std::error_code e;
            fs::remove_all(p, e);
        }
    } cleanup{root};

    test_millisecond_pbs(root / "ms");
    native::RunVault v(root, 2, 1, 128, 128);
    auto raw =
            J{{"map", "bh_aztec"},
              {"style", "autohop"},
              {"track", 0},
              {"time", 12.3},
              {"jumps", 42},
              {"strafes", 70},
              {"sync", 96.5},
              {"finishedAt", 12345},
              {"client", "native/test"},
              {"eligible", true}};
    for (const auto &id : {"../x.bhr", "C:x.bhr", "foo/bar.bhr", ".bhr", "x..bhr", "hello.png"})
        assert(!native::RunVault::valid_id(id));
    assert(native::RunVault::valid_id("bh_aztec-1234.bhr"));
    auto first = v.archive("bh_aztec-1.bhr", raw);
    assert(first["localPb"] == true && first["verified"] == false);
    std::string png("\x89PNG\r\n\x1a\n", 8);
    png.append(32, 'x');
    v.attach("bh_aztec-1.bhr", png);
    assert(v.screenshot("bh_aztec-1.bhr"));
    auto second = v.archive("bh_aztec-2.bhr", raw);
    assert(second["localPb"] == false);
    v.attach("bh_aztec-2.bhr", png);
    assert(!v.screenshot("bh_aztec-1.bhr") && v.screenshot("bh_aztec-2.bhr"));
    raw["time"] = 14;
    v.archive("bh_aztec-3.bhr", raw);
    assert(v.read("bh_aztec-1.bhr").is_null());
    raw["time"] = 13;
    assert(v.archive("bh_aztec-4.bhr", raw)["localPb"] == false);  // best survived summary pruning
    raw["time"] = 11;
    assert(v.archive("bh_aztec-5.bhr", raw)["localPb"] == true);
    raw["track"] = 1;
    assert(v.archive("bh_aztec-6.bhr", raw)["localPb"] == true);
    raw["eligible"] = false;
    raw["time"] = 1;
    assert(v.archive("bh_aztec-7.bhr", raw)["localPb"] == false);
    bool denied = false;
    try {
        v.attach("bh_aztec-7.bhr", std::string(129, 'x'));
    } catch (...) {
        denied = true;
    }
    assert(denied);
    raw["time"] = -1;
    assert(native::RunVault::sanitize(raw).is_null());
    raw["time"] = 1;
    raw["sync"] = 101;
    assert(native::RunVault::sanitize(raw).is_null());
    raw["sync"] = 95;
    raw["verified"] = true;
    assert(native::RunVault::sanitize(raw)["verified"] == false);
    {
        std::ofstream out(root / "runs" / "bad.bhr.json");
        out << "{broken";
    }
    assert(v.read("bad.bhr").is_null());
    v.trash("bh_aztec-7.bhr");
    assert(v.read("bh_aztec-7.bhr").is_null() && fs::exists(root / "trash" / "bh_aztec-7.bhr.json"));
    assert(native::RunVault::file_uri(root / "capture #1.png").find("capture%20%231.png") != std::string::npos);
#ifndef _WIN32
    fs::remove_all(root / "captures");
    fs::create_directory(root / "outside");
    fs::create_directory_symlink(root / "outside", root / "captures");
    assert(!v.screenshot("bh_aztec-6.bhr"));
    denied = false;
    try {
        v.attach("bh_aztec-6.bhr", png);
    } catch (...) {
        denied = true;
    }
    assert(denied && fs::is_empty(root / "outside"));
#endif
    std::cout << "Native vault: bounded summaries, device PB index, screenshot limits, corrupt files, safe paths/trash "
                 "passed\n";
}
