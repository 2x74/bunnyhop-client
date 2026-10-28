#pragma once
#include "hud_text.hpp"
#include "hud_geometry.hpp"
#include "name_tags.hpp"
#include <array>

namespace native {
enum class ToastTone { notice, error, unlock, whisper };

struct Toast {
    HudLabel<192> text;
    HudLabel<80> title;
    ToastTone tone = ToastTone::notice;
    double started = 0;
    double expires = 0;
};

class Toasts {
public:
    std::array<Toast, 5> items;
    size_t count = 0;

    void clear() { count = 0; }

    void
    push(std::string_view text,
         double now,
         double lifetime = 3,
         ToastTone tone = ToastTone::notice,
         std::string_view title = {}) {
        if (text.empty()) return;
        if (count && items[count - 1].text.view() == text && items[count - 1].expires > now) {
            items[count - 1].expires = now + lifetime;
            return;
        }
        if (count == items.size()) {
            std::move(items.begin() + 1, items.end(), items.begin());
            --count;
        }
        auto &toast = items[count++];
        toast.text.assign(text);
        toast.title.assign(title);
        toast.started = now;
        toast.expires = now + std::clamp(lifetime, 1., 60.);
        toast.tone = tone;
    }
};

template <class Hud>
void draw_toasts(Hud &hud, int width, int height, float percent, const Toasts &toasts, double now) {
    const HudGeometry geometry(width, height, percent);
    hud.overlay_begin(width, height, percent);
    float y = geometry.height * .12f;
    for (size_t i = toasts.count; i > 0; --i) {
        const auto &toast = toasts.items[i - 1];
        if (now >= toast.expires) continue;
        const float alpha = float(std::min({1., (now - toast.started) / .15, toast.expires - now}));
        const float x = geometry.width / 2 - 260;
        const NameColor tone = toast.tone == ToastTone::error     ? NameColor{1, .40f, .35f, alpha}
                               : toast.tone == ToastTone::whisper ? NameColor{.8f, .7f, 1, alpha}
                                                                  : NameColor{1, .71f, .24f, alpha};
        const float height = toast.title.empty() ? 42 : 67;
        hud.overlay_rect(x, y, 520, height, {.025f, .027f, .04f, alpha * .94f});
        hud.overlay_rect(x, y, 3, height, tone);
        if (!toast.title.empty()) hud.overlay_text(x + 15, y + 8, toast.title.view(), 14, tone);
        hud.overlay_text(x + 15, y + (toast.title.empty() ? 10 : 35), toast.text.view(), 13, {.94f, .91f, .86f, alpha});
        y += height + 6;
    }
    hud.overlay_end(width, height);
}
}  // namespace native
