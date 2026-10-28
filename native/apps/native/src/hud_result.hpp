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
    // The submission line under the time, as on the website's result card.
    HudLabel<96> status_line;
    bool status_bad = false;
    double record_started = -100;
    HudLabel<48> restart_hint;

    void reset() { started = -100; }

    // The hint names the restart bind, as on the website. No hint when restart is unbound.
    void restart_bind(std::string_view code) {
        if (code.starts_with("Key"))
            code.remove_prefix(3);
        else if (code.starts_with("Digit"))
            code.remove_prefix(5);
        restart_hint.assign("");
        if (!code.empty()) restart_hint.format("%.*s to go again", int(code.size()), code.data());
    }

    void finish(uint64_t attempt, double time, double now, std::optional<double> pb, bool pending) {
        if (generation == attempt && started > -100) return;
        generation = attempt;
        started = now;
        seconds = time;
        delta = pb ? std::optional<double>((std::round(time * 1000) - std::round(*pb * 1000)) / 1000) : std::nullopt;
        stamp = pending ? ResultStamp::pending : ResultStamp::finished;
        reward_count = 0;
        status_line.assign(pending ? "Submitting…" : "Not submitted.");
        status_bad = false;
        record_started = -100;
    }

    bool visible(double now) const { return now >= started && now - started < 14; }

    void submission_rewards(const nlohmann::json &message) {
        reward_count = 0;
        const auto xp = message.find("xp");
        if (xp != message.end() && xp->is_number_unsigned()) {
            auto &reward = rewards[reward_count++];
            reward.title.format("+%u XP", xp->get<unsigned>());
            reward.detail.assign("Run verified");
        }
        const auto level = message.find("level");
        if (level != message.end() && level->is_object() && level->contains("level")
            && (*level)["level"].is_number_unsigned()) {
            auto &reward = rewards[reward_count++];
            reward.title.format("Level %u", (*level)["level"].get<unsigned>());
            reward.detail.assign("Progress updated");
        }
        const auto achievements = message.find("achievements");
        if (achievements != message.end() && achievements->is_array()) {
            for (const auto &achievement : *achievements) {
                if (reward_count == rewards.size()) break;
                if (!achievement.is_string()) continue;
                auto &reward = rewards[reward_count++];
                reward.title.assign("Achievement unlocked");
                reward.detail.assign(achievement.get_ref<const std::string &>());
            }
        }
    }

    void service(const nlohmann::json &message, uint64_t attempt, double now) {
        if (generation != attempt || message.value("generation", ~uint64_t(0)) != attempt) return;
        const auto status = json_text(message, "status");
        if (status == "rejected" || status == "error")
            stamp = ResultStamp::rejected;
        else if (status == "kept")
            stamp = ResultStamp::finished;
        else if (status == "verified") {
            const auto event = json_text(message, "announcer");
            const bool was_record = stamp == ResultStamp::world_record;
            stamp = event == "wr"                                 ? ResultStamp::world_record
                    : (event == "pb" || json_flag(message, "pb")) ? ResultStamp::personal_best
                                                                  : ResultStamp::finished;
            if (stamp == ResultStamp::world_record && !was_record) record_started = now;
        }
        set_status_line(status, message);
        if (status == "verified" && !message.contains("rewards")
            && (message.contains("xp") || message.contains("level") || message.contains("achievements")))
            submission_rewards(message);
        const auto incoming = message.find("rewards");
        if (incoming == message.end() || !incoming->is_array()) return;
        reward_count = 0;
        for (const auto &reward : *incoming) {
            if (reward_count == rewards.size()) break;
            if (!reward.is_object()) continue;
            auto &stored = rewards[reward_count++];
            stored.title.assign(json_text(reward, "title", 95));
            stored.detail.assign(json_text(reward, "detail", 127));
        }
    }

private:
    void set_status_line(std::string_view status, const nlohmann::json &message) {
        status_bad = status == "rejected" || status == "error";
        if (status == "checking")
            status_line.assign("Submitting…");
        else if (status == "uploading")
            status_line.assign(
                    json_flag(message, "held") ? "No connection. This run counts once it uploads." : "Verifying replay…"
            );
        else if (status == "pending")
            status_line.assign("Waiting for verification…");
        else if (status == "verified" && message.value("rank", 0u))
            status_line.format("Rank #%u", message.value("rank", 0u));
        else if (status == "verified")
            status_line.assign("Verified");
        else if (status == "rejected")
            status_line.assign("Not accepted: the replay didn't check out.");
        else if (status == "error")
            status_line.assign("Couldn't submit. Saved on this device.");
        else if (status == "kept")
            status_line.assign("Saved on this device.");
    }
};

inline std::string_view result_word(const HudResult &result) {
    if (result.stamp == ResultStamp::rejected) return "";
    if (result.stamp == ResultStamp::world_record) return "World record";
    if (!result.delta) return "First PB";
    if (result.stamp == ResultStamp::personal_best || *result.delta < 0) return "New PB";
    return "";
}

// Confetti from the time when a world record is verified, like the website's burst: an upward cone that slows in
// the air and falls. Positions are closed-form in the burst's age, so drawing never allocates.
template <class Hud>
void draw_record_burst(Hud &hud, float x, float y, float age) {
    constexpr unsigned particle_count = 48;
    constexpr float lifetime_seconds = 1.8f;
    constexpr float gravity_per_second2 = 1150;
    constexpr float drag_per_second = 1.9f;
    constexpr float fade_seconds = .4f;
    constexpr std::array<NameColor, 4> palette = {{
            {1, .71f, .23f, 1},
            {.93f, .9f, .85f, 1},
            {1, .54f, .16f, 1},
            {1, .83f, .37f, 1},
    }};
    if (age < 0 || age >= lifetime_seconds) return;
    const float slowed = (1 - std::exp(-drag_per_second * age)) / drag_per_second;
    for (unsigned i = 0; i < particle_count; ++i) {
        // A fixed spread per particle (golden-angle steps), so every frame agrees.
        const float spread = std::fmod(float(i) * .618034f, 1.f) - .5f;
        const float angle = -1.5708f + spread * 2.8f;
        const float speed = (380 + float(i * 37 % 100) * 5.2f) * .8f;
        const float particle_x = x + std::cos(angle) * speed * slowed;
        const float rise = std::sin(angle) * speed * slowed;
        const float fall = gravity_per_second2 / drag_per_second * (age - slowed);
        NameColor color = palette[i % palette.size()];
        color[3] = std::clamp((lifetime_seconds - age) / fade_seconds, 0.f, 1.f);
        hud.overlay_rect(particle_x, y + rise + fall, 3, 5, color);
    }
}

template <class Hud>
void draw_result(Hud &hud, int width, int height, float percent, const HudResult &result, double now) {
    if (!result.visible(now)) return;
    constexpr NameColor cream = {.94f, .91f, .87f, 1};
    constexpr NameColor faded_cream = {.5f, .47f, .43f, 1};
    constexpr NameColor slower_white = {1, 1, 1, .86f};
    constexpr NameColor record_gold = {1, .83f, .37f, 1};
    constexpr NameColor gain_green = {.3f, 1, .53f, 1};
    constexpr NameColor behind_red = {1, .43f, .43f, .72f};
    constexpr NameColor quiet_white = {1, 1, 1, .6f};
    constexpr NameColor reward_gold = {1, .77f, .32f, 1};
    constexpr NameColor card_fill = {.055f, .055f, .07f, .62f};
    constexpr float card_width = 330;
    constexpr float hint_delay_seconds = 2;
    constexpr float hint_fade_seconds = .4f;
    constexpr float reward_delay_seconds = .6f;
    constexpr float reward_seconds_each = 2.4f;
    const HudGeometry geometry(width, height, percent);
    const float age = float(now - result.started);
    const float flight = std::clamp(age / .45f, 0.f, 1.f);
    const float x = geometry.width / 2;
    float y = geometry.height * (.44f - .23f * (1 - std::pow(1 - flight, 3)));
    const bool slower = result.delta && *result.delta > 0 && result.stamp != ResultStamp::personal_best;
    const NameColor time_color = result.stamp == ResultStamp::world_record ? record_gold
                                 : result.stamp == ResultStamp::rejected   ? faded_cream
                                 : slower                                  ? slower_white
                                                                           : cream;
    const bool show_reward = result.reward_count && age >= reward_delay_seconds;
    const float card_height = show_reward ? 78 : 32;
    hud.overlay_begin(width, height, percent);
    // Confetti and the card go down first so the words always sit on top of them.
    draw_record_burst(hud, x, y + 22, float(now - result.record_started));
    const float card_top = y + 106;
    hud.overlay_rect(x - card_width / 2, card_top, card_width, card_height, card_fill);
    HudLabel<48> line;
    // Roll only during the first 300 ms, then hold the exact server/core time.
    format_hud_time(line, age < .3f ? result.seconds * std::min(1.f, age / .3f) : result.seconds);
    hud.overlay_text(x, y, line.view(), 38, time_color, true);
    y += 52;
    const auto word = result_word(result);
    if (!word.empty()) {
        hud.overlay_text(x, y, word, 17, result.stamp == ResultStamp::world_record ? record_gold : cream, true);
        y += 25;
    }
    if (result.delta) {
        line.format("%+.3f", *result.delta);
        hud.overlay_text(x, y, line.view(), 15, *result.delta < 0 ? gain_green : behind_red, true);
    }
    hud.overlay_text(
            x, card_top + 8, result.status_line.view(), 13, result.status_bad ? behind_red : quiet_white, true
    );
    if (show_reward) {
        const size_t index =
                std::min(result.reward_count - 1, size_t((age - reward_delay_seconds) / reward_seconds_each));
        hud.overlay_text(x, card_top + 32, result.rewards[index].title.view(), 15, reward_gold, true);
        hud.overlay_text(x, card_top + 54, result.rewards[index].detail.view(), 12, cream, true);
    }
    const float hint_alpha = std::clamp((age - hint_delay_seconds) / hint_fade_seconds, 0.f, 1.f);
    if (hint_alpha > 0 && !result.restart_hint.empty()) {
        const NameColor hint_color = {1, 1, 1, .62f * hint_alpha};
        hud.overlay_text(x, card_top + card_height + 10, result.restart_hint.view(), 13, hint_color, true);
    }
    hud.overlay_end(width, height);
}
}  // namespace native
