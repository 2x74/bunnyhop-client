#include "online.hpp"
#include "bunnyhop_native.h"
#include <curl/curl.h>
#include <algorithm>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <vector>

namespace native {
namespace {
constexpr size_t MiB = 1024 * 1024;
const std::string origin = "https://bunnyhop.lol";
using Bytes = std::vector<uint8_t>;
struct Response { Bytes bytes; size_t limit; };
size_t receive(char *data, size_t size, size_t count, void *opaque) noexcept {
    auto &r = *static_cast<Response *>(opaque);
    if (size && count > SIZE_MAX / size) return 0;
    const auto length = size * count;
    if (length > r.limit - r.bytes.size()) return 0;
    try { r.bytes.insert(r.bytes.end(), data, data + length); }
    catch (...) { return 0; }
    return length;
}
int transfer(void *context, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    return context && static_cast<const std::atomic_bool *>(context)->load() ? 1 : 0;
}
Bytes get(const std::string &route, size_t limit, const std::atomic_bool *cancel) {
    using Curl = std::unique_ptr<CURL, decltype(&curl_easy_cleanup)>;
    Curl handle(curl_easy_init(), curl_easy_cleanup);
    if (!handle) throw std::runtime_error("Cannot initialize HTTPS");
    Response r{{}, limit};
    const auto url = origin + route;
    char error[CURL_ERROR_SIZE]{};
    curl_easy_setopt(handle.get(), CURLOPT_URL, url.c_str());
    curl_easy_setopt(handle.get(), CURLOPT_USERAGENT, "bunnyhop-native/0.1");
    curl_easy_setopt(handle.get(), CURLOPT_PROTOCOLS_STR, "https");
    curl_easy_setopt(handle.get(), CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(handle.get(), CURLOPT_FAILONERROR, 1L);
    curl_easy_setopt(handle.get(), CURLOPT_ACCEPT_ENCODING, "");
    curl_easy_setopt(handle.get(), CURLOPT_CONNECTTIMEOUT, 15L);
    curl_easy_setopt(handle.get(), CURLOPT_TIMEOUT, 180L);
    curl_easy_setopt(handle.get(), CURLOPT_LOW_SPEED_LIMIT, 1024L);
    curl_easy_setopt(handle.get(), CURLOPT_LOW_SPEED_TIME, 20L);
    curl_easy_setopt(handle.get(), CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(handle.get(), CURLOPT_ERRORBUFFER, error);
    curl_easy_setopt(handle.get(), CURLOPT_WRITEFUNCTION, receive);
    curl_easy_setopt(handle.get(), CURLOPT_WRITEDATA, &r);
    curl_easy_setopt(handle.get(), CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(handle.get(), CURLOPT_XFERINFOFUNCTION, transfer);
    curl_easy_setopt(handle.get(), CURLOPT_XFERINFODATA, cancel);
    const auto result = curl_easy_perform(handle.get());
    long status = 0;
    curl_easy_getinfo(handle.get(), CURLINFO_RESPONSE_CODE, &status);
    if (result != CURLE_OK || status != 200)
        throw std::runtime_error("Download " + route + ": " +
            (error[0] ? std::string(error) : "HTTP " + std::to_string(status)));
    return std::move(r.bytes);
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
    const auto temp = path.string() + ".part";
    std::ofstream stream(temp, std::ios::binary | std::ios::trunc);
    stream.write(reinterpret_cast<const char *>(bytes.data()), std::streamsize(bytes.size()));
    stream.close();
    if (!stream) throw std::runtime_error("Could not save " + path.string());
    // Windows cannot rename over an existing cache entry. Retain the old bytes
    // until replacement succeeds, including when a corrupted cached object is repaired.
    const auto backup=path.string()+".previous";
    std::error_code ec;
    if(std::filesystem::exists(path)){std::filesystem::remove(backup,ec);std::filesystem::rename(path,backup);}
    try{std::filesystem::rename(temp,path);}
    catch(...){if(std::filesystem::exists(backup))std::filesystem::rename(backup,path);throw;}
    std::filesystem::remove(backup,ec);
}
std::filesystem::path asset(const std::filesystem::path &cache, const std::string &sha,
                            const std::string &route, size_t max_size, const std::atomic_bool *cancel) {
    if (!hash_id(sha)) throw std::runtime_error("Invalid hosted content hash");
    const auto file = cache / "objects" / sha;
    if (std::filesystem::is_regular_file(file) && std::filesystem::file_size(file) <= max_size) {
        std::ifstream stream(file, std::ios::binary);
        Bytes bytes((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
        if (hash(bytes) == sha) return file;
    }
    const auto bytes = get(route, max_size, cancel);
    if (hash(bytes) != sha) throw std::runtime_error("Content checksum mismatch: " + route);
    save(file, bytes);
    return file;
}
}
bool valid_map_id(const std::string &id) {
    return !id.empty() && id.size() <= 160 && id != "." && id != ".." &&
        id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-.") == std::string::npos;
}
bool safe_content_path(const std::string &path) {
    if (path.empty() || path.size() > 1024 || path[0] == '/' ||
        path.find_first_of("\\:\0", 0, 3) != std::string::npos) return false;
    for (const auto &part : std::filesystem::path(path))
        if (part == "." || part == ".." || part.empty()) return false;
    return true;
}
DownloadedMap download_map(const std::string &id, const std::filesystem::path &cache,
                           const std::function<void(const std::string &)> &progress,
                           const std::atomic_bool *cancel, const DownloadLimits &limits) {
    if (!valid_map_id(id)) throw std::runtime_error("Invalid map name");
    progress("Reading " + id);
    auto detail_bytes = get("/api/maps/" + id, 4 * MiB, cancel);
    auto detail = nlohmann::json::parse(detail_bytes);
    const auto sha = detail.at("sha256").get<std::string>();
    if (!hash_id(sha)) throw std::runtime_error("Invalid map checksum");
    progress("Downloading " + id);
    const auto bsp_object = asset(cache, sha, "/api/bsp/" + sha + ".bsp", limits.bsp, cancel);
    const auto directory = cache / "maps" / sha;
    std::filesystem::create_directories(directory);
    const auto bsp = directory / (id + ".bsp");
    std::filesystem::copy_file(bsp_object, bsp, std::filesystem::copy_options::overwrite_existing);
    save(directory / "detail.json", detail_bytes);
    progress("Reading map content");
    auto manifest_bytes = get("/content-manifests/" + sha + ".json", 16 * MiB, cancel);
    auto manifest = nlohmann::json::parse(manifest_bytes);
    if (manifest.at("mapSha256") != sha) throw std::runtime_error("Content manifest belongs to another map");
    auto files = manifest.value("files", nlohmann::json::object());
    const auto physics = manifest.value("physics", nlohmann::json::object()).value("files", nlohmann::json::object());
    if (!files.is_object() || !physics.is_object() || files.size() + physics.size() > 40'000)
        throw std::runtime_error("Invalid map content manifest");
    for (auto &[path, info] : physics.items()) files[path] = info;
    const auto content = directory / "content";
    std::filesystem::create_directories(content);
    size_t count = 0, total = 0;
    for (const auto &[path, info] : files.items()) {
        if (cancel && cancel->load()) throw std::runtime_error("Map download cancelled");
        if (!safe_content_path(path)) throw std::runtime_error("Unsafe content path");
        const auto size = info.at("size").get<size_t>();
        if (size > limits.content_file || size > limits.content_total - total) throw std::runtime_error("Map content is too large");
        total += size;
        const auto file_sha = info.at("sha256").get<std::string>();
        progress("Map content " + std::to_string(++count) + "/" + std::to_string(files.size()));
        const auto object = asset(cache, file_sha, "/content/" + file_sha, size, cancel);
        if (std::filesystem::file_size(object) != size) throw std::runtime_error("Content size mismatch");
        const auto destination = content / path;
        std::filesystem::create_directories(destination.parent_path());
        std::filesystem::copy_file(object, destination, std::filesystem::copy_options::overwrite_existing);
    }
    save(directory / "manifest.json", manifest_bytes);
    progress("Loading native renderer");
    return {id, bsp, content, std::move(detail)};
}
}
