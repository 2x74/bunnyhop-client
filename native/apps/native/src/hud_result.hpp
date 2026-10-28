#pragma once
#include "hud_scoreboard.hpp"
#include <array>
#include <optional>

namespace native {
enum class ResultStamp { pending, finished, personal_best, world_record, rejected };
struct ResultReward {
    HudLabel<96> title;
    HudLabel<128> detail;
};
class HudResult {
  public:
    uint64_t generation = ~uint64_t(0);
    ResultStamp stamp = ResultStamp::finished;
    double started = -100;
    double seconds = 0;
    std::optional<double> delta;
    std::array<ResultReward, 12> rewards;
    size_t reward_count = 0;

    void reset() {
        started = -100;
    }
    void finish(uint64_t attempt, double time, double now, std::optional<double> pb, bool pending) {
        if (generation == attempt && started > -100)
            return;
        generation = attempt;
        started = now;
        seconds = time;
        delta = pb ? std::optional<double>((std::round(time * 1000) - std::round(*pb * 1000)) / 1000) : std::nullopt;
        stamp = pending ? ResultStamp::pending : ResultStamp::finished;
        reward_count = 0;
    }
    bool visible(double now) const {
        return now >= started && now - started < 14;
    }
    void service(const nlohmann::json &message, uint64_t attempt) {
        if (generation != attempt || message.value("generation", ~uint64_t(0)) != attempt)
            return;
        const auto status = json_text(message, "status");
        if (status == "rejected" || status == "error")
            stamp = ResultStamp::rejected;
        else if (status == "kept")
            stamp = ResultStamp::finished;
        else if (status == "verified") {
            const auto event = json_text(message, "announcer");
            stamp = event == "wr"                                 ? ResultStamp::world_record
                    : (event == "pb" || json_flag(message, "pb")) ? ResultStamp::personal_best
                                                                  : ResultStamp::finished;
        }
        const auto incoming = message.find("rewards");
        if (incoming == message.end() || !incoming->is_array())
            return;
        reward_count = 0;
        for (const auto &reward : *incoming) {
            if (reward_count == rewards.size())
                break;
            if (!reward.is_object())
                continue;
            auto &stored = rewards[reward_count++];
            stored.title.assign(json_text(reward, "title", 95));
            stored.detail.assign(json_text(reward, "detail", 127));
        }
    }
};

inline std::string_view result_stamp_text(ResultStamp stamp) {
    switch (stamp) {
    case ResultStamp::pending:
        return "Checking run";
    case ResultStamp::personal_best:
        return "NEW PB";
    case ResultStamp::world_record:
        return "WORLD RECORD";
    case ResultStamp::rejected:
        return "Run not ranked";
    case ResultStamp::finished:
        return "FINISHED";
    }
    return "";
}

template <class Hud>
void draw_result(Hud &hud, int width, int height, float percent, const HudResult &result, double now) {
    if (!result.visible(now))
        return;
    const HudGeometry geometry(width, height, percent);
    const float age = float(now - result.started);
    const float flight = std::clamp(age / .45f, 0.f, 1.f);
    const float y = geometry.height * (.44f - .23f * (1 - std::pow(1 - flight, 3)));
    const float x = geometry.width / 2;
    constexpr NameColor cream = {.94f, .91f, .86f, 1};
    NameColor gold = {1, .77f, .32f, 1};
    if (result.stamp == ResultStamp::pending)
        gold[3] = .65f + .25f * std::sin(age * 3);
    hud.overlay_begin(width, height, percent);
    hud.overlay_rect(x - 215, y - 18, 430, result.reward_count ? 208 : 155, {.025f, .027f, .04f, .92f});
    HudLabel<48> time;
    // Roll only during the first 300 ms, then hold the exact server/core time.
    format_hud_time(time, age < .3f ? result.seconds * std::min(1.f, age / .3f) : result.seconds);
    hud.overlay_text(x, y, time.view(), 38, cream, true);
    hud.overlay_text(x, y + 53, result_stamp_text(result.stamp), 18, gold, true);
    if (result.delta) {
        time.format("%+.3fs vs PB", *result.delta);
        hud.overlay_text(x, y + 82, time.view(), 14, *result.delta < 0 ? NameColor{.47f, .9f, .47f, 1} : gold, true);
    }
    hud.overlay_text(x, y + 112, "R to go again", 13, {.64f, .66f, .70f, 1}, true);
    if (result.reward_count && age >= .6f) {
        const size_t index = std::min(result.reward_count - 1, size_t((age - .6f) / 2.4f));
        hud.overlay_rect(x - 198, y + 140, 396, 1, {.28f, .24f, .15f, 1});
        hud.overlay_text(x, y + 150, result.rewards[index].title.view(), 15, gold, true);
        hud.overlay_text(x, y + 176, result.rewards[index].detail.view(), 12, cream, true);
    }
    const bool celebrate = result.stamp == ResultStamp::personal_best || result.stamp == ResultStamp::world_record;
    if (celebrate && age < 3) {
        for (unsigned i = 0; i < 32; ++i) {
            const float phase = float(i) * 2.399963f;
            const float radius = 30 + age * (32 + i % 5 * 9);
            const float particle_x = x + std::cos(phase) * radius;
            const float particle_y = y + 35 + std::sin(phase) * radius + age * age * 22;
            hud.overlay_rect(particle_x, particle_y, 3, 5, i % 2 ? gold : cream);
        }
    }
    hud.overlay_end(width, height);
}
} // namespace native
