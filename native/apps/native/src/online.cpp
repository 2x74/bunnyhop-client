#include "atomic_replace.hpp"
#include "data_location.hpp"
#include "json_fields.hpp"
#include "online.hpp"
#include "bunnyhop_native.h"
#include <curl/curl.h>
#include <algorithm>
#include <exception>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>
#include <vector>

namespace native {
namespace {
constexpr size_t MiB = 1024 * 1024;
const std::string origin = "https://bunnyhop.lol";
// This slow for this long counts as stalled. There's no limit on a whole transfer: the largest map has to be able to
// finish on a slow line, and a retry would start it again from nothing.
constexpr long stalled_bytes_per_second = 1024;
constexpr long stall_window_seconds = 30;
constexpr long connect_timeout_seconds = 15;
// Content files download this many at a time. A map like bhop_epiphany has 859, and one at a time each paid a full
// round trip or more.
constexpr size_t content_workers = 8;
using Bytes = std::vector<uint8_t>;

struct Response {
    Bytes bytes;
    size_t limit;
    bool oversized = false;
};

size_t receive(char *data, size_t size, size_t count, void *opaque) noexcept {
    auto &r = *static_cast<Response *>(opaque);
    if (size && count > SIZE_MAX / size) {
        r.oversized = true;
        return 0;
    }
    const auto length = size * count;
    if (length > r.limit - r.bytes.size()) {
        r.oversized = true;
        return 0;
    }
    try {
        r.bytes.insert(r.bytes.end(), data, data + length);
    } catch (...) {
        return 0;
    }
    return length;
}

struct Transfer {
    const std::atomic_bool *cancel;
    LoadProgressCallback progress;
};

int transfer(void *context, curl_off_t total, curl_off_t received, curl_off_t, curl_off_t) noexcept {
    auto &t = *static_cast<Transfer *>(context);
    if (t.cancel && t.cancel->load()) return 1;
    try {
        if (t.progress)
            t.progress(
                    {"download",
                     "Downloading map data",
                     uint64_t(std::max<curl_off_t>(0, received)),
                     uint64_t(std::max<curl_off_t>(0, total))}
            );
    } catch (...) {
        return 1;
    }
    return 0;
}

// One handle per thread, reset between requests. curl keeps open connections and TLS sessions on the handle, so the
// next request from the same thread skips the handshake.
CURL *thread_handle() {
    static const bool initialized = curl_global_init(CURL_GLOBAL_DEFAULT) == CURLE_OK;
    if (!initialized) return nullptr;
    thread_local std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> handle(curl_easy_init(), curl_easy_cleanup);
    if (handle) curl_easy_reset(handle.get());
    return handle.get();
}

Bytes fetch(
        const std::string &url, size_t limit, const std::atomic_bool *cancel, const LoadProgressCallback &progress = {}
) {
    if (cancel && cancel->load()) throw std::runtime_error("Map download cancelled");
    Transfer transfer_state{cancel, progress};
    CURL *const handle = thread_handle();
    if (!handle) throw std::runtime_error("Cannot initialize HTTPS");
    Response r{{}, limit};
    char error[CURL_ERROR_SIZE]{};
    curl_easy_setopt(handle, CURLOPT_URL, url.c_str());
    curl_easy_setopt(handle, CURLOPT_USERAGENT, "bunnyhop-native/0.1");
    curl_easy_setopt(handle, CURLOPT_PROTOCOLS_STR, "https");
    curl_easy_setopt(handle, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(handle, CURLOPT_FAILONERROR, 1L);
    curl_easy_setopt(handle, CURLOPT_ACCEPT_ENCODING, "");
    curl_easy_setopt(handle, CURLOPT_CONNECTTIMEOUT, connect_timeout_seconds);
    curl_easy_setopt(handle, CURLOPT_LOW_SPEED_LIMIT, stalled_bytes_per_second);
    curl_easy_setopt(handle, CURLOPT_LOW_SPEED_TIME, stall_window_seconds);
    curl_easy_setopt(handle, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(handle, CURLOPT_ERRORBUFFER, error);
    curl_easy_setopt(handle, CURLOPT_WRITEFUNCTION, receive);
    curl_easy_setopt(handle, CURLOPT_WRITEDATA, &r);
    curl_easy_setopt(handle, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(handle, CURLOPT_XFERINFOFUNCTION, transfer);
    curl_easy_setopt(handle, CURLOPT_XFERINFODATA, &transfer_state);
    const auto result = curl_easy_perform(handle);
    long status = 0;
    curl_easy_getinfo(handle, CURLINFO_RESPONSE_CODE, &status);
    if (cancel && cancel->load()) throw std::runtime_error("Map download cancelled");
    if (r.oversized) throw std::runtime_error("Hosted map data exceeds size budget");
    if (status >= 500 && status <= 599)
        throw DownloadNetworkError("Map server temporarily unavailable (HTTP " + std::to_string(status) + ")");
    if (result != CURLE_OK && result != CURLE_HTTP_RETURNED_ERROR)
        throw DownloadNetworkError(
                "Network unavailable: " + std::string(error[0] ? error : curl_easy_strerror(result))
        );
    if (result != CURLE_OK || status != 200)
        throw std::runtime_error(
                "Download " + url + ": " + (error[0] ? std::string(error) : "HTTP " + std::to_string(status))
        );
    return std::move(r.bytes);
}

Bytes get(
        const std::string &route,
        size_t limit,
        const std::atomic_bool *cancel,
        const LoadProgressCallback &progress = {}
) {
    return fetch(origin + route, limit, cancel, progress);
}

bool hash_id(const std::string &s) {
    return s.size() == 64 && s.find_first_not_of("0123456789abcdef") == std::string::npos;
}

std::string hash(const Bytes &bytes) {
    char out[65]{};
    if (!bh_sha256(bytes.data(), bytes.size(), out)) throw std::runtime_error("Content hash failed");
    return out;
}

void save(const std::filesystem::path &path, const Bytes &bytes) {
    std::filesystem::create_directories(path.parent_path());
    atomic_write_file(path, std::string_view(reinterpret_cast<const char *>(bytes.data()), bytes.size()));
}

// Whether `path` already holds exactly the bytes hashing to `sha`. Its size can't prove that, so this reads it.
bool file_matches(const std::filesystem::path &path, const std::string &sha, size_t max_size) {
    std::error_code error;
    if (!std::filesystem::is_regular_file(path, error)) return false;
    const auto size = std::filesystem::file_size(path, error);
    if (error || size > max_size) return false;
    std::ifstream stream(path, std::ios::binary);
    Bytes bytes((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    return bytes.size() == size && hash(bytes) == sha;
}

void report_cached(const LoadProgressCallback &progress, uint64_t size, bool offline) {
    if (progress) progress({"cache", "Using verified downloaded content", size, size, 0, 0, true, offline});
}

std::filesystem::path
asset(const std::filesystem::path &cache,
      const std::string &sha,
      const std::string &route,
      size_t max_size,
      const std::atomic_bool *cancel,
      const LoadProgressCallback &progress = {},
      bool offline = false,
      const DownloadFetch &fetch = {},
      bool *downloaded = nullptr) {
    if (cancel && cancel->load()) throw std::runtime_error("Map download cancelled");
    if (!hash_id(sha)) throw std::runtime_error("Invalid hosted content hash");
    const auto file = cache / "objects" / sha;
    if (file_matches(file, sha, max_size)) {
        report_cached(progress, std::filesystem::file_size(file), offline);
        return file;
    }
    if (offline) throw std::runtime_error("Cached map data is missing or corrupt; reconnect and retry");
    const auto bytes = fetch ? fetch(route, max_size, cancel, progress) : get(route, max_size, cancel, progress);
    if (cancel && cancel->load()) throw std::runtime_error("Map download cancelled");
    if (bytes.size() > max_size) throw std::runtime_error("Downloaded content exceeds size budget");
    if (hash(bytes) != sha) throw std::runtime_error("Content checksum mismatch: " + route);
    save(file, bytes);
    if (downloaded) *downloaded = true;
    return file;
}
}  // namespace

std::vector<uint8_t> fetch_https(
        const std::string &url, size_t limit, const std::atomic_bool *cancel, const LoadProgressCallback &progress
) {
    return fetch(url, limit, cancel, progress);
}

bool valid_map_id(const std::string &id) {
    return !id.empty() && id.size() <= 160 && id != "." && id != ".."
           && id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.")
                      == std::string::npos;
}

bool safe_content_path(const std::string &path) {
    if (path.empty() || path.size() > 1024 || path[0] == '/' || path.find_first_of("\\:\0", 0, 3) != std::string::npos)
        return false;
    for (const auto &part : data_location::from_utf8(path))
        if (part == "." || part == ".." || part.empty()) return false;
    return true;
}

namespace {
Bytes read_cached(const std::filesystem::path &path, size_t limit) {
    if (!std::filesystem::is_regular_file(path) || std::filesystem::file_size(path) > limit)
        throw std::runtime_error("Cached metadata unavailable; reconnect and retry");
    std::ifstream file(path, std::ios::binary);
    return Bytes(std::istreambuf_iterator<char>(file), {});
}

Bytes cached_detail(const std::filesystem::path &cache, const std::string &id, const std::atomic_bool *cancel) {
    const auto index = cache / "index" / (id + ".json");
    try {
        return read_cached(index, 4 * MiB);
    } catch (const std::exception &) {
    }
    // Migrate completed downloads made before the per-map index existed.
    Bytes newest;
    auto date = (std::filesystem::file_time_type::min)();
    const auto maps = cache / "maps";
    if (std::filesystem::is_directory(maps)) {
        for (const auto &entry : std::filesystem::directory_iterator(maps)) {
            if (cancel && cancel->load()) throw std::runtime_error("Map download cancelled");
            if (!entry.is_directory() || !hash_id(entry.path().filename().string())
                || !std::filesystem::is_regular_file(entry.path() / (id + ".bsp"))
                || !std::filesystem::is_regular_file(entry.path() / "manifest.json"))
                continue;
            try {
                auto bytes = read_cached(entry.path() / "detail.json", 4 * MiB);
                const auto detail = nlohmann::json::parse(bytes);
                if (detail.at("sha256") != entry.path().filename().string()) continue;
                const auto modified = std::filesystem::last_write_time(entry.path() / "detail.json");
                if (newest.empty() || modified > date) {
                    date = modified;
                    newest = std::move(bytes);
                }
            } catch (const std::exception &) {
            }
        }
    }
    if (newest.empty()) throw std::runtime_error("Map is not downloaded; connect to download it first");
    return newest;
}

// One hosted object and every path the manifest puts it at.
struct ContentObject {
    std::string sha;
    size_t size = 0;
    std::vector<std::string> paths;
};

// What the content workers share: the next object to take, the totals so far, and the first error.
struct ContentRun {
    std::mutex mutex;
    std::atomic_size_t next = 0;
    std::atomic_bool failed = false;
    std::exception_ptr error;
    size_t files_total = 0, files_done = 0;
    uint64_t bytes_done = 0;
    std::vector<uint64_t> in_flight;

    uint64_t received() const {
        uint64_t sum = bytes_done;
        for (const auto bytes : in_flight)
            sum += bytes;
        return sum;
    }
};

// Joins every worker it started, including when starting the next one throws.
struct WorkerThreads {
    std::vector<std::thread> threads;

    ~WorkerThreads() {
        for (auto &thread : threads)
            if (thread.joinable()) thread.join();
    }
};

struct MapTransfer {
    const std::string &id;
    const std::filesystem::path &cache;
    const std::function<void(const std::string &)> &progress;
    const std::atomic_bool *cancel;
    const DownloadLimits &limits;
    const LoadProgressCallback &detail_progress;
    const DownloadFetch &fetch;
    bool offline = false;
    LoadProgress current;

    void emit(LoadProgress value) const {
        value.offline = offline;
        if (detail_progress) detail_progress(value);
    }

    void phase(LoadProgress value) {
        current = std::move(value);
        progress(current.message);
        emit(current);
    }

    LoadProgressCallback transfer_progress() const {
        return [this](const LoadProgress &value) {
            auto update = current;
            update.received = value.received;
            update.total = value.total;
            update.cached = value.cached;
            emit(update);
        };
    }

    Bytes request(const std::string &route, size_t limit) const {
        if (cancel && cancel->load()) throw std::runtime_error("Map download cancelled");
        auto bytes = fetch ? fetch(route, limit, cancel, transfer_progress())
                           : get(route, limit, cancel, transfer_progress());
        if (bytes.size() > limit) throw std::runtime_error("Metadata exceeds size budget");
        return bytes;
    }

    Bytes detail() {
        phase({"metadata", "Checking latest map version: " + id});
        try {
            return request("/api/maps/" + id, 4 * MiB);
        } catch (const DownloadNetworkError &) {
            if (cancel && cancel->load()) throw;
            auto bytes = cached_detail(cache, id, cancel);
            offline = true;
            phase({"metadata", "Using previously downloaded map (offline)", 0, 0, 0, 0, true, true});
            return bytes;
        }
    }

    Bytes manifest(const std::filesystem::path &directory, const std::string &sha) {
        phase({"manifest", "Checking latest map content manifest"});
        // Content can change without a BSP change. Only an offline load uses
        // the old manifest; a retry must be able to repair stale metadata.
        if (!offline) {
            try {
                return request("/content-manifests/" + sha + ".json", 16 * MiB);
            } catch (const DownloadNetworkError &) {
                if (cancel && cancel->load()) throw;
                offline = true;
            }
        }
        return read_cached(directory / "manifest.json", 16 * MiB);
    }

    nlohmann::json content_files(const Bytes &bytes, const std::string &sha) const {
        const auto manifest = nlohmann::json::parse(bytes);
        if (manifest.at("mapSha256") != sha) throw std::runtime_error("Content manifest belongs to another map");
        // Optional groups may be null in a manifest; only a present group of the wrong shape is refused below.
        auto files = json_value(manifest, "files", nlohmann::json::object());
        const auto physics = json_value(
                json_value(manifest, "physics", nlohmann::json::object()), "files", nlohmann::json::object()
        );
        constexpr size_t content_file_limit = 40'000;
        if (!files.is_object() || !physics.is_object() || files.size() + physics.size() > content_file_limit)
            throw std::runtime_error("Invalid map content manifest");
        for (const auto &[path, info] : physics.items())
            files[path] = info;
        return files;
    }

    std::vector<ContentObject> content_objects(const nlohmann::json &files) const {
        std::map<std::string, ContentObject> objects;
        size_t total = 0;
        for (const auto &[path, info] : files.items()) {
            if (!safe_content_path(path)) throw std::runtime_error("Unsafe content path");
            const auto size = info.at("size").get<size_t>();
            if (size > limits.content_file || size > limits.content_total - total)
                throw std::runtime_error("Map content is too large");
            total += size;
            const auto sha = info.at("sha256").get<std::string>();
            auto &object = objects[sha];
            if (!object.paths.empty() && object.size != size)
                throw std::runtime_error("Map content " + path + ": Content size mismatch");
            object.sha = sha;
            object.size = size;
            object.paths.push_back(path);
        }
        std::vector<ContentObject> list;
        list.reserve(objects.size());
        for (auto &[sha, object] : objects)
            list.push_back(std::move(object));
        return list;
    }

    // Puts one object at each of its paths, downloading it at most once. A path that already holds the right bytes is
    // left alone. Returns how many paths needed no download.
    size_t materialize(
            const std::filesystem::path &content, const ContentObject &object, const LoadProgressCallback &transfer
    ) const {
        std::optional<std::filesystem::path> source;
        bool downloaded = false;
        for (const auto &path : object.paths) {
            try {
                const auto destination = content / data_location::from_utf8(path);
                if (file_matches(destination, object.sha, object.size)) continue;
                if (!source) {
                    const auto route = "/content/" + object.sha;
                    source = asset(
                            cache, object.sha, route, object.size, cancel, transfer, offline, fetch, &downloaded
                    );
                }
                if (std::filesystem::file_size(*source) != object.size)
                    throw std::runtime_error("Content size mismatch");
                std::filesystem::create_directories(destination.parent_path());
                std::filesystem::copy_file(*source, destination, std::filesystem::copy_options::overwrite_existing);
            } catch (const std::exception &error) {
                throw std::runtime_error("Map content " + path + ": " + error.what());
            }
        }
        return object.paths.size() - (downloaded ? 1 : 0);
    }

    std::string content_message(size_t file, size_t total, const std::string &path) const {
        return "Map content " + std::to_string(file) + "/" + std::to_string(total) + ": " + path;
    }

    // A transfer moved: the menu names the file it belongs to.
    void content_received(ContentRun &run, size_t worker, const std::string &path, uint64_t received) {
        std::lock_guard lock(run.mutex);
        run.in_flight[worker] = received;
        current.message = content_message(run.files_done + 1, run.files_total, path);
        current.received = run.received();
        emit(current);
    }

    void content_finished(ContentRun &run, size_t worker, const ContentObject &object, size_t cached) {
        std::lock_guard lock(run.mutex);
        run.in_flight[worker] = 0;
        for (size_t i = 0; i < object.paths.size(); ++i) {
            ++run.files_done;
            run.bytes_done += object.size;
            current.message = content_message(run.files_done, run.files_total, object.paths[i]);
            current.filesDone = run.files_done;
            current.received = run.received();
            progress(current.message);
            auto update = current;
            // The load journal counts the files that came from the cache by this flag.
            update.cached = i < cached;
            emit(update);
        }
    }

    void content_worker(
            const std::filesystem::path &content,
            const std::vector<ContentObject> &objects,
            ContentRun &run,
            size_t worker
    ) {
        try {
            const ContentObject *active = nullptr;
            const LoadProgressCallback transfer = [&](const LoadProgress &value) {
                if (!value.cached) content_received(run, worker, active->paths.front(), value.received);
            };
            for (size_t i = run.next++; i < objects.size(); i = run.next++) {
                if (run.failed || (cancel && cancel->load())) return;
                active = &objects[i];
                content_finished(run, worker, objects[i], materialize(content, objects[i], transfer));
            }
        } catch (...) {
            std::lock_guard lock(run.mutex);
            if (!run.error) run.error = std::current_exception();
            run.failed = true;
        }
    }

    void content(const std::filesystem::path &directory, const nlohmann::json &files) {
        const auto content = directory / "content";
        std::filesystem::create_directories(content);
        const auto objects = content_objects(files);
        uint64_t total = 0;
        for (const auto &object : objects)
            total += uint64_t(object.size) * object.paths.size();
        phase({"content", "Map content: " + std::to_string(files.size()) + " files", 0, total, 0, files.size()});
        ContentRun run;
        run.files_total = files.size();
        const size_t workers = std::min(content_workers, objects.size());
        run.in_flight.assign(workers, 0);
        {
            WorkerThreads threads;
            for (size_t worker = 0; worker < workers; ++worker)
                threads.threads.emplace_back([&, worker] { content_worker(content, objects, run, worker); });
        }
        if (run.error) std::rethrow_exception(run.error);
        if (cancel && cancel->load()) throw std::runtime_error("Map download cancelled");
    }

    // The map's own copy of the BSP, checked against its hash; downloaded or copied from the object cache if needed.
    std::filesystem::path bsp_file(const std::filesystem::path &directory, const std::string &sha) const {
        const auto bsp = directory / (id + ".bsp");
        if (file_matches(bsp, sha, limits.bsp)) {
            report_cached(transfer_progress(), std::filesystem::file_size(bsp), offline);
            return bsp;
        }
        const auto route = "/api/bsp/" + sha + ".bsp";
        const auto object = asset(cache, sha, route, limits.bsp, cancel, transfer_progress(), offline, fetch);
        std::filesystem::create_directories(directory);
        std::filesystem::copy_file(object, bsp, std::filesystem::copy_options::overwrite_existing);
        return bsp;
    }

    DownloadedMap run() {
        if (!valid_map_id(id)) throw std::runtime_error("Invalid map name");
        const auto detail_bytes = detail();
        auto map_detail = nlohmann::json::parse(detail_bytes);
        const auto sha = map_detail.at("sha256").get<std::string>();
        if (!hash_id(sha)) throw std::runtime_error("Invalid map checksum");
        phase({"bsp", "Downloading BSP: " + id});
        const auto directory = cache / "maps" / sha;
        const auto bsp = bsp_file(directory, sha);
        save(directory / "detail.json", detail_bytes);
        const auto manifest_bytes = manifest(directory, sha);
        const auto files = content_files(manifest_bytes, sha);
        content(directory, files);
        save(directory / "manifest.json", manifest_bytes);
        save(cache / "index" / (id + ".json"), detail_bytes);
        phase({"renderer",
               offline ? "Loading cached map into renderer" : "Loading native renderer",
               0,
               0,
               files.size(),
               files.size(),
               offline,
               offline});
        return {id, bsp, directory / "content", std::move(map_detail)};
    }
};
}  // namespace

DownloadedMap download_map(
        const std::string &id,
        const std::filesystem::path &cache,
        const std::function<void(const std::string &)> &progress,
        const std::atomic_bool *cancel,
        const DownloadLimits &limits,
        const LoadProgressCallback &detail_progress,
        const DownloadFetch &fetch
) {
    MapTransfer transfer{id, cache, progress, cancel, limits, detail_progress, fetch, false, {}};
    return transfer.run();
}

// Optional Valve sound content stays in the verified object cache, outside the
// application package. Only this manifest group is eligible for download.
void download_classic_sounds(
        const std::filesystem::path &content_root, const std::filesystem::path &cache, const DownloadFetch &fetch
) {
    const auto path = content_root.parent_path() / "manifest.json";
    if (!std::filesystem::is_regular_file(path) || std::filesystem::file_size(path) > 16 * MiB) return;
    std::ifstream f(path);
    nlohmann::json manifest;
    f >> manifest;
    const auto group =
            json_value(json_value(manifest, "optional", nlohmann::json::object()), "sounds", nlohmann::json::object());
    const auto files = json_value(group, "files", nlohmann::json::object());
    if (!files.is_object() || files.size() > 128) throw std::runtime_error("Invalid optional sound manifest");
    size_t total = 0;
    for (const auto &[name, info] : files.items()) {
        if (!safe_content_path(name) || !name.starts_with("sound/") || !name.ends_with(".wav"))
            throw std::runtime_error("Unsafe optional sound path");
        const size_t size = info.at("size");
        if (size > 4 * MiB || size > 32 * MiB - total) throw std::runtime_error("Optional sound content is too large");
        total += size;
        const std::string sha = info.at("sha256");
        const auto object = asset(cache, sha, "/content/" + sha, size, nullptr, {}, false, fetch);
        if (std::filesystem::file_size(object) != size) throw std::runtime_error("Optional sound size mismatch");
        const auto dest = cache / "classic" / name;
        std::filesystem::create_directories(dest.parent_path());
        std::filesystem::copy_file(object, dest, std::filesystem::copy_options::overwrite_existing);
    }
}

}  // namespace native
