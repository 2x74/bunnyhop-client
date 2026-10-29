#include "video_queue.hpp"
#include "data_location.hpp"
#include "video_request.hpp"
#include "video_worker.hpp"
#include <algorithm>
#include <chrono>
#include <fstream>
#include <iterator>

namespace native {
namespace {

using Clock = std::chrono::steady_clock;
constexpr auto read_poll_ms = 10;
constexpr auto cancel_grace = std::chrono::seconds(10);
constexpr size_t line_limit_bytes = 64 * 1024;
constexpr size_t text_limit_bytes = 4096;
constexpr size_t finished_limit = 20;
constexpr size_t log_tail_bytes = 2048;

std::string bounded(const nlohmann::json &event, const char *key) {
    const auto value = event.value(key, std::string());
    return value.substr(0, text_limit_bytes);
}

nlohmann::json spec_for(const VideoQueue::Request &request, const VideoQueue::Context &context) {
    nlohmann::json job = {
            {"replay", data_location::utf8(request.replay)},
            {"map", request.map},
            {"output", data_location::utf8(request.output)},
            {"options", video_options_json(request.options)}
    };
    if (!request.bsp.empty()) {
        job["bsp"] = data_location::utf8(request.bsp);
        job["content"] = data_location::utf8(request.content);
        job["detail"] = request.detail;
    }
    return {{"assets", data_location::utf8(context.assets)},
            {"cache", data_location::utf8(context.cache)},
            {"settings", context.settings},
            {"outfit", context.outfit},
            {"program", context.available.encoder},
            {"encoders", context.available.encoders.usable},
            {"aac", context.available.encoders.aac},
            {"parent", true},
            {"jobs", nlohmann::json::array({job})}};
}

bool terminal(const std::string &state) {
    return state == "completed" || state == "error" || state == "canceled";
}

void write_line(SDL_IOStream *input, const std::string &line) {
    const std::string text = line + "\n";
    SDL_WriteIO(input, text.data(), text.size());
}

SDL_Process *
start_worker(const std::filesystem::path &executable, const std::filesystem::path &spec, SDL_IOStream *log) {
    const std::string program = data_location::utf8(executable), spec_path = data_location::utf8(spec);
    const char *args[] = {program.c_str(), video_worker::flag.data(), spec_path.c_str(), nullptr};
    const auto props = SDL_CreateProperties();
    SDL_SetPointerProperty(props, SDL_PROP_PROCESS_CREATE_ARGS_POINTER, const_cast<char **>(args));
    SDL_SetNumberProperty(props, SDL_PROP_PROCESS_CREATE_STDIN_NUMBER, SDL_PROCESS_STDIO_APP);
    SDL_SetNumberProperty(props, SDL_PROP_PROCESS_CREATE_STDOUT_NUMBER, SDL_PROCESS_STDIO_APP);
    SDL_SetNumberProperty(props, SDL_PROP_PROCESS_CREATE_STDERR_NUMBER, SDL_PROCESS_STDIO_REDIRECT);
    SDL_SetPointerProperty(props, SDL_PROP_PROCESS_CREATE_STDERR_POINTER, log);
    auto *process = SDL_CreateProcessWithProperties(props);
    SDL_DestroyProperties(props);
    return process;
}

std::string tail(const std::filesystem::path &path) {
    std::ifstream in(path, std::ios::binary | std::ios::ate);
    if (!in) return {};
    const auto length = in.tellg();
    in.seekg(std::max(std::streamoff(0), std::streamoff(length) - std::streamoff(log_tail_bytes)));
    return {std::istreambuf_iterator<char>(in), {}};
}

}  // namespace

VideoQueue::~VideoQueue() {
    {
        std::lock_guard lock(mutex_);
        stopping_ = true;
        cancel_running_ = true;
    }
    wake_.notify_all();
    if (thread_.joinable()) thread_.join();
}

uint64_t VideoQueue::add(Request request, const Context &context) {
    Job job;
    job.item.title = request.title.substr(0, text_limit_bytes);
    job.item.map = request.map;
    job.spec = spec_for(request, context);
    job.executable = context.executable;
    job.folder = context.cache / "exports";
    std::lock_guard lock(mutex_);
    job.item.id = next_id_++;
    const auto id = job.item.id;
    jobs_.push_back(std::move(job));
    if (!thread_.joinable()) thread_ = std::thread(&VideoQueue::loop, this);
    wake_.notify_one();
    return id;
}

void VideoQueue::cancel(uint64_t id) {
    std::lock_guard lock(mutex_);
    for (auto it = jobs_.begin(); it != jobs_.end();) {
        const bool chosen = id == 0 || it->item.id == id;
        if (chosen && running_ == it->item.id) cancel_running_ = true;
        if (!chosen || running_ == it->item.id) {
            ++it;
            continue;
        }
        it->item.state = "canceled";
        finished_.push_back(it->item);
        it = jobs_.erase(it);
    }
}

void VideoQueue::clear_finished() {
    std::lock_guard lock(mutex_);
    finished_.clear();
}

std::vector<VideoQueue::Item> VideoQueue::items() const {
    std::lock_guard lock(mutex_);
    std::vector<Item> result = finished_;
    for (const auto &job : jobs_)
        result.push_back(job.item);
    return result;
}

bool VideoQueue::busy() const {
    std::lock_guard lock(mutex_);
    return !jobs_.empty();
}

void VideoQueue::apply_event(Item &item, const nlohmann::json &event) {
    const auto type = event.value("event", std::string());
    if (type == "start") {
        item.state = "loading";
    } else if (type == "encoder") {
        item.state = "rendering";
        item.encoder = bounded(event, "encoder");
        item.codec = bounded(event, "codec");
        item.note = bounded(event, "note");
        item.hardware = event.value("hardware", false);
        item.frames = event.value("frames", uint64_t(0));
        item.seconds = event.value("seconds", 0.);
    } else if (type == "progress") {
        item.stage = bounded(event, "stage");
        item.state = item.stage == "encoding" ? "encoding" : "rendering";
        item.frame = event.value("frame", uint64_t(0));
        item.frames = event.value("frames", item.frames);
        item.eta = event.value("eta", -1.);
        item.fps = event.value("fps", 0.);
    } else if (type == "done") {
        item.state = "completed";
        item.path = bounded(event, "path");
        item.bytes = event.value("bytes", uint64_t(0));
        item.elapsed = event.value("elapsed", 0.);
        item.frame = item.frames = event.value("frames", item.frames);
        item.eta = 0;
    } else if (type == "error") {
        item.state = "error";
        item.error = bounded(event, "message");
    } else if (type == "canceled") {
        item.state = "canceled";
    }
}

VideoQueue::Item *VideoQueue::find(uint64_t id) {
    for (auto &job : jobs_)
        if (job.item.id == id) return &job.item;
    return nullptr;
}

void VideoQueue::update(uint64_t id, const nlohmann::json &event) {
    std::lock_guard lock(mutex_);
    if (auto *item = find(id)) apply_event(*item, event);
}

void VideoQueue::loop() {
    std::unique_lock lock(mutex_);
    while (!stopping_) {
        wake_.wait(lock, [this] { return stopping_ || !jobs_.empty(); });
        if (stopping_) break;
        const Job job = jobs_.front();
        running_ = job.item.id;
        cancel_running_ = false;
        lock.unlock();
        run(job);
        lock.lock();
        running_.reset();
        if (!jobs_.empty() && jobs_.front().item.id == job.item.id) {
            finished_.push_back(jobs_.front().item);
            jobs_.pop_front();
        }
        if (finished_.size() > finished_limit) finished_.erase(finished_.begin());
    }
}

void VideoQueue::run(const Job &job) {
    const auto id = job.item.id;
    std::error_code ignored;
    std::filesystem::create_directories(job.folder, ignored);
    const auto spec = job.folder / ("job-" + std::to_string(id) + ".json");
    const auto log = job.folder / ("job-" + std::to_string(id) + ".log");
    {
        std::ofstream out(spec, std::ios::binary | std::ios::trunc);
        out << job.spec.dump();
        if (!out) {
            update(id, {{"event", "error"}, {"message", "Cannot write the export job (disk full?)."}});
            return;
        }
    }
    auto *errors = SDL_IOFromFile(data_location::utf8(log).c_str(), "wb");
    auto *process = errors ? start_worker(job.executable, spec, errors) : nullptr;
    if (errors) SDL_CloseIO(errors);
    if (!process) {
        update(id, {{"event", "error"}, {"message", std::string("Cannot start the export: ") + SDL_GetError()}});
    } else {
        read_events(process, id);
        SDL_WaitProcess(process, true, nullptr);
        SDL_DestroyProcess(process);
        settle(id, log);
    }
    std::filesystem::remove(spec, ignored);
    std::filesystem::remove(log, ignored);
}

void VideoQueue::read_events(SDL_Process *process, uint64_t id) {
    auto *output = SDL_GetProcessOutput(process);
    auto *input = SDL_GetProcessInput(process);
    std::string buffer;
    char chunk[4096];
    double sent_pace = -1;
    std::optional<Clock::time_point> canceled_at;
    for (;;) {
        if (cancel_running_ && !canceled_at) {
            write_line(input, "cancel");
            canceled_at = Clock::now();
        }
        // Quitting the game ends the export at once; a cancel gets time to clean up its temporary files.
        if (stopping_ || (canceled_at && Clock::now() - *canceled_at > cancel_grace)) SDL_KillProcess(process, true);
        if (const double pace = pace_; pace != sent_pace) {
            write_line(input, "pace " + std::to_string(pace));
            sent_pace = pace;
        }
        const size_t read = SDL_ReadIO(output, chunk, sizeof(chunk));
        if (read == 0) {
            if (SDL_GetIOStatus(output) != SDL_IO_STATUS_NOT_READY) return;
            SDL_Delay(read_poll_ms);
            continue;
        }
        buffer.append(chunk, read);
        for (size_t end = buffer.find('\n'); end != std::string::npos; end = buffer.find('\n')) {
            const auto event = nlohmann::json::parse(buffer.substr(0, end), nullptr, false);
            buffer.erase(0, end + 1);
            if (event.is_object()) update(id, event);
        }
        if (buffer.size() > line_limit_bytes) buffer.clear();
    }
}

// A process that ended without saying how is reported with the end of its log.
void VideoQueue::settle(uint64_t id, const std::filesystem::path &log) {
    std::lock_guard lock(mutex_);
    auto *item = find(id);
    if (!item || terminal(item->state)) return;
    if (cancel_running_) {
        item->state = "canceled";
        return;
    }
    item->state = "error";
    item->error = ("The export process stopped. " + tail(log)).substr(0, text_limit_bytes);
}

}  // namespace native
