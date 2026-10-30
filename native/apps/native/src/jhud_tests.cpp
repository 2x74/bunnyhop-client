// Differential test: the same tick stream through the web JHUD and through the C++ port, report for report, band for
// band, line for line. src/jhud_oracle.ts produces the stream and the expected output.
#include "hud_readouts.hpp"
#include "jhud.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <nlohmann/json.hpp>
#include <atomic>
#include <cassert>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <new>
#include <string>

namespace {

std::atomic<size_t> allocations = 0;

int failures = 0;
long compared = 0;

void fail(const std::string &where, const std::string &what) {
    if (++failures <= 20) std::cerr << "MISMATCH " << where << ": " << what << '\n';
}

// The printed line as the website writes it: the HUD draws the arrow itself, the text is the same.
std::string full_bottom(const native::JhudLines &lines) {
    const std::string text(lines.bottom.view());
    if (lines.arrow == native::JhudArrow::too_fast) return "\xE2\x96\xBC " + text;
    if (lines.arrow == native::JhudArrow::too_slow) return text + " \xE2\x96\xB2";
    return text;
}

std::optional<float> optional_float(const nlohmann::json &value) {
    return value.is_null() ? std::nullopt : std::optional<float>(value.get<float>());
}

native::JhudReport report_from(const nlohmann::json &value) {
    native::JhudReport report;
    report.jump = value.at("jump").get<unsigned>();
    report.speed = value.at("speed").get<int>();
    report.gain = optional_float(value.at("gain"));
    report.sync = optional_float(value.at("sync"));
    if (!value.at("jss").is_null()) report.jss = value.at("jss").get<double>();
    return report;
}

native::JhudBand band_from(const nlohmann::json &names, const std::string &name) {
    for (size_t band = 0; band < names.size(); ++band)
        if (names[band] == name) return native::JhudBand(band);
    throw std::runtime_error("Unknown band " + name);
}

// What a report shows is a pure function of its numbers, so this reads the oracle's own numbers, exact to the bit.
void check_shown(const nlohmann::json &oracle, const nlohmann::json &expected, const std::string &where) {
    const auto report = report_from(expected);
    const auto &colors = oracle.at("speedColors");
    for (size_t i = 0; i < colors.size(); ++i) {
        const auto want = band_from(oracle.at("bandNames"), expected.at("bands")[i].get<std::string>());
        if (native::jhud_band(report, colors[i].get<unsigned>()) != want)
            fail(where, "band for speed colours " + colors[i].dump());
    }
    const auto &prefs = oracle.at("linePrefs");
    for (size_t i = 0; i < prefs.size(); ++i) {
        native::JhudPrefs choice;
        choice.sync = prefs[i].at("sync").get<bool>();
        choice.jss = prefs[i].at("jss").get<bool>();
        choice.analyzer = prefs[i].at("analyzer").get<bool>();
        const auto lines = native::jhud_lines(report, choice);
        const auto &want = expected.at("lines")[i];
        if (lines.top.view() != want[0].get<std::string>())
            fail(where, "top line \"" + std::string(lines.top.view()) + "\", expected " + want[0].dump());
        const std::string bottom = want[1].is_null() ? std::string() : want[1].get<std::string>();
        if (full_bottom(lines) != bottom)
            fail(where, "bottom line \"" + full_bottom(lines) + "\", expected \"" + bottom + "\"");
    }
}

void compare_numbers(const native::JhudReport &actual, const nlohmann::json &expected, const std::string &where) {
    if (actual.jump != expected.at("jump").get<unsigned>()) fail(where, "jump " + std::to_string(actual.jump));
    if (actual.speed != expected.at("speed").get<int>()) fail(where, "speed " + std::to_string(actual.speed));
    const auto same_presence = [&](const char *field, bool present) {
        if (present == expected.at(field).is_null()) fail(where, std::string(field) + " presence");
        return present && !expected.at(field).is_null();
    };
    // Sync takes no trigonometry. Gain does, through cos and sin, whose last bit isn't portable: at most that reaches
    // the second decimal. JSS is double arithmetic over atan and hypot.
    if (same_presence("sync", actual.sync.has_value()) && *actual.sync != expected.at("sync").get<float>())
        fail(where, "sync " + std::to_string(*actual.sync) + ", expected " + expected.at("sync").dump());
    constexpr double gain_tolerance = .0101, jss_tolerance = 1e-9;
    if (same_presence("gain", actual.gain.has_value())
        && std::abs(double(*actual.gain) - expected.at("gain").get<double>()) > gain_tolerance)
        fail(where, "gain " + std::to_string(*actual.gain) + ", expected " + expected.at("gain").dump());
    if (same_presence("jss", actual.jss.has_value())
        && std::abs(*actual.jss - expected.at("jss").get<double>()) > jss_tolerance)
        fail(where, "jss " + std::to_string(*actual.jss) + ", expected " + expected.at("jss").dump());
}

void replay_case(const nlohmann::json &oracle, const nlohmann::json &item) {
    const auto name = item.at("name").get<std::string>();
    native::JhudTracker tracker;
    const auto &ticks = item.at("ticks");
    const auto &reports = item.at("reports");
    assert(ticks.size() == reports.size());
    for (size_t i = 0; i < ticks.size(); ++i) {
        const auto &t = ticks[i];
        const float position[3]{t.at("px").get<float>(), t.at("py").get<float>(), t.at("pz").get<float>()};
        const float velocity[3]{t.at("vx").get<float>(), t.at("vy").get<float>(), t.at("vz").get<float>()};
        native::SsjState pre;
        pre.position = position;
        pre.velocity = velocity;
        pre.grounded = t.at("grounded").get<bool>();
        pre.on_ladder = t.at("onLadder").get<bool>();
        native::SsjCmd cmd;
        cmd.forward = t.at("forward").get<float>();
        cmd.side = t.at("side").get<float>();
        cmd.yaw = t.at("yaw").get<float>();
        cmd.buttons = t.at("buttons").get<std::uint32_t>();
        native::SsjTick info;
        info.jumped = t.at("jumped").get<bool>();
        // The stream's teleports reach the tracker, which ignores them: the web tracker is never told.
        info.teleported = t.at("teleported").get<bool>();
        info.in_start = t.at("inStart").get<bool>();
        info.noclip = t.at("noclip").get<bool>();
        const auto actual = tracker.tick(pre, cmd, info);
        const auto &expected = reports[i];
        const std::string where = name + " tick " + std::to_string(i);
        if (expected.is_null() != !actual) {
            fail(where, actual ? "a report where the reference has none" : "no report where the reference has one");
            continue;
        }
        if (!actual) continue;
        ++compared;
        compare_numbers(*actual, expected, where);
        check_shown(oracle, expected, where);
    }
}

void check_pure_functions(const nlohmann::json &oracle) {
    const auto &names = oracle.at("bandNames");
    for (const auto &item : oracle.at("edgeReports"))
        check_shown(oracle, item, "edge report " + item.at("jump").dump());
    for (const auto &item : oracle.at("gainBands"))
        if (native::jhud_gain_band(item.at("gain").get<double>()) != band_from(names, item.at("band")))
            fail("gain band", item.dump());
    for (const auto &item : oracle.at("speedBands"))
        if (native::jhud_speed_band(item.at("jump").get<unsigned>(), item.at("speed").get<int>())
            != band_from(names, item.at("band")))
            fail("speed band", item.dump());
}

void check_cut_digits() {
    // SourceMod's %.2f cuts: the f32 87.52 prints 87.51, and a cut -0.00 is 0.00.
    native::JhudReport report;
    report.jump = 6;
    report.speed = 613;
    report.gain = 87.52f;
    native::JhudPrefs prefs;
    prefs.sync = false;
    assert(native::jhud_lines(report, prefs).bottom.view() == "87.51%");
    report.gain = -.001f;
    assert(native::jhud_lines(report, prefs).bottom.view() == "0.00%");
    report.gain.reset();
    assert(native::jhud_lines(report, prefs).bottom.empty());
}

void check_readout_hold_and_cutoff() {
    constexpr double tick_interval = .01;
    constexpr uint32_t tick = 500, hold_ticks = 100;
    native::JhudReport report;
    report.jump = 3;
    report.speed = 450;
    native::JhudReadout readout;
    readout.show(report, tick, tick_interval);
    assert(readout.shown() && readout.lines().top.view() == "3: 450");
    readout.expire(tick + hold_ticks - 1);
    assert(readout.shown());
    readout.expire(tick + hold_ticks);
    assert(!readout.shown());

    readout.show(report, tick, tick_interval);
    native::JhudPrefs prefs;
    prefs.cutoff = 3;
    readout.configure(prefs);
    assert(readout.shown());
    prefs.cutoff = 2;
    readout.configure(prefs);
    assert(!readout.shown());

    prefs.cutoff = 0;
    // 450 u/s on jump 3 is the speed table's "good".
    prefs.colors[size_t(native::JhudBand::good)] = native::semantic_rgb(0x123456);
    readout.configure(prefs);
    assert(readout.color() == native::semantic_rgb(0x123456));
    readout.clear();
    assert(!readout.shown());
}

void check_ticks_do_not_allocate() {
    const float position[3] = {0, 0, 0}, velocity[3] = {600, 0, 0};
    native::SsjState pre;
    pre.position = position;
    pre.velocity = velocity;
    native::SsjCmd cmd{0, 400, 0, native::ssj_in_jump};
    native::SsjTick info;
    native::JhudTracker tracker;
    native::JhudReadout readout;
    constexpr double tick_interval = .01;
    const size_t before = allocations;
    for (uint32_t tick = 0; tick < 2000; ++tick) {
        cmd.yaw = float(tick % 360);
        pre.grounded = tick % 50 == 0;
        info.jumped = pre.grounded;
        if (const auto report = tracker.tick(pre, cmd, info)) readout.show(*report, tick, tick_interval);
    }
    assert(allocations == before);
}

}  // namespace

void *operator new(std::size_t bytes) {
    ++allocations;
    if (void *memory = std::malloc(bytes ? bytes : 1)) return memory;
    throw std::bad_alloc();
}

void operator delete(void *memory) noexcept {
    std::free(memory);
}

void operator delete(void *memory, std::size_t) noexcept {
    std::free(memory);
}

int main(int argc, char **argv) {
    const std::string path = argc > 1 ? argv[1] : "jhud-oracle.json";
    std::ifstream file(path);
    if (!file) {
        std::cerr << "Cannot open the JHUD oracle at " << path
                  << "\nGenerate it with: bun apps/native/src/jhud_oracle.ts " << path << '\n';
        return 2;
    }
    nlohmann::json oracle;
    file >> oracle;
    for (const auto &item : oracle.at("cases"))
        replay_case(oracle, item);
    check_pure_functions(oracle);
    // A stream that produced nothing would otherwise pass silently.
    constexpr long least_reports = 400;
    if (compared < least_reports) {
        std::cerr << "Only " << compared << " reports were compared; the oracle looks wrong\n";
        return 1;
    }
    if (failures) {
        std::cerr << failures << " mismatches across " << compared << " reports\n";
        return 1;
    }
    check_cut_digits();
    check_readout_hold_and_cutoff();
    check_ticks_do_not_allocate();
    std::cout << "JHUD port matches the web reference across " << compared << " reports\n";
    return 0;
}
