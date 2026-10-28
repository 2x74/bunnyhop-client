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
    return action == "paint" || action == "clearPaint" || action == "paintOptions" || action == "measure" ||
           action == "clearMeasure";
}
template <class Renderer, class Chat>
void reply_surface_chat(Renderer *renderer, std::string_view action, const BhState &state, const Input &input,
                        Chat &chat, double seconds) {
    const char *reply = "Load a map to use surface tools.";
    if (action == "paintOptions")
        reply = "Paint colour and size are in Settings > Paint.";
    else if (renderer) {
        const auto tool = action == "paint" ? "paintOnce" : action == "measure" ? "measurePoint" : action;
        reply = renderer->surface_tool(tool, state, input);
    }
    chat.push(reply, "", "info", seconds);
}
template <class Decode>
void ws3_compare_message(ReplayCompare &compare, BhContext *core, const std::filesystem::path &directory,
                         const nlohmann::json &message, const nlohmann::json &playback, Decode decode) {
    if (message.at("action") == "clear") {
        compare.clear();
        return;
    }
    if (!message.contains("replayBase64")) {
        handle_replay_compare(compare, core, directory, message, playback);
        return;
    }
    if (message.at("action") != "set")
        throw std::runtime_error("Unknown compare action");
    const auto kind = message.value("kind", std::string("custom"));
    graphics_choice(kind, {"pb", "wr", "custom"});
    const auto bytes = decode(message.at("replayBase64").get<std::string>());
    char digest[65]{};
    if (!bh_sha256(bytes.data(), bytes.size(), digest))
        throw std::runtime_error("Could not hash compare replay");
    const auto path = directory / (std::string("compare-") + digest + ".bhr");
    if (!std::filesystem::exists(path)) {
        std::filesystem::create_directories(directory);
        atomic_write_file(path, std::string_view(reinterpret_cast<const char *>(bytes.data()), bytes.size()));
    }
    compare.load(core, data_location::utf8(path), native_render::ghost_source(kind), playback);
    compare.name(message.value("name", std::string("Compare")));
}
class ReplayCompareImportService {
    struct Result {
        ReplayCompare::Prepared prepared;
        std::string id, error;
    };
    struct Job {
        std::shared_ptr<std::atomic_bool> cancel;
        std::future<Result> result;
    };
    std::filesystem::path map_, content_;
    std::optional<Job> active_;
    std::list<Job> retired_;
    void cancel() {
        if (active_) {
            *active_->cancel = true;
            retired_.push_back(std::move(*active_));
            active_.reset();
        }
    }

  public:
    void reset() {
        cancel();
    }
    ~ReplayCompareImportService() {
        cancel();
        for (auto &job : retired_)
            *job.cancel = true;
    }
    void map(const std::filesystem::path &map, const std::filesystem::path &content) {
        cancel();
        map_ = map;
        content_ = content;
    }
    template <class Decode>
    void message(ReplayCompare &compare, BhContext *core, const std::filesystem::path &directory,
                 const nlohmann::json &message, const nlohmann::json &playback, const std::string &id, Decode decode) {
        cancel();
        if (message.at("action") == "clear" || !message.contains("replayBase64")) {
            ws3_compare_message(compare, core, directory, message, playback, decode);
            return;
        }
        const auto cancelled = std::make_shared<std::atomic_bool>(false);
        active_.emplace(
            Job{cancelled, std::async(std::launch::async, [map = map_, content = content_, directory, message, playback,
                                                           id, decode, cancelled] {
                    Result result;
                    result.id = id;
                    try {
                        std::unique_ptr<BhContext, decltype(&bh_destroy)> worker(bh_create(), &bh_destroy);
                        if (!worker || !bh_load_map(worker.get(), data_location::utf8(map).c_str(),
                                                    content.empty() ? nullptr : data_location::utf8(content).c_str())) {
                            throw std::runtime_error(worker ? bh_last_error(worker.get()) : "No compare context");
                        }
                        if (!*cancelled) {
                            ReplayCompare compare;
                            ws3_compare_message(compare, worker.get(), directory / "compare-cache", message, playback,
                                                decode);
                            if (!*cancelled)
                                result.prepared = compare.detach();
                        }
                    } catch (const std::exception &error) {
                        result.error = error.what();
                    }
                    return result;
                })});
    }
    template <class Chat>
    void poll(ReplayCompare &compare, const std::string &id, bool playback, Chat &chat, double seconds) {
        using namespace std::chrono_literals;
        retired_.remove_if([](Job &job) { return job.result.wait_for(0ms) == std::future_status::ready; });
        if (!active_ || active_->result.wait_for(0ms) != std::future_status::ready)
            return;
        auto result = active_->result.get();
        active_.reset();
        if (!playback || result.id != id)
            return;
        if (!result.error.empty())
            chat.push("Compare: " + result.error, "", "error", seconds);
        else
            compare.adopt(std::move(result.prepared));
    }
};
inline void render_playback_state(nlohmann::json &state, const ReplayCompare &compare, double interval) {
    state["playback"]["features"] = {"compare"};
    state["playback"]["compare"] = compare.menu_state(interval);
}
} // namespace native
