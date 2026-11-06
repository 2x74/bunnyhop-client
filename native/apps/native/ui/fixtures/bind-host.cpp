#include "settings.hpp"
#include "input_timeline.hpp"
#include "turn_settings.hpp"
#include <memory>

// Browser tests use the host's validation, disk format and physical-key input path without a window.
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    native::Json request;
    std::cin >> request;
    auto settings = native::load_settings(argv[1]);
    if (request.contains("patch")) {
        settings = native::patch_settings(settings, request.at("patch"));
        native::save_settings(argv[1], settings);
    }
    native::Json result{{"settings", settings}};
    if (request.contains("key")) {
        const auto code = request.at("key").get<std::string>();
        if (settings.at("cmdBinds").contains(code)) {
            result["command"] = settings.at("cmdBinds").at(code);
        } else {
            auto timeline = std::make_unique<native::InputTimeline>();
            native::Input input;
            const std::set<std::string> held{code};
            timeline->rebuild_binds(settings.at("binds"));
            timeline->set_timed(false, input, held);
            uint64_t simulation = 0;
            timeline->take_tick(input, simulation, 10'000'000, false);
            native::TurnSettings::from_settings(settings).apply(input, timeline->held(held), .01, true);
            const auto command = input.command();
            result["side"] = command.side;
            result["yaw"] = command.yaw;
        }
    }
    std::cout << result.dump() << '\n';
}
