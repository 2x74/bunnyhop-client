#pragma once
#include "file_dialogs.hpp"
#include <nlohmann/json.hpp>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace native {

// The menu's `file` messages (Settings -> Import / export, Settings -> Custom
// CSS) and their answers, as scripts for the menu document:
//   bunnyhop:native-file      {id, purpose, action, ok, cancelled, name, text?, error?}
//   bunnyhop:native-css-file  {name, text, error}, or {name: null} when nothing is watched
// Reading, writing and watching files happens on a worker thread, never on
// the frame loop. The watched stylesheet's path is kept in
// custom-css-file.json in the data folder.
class MenuFiles {
public:
  explicit MenuFiles(const std::filesystem::path &data, FileDialogs::Launcher launcher = nullptr)
      : dialogs_(launcher), state_file_(data / "custom-css-file.json") {
      worker_ = std::thread([this] { work(); });
      queue({Job::Kind::load_watch});
  }

    ~MenuFiles() {
        collect_dialog();
        {
            std::lock_guard lock(mutex_);
            stopping_ = true;
        }
        wake_.notify_one();
        worker_.join();
    }

    MenuFiles(const MenuFiles&) = delete;
    MenuFiles& operator=(const MenuFiles&) = delete;

    // {type:"file", action:"open"|"save"|"unwatch", purpose, id?, text?, name?}
    void handle(SDL_Window* window, const nlohmann::json& message) {
        const auto action = message.at("action").get<std::string>();
        const auto purpose = message.at("purpose").get<std::string>();
        if (!file_dialog_purpose(purpose))
            throw std::runtime_error("Unknown file purpose");
        if (action == "unwatch" && purpose == "css") {
            queue({Job::Kind::unwatch});
            return;
        }
        const auto id = message.at("id").get<std::string>();
        if (id.empty() || id.size() > 64)
            throw std::runtime_error("Invalid file request");
        if (action != "open" && action != "save")
            throw std::runtime_error("Unknown file action");
        if (action == "save" && purpose != "settings")
            throw std::runtime_error("Only settings are saved to a file");

        auto start = documents_folder();
        std::string saving;
        if (action == "save") {
            start /= suggested_name(message.value("name", std::string()));
            saving = message.at("text").get<std::string>();
            if (saving.size() > file_dialog_max_bytes)
                throw std::runtime_error("Too much to save.");
        }
        if (!dialogs_.show(window, action, purpose, id, start, std::move(saving)))
            push(failure({id, purpose, action, false, false, {}, {}, {}}, "A file dialog is already open."));
    }

    // The menu document (re)loaded: it gets the watched file again.
    void menu_ready() {
        queue({Job::Kind::resend_watch});
    }

    // Scripts to evaluate in the menu. Cheap: once a frame is fine.
    std::vector<std::string> poll() {
        collect_dialog();
        std::lock_guard lock(mutex_);
        std::vector<std::string> out;
        out.swap(outbox_);
        return out;
    }

    // A file name the menu suggests for saving, or the default one.
    static std::string suggested_name(const std::string& name) {
        const bool plain = name.find_first_of("/\\:") == std::string::npos && !name.starts_with(".");
        if (plain && name.size() <= 80 && name.ends_with(".json"))
            return name;
        return "bunnyhop-settings.json";
    }

private:
    struct Job {
        enum class Kind { finish, unwatch, load_watch, resend_watch };
        Kind kind;
        FileDialogResult result{};
        std::string text{};
    };

    FileDialogs dialogs_;
    std::filesystem::path state_file_;
    void collect_dialog() {
        if (auto result = dialogs_.take()) {
            auto text = std::move(result->text);
            queue({Job::Kind::finish, std::move(*result), std::move(text)});
        }
    }

    // Shared with the worker.
    std::mutex mutex_;
    std::condition_variable wake_;
    std::deque<Job> jobs_;
    std::vector<std::string> outbox_;
    bool stopping_ = false;
    std::thread worker_;

    // Worker only.
    CssFileWatch css_;

    static std::filesystem::path documents_folder() {
        const char* folder = SDL_GetUserFolder(SDL_FOLDER_DOCUMENTS);
        return folder ? path_from_utf8(folder) : std::filesystem::path();
    }

    static std::string event(const char* name, const nlohmann::json& detail) {
        const auto encoded = detail.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
        return "window.dispatchEvent(new CustomEvent('" + std::string(name) + "',{detail:" + encoded + "}))";
    }

    static nlohmann::json describe(const FileDialogResult& result) {
        return {{"id", result.id}, {"purpose", result.purpose}, {"action", result.action}, {"cancelled", false}};
    }

    static std::string failure(const FileDialogResult& result, const std::string& error) {
        auto detail = describe(result);
        detail["ok"] = false;
        detail["error"] = error;
        return event("bunnyhop:native-file", detail);
    }

    void queue(Job job) {
        {
            std::lock_guard lock(mutex_);
            jobs_.push_back(std::move(job));
        }
        wake_.notify_one();
    }

    void push(std::string script) {
        std::lock_guard lock(mutex_);
        outbox_.push_back(std::move(script));
    }

    void work() {
        std::unique_lock lock(mutex_);
        while (true) {
            wake_.wait_for(lock, CssFileWatch::kCheckInterval, [this] { return stopping_ || !jobs_.empty(); });
            while (!jobs_.empty()) {
                auto job = std::move(jobs_.front());
                jobs_.pop_front();
                lock.unlock();
                run_job(job);
                lock.lock();
            }
            if (stopping_)
                return;
            lock.unlock();
            check_css(false);
            lock.lock();
        }
    }

    // Nothing may escape the worker thread.
    void run_job(Job& job) {
        try {
            switch (job.kind) {
            case Job::Kind::finish:
                finish(job.result, job.text);
                break;
            case Job::Kind::unwatch:
                css_.watch(std::nullopt);
                save_css_path();
                push(event("bunnyhop:native-css-file", {{"name", nullptr}}));
                break;
            case Job::Kind::load_watch:
                css_.watch(load_css_path());
                break;
            case Job::Kind::resend_watch:
                if (!check_css(true))
                    push(event("bunnyhop:native-css-file", {{"name", nullptr}}));
                break;
            }
        } catch (const std::exception& e) {
            std::cerr << "Menu files: " << e.what() << '\n';
        }
    }

    bool check_css(bool force) {
        try {
            auto change = css_.poll(force);
            if (!change)
                return false;
            nlohmann::json detail = {{"name", change->name}, {"text", change->text}, {"error", change->error}};
            push(event("bunnyhop:native-css-file", detail));
            return true;
        } catch (const std::exception& e) {
            std::cerr << "Custom CSS file: " << e.what() << '\n';
            return false;
        }
    }

    void finish(const FileDialogResult& result, const std::string& saving) {
        if (!result.ok) {
            auto detail = describe(result);
            detail["ok"] = false;
            detail["cancelled"] = result.cancelled;
            if (!result.cancelled)
                detail["error"] = "The file dialog failed: " + result.error;
            push(event("bunnyhop:native-file", detail));
            return;
        }
        try {
            if (result.action == "save")
                push(saved(result, saving));
            else
                push(opened(result));
        } catch (const std::exception& e) {
            push(failure(result, e.what()));
        }
    }

    std::string saved(const FileDialogResult& result, const std::string& text) {
        auto path = result.path;
        if (!path.has_extension())
            path += ".json";
        write_dialog_file(path, text);
        auto detail = describe(result);
        detail["ok"] = true;
        detail["name"] = file_display_name(path);
        return event("bunnyhop:native-file", detail);
    }

    std::string opened(const FileDialogResult& result) {
        auto detail = describe(result);
        detail["ok"] = true;
        detail["name"] = file_display_name(result.path);
        detail["text"] = read_dialog_file(result.path);
        if (result.purpose == "css") {
            css_.watch(result.path);
            save_css_path();
            // The text goes with this answer; the watch sends later saves.
            css_.poll(true);
        }
        return event("bunnyhop:native-file", detail);
    }

    std::optional<std::filesystem::path> load_css_path() const {
        std::error_code ec;
        if (!std::filesystem::exists(state_file_, ec))
            return std::nullopt;
        const auto state = nlohmann::json::parse(read_dialog_file(state_file_, 16384), nullptr, false);
        if (!state.is_object() || !state.contains("path") || !state["path"].is_string())
            return std::nullopt;
        return path_from_utf8(state["path"].get<std::string>());
    }

    void save_css_path() const {
        nlohmann::json state = {{"path", nullptr}};
        if (css_.path())
            state["path"] = utf8_path(*css_.path());
        write_dialog_file(state_file_, state.dump());
    }
};

}
