// Native Release W on jump against golden vectors from the web's WRelease (native/tools/w-release/generate-vectors.ts).
#include "input_timeline.hpp"
#include "native_input.hpp"
#include <cstdio>
#include <fstream>
#include <nlohmann/json.hpp>

namespace {
constexpr int place_air = 1;
constexpr int place_ladder = 2;

bool replay_scenario(const nlohmann::json &scenario) {
    const bool autohop = scenario.at("autohop");
    const auto &resets = scenario.at("resets");
    size_t next_reset = 0;
    native::WRelease rule;
    size_t index = 0;
    for (const auto &command : scenario.at("commands")) {
        while (next_reset < resets.size() && resets[next_reset].get<size_t>() == index) {
            rule.reset();
            ++next_reset;
        }
        const uint32_t buttons = command[0];
        const int place = command[1];
        const uint32_t expected = command[2];
        const native::WReleaseContext context{
                place != place_air && place != place_ladder, place == place_ladder, autohop
        };
        const uint32_t actual = rule.apply(buttons, context);
        if (actual != expected) {
            std::fprintf(
                    stderr,
                    "%s: command %zu: buttons %u place %d gave %u, the web gave %u\n",
                    scenario.at("name").get<std::string>().c_str(),
                    index,
                    buttons,
                    place,
                    actual,
                    expected
            );
            return false;
        }
        ++index;
    }
    return true;
}

bool same_styles(const nlohmann::json &allowed) {
    for (const auto &[style, expected] : allowed.items()) {
        if (native::w_release_allowed(style) != expected.get<bool>()) {
            std::fprintf(stderr, "style %s differs from the web\n", style.c_str());
            return false;
        }
    }
    return true;
}

// The command goes out with forwardmove following the released bit, and a restart keeps the rule's memory.
bool command_follows_the_rule() {
    native::Input input;
    const native::WReleaseContext ground{true, false, true};
    input.held = native::forward | native::jump | native::left;
    const auto takeoff = input.command(ground);
    if (takeoff.forward != 0 || takeoff.buttons != (native::jump | native::left) || takeoff.side == 0) return false;
    const auto air = input.command(native::WReleaseContext{false, false, true});
    if (air.forward != 0 || (air.buttons & native::forward)) return false;
    const auto off = input.command();
    return off.forward > 0 && (off.buttons & native::forward) && !input.w_release.active();
}

// A restart keeps the physical holds and what the rule knows of them. Losing capture or opening chat forgets it, like
// the website's releaseAll.
bool barriers_match_the_website() {
    const native::WReleaseContext scroll_ground{true, false, false};
    const uint32_t held = native::forward | native::jump;
    native::Input input;
    native::InputTimeline timeline;
    std::set<std::string> held_codes;
    input.held = held;
    input.command(scroll_ground);
    timeline.restart(input, held_codes);
    input.held = held;
    if (!(input.command(scroll_ground).buttons & native::forward)) return false;
    timeline.release(input, held_codes);
    input.held = held;
    return !(input.command(scroll_ground).buttons & native::forward);
}

bool policy_matches_the_website() {
    const BhState grounded{.grounded = 1};
    if (native::w_release_context("scroll", false, false, grounded, false)) return false;
    if (!native::w_release_context("scroll", true, false, grounded, false)) return false;
    if (native::w_release_context("autohop", true, true, grounded, true)) return false;
    const auto context = native::w_release_context("autohop", false, false, grounded, true);
    return context && context->grounded && context->autohop && !context->on_ladder;
}
}  // namespace

int main(int argc, char **argv) {
    if (argc != 2) {
        std::fprintf(stderr, "usage: %s w_release_vectors.json\n", argv[0]);
        return 2;
    }
    std::ifstream file(argv[1]);
    const auto vectors = nlohmann::json::parse(file);
    if (!same_styles(vectors.at("allowed"))) return 1;
    size_t commands = 0;
    for (const auto &scenario : vectors.at("scenarios")) {
        if (!replay_scenario(scenario)) return 1;
        commands += scenario.at("commands").size();
    }
    if (!command_follows_the_rule() || !barriers_match_the_website() || !policy_matches_the_website()) {
        std::fprintf(stderr, "Input or policy differs from the website's rule\n");
        return 1;
    }
    std::printf(
            "w release parity: %zu scenarios, %zu commands match the web\n", vectors.at("scenarios").size(), commands
    );
    return 0;
}
