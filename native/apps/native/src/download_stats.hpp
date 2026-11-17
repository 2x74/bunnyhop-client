#pragma once
#include <nlohmann/json.hpp>
#include <curl/curl.h>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>

namespace native {

struct DownloadSample {
    uint64_t bytes = 0, decoded_bytes = 0;
    double seconds = 0, first_byte_seconds = 0;
    long connections = 0, protocol = 0;
};

// Content workers share one summary. Request seconds are summed; elapsed seconds measure the player's wait.
class DownloadStats {
public:
    using Clock = std::chrono::steady_clock;

    void request(const DownloadSample &sample) {
        std::lock_guard lock(mutex_);
        bytes_ += sample.bytes;
        decoded_bytes_ += sample.decoded_bytes;
        request_seconds_ += sample.seconds;
        first_byte_seconds_ += sample.first_byte_seconds;
        connections_ += sample.connections;
        ++requests_;
        http1_ |= sample.protocol == CURL_HTTP_VERSION_1_0 || sample.protocol == CURL_HTTP_VERSION_1_1;
        http2_ |= sample.protocol == CURL_HTTP_VERSION_2_0;
        http3_ |= sample.protocol == CURL_HTTP_VERSION_3;
    }

    void cached() {
        std::lock_guard lock(mutex_);
        ++cached_;
    }

    void missing() {
        std::lock_guard lock(mutex_);
        ++missing_;
    }

    void retried() {
        std::lock_guard lock(mutex_);
        ++retries_;
    }

    nlohmann::json summary(const std::string &map, bool complete, size_t workers) const {
        std::lock_guard lock(mutex_);
        const double seconds = std::chrono::duration<double>(Clock::now() - started_).count();
        std::string protocol;
        if (http1_) protocol += "HTTP/1.1 ";
        if (http2_) protocol += "HTTP/2 ";
        if (http3_) protocol += "HTTP/3 ";
        if (!protocol.empty()) protocol.pop_back();
        return {{"map", map},
                {"bytes", bytes_},
                {"decodedBytes", decoded_bytes_},
                {"seconds", seconds},
                {"bytesPerSecond", seconds > 0 ? bytes_ / seconds : 0},
                {"requestSeconds", request_seconds_},
                {"firstByteSeconds", first_byte_seconds_},
                {"requests", requests_},
                {"connections", connections_},
                {"contentWorkers", workers},
                {"retries", retries_},
                {"protocol", protocol.empty() ? "none" : protocol},
                {"cache", missing_ ? (cached_ ? "mixed" : "miss") : (cached_ ? "hit" : "none")},
                {"verifiedFiles", cached_},
                {"missingObjects", missing_},
                {"complete", complete}};
    }

private:
    Clock::time_point started_ = Clock::now();
    mutable std::mutex mutex_;
    uint64_t bytes_ = 0, decoded_bytes_ = 0;
    size_t requests_ = 0, cached_ = 0, missing_ = 0, retries_ = 0;
    long connections_ = 0;
    double request_seconds_ = 0, first_byte_seconds_ = 0;
    bool http1_ = false, http2_ = false, http3_ = false;
};

}  // namespace native
