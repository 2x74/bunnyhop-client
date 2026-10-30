// Sky packs, the looks' settings and their sun, checked against the website's code (sky-packs/, graphics/).
#include "base64.hpp"
#include "look_settings.hpp"
#include "scene_lighting.hpp"
#include "sky_image.hpp"
#include "sky_library.hpp"
#include "bunnyhop_native.h"
#include "render_math.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <string>
#include <vector>

namespace {

bool near(float a, float b, float tolerance = 1e-4f) {
    return std::abs(a - b) <= tolerance;
}

// Website values from sky-packs/folder.ts folderSkyId and sources.ts skyIdFrom.
void folder_ids_match_the_website() {
    const char *cases[][3] = {
            {"My sky.hdr", "folder-my-sky-8da2a4c6", "my-sky"},
            {"my-sky.hdr", "folder-my-sky-dabbc893", "my-sky"},
            {"Sunset (4k).png", "folder-sunset-4k-19ca2c48", "sunset-4k"},
            {"pack.bhsky.json", "folder-pack-f1d10617", "pack-bhsky"},
            {"Ünïcødé sky.jpg", "folder-n-c-d-sky-b2c9ba68", "n-c-d-sky"},
            {"\U0001F600.hdr", "folder-sky-108aa994", "sky"},
            {"..hdr", "folder-sky-241f8c09", "sky"},
    };
    for (const auto &c : cases) {
        assert(native::folder_sky_id(c[0]) == c[1]);
        assert(native::sky_id_from(c[0]) == c[2]);
    }
    assert(native::sky_display_name("Golden.bhsky.json") == "Golden");
    assert(native::sky_display_name("Night.HDR") == "Night");
}

// Website values from sky-packs/sources.ts parseSkyLink.
void links_parse_like_the_website() {
    using Kind = native::SkyLink::Kind;
    auto polyhaven = native::parse_sky_link("https://polyhaven.com/a/kloppenheim_02_puresky");
    assert(polyhaven && polyhaven->kind == Kind::polyhaven && polyhaven->asset == "kloppenheim_02_puresky");
    auto file = native::parse_sky_link("https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/sky_x_4k.hdr");
    assert(file && file->kind == Kind::polyhaven && file->asset == "sky_x");
    assert(native::parse_sky_link("https://x.org/a/b.HDR")->kind == Kind::hdr);
    assert(native::parse_sky_link("https://x.org/p.jpeg?x=1")->kind == Kind::image);
    assert(native::parse_sky_link("https://x.org/pack")->kind == Kind::pack);
    assert(!native::parse_sky_link("http://x.org/a.hdr"));
    assert(!native::parse_sky_link("https://polyhaven.com/hdris/skies"));
    assert(native::sky_fetch_url("https://bunnyhop.lol/sky-packs/sunset.bhsky.json")
           == "https://bunnyhop.lol/sky-packs/sunset.bhsky.json");
    assert(native::sky_fetch_url("https://x.org/a b.hdr")
           == "https://bunnyhop.lol/api/css-asset?kind=sky&u=https%3A%2F%2Fx.org%2Fa%20b.hdr");
}

void base64_round_trips() {
    const std::vector<std::string> texts = {"", "a", "ab", "abc", "abcd", std::string("\0\xff\x10", 3)};
    for (const auto &text : texts)
        assert(native::base64_decode(native::base64(text)) == text);
    assert(!native::base64_decode("abc"));
    assert(!native::base64_decode("ab=c"));
    assert(!native::base64_decode("a!cd"));
}

void half_floats_round_trip() {
    for (float value : {0.f, 1.f, .5f, 65504.f, 6.1035e-5f, 3.14159f, 1234.5f})
        assert(near(native::float_from_half(native::half_from_float(value)), value, value * 1e-3f + 1e-7f));
    assert(native::half_from_float(1e9f) == 0x7bff);
}

// An 8x4 Radiance file, flat scanlines, black but for one bright texel in the upper half.
std::vector<uint8_t> tiny_hdr(int bright_x, int bright_y) {
    std::string header = "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4 +X 8\n";
    std::vector<uint8_t> bytes(header.begin(), header.end());
    for (int y = 0; y < 4; y++)
        for (int x = 0; x < 8; x++) {
            const bool bright = x == bright_x && y == bright_y;
            // RGBE (128, 64, 32, 131): (128, 64, 32) * 2^(131 - 136) = 4, 2, 1 in linear light.
            const uint8_t texel[4] = {
                    uint8_t(bright ? 128 : 0),
                    uint8_t(bright ? 64 : 0),
                    uint8_t(bright ? 32 : 0),
                    uint8_t(bright ? 131 : 0)
            };
            bytes.insert(bytes.end(), texel, texel + 4);
        }
    return bytes;
}

void hdr_panoramas_declare_their_sun() {
    const auto bytes = tiny_hdr(6, 1);
    const auto decoded = native::decode_sky(bytes, native::SkyFileKind::hdr, native::SkyClouds::clear);
    assert(decoded.picture);
    const auto &sky = *decoded.picture;
    assert(sky.width == 8 && sky.height == 4 && sky.pixels.size() == 8 * 4 * 3);
    assert(near(native::float_from_half(sky.pixels[(1 * 8 + 6) * 3]), 4, .01f));
    // from-hdr.ts skyLighting: latitude and longitude of the texel's centre, colour over its peak.
    const float pi = 3.14159265f, lat = (.5f - 1.5f / 4) * pi, lon = (6.5f / 8 - .5f) * 2 * pi;
    const auto &sun = sky.lighting.sun_direction;
    assert(near(sun[0], std::cos(lat) * std::cos(lon)) && near(sun[1], std::sin(lat)));
    assert(near(sun[2], std::cos(lat) * std::sin(lon)));
    assert(near(sky.lighting.sun_color[0], 1) && near(sky.lighting.sun_color[1], .5f));
    assert(near(sky.lighting.sun_intensity, 1) && near(sky.lighting.ambient_intensity, .28f));
    const auto wide = native::decode_sky(tiny_hdr(0, 0), native::SkyFileKind::image, native::SkyClouds::clear);
    assert(!wide.picture && !wide.error.empty());
}

std::string sha256(const std::vector<uint8_t> &bytes) {
    char out[65]{};
    assert(bh_sha256(bytes.data(), bytes.size(), out));
    return out;
}

void packs_are_checked_like_the_website() {
    const auto hdr = tiny_hdr(2, 0);
    nlohmann::json pack = {
            {"schemaVersion", 1},
            {"kind", "bunnyhop-sky"},
            {"id", "tiny"},
            {"name", "Tiny"},
            {"version", "1"},
            {"format", "equirect"},
            {"rotation", 90},
            {"exposure", 1},
            {"asset",
             {{"mime", "image/vnd.radiance"},
              {"sha256", sha256(hdr)},
              {"width", 8},
              {"height", 4},
              {"data", native::base64(std::string(hdr.begin(), hdr.end()))}}},
            {"lighting",
             {{"sun", {{"direction", {0, 1, 0}}, {"color", {1, .9, .8}}, {"intensity", .8}}},
              {"ambient", {{"color", {.5, .6, 1}}, {"intensity", .3}}}}}
    };
    auto decode = [](const nlohmann::json &json) {
        const auto text = json.dump();
        const std::vector<uint8_t> bytes(text.begin(), text.end());
        return native::decode_sky(bytes, native::SkyFileKind::pack, native::SkyClouds::photographic);
    };
    const auto good = decode(pack);
    assert(good.picture);
    assert(near(good.picture->rotation, 3.14159265f / 2) && near(good.picture->exposure, 2));
    assert(good.picture->lighting.has_sun && near(good.picture->lighting.sun_intensity, .8f));
    auto tampered = pack;
    tampered["asset"]["sha256"] = std::string(64, '0');
    assert(decode(tampered).error == "Sky asset hash mismatch");
    auto cube = pack;
    cube["format"] = "cube";
    assert(!decode(cube).picture);
    auto sideways = pack;
    sideways["lighting"]["sun"]["direction"] = {0, .5, 0};
    assert(!decode(sideways).picture);
}

void looks_read_and_validate_like_the_website() {
    auto values = native::default_look_settings();
    assert(!native::patch_look_setting(values, "graphicsBloom", true));
    assert(native::patch_look_setting(values, "graphicsPreset", "cinematic"));
    bool threw = false;
    try {
        native::patch_look_setting(values, "graphicsSkyPackId", "Not An Id");
    } catch (const std::exception &) {
        threw = true;
    }
    assert(threw);
    native::patch_look_setting(values, "graphicsSkyPackId", "cloudy-day");
    native::patch_look_setting(values, "graphicsSkyMode", "pack");
    auto look = native::LookSettings::read(values, true);
    assert(look.look == native::Look::cinematic && look.composer());
    assert(native::picked_sky(look, false) == "cloudy-day" && native::picked_sky(look, true).empty());
    assert(native::LookSettings::read(values, false).look == native::Look::classic);
    // profiles.ts resolveVisualProfile: automatic picks balanced with a sun and indoor without.
    look.lighting_profile = native::LightingProfileId::automatic;
    assert(native::resolve_visual_profile(look, "bhop_x", "", true).id == "balanced-lighting-v2");
    assert(native::resolve_visual_profile(look, "bhop_x", "", false).id == "indoor-night-v2");
    look.ambience_showcase = true;
    assert(native::resolve_visual_profile(look, "bhop_ambience", "", true).id == "ambience-showcase-v1");
    look.lighting_profile = native::LightingProfileId::map;
    look.ambience_showcase = false;
    look.map_profiles = true;
    assert(near(native::resolve_visual_profile(look, "bhop_arcane_v2", "", true).bloom_scale, .85f));
}

void a_map_lit_pack_turns_to_the_map_sun() {
    native::LookSettings look;
    native::MapSun map;
    map.present = true;
    map.direction = {0, 1, 0};
    native::SkyPicture sky;
    sky.lighting.has_sun = true;
    sky.lighting.sun_direction = {1, 0, 0};
    const float yaw = native::sky_yaw(look, false, sky, map);
    const auto turned = native::source_from_three(native::turn_three(sky.lighting.sun_direction, yaw));
    assert(near(turned[0], 0) && near(turned[1], 1) && near(turned[2], 0));
    const auto lit = native::resolve_scene_sun(map, &sky, true, yaw, 1);
    assert(lit.from_pack && near(lit.direction[1], 1));
}

void the_sun_map_centres_on_the_camera() {
    const std::array<float, 3> center{128, -64, 32}, direction{.3f, .2f, .9f};
    const auto m = native::sun_view_projection(center, direction, 1024, 1024);
    const auto p = native_render::transform_point(m, {128, -64, 32});
    const float texel = 2.f / 1024;
    assert(std::abs(p[0]) <= texel && std::abs(p[1]) <= texel && near(p[2], 0, 1e-3f));
}

}  // namespace

int main() {
    folder_ids_match_the_website();
    links_parse_like_the_website();
    base64_round_trips();
    half_floats_round_trip();
    hdr_panoramas_declare_their_sun();
    packs_are_checked_like_the_website();
    looks_read_and_validate_like_the_website();
    a_map_lit_pack_turns_to_the_map_sun();
    the_sun_map_centres_on_the_camera();
    std::cout << "sky tests passed\n";
}
