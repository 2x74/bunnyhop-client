#include "online.hpp"
#include "data_location.hpp"
#include "map_download.hpp"
#include "room_state.hpp"
#include "bunnyhop_native.h"
#include <chrono>
#include <fstream>
#include <iostream>
#include <map>

namespace {
using Bytes = std::vector<uint8_t>;
using Json = nlohmann::json;
const std::string map_id = "bhop_cobblestone";
constexpr auto worker_timeout = std::chrono::seconds(5);

void check(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}

std::string digest(const Bytes &bytes) {
    char result[65]{};
    check(bh_sha256(bytes.data(), bytes.size(), result), "hash failed");
    return result;
}

Bytes encode(const Json &json) {
    const auto text = json.dump();
    return {text.begin(), text.end()};
}

struct Fixture {
    std::filesystem::path cache =
            std::filesystem::temp_directory_path()
            / ("native-map-load-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    Bytes bsp{'V', 'B', 'S', 'P', '1'};
    Bytes content{'m', 'a', 't'};
    std::string sha = digest(bsp), content_sha = digest(content);
    std::string detail_route = "/api/maps/" + map_id;
    std::string manifest_route = "/content-manifests/" + sha + ".json";
    std::string bsp_route = "/api/bsp/" + sha + ".bsp";
    std::string content_route = "/content/" + content_sha;
    std::map<std::string, Bytes> routes;
    std::map<std::string, int> requests;
    std::string failed_route;
    bool network_error = false;

    Fixture() {
        routes[detail_route] = encode({{"sha256", sha}, {"zones", {{"revision", 1}}}});
        routes[manifest_route] =
                encode({{"mapSha256", sha},
                        {"files", {{"materials/test.vmt", {{"sha256", content_sha}, {"size", content.size()}}}}}});
        routes[bsp_route] = bsp;
        routes[content_route] = content;
    }

    ~Fixture() {
        std::error_code error;
        std::filesystem::remove_all(cache, error);
    }

    native::DownloadFetch fetch() {
        return [this](const std::string &route,
                      size_t,
                      const std::atomic_bool *,
                      const native::LoadProgressCallback &progress) {
            ++requests[route];
            if (route == failed_route) {
                if (network_error) throw native::DownloadNetworkError("fixture connection lost");
                throw std::runtime_error("HTTP 404: " + route);
            }
            if (progress) progress({"download", "Downloading map data", 1, routes.at(route).size()});
            return routes.at(route);
        };
    }

    native::DownloadedMap load(const native::LoadProgressCallback &progress = {}) {
        return native::download_map(map_id, cache, [](const std::string &) {}, nullptr, {}, progress, fetch());
    }

    void write(const std::filesystem::path &path, const std::string &text) {
        std::filesystem::create_directories(path.parent_path());
        std::ofstream(path, std::ios::binary) << text;
    }

    std::string failure() {
        try {
            load();
        } catch (const std::exception &error) {
            return error.what();
        }
        throw std::runtime_error("expected a failed download");
    }
};

void check_manifest_refresh() {
    Fixture fixture;
    const auto first = fixture.load();
    fixture.write(
            first.content_root.parent_path() / "manifest.json",
            "{\"mapSha256\":\"" + fixture.sha + "\",\"files\":{\"materials/test.vmt\":{\"sha256\":\""
                    + std::string(64, '0') + "\",\"size\":3}}}"
    );
    fixture.load();
    check(fixture.requests[fixture.manifest_route] == 2, "stale manifest wasn't refreshed once");
    check(fixture.requests["/content/" + std::string(64, '0')] == 0, "stale content requested");
    fixture.write(first.content_root.parent_path() / "manifest.json", "{truncated");
    fixture.load();
    check(fixture.requests[fixture.manifest_route] == 3, "truncated manifest wasn't recovered");
}

void check_room_reconnect() {
    native::RoomState room;
    const Json welcome = {
            {"generation", 1},
            {"id", "test"},
            {"event", {{"t", "welcome"}, {"you", 1}, {"players", Json::array()}, {"map", {{"name", map_id}}}}}
    };
    check(room.event(welcome) == map_id, "room join didn't request its map");
    // A failed load leaves no gameplay map. Reconnecting must leave Retry in control.
    for (int reconnect = 0; reconnect < 5; ++reconnect)
        check(room.event(welcome).empty(), "room reconnect requested the failed map again");
    const Json change = {{"generation", 1}, {"id", "test"}, {"event", {{"t", "nativeMap"}, {"map", "bhop_other"}}}};
    check(room.event(change) == "bhop_other", "room switch didn't request new map");
    check(room.event(change).empty(), "duplicate room switch requested a map again");
    auto rejoined = welcome;
    rejoined["generation"] = 2;
    check(room.event(rejoined) == map_id, "deliberate rejoin couldn't retry the map");
}

void check_cache_recovery() {
    Fixture fixture;
    const auto first = fixture.load();
    for (const auto &bytes : {"V", "obsolete BSP", ""}) {
        fixture.write(fixture.cache / "objects" / fixture.sha, bytes);
        fixture.write(first.bsp, "truncated materialized BSP");
        fixture.write(first.content_root / "materials/test.vmt", "old materialized content");
        fixture.write(fixture.cache / "objects" / fixture.content_sha, "bad");
        fixture.requests.clear();
        const auto loaded = fixture.load();
        check(fixture.requests[fixture.bsp_route] == 1, "bad BSP wasn't fetched exactly once");
        check(fixture.requests[fixture.content_route] == 1, "bad content wasn't fetched exactly once");
        check(std::filesystem::file_size(loaded.bsp) == fixture.bsp.size(), "BSP copy wasn't repaired");
        check(std::filesystem::file_size(loaded.content_root / "materials/test.vmt") == fixture.content.size(),
              "materialized content wasn't repaired");
    }
    fixture.write(fixture.cache / "objects" / fixture.sha, "bad");
    fixture.routes[fixture.bsp_route] = {'b', 'a', 'd'};
    fixture.requests.clear();
    check(fixture.failure().find("checksum mismatch") != std::string::npos, "bad BSP download wasn't reported");
    check(fixture.requests[fixture.bsp_route] == 1, "bad download retried itself");
    fixture.routes[fixture.bsp_route] = fixture.bsp;
    fixture.load();
    check(fixture.requests[fixture.bsp_route] == 2, "explicit retry didn't recover the BSP");
}

void check_failed_content() {
    for (const bool network_error : {false, true}) {
        Fixture fixture;
        fixture.failed_route = fixture.content_route;
        fixture.network_error = network_error;
        const auto failure = fixture.failure();
        check(failure.find("materials/test.vmt") != std::string::npos, "failure didn't identify content path");
        check(fixture.requests[fixture.content_route] == 1, "failed content retried itself");
        check(!std::filesystem::exists(fixture.cache / "index" / (map_id + ".json")),
              "incomplete download was recorded as complete");
        fixture.failed_route.clear();
        fixture.load();
        check(fixture.requests[fixture.content_route] == 2, "explicit retry didn't recover content");
        check(fixture.requests[fixture.bsp_route] == 1, "content retry downloaded the verified BSP again");
    }
}

void check_content_checksum() {
    Fixture fixture;
    fixture.routes[fixture.content_route] = {'b', 'a', 'd'};
    check(fixture.failure().find("checksum mismatch") != std::string::npos, "bad content checksum wasn't reported");
    check(fixture.requests[fixture.content_route] == 1, "bad content download retried itself");
    check(!std::filesystem::exists(fixture.cache / "objects" / fixture.content_sha), "bad content was cached");
    fixture.routes[fixture.content_route] = fixture.content;
    fixture.load();
    check(fixture.requests[fixture.content_route] == 2, "explicit retry didn't recover bad content");
}

void check_manifest_failure() {
    Fixture fixture;
    fixture.load();
    fixture.failed_route = fixture.manifest_route;
    check(fixture.failure().find("404") != std::string::npos, "manifest 404 silently used stale cache");
    check(fixture.requests[fixture.manifest_route] == 2, "manifest 404 retried itself");
    fixture.network_error = true;
    bool offline = false;
    fixture.load([&](const native::LoadProgress &value) { offline = value.offline; });
    check(offline, "network failure didn't use the verified offline manifest");
    fixture.failed_route.clear();
    fixture.load();
    check(fixture.requests[fixture.manifest_route] == 4, "explicit retry couldn't fetch manifest again");
}

void check_updated_metadata() {
    Fixture fixture;
    fixture.load();
    fixture.routes[fixture.detail_route] = encode({{"sha256", fixture.sha}, {"zones", {{"revision", 2}}}});
    const Bytes changed_content{'n', 'e', 'w'};
    const auto changed_sha = digest(changed_content);
    fixture.routes["/content/" + changed_sha] = changed_content;
    fixture.routes[fixture.manifest_route] =
            encode({{"mapSha256", fixture.sha},
                    {"files", {{"materials/test.vmt", {{"sha256", changed_sha}, {"size", changed_content.size()}}}}}});
    fixture.requests.clear();
    const auto updated = fixture.load();
    check(updated.detail["zones"]["revision"] == 2, "updated zones weren't loaded");
    check(fixture.requests["/content/" + changed_sha] == 1, "updated manifest wasn't used");
    check(fixture.requests[fixture.bsp_route] == 0, "unchanged BSP was downloaded again");
    const Bytes changed_bsp{'V', 'B', 'S', 'P', '2'};
    const auto changed_bsp_sha = digest(changed_bsp);
    fixture.routes[fixture.detail_route] = encode({{"sha256", changed_bsp_sha}});
    fixture.routes["/api/bsp/" + changed_bsp_sha + ".bsp"] = changed_bsp;
    fixture.routes["/content-manifests/" + changed_bsp_sha + ".json"] = encode({{"mapSha256", changed_bsp_sha}});
    const auto changed_map = fixture.load();
    check(changed_map.bsp != updated.bsp, "new BSP revision reused old map directory");
}

void check_file_progress() {
    Fixture fixture;
    bool content_progress = false;
    fixture.load([&](const native::LoadProgress &progress) {
        if (progress.received == 1 && progress.stage == "content") {
            check(progress.filesTotal == 1 && progress.filesDone == 0, "content counters were lost");
            check(progress.message.find("materials/test.vmt") != std::string::npos, "content name was lost");
            content_progress = true;
        }
    });
    check(content_progress, "no file download progress reached the menu");
}

void check_moved_cache() {
    Fixture source, destination;
    source.load();
    native::data_location::Progress progress;
    check(native::data_location::move(source.cache, destination.cache, source.cache, progress).empty(),
          "game data move failed");
    destination.failed_route = destination.detail_route;
    destination.network_error = true;
    bool offline = false;
    const auto loaded = destination.load([&](const native::LoadProgress &value) { offline = value.offline; });
    check(offline && std::filesystem::exists(loaded.bsp), "moved cache didn't load offline");
    check(destination.requests.size() == 1, "moved cache tried to download content again");
}

struct ReleaseWorker {
    std::promise<void> &release;

    ~ReleaseWorker() {
        try {
            release.set_value();
        } catch (const std::future_error &) {
        }
    }
};

void check_map_switch() {
    Fixture fixture;
    fixture.routes["/api/maps/bhop_other"] = fixture.routes[fixture.detail_route];
    std::mutex mutex;
    auto lock_cache = [&](const std::atomic_bool &) {
        return std::unique_lock(mutex);
    };
    std::promise<void> entered, release;
    auto released = release.get_future().share();
    const auto fetch = fixture.fetch();
    std::atomic_bool held = false;
    native::DownloadFetch delayed = [&](const std::string &route,
                                        size_t limit,
                                        const std::atomic_bool *cancel,
                                        const native::LoadProgressCallback &progress) {
        if (route == fixture.bsp_route && !held.exchange(true)) {
            entered.set_value();
            released.wait();
        }
        return fetch(route, limit, cancel, progress);
    };
    native::MapDownload download;
    ReleaseWorker guard{release};
    download.start(map_id, fixture.cache, lock_cache, delayed);
    check(entered.get_future().wait_for(worker_timeout) == std::future_status::ready, "fixture download didn't enter");
    download.start(map_id, fixture.cache, lock_cache, delayed);
    download.preparing = true;
    download.start("bhop_other", fixture.cache, lock_cache, delayed);
    check(!download.preparing, "replacement kept the cancelled map's renderer preparation state");
    {
        std::lock_guard lock(download.mutex);
        check(download.progress["map"] == "bhop_other", "switch didn't replace progress immediately");
    }
    release.set_value();
    check(download.jobs.wait_for(worker_timeout) == std::future_status::ready, "replacement didn't finish");
    const auto result = download.jobs.get();
    check(result.map && result.map->id == "bhop_other", "cancelled map was installed instead of replacement");
    check(fixture.requests[fixture.detail_route] == 1, "duplicate request restarted a running map");
    check(fixture.requests[fixture.bsp_route] == 2, "cancelled worker wrote its BSP into the cache");
    check(download.progress["map"] == "bhop_other", "old progress overwrote replacement");
    download.jobs.poll();
}

void check_worker_retry() {
    Fixture fixture;
    fixture.failed_route = fixture.content_route;
    std::mutex mutex;
    auto lock_cache = [&](const std::atomic_bool &) {
        return std::unique_lock(mutex);
    };
    native::MapDownload download;
    download.start(map_id, fixture.cache, lock_cache, fixture.fetch());
    check(download.jobs.wait_for(worker_timeout) == std::future_status::ready, "failed worker didn't settle");
    const auto failed = download.jobs.get();
    check(!failed.map && !failed.error.empty() && !download.jobs.valid(),
          "failed worker held the already-loading guard");
    fixture.failed_route.clear();
    download.start(map_id, fixture.cache, lock_cache, fixture.fetch());
    check(download.jobs.wait_for(worker_timeout) == std::future_status::ready, "retry didn't finish");
    const auto result = download.jobs.get();
    check(result.map && result.map->id == map_id, "retry couldn't load failed map");
}
}  // namespace

int main(int argc, char **argv) {
    try {
        if (argc > 1 && std::string(argv[1]) == "room")
            check_room_reconnect();
        else {
            check_manifest_refresh();
            check_cache_recovery();
            check_failed_content();
            check_content_checksum();
            check_manifest_failure();
            check_updated_metadata();
            check_file_progress();
            check_moved_cache();
            check_map_switch();
            check_worker_retry();
        }
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
