#pragma once
#include <curl/curl.h>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <string_view>

namespace native {
inline constexpr unsigned download_attempts = 3;

inline bool transient_download_error(CURLcode error, long status) {
    if (status == 408 || status == 429 || (status >= 500 && status <= 599)) return true;
    if (status >= 400) return false;
    return error == CURLE_COULDNT_RESOLVE_HOST || error == CURLE_COULDNT_CONNECT || error == CURLE_OPERATION_TIMEDOUT
           || error == CURLE_PARTIAL_FILE || error == CURLE_RECV_ERROR || error == CURLE_SEND_ERROR
           || error == CURLE_HTTP2 || error == CURLE_HTTP2_STREAM;
}

inline std::chrono::milliseconds download_retry_delay(unsigned attempt) {
    return std::chrono::milliseconds(250 * (1u << attempt));
}

// A resumed body can be appended only when the server names exactly the requested offset and a bounded total.
inline bool valid_download_range(std::string_view value, size_t offset, size_t length, size_t limit) {
    if (!value.starts_with("bytes ")) return false;
    value.remove_prefix(6);
    size_t first = 0, last = 0, total = 0;
    const char *end = value.data() + value.size();
    auto a = std::from_chars(value.data(), end, first);
    if (a.ec != std::errc() || a.ptr == end || *a.ptr != '-') return false;
    auto b = std::from_chars(a.ptr + 1, end, last);
    if (b.ec != std::errc() || b.ptr == end || *b.ptr != '/') return false;
    auto c = std::from_chars(b.ptr + 1, end, total);
    return c.ec == std::errc() && c.ptr == end && first == offset && first <= last && last < total && total <= limit
           && last + 1 == total && length <= total - first;
}

// Prefixes live only during this download. No partial file ever enters the verified disk cache.
struct DownloadPrefix {
    size_t size = 0;

    bool accept(long status, std::string_view range, size_t length, size_t limit, bool identity) const {
        if (!size) return status == 200;
        return status == 206 && identity && valid_download_range(range, size, length, limit);
    }
};
}  // namespace native
