#include "weapon_menu.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <set>

int main() {
    native::NativeWeaponMenu menu;
    native::WeaponMenuContext ranked, practice;
    practice.anyGun = true;
    menu.show();
    assert(menu.rows(ranked).size() == 9);
    menu.key(1, ranked);
    assert(menu.title().find("Bunnyhop") != std::string::npos);
    assert(menu.key(3, ranked).refusal.find("Ranked") != std::string::npos && menu.open);
    assert(menu.key(1, ranked).weapon == 3 && !menu.open);
    menu.show();
    menu.key(1, practice);
    menu.key(9, practice);
    assert(menu.title().find("2/2") != std::string::npos);
    assert(menu.key(1, practice).weapon == 22);
    menu.show();
    menu.key(1, ranked);
    menu.key(9, ranked);
    assert(menu.key(2, ranked).weapon == 1);
    // Every shared core weapon is reachable from a category.
    std::set<unsigned> reached;
    for (unsigned category = 1; category <= 7; ++category)
        for (unsigned page = 0; page < 2; ++page)
            for (unsigned digit = 1; digit <= 7; ++digit) {
                menu.show();
                menu.key(category, practice);
                if (page) menu.key(9, practice);
                const auto selected = menu.key(digit, practice);
                if (selected.weapon) reached.insert(*selected.weapon);
            }
    assert(reached.size() == 25 && *reached.begin() == 1 && *reached.rbegin() == 25);
    for (const auto &context :
         {native::WeaponMenuContext{6, true},
          native::WeaponMenuContext{17, true, true},
          native::WeaponMenuContext{17, true, false, true},
          native::WeaponMenuContext{17, true, false, false, true}}) {
        menu.show();
        menu.key(2, context);
        assert(!menu.key(1, context).refusal.empty() && menu.open);
    }
    menu.key(8, practice);
    assert(menu.title() == "Weapons");
    menu.key(0, practice);
    assert(!menu.open && !menu.key(1, practice).handled);
}
