#pragma once
#include "input_binds.hpp"
#include <array>
#include <deque>
#include <stdexcept>
#include <span>

namespace native {
// Web expands aliases once at key-down/up. This queue applies their typed holds after the exact command boundary,
// even when one native frame runs several ticks and the menu cannot answer between them.
class ConsoleBindQueue {
public:
    struct Pulse {
        std::string action, command;
        bool down = false;
    };

private:
    struct Operation {
        std::string kind, code, action, command;
        bool own = true;
    };

    struct Hold {
        std::string code, action;
        bool active = false;
    };

    std::array<Hold, 256> holds;
    size_t hold_count = 0;
    std::deque<std::vector<Operation>> later;
    std::array<Pulse, 512> pulses;
    size_t pulse_count = 0;
    uint32_t held_bits = 0;

    void emit(std::string_view action, std::string_view command, bool down) {
        if (pulse_count == pulses.size()) return;
        auto &pulse = pulses[pulse_count++];
        pulse.action.assign(action);
        pulse.command.assign(command);
        pulse.down = down;
    }

    void apply(const Operation &op) {
        if (op.kind == "press") {
            emit(op.action, {}, true);
            return;
        }
        if (op.kind == "once") {
            emit({}, op.command, true);
            return;
        }
        const bool was_held = active(op.action);
        for (size_t i = 0; i < hold_count; i++) {
            auto &hold = holds[i];
            if (hold.action != op.action || (op.own && hold.code != op.code)) continue;
            if (op.kind == "hold") {
                if (hold.code == op.code) hold.active = true;
            } else
                hold.active = false;
        }
        const bool is_held = active(op.action);
        if (was_held != is_held && !movement_bit(op.action)) emit(op.action, {}, is_held);
        held_bits = 0;
        for (size_t i = 0; i < hold_count; i++)
            if (holds[i].active) held_bits |= movement_bit(holds[i].action);
    }

    bool active(const std::string &action) const {
        for (size_t i = 0; i < hold_count; i++)
            if (holds[i].active && holds[i].action == action) return true;
        return false;
    }

public:
    ConsoleBindQueue() {
        for (auto &pulse : pulses) {
            pulse.action.reserve(64);
            pulse.command.reserve(4096);
        }
    }

    uint32_t bits() const { return held_bits; }

    bool waiting() const { return !later.empty(); }

    void enqueue(const nlohmann::json &message) {
        const auto &raw = message.at("ops");
        if (!raw.is_array() || raw.size() > 256) throw std::runtime_error("Invalid command chain");
        std::vector<std::pair<unsigned, Operation>> validated;
        validated.reserve(raw.size());
        for (const auto &item : raw) {
            const unsigned step = item.at("step");
            Operation op{
                    item.at("kind"),
                    item.at("code"),
                    item.value("action", std::string()),
                    item.value("command", std::string()),
                    item.value("own", true)
            };
            if (step > 256 || op.code.size() > 64 || op.action.size() > 64 || op.command.size() > 4096
                || (op.kind != "hold" && op.kind != "unhold" && op.kind != "once" && op.kind != "press"))
                throw std::runtime_error("Invalid command chain operation");
            validated.emplace_back(step, std::move(op));
        }
        for (const auto &[step, op] : validated) {
            if (op.kind != "hold") continue;
            bool known = false;
            for (size_t i = 0; i < hold_count; i++)
                known |= holds[i].code == op.code && holds[i].action == op.action;
            if (!known) {
                if (hold_count == holds.size()) throw std::runtime_error("Too many held command actions");
                holds[hold_count++] = {op.code, op.action, false};
            }
        }
        for (auto &[step, op] : validated) {
            if (!step)
                apply(op);
            else {
                if (later.size() < step) later.resize(step);
                if (later[step - 1].size() >= 256) throw std::runtime_error("Too many waiting commands");
                later[step - 1].push_back(std::move(op));
            }
        }
    }

    void advance() {
        if (later.empty()) return;
        for (const auto &op : later.front())
            apply(op);
        later.pop_front();
    }

    std::span<const Pulse> take_pulses() {
        const auto count = pulse_count;
        pulse_count = 0;
        return {pulses.data(), count};
    }

    void release_all() {
        for (size_t i = 0; i < hold_count; i++) {
            const auto &hold = holds[i];
            if (hold.active && !movement_bit(hold.action)) emit(hold.action, {}, false);
        }
        hold_count = 0;
        later.clear();
        held_bits = 0;
    }
};
}  // namespace native
