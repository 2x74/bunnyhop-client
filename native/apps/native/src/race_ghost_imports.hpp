#pragma once
#include "ghost_slots.hpp"
#include "ghost_route_events.hpp"
#include "latest_worker.hpp"
#include "atomic_replace.hpp"
#include "data_location.hpp"

namespace native {
// Replay decoding and simulation use a private context. Installing its immutable path does not touch the live run.
class RaceGhostImports {
    struct Result {
        GhostSlot slot;
        native_render::GhostPath path;
        std::string error;
        uint32_t track = 0;
        std::string style;
        bool replace = false;
    };

    std::array<LatestWorker<Result>, GhostSlots::slot_count> workers_;
    uint64_t generation_ = 0;

public:
    uint64_t generation() const { return generation_; }

    void reset() {
        ++generation_;
        for (auto &worker : workers_)
            worker.cancel();
    }

    void cancel(unsigned slot) { workers_.at(slot).cancel(); }

    bool
    accepts(const nlohmann::json &message,
            const GhostSlots &ghosts,
            const std::string &map,
            const std::string &style,
            uint32_t track) const {
        const unsigned slot = message.at("ghostSlot").get<unsigned>();
        const auto source = message.at("source").get<std::string>();
        if (slot >= ghosts.slots.size() || (source != "pb" && source != "wr") || message.at("generation") != generation_
            || message.at("map") != map || message.at("style") != style || message.at("track") != track)
            return false;
        const auto &previous = ghosts.slots[slot];
        return !previous.loaded()
               || (native_render::ghost_source(source) == ghosts.sources[slot]
                   && (previous.info.value("track", 0u) != track
                       || previous.info.value("style", std::string()) != style));
    }

    template <class Decode>
    void
    request(const nlohmann::json &message,
            const std::string &map,
            const std::string &content,
            const std::filesystem::path &directory,
            Decode decode) {
        const unsigned slot = message.at("ghostSlot").get<unsigned>();
        const auto source = message.at("source").get<std::string>();
        if (source != "pb" && source != "wr" && source != "custom")
            throw std::runtime_error("Invalid race ghost source");
        workers_.at(slot).submit([message, map, content, directory, decode, source](const std::atomic_bool &cancelled) {
            Result result;
            result.replace = message.value("replace", false);
            result.track = message.at("track").get<uint32_t>();
            result.style = message.at("style").get<std::string>();
            try {
                auto path = directory / data_location::from_utf8(message.value("id", std::string()));
                if (message.contains("replayBase64")) {
                    const auto bytes = decode(message.at("replayBase64").get<std::string>());
                    char digest[65]{};
                    if (!bh_sha256(bytes.data(), bytes.size(), digest))
                        throw std::runtime_error("Cannot hash race ghost");
                    path = directory / "ghost-cache" / (std::string(digest) + ".bhr");
                    std::filesystem::create_directories(path.parent_path());
                    atomic_write_file(
                            path, std::string_view(reinterpret_cast<const char *>(bytes.data()), bytes.size())
                    );
                } else if (!message.contains("id") || path.filename() != data_location::from_utf8(message.at("id"))) {
                    throw std::runtime_error("Invalid local race ghost");
                }
                std::unique_ptr<BhContext, decltype(&bh_destroy)> owned_core(bh_create(), bh_destroy);
                auto *core = owned_core.get();
                if (!core
                    || !bh_load_map_cancellable(
                            core,
                            map.c_str(),
                            content.empty() ? nullptr : content.c_str(),
                            replay_cancelled,
                            const_cast<std::atomic_bool *>(&cancelled)
                    ))
                    throw std::runtime_error(core ? bh_last_error(core) : "No race ghost context");
                result.slot.handle = bh_ghost_load_cancellable(
                        core,
                        data_location::utf8(path).c_str(),
                        replay_cancelled,
                        const_cast<std::atomic_bool *>(&cancelled)
                );
                if (!result.slot.handle) throw std::runtime_error(bh_last_error(core));
                size_t count = 0;
                const auto *raw = bh_ghost_info(core, result.slot.handle, &count);
                if (!raw) throw std::runtime_error(bh_last_error(core));
                result.slot.info = nlohmann::json::parse(raw, raw + count);
                if (result.slot.info.value("track", 0u) != result.track
                    || result.slot.info.value("style", std::string()) != result.style)
                    throw std::runtime_error("Race ghost does not match this track and style");
                result.slot.id = data_location::utf8(path.filename());
                result.slot.enabled = true;
                result.path.load(core, result.slot.handle, result.slot.info, native_render::ghost_source(source));
                native_render::load_route_events(result.path, core, data_location::utf8(path), &cancelled);
                auto recording = std::make_shared<GhostRecording>();
                recording->commands.resize(result.path.frames.size());
                recording->events.resize(result.path.frames.size());
                for (uint32_t tick = 0; tick < result.path.frames.size() && !cancelled; ++tick) {
                    if (!bh_ghost_command(core, result.slot.handle, tick, &recording->commands[tick]))
                        throw std::runtime_error(bh_last_error(core));
                    bh_ghost_events(core, result.slot.handle, tick ? tick - 1 : 0, tick, &recording->events[tick]);
                }
                result.slot.recording = std::move(recording);
                result.slot.handle = 0;
            } catch (const std::exception &error) {
                result.error = error.what();
            }
            return result;
        });
    }

    template <class Renderer, class Chat>
    bool
    poll(GhostSlots &ghosts,
         BhContext *live,
         Renderer *renderer,
         uint32_t track,
         const std::string &style,
         Chat &chat,
         double seconds) {
        bool primary_changed = false;
        for (unsigned slot = 0; slot < workers_.size(); ++slot) {
            auto ready = workers_[slot].take();
            if (!ready || !renderer || ready->track != track || ready->style != style
                || (ghosts.slots[slot].loaded() && !ready->replace))
                continue;
            if (!ready->error.empty()) {
                chat.push("Ghost: " + ready->error, "", "error", seconds);
                continue;
            }
            const auto &previous = ghosts.slots[slot];
            if (previous.handle) bh_ghost_free(live, previous.handle);
            ghosts.sources[slot] = ready->path.source;
            ghosts.slots[slot] = std::move(ready->slot);
            ghosts.cursors[slot].reset();
            renderer->set_ghost_path(slot, std::move(ready->path));
            if (slot == 0) {
                ghosts.select_primary();
                primary_changed = true;
            }
        }
        return primary_changed;
    }
};
}  // namespace native
