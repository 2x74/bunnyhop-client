#include "log_scrub.hpp"
#include <algorithm>
#include <array>
#include <cstdint>

namespace native::log {
namespace {
constexpr size_t max_line_bytes = 2000;
// Opaque account values are long and mix cases and digits. Hashes and build ids are lower-case hex, and stay readable.
constexpr size_t opaque_value_bytes = 24;
constexpr size_t opaque_value_with_punctuation_bytes = 32;
constexpr size_t numeric_status_digits = 4;
constexpr std::string_view removed = "<removed>";
constexpr std::string_view email_mark = "<email>";

bool is_separator(char c) {
    return c == '/' || c == '\\';
}

bool is_upper(char c) {
    return c >= 'A' && c <= 'Z';
}

bool is_lower(char c) {
    return c >= 'a' && c <= 'z';
}

bool is_alpha(char c) {
    return is_upper(c) || is_lower(c);
}

bool is_digit(char c) {
    return c >= '0' && c <= '9';
}

bool is_word(char c) {
    return is_alpha(c) || is_digit(c) || c == '_' || c == '-';
}

bool is_space(char c) {
    return c == ' ' || c == '\t';
}

char lower(char c) {
    return is_upper(c) ? char(c - 'A' + 'a') : c;
}

bool same_text(char a, char b) {
    return lower(a) == lower(b);
}

// Paths also appear with forward slashes or as doubled backslashes inside JSON, so any run of separators matches one.
size_t path_match_length(std::string_view line, size_t at, std::string_view path) {
    size_t read = at;
    for (size_t index = 0; index < path.size(); ++index) {
        if (read >= line.size()) return 0;
        if (is_separator(path[index])) {
            if (!is_separator(line[read])) return 0;
            while (read < line.size() && is_separator(line[read]))
                ++read;
        } else {
            if (!same_text(line[read], path[index])) return 0;
            ++read;
        }
    }
    return read < line.size() && is_word(line[read]) ? 0 : read - at;
}

std::string without_home(std::string_view line, std::string_view home) {
    while (!home.empty() && is_separator(home.back()))
        home.remove_suffix(1);
    std::string out;
    out.reserve(line.size());
    for (size_t at = 0; at < line.size();) {
        const size_t length = home.empty() ? 0 : path_match_length(line, at, home);
        if (length) {
            out += '~';
            at += length;
        } else
            out += line[at++];
    }
    return out;
}

bool segment_matches(std::string_view line, size_t at, std::string_view name) {
    if (at + name.size() >= line.size() || !is_separator(line[at + name.size()])) return false;
    return std::equal(name.begin(), name.end(), line.begin() + std::ptrdiff_t(at), same_text);
}

// A name ends at the next separator. When no separator follows, the path ends here and so does the name at a space.
size_t user_name_end(std::string_view line, size_t begin) {
    size_t end = begin;
    while (end < line.size() && !is_separator(line[end]) && std::string_view("\"'<>|:;,").find(line[end]) == line.npos)
        ++end;
    if (end == line.size() || !is_separator(line[end])) end = std::min(end, line.find(' ', begin));
    return end;
}

// Any other account's folder, and this one where the home variable doesn't match how the path was written.
std::string without_user_folders(std::string_view line) {
    std::string out;
    out.reserve(line.size());
    for (size_t at = 0; at < line.size();) {
        const bool starts_path = is_separator(line[at]) && (at == 0 || (!is_word(line[at - 1]) && line[at - 1] != '.'));
        const bool after_drive =
                at >= 2 && line[at - 1] == ':' && is_alpha(line[at - 2]) && (at == 2 || !is_word(line[at - 3]));
        size_t name = 0;
        if (starts_path || after_drive) {
            size_t segment = at;
            while (segment < line.size() && is_separator(line[segment]))
                ++segment;
            for (const std::string_view folder : {std::string_view("users"), std::string_view("home")})
                if (segment_matches(line, segment, folder)) name = segment + folder.size();
        }
        if (!name) {
            out += line[at++];
            continue;
        }
        while (name < line.size() && is_separator(line[name]))
            ++name;
        if (after_drive) out.resize(out.size() - 2);
        out += '~';
        at = user_name_end(line, name);
    }
    return out;
}

size_t token_end(std::string_view line, size_t at) {
    while (at < line.size() && !is_space(line[at]) && std::string_view("\"'<>()[]{}").find(line[at]) == line.npos)
        ++at;
    return at;
}

void cut_url(std::string_view token, std::string &out) {
    const size_t scheme = token.find("://");
    size_t authority = scheme == token.npos ? 0 : scheme + 3;
    const size_t path = std::min(token.find('/', authority), token.size());
    const size_t credentials = token.substr(authority, path - authority).rfind('@');
    out += token.substr(0, authority);
    if (credentials != token.npos) authority += credentials + 1;
    const size_t query = std::min(token.find('?', authority), token.find('#', authority));
    out += token.substr(authority, query == token.npos ? token.npos : query - authority);
}

// URLs and bare paths keep where they point and lose what they carry.
std::string without_url_queries(std::string_view line) {
    std::string out;
    out.reserve(line.size());
    for (size_t at = 0; at < line.size();) {
        const size_t end = token_end(line, at);
        const auto token = line.substr(at, end - at);
        if (token.find("://") != token.npos || (!token.empty() && token[0] == '/')) {
            cut_url(token, out);
        } else
            out += token;
        at = end;
        if (at < line.size()) out += line[at++];
    }
    return out;
}

std::string without_discord_codes(std::string line) {
    for (const std::string_view link : {std::string_view("discord.gg/"), std::string_view("discord.com/invite/")}) {
        for (size_t at = line.find(link); at != line.npos; at = line.find(link, at + link.size())) {
            const size_t begin = at + link.size();
            size_t end = begin;
            while (end < line.size() && is_word(line[end]))
                ++end;
            line.replace(begin, end - begin, removed);
        }
    }
    return line;
}

bool contains_any(std::string_view text, std::initializer_list<std::string_view> needles) {
    return std::any_of(needles.begin(), needles.end(), [&](std::string_view needle) {
        return text.find(needle) != text.npos;
    });
}

std::string lower_copy(std::string_view text) {
    std::string out(text);
    std::transform(out.begin(), out.end(), out.begin(), lower);
    return out;
}

bool names_code(std::string_view name) {
    const auto lowered = lower_copy(name);
    if (lowered == "code") return true;
    // "discordCode", "link_code": not "barcode" or "zipcode".
    return name.size() > 4 && lowered.ends_with("code")
           && (name[name.size() - 4] == 'C' || name[name.size() - 5] == '_' || name[name.size() - 5] == '-');
}

bool names_secret(std::string_view name) {
    return names_code(name)
           || contains_any(
                   lower_copy(name),
                   {"token",
                    "cookie",
                    "password",
                    "passwd",
                    "pwd",
                    "secret",
                    "authorization",
                    "apikey",
                    "api_key",
                    "api-key",
                    "session",
                    "credential"}
           );
}

// These headers carry several values, separated in ways the value scan can't follow.
bool whole_rest_is_secret(std::string_view name) {
    return contains_any(lower_copy(name), {"cookie", "authorization"});
}

// HTTP statuses and exit codes are what a log is for, and 0x80070005 says more than any message.
bool is_plain_status(std::string_view value) {
    if (value.starts_with("0x")) return true;
    return value.size() <= numeric_status_digits && std::all_of(value.begin(), value.end(), is_digit);
}

size_t value_end(std::string_view line, size_t at) {
    if (at < line.size() && (line[at] == '"' || line[at] == '\'')) {
        const size_t close = line.find(line[at], at + 1);
        return close == line.npos ? line.size() : close + 1;
    }
    while (at < line.size() && !is_space(line[at]) && std::string_view("&,;)]}\"'").find(line[at]) == line.npos)
        ++at;
    return at;
}

// After a name: an optional closing quote, then = or :, then the value. npos when it isn't a key and value.
size_t value_start(std::string_view line, size_t at) {
    if (at < line.size() && (line[at] == '"' || line[at] == '\'')) ++at;
    while (at < line.size() && is_space(line[at]))
        ++at;
    if (at >= line.size() || (line[at] != '=' && line[at] != ':')) return line.npos;
    ++at;
    while (at < line.size() && is_space(line[at]))
        ++at;
    return at < line.size() ? at : line.npos;
}

std::string without_secret_values(std::string_view line) {
    std::string out;
    out.reserve(line.size());
    for (size_t at = 0; at < line.size();) {
        if (!is_word(line[at])) {
            out += line[at++];
            continue;
        }
        size_t end = at;
        while (end < line.size() && is_word(line[end]))
            ++end;
        const auto name = line.substr(at, end - at);
        out += name;
        at = end;
        if (lower_copy(name) == "bearer") {
            size_t value = at;
            while (value < line.size() && is_space(line[value]))
                ++value;
            if (value > at && value < line.size()) {
                out.append(1, ' ').append(removed);
                at = value_end(line, value);
            }
            continue;
        }
        if (!names_secret(name)) continue;
        const size_t value = value_start(line, at);
        if (value == line.npos) continue;
        const size_t stop = whole_rest_is_secret(name) ? line.size() : value_end(line, value);
        if (names_code(name) && is_plain_status(line.substr(value, stop - value))) continue;
        out += line.substr(at, value - at);
        out += removed;
        at = stop;
    }
    return out;
}

bool email_local_char(char c) {
    return is_word(c) || c == '.' || c == '%' || c == '+';
}

bool email_domain_char(char c) {
    return is_alpha(c) || is_digit(c) || c == '-' || c == '.';
}

std::string without_emails(std::string line) {
    for (size_t at = line.find('@'); at != line.npos; at = line.find('@', at + 1)) {
        size_t begin = at, end = at + 1;
        while (begin > 0 && email_local_char(line[begin - 1]))
            --begin;
        while (end < line.size() && email_domain_char(line[end]))
            ++end;
        while (end > at + 1 && line[end - 1] == '.')
            --end;
        const auto domain = std::string_view(line).substr(at + 1, end - at - 1);
        if (begin == at || domain.find('.') == domain.npos) continue;
        line.replace(begin, end - begin, email_mark);
        at = begin + email_mark.size() - 1;
    }
    return line;
}

bool is_opaque_value(std::string_view text) {
    const bool has_punctuation = text.find_first_of("_-") != text.npos;
    if (text.size() < (has_punctuation ? opaque_value_with_punctuation_bytes : opaque_value_bytes)) return false;
    const auto has = [&](bool (*test)(char)) {
        return std::any_of(text.begin(), text.end(), test);
    };
    return has(is_upper) && has(is_lower) && has(is_digit);
}

std::string without_opaque_values(std::string_view line) {
    std::string out;
    out.reserve(line.size());
    for (size_t at = 0; at < line.size();) {
        if (!is_word(line[at])) {
            out += line[at++];
            continue;
        }
        size_t end = at;
        while (end < line.size() && is_word(line[end]))
            ++end;
        const auto word = line.substr(at, end - at);
        if (is_opaque_value(word))
            out += removed;
        else
            out += word;
        at = end;
    }
    return out;
}

// The bytes of the UTF-8 sequence starting here, or 0 when it isn't one.
size_t utf8_sequence_length(std::string_view text, size_t at) {
    const auto lead = uint8_t(text[at]);
    size_t length = 0;
    if (lead < 0x80)
        length = 1;
    else if (lead >= 0xc2 && lead <= 0xdf)
        length = 2;
    else if ((lead & 0xf0) == 0xe0)
        length = 3;
    else if (lead >= 0xf0 && lead <= 0xf4)
        length = 4;
    if (!length || at + length > text.size()) return 0;
    for (size_t index = 1; index < length; ++index)
        if ((uint8_t(text[at + index]) & 0xc0) != 0x80) return 0;
    return length;
}

// Localized Windows errors arrive in the system code page and JSON escapes arrive as control characters.
std::string printable(std::string_view line) {
    std::string out;
    out.reserve(line.size());
    for (size_t at = 0; at < line.size();) {
        const size_t length = utf8_sequence_length(line, at);
        if (!length) {
            out += '?';
            ++at;
        } else if (length == 1) {
            const char c = line[at++];
            out += uint8_t(c) < 0x20 || c == 0x7f ? ' ' : c;
        } else {
            out += line.substr(at, length);
            at += length;
        }
    }
    return out;
}

std::string bounded(std::string line) {
    if (line.size() <= max_line_bytes) return line;
    size_t end = max_line_bytes;
    while (end > 0 && (uint8_t(line[end]) & 0xc0) == 0x80)
        --end;
    line.resize(end);
    line += "...";
    return line;
}
}  // namespace

std::string scrub(std::string_view line, std::string_view home) {
    auto out = without_user_folders(without_home(line, home));
    out = without_url_queries(out);
    out = without_discord_codes(std::move(out));
    out = without_secret_values(out);
    out = without_emails(std::move(out));
    out = without_opaque_values(out);
    return bounded(printable(out));
}

}  // namespace native::log
