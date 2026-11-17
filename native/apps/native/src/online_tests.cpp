#include "online.hpp"
#include "download_stats.hpp"
#include "download_retry.hpp"
#include "data_location.hpp"
#include "map_prefetch.hpp"
#include <future>
#include <iostream>
#include "bunnyhop_native.h"
#include <fstream>
#include <chrono>
#include <map>

int main() {
    auto check = [](bool value, const char *label) {
        if (!value) {
            std::cerr << label << '\n';
            std::exit(1);
        }
    };
    using native::valid_download_range;
    check(valid_download_range("bytes 4-9/10", 4, 6, 10), "valid resume rejected");
    check(valid_download_range("bytes 4-9/10", 4, 2, 10), "interrupted resume prefix rejected");
    for (const auto range :
         {"bytes 0-9/10",
          "bytes 4-8/10",
          "bytes 4-10/10",
          "bytes 4-9/*",
          "bytes 4-9/11",
          "bytes 4-9/10 trailing",
          "bytes 4-3/10",
          "garbage"})
        check(!valid_download_range(range, 4, 6, 10), "unsafe resume accepted");
    check(!valid_download_range("bytes 4-9/10", 4, 7, 10), "oversized range body accepted");
    const native::DownloadPrefix prefix{4};
    check(prefix.accept(206, "bytes 4-9/10", 6, 10, true), "resume rejected");
    check(!prefix.accept(200, "", 6, 10, true), "ignored range appended");
    check(!prefix.accept(206, "bytes 4-9/10", 6, 10, false), "compressed range appended");
    check(native::transient_download_error(CURLE_PARTIAL_FILE, 200), "dropped body not retried");
    check(native::transient_download_error(CURLE_HTTP2_STREAM, 0), "HTTP2 stream failure not retried");
    check(native::transient_download_error(CURLE_HTTP_RETURNED_ERROR, 503), "503 not retried");
    check(!native::transient_download_error(CURLE_HTTP_RETURNED_ERROR, 404), "404 retried");
    check(!native::transient_download_error(CURLE_PEER_FAILED_VERIFICATION, 0), "TLS failure retried");
    check(!native::transient_download_error(CURLE_ABORTED_BY_CALLBACK, 200), "cancel retried");
    check(native::download_attempts == 3 && native::download_retry_delay(1).count() == 500,
          "retry budget or backoff changed");
    native::DownloadStats stats;
    const native::DownloadSample sample{1024, 4096, 0.5, 0.1, 1, CURL_HTTP_VERSION_2_0};
    auto worker = std::async(std::launch::async, [&] {
        stats.request(sample);
        stats.cached();
    });
    stats.request(sample);
    stats.missing();
    stats.retried();
    worker.get();
    const auto summary = stats.summary("bhop_test", false, 2);
    check(summary.at("bytes") == 2048 && summary.at("decodedBytes") == 8192, "download bytes not summed");
    check(summary.at("requests") == 2 && summary.at("connections") == 2, "download connections not summed");
    check(summary.at("retries") == 1 && summary.at("cache") == "mixed", "download retry/cache summary wrong");
    check(summary.at("protocol") == "HTTP/2" && summary.at("complete") == false, "download outcome missing");
    check(summary.at("requestSeconds") == 1.0 && summary.at("firstByteSeconds") == 0.2, "download timing wrong");
    for (const auto &id : {"bhop_eazy", "bhop_lol_tutorial", "bhop_map-v2"})
        check(native::valid_map_id(id), "valid map rejected");
    for (const auto &id : {"", ".", "..", "../map", "https://evil.test/a", "a?b", "a#b", "a\\b"})
        check(!native::valid_map_id(id), "unsafe map accepted");
    for (const auto &path : {"materials/test.vmt", "models/props/test.dx90.vtx", "materials/map textures/stone.vtf"})
        check(native::safe_content_path(path), "valid content rejected");
    for (const auto &path : {"", "/tmp/a", "../x", "materials/../../a", "materials/../a", "C:/a", "a\\..\\x"})
        check(!native::safe_content_path(path), "unsafe content accepted");
    check(!native::safe_content_path(std::string("materials/a\0.vmt", 16)), "NUL path accepted");
    const auto cache =
            std::filesystem::temp_directory_path() / native::data_location::from_utf8("Jos\xc3\xa9-\xe6\xb8\xac")
            / ("native-cache-test-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));

    struct Cleanup {
        std::filesystem::path p;

        ~Cleanup() {
            std::error_code e;
            std::filesystem::remove_all(p, e);
        }
    } cleanup{cache};

    using Bytes = std::vector<uint8_t>;
    const Bytes bsp{'V', 'B', 'S', 'P', '1'}, content{'m', 'a', 't'};
    auto digest = [](const Bytes &b) {
        char out[65]{};
        if (!bh_sha256(b.data(), b.size(), out)) throw std::runtime_error("hash");
        return std::string(out);
    };
    const auto sha = digest(bsp), fileSha = digest(content);
    auto encode = [](const nlohmann::json &j) {
        auto s = j.dump();
        return Bytes(s.begin(), s.end());
    };
    const auto detail = encode({{"sha256", sha}, {"name", "bhop_test"}});
    const auto manifest =
            encode({{"mapSha256", sha},
                    {"files", {{"materials/test.vmt", {{"sha256", fileSha}, {"size", content.size()}}}}},
                    // Optional groups may come as null (a value() on them used to throw type_error.306).
                    {"physics", nullptr},
                    {"optional", nullptr}});
    // Content files download on several workers.
    std::atomic_int requests = 0;
    bool offline = false, notFound = false;
    native::LoadProgress latest;
    native::DownloadFetch fetch =
            [&](const std::string &route, size_t, const std::atomic_bool *, const native::LoadProgressCallback &) {
                ++requests;
                if (notFound) throw std::runtime_error("HTTP 404");
                if (offline) throw native::DownloadNetworkError("offline fixture");
                if (route == "/api/maps/bhop_test") return detail;
                if (route == "/content-manifests/" + sha + ".json") return manifest;
                if (route == "/api/bsp/" + sha + ".bsp") return bsp;
                if (route == "/content/" + fileSha) return content;
                throw std::runtime_error("Unexpected route");
            };
    auto load = [&] {
        return native::download_map(
                "bhop_test", cache, [](const std::string &) {}, nullptr, {}, [&](const auto &p) { latest = p; }, fetch
        );
    };
    const auto first = load();
    check(requests == 4, "first load fetches detail/BSP/manifest/content");
    check(std::filesystem::exists(first.content_root / "materials/test.vmt"), "content not materialized");
    const std::atomic_bool prefetch_cancel = false;
    auto prefetched = std::async(std::launch::async, [&] {
        return native::prefetch_map("bhop_test", sha, cache, prefetch_cancel, fetch);
    });
    check(prefetched.get(), "verified worker prefetch failed");
    auto stale = std::async(std::launch::async, [&] {
        return native::prefetch_map("bhop_test", std::string(64, '0'), cache, prefetch_cancel, fetch);
    });
    check(!stale.get(), "prefetch accepted a different map revision");
    requests = 0;
    load();
    check(requests == 2, "cached objects should only fetch current detail and manifest");
    std::filesystem::remove(cache / "index" / "bhop_test.json");  // Older client cache migration.
    offline = true;
    requests = 0;
    load();
    check(requests == 1 && latest.offline, "offline cache did not load");
    notFound = true;
    bool rejected = false;
    try {
        load();
    } catch (...) {
        rejected = true;
    }
    check(rejected, "404 must not use stale cache");
    notFound = false;
    offline = false;
    std::filesystem::remove(cache / "objects" / fileSha);
    requests = 0;
    load();
    check(requests == 2, "a materialized file that matches its hash should not be fetched again");
    offline = true;
    for (const auto &path : {cache / "objects" / fileSha, first.content_root / "materials/test.vmt"}) {
        std::ofstream corrupt(path);
        corrupt << "bad";
    }
    rejected = false;
    try {
        load();
    } catch (...) {
        rejected = true;
    }
    check(rejected, "offline corrupt object accepted");
    offline = false;
    requests = 0;
    load();
    check(requests == 3, "corrupt content should redownload once after checking metadata");
    std::atomic_bool canceled = true;
    rejected = false;
    try {
        native::download_map("bhop_test", cache, [](const std::string &) {}, &canceled, {}, {}, fetch);
    } catch (...) {
        rejected = true;
    }
    check(rejected, "cancelled cache load accepted");
    const auto sound = encode(
            {{"optional",
              {{"sounds",
                {{"files",
                  {{"sound/player/footsteps/metal1.wav", {{"sha256", fileSha}, {"size", content.size()}}}}}}}}}}
    );
    {
        std::ofstream f(first.content_root.parent_path() / "manifest.json", std::ios::binary);
        f.write(reinterpret_cast<const char *>(sound.data()), sound.size());
    }
    requests = 0;
    native::download_classic_sounds(first.content_root, cache, fetch);
    check(requests == 0, "cached optional sound should use verified object");
    check(std::filesystem::exists(cache / "classic/sound/player/footsteps/metal1.wav"), "optional sound missing");
    {
        std::ofstream f(cache / "objects" / fileSha);
        f << "bad";
    }
    requests = 0;
    native::download_classic_sounds(first.content_root, cache, fetch);
    check(requests == 1, "corrupt optional sound must redownload");
    const auto unsafe = encode(
            {{"optional",
              {{"sounds", {{"files", {{"sound/../../bad.wav", {{"sha256", fileSha}, {"size", content.size()}}}}}}}}}}
    );
    {
        std::ofstream f(first.content_root.parent_path() / "manifest.json", std::ios::binary);
        f.write(reinterpret_cast<const char *>(unsafe.data()), unsafe.size());
    }
    rejected = false;
    try {
        native::download_classic_sounds(first.content_root, cache, fetch);
    } catch (...) {
        rejected = true;
    }
    check(rejected, "unsafe optional sound accepted");
    for (const auto &empty :
         {nlohmann::json{{"optional", nullptr}}, nlohmann::json{{"optional", {{"sounds", nullptr}}}}}) {
        const auto bytes = encode(empty);
        {
            std::ofstream f(first.content_root.parent_path() / "manifest.json", std::ios::binary);
            f.write(reinterpret_cast<const char *>(bytes.data()), bytes.size());
        }
        requests = 0;
        native::download_classic_sounds(first.content_root, cache, fetch);
        check(requests == 0, "a null optional group should fetch nothing");
    }
    // A map with more files than workers, two paths sharing one object: every file lands, each object is fetched once.
    std::map<std::string, Bytes> objects;
    nlohmann::json many_files = nlohmann::json::object();
    for (int i = 0; i < 40; ++i) {
        const Bytes body(size_t(100 + i), uint8_t(i));
        objects[digest(body)] = body;
        many_files["materials/many/" + std::to_string(i) + ".vtf"] = {{"sha256", digest(body)}, {"size", body.size()}};
    }
    many_files["materials/many/copy.vtf"] = many_files["materials/many/7.vtf"];
    const auto many_manifest = encode({{"mapSha256", sha}, {"files", many_files}});
    std::atomic_int content_requests = 0;
    native::DownloadFetch many_fetch =
            [&](const std::string &route, size_t, const std::atomic_bool *, const native::LoadProgressCallback &) {
                if (route == "/api/maps/bhop_test") return detail;
                if (route == "/content-manifests/" + sha + ".json") return many_manifest;
                if (route == "/api/bsp/" + sha + ".bsp") return bsp;
                ++content_requests;
                return objects.at(route.substr(std::string("/content/").size()));
            };
    native::LoadProgress last;
    const auto many = native::download_map(
            "bhop_test", cache, [](const std::string &) {}, nullptr, {}, [&](const auto &p) { last = p; }, many_fetch
    );
    check(content_requests == 40, "each object should be fetched once");
    check(last.filesDone == 41 && last.filesTotal == 41, "progress should count every file");
    for (const auto &[path, info] : many_files.items()) {
        std::ifstream file(many.content_root / native::data_location::from_utf8(path), std::ios::binary);
        const Bytes bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
        check(digest(bytes) == info.at("sha256").get<std::string>(), "materialized file differs");
    }
    return 0;
}
