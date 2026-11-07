// The numbered menus share the digit keys: one owns them at a time, so a digit never reaches a menu hidden under
// another one, and 7 with a menu open opens no guns menu over it.
#include "numbered_menus.hpp"
#include "settings.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cstdio>
#include <memory>
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
    bool look_handled = false;
    bool reached_binds = false;
};

struct Menus {
    native::NativeWeaponMenu guns;
    native::NativeTriggerMenu triggers;
    native::RacePicker race;
    native::SpectatePicker spectate;
    bool checkpoints = false;
    native::LookMenu look;
    native::Json settings = native::default_settings();
    native::NumberedMenus numbered{guns, triggers, race, spectate, checkpoints, look};
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
        if (menu == Menu::look && !look.open()) look.toggle("bhop_eazy", settings);
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
        if ((outcome.look_handled = look.key(code, true, false, settings).handled)) return outcome;
        outcome.reached_binds = !numbered.owns(code, true, vote_shown);
        return outcome;
    }
};

constexpr Menu every_menu[] = {Menu::guns, Menu::triggers, Menu::race, Menu::spectate, Menu::checkpoints, Menu::look};

void test_opening_one_closes_the_others() {
    for (const Menu first : every_menu)
        for (const Menu second : every_menu) {
            const auto menus_owner = std::make_unique<Menus>();
            auto &menus = *menus_owner;
            menus.open(first);
            menus.open(second);
            for (const Menu menu : every_menu)
                assert(menus.numbered.is_open(menu) == (menu == second));
        }
}

// !guns in a room, then N: 1 watches the first player instead of picking a gun category.
void test_spectate_menu_over_guns_takes_the_digits() {
    const auto menus_owner = std::make_unique<Menus>();
    auto &menus = *menus_owner;
    menus.open(Menu::guns);
    menus.open(Menu::spectate);
    const auto outcome = menus.digit("Digit1");
    assert(outcome.watch == 4u && !outcome.guns_handled);
    assert(!menus.guns.open);
}

void test_each_menu_gets_its_own_digit() {
    {
        const auto menus_owner = std::make_unique<Menus>();
        auto &menus = *menus_owner;
        menus.open(Menu::spectate);
        menus.open(Menu::triggers);
        assert(menus.digit("Digit1").trigger == "showTriggers" && !menus.spectate.open());
    }
    {
        const auto menus_owner = std::make_unique<Menus>();
        auto &menus = *menus_owner;
        menus.open(Menu::triggers);
        menus.open(Menu::race);
        const auto outcome = menus.digit("Digit1");
        assert(outcome.race_handled && outcome.trigger.empty());
    }
    {
        const auto menus_owner = std::make_unique<Menus>();
        auto &menus = *menus_owner;
        menus.open(Menu::race);
        menus.open(Menu::checkpoints);
        const auto outcome = menus.digit("Digit1");
        assert(outcome.checkpoint_picked && !outcome.race_handled);
    }
    {
        const auto menus_owner = std::make_unique<Menus>();
        auto &menus = *menus_owner;
        menus.open(Menu::checkpoints);
        menus.open(Menu::guns);
        const auto outcome = menus.digit("Digit2");
        assert(outcome.guns_handled && !outcome.checkpoint_picked);
    }
}

// The guns key again (7 with default binds) closes the guns menu rather than picking its 7th entry; 0 closes it too.
void test_the_guns_key_closes_the_guns_menu() {
    const auto menus_owner = std::make_unique<Menus>();
    auto &menus = *menus_owner;
    assert(menus.binds.is_bound("gunMenu", "Digit7"));
    menus.open(Menu::guns);
    const auto outcome = menus.digit("Digit7");
    assert(!menus.guns.open && !outcome.guns_handled && !outcome.reached_binds);
    menus.open(Menu::guns);
    assert(menus.digit("Digit0").guns_handled && !menus.guns.open);
}

// While a menu or the room's map vote is on screen, a digit it doesn't use still fires no bind (7 opens no guns menu).
void test_open_menus_own_the_digits() {
    const auto menus_owner = std::make_unique<Menus>();
    auto &menus = *menus_owner;
    assert(menus.digit("Digit7").reached_binds);
    assert(!menus.digit("Digit7", true).reached_binds);
    menus.open(Menu::spectate);
    assert(!menus.digit("Digit6").reached_binds);
    assert(!menus.numbered.owns("Digit6", false, false));
    assert(!menus.numbered.owns("KeyW", true, true));
    menus.numbered.close_all();
    assert(!menus.numbered.any_open() && !menus.numbered.owns("Digit6", true, false));
}

// !bright's menu takes the digits over the others, and gives them up to the next menu opened.
void test_look_menu_takes_the_digits() {
    const auto menus = std::make_unique<Menus>();
    menus->open(Menu::guns);
    menus->open(Menu::look);
    assert(menus->digit("Digit1").look_handled && !menus->guns.open);
    assert(!menus->digit("Digit8").reached_binds);
    menus->open(Menu::spectate);
    assert(!menus->look.open() && menus->digit("Digit1").watch == 4u);
}

// A click on a menu a chat line opened is its row's digit; a click away from the panel closes the menu.
void test_clicks_pick_rows() {
    constexpr int width = 1280, height = 720;
    constexpr float percent = 100;
    const auto menus = std::make_unique<Menus>();
    assert(!menus->numbered.chat_menu_open());
    menus->open(Menu::spectate);
    assert(menus->numbered.chat_menu_open());
    const auto rows = menus->spectate.rows(width, height, percent);
    const auto middle = [&](size_t row) {
        const auto &place = rows.rows[row];
        return std::array<float, 2>{rows.left + rows.width / 2, place.top + place.height / 2};
    };
    assert(menus->numbered.click(width, height, percent, middle(1)).code == "Digit2");
    const auto close = menus->numbered.click(width, height, percent, middle(rows.count - 1));
    assert(close.code == "Digit0");
    const auto title = menus->numbered.click(width, height, percent, {rows.left + 20, rows.top + 4});
    assert(!title.code && !title.outside);
    assert(menus->numbered.click(width, height, percent, {1, 1}).outside);
    menus->open(Menu::guns);
    assert(!menus->numbered.chat_menu_open() && !menus->numbered.click(width, height, percent, {1, 1}).outside);
}

// Ten race styles take two pages: the picker's own "9. Next page" line takes the click.
void test_race_pages_click() {
    constexpr int width = 1920, height = 1080;
    constexpr float percent = 100;
    const auto menus = std::make_unique<Menus>();
    menus->open(Menu::race);
    menus->digit("Digit1");
    assert(menus->race.step == native::RacePicker::Step::style);
    const auto rows = menus->race.rows(width, height, percent);
    bool next_page = false;
    for (size_t i = 0; i < rows.count; ++i) {
        const auto &row = rows.rows[i];
        const auto click = menus->numbered.click(width, height, percent, {rows.left + 30, row.top + row.height / 2});
        assert(click.code == "Digit" + std::to_string(row.digit));
        next_page |= row.digit == 9;
    }
    assert(next_page == (menus->race.available() > 8));
}

void test_copy_start_menu_owns_its_rows() {
    const auto menus = std::make_unique<Menus>();
    menus->open(Menu::guns);
    menus->numbered.copy_start.show(menus->board);
    menus->numbered.opened(Menu::copy_start);
    assert(!menus->guns.open && menus->numbered.chat_menu_open());
    assert(menus->numbered.owns("Digit1", true, false));
    const auto rows = menus->numbered.copy_start.rows(1920, 1080, 100);
    const auto &row = rows.rows[1];
    const auto click = menus->numbered.click(1920, 1080, 100, {rows.left + 30, row.top + row.height / 2});
    assert(click.code == "Digit2");
    const auto pick = menus->numbered.copy_start.key(*click.code, true, false);
    assert(pick.chosen && pick.slot == 4 && !menus->numbered.chat_menu_open());
    menus->numbered.copy_start.show(menus->board);
    menus->open(Menu::race);
    assert(!menus->numbered.copy_start.open());
}

}  // namespace

int main() {
    test_opening_one_closes_the_others();
    test_spectate_menu_over_guns_takes_the_digits();
    test_each_menu_gets_its_own_digit();
    test_the_guns_key_closes_the_guns_menu();
    test_open_menus_own_the_digits();
    test_look_menu_takes_the_digits();
    test_clicks_pick_rows();
    test_race_pages_click();
    test_copy_start_menu_owns_its_rows();
    std::puts("numbered menus passed");
}
