#include "options.hpp"
#include "settings.hpp"
#include "online.hpp"
#include <cmath>
#include <sstream>
#include <stdexcept>

namespace native {

Options options(int argc, char **argv) {
    Options out;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto value = [&]() -> std::string {
            if (++i >= argc) throw std::runtime_error("Missing value for " + arg);
            return argv[i];
        };
        if (arg == "--room-smoke") {
            out.room_smoke = value();
            out.hidden = true;
            out.no_menu = true;
        } else if (arg == "--presentation-smoke") {
            out.presentation_smoke = value();
            out.hidden = true;
            out.no_menu = true;
        } else if (arg == "--video-smoke") {
            out.video_smoke = value();
            out.hidden = true;
            out.no_menu = true;
        } else if (arg == "--runtime-smoke") {
            out.runtime_smoke = value();
            out.hidden = true;
            out.no_menu = true;
        } else if (arg == "--tutorial")
            out.tutorial_lesson = value();
        else if (arg == "--tutorial-demo")
            out.tutorial_demo = true;
        else if (arg == "--style")
            out.style = value();
        else if (arg == "--replay")
            out.replay = value();
        else if (arg == "--map")
            out.map = value();
        else if (arg == "--online-map")
            out.online_map = value();
        else if (arg == "--menu-html")
            out.menu_html = value();
        else if (arg == "--menu-smoke")
            out.menu_smoke = value();
        else if (arg == "--menu-home-smoke") {
            out.menu_smoke = value();
            out.menu_home_smoke = true;
        } else if (arg == "--no-menu")
            out.no_menu = true;
        else if (arg == "--windowed")
            out.windowed = true;
        else if (arg == "--legacy-input")
            out.legacy_input = true;
        else if (arg == "--content-root")
            out.content_root = value();
        else if (arg == "--screenshot")
            out.screenshot = value();
        else if (arg == "--camera") {
            std::array<float, 5> view{};
            std::stringstream parts(value());
            std::string part;
            size_t n = 0;
            while (std::getline(parts, part, ',')) {
                if (n == 5) throw std::runtime_error("--camera takes x,y,z,pitch,yaw");
                size_t used = 0;
                view[n] = std::stof(part, &used);
                if (used != part.size() || !std::isfinite(view[n]))
                    throw std::runtime_error("--camera takes x,y,z,pitch,yaw");
                n++;
            }
            if (n != 5) throw std::runtime_error("--camera takes x,y,z,pitch,yaw");
            out.camera = view;
        } else if (arg == "--sensitivity") {
            out.sensitivity_set = true;
            const auto s = value();
            size_t n = 0;
            out.sensitivity = std::stod(s, &n);
            if (n != s.size() || !std::isfinite(out.sensitivity) || out.sensitivity <= 0)
                throw std::runtime_error("--sensitivity must be a positive finite number");
        } else if (arg == "--frames") {
            const auto s = value();
            size_t n = 0;
            if (s.empty() || s[0] == '-') throw std::runtime_error("--frames must be positive");
            out.frames = std::stoull(s, &n);
            if (n != s.size() || out.frames == 0) throw std::runtime_error("--frames must be positive");
        } else if (arg == "--hidden")
            out.hidden = true;
        else if (arg == "--help" || arg == "-h")
            out.help = true;
        else
            throw std::runtime_error("Unknown argument: " + arg);
    }
    if (!out.runtime_smoke.empty() && (out.map.empty() || !out.online_map.empty() || out.replay.empty()))
        throw std::runtime_error("Runtime smoke requires a local --map and --replay");
    if (!out.tutorial_lesson.empty() && out.tutorial_lesson != "jump" && out.tutorial_lesson != "strafe"
        && out.tutorial_lesson != "speed" && out.tutorial_lesson != "final")
        throw std::runtime_error("Unknown tutorial lesson");
    if (!native::styles.contains(out.style)) throw std::runtime_error("Unknown movement style");
    if (!out.screenshot.empty() && !out.frames) out.frames = 1;
    if (!out.map.empty() && !out.online_map.empty()) throw std::runtime_error("Choose --map or --online-map");
    if (!out.online_map.empty() && !native::valid_map_id(out.online_map))
        throw std::runtime_error("Invalid online map name");
    if (out.map.empty() && out.online_map.empty() && (out.no_menu || out.frames) && !out.help)
        throw std::runtime_error("This mode needs --map or --online-map");
    if (out.menu_home_smoke
        && (!out.map.empty() || !out.online_map.empty() || out.frames || out.no_menu || !out.replay.empty()
            || !out.tutorial_lesson.empty()))
        throw std::runtime_error("Home menu smoke must start without a map or gameplay mode");
    return out;
}

void print_help(std::ostream &output) {
    output << "Usage: bunnyhop-native [--map MAP.bsp | --online-map NAME] [--content-root DIR] "
              "[--sensitivity 2]\n"
              "  [--menu-html PATH] [--no-menu] [--windowed] [--legacy-input] [--frames N] [--screenshot "
              "output.ppm] [--camera x,y,z,pitch,yaw] [--hidden]\n"
              "  [--runtime-smoke OUTPUT_DIR --replay PATH] (offline lifecycle checks with --map; private "
              "data, no network)\n"
              "  [--room-smoke DIR] (with --map: replays DIR/room.jsonl, saves the frames in DIR/shots.json)\n"
              "  [--tutorial jump|strafe|speed|final] [--tutorial-demo] (tutorial map only)\n"
              "  [--menu-smoke OUTPUT_PREFIX] (with --online-map; live API reads only, no scores)\n"
              "  [--menu-home-smoke OUTPUT_PREFIX] (home menu over the real map tour backdrop; no gameplay "
              "or scores)\n"
              "No map: open the map browser. WASD move, Space/wheel jump, Ctrl crouch, E use, R restart, "
              "Esc menu, F10 Settings, Alt+Enter fullscreen.\n"
              "Frame-limited mode simulates one fixed tick per rendered frame; screenshot implies --frames "
              "1.\n";
}
}  // namespace native
