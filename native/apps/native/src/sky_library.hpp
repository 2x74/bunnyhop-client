#pragma once
// The Sky picker's skies (web sky-packs/sources.ts, folder.ts) for the native client: the website's seven built-in
// skies, fetched once when picked into <data>/sky-cache, and the player's skies folder <data>/skies, where Add from a
// link and Import file put what they get and any .hdr, PNG, JPEG or .bhsky.json dropped there shows up. Every download,
// directory scan and decode runs on a worker; the frame loop only takes finished panoramas.
//
//   SkyLibrary skies(data_folder);
//   skies.select(id);                 when the picked sky changes ("" for none)
//   skies.frame(menu_visible);        each frame: takes finished work, rescans the folder now and then
//   renderer.use_sky(skies.current_id(), skies.current());
#include "latest_worker.hpp"
#include "nlohmann/json.hpp"
#include "sky_image.hpp"
#include <array>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace native {

struct CuratedSky {
    std::string_view id, name;
    float megabytes;
    // Hosted: our own .bhsky.json. Otherwise a Poly Haven HDRI by its asset name.
    bool hosted;
    std::string_view asset;
    SkyClouds clouds;
};

inline constexpr std::array<CuratedSky, 7> curated_skies{{
        {"clear-day", "Clear day", 6.2f, true, "", SkyClouds::clear},
        {"cloudy-day", "Cloudy day", 7.3f, true, "", SkyClouds::photographic},
        {"sunset", "Sunset", 5.5f, true, "", SkyClouds::clear},
        {"overcast_soil_puresky", "Overcast", 4.6f, false, "overcast_soil_puresky", SkyClouds::photographic},
        {"belfast_sunset_puresky", "Golden hour", 4.6f, false, "belfast_sunset_puresky", SkyClouds::photographic},
        {"qwantani_dusk_2_puresky", "Dusk", 4.6f, false, "qwantani_dusk_2_puresky", SkyClouds::clear},
        {"kloppenheim_02_puresky", "Starry night", 5.6f, false, "kloppenheim_02_puresky", SkyClouds::clear},
}};

const CuratedSky *find_curated_sky(std::string_view id);

// What a pasted link points at (web sources.ts parseSkyLink).
struct SkyLink {
    enum class Kind { polyhaven, hdr, image, pack } kind = Kind::pack;
    std::string url, asset;
};

std::optional<SkyLink> parse_sky_link(std::string_view raw);

// Where the client fetches a sky from: our own files straight from the site, anything else through bunnyhop.lol's
// sky proxy (/api/css-asset?kind=sky), so the sky's host never sees the player (web sky-packs/store.ts).
std::string sky_fetch_url(std::string_view address);

struct LoadedSky {
    std::string id;
    std::optional<SkyPicture> picture;
    std::string error;
};

class SkyLibrary {
public:
    struct FolderSky {
        std::string id, name, file;
        SkyFileKind kind = SkyFileKind::unsupported;
        std::string error;
    };

    struct Progress {
        std::atomic<uint64_t> received{0}, total{0};
    };

    explicit SkyLibrary(std::filesystem::path data_folder);

    // The sky to draw: a built-in id, a folder sky id, or "" for none.
    void select(const std::string &id);

    const std::string &selected() const { return selected_; }

    void frame(bool menu_visible);

    // The last panorama that loaded, and its id ("" and null before any).
    const std::string &current_id() const { return loaded_; }

    const SkyPicture *current() const { return current_.get(); }

    // {type:"sky", action:"link"|"import"|"remove"|"openFolder"|"cancel", url?, id?}. Errors land in the state.
    void message(const nlohmann::json &message);

    // For the menu's Sky picker: every built-in and folder sky, and what's happening now.
    nlohmann::json state() const;

    const std::filesystem::path &folder() const { return folder_; }

private:
    struct JobResult {
        std::string error, added_id;
        std::optional<std::vector<FolderSky>> listing;
    };

    std::filesystem::path folder_, cache_;
    std::string selected_, loaded_, loading_name_;
    std::map<std::string, std::string> failed_;
    std::vector<FolderSky> listing_;
    std::shared_ptr<const SkyPicture> current_;
    std::vector<std::string> cached_builtins_;
    LatestWorker<LoadedSky> loader_;
    LatestWorker<JobResult> jobs_;
    std::shared_ptr<Progress> load_progress_ = std::make_shared<Progress>(),
                              job_progress_ = std::make_shared<Progress>();
    bool loading_ = false, job_running_ = false, listed_ = false;
    std::string job_label_, status_error_, added_id_;
    std::chrono::steady_clock::time_point next_scan_{};

    void start_load(const std::string &id);
    void start_job(std::string label, std::function<JobResult(const std::atomic_bool &)> work);
    void collect_job();
    void collect_load();
    void scan_now();
    void import_dialog();
    std::string status_text() const;
};

// The folder's sky files (at most 24), listed by name, each with why it can't be used if it can't.
std::vector<SkyLibrary::FolderSky> list_sky_folder(const std::filesystem::path &folder);

}  // namespace native
