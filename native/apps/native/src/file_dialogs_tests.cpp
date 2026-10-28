#include "file_dialogs.hpp"
#include "menu_files.hpp"
#include <cassert>
#include <filesystem>
#include <fstream>
#include <string>
#include <chrono>
#include <thread>

namespace {

namespace fs = std::filesystem;

void write_raw(const fs::path& path, const std::string& bytes) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    out << bytes;
}

bool throws(const fs::path& path, std::uintmax_t limit = native::kFileDialogMaxBytes) {
    try {
        native::read_dialog_file(path, limit);
    } catch (const std::exception&) {
        return true;
    }
    return false;
}

void read_and_write(const fs::path& dir) {
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
    assert(native::file_dialog_purpose("settings"));
    assert(native::file_dialog_purpose("css"));
    assert(!native::file_dialog_purpose("replay"));
}

void css_watch(const fs::path& dir) {
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
bool answered(native::MenuFiles& files, const std::string& needle) {
    const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < until) {
        for (const auto& script : files.poll()) {
            if (script.find(needle) != std::string::npos)
                return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    return false;
}

void menu_files(const fs::path& dir) {
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
    native::write_dialog_file(data / "custom-css-file.json", "{\"path\":\"" + native::utf8_path(css) + "\"}");
    native::MenuFiles files(data);
    files.menu_ready();
    assert(answered(files, "color:red"));
    write_raw(css, "body{color:blue;}");
    assert(answered(files, "color:blue"));
    files.handle(nullptr, {{"type", "file"}, {"action", "unwatch"}, {"purpose", "css"}});
    assert(answered(files, "\"name\":null"));
    assert(native::read_dialog_file(data / "custom-css-file.json") == "{\"path\":null}");
}

}

int main() {
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto dir = fs::temp_directory_path() / ("bunnyhop-file-dialog-tests-" + std::to_string(stamp));
    fs::create_directories(dir);
    read_and_write(dir);
    css_watch(dir);
    menu_files(dir);
    fs::remove_all(dir);
}
