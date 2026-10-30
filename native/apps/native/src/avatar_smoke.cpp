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

nlohmann::json render(native::avatar::AvatarService &service, native::Gl &gl, const nlohmann::json &request) {
    service.request(request);
    for (int wait = 0; wait < max_reply_waits; ++wait) {
        gl.BindFramebuffer(GL_FRAMEBUFFER, 0);
        gl.Viewport(3, 5, 101, 77);
        service.frame();
        GLint framebuffer = -1, viewport[4];
        gl.GetIntegerv(GL_FRAMEBUFFER_BINDING, &framebuffer);
        gl.GetIntegerv(GL_VIEWPORT, viewport);
        if (framebuffer != 0 || viewport[0] != 3 || viewport[1] != 5 || viewport[2] != 101 || viewport[3] != 77)
            throw std::runtime_error("Avatar render leaked its framebuffer or viewport");
        if (gl.GetError() != GL_NO_ERROR) throw std::runtime_error("Avatar render GL error");
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
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
        SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
        auto *window = SDL_CreateWindow("Native avatar smoke", 320, 240, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
        if (!window) throw std::runtime_error(SDL_GetError());
        auto context = SDL_GL_CreateContext(window);
        if (!context) throw std::runtime_error(SDL_GetError());
        SDL_GL_MakeCurrent(window, context);
        native::Gl gl;
        gl.load();
        {
            native::avatar::AvatarService service(gl, argv[1]);
            for (const auto &job : jobs)
                save(output, job.at("name").get<std::string>(), render(service, gl, job.at("request")));
        }
        SDL_GL_DestroyContext(context);
        SDL_DestroyWindow(window);
        return 0;
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
