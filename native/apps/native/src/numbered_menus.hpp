#pragma once
// The CS:S-style numbered menus: guns, triggers, the race picker, the spectate menu, the checkpoint menu and !bright's.
// One owns the digit keys at a time, as on the website (weapon-commands.ts numberMenuOpen): opening one closes the
// others, and while one is on screen a digit fires no bind. The room's map vote counts as on screen too, but the room
// opens and closes it.
#include "input_binds.hpp"
#include "look_menu.hpp"
#include "copy_start_picker.hpp"
#include "room_modes.hpp"
#include "spectate.hpp"
#include "weapon_menu.hpp"
#include <array>
#include <optional>
#include <string>
#include <string_view>

namespace native {

struct NumberedMenus {
    enum class Menu { guns, triggers, race, spectate, checkpoints, look, copy_start };

    NativeWeaponMenu &guns;
    NativeTriggerMenu &triggers;
    RacePicker &race;
    SpectatePicker &spectate;
    bool &checkpoints;
    LookMenu &look;
    CopyStartPicker copy_start{};

    bool is_open(Menu menu) const {
        switch (menu) {
            case Menu::copy_start:
                return copy_start.open();
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
            case Menu::look:
                return look.open();
        }
        return false;
    }

    // The menus a chat line opens (!spec, !race, !bright), which keep the cursor out for their rows (menu_cursor.hpp).
    bool chat_menu_open() const {
        return is_open(Menu::race) || is_open(Menu::spectate) || is_open(Menu::look) || is_open(Menu::copy_start);
    }

    struct Click {
        // The digit key the clicked row stands for ("Digit3"), to go through the keys' own path.
        std::optional<std::string> code;
        // !bright's bar: the brightness clicked.
        std::optional<double> brightness;
        // Away from the menu: it closes.
        bool outside = false;
    };

    // A left click at `point` (HUD units, menu_cursor.hpp hud_point) on the chat-opened menu on screen.
    Click click(int width, int height, float percent, std::array<float, 2> point) const {
        const auto rows = chat_menu_rows(width, height, percent);
        if (!rows) return {};
        Click result;
        if (look.open()) result.brightness = look.bar_value(width, height, percent, point[0], point[1]);
        if (result.brightness) return result;
        if (const auto digit = rows->digit_at(point[0], point[1]))
            result.code = "Digit" + std::to_string(*digit);
        else
            result.outside = !rows->contains(point[0], point[1]);
        return result;
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
    static constexpr Menu all[] = {
            Menu::guns, Menu::triggers, Menu::race, Menu::spectate, Menu::checkpoints, Menu::look, Menu::copy_start
    };

    std::optional<MenuRows> chat_menu_rows(int width, int height, float percent) const {
        if (is_open(Menu::copy_start)) return copy_start.rows(width, height, percent);
        if (is_open(Menu::race)) return race.rows(width, height, percent);
        if (is_open(Menu::spectate)) return spectate.rows(width, height, percent);
        if (is_open(Menu::look)) return look.rows(width, height, percent);
        return std::nullopt;
    }

    void close(Menu menu) {
        switch (menu) {
            case Menu::copy_start:
                copy_start.close();
                break;
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
            case Menu::look:
                look.close();
                break;
        }
    }
};

}  // namespace native
