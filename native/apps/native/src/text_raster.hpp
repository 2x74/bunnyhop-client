#pragma once
#include <cstdint>
#include <cstddef>
#include <string>
#include <vector>
namespace native {
// Top-down RGBA8, white glyphs with straight alpha and transparent background.
// System shaping/font fallback preserves Unicode, combining marks and RTL runs.
struct TextBitmap {int width=0,height=0;std::vector<uint8_t> rgba;};
struct TextCaret {size_t byte=0;float x=0;bool secondary=false;};
// Platform-shaped grapheme carets, including both visual affinities at bidi boundaries.
// Positions are pixel coordinates with bitmap padding included.
struct TextRangeBox {float x=0,width=0;};
// Visual coverage of a logical UTF8 range; bidi selections may have several boxes.
std::vector<TextRangeBox> text_range_boxes(const std::string &utf8,float pixel_size,size_t begin,size_t end);
std::vector<TextCaret> text_carets(const std::string &utf8,float pixel_size);
// Bounded: <=4096 UTF8 bytes, width <=4096, height <=256. Invalid input or a
// platform allocation failure returns an empty bitmap so HUD fallback is safe.
TextBitmap raster_text(const std::string &utf8,float pixel_size, bool tabular = false);
}
