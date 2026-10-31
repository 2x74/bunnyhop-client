#include "menu_messages.hpp"
#include "menu_state.hpp"
#include <iostream>
#include <stdexcept>

namespace {
using Json = nlohmann::json;
const Json no_settings = Json::object(), no_replays = Json::array();

Json host_state(const std::string &loading, const std::string &error) {
    return {{"map", ""}, {"loading", loading}, {"error", error}};
}

bool says(const std::string &script, const std::string &text) {
    return script.find(text) != std::string::npos;
}

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

// A download that fails within one publish interval: the menu only ever hears about it through publish_now.
void check_fast_failure() {
    native::MenuState state;
    state.publish(host_state("", ""), true, no_settings, no_replays);
    state.publish_now({{"loading", "Preparing"}, {"error", ""}});
    const auto first = state.publish(host_state("", "Network unavailable"), true, no_settings, no_replays);
    check(says(first, "\"loading\":\"\""), "the menu was never told a failed load had stopped");
    check(says(first, "Network unavailable"), "the failure didn't reach the menu");
    // The same failure again: it still has to look like a new load that failed.
    state.publish_now({{"loading", "Preparing"}, {"error", ""}});
    const auto second = state.publish(host_state("", "Network unavailable"), true, no_settings, no_replays);
    check(says(second, "\"loading\":\"\"") && says(second, "Network unavailable"),
          "a second identical failure said nothing");
}

void check_settled_while_hidden() {
    native::MenuState state;
    state.publish(host_state("Reading bhop_a", ""), true, no_settings, no_replays);
    // The menu closed mid-load (Resume on the old map) and the load settled with nothing published.
    state.reset();
    check(state.needs_full(true), "reopening the menu didn't ask for a full snapshot");
    const auto reopened = state.publish(host_state("", ""), true, no_settings, no_replays);
    check(says(reopened, "\"loading\":\"\""), "the reopened menu was left on the finished load");
}

void check_foreign_error_text() {
    native::MenuState state;
    const std::string windows_1252 = "Acc\xe8s refus\xe9";
    const auto full = state.publish(host_state("", windows_1252), true, no_settings, no_replays);
    check(says(full, "refus"), "an error in a Windows code page didn't reach the menu");
    const auto now = state.publish_now({{"error", windows_1252}});
    check(says(now, "refus"), "an error in a Windows code page couldn't be sent at once");
}
}  // namespace

int main() {
    try {
        check_message_sources();
        check_fast_failure();
        check_settled_while_hidden();
        check_foreign_error_text();
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
