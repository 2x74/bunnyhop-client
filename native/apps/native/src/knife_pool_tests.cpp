#include "knife_pool.hpp"
#include <cassert>
#include <cmath>
#include <vector>

namespace {

const nlohmann::json three_knives = {
        {"items",
         {{{"knife", "knife-karrotbit"}, {"finish", "fin-sunset"}},
          {{"knife", "knife-whirligig"}, {"finish", "fin-garden"}},
          {{"knife", "knife-thistle"}, {"finish", "fin-geode"}}}},
        {"swap", "map"},
        {"order", "order"}
};

const std::string equipped = "2;knife-carrot;fin-garden;glove-sport;;hat-ponytail;;outfit-neon;f29bbf;300";

void test_next_index_matches_the_website() {
    // loadout.ts nextPoolIndex: in order wraps; random never repeats the last pick.
    assert(native::next_pool_index(3, 0, false, 0) == 1);
    assert(native::next_pool_index(3, 2, false, 0) == 0);
    assert(native::next_pool_index(3, -1, false, 0) == 0);
    assert(native::next_pool_index(1, 0, false, 0) == 0);
    for (double fraction : {0., .2, .49, .5, .7, .999})
        for (long at = 0; at < 3; ++at)
            assert(native::next_pool_index(3, at, true, fraction) != size_t(at));
    assert(native::next_pool_index(3, 0, true, 0) == 1);
    assert(native::next_pool_index(3, 0, true, .6) == 2);
    assert(native::next_pool_index(2, 1, true, .9) == 0);
}

void test_map_loads_move_the_pick() {
    native::KnifePool pool;
    pool.set(three_knives, -1);
    assert(pool.active());
    assert(pool.held(equipped) == "2;knife-karrotbit;fin-sunset;glove-sport;;hat-ponytail;;outfit-neon;f29bbf;300");
    assert(!pool.advance(native::KnifePoolEvent::restart, 0));
    assert(pool.advance(native::KnifePoolEvent::map, 0) && pool.pick() == 0);
    assert(pool.advance(native::KnifePoolEvent::map, 0) && pool.pick() == 1);
    assert(pool.held(equipped) == "2;knife-whirligig;fin-garden;glove-sport;;hat-ponytail;;outfit-neon;f29bbf;300");
    assert(pool.advance(native::KnifePoolEvent::map, 0) && pool.advance(native::KnifePoolEvent::map, 0));
    assert(pool.pick() == 0);
    assert(!pool.advance(native::KnifePoolEvent::none, 0));
}

void test_restart_swap_and_saved_pick() {
    auto restart = three_knives;
    restart["swap"] = "restart";
    native::KnifePool pool;
    pool.set(restart, 2);
    assert(pool.pick() == 2);
    assert(pool.advance(native::KnifePoolEvent::restart, 0) && pool.pick() == 0);
    // The game's own pick wins over the menu echoing the one it saved before.
    pool.set(restart, 2);
    assert(pool.pick() == 0);
}

void test_short_or_bad_pools_hold_the_equipped_knife() {
    native::KnifePool pool;
    pool.set(nullptr, 3);
    assert(!pool.active() && pool.held(equipped) == equipped);
    pool.set({{"items", {{{"knife", "knife-whirligig"}, {"finish", "fin-garden"}}}}}, -1);
    assert(!pool.active() && !pool.advance(native::KnifePoolEvent::map, 0));
    nlohmann::json bad = three_knives;
    bad["items"][1]["knife"] = "knife-<script>";
    bad["items"][2]["finish"] = "glove-knit";
    pool.set(bad, -1);
    assert(!pool.active());
    nlohmann::json many = {{"items", nlohmann::json::array()}};
    for (int i = 0; i < 12; ++i)
        many["items"].push_back({{"knife", "knife-carrot"}, {"finish", "fin-" + std::to_string(i)}});
    pool.set(many, 11);
    assert(pool.active() && pool.held("2;knife-golden;fin-garden;glove-knit").starts_with("2;knife-carrot;fin-"));
    assert(pool.held("1;knife-golden;fin-garden;0;0;glove-knit") == "1;knife-golden;fin-garden;0;0;glove-knit");
    assert(pool.held("2;knife-golden;fin-garden") == "2;knife-carrot;fin-3");
}

void test_held_knife_reports_changes() {
    native::HeldKnife held;
    assert(held.update(equipped, three_knives, -1));
    assert(!held.update(equipped, three_knives, -1));
    assert(held.advance(native::KnifePoolEvent::map));
    assert(held.loadout().starts_with("2;knife-karrotbit;fin-sunset;glove-sport"));
    assert(held.menu_script() == "window.bunnyhopNativeMenu?.onKnifePick?.(0)");
    assert(held.update(equipped, nullptr, 0) && held.loadout() == equipped);
}

}  // namespace

int main() {
    test_next_index_matches_the_website();
    test_map_loads_move_the_pick();
    test_restart_swap_and_saved_pick();
    test_short_or_bad_pools_hold_the_equipped_knife();
    test_held_knife_reports_changes();
}
