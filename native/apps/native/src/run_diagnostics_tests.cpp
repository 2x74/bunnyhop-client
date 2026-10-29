#include "run_session.hpp"
#include "run_history.hpp"
#include "test_bsp.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <memory>
#include <regex>
#include <set>

namespace {
using Json = nlohmann::json;
constexpr uint64_t second_ns = 1'000'000'000;
constexpr uint64_t millisecond_ns = 1'000'000;

// Port of apps/api/src/diagnostics.ts at bunnyhop 59fd424: only the fields emitted by the host. Equality
// after sanitizing catches silent field drops as well as a rejected body, without making network requests.
Json sanitize(const Json &body) {
    const std::set<std::string> self_checks = {"ok", "mismatch", "error"};
    assert(body.at("selfCheck").is_string() && self_checks.contains(body.at("selfCheck")));
    Json result = {{"selfCheck", body.at("selfCheck")}};
    for (const auto &problem : body.at("problems")) {
        assert(problem.is_string() && !problem.get<std::string>().empty());
        if (result["problems"].size() < 3) result["problems"].push_back(problem.get<std::string>().substr(0, 160));
    }
    if (body.at("client").at("kind") == "native") {
        result["client"] = {{"kind", "native"}};
        const auto &client = body.at("client");
        static const std::regex version_pattern(R"(^[\w.+-]{1,32}$)");
        if (client.contains("version") && client.at("version").is_string()
            && std::regex_match(client.at("version").get<std::string>(), version_pattern))
            result["client"]["version"] = client.at("version");
    }
    const double fps = body.at("fps");
    if (std::isfinite(fps)) result["fps"] = std::clamp(std::round(fps * 100) / 100, 0., 1000.);
    const std::set<std::string> numbers = {"pollHz",     "reportHz",    "eventHz",    "fps",         "events",
                                           "reports",    "maxDelta",    "spikes",     "maxSpike",    "discards",
                                           "mismatches", "frameP50",    "frameP99",   "frameMax",    "over25",
                                           "over50",     "worstFrame",  "longTasks",  "longTaskMax", "ageP50",
                                           "ageMax",     "rawRefusals", "holdbackMs", "lateShare"};
    for (const auto &[key, value] : body.at("input").items()) {
        if (numbers.contains(key) && value.is_number() && std::isfinite(value.get<double>())) {
            result["input"][key] = std::clamp(std::round(value.get<double>() * 100) / 100, -1e6, 1e6);
        } else if ((key == "source" || key == "lock" || key == "rawError") && value.is_string()) {
            result["input"][key] = value.get<std::string>().substr(0, 24);
        } else if ((key == "filter" || key == "timed" || key == "timedOff") && value.is_boolean()) {
            result["input"][key] = value;
        }
    }
    return result;
}

Json sanitize_play(const Json &play) {
    Json result = Json::object();
    const std::pair<const char *, int> bounds[] = {
            {"attempt", 10'000'000}, {"seconds", 100'000'000}, {"session", 1'000'000}, {"sessionSeconds", 1'000'000}
    };
    for (const auto &[key, maximum] : bounds) {
        if (!play.contains(key) || !play[key].is_number()) continue;
        const double value = play[key];
        const int minimum = std::string_view(key) == "attempt" || std::string_view(key) == "session" ? 1 : 0;
        if (std::isfinite(value) && value == std::round(value) && value >= minimum && value <= maximum)
            result[key] = value;
    }
    if (play.contains("frameCap")) {
        const auto &cap = play["frameCap"];
        if (cap["limit"].is_number_integer() && cap["limit"] >= 0 && cap["limit"] <= 10'000
            && cap["vsync"].is_boolean())
            result["frameCap"] = cap;
    }
    if (play.contains("turn")) {
        const double yaw = play["turn"]["yawSpeed"], fast = play["turn"]["angleSpeedKey"];
        if (std::isfinite(yaw) && yaw >= 60 && yaw <= 720 && std::isfinite(fast) && fast >= 1 && fast <= 4)
            result["turn"] = {
                    {"yawSpeed", std::round(yaw * 100) / 100}, {"angleSpeedKey", std::round(fast * 100) / 100}
            };
    }
    constexpr unsigned rates[] = {125, 250, 500, 1000, 2000, 4000, 8000};
    if (play.contains("pollHz") && std::find(std::begin(rates), std::end(rates), play["pollHz"]) != std::end(rates))
        result["pollHz"] = play["pollHz"];
    return result;
}

void server_accepts(const Json &diagnostics) {
    auto sanitized = sanitize(diagnostics);
    sanitized["play"] = sanitize_play(diagnostics.at("play"));
    assert(sanitized == diagnostics);
    assert(sanitized.dump().size() <= 3072);
}

void recorded_run() {
    const auto root = std::filesystem::temp_directory_path() / "bunnyhop-run-diagnostics-test";
    std::filesystem::create_directories(root / "replays");
    const auto map = root / "fixture.bsp";
    const auto bytes = native::test::make_bsp();
    std::ofstream(map, std::ios::binary).write(reinterpret_cast<const char *>(bytes.data()), bytes.size());
    const auto model_path = root / "models" / "fixture" / "box.mdl";
    std::filesystem::create_directories(model_path.parent_path());
    const auto model = native::test::make_box_model();
    std::ofstream(model_path, std::ios::binary).write(reinterpret_cast<const char *>(model.data()), model.size());
    const std::unique_ptr<BhContext, decltype(&bh_destroy)> core(bh_create(), bh_destroy);
    assert(core && bh_load_map(core.get(), map.string().c_str(), root.string().c_str()));
    BhRunOptions options{};
    bh_default_run_options(&options);
    const BhZone zones[] = {
            {0, 0, 0, {-100, -100, -10000}, {100, 100, 1000}}, {1, 0, 0, {150, -100, -10000}, {1000, 100, 1000}}
    };
    assert(bh_run_configure(core.get(), &options, zones, 2));
    assert(bh_reset(core.get()) && bh_set_position(core.get(), 10, 20, 65, 0));
    native::RunRecorder recorder;
    recorder.begin(core.get(), root, "fixture", "bunnyhop-native/test", "autohop", "player", {}, "");
    native::TimedInput queue;
    recorder.diagnostics.start(second_ns, queue, true);
    constexpr unsigned maximum_frames = 1000, reports_per_frame = 10;
    BhRunState run{};
    unsigned frame_count = 0;
    for (unsigned frame = 1; frame <= maximum_frames && run.status != 2; ++frame) {
        frame_count = frame;
        for (unsigned report = 1; report <= reports_per_frame; ++report) {
            const uint64_t timestamp = second_ns + ((frame - 1) * reports_per_frame + report) * millisecond_ns;
            recorder.diagnostics.motion(timestamp, timestamp + millisecond_ns, 1, 0);
            ++queue.reports;
        }
        BhCmd command{};
        command.forward = 450;
        command.buttons = native::forward;
        BhState state{};
        assert(bh_step(core.get(), &command, &state));
        assert(bh_run_state(core.get(), &run));
        ++queue.late;
        const uint64_t now = second_ns + frame * 10 * millisecond_ns;
        if (run.status == 2)
            recorder.diagnostics.stop(now, queue);
        else
            recorder.diagnostics.frame(now, queue);
    }
    assert(run.status == 2);
    recorder.write(core.get());
    std::ifstream replay(recorder.path, std::ios::binary);
    const std::string replay_bytes{std::istreambuf_iterator<char>(replay), std::istreambuf_iterator<char>()};
    assert(!replay_bytes.empty());
    const auto event = recorder.finish_event(
            run.track, run.seconds, replay_bytes, {{"attempt", 3}, {"seconds", 12}}, {{"sensitivity", 1.73}}
    );
    const auto &diagnostics = event.at("diagnostics");
    server_accepts(diagnostics);
    assert(diagnostics["fps"] == 100);
    assert(diagnostics["input"]["events"] == frame_count * 10 && diagnostics["input"]["lateShare"] == .1);
    assert(diagnostics["input"]["frameP50"] == 10 && diagnostics["input"]["ageP50"] == 1);
    assert(event["mouse"]["sensitivity"] == 1.73 && !event["mouse"].contains("dpi"));
    const auto frozen = diagnostics;
    recorder.diagnostics.motion(4 * second_ns, 4 * second_ns, 500, 0);
    recorder.diagnostics.frame(5 * second_ns, queue);
    assert(recorder.finish_event(run.track, run.seconds, replay_bytes, {{"attempt", 3}, {"seconds", 12}})["diagnostics"]
           == frozen);
    std::filesystem::remove_all(root);
}

void history() {
    native::ActivityCounter activity;
    activity.loaded("map");
    activity.input(100);
    activity.frame("map", 2, 101, true);
    activity.frame("map", 2, 131, true);  // Idle time does not count.
    native::RunHistory history;
    history.restore({{"map", {4u, 120.}}});
    const auto prefs = native::Preferences::from_settings(native::default_settings());
    history.select("map", 0, "autohop", 100);
    history.start(101);
    activity.attempt("map");
    auto play = history.play(activity, "map", prefs, {});
    assert(play["attempt"] == 5 && play["seconds"] == 122 && play["session"] == 1);
    history.select("map", 0, "autohop", 105);  // Preparing a restart is not a timer start.
    assert(history.play(activity, "map", prefs, {})["session"] == 1);
    history.start(110);
    assert(history.play(activity, "map", prefs, {})["sessionSeconds"] == 9);
    history.select("map", 1, "scroll", 120);
    history.start(121);
    activity.attempt("map");
    assert(history.play(activity, "map", prefs, {})["attempt"] == 6);
    assert(history.play(activity, "map", prefs, {})["session"] == 1);
    native::RunHistory restored;
    restored.restore(history.snapshot(activity));
    native::ActivityCounter next_activity;
    assert(restored.play(next_activity, "map", prefs, {})["seconds"] == 122);
    history.select("map", 0, "autohop", 8000);
    history.start(8001);
    assert(history.play(activity, "map", prefs, {})["session"] == 1);
    server_accepts(native::RunDiagnostics{}.serialize(play));
}

// Hover cards show "Native client 0.6.2": the release version survives each run's reset; a local build sends none.
void client_version() {
    native::TimedInput queue;
    native::RunDiagnostics diagnostics;
    diagnostics.set_client_version("0.6.2");
    diagnostics.start(second_ns, queue, true);
    diagnostics.stop(2 * second_ns, queue);
    const auto released = diagnostics.serialize(Json::object());
    assert(released.at("client") == Json({{"kind", "native"}, {"version", "0.6.2"}}));
    server_accepts(released);
    native::RunDiagnostics local;
    local.set_client_version("local");
    assert(local.serialize(Json::object()).at("client") == Json({{"kind", "native"}}));
}

void polling() {
    constexpr unsigned rates[] = {125, 250, 500, 1000, 2000, 4000, 8000};
    for (unsigned rate : rates) {
        native::RunDiagnostics diagnostics;
        native::TimedInput queue;
        diagnostics.start(second_ns, queue, true);
        uint64_t next_report = 1;
        for (unsigned frame = 1; frame <= 200; ++frame) {
            const uint64_t now = second_ns + frame * 10 * millisecond_ns;
            while (second_ns + next_report * second_ns / rate <= now) {
                const uint64_t timestamp = second_ns + next_report++ * second_ns / rate;
                diagnostics.motion(timestamp, now, 1, 0);
            }
            if (frame < 200) diagnostics.frame(now, queue);
        }
        diagnostics.stop(3 * second_ns, queue);
        const auto result = diagnostics.serialize(Json::object());
        server_accepts(result);
        assert(result["play"]["pollHz"] == rate);
    }
}

void bounds_and_reset() {
    native::RunDiagnostics diagnostics;
    native::TimedInput queue;
    diagnostics.start(second_ns, queue, false);
    diagnostics.motion(second_ns, second_ns + millisecond_ns, 2e6, 0);
    diagnostics.stop(2 * second_ns, queue);
    auto result = diagnostics.serialize(Json::object());
    server_accepts(result);
    assert(result["input"]["maxDelta"] == 1e6 && result["input"]["over50"] == 1);
    assert(!result["play"].contains("pollHz"));
    diagnostics.start(3 * second_ns, queue, true);
    diagnostics.stop(4 * second_ns, queue);
    result = diagnostics.serialize(Json::object());
    server_accepts(result);
    assert(result["input"]["events"] == 0 && result["input"]["maxDelta"] == 0);
    assert(sanitize_play({{"attempt", 10'000'001}, {"seconds", -1}, {"pollHz", 999}}).empty());
}
}  // namespace

int main() {
    recorded_run();
    history();
    polling();
    client_version();
    bounds_and_reset();
}
