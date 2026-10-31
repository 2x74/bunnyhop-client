#include "menu_messages.hpp"
#include <iostream>
#include <stdexcept>

namespace {
void check(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}

void check_message_sources() {
    // Every address the menu document can reach through history.replaceState or pushState.
    for (const auto *source :
         {L"https://bunnyhop.lol/__native_menu__/index.html",
          L"https://bunnyhop.lol/",
          L"https://bunnyhop.lol/ranks?page=2",
          L"https://bunnyhop.lol/gauntlets",
          L"https://bunnyhop.lol/g/weekly?attempt=abc"})
        check(native::menu_message_source_trusted(source), "the menu stopped being heard after its address moved");
    for (const auto *source :
         {L"",
          L"https://bunnyhop.lol",
          L"https://bunnyhop.lol.evil.test/",
          L"https://bunnyhop.lol@evil.test/",
          L"https://bunnyhop.lol:8443/",
          L"http://bunnyhop.lol/",
          L"https://evil.test/https://bunnyhop.lol/"})
        check(!native::menu_message_source_trusted(source), "a message from another site was trusted");
}
}  // namespace

int main() {
    try {
        check_message_sources();
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
