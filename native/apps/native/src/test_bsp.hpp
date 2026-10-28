#pragma once
#include <bit>
#include <cstdint>
#include <span>
#include <string_view>
#include <vector>

namespace native::test {

using Bytes = std::vector<uint8_t>;

inline void integer(Bytes &bytes, size_t offset, uint32_t value) {
    for (int i = 0; i < 4; ++i) {
        bytes[offset + i] = uint8_t(value >> (i * 8));
    }
}

inline void number(Bytes &bytes, size_t offset, float value) {
    integer(bytes, offset, std::bit_cast<uint32_t>(value));
}

inline void lump(Bytes &bytes, size_t index, uint32_t version, std::span<const uint8_t> data) {
    constexpr size_t lump_table = 8;
    constexpr size_t lump_bytes = 16;
    const size_t offset = lump_table + index * lump_bytes;
    integer(bytes, offset, uint32_t(bytes.size()));
    integer(bytes, offset + 4, uint32_t(data.size()));
    integer(bytes, offset + 8, version);
    bytes.insert(bytes.end(), data.begin(), data.end());
}

inline void triangle_lumps(Bytes &bytes) {
    Bytes vertices(36);
    number(vertices, 12, 64);
    number(vertices, 28, 64);
    lump(bytes, 3, 0, vertices);
    Bytes face(56);
    face[8] = 3;
    face[12] = 255;
    face[13] = 255;
    integer(face, 20, uint32_t(-1));
    lump(bytes, 7, 1, face);
    const Bytes edges{0, 0, 1, 0, 1, 0, 2, 0, 2, 0, 0, 0};
    lump(bytes, 12, 0, edges);
    Bytes surface_edges(12);
    integer(surface_edges, 4, 2);
    integer(surface_edges, 8, 1);
    lump(bytes, 13, 0, surface_edges);
}

inline void material_lumps(Bytes &bytes) {
    Bytes texture(32);
    for (size_t offset : {16, 20, 24, 28}) {
        integer(texture, offset, 2);
    }
    lump(bytes, 2, 0, texture);
    Bytes info(72);
    for (size_t offset : {0, 20, 32, 52}) {
        number(info, offset, 1);
    }
    lump(bytes, 6, 0, info);
    constexpr std::string_view material = "fixture/test\0";
    lump(bytes, 43, 0, {reinterpret_cast<const uint8_t *>(material.data()), material.size() + 1});
    lump(bytes, 44, 0, Bytes(4));
}

// One triangle and a nonsolid leaf, matching the bridge's offline fixture.
inline Bytes make_bsp() {
    constexpr size_t header_bytes = 1036;
    Bytes bytes(header_bytes);
    integer(bytes, 0, 0x50534256);
    integer(bytes, 4, 20);
    constexpr std::string_view entities =
        "{\"classname\" \"worldspawn\"}\n"
        "{\"classname\" \"info_player_start\" \"origin\" \"10 20 100\" \"angles\" \"0 45 0\"}\n"
        "{\"classname\" \"prop_dynamic\" \"model\" \"models/fixture/box.mdl\" "
        "\"solid\" \"2\" \"origin\" \"10 20 0\"}";
    lump(bytes, 0, 0, {reinterpret_cast<const uint8_t *>(entities.data()), entities.size()});
    Bytes plane(20);
    number(plane, 8, 1);
    integer(plane, 16, 2);
    lump(bytes, 1, 0, plane);
    Bytes node(32);
    integer(node, 4, uint32_t(-1));
    integer(node, 8, uint32_t(-1));
    lump(bytes, 5, 0, node);
    Bytes leaf(32);
    leaf[26] = 1;
    lump(bytes, 10, 1, leaf);
    Bytes model(48);
    integer(model, 44, 1);
    lump(bytes, 14, 0, model);
    lump(bytes, 17, 0, Bytes(2));
    Bytes brush(12);
    integer(brush, 4, 1);
    lump(bytes, 18, 0, brush);
    Bytes side{0, 0, 255, 255, 255, 255, 0, 0};
    lump(bytes, 19, 0, side);
    triangle_lumps(bytes);
    material_lumps(bytes);
    return bytes;
}

inline Bytes make_box_model() {
    Bytes bytes(128);
    integer(bytes, 0, 0x54534449);
    for (size_t offset : {104, 108, 112}) {
        number(bytes, offset, -32);
    }
    for (size_t offset : {116, 120}) {
        number(bytes, offset, 32);
    }
    number(bytes, 124, 64);
    return bytes;
}

}  // namespace native::test
