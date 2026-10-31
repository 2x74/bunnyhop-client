#pragma once
#include <string>
#include <string_view>

namespace native::log {

// A log line made fit to post in public: no tokens, cookies, passwords, emails, Discord codes or URL query strings,
// and the player's home folder written as ~. The bytes that come out are valid UTF-8 on one line, of bounded length.
std::string scrub(std::string_view line, std::string_view home);

}  // namespace native::log
