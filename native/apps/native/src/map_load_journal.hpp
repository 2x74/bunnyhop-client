#pragma once
#include "native_log.hpp"
#include "online.hpp"
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <string>
#include <string_view>

namespace native {

// A map load as a few readable lines in the log, never one per byte or per frame, and the last map state for the crash
// note. MapDownload owns it and serializes the calls.
class MapLoadJournal {
public:
    void requested(const std::string &id) {
        id_ = id;
        stage_.clear();
        started_ = Clock::now();
        bsp_cached_ = offline_ = false;
        files_total_ = files_cached_ = 0;
        line("requested");
        state("loading " + id_);
    }

    void refused(const std::string &id, std::string_view reason) const {
        std::cerr << "Map load " << id << ": refused, " << reason << '\n';
    }

    void progress(const LoadProgress &value) {
        if (value.stage != stage_) {
            stage_ = value.stage;
            state("loading " + id_ + ", stage " + stage_);
            // The renderer stage is announced by preparing(), and a content message names just its first file.
            if (stage_ == "content")
                line("content: " + std::to_string(value.filesTotal) + " files");
            else if (stage_ != "renderer")
                line(stage_ + ": " + value.message);
        }
        if (value.offline && !offline_) {
            offline_ = true;
            line("offline, using the last downloaded version");
        }
        files_total_ = std::max(files_total_, value.filesTotal);
        if (!value.cached) return;
        if (stage_ == "bsp") bsp_cached_ = true;
        if (stage_ == "content") ++files_cached_;
    }

    void files_ready() const {
        line("files ready after " + elapsed() + " (BSP " + (bsp_cached_ ? "from the cache" : "downloaded") + ", "
             + std::to_string(files_cached_) + " of " + std::to_string(files_total_)
             + " content files from the cache)");
    }

    void stalled(std::chrono::steady_clock::duration limit) const {
        const auto seconds = std::chrono::duration_cast<std::chrono::seconds>(limit).count();
        line("timed out: no progress for " + std::to_string(seconds) + " s at stage " + stage_);
    }

    void preparing() {
        line("preparing map, models and renderer");
        state("preparing " + id_);
    }

    void loaded() {
        line("loaded after " + elapsed());
        state(id_ + " is up");
    }

    void failed(const std::string &error) {
        line("failed after " + elapsed() + ": " + error);
        state("load of " + id_ + " failed");
    }

    void cancelled() {
        line("cancelled after " + elapsed());
        state("load of " + id_ + " cancelled");
    }

    void left_map() const { state("no map"); }

private:
    using Clock = std::chrono::steady_clock;

    void line(std::string_view text) const { std::cerr << "Map load " << id_ << ": " << text << '\n'; }

    static void state(std::string_view text) { log::set_crash_context(text); }

    std::string elapsed() const {
        const double seconds = std::chrono::duration<double>(Clock::now() - started_).count();
        char text[32];
        std::snprintf(text, sizeof(text), "%.1f s", seconds);
        return text;
    }

    std::string id_, stage_;
    Clock::time_point started_;
    bool bsp_cached_ = false, offline_ = false;
    size_t files_total_ = 0, files_cached_ = 0;
};

}  // namespace native
