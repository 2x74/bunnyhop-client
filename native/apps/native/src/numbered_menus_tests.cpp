// The numbered menus share the digit keys: one owns them at a time, so a digit never reaches a menu hidden under
// another one, and 7 with a menu open opens no guns menu over it.
#include "numbered_menus.hpp"
#include "settings.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cstdio>
#include <optional>
#include <string>
#include <vector>

namespace {

using Menu = native::NumberedMenus::Menu;

struct Zone {
    unsigned kind = 0;
    unsigned track = 0;
};

// What a digit did, in the order client.cpp handle_code offers it: triggers, guns, race, spectate, checkpoints, then
// the binds when no menu owns it.
struct Outcome {
    std::string_view trigger;
    bool guns_handled = false;
    bool race_handled = false;
    std::optional<unsigned> watch;
    bool checkpoint_picked = false;
    bool reached_binds = false;
};

struct Menus {
    native::NativeWeaponMenu guns;
    native::NativeTriggerMenu triggers;
    native::RacePicker race;
    native::SpectatePicker spectate;
    bool checkpoints = false;
    native::NumberedMenus numbered{guns, triggers, race, spectate, checkpoints};
    native::BindTable binds;
    native::HudScoreboard board;
    std::vector<Zone> zones;

    Menus() {
        binds.rebuild(native::default_settings().at("binds"));
        board.count = 3;
        board.rows[0].slot = 0;
        board.rows[0].name = "me";
        board.rows[0].you = true;
        board.rows[1].slot = 4;
        board.rows[1].name = "ana";
        board.rows[2].slot = 9;
        board.rows[2].name = "bo";
    }

    void open(Menu menu) {
        if (menu == Menu::guns) guns.show();
        if (menu == Menu::triggers && !triggers.open) triggers.toggle();
        if (menu == Menu::race) race.open(board, zones);
        if (menu == Menu::spectate) assert(spectate.show(board, std::nullopt));
        if (menu == Menu::checkpoints) checkpoints = true;
        numbered.opened(menu);
    }

    Outcome digit(const std::string &code, bool vote_shown = false) {
        Outcome outcome;
        if (numbered.closes_guns(code, true, false, binds)) return outcome;
        if (const auto action = triggers.key(code, true, false)) {
            outcome.trigger = *action;
            return outcome;
        }
        if (guns.open && code.starts_with("Digit")) {
            outcome.guns_handled = guns.key(unsigned(code.back() - '0'), {}).handled;
            if (outcome.guns_handled) return outcome;
        }
        if ((outcome.race_handled = race.key(code, true, false))) return outcome;
        if (const auto pick = spectate.key(code, true, false); pick.handled) {
            outcome.watch = pick.watch;
            return outcome;
        }
        if (checkpoints && code.starts_with("Digit")) {
            outcome.checkpoint_picked = true;
            return outcome;
        }
        outcome.reached_binds = !numbered.owns(code, true, vote_shown);
        return outcome;
    }
};

constexpr Menu every_menu[] = {Menu::guns, Menu::triggers, Menu::race, Menu::spectate, Menu::checkpoints};

void test_opening_one_closes_the_others() {
    for (const Menu first : every_menu)
        for (const Menu second : every_menu) {
            Menus menus;
            menus.open(first);
            menus.open(second);
            for (const Menu menu : every_menu)
                assert(menus.numbered.is_open(menu) == (menu == second));
        }
}

// !guns in a room, then N: 1 watches the first player instead of picking a gun category.
void test_spectate_menu_over_guns_takes_the_digits() {
    Menus menus;
    menus.open(Menu::guns);
    menus.open(Menu::spectate);
    const auto outcome = menus.digit("Digit1");
    assert(outcome.watch == 4u && !outcome.guns_handled);
    assert(!menus.guns.open);
}

void test_each_menu_gets_its_own_digit() {
    {
        Menus menus;
        menus.open(Menu::spectate);
        menus.open(Menu::triggers);
        assert(menus.digit("Digit1").trigger == "showTriggers" && !menus.spectate.open());
    }
    {
        Menus menus;
        menus.open(Menu::triggers);
        menus.open(Menu::race);
        const auto outcome = menus.digit("Digit1");
        assert(outcome.race_handled && outcome.trigger.empty());
    }
    {
        Menus menus;
        menus.open(Menu::race);
        menus.open(Menu::checkpoints);
        const auto outcome = menus.digit("Digit1");
        assert(outcome.checkpoint_picked && !outcome.race_handled);
    }
    {
        Menus menus;
        menus.open(Menu::checkpoints);
        menus.open(Menu::guns);
        const auto outcome = menus.digit("Digit2");
        assert(outcome.guns_handled && !outcome.checkpoint_picked);
    }
}

// The guns key again (7 with default binds) closes the guns menu rather than picking its 7th entry; 0 closes it too.
void test_the_guns_key_closes_the_guns_menu() {
    Menus menus;
    assert(menus.binds.is_bound("gunMenu", "Digit7"));
    menus.open(Menu::guns);
    const auto outcome = menus.digit("Digit7");
    assert(!menus.guns.open && !outcome.guns_handled && !outcome.reached_binds);
    menus.open(Menu::guns);
    assert(menus.digit("Digit0").guns_handled && !menus.guns.open);
}

// While a menu or the room's map vote is on screen, a digit it doesn't use still fires no bind (7 opens no guns menu).
void test_open_menus_own_the_digits() {
    Menus menus;
    assert(menus.digit("Digit7").reached_binds);
    assert(!menus.digit("Digit7", true).reached_binds);
    menus.open(Menu::spectate);
    assert(!menus.digit("Digit6").reached_binds);
    assert(!menus.numbered.owns("Digit6", false, false));
    assert(!menus.numbered.owns("KeyW", true, true));
    menus.numbered.close_all();
    assert(!menus.numbered.any_open() && !menus.numbered.owns("Digit6", true, false));
}

}  // namespace

int main() {
    test_opening_one_closes_the_others();
    test_spectate_menu_over_guns_takes_the_digits();
    test_each_menu_gets_its_own_digit();
    test_the_guns_key_closes_the_guns_menu();
    test_open_menus_own_the_digits();
    std::puts("numbered menus passed");
}
