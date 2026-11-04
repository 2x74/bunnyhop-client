#pragma once
// The CS:S-style numbered menus: guns, triggers, the race picker, the spectate menu and the checkpoint menu. One owns
// the digit keys at a time, as on the website (weapon-commands.ts numberMenuOpen): opening one closes the others, and
// while one is on screen a digit fires no bind. The room's map vote counts as on screen too, but the room opens and
// closes it.
#include "input_binds.hpp"
#include "room_modes.hpp"
#include "spectate.hpp"
#include "weapon_menu.hpp"
#include <string>
#include <string_view>

namespace native {

struct NumberedMenus {
    enum class Menu { guns, triggers, race, spectate, checkpoints };

    NativeWeaponMenu &guns;
    NativeTriggerMenu &triggers;
    RacePicker &race;
    SpectatePicker &spectate;
    bool &checkpoints;

    bool is_open(Menu menu) const {
        switch (menu) {
            case Menu::guns:
                return guns.open;
            case Menu::triggers:
                return triggers.open;
            case Menu::race:
                return race.step != RacePicker::Step::closed;
            case Menu::spectate:
                return spectate.open();
            case Menu::checkpoints:
                return checkpoints;
        }
        return false;
    }

    bool any_open() const {
        for (const Menu menu : all)
            if (is_open(menu)) return true;
        return false;
    }

    // After |menu| was asked to open (or toggled): if it is open now, the others close.
    void opened(Menu menu) {
        if (!is_open(menu)) return;
        for (const Menu other : all)
            if (other != menu) close(other);
    }

    void close_all() {
        for (const Menu menu : all)
            close(menu);
    }

    // The guns key again closes the guns menu, before its digit can pick (7 with default binds).
    bool closes_guns(const std::string &code, bool down, bool repeat, const BindTable &binds) {
        if (!guns.open || !down || repeat || !binds.is_bound("gunMenu", code)) return false;
        guns.close();
        return true;
    }

    // Whether a digit press belongs to a menu on screen rather than to a bind. Key releases still reach the binds.
    bool owns(std::string_view code, bool down, bool vote_shown) const {
        const bool digit = code.size() == 6 && code.starts_with("Digit");
        return digit && down && (vote_shown || any_open());
    }

private:
    static constexpr Menu all[] = {Menu::guns, Menu::triggers, Menu::race, Menu::spectate, Menu::checkpoints};

    void close(Menu menu) {
        switch (menu) {
            case Menu::guns:
                guns.close();
                break;
            case Menu::triggers:
                triggers.close();
                break;
            case Menu::race:
                race.step = RacePicker::Step::closed;
                break;
            case Menu::spectate:
                spectate.close();
                break;
            case Menu::checkpoints:
                checkpoints = false;
                break;
        }
    }
};

}  // namespace native
