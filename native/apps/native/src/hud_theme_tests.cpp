#include "hud_theme.hpp"
#include "movement_hud.hpp"
#include "hud_trainer.hpp"
#include "crosshair_shape.hpp"
#include "hud_editor_layout.hpp"
#include "hud_result.hpp"
#include "toasts.hpp"
#include "room_modes.hpp"
#include "room_state.hpp"
#include "weapon_menu.hpp"
#include "native_chat.hpp"
#include "capabilities.hpp"
#include <cassert>
#include <set>
#include <iostream>
#include <filesystem>
#include <fstream>
#include <vector>

#include <cstdlib>
#include <new>
static bool count_allocations = false;
static size_t allocation_count = 0;

void *operator new(std::size_t bytes) {
    if (count_allocations) ++allocation_count;
    if (void *memory = std::malloc(bytes ? bytes : 1)) return memory;
    throw std::bad_alloc();
}

void operator delete(void *memory) noexcept {
    std::free(memory);
}

void operator delete(void *memory, std::size_t) noexcept {
    std::free(memory);
}

namespace {
struct NoAllocations {
    NoAllocations() {
        allocation_count = 0;
        count_allocations = true;
    }

    ~NoAllocations() {
        count_allocations = false;
        assert(allocation_count == 0);
    }
};

struct DrawProbe {
    // On the heap: several probes share one test function, and Windows gives the main thread a 1 MB stack.
    std::vector<native::HudLabel<512>> labels = std::vector<native::HudLabel<512>>(256);
    size_t texts = 0;
    size_t rects = 0;
    size_t flags = 0;
    size_t names = 0;
    size_t avatars = 0;
    bool particle_after_text = false;

    bool has(std::string_view value) const {
        for (size_t i = 0; i < texts; ++i) {
            if (labels[i].view().find(value) != std::string_view::npos) return true;
        }
        return false;
    }

    void overlay_begin(int, int, float) {}

    void overlay_end(int, int) {}

    void overlay_text(float x, float y, std::string_view text, float, native::NameColor, bool = false) {
        assert(std::isfinite(x) && std::isfinite(y));
        if (texts < labels.size()) labels[texts++].assign(text);
    }

    void overlay_rect(float x, float y, float width, float height, native::NameColor) {
        assert(std::isfinite(x) && std::isfinite(y) && width >= 0 && height >= 0);
        particle_after_text |= texts > 0 && width == 3 && height == 5;
        ++rects;
    }

    void overlay_flag(float, float, std::string_view) { ++flags; }

    void overlay_mark(float, float, native::NameMark, native::NameColor) {}

    void overlay_avatar(float, float, unsigned, native::NameColor) { ++avatars; }

    float overlay_text_width(std::string_view text, float size) const { return float(text.size()) * size * .6f; }

    void overlay_name(float, float, std::string_view, float, const native::NameAppearance &, double, bool = false) {
        ++names;
    }
};

bool rejects_setting(const native::Json &settings, const std::string &key, const native::Json &value) {
    try {
        native::patch_settings(settings, {{key, value}});
    } catch (const std::exception &) {
        return true;
    }
    return false;
}

void test_web_settings_schema() {
    const auto cases = native::Json::parse(R"schema([
        {"key":"nullBinds","rule":{"kind":"boolean"},"default":false},
        {"key":"autoRestartWhen","rule":{"kind":"choice","values":["off","pb","wr","ghost"]},"default":"off"},
        {"key":"autoRestartAction","rule":{"kind":"choice","values":["restart","sound"]},"default":"restart"},
        {"key":"hudPlace","rule":{"kind":"choice","values":["off","place","top"]},"default":"off"},
        {"key":"hudEdgeGlow","rule":{"kind":"boolean"},"default":false},
        {"key":"hudHiddenKeeps","rule":{"kind":"choice","values":["speedKeys","nothing"]},"default":"speedKeys"},
        {"key":"hudKeysOpacity","rule":{"kind":"number","min":0.2,"max":1,"whole":false},"default":1},
        {"key":"hudKeysPressed","rule":{"kind":"color"},"default":"#ffffff"},
        {"key":"hudKeysIdle","rule":{"kind":"color"},"default":"#9aa3b2"},
        {"key":"hudKeysRowsWasd","rule":{"kind":"boolean"},"default":true},
        {"key":"hudKeysRowsActions","rule":{"kind":"boolean"},"default":true},
        {"key":"hudKeysRowsMouse","rule":{"kind":"boolean"},"default":true},
        {"key":"hudStrafeTrainerStyle","rule":{"kind":"choice","values":["classic","detailed","minimal"]},"default":"classic"},
        {"key":"hudStrafeTrainerFollow","rule":{"kind":"boolean"},"default":false},
        {"key":"hudStrafeTrainerZone","rule":{"kind":"number","min":2,"max":30,"whole":true},"default":10},
        {"key":"hudStrafeTrainerHeight","rule":{"kind":"number","min":0.5,"max":3,"whole":false},"default":1},
        {"key":"hudStrafeTrainerDimBelow","rule":{"kind":"number","min":0,"max":90,"whole":true},"default":0},
        {"key":"hudStrafeTrainerColor","rule":{"kind":"color"},"default":"#ffffff"},
        {"key":"hudStrafeTrainerShowPace","rule":{"kind":"boolean"},"default":true},
        {"key":"hudStrafeTrainerSound","rule":{"kind":"boolean"},"default":false},
        {"key":"hudSsjChat","rule":{"kind":"boolean"},"default":false},
        {"key":"hudJhudSync","rule":{"kind":"boolean"},"default":true},
        {"key":"hudJhudJss","rule":{"kind":"boolean"},"default":false},
        {"key":"hudJhudAnalyzer","rule":{"kind":"boolean"},"default":false},
        {"key":"hudJhudSpeedColors","rule":{"kind":"number","min":1,"max":16,"whole":true},"default":6},
        {"key":"hudJhudCutoff","rule":{"kind":"number","min":0,"max":30,"whole":true},"default":0},
        {"key":"hudJhudColorsReallyBad","rule":{"kind":"color"},"default":"#ff0000"},
        {"key":"hudJhudColorsBad","rule":{"kind":"color"},"default":"#ffa500"},
        {"key":"hudJhudColorsMeh","rule":{"kind":"color"},"default":"#00ff00"},
        {"key":"hudJhudColorsGood","rule":{"kind":"color"},"default":"#00ffff"},
        {"key":"hudJhudColorsReallyGood","rule":{"kind":"color"},"default":"#ffffff"},
        {"key":"ghostCompare","rule":{"kind":"choice","values":["auto","pb","wr","custom"]},"default":"auto"},
        {"key":"hudSsjFieldsSpeed","rule":{"kind":"boolean"},"default":true},
        {"key":"hudSsjFieldsDiff","rule":{"kind":"boolean"},"default":true},
        {"key":"hudSsjFieldsGain","rule":{"kind":"boolean"},"default":true},
        {"key":"hudSsjFieldsSync","rule":{"kind":"boolean"},"default":true},
        {"key":"hudSsjFieldsStrafes","rule":{"kind":"boolean"},"default":true},
        {"key":"hudSsjFieldsEff","rule":{"kind":"boolean"},"default":false},
        {"key":"hudSsjFieldsHeight","rule":{"kind":"boolean"},"default":false},
        {"key":"hudSsjFieldsTime","rule":{"kind":"boolean"},"default":false},
        {"key":"hudMovementFjtChat","rule":{"kind":"boolean"},"default":false},
        {"key":"hudMovementLj","rule":{"kind":"boolean"},"default":false},
        {"key":"hudMovementLjChat","rule":{"kind":"boolean"},"default":true},
        {"key":"triggersStyle","rule":{"kind":"choice","values":["filled","outline","bottom"]},"default":"filled"},
        {"key":"triggersThickness","rule":{"kind":"number","min":1,"max":6,"whole":false},"default":1},
        {"key":"triggersOpacity","rule":{"kind":"number","min":0,"max":1,"whole":false},"default":0.16},
        {"key":"triggersColorsTeleport","rule":{"kind":"color"},"default":"#ff4040"},
        {"key":"triggersColorsPush","rule":{"kind":"color"},"default":"#3d8bff"},
        {"key":"triggersColorsGravity","rule":{"kind":"color"},"default":"#3ddc84"},
        {"key":"triggersColorsOther","rule":{"kind":"color"},"default":"#ffd23d"},
        {"key":"triggersColorsClip","rule":{"kind":"color"},"default":"#b35cff"},
        {"key":"triggersColorsWall","rule":{"kind":"color"},"default":"#b4bac4"},
        {"key":"audioMusicMode","rule":{"kind":"choice","values":["always","menus","off"]},"default":"always"},
        {"key":"audioShuffle","rule":{"kind":"boolean"},"default":true},
        {"key":"audioPerfHud","rule":{"kind":"boolean"},"default":true}
    ])schema");
    const auto settings = native::default_settings();
    for (const auto &entry : cases) {
        const auto key = entry.at("key").get<std::string>();
        assert(settings.contains(key) && settings.at(key) == entry.at("default"));
        const auto &rule = entry.at("rule");
        const auto kind = rule.at("kind").get<std::string>();
        if (kind == "number") {
            const double low = rule.at("min");
            const double high = rule.at("max");
            native::patch_settings(settings, {{key, low}});
            native::patch_settings(settings, {{key, high}});
            assert(rejects_setting(settings, key, low - .01));
            assert(rejects_setting(settings, key, high + .01));
            if (rule.value("whole", false)) assert(rejects_setting(settings, key, low + .5));
        } else if (kind == "choice") {
            for (const auto &value : rule.at("values"))
                native::patch_settings(settings, {{key, value}});
            assert(rejects_setting(settings, key, "unknown"));
        } else if (kind == "color") {
            native::patch_settings(settings, {{key, "#abcdef"}});
            assert(rejects_setting(settings, key, "#gg0000"));
        } else {
            native::patch_settings(settings, {{key, !entry.at("default").get<bool>()}});
            assert(rejects_setting(settings, key, 1));
        }
    }
    // The website's default places leave every element at the native HUD's own place, at the native size.
    const auto classic = native::HudPreferences::from(settings);
    for (const auto id : native::web_hud_elements) {
        const auto &place = classic.layout[native::hud_index(id)];
        assert(place && !place->placed && std::abs(place->scale - 1) < 1e-6f);
    }
    auto legacy = native::patch_settings(
            settings, {{"hudLayout", {{"fps", {{"visible", true}}}, {"timer", {{"x", 50}, {"y", 70}}}}}}
    );
    assert(native::HudPreferences::from(legacy).layout[native::hud_index("fps")]->visible);
    assert(native::HudPreferences::from(legacy).layout[native::hud_index("timer")]->placed);
    // Showing an element keeps a v0.5.1 placement; moving the timer with the website's layout replaces its own.
    auto web = settings.at("hudLayoutWeb");
    web["graph"]["on"] = true;
    assert(native::patch_settings(legacy, {{"hudLayoutWeb", web}}).at("hudLayout") == legacy.at("hudLayout"));
    web["timer"]["x"] = -.05;
    const auto modern = native::patch_settings(legacy, {{"hudLayoutWeb", web}});
    assert(modern.at("hudLayoutWeb") == web && !modern.at("hudLayout").contains("timer"));
    assert(modern.at("hudLayout").contains("fps"));
    const auto moved = native::HudPreferences::from(modern).layout[native::hud_index("timer")];
    assert(moved && moved->placed && moved->anchored);
    const auto file = std::filesystem::temp_directory_path() / "bunnyhop-polish-settings.json";
    native::save_settings(file, legacy);
    const auto reloaded = native::load_settings(file);
    assert(reloaded.at("hudLayout") == legacy.at("hudLayout"));
    assert(reloaded.at("hudLayoutWeb") == legacy.at("hudLayoutWeb"));
    assert(native::HudPreferences::from(reloaded).layout[native::hud_index("fps")]->visible);
    std::filesystem::remove(file);
    assert(native::patch_settings(settings, legacy).at("hudLayout") == legacy.at("hudLayout"));
    const auto capabilities = native::native_capabilities();
    for (const auto &id : native::web_hud_elements)
        assert(std::find(capabilities.begin(), capabilities.end(), "hud:" + std::string(id)) != capabilities.end());
    std::cout << "Web settings schema: 55 exact defaults, choices and numeric/color/boolean boundaries\n";
}

void test_defaults_and_saved_settings() {
    const auto defaults = native::default_settings();
    assert(defaults["volume"] == .8 && defaults["musicVolume"] == .5 && defaults["sfxVolume"] == .8);
    assert(defaults["ambienceVolume"] == .7 && defaults["uiVolume"] == .6);
    assert(defaults["wind"] == false && defaults["ghostAudio"] == false);
    assert(defaults["keysStyle"] == "keycaps" && defaults["jumpStats"] == false);
    assert(defaults["crosshairColor"] == "#4dff6a" && defaults["crosshairGap"] == 4);
    assert(defaults["fpsLimit"] == 1000);
    assert(defaults["hudLayoutWeb"]["fps"]["on"] == false);
    assert(defaults["hudLayoutWeb"].size() == 25);
    assert(defaults["hudLayoutWeb"]["jhud"]["on"] == false && defaults["hudLayoutWeb"]["ghostSpeed"]["on"] == false);
    assert(defaults["ghostOpacity"] == .55 && defaults["strafeTrainerSmoothing"] == 8);
    assert(defaults["strafeTrainerHints"] == false);
    const auto &binds = defaults["binds"];
    assert(binds["turnFast"] == native::Json::array({"ArrowUp"}));
    assert(binds["noclip"] == native::Json::array({"KeyZ"}));
    assert(binds["thirdPerson"] == native::Json::array({"KeyT"}) && binds["showClips"].empty());
    assert(binds["duck"] == native::Json::array({"ControlLeft"}));
    for (const auto &[action, key] : std::array<std::pair<const char *, const char *>, 5>{
                 {{"flashlight", "KeyL"},
                  {"hudEditor", "F2"},
                  {"gunMenu", "Digit7"},
                  {"setStart", "Digit4"},
                  {"nextTrack", "KeyP"}}
         })
        assert(binds[action] == native::Json::array({key}));
    const auto directory = std::filesystem::temp_directory_path() / "bunnyhop-hud-saved-defaults";
    std::filesystem::create_directories(directory);
    const auto file = directory / "settings.json";
    const native::Json saved = {
            {"volume", .65},
            {"wind", true},
            {"ghostAudio", true},
            {"jumpStats", true},
            {"keysStyle", "classic"},
            {"crosshairGap", 3},
            {"ghostOpacity", .4},
            {"binds", {{"turnFast", {"Mouse4"}}, {"noclip", {"Backquote"}}, {"showClips", {"KeyT"}}}}
    };
    std::ofstream(file) << saved;
    const auto loaded = native::load_settings(file);
    for (const auto &[key, value] : saved.items()) {
        if (key != "binds") assert(loaded[key] == value);
    }
    for (const auto &[key, value] : saved["binds"].items())
        assert(loaded["binds"][key] == value);
    std::filesystem::remove_all(directory);
    for (const auto &key : native::hud_capabilities())
        assert(defaults.contains(key.get<std::string>()) || key == "movementStats" || key == "longjump"
               || key == "triggerMenu");
}

void test_layouts_and_options() {
    const auto defaults = native::default_settings();
    for (unsigned anchor = 0; anchor < 9; ++anchor) {
        const native::HudPlace place{true, true, anchor, .01f, -.02f, 1.5f};
        const auto rect = place.rect(1000, 800, 100, 20);
        const float horizontal = float(anchor % 3) / 2;
        const float vertical = float(anchor / 3) / 2;
        assert(std::abs(rect.x + horizontal * rect.width - (horizontal + .01f) * 1000) < .001f);
        assert(std::abs(rect.y + vertical * rect.height - (vertical - .02f) * 800) < .001f);
    }
    for (const auto &id : native::hud_elements) {
        const auto changed = native::patch_settings(
                defaults, {{"hudLayout", {{id, {{"a", 7}, {"x", -.1}, {"y", -.2}, {"s", 1.25}, {"on", false}}}}}}
        );
        const auto options = native::HudPreferences::from(changed);
        const auto &place = options.layout[native::hud_index(id)];
        assert(place && place->anchored && !place->visible && place->scale == 1.25f);
    }
    for (const auto &invalid : native::Json::array(
                 {{{"hudLayout", {{"timer", {{"a", 9}, {"x", 0}, {"y", 0}}}}}},
                  {{"hudLayout", {{"timer", {{"a", 4}, {"x", 0}, {"y", 0}, {"s", 0}}}}}},
                  {{"hudHiddenKeeps", "all"}},
                  {{"hudKeysOpacity", 1.1}},
                  {{"hudKeysPressed", "red"}},
                  {{"hudStrafeTrainerZone", 0}},
                  {{"hudStrafeTrainerStyle", "unknown"}},
                  {{"autoRestartWhen", "all"}}}
         )) {
        bool rejected = false;
        try {
            native::patch_settings(defaults, invalid);
        } catch (const std::exception &) {
            rejected = true;
        }
        assert(rejected);
    }
    const auto beginner = native::patch_settings(defaults, native::trainer_preset("beginner"));
    assert(beginner["hudStrafeTrainerStyle"] == "detailed" && beginner["strafeTrainerSmoothing"] == 12);
    assert(native::trainer_preset("strict")["hudStrafeTrainerZone"] == 5);
    for (const auto preset : {"beginner", "standard", "strict"}) {
        const auto enabled = native::patch_settings(defaults, native::trainer_preset(preset));
        assert(native::HudPreferences::from(enabled).trainer_enabled);
    }
}

void test_scoreboard_and_names() {
    native::HudScoreboard board;
    board.contract(
            {{"head", {{"room", "Test room"}, {"map", "bhop_test"}, {"tier", 8}, {"max", 16}}},
             {"rows",
              native::Json::array(
                      {{{"slot", 1},
                        {"name", "First"},
                        {"style", "autohop"},
                        {"pb", 12.345},
                        {"country", "US"},
                        {"status", "0:13.000"},
                        {"statusKind", "running"},
                        {"host", true},
                        {"rank", {{"name", "Gold"}, {"color", "#ffc53d"}}},
                        {"nameColor", "rose"},
                        {"nameColor2", "aqua"},
                        {"nameEffect", "paint"},
                        {"supporter", true},
                        {"verified", true},
                        {"special", {"mapper", "contributor"}}},
                       {{"slot", 2}, {"name", "Spectator"}, {"statusKind", "spec"}, {"status", "SPEC -> First"}}}
              )}}
    );
    assert(board.count == 2 && board.rows[0].pb == 12.345 && board.rows[1].spectator);
    assert(board.rows[0].look.marks & (1u << unsigned(native::NameMark::mapper)));
    const auto start = native::name_ink(board.rows[0].look, 0, 0);
    const auto end = native::name_ink(board.rows[0].look, 1, 0);
    assert(start != end && start[0] == 1);
    assert(native::flag_glyph("US") == native::flag_glyph("us"));
    assert(!native::flag_glyph("USA") && !native::flag_glyph("?S"));
    for (const auto size : {std::pair{1280, 720}, std::pair{1920, 1080}, std::pair{720, 900}}) {
        DrawProbe probe;
        {
            NoAllocations no_allocations;
            native::draw_scoreboard(probe, size.first, size.second, 100, board, 1, 0);
        }
        assert(probe.has("Test room") && probe.has("T7+") && probe.has("00:12.345") && probe.has("Normal"));
        // Spectators are listed under the table, as on the website.
        assert(probe.has("Spectating: ") && probe.has("Spectator -> First"));
        assert(probe.flags == 1 && probe.names == 1 && probe.avatars == 1);
        assert(probe.has("Bind a key to chat, N to spectate."));
    }
    native::HudLabel<48> time;
    native::format_hud_time(time, 16.731);
    assert(time.view() == "00:16.731");
    native::format_hud_time(time, 59.9996);
    assert(time.view() == "01:00.000");
    const std::array<float, 16> matrix = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 4};
    const float point[] = {0, 0, 0};
    const auto projected = native::project_name_tag(matrix.data(), point, 1000, 800);
    native::GraphicsView bars;
    bars.x = 200;
    bars.y = 100;
    bars.output_width = 600;
    bars.output_height = 600;
    const float offset_point[] = {1, 1, 0};
    const auto in_bars = native::project_name_tag(matrix.data(), offset_point, bars, 800, .5f);
    const auto local = native::project_name_tag(matrix.data(), offset_point, 600, 600);
    assert(in_bars && local);
    assert(std::abs((*in_bars)[0] - (200 + (*local)[0]) * 2) < .001f);
    assert(std::abs((*in_bars)[1] - (100 + (*local)[1]) * 2) < .001f);
    assert(projected && (*projected)[0] == 500 && (*projected)[1] == 400);
    const float hidden[] = {20, 0, 0};
    assert(!native::project_name_tag(matrix.data(), hidden, 1000, 800));
}

void test_merged_menu_contracts() {
    const native::Json marks = native::Json::array(
            {{{"id", "contributor"}, {"name", "Contributor"}},
             {{"id", "verified"}, {"name", "Verified"}},
             {{"id", "gifter-prism"}, {"name", "Prism Gifter"}, {"colors", {"#ffa8cb", "#6ff0f0"}}, {"animated", true}}}
    );
    const native::Json look = {{"color", "#ffa8cb"}, {"color2", "#6ff0f0"}, {"effect", "paint"}};
    const auto decoration = native::chat_decoration(
            {{"nativeName", look}, {"nativeMarks", marks}, {"nativeRankColor", "#ffc53d"}, {"nativeCountry", "us"}}
    );
    assert(decoration.appearance.badge_count == 3);
    assert(decoration.appearance.badges[0].glyph == native::NameMark::contributor);
    assert(decoration.appearance.badges[1].glyph == native::NameMark::verified);
    assert(decoration.appearance.badges[2].glyph == native::NameMark::gift);
    assert(decoration.appearance.effect == native::NameEffect::paint);
    native::RoomState room;
    room.display_contract(
            {{"type", "scoreboard"},
             {"head", {{"room", "Decorated"}, {"map", "bhop_test"}, {"max", 16}}},
             {"rows",
              native::Json::array(
                      {{{"slot", 3},
                        {"name", "Runner"},
                        {"look", look},
                        {"marks", marks},
                        {"status", "00:16.731"},
                        {"statusKind", "running"},
                        {"running", {{"seconds", 16.731}, {"at", 100000.}}},
                        {"pb", 20.123}}}
              )}}
    );
    room.refresh_display(90);
    assert(room.display().count == 1 && room.display().rows[0].look.badge_count == 3);
    DrawProbe probe;
    {
        NoAllocations no_allocations;
        native::draw_scoreboard(probe, 1280, 720, 100, room.display(), 90, 100500);
    }
    assert(probe.has("00:17.231"));
    BhRunState run{};
    std::string style;
    room.spectator_run(run, style, 3, 90, 100500);
    assert(run.status == 1 && std::abs(run.seconds - 17.231) < 1e-8);
    room.display_contract(
            {{"type", "scoreboard"},
             {"head", {{"room", "Decorated"}, {"map", "bhop_test"}, {"chatKey", "U"}}},
             {"rows", native::Json::array()}}
    );
    DrawProbe keyed;
    native::draw_scoreboard(keyed, 1280, 720, 100, room.display(), 90, 100500);
    assert(keyed.has("U to chat, N to spectate."));
    room.display_contract({{"type", "scoreboard"}, {"head", nullptr}, {"rows", native::Json::array()}});
    assert(room.display().count == 0);
    auto settings = native::default_settings();
    for (const char *stat : {"offsets", "fjt", "lj"}) {
        settings =
                native::patch_settings(settings, native::movement_stat_patch(settings, {{"stat", stat}, {"on", true}}));
    }
    assert(settings["hudLayoutWeb"]["strafeOffsets"]["on"] == true);
    assert(settings["hudLayoutWeb"]["firstJump"]["on"] == true);
    assert(settings["hudLayoutWeb"]["longJump"]["on"] == true && settings["hudMovementLj"] == true);
    native::NativeTriggerMenu triggers;
    triggers.toggle();
    assert(triggers.key("Digit1", true, false) == "showTriggers");
    assert(triggers.key("Digit2", true, false) == "showClips");
    DrawProbe trigger_probe;
    {
        NoAllocations no_allocations;
        triggers.draw(trigger_probe, 1280, 720, 100, true, false);
    }
    assert(trigger_probe.has("Triggers: shown") && trigger_probe.has("Player clips: hidden"));
    assert(triggers.key("Digit0", true, false) && !triggers.open);
}

// The website's tag fades (player/tag.ts TagSight(2000, 3000), net/players.ts near-camera ramp).
void test_tag_sight_fades() {
    native::NameTagSights sights;
    const float eye[] = {0, 0, 0};
    auto clear = [](const float *) {
        return true;
    };
    auto blocked = [](const float *) {
        return false;
    };
    sights.begin(0, eye);
    const float close[] = {60, 0, 0}, ramp[] = {135, 0, 0}, distant[] = {2500, 0, 0}, gone[] = {3200, 0, 0};
    assert(sights.opacity(1, close, true, clear) == 0);
    assert(std::abs(sights.opacity(1, ramp, true, clear) - .5f) < 1e-5f);
    assert(std::abs(sights.opacity(1, distant, true, clear) - .5f) < 1e-5f);
    assert(sights.opacity(1, gone, true, clear) == 0);
    // Occlusion eases out over a fifth of a second and back in over an eighth.
    const float mid[] = {500, 0, 0};
    assert(sights.opacity(2, mid, false, clear) == 1);
    sights.begin(.1, eye);
    assert(std::abs(sights.opacity(2, mid, false, blocked) - .5f) < 1e-4f);
    sights.begin(.2, eye);
    assert(sights.opacity(2, mid, false, blocked) == 0);
    sights.begin(.32, eye);
    assert(std::abs(sights.opacity(2, mid, false, clear) - .8f) < 1e-4f);
}

void test_room_tag_detail() {
    native::RoomState room;
    room.event(
            {{"generation", 1},
             {"id", "easy"},
             {"event",
              {{"t", "welcome"},
               {"you", 0},
               {"room", {{"name", "Easy"}}},
               {"map", {{"name", "bhop_eazy"}}},
               {"players",
                native::Json::array(
                        {{{"slot", 0}, {"name", "Me"}, {"style", "autohop"}},
                         {{"slot", 1}, {"name", "Scroller"}, {"style", "scroll"}}}
                )},
               {"metas", {{"1", {{"style", 6}, {"track", 0}, {"timer", 3}, {"timerTicks", 1673}, {"ping", 20}}}}}}}}
    );
    native::HudLabel<48> detail;
    room.tag_detail(1, 10, detail);
    assert(detail.view() == "SCR · 00:16.730");
    room.tag_detail(0, 10, detail);
    assert(detail.empty());
}

void test_tags_and_race_picker() {
    test_room_tag_detail();
    native::RoomState room;
    std::array<native_render::Actor, 1> actors;
    actors[0].id = "1";
    actors[0].name = "Bunny";
    actors[0].opacity = 1;
    const std::array<float, 16> matrix = {.01f, 0, 0, 0, 0, .01f, 0, 0, 0, 0, .01f, 0, 0, 0, 0, 4};
    native::NameTagSights sights;
    const float eye[] = {0, 0, 900};
    sights.begin(0, eye);
    DrawProbe hidden;
    native::draw_name_tags(
            hidden,
            1280,
            720,
            100,
            matrix.data(),
            actors,
            room,
            sights,
            true,
            true,
            false,
            [](const float *) { return false; },
            0
    );
    assert(hidden.names == 0);
    DrawProbe visible;
    {
        NoAllocations no_allocations;
        native::draw_name_tags(
                visible,
                1280,
                720,
                100,
                matrix.data(),
                actors,
                room,
                sights,
                true,
                true,
                true,
                [](const float *) { return false; },
                0
        );
    }
    assert(visible.names == 1);
    test_tag_sight_fades();
    native::draw_ghost_name_tag(
            visible, 1280, 720, 100, matrix.data(), actors[0], "PB ghost", 16.731, "-0.020s", true, [](const float *) {
                return false;
            }
    );
    assert(visible.has("16.731s | -0.020s"));
    native::HudScoreboard board;
    board.count = 1;
    board.rows[0].name = "Opponent";
    board.rows[0].slot = 3;
    native::RacePicker picker;
    const std::array<BhZone, 2> zones = {BhZone{}, BhZone{0, 1, 0, {}, {}}};
    picker.open(board, zones);
    assert(picker.step == native::RacePicker::Step::player);
    assert(picker.key("Digit1", true, false));
    assert(picker.step == native::RacePicker::Step::track);
    assert(picker.key("Digit1", true, false));
    assert(picker.step == native::RacePicker::Step::style);
    assert(picker.key("Digit2", true, false));
    assert(picker.command.view() == "/race #3 legit 0");
}

void test_ghost_progress() {
    native::HudExtras extras;
    extras.ghost(
            {{"map", "test"},
             {"style", "autohop"},
             {"track", 0u},
             {"startTick", 10u},
             {"endTick", 100u},
             {"settings", {{"tickInterval", .01}}}}
    );
    assert(extras.ghost_seconds && *extras.ghost_seconds == .9);
    extras.ghost(
            {{"map", "test"},
             {"style", "autohop"},
             {"track", 0u},
             {"timeMs", 895u},
             {"startTick", 10u},
             {"endTick", 100u},
             {"settings", {{"tickInterval", .01}}}}
    );
    assert(extras.ghost_seconds && *extras.ghost_seconds == .895);
    assert(extras.ghost_target("test", "autohop", 0, true) == extras.ghost_seconds);
    assert(!extras.ghost_target("other", "autohop", 0, true));
    assert(!extras.ghost_target("test", "autohop", 0, false));
    BhCmd command{};
    command.buttons = native::forward | native::jump;
    extras.ghost_keys(&command);
    assert(extras.have_ghost && extras.ghost_buttons == command.buttons);
    extras.show_ghost_split(-.025, -.025);
    assert(extras.ghost_delta.view() == "-0.025s" && extras.ghost_ahead);
    extras.show_ghost_split(.1, -.5);
    assert(extras.ghost_delta.view() == "+0.100s" && !extras.ghost_ahead);
    assert(extras.ghost_tag_delta.view() == "-0.500s");
    // Exactly level reads ahead, as on the website.
    extras.show_ghost_split(0., 0.);
    assert(extras.ghost_delta.view() == "+0.000s" && extras.ghost_ahead);
    extras.ghost_keys(nullptr);
    extras.show_ghost_split(std::nullopt, std::nullopt);
    assert(!extras.have_ghost && extras.ghost_delta.empty() && !extras.ghost_ahead && extras.ghost_tag_delta.empty());
    extras.leaderboard(4, 3);
    assert(extras.place.view() == "#4 · top 3%");
    extras.leaderboard(0);
    assert(extras.place.empty());
}

void test_results_toasts_and_room_widgets() {
    native::HudResult result;
    result.finish(4, 12.345, 1, 13, true);
    assert(result.delta && *result.delta < 0 && result.stamp == native::ResultStamp::pending);
    assert(result.status_line.view() == "Submitting…");
    result.service({{"generation", 3}, {"status", "verified"}, {"announcer", "wr"}}, 4, 1.5);
    assert(result.stamp == native::ResultStamp::pending);
    result.service({{"generation", 4}, {"status", "uploading"}}, 4, 1.5);
    assert(result.status_line.view() == "Verifying replay…");
    result.service(
            {{"generation", 4},
             {"status", "verified"},
             {"announcer", "wr"},
             {"rank", 1u},
             {"rewards", native::Json::array({{{"title", "+120 XP"}, {"detail", "New hat unlocked"}}})}},
            4,
            1.5
    );
    assert(result.status_line.view() == "Rank #1" && result.record_started == 1.5);
    result.restart_bind("KeyR");
    DrawProbe result_probe;
    {
        NoAllocations no_allocations;
        native::draw_result(result_probe, 1280, 720, 100, result, 2);
    }
    // Confetti goes under the words; the hint waits two seconds.
    assert(result_probe.has("World record") && result_probe.has("+120 XP") && result_probe.has("Rank #1"));
    assert(!result_probe.has("R to go again") && !result_probe.particle_after_text);
    DrawProbe settled_probe;
    native::draw_result(settled_probe, 1280, 720, 100, result, 3.5);
    assert(settled_probe.has("R to go again"));
    result.restart_bind("");
    DrawProbe unbound_probe;
    native::draw_result(unbound_probe, 1280, 720, 100, result, 3.5);
    assert(!unbound_probe.has("to go again"));
    assert(!result.visible(16));
    result.service(
            {{"generation", 4},
             {"status", "verified"},
             {"xp", 120u},
             {"level", {{"level", 12u}}},
             {"achievements", native::Json::array({"First finish"})}},
            4,
            2
    );
    assert(result.reward_count == 3);
    assert(result.rewards[0].title.view() == "+120 XP");
    assert(result.rewards[1].title.view() == "Level 12");
    assert(result.rewards[2].detail.view() == "First finish");
    result.service({{"generation", 3}, {"status", "verified"}, {"xp", 999u}}, 4, 2);
    assert(result.rewards[0].title.view() == "+120 XP");
    result.service({{"generation", 4}, {"status", "rejected"}}, 4, 2);
    assert(result.status_bad && native::result_word(result).empty());
    native::Toasts toasts;
    for (unsigned i = 0; i < 8; ++i)
        toasts.push(std::to_string(i), 1);
    assert(toasts.count == 5 && toasts.items[0].text.view() == "3");
    DrawProbe toast_probe;
    native::draw_toasts(toast_probe, 1280, 720, 100, toasts, 2);
    assert(toast_probe.texts == 5);
    native::RoomState room;
    room.vote = {
            {"options", {{{"map", "bhop_a"}}, {{"extend", true}, {"minutes", 10}}}},
            {"counts", native::Json::array({3u, 1u})},
            {"endsAt", 12000}
    };
    room.refresh_vote();
    room.voted(1);
    DrawProbe vote_probe;
    native::draw_vote(vote_probe, 1280, 720, 100, room.vote_display, 2000);
    assert(vote_probe.has("10s") && vote_probe.has("[3]") && vote_probe.has("Extend 10 minutes")
           && vote_probe.has("<"));
    native::RaceDisplay race;
    race.state = native::RaceDisplay::State::challenge;
    race.recipient = true;
    race.deadline = 12000;
    DrawProbe race_probe;
    native::draw_race(race_probe, 1280, 720, 100, race, 2000);
    assert(race_probe.has("1 Accept") && race_probe.has("2 Decline"));
}

void test_movement_widgets_and_restart() {
    auto settings = native::default_settings();
    for (const char *id : {"startPre", "strafeOffsets", "firstJump", "longJump", "sync", "ghostKeys"})
        settings["hudLayout"][id] = {{"a", 4}, {"x", 0}, {"y", .1}, {"s", 1}, {"on", true}};
    settings["hudMovementLj"] = true;
    auto options = native::HudPreferences::from(settings);
    native::MovementHud movement;
    movement.start_pre.assign("Start Pre 280");
    movement.offset.assign("Offset -1");
    movement.first_jump.assign("FJT 0 ticks");
    movement.long_jump.assign("LJ 275.50");
    native::HudExtras extras;
    extras.contract({{"pb", 12.345}, {"spectators", {"Watcher"}}, {"ghostButtons", native::left}});
    BhRunState run{};
    run.track = 1;
    run.split_count = 3;
    DrawProbe probe;
    native::draw_movement_widgets(
            probe,
            [](const char *, float x, float y) { return std::array{x, y}; },
            options,
            movement,
            extras,
            run,
            1600,
            900,
            true,
            2
    );
    for (const auto label : {"Start Pre", "Offset -1", "FJT", "LJ 275.50", "Watcher", "Practice", "Stage", "Ghost"})
        assert(probe.has(label));
    // The map line names the bonus; its own line only shows where the player put it.
    assert(!probe.has("Bonus"));
    settings["hudLayout"]["track"] = {{"x", 50}, {"y", 30}};
    DrawProbe placed_track;
    native::draw_movement_widgets(
            placed_track,
            [](const char *, float x, float y) { return std::array{x, y}; },
            native::HudPreferences::from(settings),
            movement,
            extras,
            run,
            1600,
            900,
            false,
            0
    );
    assert(placed_track.has("Bonus"));
    for (const char *style : {"classic", "detailed", "minimal"}) {
        options.trainer.style = style;
        DrawProbe trainer;
        {
            NoAllocations no_allocations;
            native::draw_trainer(
                    trainer, 500, 200, {105, native::StrafeHint::strafe_more}, options.trainer, true, options.palette
            );
        }
        assert(trainer.rects >= 4 && trainer.has("105%") && trainer.has("turn more"));
    }
    native::FirstJumpTracker first;
    run.jumps = 1;
    run.in_start = 1;
    assert(first.feed(true, run, 20, false) == 0);
    assert(!first.feed(true, run, 21, false));
    options.trainer_sound = true;
    options.trainer_enabled = true;
    assert(native::trainer_jump_sound(options, 105) == 1.5);
    assert(native::trainer_jump_sound(options, 180) == .75);
    assert(!native::trainer_jump_sound(options, std::nullopt));
    native::AutoRestart restart;
    run.status = 1;
    run.seconds = 10;
    assert(!restart.check(1, run, 10, false));
    run.seconds = 10.01;
    assert(!restart.check(1, run, 10, true));
    assert(restart.check(1, run, 10, false));
    assert(!restart.check(1, run, 10, false));
    assert(restart.check(2, run, 10, false));
    assert(!restart.check(3, run, std::nullopt, false));
}
}  // namespace

// Filled pixels of a crosshair, relative to its middle.
std::set<std::pair<int, int>> crosshair_pixels(const native::CrosshairShape &shape, bool outline) {
    std::set<std::pair<int, int>> pixels;
    for (const auto &run : shape.runs()) {
        if (run.outline != outline) continue;
        for (int x = run.x; x < run.x + run.width; ++x)
            assert(pixels.emplace(x, run.y).second);
    }
    return pixels;
}

void test_crosshair_pixels() {
    native::CrosshairShape shape;
    // Even thickness: the arms mirror around the line between the two middle pixels; gap and size are exact.
    shape.build("cross", 6, 4, 2, true, 1);
    auto fill = crosshair_pixels(shape, false);
    assert(fill.size() == 4 * 6 * 2);
    for (const auto &[x, y] : fill)
        assert(fill.contains({-1 - x, y}) && fill.contains({x, -1 - y}));
    assert(fill.contains({-5, 0}) && !fill.contains({-4, 0}) && fill.contains({4, 0}) && fill.contains({9, -1}));
    const auto outline = crosshair_pixels(shape, true);
    for (const auto &pixel : outline)
        assert(!fill.contains(pixel));
    assert(outline.contains({-11, 0}) && outline.contains({10, 0}) && outline.contains({-5, -2}));
    // Odd thickness centres on one pixel; fractional settings round to whole pixels.
    shape.build("cross", 5.6f, 3.4f, 2.6f, false, 1);
    fill = crosshair_pixels(shape, false);
    assert(fill.size() == 4 * 6 * 3 && crosshair_pixels(shape, true).empty());
    for (const auto &[x, y] : fill)
        assert(fill.contains({-x, y}) && fill.contains({x, -y}));
    // CSS pixels times the display scale, as on the website.
    shape.build("cross", 6, 4, 2, false, 2);
    assert(crosshair_pixels(shape, false).size() == 4 * 12 * 4);
    // The website's dot is a circle 1.6 times the thickness wide; T has no top arm.
    shape.build("dot", 6, 4, 5, false, 1);
    fill = crosshair_pixels(shape, false);
    assert(fill.contains({-4, 0}) && fill.contains({3, 0}) && !fill.contains({4, 0}) && !fill.contains({3, 3}));
    shape.build("t", 6, 4, 2, false, 1);
    for (const auto &[x, y] : crosshair_pixels(shape, false))
        assert(y >= -1);
    // Circle: the ring's outer edge is size + gap from the middle, with a centre dot.
    shape.build("circle", 6, 4, 2, false, 1);
    fill = crosshair_pixels(shape, false);
    assert(fill.contains({9, 0}) && !fill.contains({10, 0}) && !fill.contains({7, 0}) && fill.contains({0, 0}));
    // Windows' borderless window is one row taller; the middle stays on the same pixel.
    assert(native::CrosshairShape::centre_px(1441) == native::CrosshairShape::centre_px(1440));
}

// Layout codes made by the website's encodeLayout (hud/layout.ts): its Classic layout, and one with a moved timer,
// the FPS counter on and a minimal keys overlay.
constexpr const char *web_classic_code =
        "bhl1.CYcAAPXEMocAAPdoMocC0PdULYcAAPPkK4cAAPmOMocAAPiUMgcAAPq6MoQAAAR-MgQDUgR-KAYAlv7UMgQAAP2oMoAAeACgMoL_"
        "iACgMgAAeAHCMoYAePgwMoj_dP8kMgEAAAiYOQf9EvXEMgQAAPrsKwQAAPvwKwQAAPjGMoMAeP2oMoQAAAFAMgQAAP2oMgcC0PXELQFkB____"
        "5qjsg";
constexpr const char *web_custom_code =
        "bhl1.CYcAAPXEMoEE0gH0RocC0PdULYcAAPPkK4cAAPmOMocAAPiUMgcAAPq6MoQAAAR-MgQDUgR-KAYAlv7UMgQAAP2oMoAAeACgMoL_"
        "iACgMoAAeAHCMoYAePgwMoj_dP8kMgEAAAiYOQf9EvXEMgQAAPrsKwQAAPvwKwQAAPjGMoMAeP2oMoQAAAFAMgQAAP2oMgcC0PXELQI8Bf-2P"
        "Zqjsg";
// A code from before the JHUD and Speed vs ghost (the same custom layout, version 8).
constexpr const char *web_version_8_code =
        "bhl1.CIcAAPXEMoEE0gH0RocC0PdULYcAAPPkK4cAAPmOMocAAPiUMgcAAPq6MoQAAAR-MgQDUgR-KAYAlv7UMgQAAP2oMoAAeACgMoL_"
        "iACgMoAAeAHCMoYAePgwMoj_dP8kMgEAAAiYOQf9EvXEMgQAAPrsKwQAAPvwKwQAAPjGMoMAeP2oMoQAAAFAMgI8Bf-2PZqjsg";

// A layout saved before the JHUD and Speed vs ghost has them off, in their default places, and still makes a code.
void test_new_elements_in_old_layouts() {
    const auto file = std::filesystem::temp_directory_path() / "bunnyhop-hud-old-layout.json";
    auto layout = native::default_settings().at("hudLayoutWeb");
    layout.erase("jhud");
    layout.erase("ghostSpeed");
    native::save_settings(file, {{"hudLayoutWeb", layout}});
    const auto settings = native::load_settings(file);
    std::filesystem::remove(file);
    assert(settings.at("hudLayoutWeb") == native::default_settings().at("hudLayoutWeb"));
    assert(native::encode_hud_layout(settings) == web_classic_code);
    const auto preferences = native::HudPreferences::from(settings);
    assert(!preferences.layout[native::hud_index("jhud")]->visible);
    assert(!preferences.layout[native::hud_index("ghostSpeed")]->visible);
    assert(preferences.jhud == native::JhudPrefs{});
}

// The JHUD and Speed vs ghost keep their switches through a preset, as on the website.
void test_presets_keep_personal_elements() {
    auto settings = native::default_settings();
    settings["hudLayoutWeb"]["jhud"]["on"] = true;
    for (const auto id : native::hud_preset_ids) {
        const auto moved = native::patch_settings(settings, native::hud_preset(id, settings), false);
        assert(moved.at("hudLayoutWeb").at("jhud").at("on") == true);
        assert(moved.at("hudLayoutWeb").at("ghostSpeed").at("on") == false);
        assert(native::hud_layout_is_preset(moved, id));
    }
}

void test_jhud_chat_switch() {
    auto settings = native::default_settings();
    settings =
            native::patch_settings(settings, native::movement_stat_patch(settings, {{"stat", "jhud"}, {"on", true}}));
    assert(settings.at("hudLayoutWeb").at("jhud").at("on") == true);
    settings =
            native::patch_settings(settings, native::movement_stat_patch(settings, {{"stat", "jhud"}, {"on", false}}));
    assert(settings.at("hudLayoutWeb").at("jhud").at("on") == false);
}

void test_layout_codes() {
    const auto defaults = native::default_settings();
    assert(native::encode_hud_layout(defaults) == web_classic_code);
    // The website's Classic code leaves every element at the native HUD's own place.
    const auto classic = native::decode_hud_layout(web_classic_code);
    assert(classic);
    const auto imported = native::patch_settings(defaults, *classic, false);
    for (const auto &place : native::HudPreferences::from(imported).layout)
        assert(!place || !place->placed);
    const auto custom = native::decode_hud_layout(std::string("  ") + web_custom_code + "\n");
    assert(custom);
    const auto &timer = custom->at("hudLayoutWeb").at("timer");
    assert(timer.at("a") == 1 && std::abs(timer.at("x").get<double>() - .1234) < 1e-9 && timer.at("s") == 1.4);
    assert(custom->at("hudLayoutWeb").at("fps").at("on") == true && custom->at("keysStyle") == "minimal");
    assert(custom->at("hudKeysRowsActions") == false && custom->at("hudKeysPressed") == "#ffb63d");
    const auto settings = native::patch_settings(defaults, *custom, false);
    assert(native::encode_hud_layout(settings) == web_custom_code);
    const auto older = native::decode_hud_layout(web_version_8_code);
    assert(older && older->at("hudLayoutWeb").at("timer") == custom->at("hudLayoutWeb").at("timer"));
    assert(older->at("hudLayoutWeb").at("jhud") == defaults.at("hudLayoutWeb").at("jhud"));
    assert(older->at("hudLayoutWeb").at("ghostSpeed") == defaults.at("hudLayoutWeb").at("ghostSpeed"));
    assert(!native::decode_hud_layout("bhl1.???") && !native::decode_hud_layout("bhl2.CIcA"));
    assert(!native::decode_hud_layout("bhl1.CA"));
}

void test_layout_editor_math() {
    // A box in the bottom centre cell anchors to the screen's bottom centre, and HudPlace::rect puts it back.
    const native::HudRect box{900, 900, 120, 30};
    const auto place = native::hud_place_from_box(box, 1920, 1080, true, 1.25);
    assert(place.at("a") == 7 && place.at("s") == 1.25);
    const native::HudPlace stored{true, true, 7, place.at("x").get<float>(), place.at("y").get<float>(), 1, true};
    const auto back = stored.rect(1920, 1080, 120, 30);
    assert(std::abs(back.x - box.x) < .2f && std::abs(back.y - box.y) < .2f);
    // Snapping: the centre line within 8 px, otherwise the anchor-side edge to the grid.
    const auto centred = native::snap_box({893, 500, 120, 30}, 1920, 1080, 8, 8);
    assert(centred.vertical_guide && std::abs(centred.box.x - 900) < 1e-3f);
    const auto gridded = native::snap_box({13, 21, 50, 20}, 1920, 1080, 8, 8);
    assert(!gridded.vertical_guide && gridded.box.x == 16 && gridded.box.y == 24);
    // Each preset is a valid settings patch, and Classic is the built-in layout.
    for (const auto id : native::hud_preset_ids) {
        const auto settings = native::patch_settings(native::default_settings(), native::hud_preset(id), false);
        assert(native::hud_layout_is_preset(settings, id));
    }
    assert(native::hud_layout_is_preset(native::default_settings(), "classic"));
    for (const bool enabled : {false, true}) {
        auto settings = native::patch_settings(native::default_settings(), {{"strafeTrainer", enabled}});
        for (const auto id : native::hud_preset_ids) {
            settings = native::patch_settings(settings, native::hud_preset(id, settings), false);
            assert(settings.at("hudLayoutWeb").at("strafeTrainer").at("on") == enabled);
            assert(settings.at("strafeTrainer") == enabled);
            assert(native::HudPreferences::from(settings).trainer_enabled == enabled);
            assert(native::hud_layout_is_preset(settings, id));
        }
    }
    std::set<std::string_view> ids;
    for (const auto &element : native::hud_editor_elements)
        assert(ids.insert(element.id).second && native::hud_index(element.id) != 0);
}

int main() {
    test_web_settings_schema();
    test_defaults_and_saved_settings();
    test_new_elements_in_old_layouts();
    test_presets_keep_personal_elements();
    test_jhud_chat_switch();
    test_layouts_and_options();
    test_scoreboard_and_names();
    test_merged_menu_contracts();
    test_tags_and_race_picker();
    test_ghost_progress();
    test_results_toasts_and_room_widgets();
    test_movement_widgets_and_restart();
    test_crosshair_pixels();
    test_layout_codes();
    test_layout_editor_math();
    std::cout << "HUD: 8 scenario groups, all layout IDs, three trainer styles, defaults and saved settings\n";
    using native::parse_hud_theme;

    // Nothing set: the default HUD.
    const auto empty = parse_hud_theme(nlohmann::json::object());
    assert(!empty.text && !empty.gain && empty.elements.empty());
    assert(parse_hud_theme(nullptr).elements.empty());

    const auto theme = parse_hud_theme({
            {"colors",
             {{"text", {1, 1, 1, 1}},
              {"accent", {0.5, 0.8, 1, 1}},
              {"gain", {0, 0.5, 1, 1}},
              {"loss", "red"},
              {"sync", {1, 2, 0, 1}}}},
            {"elements",
             {{"speed", {{"color", {1, 0.4, 0.8, 1}}, {"opacity", 0.5}}},
              {"keys", {{"opacity", 3}}},
              {"chat", {{"opacity", 0.1}}},
              {"timer", "bold"}}},
    });
    assert(theme.text && (*theme.text)[0] == 1);
    assert(theme.accent && (*theme.accent)[1] == 0.8f);
    // Malformed colours are ignored, not guessed.
    assert(!theme.loss && !theme.sync);

    const auto *speed = theme.element("speed");
    assert(speed && speed->color && speed->opacity == 0.5f);
    const auto *keys = theme.element("keys");
    assert(keys && !keys->color && keys->opacity == 1);
    // Elements the native HUD doesn't draw from this table are dropped.
    assert(theme.element("chat") && theme.element("chat")->opacity == .1f && !theme.element("timer"));

    // Gain applies over the palette; colours that weren't set stay.
    auto palette = native::semantic_palette("off");
    const auto loss = palette.loss;
    theme.apply(palette);
    assert(palette.gain[2] == 1 && palette.loss == loss);
}
