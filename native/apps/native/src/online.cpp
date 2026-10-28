#include "atomic_replace.hpp"
#include "data_location.hpp"
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

struct Response { Bytes bytes; size_t limit; bool oversized=false; };
size_t receive(char *data, size_t size, size_t count, void *opaque) noexcept {
    auto &r = *static_cast<Response *>(opaque);
    if (size && count > SIZE_MAX / size) {r.oversized=true;return 0;}
    const auto length = size * count;
    if (length > r.limit - r.bytes.size()) {r.oversized=true;return 0;}
    try { r.bytes.insert(r.bytes.end(), data, data + length); }
    catch (...) { return 0; }
    return length;
}
struct Transfer {const std::atomic_bool *cancel;LoadProgressCallback progress;};
int transfer(void *context,curl_off_t total,curl_off_t received,curl_off_t,curl_off_t) noexcept {
    auto &t=*static_cast<Transfer*>(context);if(t.cancel&&t.cancel->load())return 1;
    try{if(t.progress)t.progress({"download","Downloading map data",uint64_t(std::max<curl_off_t>(0,received)),uint64_t(std::max<curl_off_t>(0,total))});}catch(...){return 1;}return 0;
}
Bytes get(const std::string &route, size_t limit, const std::atomic_bool *cancel,const LoadProgressCallback &progress={}) {
    if(cancel&&cancel->load())throw std::runtime_error("Map download cancelled");
    Transfer transfer_state{cancel,progress};
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
    curl_easy_setopt(handle.get(), CURLOPT_XFERINFODATA, &transfer_state);
    const auto result = curl_easy_perform(handle.get());
    long status = 0;
    curl_easy_getinfo(handle.get(), CURLINFO_RESPONSE_CODE, &status);
    if(cancel&&cancel->load())throw std::runtime_error("Map download cancelled");
    if(r.oversized)throw std::runtime_error("Hosted map data exceeds size budget");
    if(status>=500&&status<=599)throw DownloadNetworkError("Map server temporarily unavailable (HTTP "+std::to_string(status)+")");
    if(result!=CURLE_OK&&result!=CURLE_HTTP_RETURNED_ERROR)throw DownloadNetworkError("Network unavailable: "+std::string(error[0]?error:curl_easy_strerror(result)));
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
    atomic_write_file(path, std::string_view(reinterpret_cast<const char *>(bytes.data()), bytes.size()));
}
std::filesystem::path asset(const std::filesystem::path &cache, const std::string &sha,
                            const std::string &route, size_t max_size, const std::atomic_bool *cancel,const LoadProgressCallback &progress={},bool offline=false,const DownloadFetch &fetch={}) {
    if(cancel&&cancel->load())throw std::runtime_error("Map download cancelled");
    if (!hash_id(sha)) throw std::runtime_error("Invalid hosted content hash");
    const auto file = cache / "objects" / sha;
    if (std::filesystem::is_regular_file(file) && std::filesystem::file_size(file) <= max_size) {
        std::ifstream stream(file, std::ios::binary);
        Bytes bytes((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
        if (hash(bytes) == sha) {if(progress)progress({"cache","Using verified downloaded content",bytes.size(),bytes.size(),0,0,true,offline});return file;}
    }
    if(offline)throw std::runtime_error("Cached map data is missing or corrupt; reconnect and retry");
    const auto bytes = fetch?fetch(route,max_size,cancel,progress):get(route,max_size,cancel,progress);
    if(bytes.size()>max_size)throw std::runtime_error("Downloaded content exceeds size budget");
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
    for (const auto &part : data_location::from_utf8(path))
        if (part == "." || part == ".." || part.empty()) return false;
    return true;
}
DownloadedMap download_map(const std::string &id, const std::filesystem::path &cache,
                           const std::function<void(const std::string &)> &progress,
                           const std::atomic_bool *cancel, const DownloadLimits &limits,const LoadProgressCallback &detail_progress,const DownloadFetch &fetch) {
    if (!valid_map_id(id)) throw std::runtime_error("Invalid map name");
    progress("Reading " + id);
    auto request=[&](const std::string &route,size_t limit,const LoadProgressCallback &cb=LoadProgressCallback{}){auto bytes=fetch?fetch(route,limit,cancel,cb):get(route,limit,cancel,cb);if(bytes.size()>limit)throw std::runtime_error("Metadata exceeds size budget");return bytes;};
    bool offline=false;
    auto emit=[&](LoadProgress value){value.offline=offline;if(detail_progress)detail_progress(value);};
    auto read=[&](const std::filesystem::path &path,size_t limit){if(!std::filesystem::is_regular_file(path)||std::filesystem::file_size(path)>limit)throw std::runtime_error("Cached metadata unavailable");std::ifstream file(path,std::ios::binary);return Bytes(std::istreambuf_iterator<char>(file),{});};
    const auto index=cache/"index"/(id+".json");Bytes detail_bytes;
    auto offline_detail=[&](){
        try{return read(index,4*MiB);}catch(...){}
        // Migrate completed downloads made before the per-map index existed.
        Bytes newest;std::filesystem::file_time_type date=(std::filesystem::file_time_type::min)();
        const auto maps=cache/"maps";if(std::filesystem::is_directory(maps))for(const auto &entry:std::filesystem::directory_iterator(maps)){
            if(cancel&&cancel->load())throw std::runtime_error("Map download cancelled");
            if(!entry.is_directory()||!hash_id(entry.path().filename().string())||!std::filesystem::is_regular_file(entry.path()/(id+".bsp"))||!std::filesystem::is_regular_file(entry.path()/"manifest.json"))continue;
            try{auto bytes=read(entry.path()/"detail.json",4*MiB);const auto detail=nlohmann::json::parse(bytes);if(detail.at("sha256")!=entry.path().filename().string())continue;const auto modified=std::filesystem::last_write_time(entry.path()/"detail.json");if(newest.empty()||modified>date){date=modified;newest=std::move(bytes);}}catch(...){}
        }
        if(newest.empty())throw std::runtime_error("Map is not downloaded; connect to download it first");return newest;
    };
    emit({"metadata","Checking latest map version"});
    try{detail_bytes=request("/api/maps/"+id,4*MiB);}
    catch(const DownloadNetworkError&){if(cancel&&cancel->load())throw;detail_bytes=offline_detail();offline=true;emit({"metadata","Using previously downloaded map (offline)",0,0,0,0,true,true});}
    auto detail = nlohmann::json::parse(detail_bytes);
    const auto sha = detail.at("sha256").get<std::string>();
    if (!hash_id(sha)) throw std::runtime_error("Invalid map checksum");
    progress("Downloading " + id);
    const auto bsp_object = asset(cache, sha, "/api/bsp/" + sha + ".bsp", limits.bsp, cancel,emit,offline,fetch);
    const auto directory = cache / "maps" / sha;
    std::filesystem::create_directories(directory);
    const auto bsp = directory / (id + ".bsp");
    std::filesystem::copy_file(bsp_object, bsp, std::filesystem::copy_options::overwrite_existing);
    save(directory / "detail.json", detail_bytes);
    progress("Reading map content");
    Bytes manifest_bytes;
    try{manifest_bytes=read(directory/"manifest.json",16*MiB);auto cached=nlohmann::json::parse(manifest_bytes);if(cached.at("mapSha256")!=sha)throw std::runtime_error("Stale manifest");}
    catch(...){if(offline)throw std::runtime_error("Offline map content is incomplete; reconnect and retry");manifest_bytes=request("/content-manifests/"+sha+".json",16*MiB,emit);}
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
        emit({"content","Checking map content",0,size,count,files.size()});
        const auto object = asset(cache, file_sha, "/content/" + file_sha, size, cancel,emit,offline,fetch);
        if (std::filesystem::file_size(object) != size) throw std::runtime_error("Content size mismatch");
        const auto destination = content / data_location::from_utf8(path);
        std::filesystem::create_directories(destination.parent_path());
        std::filesystem::copy_file(object, destination, std::filesystem::copy_options::overwrite_existing);
    }
    save(directory / "manifest.json", manifest_bytes);
    save(index,detail_bytes);
    emit({"renderer",offline?"Loading cached map into renderer":"Loading native renderer",0,0,files.size(),files.size(),offline,offline});
    progress("Loading native renderer");
    return {id, bsp, content, std::move(detail)};
}
// Optional Valve sound content stays in the verified object cache, outside the
// application package. Only this manifest group is eligible for download.
void download_classic_sounds(const std::filesystem::path &content_root,const std::filesystem::path &cache,const DownloadFetch &fetch){
    const auto path=content_root.parent_path()/"manifest.json";
    if(!std::filesystem::is_regular_file(path)||std::filesystem::file_size(path)>16*MiB)return;
    std::ifstream f(path);nlohmann::json manifest;f>>manifest;
    const auto group=manifest.value("optional",nlohmann::json::object()).value("sounds",nlohmann::json::object());
    const auto files=group.value("files",nlohmann::json::object());if(!files.is_object()||files.size()>128)throw std::runtime_error("Invalid optional sound manifest");
    size_t total=0;
    for(const auto &[name,info]:files.items()){
        if(!safe_content_path(name)||!name.starts_with("sound/")||!name.ends_with(".wav"))throw std::runtime_error("Unsafe optional sound path");
        const size_t size=info.at("size");if(size>4*MiB||size>32*MiB-total)throw std::runtime_error("Optional sound content is too large");total+=size;
        const std::string sha=info.at("sha256");const auto object=asset(cache,sha,"/content/"+sha,size,nullptr,{},false,fetch);
        if(std::filesystem::file_size(object)!=size)throw std::runtime_error("Optional sound size mismatch");
        const auto dest=cache/"classic"/name;std::filesystem::create_directories(dest.parent_path());std::filesystem::copy_file(object,dest,std::filesystem::copy_options::overwrite_existing);
    }
}

}
