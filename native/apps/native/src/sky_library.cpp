#include "sky_library.hpp"
#include "atomic_replace.hpp"
#include "data_location.hpp"
#include "online.hpp"
#include <SDL3/SDL.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <regex>

namespace native {
namespace {

constexpr auto scan_interval = std::chrono::seconds(2);
constexpr size_t folder_limit = 24;
constexpr double bytes_per_megabyte = 1048576;
const std::string site_origin = "https://bunnyhop.lol";

std::string lower(std::string_view text) {
    std::string out(text);
    std::transform(out.begin(), out.end(), out.begin(), [](unsigned char c) { return char(std::tolower(c)); });
    return out;
}

std::string url_encode(std::string_view text) {
    std::string out;
    for (const unsigned char c : text) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            out += char(c);
        } else {
            char escaped[4]{};
            std::snprintf(escaped, sizeof(escaped), "%%%02X", c);
            out += escaped;
        }
    }
    return out;
}

std::vector<uint8_t> read_file(const std::filesystem::path &path, size_t limit) {
    std::error_code ec;
    const auto size = std::filesystem::file_size(path, ec);
    if (ec) throw std::runtime_error("That sky file can't be read.");
    if (size > limit) throw std::runtime_error("That sky file is too big.");
    std::ifstream file(path, std::ios::binary);
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    if (!file.good() && !file.eof()) throw std::runtime_error("That sky file can't be read.");
    return bytes;
}

void write_file(const std::filesystem::path &path, const std::vector<uint8_t> &bytes) {
    std::filesystem::create_directories(path.parent_path());
    atomic_write_file(path, std::string_view(reinterpret_cast<const char *>(bytes.data()), bytes.size()));
}

size_t kind_limit(SkyFileKind kind) {
    return kind == SkyFileKind::pack ? sky_pack_max_bytes : sky_picture_max_bytes;
}

LoadProgressCallback progress_into(const std::shared_ptr<SkyLibrary::Progress> &progress) {
    progress->received = 0;
    progress->total = 0;
    return [progress](const LoadProgress &p) {
        progress->received = p.received;
        progress->total = p.total;
    };
}

// A file name for a downloaded link: its own name when it has a usable one.
std::string link_file_name(const SkyLink &link) {
    if (link.kind == SkyLink::Kind::polyhaven) return link.asset + ".hdr";
    auto path = link.url.substr(0, link.url.find_first_of("?#"));
    auto name = path.substr(path.find_last_of('/') + 1);
    name = std::regex_replace(name, std::regex("%20"), " ");
    name = std::regex_replace(name, std::regex("[^A-Za-z0-9 ._-]"), "");
    if (name.empty() || name.front() == '.') name = "sky" + name;
    if (link.kind == SkyLink::Kind::pack && sky_file_kind(name) != SkyFileKind::pack) name += ".bhsky.json";
    return name.substr(0, 120);
}

std::string polyhaven_hdr(std::string_view asset) {
    return "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/" + std::string(asset) + "_2k.hdr";
}

std::string network_message(const std::exception &e) {
    if (dynamic_cast<const DownloadNetworkError *>(&e)) return "Couldn't reach the sky's host.";
    const std::string text = e.what();
    if (text.find("size budget") != std::string::npos) return "That sky file is too big.";
    if (text.find("cancelled") != std::string::npos) return "Cancelled.";
    return "The sky download failed.";
}

// A built-in sky, from the cache or fetched into it.
std::filesystem::path builtin_file(
        const CuratedSky &sky,
        const std::filesystem::path &cache,
        const std::atomic_bool &cancelled,
        const LoadProgressCallback &progress
) {
    const auto file = cache / (std::string(sky.id) + (sky.hosted ? ".bhsky.json" : ".hdr"));
    std::error_code ec;
    if (std::filesystem::exists(file, ec)) return file;
    const auto url = sky.hosted ? site_origin + "/sky-packs/" + std::string(sky.id) + ".bhsky.json"
                                : sky_fetch_url(polyhaven_hdr(sky.asset));
    const auto bytes = fetch_https(url, sky.hosted ? sky_pack_max_bytes : sky_picture_max_bytes, &cancelled, progress);
    write_file(file, bytes);
    return file;
}

LoadedSky load_file(const std::string &id, const std::filesystem::path &file, SkyClouds clouds) {
    const auto kind = sky_file_kind(file.filename().string());
    try {
        const auto bytes = read_file(file, kind_limit(kind));
        auto decoded = decode_sky(bytes, kind, clouds);
        return {id, std::move(decoded.picture), std::move(decoded.error)};
    } catch (const std::exception &e) {
        return {id, std::nullopt, e.what()};
    }
}

struct DialogAnswer {
    std::mutex mutex;
    bool open = false;
    std::optional<std::filesystem::path> chosen;
};

DialogAnswer &dialog_answer() {
    static DialogAnswer answer;
    return answer;
}

// Called by SDL from any thread: nothing may throw out of it.
void dialog_answered(void *, const char *const *files, int) {
    auto &answer = dialog_answer();
    std::lock_guard lock(answer.mutex);
    answer.open = false;
    try {
        if (files && files[0]) answer.chosen = data_location::from_utf8(files[0]);
    } catch (...) {
        answer.chosen.reset();
    }
}

}  // namespace

const CuratedSky *find_curated_sky(std::string_view id) {
    for (const auto &sky : curated_skies)
        if (sky.id == id) return &sky;
    return nullptr;
}

std::optional<SkyLink> parse_sky_link(std::string_view raw) {
    static const std::regex url_pattern(R"(^\s*https://([^/?#\s]+)(/[^?#\s]*)?([?#]\S*)?\s*$)", std::regex::icase);
    std::cmatch match;
    if (!std::regex_match(raw.begin(), raw.end(), match, url_pattern)) return std::nullopt;
    const auto host = lower(match[1].str());
    const auto path = match[2].str();
    std::string url(raw);
    url.erase(0, url.find_first_not_of(" \t\r\n"));
    url.erase(url.find_last_not_of(" \t\r\n") + 1);
    std::smatch part;
    if (host == "polyhaven.com" || host == "www.polyhaven.com") {
        static const std::regex page("^/a/([a-z0-9_]{1,63})/?$");
        if (!std::regex_match(path, part, page)) return std::nullopt;
        return SkyLink{SkyLink::Kind::polyhaven, url, part[1].str()};
    }
    static const std::regex file(R"(/HDRIs/[a-z]+/\d+k/([a-z0-9_]{1,63})_\d+k\.[a-z]+$)");
    if (host == "dl.polyhaven.org" && std::regex_search(path, part, file))
        return SkyLink{SkyLink::Kind::polyhaven, url, part[1].str()};
    const auto kind = sky_file_kind(path);
    if (kind == SkyFileKind::hdr) return SkyLink{SkyLink::Kind::hdr, url, {}};
    if (kind == SkyFileKind::image) return SkyLink{SkyLink::Kind::image, url, {}};
    return SkyLink{SkyLink::Kind::pack, url, {}};
}

std::string sky_fetch_url(std::string_view address) {
    if (address.starts_with(site_origin + "/")) return std::string(address);
    return site_origin + "/api/css-asset?kind=sky&u=" + url_encode(address);
}

std::vector<SkyLibrary::FolderSky> list_sky_folder(const std::filesystem::path &folder) {
    std::vector<SkyLibrary::FolderSky> skies;
    std::error_code ec;
    for (const auto &entry : std::filesystem::directory_iterator(folder, ec)) {
        if (!entry.is_regular_file(ec)) continue;
        const auto name = entry.path().filename().string();
        const auto kind = sky_file_kind(name);
        if (kind == SkyFileKind::unsupported || name.starts_with(".")) continue;
        SkyLibrary::FolderSky sky{folder_sky_id(name), sky_display_name(name), name, kind, {}};
        if (entry.file_size(ec) > kind_limit(kind))
            sky.error = "Over " + std::to_string(kind_limit(kind) / size_t(bytes_per_megabyte)) + " MB.";
        else if (lower(name).ends_with(".webp"))
            sky.error = "WebP doesn't load here. Use PNG or JPEG.";
        skies.push_back(std::move(sky));
    }
    std::sort(skies.begin(), skies.end(), [](const auto &a, const auto &b) { return lower(a.name) < lower(b.name); });
    if (skies.size() > folder_limit) skies.resize(folder_limit);
    return skies;
}

SkyLibrary::SkyLibrary(std::filesystem::path data_folder)
    : folder_(data_folder / "skies")
    , cache_(data_folder / "sky-cache") {
}

void SkyLibrary::select(const std::string &id) {
    if (id == selected_) return;
    selected_ = id;
    loader_.cancel();
    loading_ = false;
    if (!id.empty() && id != loaded_) start_load(id);
}

void SkyLibrary::start_load(const std::string &id) {
    const auto *curated = find_curated_sky(id);
    const auto entry = std::find_if(listing_.begin(), listing_.end(), [&](const auto &s) { return s.id == id; });
    if (!curated && entry == listing_.end() && listed_) {
        failed_[id] = "That sky isn't in your skies folder any more.";
        return;
    }
    loading_ = true;
    loading_name_ = curated ? std::string(curated->name) : entry != listing_.end() ? entry->name : "the sky";
    const auto progress = progress_into(load_progress_);
    loader_.submit([id, folder = folder_, cache = cache_, progress](const std::atomic_bool &cancelled) -> LoadedSky {
        if (const auto *sky = find_curated_sky(id)) {
            try {
                return load_file(id, builtin_file(*sky, cache, cancelled, progress), sky->clouds);
            } catch (const std::exception &e) {
                return {id, std::nullopt, network_message(e)};
            }
        }
        for (const auto &sky : list_sky_folder(folder))
            if (sky.id == id)
                return sky.error.empty() ? load_file(id, folder / sky.file, SkyClouds::photographic)
                                         : LoadedSky{id, std::nullopt, sky.error};
        return {id, std::nullopt, "That sky isn't in your skies folder any more."};
    });
}

void SkyLibrary::frame(bool menu_visible) {
    collect_job();
    collect_load();
    {
        auto &answer = dialog_answer();
        std::lock_guard lock(answer.mutex);
        if (answer.chosen) {
            const auto chosen = std::move(*answer.chosen);
            answer.chosen.reset();
            start_job("Importing the sky", [chosen, folder = folder_](const std::atomic_bool &) {
                JobResult result;
                const auto kind = sky_file_kind(chosen.filename().string());
                try {
                    if (kind == SkyFileKind::unsupported)
                        throw std::runtime_error("Skies are 2:1 panoramas (.hdr, PNG or JPEG) or .bhsky.json packs.");
                    write_file(folder / chosen.filename(), read_file(chosen, kind_limit(kind)));
                    result.added_id = folder_sky_id(chosen.filename().string());
                } catch (const std::exception &e) {
                    result.error = e.what();
                }
                result.listing = list_sky_folder(folder);
                return result;
            });
        }
    }
    const auto now = std::chrono::steady_clock::now();
    if (menu_visible && !job_running_ && now >= next_scan_) scan_now();
}

void SkyLibrary::scan_now() {
    next_scan_ = std::chrono::steady_clock::now() + scan_interval;
    jobs_.submit([folder = folder_, cache = cache_](const std::atomic_bool &) {
        JobResult result;
        result.listing = list_sky_folder(folder);
        return result;
    });
    job_running_ = true;
}

void SkyLibrary::start_job(std::string label, std::function<JobResult(const std::atomic_bool &)> work) {
    job_label_ = std::move(label);
    status_error_.clear();
    jobs_.submit(std::move(work));
    job_running_ = true;
}

void SkyLibrary::collect_job() {
    auto result = jobs_.take();
    if (!result) return;
    job_running_ = false;
    job_label_.clear();
    if (!result->error.empty()) status_error_ = result->error;
    if (!result->added_id.empty()) {
        added_id_ = result->added_id;
        failed_.erase(added_id_);
    }
    if (result->listing) {
        listing_ = std::move(*result->listing);
        listed_ = true;
        cached_builtins_.clear();
        std::error_code ec;
        for (const auto &sky : curated_skies)
            for (const auto *extension : {".bhsky.json", ".hdr"})
                if (std::filesystem::exists(cache_ / (std::string(sky.id) + extension), ec))
                    cached_builtins_.emplace_back(sky.id);
    }
}

void SkyLibrary::collect_load() {
    auto loaded = loader_.take();
    if (!loaded) return;
    loading_ = false;
    if (loaded->id != selected_) return;
    if (loaded->picture) {
        loaded_ = loaded->id;
        current_ = std::make_shared<const SkyPicture>(std::move(*loaded->picture));
        failed_.erase(loaded->id);
    } else
        failed_[loaded->id] = loaded->error;
}

void SkyLibrary::import_dialog() {
    auto &answer = dialog_answer();
    {
        std::lock_guard lock(answer.mutex);
        if (answer.open) return;
        answer.open = true;
    }
    static const SDL_DialogFileFilter filter{"Sky (.hdr, PNG, JPEG, .bhsky.json)", "hdr;png;jpg;jpeg;json"};
    SDL_ShowOpenFileDialog(&dialog_answered, nullptr, nullptr, &filter, 1, nullptr, false);
}

void SkyLibrary::message(const nlohmann::json &message) {
    const auto action = message.value("action", std::string());
    if (action == "openFolder") {
        std::error_code ec;
        std::filesystem::create_directories(folder_, ec);
        SDL_OpenURL(data_location::file_url(folder_).c_str());
    } else if (action == "import") {
        import_dialog();
    } else if (action == "cancel") {
        jobs_.cancel();
        job_running_ = false;
        job_label_.clear();
    } else if (action == "remove") {
        const auto id = message.value("id", std::string());
        start_job("Removing the sky", [id, folder = folder_, cache = cache_](const std::atomic_bool &) {
            JobResult result;
            std::error_code ec;
            for (const auto &sky : list_sky_folder(folder))
                if (sky.id == id) std::filesystem::remove(folder / sky.file, ec);
            for (const auto *extension : {".bhsky.json", ".hdr"})
                if (find_curated_sky(id)) std::filesystem::remove(cache / (id + extension), ec);
            result.listing = list_sky_folder(folder);
            return result;
        });
    } else if (action == "link") {
        const auto link = parse_sky_link(message.value("url", std::string()));
        if (!link) {
            status_error_ = "Paste an https:// link: a Poly Haven HDRI page, a .hdr or PNG/JPEG panorama, or a "
                            ".bhsky.json sky pack.";
            return;
        }
        const auto progress = progress_into(job_progress_);
        start_job("Downloading the sky", [link = *link, folder = folder_, progress](const std::atomic_bool &stop) {
            JobResult result;
            try {
                const auto url = link.kind == SkyLink::Kind::polyhaven ? polyhaven_hdr(link.asset) : link.url;
                const auto name = link_file_name(link);
                const auto bytes = fetch_https(sky_fetch_url(url), kind_limit(sky_file_kind(name)), &stop, progress);
                write_file(folder / name, bytes);
                result.added_id = folder_sky_id(name);
            } catch (const std::exception &e) {
                result.error = network_message(e);
            }
            result.listing = list_sky_folder(folder);
            return result;
        });
    } else
        throw std::runtime_error("Unknown sky action");
}

std::string SkyLibrary::status_text() const {
    const auto &progress = job_running_ ? *job_progress_ : *load_progress_;
    std::string label = job_running_ ? job_label_ : "Loading " + loading_name_;
    const uint64_t received = progress.received, total = progress.total;
    if (!received) return label + "…";
    char text[64]{};
    if (total)
        std::snprintf(
                text, sizeof(text), "… %.1f / %.1f MB", received / bytes_per_megabyte, total / bytes_per_megabyte
        );
    else
        std::snprintf(text, sizeof(text), "… %.1f MB", received / bytes_per_megabyte);
    return label + text;
}

nlohmann::json SkyLibrary::state() const {
    auto skies = nlohmann::json::array();
    for (const auto &sky : curated_skies) {
        const bool cached =
                std::find(cached_builtins_.begin(), cached_builtins_.end(), sky.id) != cached_builtins_.end();
        skies.push_back(
                {{"id", sky.id},
                 {"name", sky.name},
                 {"source", "builtin"},
                 {"downloaded", cached || loaded_ == sky.id},
                 {"mb", sky.megabytes}}
        );
    }
    for (const auto &sky : listing_) {
        const auto failed = failed_.find(sky.id);
        const auto error = !sky.error.empty() ? sky.error : failed != failed_.end() ? failed->second : "";
        skies.push_back(
                {{"id", sky.id},
                 {"name", sky.name},
                 {"source", "folder"},
                 {"error", error.empty() ? nlohmann::json(nullptr) : nlohmann::json(error)}}
        );
    }
    const auto failed = failed_.find(selected_);
    const bool busy = job_running_ && !job_label_.empty();
    std::string error = status_error_;
    if (error.empty() && failed != failed_.end()) error = failed->second;
    return {{"skies", skies},
            {"selected", selected_},
            {"loaded", loaded_ == selected_ && !selected_.empty()},
            {"busy", busy || loading_},
            {"status", busy || loading_ ? status_text() : std::string()},
            {"error", error},
            {"added", added_id_},
            {"folder", data_location::utf8(folder_)}};
}

}  // namespace native
