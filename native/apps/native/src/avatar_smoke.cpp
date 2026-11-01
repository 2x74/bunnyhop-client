#include "smoke_graphics.hpp"
// Draws avatar pictures through the same service the menu talks to, from a JSON list of
// {name, request} (request = an avatarRender message), into OUTPUT/<name>.png or .webp. Opens a hidden GL
// window; no menu, account or network.
#include "renderer.hpp"
#include "avatar_service.hpp"

#include <chrono>
#include <thread>

namespace {

constexpr auto reply_wait = std::chrono::milliseconds(5);
constexpr int max_reply_waits = 2000;
constexpr std::string_view reply_prefix = "window.bunnyhopNativeAvatar?.(";

nlohmann::json reply_json(const std::string &js) {
    if (!js.starts_with(reply_prefix) || !js.ends_with(")")) throw std::runtime_error("Unexpected reply: " + js);
    return nlohmann::json::parse(js.substr(reply_prefix.size(), js.size() - reply_prefix.size() - 1));
}

std::string decode_base64(const std::string &text) {
    std::string out;
    uint32_t bits = 0;
    int count = 0;
    for (const char c : text) {
        const char *alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const char *at = c ? std::strchr(alphabet, c) : nullptr;
        if (!at) continue;
        bits = bits << 6 | uint32_t(at - alphabet);
        count += 6;
        if (count >= 8) {
            count -= 8;
            out.push_back(char((bits >> count) & 0xff));
        }
    }
    return out;
}

nlohmann::json render(native::avatar::AvatarService &service, native::gfx::Context &gl, const nlohmann::json &request) {
    service.request(request);
    for (int wait = 0; wait < max_reply_waits; ++wait) {
        const auto target = gl.current_target();
        gl.viewport({3, 5, 101, 77});
        service.frame();
        const auto viewport = gl.current_viewport();
        if (gl.current_target() != target || viewport.x != 3 || viewport.y != 5 || viewport.width != 101
            || viewport.height != 77)
            throw std::runtime_error("Avatar render leaked its target or viewport");
        gl.check_error("Avatar render");
        const auto replies = service.take_replies();
        if (!replies.empty()) return reply_json(replies.front());
        std::this_thread::sleep_for(reply_wait);
    }
    throw std::runtime_error("No avatar reply");
}

void save(const std::filesystem::path &directory, const std::string &name, const nlohmann::json &reply) {
    if (reply.contains("error")) throw std::runtime_error(name + ": " + reply["error"].get<std::string>());
    if (reply.contains("saved")) {
        std::cout << name << ": " << reply["saved"].get<std::string>() << '\n';
        return;
    }
    std::string bytes, extension;
    if (reply.contains("webp")) {
        bytes = decode_base64(reply["webp"].get<std::string>());
        extension = ".webp";
    } else {
        const auto url = reply.at("png").get<std::string>();
        bytes = decode_base64(url.substr(url.find(',') + 1));
        extension = ".png";
    }
    std::ofstream(directory / (name + extension), std::ios::binary).write(bytes.data(), std::streamsize(bytes.size()));
    std::cout << name << extension << ": " << bytes.size() << " bytes\n";
}

}  // namespace

int main(int argc, char **argv) {
    try {
        if (argc != 4) throw std::runtime_error("usage: native-avatar-smoke ASSETS JOBS.json OUTPUT_DIR");
        std::ifstream file(argv[2]);
        const auto jobs = nlohmann::json::parse(file);
        const std::filesystem::path output = argv[3];
        std::filesystem::create_directories(output);
        if (!SDL_Init(SDL_INIT_VIDEO)) throw std::runtime_error(SDL_GetError());
        native::SmokeGraphics surface(320, 240);
        auto &graphics = surface.context();
        {
            native::avatar::AvatarService service(graphics, argv[1]);
            for (const auto &job : jobs)
                save(output, job.at("name").get<std::string>(), render(service, graphics, job.at("request")));
        }
        return 0;
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
