// +paint's saved copy (paint_store.hpp): marks come back as drawn on the same BSP and never on another, the newest
// 256 per map, the 40 most recently painted maps, and a clear empties the saved copy.
#include "paint_store.hpp"
#include <cassert>
#include <cstdio>
#include <filesystem>
#include <string>

namespace {
using native_render::Paint;

Paint::Mark mark(float x, uint32_t model = 1, int32_t entity = -1) {
    Paint::Mark result;
    result.owner = {model, entity};
    result.color = {1, .25f, .25f, 1};
    result.count = 2;
    for (size_t face = 0; face < result.count; ++face)
        for (size_t corner = 0; corner < 4; ++corner) {
            result.faces[face].points[corner] = {x + float(corner), float(face) * 3.333f, -16.004f};
            result.faces[face].uv[corner] = {float(corner) * .25f, float(face) * .123456f};
        }
    return result;
}

std::vector<Paint::Mark> marks_of(const Paint &paint) {
    std::vector<Paint::Mark> result;
    paint.each_mark([&](const Paint::Mark &m) { result.push_back(m); });
    return result;
}

void test_round_trip_on_the_same_bsp_only() {
    auto paint = std::make_unique<Paint>();
    paint->restore(mark(10));
    paint->restore(mark(20, 4, 17));
    const auto document = nlohmann::json::parse(native::paint_document("abc", *paint).dump());
    auto back = std::make_unique<Paint>();
    assert(native::restore_paint(document, "abc", *back) == 2);
    const auto marks = marks_of(*back);
    assert(marks.size() == 2 && marks[1].owner.model == 4 && marks[1].owner.entity == 17 && marks[1].count == 2);
    // Points to 0.01 units, texture coordinates to 0.0001.
    assert(std::abs(marks[0].faces[1].points[2][1] - 3.33f) < 1e-5f);
    assert(std::abs(marks[0].faces[1].uv[0][1] - .1235f) < 1e-6f);
    assert(marks[0].color[1] == .25f);
    auto other = std::make_unique<Paint>();
    assert(native::restore_paint(document, "changed-bsp", *other) == 0 && other->count() == 0);
    assert(native::restore_paint(document, "", *other) == 0);
}

void test_newest_marks_win_and_broken_ones_are_dropped() {
    auto paint = std::make_unique<Paint>();
    for (int index = 0; index < 300; ++index)
        paint->restore(mark(float(index)));
    assert(paint->count() == Paint::capacity);
    auto document = native::paint_document("abc", *paint);
    // The ring keeps the newest 256, oldest first.
    assert(document["marks"][0]["f"][0][0] == 44 && document["marks"][255]["f"][0][0] == 299);
    document["marks"][3]["f"][0][2] = "x";
    document["marks"][4]["m"] = nlohmann::json::array({1});
    auto back = std::make_unique<Paint>();
    assert(native::restore_paint(document, "abc", *back) == 254);
}

void test_forty_most_recent_maps() {
    std::vector<std::string> index;
    for (int map = 0; map < 40; ++map)
        assert(native::touch_paint_index(index, "map" + std::to_string(map)).empty());
    assert(native::touch_paint_index(index, "map0").empty() && index.front() == "map0");
    const auto dropped = native::touch_paint_index(index, "map40");
    assert(dropped == std::vector<std::string>{"map1"} && index.size() == native::paint_store_maps);
}

void test_store_saves_after_a_change_and_a_clear_empties_it() {
    const auto directory = std::filesystem::temp_directory_path() / "bunnyhop-paint-store-test";
    std::filesystem::remove_all(directory);
    auto marked = std::make_unique<Paint>();
    {
        native::JsonFileWriter writer;
        native::PaintStore store(directory);
        // Nothing saved yet and nothing changed: nothing written.
        store.load("bhop_eazy", "abc", *marked);
        store.frame(*marked, 0, writer);
        writer.flush();
        assert(!std::filesystem::exists(directory / "bhop_eazy.json"));
        // A change (here a clear, then a mark), then the store writes (at most once a second).
        marked->clear();
        marked->restore(mark(6));
        store.frame(*marked, .5, writer);
        writer.flush();
        auto back = std::make_unique<Paint>();
        native::PaintStore reader(directory);
        reader.load("bhop_eazy", "abc", *back);
        assert(back->count() == 1);
        // Clear paint: the saved copy is empty a second later, and the index names the map.
        marked->clear();
        store.frame(*marked, 1, writer);
        writer.flush();
        auto unchanged = std::make_unique<Paint>();
        native::PaintStore early(directory);
        early.load("bhop_eazy", "abc", *unchanged);
        assert(unchanged->count() == 1);
        store.frame(*marked, 1.6, writer);
        writer.flush();
        auto cleared = std::make_unique<Paint>();
        native::PaintStore late(directory);
        late.load("bhop_eazy", "abc", *cleared);
        assert(cleared->count() == 0);
        std::ifstream index(directory / "index.json");
        assert(nlohmann::json::parse(index) == nlohmann::json::array({"bhop_eazy"}));
    }
    std::filesystem::remove_all(directory);
}
}  // namespace

int main() {
    test_round_trip_on_the_same_bsp_only();
    test_newest_marks_win_and_broken_ones_are_dropped();
    test_forty_most_recent_maps();
    test_store_saves_after_a_change_and_a_clear_empties_it();
    std::puts("paint store passed");
}
