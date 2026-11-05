#pragma once
// Room spectating's camera and screens (web net/mp.ts): In-eye, Chase and Free look, the bar that says whom you watch
// and how to stop, and the N / !spec menu.
#include "free_look.hpp"
#include "hud_geometry.hpp"
#include "hud_layout.hpp"
#include "hud_scoreboard.hpp"
#include "hud_text.hpp"
#include "input_timeline.hpp"
#include "menu_rows.hpp"
#include <array>
#include <optional>
#include <set>
#include <string>
#include <string_view>

namespace native {

class SpectatorView {
public:
    enum class Mode { eye, chase, free };

    Mode mode() const { return mode_; }

    bool chase() const { return mode_ == Mode::chase; }

    bool free() const { return mode_ == Mode::free; }

    FreeLook &free_look() { return free_look_; }

    // A new watch starts in-eye; switching players keeps the camera (CS:S does), free look included.
    void watch(bool first, const FreeLookInput &controls) {
        if (first) set(Mode::eye, controls);
    }

    void stop(const FreeLookInput &controls) { set(Mode::eye, controls); }

    // Space or F: In-eye, Chase, Free look, in CS:S's observer order.
    void cycle(const FreeLookInput &controls) {
        const Mode next = mode_ == Mode::eye ? Mode::chase : mode_ == Mode::chase ? Mode::free : Mode::eye;
        set(next, controls);
    }

    // !freecam or the freecam bind while watching: free look, or back in-eye from it.
    void toggle_free(const FreeLookInput &controls) { set(mode_ == Mode::free ? Mode::eye : Mode::free, controls); }

    // The thirdPerson bind while watching: in-eye and chase.
    void toggle_chase(const FreeLookInput &controls) { set(mode_ == Mode::chase ? Mode::eye : Mode::chase, controls); }

    // Whether a key changes the camera: Space or F. In free look a movement key flies instead (Space rises), and F
    // still changes the camera unless it is a movement key too; then !freecam is the way back (web net/mp.ts).
    bool changes_camera(std::string_view code, const BindTable &binds) const {
        if (code != "Space" && code != "KeyF") return false;
        return mode_ != Mode::free || !binds.of(std::string(code));
    }

    // Free look starts from the last In-eye or Chase view, not from wherever the frame first put the camera.
    void remember(const float eye[3], const Input &view) {
        last_eye_ = {eye[0], eye[1], eye[2]};
        last_yaw_ = view.yaw();
        last_pitch_ = view.pitch;
        have_last_ = true;
    }

    void place_free(float eye[3], Input &view, const FreeLookKeys &keys, double seconds) {
        if (!free_look_.started() && have_last_) {
            for (int axis = 0; axis < 3; ++axis)
                eye[axis] = last_eye_[axis];
            view.set_angles(last_pitch_, last_yaw_, 5);
        }
        free_look_.place(eye, view, keys, seconds);
    }

    // The quiet line under the bar: the camera and the way out. |stop_code| is the restart bind's first key.
    std::string_view hint(std::string_view stop_code, const BindTable &binds) {
        const bool f_flies = binds.of("KeyF") != 0;
        if (hint_mode_ == mode_ && hint_code_.view() == stop_code && hint_f_flies_ == f_flies && !hint_.empty())
            return hint_.view();
        hint_mode_ = mode_;
        hint_code_.assign(stop_code);
        hint_f_flies_ = f_flies;
        const std::string stop = stop_code.empty() ? std::string("!r") : hud_key_label(stop_code);
        if (mode_ == Mode::free)
            hint_.format(
                    "Free look. %s goes back in-eye, %s stops watching.", f_flies ? "!freecam" : "F", stop.c_str()
            );
        else
            hint_.format("Space changes the camera, %s stops watching.", stop.c_str());
        return hint_.view();
    }

private:
    Mode mode_ = Mode::eye;
    FreeLook free_look_;
    std::array<float, 3> last_eye_{};
    double last_yaw_ = 0;
    double last_pitch_ = 0;
    bool have_last_ = false;
    HudLabel<128> hint_;
    HudLabel<48> hint_code_;
    Mode hint_mode_ = Mode::eye;
    bool hint_f_flies_ = false;

    // Free look takes the mouse and the keys (R2 and R3 as for freecam); leaving it gives them back.
    void set(Mode next, const FreeLookInput &controls) {
        if (next == Mode::free && mode_ != Mode::free)
            controls.take(free_look_);
        else if (next != Mode::free && mode_ == Mode::free)
            controls.give_back();
        mode_ = next;
    }
};

// What the spectator bar shows this frame; |shown| is false while not watching. |look|: the watched name's colour,
// effect and font (watched_name_look); |seconds| runs the effect.
struct SpectatorBar {
    bool shown = false;
    bool waiting = false;
    std::string_view name;
    std::string_view hint;
    NameAppearance look;
    double seconds = 0;
};

// The bar draws the name as the website does: the supporter's look, else the slot's colour, and no marks.
inline NameAppearance watched_name_look(NameAppearance look, unsigned slot) {
    if (look.color == NameAppearance{}.color) look.color = slot_color(slot);
    look.marks = 0;
    look.badge_count = 0;
    return look;
}

// "Watching <name>" at the bottom of the screen with the hint under it (web net/hud.ts SpecBar).
template <class Hud>
void draw_spectator_bar(Hud &hud, int width, int height, float percent, const SpectatorBar &bar) {
    if (!bar.shown) return;
    constexpr float bar_from_bottom = 46;
    constexpr float hint_below_bar = 21;
    constexpr float text_size = 16;
    constexpr NameColor cream = {.94f, .91f, .86f, 1};
    constexpr NameColor dim = {.63f, .65f, .70f, 1};
    constexpr std::string_view lead = "Watching ";
    const std::string_view waiting = bar.waiting ? ", waiting for them" : "";
    const HudGeometry geometry(width, height, percent);
    hud.overlay_begin(width, height, percent);
    const float lead_width = hud.overlay_text_width(lead, text_size);
    const float name_width = hud.overlay_name_width(bar.name, text_size, bar.look);
    const float waiting_width = waiting.empty() ? 0 : hud.overlay_text_width(waiting, text_size);
    const float left = (geometry.width - lead_width - name_width - waiting_width) / 2;
    const float top = geometry.height - bar_from_bottom;
    hud.overlay_text(left, top, lead, text_size, cream);
    hud.overlay_name(left + lead_width, top, bar.name, text_size, bar.look, bar.seconds);
    if (!waiting.empty()) hud.overlay_text(left + lead_width + name_width, top, waiting, text_size, dim);
    hud.overlay_text(geometry.width / 2, top + hint_below_bar, bar.hint, 12, dim, true);
    hud.overlay_end(width, height);
}

// The chat line when watching starts or stops (web net/mp.ts startSpectate, stopSpectating).
template <class Chat, class Room>
void announce_watching(
        Chat &chat,
        const Room &room,
        std::optional<unsigned> before,
        std::optional<unsigned> now,
        const BindTable &binds,
        double epoch_ms
) {
    constexpr double milliseconds_per_second = 1000;
    const auto label = [&](std::string_view action, std::string_view fallback) {
        const auto &codes = binds.codes(action);
        return codes.empty() ? std::string(fallback) : hud_key_label(codes.front());
    };
    if (now) {
        const auto name = room.player_name(*now);
        chat.push(
                "Spectating " + std::string(name.empty() ? "a player" : name)
                        + ". Mouse 1 and 2 switch players, Space changes the camera, " + label("restart", "!r")
                        + " stops watching.",
                "",
                "local",
                epoch_ms / milliseconds_per_second
        );
    } else if (before) {
        const auto &menu = binds.codes("spectatorMode");
        const std::string again = menu.empty() ? "!spec" : hud_key_label(menu.front()) + " or !spec";
        chat.push("Back in the run. " + again + " to watch again.", "", "local", epoch_ms / milliseconds_per_second);
    }
}

// The N / !spec menu: the players to watch, and the way back while watching (web net/mp.ts openSpectateMenu).
class SpectatePicker {
public:
    static constexpr size_t max_players = 8;

    bool open() const { return open_; }

    size_t count() const { return count_; }

    std::string_view name(size_t index) const { return names_[index].view(); }

    bool offers_stop() const { return spectating_; }

    // Opens with whoever is playing; returns false (and stays closed) when nobody is.
    bool show(const HudScoreboard &board, std::optional<unsigned> watching) {
        count_ = 0;
        spectating_ = watching.has_value();
        for (size_t i = 0; i < board.count && count_ < max_players; ++i) {
            const auto &row = board.rows[i];
            if (row.you || row.spectator) continue;
            slots_[count_] = row.slot;
            names_[count_].assign(row.name);
            watched_[count_] = watching == row.slot;
            ++count_;
        }
        open_ = count_ > 0;
        return open_;
    }

    void close() { open_ = false; }

    struct Pick {
        bool handled = false;
        std::optional<unsigned> watch;
        bool stop = false;
    };

    // A digit while it is open: 1-8 watch a player, the number after them stops watching, 0 closes.
    Pick key(std::string_view code, bool down, bool repeat) {
        if (!open_ || !down || repeat || code.size() != 6 || !code.starts_with("Digit")) return {};
        const size_t digit = size_t(code.back() - '0');
        Pick pick;
        pick.handled = true;
        if (digit == 0) {
            open_ = false;
            return pick;
        }
        if (digit <= count_) {
            pick.watch = slots_[digit - 1];
            open_ = false;
        } else if (spectating_ && digit == count_ + 1) {
            pick.stop = true;
            open_ = false;
        }
        return pick;
    }

    // The panel and its rows: the players, the way back while watching, and Close.
    MenuRows rows(int width, int height, float percent) const {
        constexpr float panel_width = 440, row_height = 28, first_row = 52, frame_height = 104;
        constexpr float exit_from_bottom = 22, exit_height = 22;
        const size_t lines = count_ + (spectating_ ? 1 : 0);
        const HudGeometry geometry(width, height, percent);
        MenuRows out;
        out.width = panel_width;
        out.height = frame_height + float(lines) * row_height;
        out.left = geometry.width / 2 - panel_width / 2;
        out.top = geometry.height / 2 - out.height / 2;
        for (size_t i = 0; i < lines; ++i)
            out.add(unsigned(i + 1), out.top + first_row + float(i) * row_height, row_height);
        out.add(0, out.top + out.height - exit_from_bottom, exit_height);
        return out;
    }

    // `pointer`: the cursor in HUD units while a chat line holds it out, for the row it is on.
    template <class Hud>
    void draw(
            Hud &hud, int width, int height, float percent, std::optional<std::array<float, 2>> pointer = std::nullopt
    ) const {
        if (!open_) return;
        constexpr float text_inset = 6;
        constexpr NameColor cream = {.94f, .91f, .86f, 1};
        constexpr NameColor dim = {.63f, .65f, .70f, 1};
        constexpr NameColor amber = {1, .71f, .24f, 1};
        const auto layout = rows(width, height, percent);
        const float x = layout.left, y = layout.top;
        hud.overlay_begin(width, height, percent);
        hud.overlay_rect(x, y, layout.width, layout.height, {.025f, .027f, .04f, .96f});
        draw_menu_hover(hud, layout, layout.hovered(pointer));
        hud.overlay_text(x + 18, y + 16, "Spectate", 20, amber);
        HudLabel<160> label;
        for (size_t i = 0; i < count_; ++i) {
            const auto shown = names_[i].view();
            label.format("%zu. %.*s", i + 1, int(shown.size()), shown.data());
            hud.overlay_text(x + 18, layout.rows[i].top + text_inset, label.view(), 14, watched_[i] ? amber : cream);
        }
        if (spectating_) {
            label.format("%zu. Stop spectating (respawn)", count_ + 1);
            hud.overlay_text(x + 18, layout.rows[count_].top + text_inset, label.view(), 14, cream);
        }
        const float footer = y + layout.height - 36;
        hud.overlay_text(x + 18, footer, "Mouse 1 and 2 switch players. Space changes the camera.", 12, dim);
        hud.overlay_text(x + 18, footer + 18, "0. Close", 12, dim);
        hud.overlay_end(width, height);
    }

private:
    std::array<unsigned, max_players> slots_{};
    std::array<HudLabel<128>, max_players> names_;
    std::array<bool, max_players> watched_{};
    size_t count_ = 0;
    bool open_ = false;
    bool spectating_ = false;
};

}  // namespace native
