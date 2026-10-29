#include "hud_editor.hpp"
#include "client_util.hpp"
#include <algorithm>
#include <cmath>

namespace native {
namespace {

// The website editor's grid and snap distance, in CSS pixels.
constexpr float grid_css_px = 8;
constexpr float snap_css_px = 8;
constexpr float handle_px = 12;
constexpr double scale_step = .05;
constexpr float nudge_px = 1;
constexpr float big_nudge_px = 10;
constexpr uint64_t message_ns = 3'000'000'000ull;
constexpr float bar_margin = 16;
constexpr float bar_widest = 1180;
constexpr float bar_padding = 14;
constexpr float button_height = 24;
constexpr float button_padding = 9;
constexpr float button_gap = 6;
constexpr float row_gap = 8;
constexpr float button_text = 12;
constexpr std::array<float, 4> panel_fill{.02f, .02f, .035f, .92f};
constexpr std::array<float, 4> button_fill{.06f, .06f, .08f, .95f};
constexpr std::array<float, 4> button_hover{.11f, .11f, .14f, .95f};
constexpr std::array<float, 4> button_line{.24f, .24f, .28f, 1};
constexpr std::array<float, 4> cream{.94f, .91f, .86f, 1};
constexpr std::array<float, 4> dim{.63f, .65f, .70f, 1};
constexpr std::array<float, 4> amber{1, .71f, .24f, 1};
constexpr std::array<float, 4> outline_on{.94f, .91f, .86f, .45f};
constexpr std::array<float, 4> outline_off{.63f, .65f, .70f, .25f};
constexpr std::array<float, 4> grid_line{1, 1, 1, .035f};
constexpr std::array<const char *, 9> anchor_names = {
        "top-left", "top", "top-right", "left", "centre", "right", "bottom-left", "bottom", "bottom-right"
};

const HudEditorElement *editor_element(std::string_view id) {
    for (const auto &element : hud_editor_elements) {
        if (element.id == id) return &element;
    }
    return nullptr;
}

bool contains(const HudRect &box, float x, float y) {
    return x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
}

// The point of `box` that its anchor ties to the screen (hud/layout.ts anchorX / anchorY).
std::array<float, 2> anchor_point(const HudRect &box, unsigned anchor) {
    return {box.x + float(anchor % 3) / 2 * box.width, box.y + float(anchor / 3) / 2 * box.height};
}

// A box grown or shrunk around its anchor point, so the point the layout stores stays put.
HudRect scale_box(const HudRect &box, unsigned anchor, double factor) {
    const float horizontal = float(anchor % 3) / 2, vertical = float(anchor / 3) / 2;
    const float point_x = box.x + horizontal * box.width, point_y = box.y + vertical * box.height;
    const float width = box.width * float(factor), height = box.height * float(factor);
    return {point_x - horizontal * width, point_y - vertical * height, width, height};
}

void outline(NativeHud &hud, const HudRect &box, float scale, float thickness, std::array<float, 4> color) {
    const float x = box.x / scale, y = box.y / scale, w = box.width / scale, h = box.height / scale;
    const float t = thickness / scale;
    hud.overlay_rect(x, y, w, t, color);
    hud.overlay_rect(x, y + h - t, w, t, color);
    hud.overlay_rect(x, y, t, h, color);
    hud.overlay_rect(x + w - t, y, t, h, color);
}

}  // namespace

void HudLayoutEditor::open(const Json &settings) {
    settings_ = settings;
    active_ = true;
    closed_ = false;
    preview_ = true;
    drag_.reset();
}

void HudLayoutEditor::close() {
    if (!active_) return;
    if (drag_) release();
    active_ = false;
    closed_ = true;
    drag_.reset();
}

std::optional<Json> HudLayoutEditor::take_patch() {
    auto patch = std::move(patch_);
    patch_.reset();
    return patch;
}

bool HudLayoutEditor::take_closed() {
    const bool closed = closed_;
    closed_ = false;
    return closed;
}

bool HudLayoutEditor::take_preview() {
    const bool preview = preview_;
    preview_ = false;
    return preview;
}

bool HudLayoutEditor::event(
        const SDL_Event &event, const NativeHud &hud, float pixel_density, const std::vector<std::string> &bind
) {
    if (!active_) return false;
    switch (event.type) {
        case SDL_EVENT_MOUSE_BUTTON_DOWN:
        case SDL_EVENT_MOUSE_BUTTON_UP:
        case SDL_EVENT_MOUSE_MOTION:
        case SDL_EVENT_MOUSE_WHEEL:
            return mouse_event(event, hud, pixel_density);
        case SDL_EVENT_KEY_DOWN:
            key_event(event.key, hud, bind);
            return true;
        case SDL_EVENT_KEY_UP:
        case SDL_EVENT_TEXT_INPUT:
        case SDL_EVENT_TEXT_EDITING:
            return true;
        default:
            return false;
    }
}

bool HudLayoutEditor::mouse_event(const SDL_Event &event, const NativeHud &hud, float pixel_density) {
    if (event.type == SDL_EVENT_MOUSE_WHEEL) {
        if (const auto id = element_at(mouse_x_, mouse_y_, hud)) {
            selected_ = *id;
            rescale(event.wheel.y > 0 ? scale_step : -scale_step, hud);
        }
        return true;
    }
    const bool motion = event.type == SDL_EVENT_MOUSE_MOTION;
    mouse_x_ = (motion ? event.motion.x : event.button.x) * pixel_density;
    mouse_y_ = (motion ? event.motion.y : event.button.y) * pixel_density;
    if (motion) {
        move(mouse_x_, mouse_y_, (SDL_GetModState() & SDL_KMOD_ALT) != 0, hud);
    } else if (event.button.button == SDL_BUTTON_LEFT) {
        if (event.type == SDL_EVENT_MOUSE_BUTTON_DOWN)
            press(mouse_x_, mouse_y_, hud);
        else
            release();
    }
    return true;
}

bool HudLayoutEditor::key_event(
        const SDL_KeyboardEvent &key, const NativeHud &hud, const std::vector<std::string> &bind
) {
    const float step = (key.mod & SDL_KMOD_SHIFT) ? big_nudge_px : nudge_px;
    switch (key.scancode) {
        case SDL_SCANCODE_ESCAPE:
        case SDL_SCANCODE_RETURN:
            close();
            return true;
        case SDL_SCANCODE_LEFT:
            nudge(-step, 0, hud);
            return true;
        case SDL_SCANCODE_RIGHT:
            nudge(step, 0, hud);
            return true;
        case SDL_SCANCODE_UP:
            nudge(0, -step, hud);
            return true;
        case SDL_SCANCODE_DOWN:
            nudge(0, step, hud);
            return true;
        case SDL_SCANCODE_EQUALS:
        case SDL_SCANCODE_KP_PLUS:
            rescale(scale_step, hud);
            return true;
        case SDL_SCANCODE_MINUS:
        case SDL_SCANCODE_KP_MINUS:
            rescale(-scale_step, hud);
            return true;
        case SDL_SCANCODE_H:
        case SDL_SCANCODE_DELETE:
            toggle(selected_, hud);
            return true;
        case SDL_SCANCODE_TAB:
            select_next((key.mod & SDL_KMOD_SHIFT) ? -1 : 1);
            return true;
        default:
            break;
    }
    if (!key.repeat && std::find(bind.begin(), bind.end(), key_code(key.scancode)) != bind.end()) close();
    return true;
}

void HudLayoutEditor::select_next(int step) {
    const auto count = int(hud_editor_elements.size());
    int index = 0;
    for (int i = 0; i < count; ++i) {
        if (hud_editor_elements[size_t(i)].id == selected_) index = i;
    }
    selected_ = hud_editor_elements[size_t((index + step + count) % count)].id;
}

std::optional<std::string_view> HudLayoutEditor::element_at(float x, float y, const NativeHud &hud) const {
    // The smallest box under the pointer wins, so a label inside the chat's box can still be picked.
    std::optional<std::string_view> found;
    float smallest = 0;
    for (const auto &element : hud_editor_elements) {
        const auto &box = hud.layout_box(element.id);
        if (box.width <= 0 || !contains(box, x, y)) continue;
        const float area = box.width * box.height;
        if (!found || area < smallest) {
            found = element.id;
            smallest = area;
        }
    }
    return found;
}

void HudLayoutEditor::press(float x, float y, const NativeHud &hud) {
    if (click_button(x, y, hud) || contains(bar_box_, x, y)) return;
    const auto &selected_box = hud.layout_box(selected_);
    const bool on_handle = selected_box.width > 0 && std::abs(x - (selected_box.x + selected_box.width)) < handle_px
                           && std::abs(y - (selected_box.y + selected_box.height)) < handle_px;
    if (!on_handle) {
        const auto id = element_at(x, y, hud);
        if (!id) return;
        selected_ = *id;
    }
    const auto &place = hud.preferences().layout[hud_index(selected_)];
    drag_ = Drag{selected_, on_handle, x, y, hud.layout_box(selected_), place ? place->scale : 1.};
}

void HudLayoutEditor::move(float x, float y, bool free, const NativeHud &hud) {
    if (!drag_) return;
    const auto &drag = *drag_;
    if (drag.resize) {
        const unsigned anchor = hud_place_from_box(drag.start_box, float(width_), float(height_), true, 1).at("a");
        const auto [point_x, point_y] = anchor_point(drag.start_box, anchor);
        const double from = std::max(1.f, std::hypot(drag.start_x - point_x, drag.start_y - point_y));
        const double to = std::hypot(x - point_x, y - point_y);
        const double scale = std::clamp(drag.start_scale * to / from, .4, 3.);
        place_box(drag.id, scale_box(drag.start_box, anchor, scale / drag.start_scale), scale, hud, false);
        return;
    }
    HudRect box = drag.start_box;
    box.x += x - drag.start_x;
    box.y += y - drag.start_y;
    vertical_guide_ = horizontal_guide_ = false;
    if (snap_ && !free) {
        const auto snapped =
                snap_box(box, float(width_), float(height_), grid_px_, grid_px_ * snap_css_px / grid_css_px);
        box = snapped.box;
        vertical_guide_ = snapped.vertical_guide;
        horizontal_guide_ = snapped.horizontal_guide;
    }
    place_box(drag.id, box, drag.start_scale, hud, false);
}

void HudLayoutEditor::release() {
    if (!drag_) return;
    drag_.reset();
    vertical_guide_ = horizontal_guide_ = false;
    apply({{"hudLayoutWeb", settings_.at("hudLayoutWeb")}, {"hudLayout", settings_.at("hudLayout")}});
}

Json HudLayoutEditor::current_place(std::string_view id, const NativeHud &hud) const {
    const auto *element = editor_element(id);
    const auto &place = hud.preferences().layout[hud_index(id)];
    const bool on = !place || place->visible;
    if (element && element->web) {
        auto entry = settings_.at("hudLayoutWeb").value(std::string(id), Json::object());
        entry["on"] = on;
        return entry;
    }
    return hud_place_from_box(hud.layout_box(id), float(width_), float(height_), on, place ? place->scale : 1.);
}

void HudLayoutEditor::set_place(std::string_view id, const Json &place, bool save) {
    const auto *element = editor_element(id);
    if (!element) return;
    auto &legacy = settings_["hudLayout"];
    for (auto entry = legacy.begin(); entry != legacy.end();) {
        // A place set here replaces one from v0.5.1's editor.
        if (element->web && canonical_hud_id(entry.key()) == canonical_hud_id(id))
            entry = legacy.erase(entry);
        else
            ++entry;
    }
    if (element->web)
        settings_["hudLayoutWeb"][std::string(id)] = place;
    else
        legacy[std::string(id)] = place;
    preview_ = true;
    if (save) apply({{"hudLayoutWeb", settings_.at("hudLayoutWeb")}, {"hudLayout", legacy}});
}

void HudLayoutEditor::place_box(
        std::string_view id, const HudRect &box, double scale, const NativeHud &hud, bool save
) {
    const auto &place = hud.preferences().layout[hud_index(id)];
    const bool on = !place || place->visible;
    set_place(id, hud_place_from_box(box, float(width_), float(height_), on, scale), save);
}

void HudLayoutEditor::nudge(float dx, float dy, const NativeHud &hud) {
    HudRect box = hud.layout_box(selected_);
    if (box.width <= 0) return;
    box.x += dx;
    box.y += dy;
    const auto &place = hud.preferences().layout[hud_index(selected_)];
    place_box(selected_, box, place ? place->scale : 1., hud, true);
}

void HudLayoutEditor::rescale(double step, const NativeHud &hud) {
    const HudRect box = hud.layout_box(selected_);
    if (box.width <= 0) return;
    const auto &place = hud.preferences().layout[hud_index(selected_)];
    const double from = place ? place->scale : 1.;
    const double to = std::clamp(std::round((from + step) * 100) / 100, .4, 3.);
    const unsigned anchor = hud_place_from_box(box, float(width_), float(height_), true, 1).at("a");
    place_box(selected_, scale_box(box, anchor, to / from), to, hud, true);
}

void HudLayoutEditor::toggle(std::string_view id, const NativeHud &hud) {
    auto place = current_place(id, hud);
    const bool on = !place.value("on", true);
    const auto *element = editor_element(id);
    if (element && !element->web) {
        // Native-only elements are hidden with an anchored entry of their own, at the place they show now.
        place = hud_place_from_box(hud.layout_box(id), float(width_), float(height_), on, place.value("s", 1.));
    }
    place["on"] = on;
    set_place(id, place, false);
    Json patch = {{"hudLayoutWeb", settings_.at("hudLayoutWeb")}, {"hudLayout", settings_.at("hudLayout")}};
    if (const char *setting = hud_element_setting(id)) patch[setting] = on;
    apply(patch);
}

void HudLayoutEditor::apply(const Json &patch) {
    try {
        settings_ = patch_settings(settings_, patch, false);
        patch_ = patch_ ? *patch_ : Json::object();
        patch_->update(patch);
        preview_ = true;
    } catch (const std::exception &error) {
        say(std::string("Couldn't save the layout: ") + error.what());
    }
}

void HudLayoutEditor::say(std::string text) {
    message_ = std::move(text);
    message_until_ns_ = SDL_GetTicksNS() + message_ns;
}

bool HudLayoutEditor::click_button(float x, float y, const NativeHud &hud) {
    for (const auto &button : buttons_) {
        if (!contains(button.box, x, y)) continue;
        run_action(button.action, hud);
        return true;
    }
    return false;
}

void HudLayoutEditor::run_action(const std::string &action, const NativeHud &hud) {
    if (action == "done") return close();
    if (action == "bar") {
        bar_at_bottom_ = !bar_at_bottom_;
        return;
    }
    if (action == "snap") {
        snap_ = !snap_;
        return;
    }
    if (action.starts_with("element:")) {
        const auto id = std::string_view(action).substr(8);
        for (const auto &element : hud_editor_elements) {
            if (element.id != id) continue;
            if (selected_ == element.id) toggle(element.id, hud);
            selected_ = element.id;
        }
        return;
    }
    if (action.starts_with("preset:")) {
        apply(hud_preset(std::string_view(action).substr(7)));
        return;
    }
    if (action == "scale:up" || action == "scale:down") {
        const double scale = settings_.at("hudScale").get<double>() + (action == "scale:up" ? 5 : -5);
        apply({{"hudScale", std::clamp(scale, 50., 175.)}});
        return;
    }
    if (action == "copy") {
        const auto code = encode_hud_layout(settings_);
        say(SDL_SetClipboardText(code.c_str()) ? "Layout code copied" : "Couldn't copy the layout code");
        return;
    }
    if (action == "paste") {
        char *text = SDL_GetClipboardText();
        const auto patch = decode_hud_layout(text ? text : "");
        SDL_free(text);
        if (!patch) return say("The clipboard has no layout code (bhl1.)");
        auto full = *patch;
        full["hudLayout"] = Json::object();
        apply(full);
        say("Layout imported");
    }
}

std::string HudLayoutEditor::info_line(const NativeHud &hud) const {
    const auto *element = editor_element(selected_);
    if (!element) return "";
    const auto &place = hud.preferences().layout[hud_index(selected_)];
    char line[192];
    if (!place || !place->placed) {
        std::snprintf(
                line,
                sizeof(line),
                "%.*s%s | built-in place | size %.0f%%",
                int(element->label.size()),
                element->label.data(),
                place && !place->visible ? " (hidden)" : "",
                (place ? place->scale : 1) * 100
        );
        return line;
    }
    std::snprintf(
            line,
            sizeof(line),
            "%.*s%s | anchor %s | x %.1f%% | y %.1f%% | size %.0f%%",
            int(element->label.size()),
            element->label.data(),
            place->visible ? "" : " (hidden)",
            anchor_names[std::min(place->anchor, 8u)],
            place->x * 100,
            place->y * 100,
            place->scale * 100
    );
    return line;
}

void HudLayoutEditor::draw(NativeHud &hud, int width, int height, float display_scale, std::string_view done_key) {
    width_ = width;
    height_ = height;
    grid_px_ = grid_css_px * std::max(1.f, display_scale);
    const HudGeometry geometry(width, height, 100);
    hud.overlay_begin(width, height, 100);
    draw_outlines(hud, geometry.scale);
    buttons_.clear();
    draw_bar(hud, geometry.width, geometry.height, geometry.scale, done_key);
    hud.overlay_end(width, height);
}

void HudLayoutEditor::draw_outlines(NativeHud &hud, float scale) {
    constexpr float grid_step_css_px = 40;
    const float step = grid_step_css_px * grid_px_ / grid_css_px;
    for (float x = step; x < float(width_); x += step)
        hud.overlay_rect(x / scale, 0, 1 / scale, float(height_) / scale, grid_line);
    for (float y = step; y < float(height_); y += step)
        hud.overlay_rect(0, y / scale, float(width_) / scale, 1 / scale, grid_line);
    if (vertical_guide_) hud.overlay_rect(float(width_ / 2) / scale, 0, 1 / scale, float(height_) / scale, amber);
    if (horizontal_guide_) hud.overlay_rect(0, float(height_ / 2) / scale, float(width_) / scale, 1 / scale, amber);
    for (const auto &element : hud_editor_elements) {
        const auto &box = hud.layout_box(element.id);
        if (box.width <= 0 || element.id == selected_) continue;
        const auto &place = hud.preferences().layout[hud_index(element.id)];
        outline(hud, box, scale, 1, place && !place->visible ? outline_off : outline_on);
    }
    const auto &box = hud.layout_box(selected_);
    if (box.width <= 0) return;
    outline(hud, box, scale, 2, amber);
    hud.overlay_rect((box.x + box.width) / scale - 5, (box.y + box.height) / scale - 5, 10, 10, amber);
    if (const auto *element = editor_element(selected_))
        hud.overlay_text(box.x / scale, box.y / scale - 17, element->label, 11, amber);
}

float HudLayoutEditor::draw_button(
        NativeHud &hud, float x, float y, std::string_view label, std::string action, float scale, bool on
) {
    const float width = hud.overlay_text_width(label, button_text) + 2 * button_padding;
    const HudRect box{x * scale, y * scale, width * scale, button_height * scale};
    const bool hover = contains(box, mouse_x_, mouse_y_);
    hud.overlay_rect(x, y, width, button_height, hover ? button_hover : button_fill);
    outline(hud, box, scale, 1, on ? amber : button_line);
    hud.overlay_text(
            x + button_padding, y + (button_height - button_text * 1.3f) / 2, label, button_text, on ? amber : cream
    );
    buttons_.push_back({box, std::move(action)});
    return width;
}

float HudLayoutEditor::draw_bar_head(
        NativeHud &hud, float left, float top, float width, float scale, std::string_view done_key
) {
    hud.overlay_text(left, top + 4, "HUD LAYOUT", 15, amber);
    hud.overlay_text(
            left + 120,
            top + 7,
            "Drag to move | corner to resize | arrows nudge (Shift x10) | +/- size | H hide | Tab next | Alt: no snap",
            11,
            dim
    );
    std::string done = "Done";
    if (!done_key.empty()) done += " (" + std::string(done_key) + ")";
    const float done_width = hud.overlay_text_width(done, button_text) + 2 * button_padding;
    draw_button(hud, left + width - done_width, top, done, "done", scale, true);
    const float bar_width = hud.overlay_text_width(bar_at_bottom_ ? "Bar to top" : "Bar to bottom", button_text);
    draw_button(
            hud,
            left + width - done_width - button_gap - bar_width - 2 * button_padding,
            top,
            bar_at_bottom_ ? "Bar to top" : "Bar to bottom",
            "bar",
            scale
    );
    return top + button_height + row_gap;
}

// How many rows the element buttons take across `width`.
unsigned HudLayoutEditor::chip_rows(NativeHud &hud, float width) const {
    unsigned rows = 1;
    float x = 0;
    for (const auto &element : hud_editor_elements) {
        const float chip = hud.overlay_text_width(element.label, button_text) + 2 * button_padding;
        if (x > 0 && x + chip > width) {
            x = 0;
            ++rows;
        }
        x += chip + button_gap;
    }
    return rows;
}

float HudLayoutEditor::draw_chips(NativeHud &hud, float left, float top, float width, float scale) {
    float x = left;
    for (const auto &element : hud_editor_elements) {
        const float chip = hud.overlay_text_width(element.label, button_text) + 2 * button_padding;
        if (x > left && x + chip > left + width) {
            x = left;
            top += button_height + button_gap;
        }
        const auto &place = hud.preferences().layout[hud_index(element.id)];
        const bool on = !place || place->visible;
        const float drawn = draw_button(
                hud, x, top, element.label, "element:" + std::string(element.id), scale, element.id == selected_
        );
        if (!on) hud.overlay_rect(x + button_padding, top + button_height / 2, drawn - 2 * button_padding, 1, dim);
        x += drawn + button_gap;
    }
    return top + button_height + row_gap;
}

float HudLayoutEditor::draw_tools(NativeHud &hud, float left, float top, float scale) {
    float x = left;
    hud.overlay_text(x, top + 6, "Presets", 12, dim);
    x += 64;
    for (size_t i = 0; i < hud_preset_ids.size(); ++i) {
        const bool on = hud_layout_is_preset(settings_, hud_preset_ids[i]);
        x += draw_button(hud, x, top, hud_preset_labels[i], "preset:" + std::string(hud_preset_ids[i]), scale, on);
        x += button_gap;
    }
    x += draw_button(hud, x + 12, top, snap_ ? "Snap: on" : "Snap: off", "snap", scale, snap_) + 12 + button_gap;
    x += draw_button(hud, x, top, "Reset to default", "preset:classic", scale) + 24;
    hud.overlay_text(x, top + 6, "HUD scale", 12, dim);
    x += 82;
    x += draw_button(hud, x, top, "-", "scale:down", scale) + button_gap;
    char percent[16];
    std::snprintf(percent, sizeof(percent), "%.0f%%", settings_.at("hudScale").get<double>());
    hud.overlay_text(x, top + 6, percent, 12, cream);
    x += 44;
    x += draw_button(hud, x, top, "+", "scale:up", scale) + 24;
    x += draw_button(hud, x, top, "Copy layout code", "copy", scale) + button_gap;
    x += draw_button(hud, x, top, "Paste layout code", "paste", scale) + 12;
    if (!message_.empty() && SDL_GetTicksNS() < message_until_ns_) hud.overlay_text(x, top + 6, message_, 12, amber);
    return top + button_height;
}

void HudLayoutEditor::draw_bar(
        NativeHud &hud, float units_width, float units_height, float scale, std::string_view done_key
) {
    constexpr float info_height = 20;
    const float width = std::min(bar_widest, units_width - 2 * bar_margin);
    const float left = (units_width - width) / 2;
    const float chips = float(chip_rows(hud, width - 2 * bar_padding));
    const float height = 2 * bar_padding + button_height + 2 * row_gap + chips * button_height
                         + (chips - 1) * button_gap + info_height + button_height;
    // The bar keeps clear of the selected element: it moves to the other edge when it would cover it.
    const HudRect top_bar{left * scale, bar_margin * scale, width * scale, height * scale};
    const auto &selected = hud.layout_box(selected_);
    const bool covers = selected.width > 0 && selected.x < top_bar.x + top_bar.width
                        && selected.x + selected.width > top_bar.x && selected.y < top_bar.y + top_bar.height;
    const bool bottom = bar_at_bottom_ != covers;
    const float top = bottom ? units_height - bar_margin - height : bar_margin;
    bar_box_ = {left * scale, top * scale, width * scale, height * scale};
    hud.overlay_rect(left, top, width, height, panel_fill);
    float y = draw_bar_head(hud, left + bar_padding, top + bar_padding, width - 2 * bar_padding, scale, done_key);
    y = draw_chips(hud, left + bar_padding, y, width - 2 * bar_padding, scale);
    hud.overlay_text(left + bar_padding, y, info_line(hud), 12, cream);
    y += info_height;
    draw_tools(hud, left + bar_padding, y, scale);
}
}  // namespace native
