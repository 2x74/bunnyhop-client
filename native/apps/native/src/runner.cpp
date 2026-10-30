#include "bunnyhop_native.h"
#include <bit>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>

// A deliberately small stdin protocol for the WASM/native differential harness.
// Floats are decimal round-trip representations; output is exact IEEE-754 bits.
// No network, rendering, timers or caller-reported finish times are involved.
namespace {
void check(BhContext *ctx, int result) {
    if (!result) throw std::runtime_error(bh_last_error(ctx));
}

void emit_model(BhContext *ctx, uint32_t model) {
    BhTransform transform{};
    check(ctx, bh_model_transform(ctx, model, &transform));
    std::cout << "{\"model\":" << model << ",\"bits\":[";
    for (size_t i = 0; i < 6; ++i) {
        if (i) std::cout << ',';
        const float value = i < 3 ? transform.origin[i] : transform.angles[i - 3];
        std::cout << std::bit_cast<uint32_t>(value);
    }
    std::cout << "],\"visible\":" << transform.visible << "}\n";
}

void emit(BhContext *ctx) {
    BhState s{};
    check(ctx, bh_state(ctx, &s));
    const float floats[] = {
            s.position[0],
            s.position[1],
            s.position[2],
            s.velocity[0],
            s.velocity[1],
            s.velocity[2],
            s.view_offset_z,
            s.teleport_angles[0],
            s.teleport_angles[1],
            s.teleport_angles[2],
            s.angle_change[0],
            s.angle_change[1],
            s.angle_change[2],
            s.touch_position[0],
            s.touch_position[1],
            s.touch_position[2],
    };
    std::cout << "{\"tick\":" << s.tick << ",\"bits\":[";
    for (size_t i = 0; i < std::size(floats); ++i) {
        if (i) std::cout << ',';
        std::cout << std::bit_cast<uint32_t>(floats[i]);
    }
    std::cout << "],\"flags\":[" << s.grounded << ',' << s.crouched << ',' << s.on_ladder << ',' << s.events << ','
              << s.touch_crouched << "]}\n";
}

template <class... T>
void fields(std::istringstream &in, T &...values) {
    if (!(in >> ... >> values)) throw std::runtime_error("invalid or missing protocol field");
    in >> std::ws;
    if (!in.eof()) throw std::runtime_error("unexpected trailing protocol data");
}
}  // namespace

int main(int argc, char **argv) {
    try {
        std::string map, commands, content;
        for (int i = 1; i < argc; ++i) {
            const std::string arg = argv[i];
            if (arg == "--help") {
                std::cout << "bunnyhop-native-runner --map MAP.bsp [--commands FILE] [--content-root DIR]\n"
                          << "Protocol: settings dt air accel friction stop gravity speed autohop physics stamina;\n"
                          << "reset; position x y z yaw; velocity x y z; names \"target\" \"class\";\n"
                          << "cmd forward side yaw pitch buttons; state; model N (one JSON line per result).\n";
                return 0;
            }
            if ((arg == "--map" || arg == "--commands" || arg == "--content-root") && i + 1 < argc) {
                auto &value = arg == "--map" ? map : arg == "--commands" ? commands : content;
                value = argv[++i];
            } else
                throw std::runtime_error("unknown or incomplete argument: " + arg);
        }
        if (map.empty()) throw std::runtime_error("--map is required");
        std::unique_ptr<BhContext, decltype(&bh_destroy)> ctx(bh_create(), bh_destroy);
        if (!ctx) throw std::runtime_error("could not create native core");
        if (bh_abi_version() != 1) throw std::runtime_error("unsupported native ABI");
        if (!bh_v29_check_abi(BH_V29_ABI_VERSION, sizeof(BhRecordOptionsV29), sizeof(BhTimingSegmentV2))) {
            throw std::runtime_error("Unsupported native v29 ABI layout");
        }
        check(ctx.get(), bh_load_map(ctx.get(), map.c_str(), content.empty() ? nullptr : content.c_str()));
        std::ifstream file;
        if (!commands.empty()) {
            file.open(commands);
            if (!file) throw std::runtime_error("cannot open commands: " + commands);
        }
        std::istream &input = commands.empty() ? std::cin : file;
        std::string line;
        size_t line_number = 0;
        while (std::getline(input, line)) {
            ++line_number;
            try {
                std::istringstream in(line);
                std::string op;
                if (!(in >> op) || op.starts_with('#')) continue;
                if (op == "settings") {
                    BhSettings s{};
                    fields(in,
                           s.tick_interval,
                           s.air_accelerate,
                           s.accelerate,
                           s.friction,
                           s.stop_speed,
                           s.gravity,
                           s.max_speed,
                           s.autohop,
                           s.physics,
                           s.stamina);
                    check(ctx.get(), bh_set_settings(ctx.get(), &s));
                } else if (op == "reset") {
                    fields(in);
                    check(ctx.get(), bh_reset(ctx.get()));
                } else if (op == "state") {
                    fields(in);
                    emit(ctx.get());
                } else if (op == "model") {
                    uint32_t model;
                    fields(in, model);
                    emit_model(ctx.get(), model);
                } else if (op == "position") {
                    float x, y, z, yaw;
                    fields(in, x, y, z, yaw);
                    check(ctx.get(), bh_set_position(ctx.get(), x, y, z, yaw));
                } else if (op == "velocity") {
                    float x, y, z;
                    fields(in, x, y, z);
                    check(ctx.get(), bh_set_velocity(ctx.get(), x, y, z));
                } else if (op == "names") {
                    std::string target, name;
                    if (!(in >> std::quoted(target) >> std::quoted(name)))
                        throw std::runtime_error("expected two quoted names");
                    fields(in);
                    check(ctx.get(), bh_set_restart_names(ctx.get(), target.c_str(), name.c_str()));
                } else if (op == "cmd") {
                    BhCmd cmd{};
                    fields(in, cmd.forward, cmd.side, cmd.yaw, cmd.pitch, cmd.buttons);
                    BhState state{};
                    check(ctx.get(), bh_step(ctx.get(), &cmd, &state));
                } else
                    throw std::runtime_error("unknown operation: " + op);
            } catch (const std::exception &e) {
                throw std::runtime_error("line " + std::to_string(line_number) + ": " + e.what());
            }
        }
        if (input.bad()) throw std::runtime_error("could not read command stream");
        return 0;
    } catch (const std::exception &e) {
        std::cerr << "native runner: " << e.what() << '\n';
        return 1;
    }
}
