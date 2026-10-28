#include "file_dialogs.hpp"
#include "menu_files.hpp"
#include "window_mode_driver.hpp"
#include <cassert>
#include <filesystem>
#include <fstream>
#include <functional>
#include <string>
#include <chrono>
#include <thread>

namespace {

namespace fs = std::filesystem;

void write_raw(const fs::path &path, const std::string &bytes) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out << bytes;
}

bool throws(const fs::path &path, std::uintmax_t limit = native::file_dialog_max_bytes) {
    try {
        native::read_dialog_file(path, limit);
    } catch (const std::exception &) {
        return true;
    }
    return false;
}

struct FakeWindow {
    std::string shown = "borderless";
    int applies = 0;
    int refits = 0;
    bool iconified = false;
    bool on_top = false;

    bool is_minimized() const { return iconified; }

    bool
    apply(const native::WindowJson &settings,
          bool = false,
          const std::optional<native::WindowBounds> & = std::nullopt) {
        shown = settings.at("windowMode");
        on_top = settings.value("alwaysOnTop", false);
        ++applies;
        return true;
    }

    std::string mode() const { return shown; }

    std::string error() const { return {}; }

    void refit() { ++refits; }
};

void deferred_window_changes() {
    FakeWindow window;
    native::BasicWindowModeDriver<FakeWindow> driver(window, "borderless");
    // SDL can update flags before the minimize event reaches the driver.
    window.iconified = true;
    driver.display_changed();
    assert(driver.choose({{"windowMode", "windowed"}}));
    assert(window.applies == 0 && window.refits == 0);
    driver.resumed({{"windowMode", "windowed"}});
    assert(window.applies == 0 && window.refits == 0);
    window.iconified = false;
    driver.resumed({{"windowMode", "windowed"}});
    assert(window.applies == 1 && window.refits == 1 && window.shown == "windowed");
    window.iconified = true;
    const native::WindowJson same_mode = {{"windowMode", "windowed"}, {"alwaysOnTop", true}};
    assert(driver.choose(same_mode));
    assert(window.applies == 1 && !window.on_top);
    window.iconified = false;
    driver.resumed(same_mode);
    assert(window.applies == 2 && window.on_top);
    driver.set_menu(true, true, {});
    assert(driver.choose({{"windowMode", "fullscreen"}}));
    assert(window.applies == 2);
    driver.resumed({{"windowMode", "fullscreen"}});
    assert(window.shown == "borderless" && window.applies == 3 && !window.on_top);
}

void read_and_write(const fs::path &dir) {
    const auto file = dir / "bunnyhop-settings.json";
    native::write_dialog_file(file, "{\"sensitivity\":1.5}\n");
    assert(native::read_dialog_file(file) == "{\"sensitivity\":1.5}\n");
    // Replacing an existing file leaves no partial file behind.
    native::write_dialog_file(file, "bhs1.abc");
    assert(native::read_dialog_file(file) == "bhs1.abc");
    assert(!fs::exists(dir / "bunnyhop-settings.json.partial"));

    // A byte-order mark is dropped; binary files and oversized files are refused.
    write_raw(dir / "bom.json", "\xEF\xBB\xBF{}");
    assert(native::read_dialog_file(dir / "bom.json") == "{}");
    write_raw(dir / "binary.json", std::string("ab\0cd", 5));
    assert(throws(dir / "binary.json"));
    write_raw(dir / "big.css", std::string(2048, 'a'));
    assert(throws(dir / "big.css", 1024));
    assert(throws(dir / "missing.json"));
    assert(throws(dir));
    assert(native::file_display_name(dir / "theme.css") == "theme.css");
    const auto blocked = dir / "destination";
    fs::create_directory(blocked);
    write_raw(blocked / "original", "keep");
    try {
        native::write_dialog_file(blocked, "replacement");
        assert(false);
    } catch (const std::exception &) {
        assert(native::read_dialog_file(blocked / "original") == "keep");
    }
    for (const auto &entry : fs::directory_iterator(dir))
        assert(entry.path().filename().string().find(".partial-") == std::string::npos);
    assert(native::file_dialog_purpose("settings"));
    assert(native::file_dialog_purpose("css"));
    assert(!native::file_dialog_purpose("replay"));
}

void concurrent_replacements(const fs::path &dir) {
    const auto file = dir / "concurrent.json";
    bool first_ok = true;
    bool second_ok = true;
    const std::string first(16384, 'a');
    const std::string second(16384, 'b');
    auto write = [&](const std::string &text, bool &ok) {
        try {
            for (int i = 0; i < 20; ++i)
                native::write_dialog_file(file, text);
        } catch (...) {
            ok = false;
        }
    };
    std::thread left(write, std::cref(first), std::ref(first_ok));
    std::thread right(write, std::cref(second), std::ref(second_ok));
    left.join();
    right.join();
    assert(first_ok && second_ok);
    const auto saved = native::read_dialog_file(file);
    assert(saved == first || saved == second);
    try {
        native::atomic_replace(dir / "missing-source", file);
        assert(false);
    } catch (const std::exception &) {
        assert(native::read_dialog_file(file) == saved);
    }
    for (const auto &entry : fs::directory_iterator(dir))
        assert(entry.path().filename().string().find(".partial-") == std::string::npos);
}

void css_watch(const fs::path &dir) {
    const auto file = dir / "theme.css";
    write_raw(file, ":root { --amber: #7fd1ff; }");
    native::CssFileWatch watch;
    assert(!watch.poll(true));
    watch.watch(file);
    auto first = watch.poll(true);
    assert(first && first->name == "theme.css" && first->error.empty());
    assert(first->text.find("--amber") != std::string::npos);
    // Unchanged: nothing.
    assert(!watch.poll());

    // Saved again (different size): sent once the next check is due.
    write_raw(file, ":root { --amber: #ff7ad9; --cream: #fff; }");
    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    auto changed = watch.poll();
    assert(changed && changed->text.find("#ff7ad9") != std::string::npos);

    // Deleted: one error, then quiet until it comes back.
    fs::remove(file);
    auto gone = watch.poll(true);
    assert(gone && !gone->error.empty());
    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    assert(!watch.poll());
    write_raw(file, "body{}");
    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    auto back = watch.poll();
    assert(back && back->text == "body{}" && back->error.empty());

    watch.watch(std::nullopt);
    assert(!watch.poll(true));
}

// Waits for the worker to answer with a script containing `needle`.
bool answered(native::MenuFiles &files, const std::string &needle) {
    const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < until) {
        for (const auto &script : files.poll()) {
            if (script.find(needle) != std::string::npos) return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    return false;
}

SDL_DialogFileCallback dialog_answer;

void hold_dialog(SDL_DialogFileCallback answer, void *) {
    dialog_answer = answer;
}

void accepted_save(const fs::path &dir) {
    const auto destination = native::utf8_path(dir / "accepted.json");
    {
        native::MenuFiles files(dir, hold_dialog);
        files.handle(nullptr, {{"action", "save"}, {"purpose", "settings"}, {"id", "accepted"}, {"text", "first"}});
        files.handle(nullptr, {{"action", "save"}, {"purpose", "settings"}, {"id", "rejected"}, {"text", "second"}});
        const char *selected[] = {destination.c_str(), nullptr};
        dialog_answer(nullptr, selected, 0);
        // Shutdown must collect the dialog answer and drain its write without a frame poll.
    }
    assert(native::read_dialog_file(native::path_from_utf8(destination)) == "first");
}

void menu_files(const fs::path &dir) {
    const std::string dated = "bunnyhop-settings-2026-10-28.json";
    assert(native::MenuFiles::suggested_name(dated) == dated);
    assert(native::MenuFiles::suggested_name("../evil.json") == "bunnyhop-settings.json");
    assert(native::MenuFiles::suggested_name("notes.txt") == "bunnyhop-settings.json");
    assert(native::MenuFiles::suggested_name(".json") == "bunnyhop-settings.json");

    const auto data = dir / "data";
    fs::create_directories(data);
    {
        // Nothing watched: a reloaded menu hears so.
        native::MenuFiles files(data);
        files.menu_ready();
        assert(answered(files, "\"name\":null"));
    }
    // A watched file from the last launch is sent to the reloaded menu, then its saves.
    const auto css = dir / "mine.css";
    write_raw(css, "body{color:red}");
    native::write_dialog_file(data / "custom-css-file.json", nlohmann::json({{"path", native::utf8_path(css)}}).dump());
    native::MenuFiles files(data);
    files.menu_ready();
    assert(answered(files, "color:red"));
    write_raw(css, "body{color:blue;}");
    assert(answered(files, "color:blue"));
    files.handle(nullptr, {{"type", "file"}, {"action", "unwatch"}, {"purpose", "css"}});
    assert(answered(files, "\"name\":null"));
    assert(native::read_dialog_file(data / "custom-css-file.json") == "{\"path\":null}");
}

}  // namespace

int main() {
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto dir = fs::temp_directory_path() / ("bunnyhop-file-dialog-tests-" + std::to_string(stamp));
    fs::create_directories(dir);
    deferred_window_changes();
    read_and_write(dir);
    concurrent_replacements(dir);
    css_watch(dir);
    menu_files(dir);
    accepted_save(dir);
    {
        native::MenuFiles files(dir / "data");
        files.handle(nullptr, {{"action", "unwatch"}, {"purpose", "css"}});
    }
    assert(native::read_dialog_file(dir / "data" / "custom-css-file.json") == "{\"path\":null}");
    fs::remove_all(dir);
}
