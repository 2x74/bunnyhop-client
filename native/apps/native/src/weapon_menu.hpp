#pragma once
#include "weapon_commands.hpp"
#include "hud_geometry.hpp"
#include "hud_text.hpp"
#include <span>
#include <array>
#include <optional>
#include <string>
#include <vector>

namespace native {
struct WeaponMenuContext {
    unsigned physics = 17;
    bool anyGun = false, replay = false, spectating = false, noclip = false;
};

struct WeaponMenuResult {
    bool handled = false;
    std::optional<uint32_t> weapon;
    std::string refusal;
};

struct WeaponMenuEntry {
    const char *label;
    uint32_t id;
};

class NativeWeaponMenu {
    int category = -1;
    size_t page = 0;
    static constexpr size_t page_size = 7;

    static const std::array<const char *, 7> &categories() {
        static const std::array<const char *, 7> names = {
                "Bunnyhop guns", "Pistols", "Shotguns", "SMGs", "Rifles", "Snipers", "Heavy"
        };
        return names;
    }

    std::span<const WeaponMenuEntry> entries() const {
        static constexpr WeaponMenuEntry bunny[] = {
                {"Cottontail / USP", 3},
                {"Thumper / Glock", 2},
                {"Jackrabbit / Five-Seven", 7},
                {"Seed Drill / P90", 14},
                {"Furrow / AK-47", 17},
                {"Broadfork / M3", 8},
                {"Hedgerow / XM1014", 9},
                {"Beanpole / AWP", 22},
                {"Knife", 1}
        };
        static constexpr WeaponMenuEntry pistols[] = {
                {"USP", 3},
                {"Glock", 2},
                {"P228", 4},
                {"Desert Eagle", 5},
                {"Dual Elites", 6},
                {"Five-Seven", 7},
                {"Knife", 1}
        };
        static constexpr WeaponMenuEntry shotguns[] = {{"M3", 8}, {"XM1014", 9}};
        static constexpr WeaponMenuEntry smgs[] = {
                {"MAC-10", 10}, {"TMP", 11}, {"MP5", 12}, {"UMP-45", 13}, {"P90", 14}
        };
        static constexpr WeaponMenuEntry rifles[] = {
                {"Galil", 15}, {"FAMAS", 16}, {"AK-47", 17}, {"M4A1", 18}, {"SG552", 19}, {"AUG", 20}
        };
        static constexpr WeaponMenuEntry snipers[] = {{"Scout", 21}, {"AWP", 22}, {"G3SG1", 23}, {"SG550", 24}};
        static constexpr WeaponMenuEntry heavy[] = {{"M249", 25}};
        switch (category) {
            case 0:
                return bunny;
            case 1:
                return pistols;
            case 2:
                return shotguns;
            case 3:
                return smgs;
            case 4:
                return rifles;
            case 5:
                return snipers;
            case 6:
                return heavy;
            default:
                return {};
        }
    }

public:
    bool open = false;

    void show() {
        open = true;
        category = -1;
        page = 0;
    }

    void toggle() {
        if (open)
            close();
        else
            show();
    }

    void close() {
        open = false;
        category = -1;
        page = 0;
    }

    std::string title() const {
        return category < 0 ? "Weapons"
                            : std::string(categories()[size_t(category)]) + " (" + std::to_string(page + 1) + "/"
                                      + std::to_string((entries().size() + page_size - 1) / page_size) + ")";
    }

    static std::string refusal(uint32_t id, const WeaponMenuContext &context) {
        if (context.replay || context.spectating || context.noclip)
            return "Weapon commands are unavailable while watching or noclipping.";
        if (context.physics < 7) return "Weapon commands require physics v7 or later.";
        if (id < 1 || id > 25) return "Unknown weapon.";
        if (!context.anyGun && !ranked_command_weapon(id)) return "Ranked runs only allow the USP, Glock and knife.";
        return {};
    }

    std::vector<std::string> rows(const WeaponMenuContext &context) const {
        std::vector<std::string> out;
        if (category < 0) {
            for (size_t i = 0; i < categories().size(); ++i)
                out.push_back(std::to_string(i + 1) + ". " + categories()[i]);
        } else {
            const auto list = entries();
            for (size_t i = page * page_size; i < std::min(list.size(), (page + 1) * page_size); ++i)
                out.push_back(
                        std::to_string(i % page_size + 1) + ". " + list[i].label
                        + (refusal(list[i].id, context).empty() ? "" : " [unavailable]")
                );
            out.push_back(page ? "8. Previous page" : "8. Categories");
            if ((page + 1) * page_size < list.size()) out.push_back("9. Next page");
        }
        out.push_back("0. Close");
        if (!context.anyGun) out.push_back("Practice has every gun.");
        return out;
    }

    template <class Hud>
    void draw(Hud &hud, int width, int height, float percent, const WeaponMenuContext &context) const {
        const HudGeometry geometry(width, height, percent);
        const float box = std::min(600.f, geometry.width - 40);
        const float x = (geometry.width - box) / 2;
        const float y = (geometry.height - 340) / 2;
        constexpr std::array<float, 4> cream = {.94f, .91f, .86f, 1};
        constexpr std::array<float, 4> dim = {.63f, .65f, .7f, 1};
        constexpr std::array<float, 4> amber = {1, .71f, .24f, 1};
        hud.overlay_begin(width, height, percent);
        hud.overlay_rect(x, y, box, 340, {.025f, .027f, .04f, .94f});
        HudLabel<128> label;
        label.assign(category < 0 ? "Weapons" : categories()[size_t(category)]);
        hud.overlay_text(x + 20, y + 14, label.view(), 22, amber);
        float top = y + 56;
        if (category < 0) {
            for (size_t i = 0; i < categories().size(); ++i) {
                label.format("%zu. %s", i + 1, categories()[i]);
                hud.overlay_text(x + 20, top, label.view(), 14, cream);
                top += 25;
            }
        } else {
            const auto list = entries();
            for (size_t i = page * page_size; i < std::min(list.size(), (page + 1) * page_size); ++i) {
                const bool unavailable = context.replay || context.spectating || context.noclip || context.physics < 7
                                         || (!context.anyGun && !ranked_command_weapon(list[i].id));
                label.format("%zu. %s%s", i % page_size + 1, list[i].label, unavailable ? " [unavailable]" : "");
                hud.overlay_text(x + 20, top, label.view(), 14, unavailable ? dim : cream);
                top += 25;
            }
            hud.overlay_text(x + 20, top, page ? "8. Previous page" : "8. Categories", 14, dim);
            top += 25;
            if ((page + 1) * page_size < list.size()) hud.overlay_text(x + 20, top, "9. Next page", 14, dim);
        }
        hud.overlay_text(x + 20, y + 292, "0. Close", 14, dim);
        if (!context.anyGun) hud.overlay_text(x + 20, y + 315, "Practice has every gun.", 11, amber);
        hud.overlay_end(width, height);
    }

    WeaponMenuResult key(unsigned digit, const WeaponMenuContext &context) {
        if (!open || digit > 9) return {};
        WeaponMenuResult result;
        result.handled = true;
        if (digit == 0) {
            close();
            return result;
        }
        if (category < 0) {
            if (digit >= 1 && digit <= categories().size()) {
                category = int(digit - 1);
                page = 0;
            }
            return result;
        }
        const auto list = entries();
        if (digit == 8) {
            if (page)
                --page;
            else
                category = -1;
            return result;
        }
        if (digit == 9) {
            if ((page + 1) * page_size < list.size()) ++page;
            return result;
        }
        if (digit < 1 || digit > page_size) return result;
        const size_t index = page * page_size + digit - 1;
        if (index >= list.size()) return result;
        result.refusal = refusal(list[index].id, context);
        if (result.refusal.empty()) {
            result.weapon = list[index].id;
            close();
        }
        return result;
    }
};

class NativeTriggerMenu {
public:
    bool open = false;

    void toggle() { open = !open; }

    void close() { open = false; }

    std::optional<std::string_view> key(std::string_view code, bool down, bool repeat) {
        if (!open || !down || repeat) return std::nullopt;
        if (code == "Digit0") {
            close();
            return "";
        }
        if (code == "Digit1") return "showTriggers";
        if (code == "Digit2") return "showClips";
        return std::nullopt;
    }

    template <class Hud>
    void draw(Hud &hud, int width, int height, float percent, bool triggers, bool clips) const {
        const HudGeometry geometry(width, height, percent);
        const float x = geometry.width / 2 - 220;
        const float y = geometry.height / 2 - 105;
        const std::array<float, 4> cream = {.94f, .91f, .86f, 1};
        const std::array<float, 4> amber = {1, .71f, .24f, 1};
        hud.overlay_begin(width, height, percent);
        hud.overlay_rect(x, y, 440, 210, {.025f, .027f, .04f, .94f});
        hud.overlay_text(x + 18, y + 16, "Triggers and clips", 20, amber);
        HudLabel<96> label;
        label.format("1. Triggers: %s", triggers ? "shown" : "hidden");
        hud.overlay_text(x + 18, y + 65, label.view(), 14, cream);
        label.format("2. Player clips: %s", clips ? "shown" : "hidden");
        hud.overlay_text(x + 18, y + 99, label.view(), 14, cream);
        hud.overlay_text(x + 18, y + 159, "0. Close", 13, cream);
        hud.overlay_end(width, height);
    }
};

}  // namespace native
