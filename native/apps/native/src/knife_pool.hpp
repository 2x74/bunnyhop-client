#pragma once
#include "nlohmann/json.hpp"
#include <algorithm>
#include <cmath>
#include <random>
#include <string>
#include <string_view>
#include <vector>

namespace native {

// The knife pool (website progression.ts KnifePool, loadout.ts, player/cosmetics.ts): up to eight knives, each with
// its finish, that the game swaps between at a map load or, with swap "restart", on every restart too. The menu keeps
// the saved pool and the pick (as the website's localStorage does); the game owns when the pick moves on, so the knife
// in hand, your bunny and the run's replay trailer change together and never mid-run.
enum class KnifePoolEvent { none, map, restart };

struct KnifePoolItem {
    std::string knife, finish;
};

// The pick after item `index` (loadout.ts nextPoolIndex): the next one in the list, or (random) any other one.
inline size_t next_pool_index(size_t count, long index, bool random, double random_fraction) {
    if (count < 2) return 0;
    const long n = long(count);
    const long at = ((index % n) + n) % n;
    if (!random) return size_t((at + 1) % n);
    const long step = std::min(n - 2, long(std::floor(std::clamp(random_fraction, 0., .999999) * double(n - 1))));
    return size_t((at + 1 + step) % n);
}

class KnifePool {
public:
    static constexpr size_t max_items = 8;
    static constexpr size_t max_id_bytes = 48;

    // The menu's "knifePool" ({items, swap, order} or null) and its saved pick. Ids are the menu's, checked against
    // the catalogue there; this only bounds them. The pick the menu saved is taken until the game has its own.
    void set(const nlohmann::json &pool, long saved_pick) {
        items_.clear();
        swap_restart_ = random_ = false;
        if (pool.is_object()) read(pool);
        if (pick_ < 0 && saved_pick >= 0) pick_ = saved_pick;
    }

    bool active() const { return items_.size() >= 2; }

    long pick() const { return pick_; }

    // A map loaded or the run restarted (player/cosmetics.ts advanceKnifePool). `random_fraction` is in [0, 1).
    // Returns whether the pick moved.
    bool advance(KnifePoolEvent event, double random_fraction) {
        if (!active() || event == KnifePoolEvent::none) return false;
        if (event == KnifePoolEvent::restart && !swap_restart_) return false;
        const size_t count = items_.size();
        if (pick_ < 0)
            pick_ = random_ ? long(std::min(count - 1, size_t(std::clamp(random_fraction, 0., 1.) * double(count))))
                            : 0;
        else
            pick_ = long(next_pool_index(count, pick_, random_, random_fraction));
        return true;
    }

    // The equipped packed loadout ("2;<knife>;<finish>;...", loadout.ts packLoadout) holding the pool's pick
    // (loadout.ts withPick); the equipped one itself without an active pool.
    std::string held(std::string_view packed) const {
        if (!active() || !packed.starts_with("2;")) return std::string(packed);
        const long n = long(items_.size());
        const auto &item = items_[size_t(((std::max(0L, pick_) % n) + n) % n)];
        const auto knife_end = packed.find(';', 2);
        if (knife_end == std::string_view::npos) return std::string(packed);
        const auto finish_end = packed.find(';', knife_end + 1);
        std::string out = "2;" + item.knife + ";" + item.finish;
        if (finish_end != std::string_view::npos) out += packed.substr(finish_end);
        return out;
    }

private:
    std::vector<KnifePoolItem> items_;
    bool swap_restart_ = false, random_ = false;
    long pick_ = -1;

    static bool valid_id(const nlohmann::json &value, std::string_view prefix) {
        if (!value.is_string()) return false;
        const auto &id = value.get_ref<const std::string &>();
        return id.size() <= max_id_bytes && id.starts_with(prefix)
               && id.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789-") == std::string::npos;
    }

    void read(const nlohmann::json &pool) {
        swap_restart_ = pool.value("swap", std::string()) == "restart";
        random_ = pool.value("order", std::string()) == "random";
        if (!pool.contains("items") || !pool.at("items").is_array()) return;
        for (const auto &item : pool.at("items")) {
            if (items_.size() == max_items) break;
            if (!item.is_object() || !item.contains("knife") || !item.contains("finish")) continue;
            if (!valid_id(item.at("knife"), "knife-") || !valid_id(item.at("finish"), "fin-")) continue;
            items_.push_back({item.at("knife").get<std::string>(), item.at("finish").get<std::string>()});
        }
    }
};

// The pool with the equipped loadout it holds from, as the menu sends them, and the loadout held now.
class HeldKnife {
public:
    // A "cosmetics" message from the menu. Returns whether the held loadout changed.
    bool update(std::string equipped, const nlohmann::json &pool, long saved_pick) {
        equipped_ = std::move(equipped);
        pool_.set(pool, saved_pick);
        return refresh();
    }

    // Returns whether the pick moved; the menu is then told it (menu_script).
    bool advance(KnifePoolEvent event) {
        std::uniform_real_distribution<double> fraction(0., 1.);
        if (!pool_.advance(event, fraction(random_))) return false;
        refresh();
        return true;
    }

    const std::string &loadout() const { return held_; }

    // Saves the pick in the menu (player/cosmetics.ts keeps it across sessions) and lets its room show the knife.
    std::string menu_script() const {
        return "window.bunnyhopNativeMenu?.onKnifePick?.(" + std::to_string(pool_.pick()) + ")";
    }

private:
    KnifePool pool_;
    std::string equipped_, held_;
    std::mt19937 random_{std::random_device{}()};

    bool refresh() {
        auto next = pool_.held(equipped_);
        if (next == held_) return false;
        held_ = std::move(next);
        return true;
    }
};

}  // namespace native
