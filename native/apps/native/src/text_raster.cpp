#include "text_raster.hpp"
#include "graphemes.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreText/CoreText.h>
#elif defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <d2d1.h>
#include <dwrite.h>
#include <wincodec.h>
#include <wrl/client.h>
#else
#include <pango/pangocairo.h>
#endif

namespace native {
namespace {
constexpr int max_width = 4096, max_height = 256, pad = 4;

TextBitmap bitmap(int width, int height) {
    TextBitmap out;
    if (width <= 0 || height <= 0 || width > max_width || height > max_height) return out;
    out.width = width;
    out.height = height;
    out.rgba.resize(size_t(width) * height * 4);
    return out;
}

// Renderers produce coverage (or premultiplied BGRA). HUD uses SRC_ALPHA, so
// keep white RGB independent of alpha to avoid multiplying antialiasing twice.
void white(TextBitmap &out) {
    for (size_t i = 0; i < out.rgba.size(); i += 4)
        out.rgba[i] = out.rgba[i + 1] = out.rgba[i + 2] = 255;
}
}  // namespace

TextBitmap raster_text(const std::string &text, float size, bool tabular) {
    if (text.empty() || text.size() > 4096 || text.find('\0') != std::string::npos || !std::isfinite(size)) return {};
    size = std::clamp(size, 8.f, 192.f);
#if defined(__APPLE__)
    const auto string = CFStringCreateWithBytes(
            kCFAllocatorDefault,
            reinterpret_cast<const UInt8 *>(text.data()),
            CFIndex(text.size()),
            kCFStringEncodingUTF8,
            false
    );
    if (!string) return {};
    auto font = CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, size, nullptr);
    if (!font) {
        CFRelease(string);
        return {};
    }
    if (tabular) {
        const int feature = kNumberSpacingType, selector = kMonospacedNumbersSelector;
        const auto type = CFNumberCreate(nullptr, kCFNumberIntType, &feature);
        const auto choice = CFNumberCreate(nullptr, kCFNumberIntType, &selector);
        const void *keys[] = {kCTFontFeatureTypeIdentifierKey, kCTFontFeatureSelectorIdentifierKey};
        const void *values[] = {type, choice};
        const auto setting = CFDictionaryCreate(
                nullptr, keys, values, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks
        );
        const void *settings[] = {setting};
        const auto features = CFArrayCreate(nullptr, settings, 1, &kCFTypeArrayCallBacks);
        const void *attribute_keys[] = {kCTFontFeatureSettingsAttribute};
        const void *attribute_values[] = {features};
        const auto attributes = CFDictionaryCreate(
                nullptr,
                attribute_keys,
                attribute_values,
                1,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks
        );
        const auto descriptor = CTFontDescriptorCreateWithAttributes(attributes);
        const auto configured = CTFontCreateCopyWithAttributes(font, size, nullptr, descriptor);
        CFRelease(font);
        font = configured;
        CFRelease(descriptor);
        CFRelease(attributes);
        CFRelease(features);
        CFRelease(setting);
        CFRelease(choice);
        CFRelease(type);
    }
    const auto color = CGColorCreateGenericRGB(1, 1, 1, 1);
    const void *keys[] = {kCTFontAttributeName, kCTForegroundColorAttributeName};
    const void *values[] = {font, color};
    const auto attrs = CFDictionaryCreate(
            kCFAllocatorDefault, keys, values, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks
    );
    const auto attributed = CFAttributedStringCreate(kCFAllocatorDefault, string, attrs);
    const auto line = CTLineCreateWithAttributedString(attributed);
    CGFloat ascent = 0, descent = 0, leading = 0;
    const double advance = CTLineGetTypographicBounds(line, &ascent, &descent, &leading);
    const CGRect bounds = CTLineGetBoundsWithOptions(line, kCTLineBoundsUseGlyphPathBounds);
    const double left = std::min(0., double(bounds.origin.x)), right = std::max(advance, double(CGRectGetMaxX(bounds)));
    const int width = std::min(max_width, int(std::ceil(right - left)) + pad * 2),
              height = std::min(max_height, int(std::ceil(ascent + descent + leading)) + pad * 2);
    auto out = bitmap(width, height);
    const auto space = CGColorSpaceCreateDeviceRGB();
    const auto context =
            out.rgba.empty()
                    ? nullptr
                    : CGBitmapContextCreate(
                              out.rgba.data(),
                              width,
                              height,
                              8,
                              size_t(width) * 4,
                              space,
                              CGBitmapInfo(kCGImageAlphaPremultipliedLast) | CGBitmapInfo(kCGBitmapByteOrder32Big)
                      );
    if (context) {
        CGContextSetTextMatrix(context, CGAffineTransformIdentity);
        CGContextSetTextPosition(context, pad - left, pad + descent);
        CTLineDraw(line, context);
        CGContextRelease(context);
        // CGBitmapContext already exposes top-down scanlines for this bitmap.
        // HUD UV0 is the top edge; reversing these rows would invert every glyph.
        white(out);
    } else
        out = {};
    CGColorSpaceRelease(space);
    CFRelease(line);
    CFRelease(attributed);
    CFRelease(attrs);
    CGColorRelease(color);
    CFRelease(font);
    CFRelease(string);
    return out;
#elif defined(_WIN32)
    using Microsoft::WRL::ComPtr;
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), int(text.size()), nullptr, 0);
    if (count <= 0) return {};
    std::wstring wide(size_t(count), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), int(text.size()), wide.data(), count);
    // The client already initializes COM for WebView2. A standalone caller also
    // works: balance only our own successful initialization, never another owner's.
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    struct ComScope {
        HRESULT result;

        ~ComScope() {
            if (SUCCEEDED(result)) CoUninitialize();
        }
    } scope{initialized};

    ComPtr<IDWriteFactory> write;
    ComPtr<ID2D1Factory> draw;
    ComPtr<IWICImagingFactory> imaging;
    if (FAILED(DWriteCreateFactory(
                DWRITE_FACTORY_TYPE_SHARED,
                __uuidof(IDWriteFactory),
                reinterpret_cast<IUnknown **>(write.GetAddressOf())
        ))
        || FAILED(D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, draw.GetAddressOf()))
        || FAILED(CoCreateInstance(
                CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(imaging.GetAddressOf())
        )))
        return {};
    ComPtr<IDWriteTextFormat> format;
    if (FAILED(write->CreateTextFormat(
                L"Segoe UI",
                nullptr,
                DWRITE_FONT_WEIGHT_NORMAL,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                size,
                L"",
                &format
        )))
        return {};
    format->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
    ComPtr<IDWriteTextLayout> layout;
    if (FAILED(write->CreateTextLayout(
                wide.data(),
                UINT32(wide.size()),
                format.Get(),
                float(max_width - pad * 2),
                float(max_height - pad * 2),
                &layout
        )))
        return {};
    if (tabular) {
        ComPtr<IDWriteTypography> typography;
        if (SUCCEEDED(write->CreateTypography(&typography))) {
            typography->AddFontFeature({DWRITE_FONT_FEATURE_TAG_TABULAR_FIGURES, 1});
            layout->SetTypography(typography.Get(), {0, UINT32(wide.size())});
        }
    }
    DWRITE_TEXT_METRICS metrics{};
    DWRITE_OVERHANG_METRICS overhang{};
    if (FAILED(layout->GetMetrics(&metrics)) || FAILED(layout->GetOverhangMetrics(&overhang))) return {};
    const int width = std::min(
                      max_width,
                      int(std::ceil(
                              metrics.widthIncludingTrailingWhitespace + std::max(0.f, overhang.left)
                              + std::max(0.f, overhang.right)
                      )) + pad * 2
              ),
              height = std::min(
                      max_height,
                      int(std::ceil(metrics.height + std::max(0.f, overhang.top) + std::max(0.f, overhang.bottom)))
                              + pad * 2
              );
    auto out = bitmap(width, height);
    if (out.rgba.empty()) return {};
    ComPtr<IWICBitmap> image;
    ComPtr<ID2D1RenderTarget> target;
    ComPtr<ID2D1SolidColorBrush> brush;
    if (FAILED(imaging->CreateBitmap(
                UINT(width), UINT(height), GUID_WICPixelFormat32bppPBGRA, WICBitmapCacheOnLoad, &image
        )))
        return {};
    const auto props = D2D1::RenderTargetProperties(
            D2D1_RENDER_TARGET_TYPE_SOFTWARE,
            D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED),
            96,
            96
    );
    if (FAILED(draw->CreateWicBitmapRenderTarget(image.Get(), props, &target))
        || FAILED(target->CreateSolidColorBrush(D2D1::ColorF(1, 1, 1, 1), &brush)))
        return {};
    target->SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
    target->BeginDraw();
    target->Clear(D2D1::ColorF(0, 0, 0, 0));
    target->DrawTextLayout(
            D2D1::Point2F(float(pad) + std::max(0.f, overhang.left), float(pad) + std::max(0.f, overhang.top)),
            layout.Get(),
            brush.Get()
    );
    if (FAILED(target->EndDraw())) return {};
    if (FAILED(image->CopyPixels(nullptr, UINT(width * 4), UINT(out.rgba.size()), out.rgba.data()))) return {};
    white(out);
    return out;
#else
    if (!g_utf8_validate(text.data(), gssize(text.size()), nullptr)) return {};
    auto *surface = cairo_image_surface_create(CAIRO_FORMAT_A8, 1, 1);
    auto *context = cairo_create(surface);
    auto *layout = pango_cairo_create_layout(context);
    auto *font = pango_font_description_new();
    pango_font_description_set_family(font, "sans-serif");
    pango_font_description_set_absolute_size(font, size * PANGO_SCALE);
    pango_layout_set_font_description(layout, font);
    pango_layout_set_text(layout, text.data(), int(text.size()));
    pango_layout_set_single_paragraph_mode(layout, TRUE);
    if (tabular) {
        auto *attributes = pango_attr_list_new();
        pango_attr_list_insert(attributes, pango_attr_font_features_new("tnum=1"));
        pango_layout_set_attributes(layout, attributes);
        pango_attr_list_unref(attributes);
    }
    PangoRectangle ink{}, logical{};
    pango_layout_get_pixel_extents(layout, &ink, &logical);
    const int left = std::min(ink.x, logical.x), top = std::min(ink.y, logical.y);
    const int width = std::min(max_width, std::max(ink.x + ink.width, logical.x + logical.width) - left + pad * 2),
              height = std::min(max_height, std::max(ink.y + ink.height, logical.y + logical.height) - top + pad * 2);
    auto out = bitmap(width, height);
    cairo_destroy(context);
    cairo_surface_destroy(surface);
    if (!out.rgba.empty()) {
        surface = cairo_image_surface_create(CAIRO_FORMAT_A8, width, height);
        context = cairo_create(surface);
        cairo_set_source_rgba(context, 1, 1, 1, 1);
        cairo_move_to(context, pad - left, pad - top);
        pango_cairo_update_layout(context, layout);
        pango_cairo_show_layout(context, layout);
        cairo_surface_flush(surface);
        if (cairo_status(context) == CAIRO_STATUS_SUCCESS && cairo_surface_status(surface) == CAIRO_STATUS_SUCCESS) {
            const auto *pixels = cairo_image_surface_get_data(surface);
            const int stride = cairo_image_surface_get_stride(surface);
            for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++)
                    out.rgba[(size_t(y) * width + x) * 4 + 3] = pixels[y * stride + x];
            white(out);
        } else
            out = {};
        cairo_destroy(context);
        cairo_surface_destroy(surface);
    }
    pango_font_description_free(font);
    g_object_unref(layout);
    return out;
#endif
}

std::vector<TextCaret> text_carets(const std::string &text, float size) {
    if (text.size() > 4096 || !std::isfinite(size)) return {};
    size = std::clamp(size, 8.f, 96.f);
    const auto boundaries = grapheme_boundaries(text);
    std::vector<TextCaret> out;
    if (text.empty()) return {{0, float(pad)}};
    const auto points = unicode_points(text);
    std::vector<std::pair<size_t, size_t>> utf16{{0, 0}};
    size_t units = 0;
    for (const auto &p : points) {
        if (p.cp == 0xfffd && p.end - p.byte == 1 && uint8_t(text[p.byte]) >= 128) return {};
        units += p.cp > 0xffff ? 2 : 1;
        utf16.push_back({p.end, units});
    }
    auto index = [&](size_t byte) {
        const auto at =
                std::lower_bound(utf16.begin(), utf16.end(), byte, [](const auto &a, size_t b) { return a.first < b; });
        return at == utf16.end() ? units : at->second;
    };
#if defined(__APPLE__)
    const auto string = CFStringCreateWithBytes(
            kCFAllocatorDefault,
            reinterpret_cast<const UInt8 *>(text.data()),
            CFIndex(text.size()),
            kCFStringEncodingUTF8,
            false
    );
    if (!string) return {};
    const auto font = CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, size, nullptr);
    if (!font) {
        CFRelease(string);
        return {};
    }
    const void *keys[] = {kCTFontAttributeName};
    const void *values[] = {font};
    const auto attrs = CFDictionaryCreate(
            kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks
    );
    const auto attributed = CFAttributedStringCreate(kCFAllocatorDefault, string, attrs);
    const auto line = CTLineCreateWithAttributedString(attributed);
    const auto bounds = CTLineGetBoundsWithOptions(line, kCTLineBoundsUseGlyphPathBounds);
    const float origin = float(pad - std::min(0., double(bounds.origin.x)));
    for (const auto byte : boundaries) {
        CGFloat secondary = 0;
        const auto primary = CTLineGetOffsetForStringIndex(line, CFIndex(index(byte)), &secondary);
        out.push_back({byte, origin + float(primary)});
        if (std::abs(primary - secondary) > .5) out.push_back({byte, origin + float(secondary), true});
    }
    CFRelease(line);
    CFRelease(attributed);
    CFRelease(attrs);
    CFRelease(font);
    CFRelease(string);
#elif defined(_WIN32)
    using Microsoft::WRL::ComPtr;
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), int(text.size()), nullptr, 0);
    if (count <= 0) return {};
    std::wstring wide(size_t(count), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), int(text.size()), wide.data(), count);
    ComPtr<IDWriteFactory> factory;
    if (FAILED(DWriteCreateFactory(
                DWRITE_FACTORY_TYPE_SHARED,
                __uuidof(IDWriteFactory),
                reinterpret_cast<IUnknown **>(factory.GetAddressOf())
        )))
        return {};
    ComPtr<IDWriteTextFormat> format;
    ComPtr<IDWriteTextLayout> layout;
    if (FAILED(factory->CreateTextFormat(
                L"Segoe UI",
                nullptr,
                DWRITE_FONT_WEIGHT_NORMAL,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                size,
                L"",
                &format
        )))
        return {};
    format->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
    if (FAILED(factory->CreateTextLayout(
                wide.data(),
                UINT32(wide.size()),
                format.Get(),
                float(max_width - pad * 2),
                float(max_height - pad * 2),
                &layout
        )))
        return {};
    DWRITE_OVERHANG_METRICS overhang{};
    layout->GetOverhangMetrics(&overhang);
    for (const auto byte : boundaries) {
        FLOAT x = 0, y = 0;
        DWRITE_HIT_TEST_METRICS metrics{};
        if (SUCCEEDED(layout->HitTestTextPosition(UINT32(index(byte)), FALSE, &x, &y, &metrics))) {
            const float origin = float(pad) + std::max(0.f, overhang.left);
            out.push_back({byte, origin + x});
            if (byte > 0) {
                FLOAT trailing = 0, ty = 0;
                DWRITE_HIT_TEST_METRICS prior{};
                if (SUCCEEDED(layout->HitTestTextPosition(UINT32(index(byte) - 1), TRUE, &trailing, &ty, &prior))
                    && std::abs(trailing - x) > .5f)
                    out.push_back({byte, origin + trailing, true});
            }
        }
    }
#else
    (void)index;
    if (!g_utf8_validate(text.data(), gssize(text.size()), nullptr)) return {};
    auto *surface = cairo_image_surface_create(CAIRO_FORMAT_A8, 1, 1);
    auto *context = cairo_create(surface);
    auto *layout = pango_cairo_create_layout(context);
    auto *font = pango_font_description_new();
    pango_font_description_set_family(font, "sans-serif");
    pango_font_description_set_absolute_size(font, size * PANGO_SCALE);
    pango_layout_set_font_description(layout, font);
    pango_layout_set_text(layout, text.data(), int(text.size()));
    pango_layout_set_single_paragraph_mode(layout, TRUE);
    PangoRectangle ink{}, logical{};
    pango_layout_get_pixel_extents(layout, &ink, &logical);
    const float origin = float(pad - std::min(ink.x, logical.x));
    for (const auto byte : boundaries) {
        PangoRectangle strong{}, weak{};
        pango_layout_get_cursor_pos(layout, int(byte), &strong, &weak);
        out.push_back({byte, origin + float(strong.x) / PANGO_SCALE});
        if (std::abs(strong.x - weak.x) > PANGO_SCALE / 2)
            out.push_back({byte, origin + float(weak.x) / PANGO_SCALE, true});
    }
    pango_font_description_free(font);
    g_object_unref(layout);
    cairo_destroy(context);
    cairo_surface_destroy(surface);
#endif
    return out;
}

std::vector<TextRangeBox> text_range_boxes(const std::string &text, float size, size_t begin, size_t end) {
    if (text.empty() || text.size() > 4096 || begin >= end || end > text.size() || !std::isfinite(size)) return {};
    size = std::clamp(size, 8.f, 96.f);
    std::vector<TextRangeBox> out;
    const auto points = unicode_points(text);
    size_t first = 0, last = 0;
    for (const auto &p : points) {
        if (p.byte < begin) first += p.cp > 0xffff ? 2 : 1;
        if (p.byte < end) last += p.cp > 0xffff ? 2 : 1;
    }
#if defined(__APPLE__)
    const auto string = CFStringCreateWithBytes(
            kCFAllocatorDefault,
            reinterpret_cast<const UInt8 *>(text.data()),
            CFIndex(text.size()),
            kCFStringEncodingUTF8,
            false
    );
    if (!string) return {};
    const auto font = CTFontCreateUIFontForLanguage(kCTFontUIFontSystem, size, nullptr);
    if (!font) {
        CFRelease(string);
        return {};
    }
    const void *keys[] = {kCTFontAttributeName};
    const void *values[] = {font};
    const auto attrs = CFDictionaryCreate(
            kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks
    );
    const auto attributed = CFAttributedStringCreate(kCFAllocatorDefault, string, attrs);
    const auto line = CTLineCreateWithAttributedString(attributed);
    const auto bounds = CTLineGetBoundsWithOptions(line, kCTLineBoundsUseGlyphPathBounds);
    const float origin = float(pad - std::min(0., double(bounds.origin.x)));
    const auto runs = CTLineGetGlyphRuns(line);
    for (CFIndex i = 0; i < CFArrayGetCount(runs); i++) {
        const auto run = static_cast<CTRunRef>(CFArrayGetValueAtIndex(runs, i));
        const auto count = CTRunGetGlyphCount(run);
        const auto range = CTRunGetStringRange(run);
        std::vector<CFIndex> indices(size_t(count), CFIndex(0));
        std::vector<CGPoint> positions(size_t(count), CGPoint{});
        std::vector<CGSize> advances(size_t(count), CGSize{});
        CTRunGetStringIndices(run, CFRangeMake(0, 0), indices.data());
        CTRunGetPositions(run, CFRangeMake(0, 0), positions.data());
        CTRunGetAdvances(run, CFRangeMake(0, 0), advances.data());
        for (CFIndex g = 0; g < count; g++) {
            auto next = range.location + range.length;
            for (const auto value : indices)
                if (value > indices[g]) next = std::min(next, value);
            if (size_t(indices[g]) >= last || size_t(next) <= first) continue;
            const float a = origin + float(positions[g].x), b = a + float(advances[g].width);
            if (a != b) out.push_back({std::min(a, b), std::abs(b - a)});
        }
    }
    CFRelease(line);
    CFRelease(attributed);
    CFRelease(attrs);
    CFRelease(font);
    CFRelease(string);
#elif defined(_WIN32)
    using Microsoft::WRL::ComPtr;
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), int(text.size()), nullptr, 0);
    if (count <= 0) return {};
    std::wstring wide(size_t(count), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), int(text.size()), wide.data(), count);
    ComPtr<IDWriteFactory> factory;
    ComPtr<IDWriteTextFormat> format;
    ComPtr<IDWriteTextLayout> layout;
    if (FAILED(DWriteCreateFactory(
                DWRITE_FACTORY_TYPE_SHARED,
                __uuidof(IDWriteFactory),
                reinterpret_cast<IUnknown **>(factory.GetAddressOf())
        ))
        || FAILED(factory->CreateTextFormat(
                L"Segoe UI",
                nullptr,
                DWRITE_FONT_WEIGHT_NORMAL,
                DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                size,
                L"",
                &format
        )))
        return {};
    format->SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
    if (FAILED(factory->CreateTextLayout(
                wide.data(),
                UINT32(wide.size()),
                format.Get(),
                float(max_width - pad * 2),
                float(max_height - pad * 2),
                &layout
        )))
        return {};
    DWRITE_OVERHANG_METRICS overhang{};
    layout->GetOverhangMetrics(&overhang);
    UINT32 needed = 0;
    layout->HitTestTextRange(
            UINT32(first), UINT32(last - first), float(pad) + std::max(0.f, overhang.left), 0, nullptr, 0, &needed
    );
    if (needed > 8192) return {};
    std::vector<DWRITE_HIT_TEST_METRICS> boxes(needed);
    if (needed
        && SUCCEEDED(layout->HitTestTextRange(
                UINT32(first),
                UINT32(last - first),
                float(pad) + std::max(0.f, overhang.left),
                0,
                boxes.data(),
                needed,
                &needed
        )))
        for (const auto &box : boxes)
            if (box.width > 0) out.push_back({box.left, box.width});
#else
    (void)first;
    (void)last;
    if (!g_utf8_validate(text.data(), gssize(text.size()), nullptr)) return {};
    auto *surface = cairo_image_surface_create(CAIRO_FORMAT_A8, 1, 1);
    auto *context = cairo_create(surface);
    auto *layout = pango_cairo_create_layout(context);
    auto *font = pango_font_description_new();
    pango_font_description_set_family(font, "sans-serif");
    pango_font_description_set_absolute_size(font, size * PANGO_SCALE);
    pango_layout_set_font_description(layout, font);
    pango_layout_set_text(layout, text.data(), int(text.size()));
    pango_layout_set_single_paragraph_mode(layout, TRUE);
    PangoRectangle ink{}, logical{};
    pango_layout_get_pixel_extents(layout, &ink, &logical);
    const float origin = float(pad - std::min(ink.x, logical.x));
    int *ranges = nullptr, count = 0;
    pango_layout_line_get_x_ranges(pango_layout_get_line_readonly(layout, 0), int(begin), int(end), &ranges, &count);
    for (int i = 0; i < count; i++)
        out.push_back(
                {origin + float(ranges[i * 2]) / PANGO_SCALE, float(ranges[i * 2 + 1] - ranges[i * 2]) / PANGO_SCALE}
        );
    g_free(ranges);
    pango_font_description_free(font);
    g_object_unref(layout);
    cairo_destroy(context);
    cairo_surface_destroy(surface);
#endif
    std::sort(out.begin(), out.end(), [](const auto &a, const auto &b) { return a.x < b.x; });
    std::vector<TextRangeBox> merged;
    for (const auto &box : out) {
        if (!merged.empty() && box.x <= merged.back().x + merged.back().width + .5f)
            merged.back().width = std::max(merged.back().width, box.x + box.width - merged.back().x);
        else
            merged.push_back(box);
    }
    return merged;
}

}  // namespace native
