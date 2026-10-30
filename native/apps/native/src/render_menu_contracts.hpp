#pragma once
#include "replay_controls.hpp"
#include "native_input.hpp"
#include "replay_timeline.hpp"
#include <fstream>
#include "atomic_replace.hpp"

namespace native {
inline size_t render_menu_message_limit(const std::string &type, size_t fallback) {
    constexpr size_t replay_message_bytes = 12 * 1024 * 1024;
    return type == "replayCompare" ? replay_message_bytes : fallback;
}

inline bool surface_chat_action(std::string_view action) {
    return action == "paint" || action == "clearPaint" || action == "paintOptions" || action == "measure"
           || action == "clearMeasure";
}

template <class Renderer, class Chat>
void reply_surface_chat(
        Renderer *renderer,
        std::string_view action,
        const BhState &state,
        const Input &input,
        Chat &chat,
        double seconds,
        bool can_paint
) {
    const char *reply = "Load a map to use surface tools.";
    if (action == "paintOptions")
        reply = "Paint colour and size are in Settings > Paint.";
    else if (action == "paint" && !can_paint)
        reply = "Paint is unavailable while spectating or watching a replay.";
    else if (renderer) {
        const auto tool = action == "paint" ? "paintOnce" : action == "measure" ? "measurePoint" : action;
        reply = renderer->surface_tool(tool, state, input);
    }
    chat.push(reply, "", "info", seconds);
}

template <class Decode>
void compare_message(
        ReplayCompare &compare,
        BhContext *core,
        const std::filesystem::path &directory,
        const nlohmann::json &message,
        const nlohmann::json &playback,
        Decode decode,
        const std::atomic_bool *cancel = nullptr
) {
    if (message.at("action") == "clear") {
        compare.clear();
        return;
    }
    if (!message.contains("replayBase64")) {
        handle_replay_compare(compare, core, directory, message, playback, cancel);
        return;
    }
    if (message.at("action") != "set") throw std::runtime_error("Unknown compare action");
    const auto kind = message.value("kind", std::string("custom"));
    graphics_choice(kind, {"pb", "wr", "custom"});
    const auto bytes = decode(message.at("replayBase64").get<std::string>());
    char digest[65]{};
    if (!bh_sha256(bytes.data(), bytes.size(), digest)) throw std::runtime_error("Could not hash compare replay");
    const auto path = directory / (std::string("compare-") + digest + ".bhr");
    if (!std::filesystem::exists(path)) {
        std::filesystem::create_directories(directory);
        atomic_write_file(path, std::string_view(reinterpret_cast<const char *>(bytes.data()), bytes.size()));
    }
    compare.load(core, data_location::utf8(path), native_render::ghost_source(kind), playback, cancel);
    compare.name(message.value("name", std::string("Compare")));
}

class ReplayCompareImportService {
    struct Result {
        ReplayCompare::Prepared prepared;
        std::string id, error;
    };

    std::filesystem::path map_, content_;
    LatestWorker<Result> worker_;

public:
    void reset() { worker_.cancel(); }

    void map(const std::filesystem::path &map, const std::filesystem::path &content) {
        reset();
        map_ = map;
        content_ = content;
    }

    template <class Decode>
    void
    message(ReplayCompare &compare,
            BhContext *,
            const std::filesystem::path &directory,
            const nlohmann::json &message,
            const nlohmann::json &playback,
            const std::string &id,
            Decode decode) {
        reset();
        if (message.at("action") == "clear") {
            compare.clear();
            return;
        }
        worker_.submit([map = map_, content = content_, directory, message, playback, id, decode](
                               const std::atomic_bool &cancelled
                       ) {
            Result result;
            result.id = id;
            try {
                std::unique_ptr<BhContext, decltype(&bh_destroy)> core(bh_create(), &bh_destroy);
                if (!core
                    || !bh_load_map_cancellable(
                            core.get(),
                            data_location::utf8(map).c_str(),
                            content.empty() ? nullptr : data_location::utf8(content).c_str(),
                            replay_cancelled,
                            const_cast<std::atomic_bool *>(&cancelled)
                    ))
                    throw std::runtime_error(core ? bh_last_error(core.get()) : "No compare context");
                if (!cancelled) {
                    ReplayCompare prepared;
                    const auto cache = message.contains("replayBase64") ? directory / "compare-cache" : directory;
                    compare_message(prepared, core.get(), cache, message, playback, decode, &cancelled);
                    if (!cancelled)
                        result.prepared = prepared.detach(&cancelled);
                    else
                        prepared.clear();
                }
            } catch (const std::exception &error) {
                result.error = error.what();
            }
            return result;
        });
    }

    template <class Chat>
    void poll(ReplayCompare &compare, const std::string &id, bool playback, Chat &chat, double seconds) {
        if (!playback) {
            reset();
            return;
        }
        auto ready = worker_.take();
        if (!ready) return;
        auto result = std::move(*ready);
        if (!playback || result.id != id) return;
        if (!result.error.empty())
            chat.push("Compare: " + result.error, "", "error", seconds);
        else
            compare.adopt(std::move(result.prepared));
    }
};

inline void
render_playback_state(nlohmann::json &state, const ReplayCompare &compare, double interval, const BhState &shown) {
    state["playback"]["features"] = {"compare", "loop", "weapon", "hud", "orbit", "strafes", "exportQueue"};
    state["playback"]["compare"] = compare.menu_state(interval, shown.tick, shown.position);
}
}  // namespace native
