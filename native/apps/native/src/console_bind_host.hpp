#pragma once
#include "console_bind_queue.hpp"
#include "menu_webview.hpp"
#include "recoverable_action.hpp"

namespace native {
template <class Action>
inline void
dispatch_console_pulses(ConsoleBindQueue &queue, MenuWebView *menu, Action &act, Renderer *renderer, BhContext *core) {
    for (const auto &pulse : queue.take_pulses()) {
        if (!pulse.command.empty()) {
            if (menu)
                menu->evaluate_js(
                        "window.dispatchEvent(new CustomEvent('bunnyhop:native-console-command',{detail:"
                        + nlohmann::json(pulse.command).dump() + "}))"
                );
        } else if (pulse.action == "inspect") {
            if (pulse.down) act(pulse.action, false, true);
            if (renderer) renderer->inspect_held(pulse.down);
            if (core) bh_record_inspect(core, pulse.down ? 3 : 4);
        } else if (pulse.down) {
            act(pulse.action, false, true);
        }
    }
}
}  // namespace native
